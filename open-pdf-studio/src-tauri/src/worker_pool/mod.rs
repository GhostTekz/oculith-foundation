//! Multi-process PDFium worker pool. Transparent to JS — the
//! `render_pdf_page` Tauri command routes through `WorkerPool::render`
//! when the pool is ready, falls back to in-proc PDFium otherwise.
//!
//! Architecture: spec/2026-05-19-multi-process-pdfium-design.md.

pub mod state;
pub mod routing;
pub mod spawn;
pub mod recovery;
pub mod priority;
pub mod supersede;

use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use ocg_render_copy::LayerVisibility;
use crate::pdfium_renderer::AnnotShow;
use priority::Priority;

pub use state::{Status, WorkerState};
pub use supersede::{RenderTicket, RENDER_SUPERSEDED};

pub struct WorkerPool {
    pub workers: Vec<Arc<WorkerState>>,
    next_request_id: std::sync::atomic::AtomicU64,
    /// Laatste render-activiteit (ms sinds epoch) + of er al getrimd is sinds
    /// die activiteit. Open pagina-handles in de workers kosten op zware
    /// CAD-pagina's ruim 1 GB per worker; bij inactiviteit sturen we Trim.
    last_used_ms: std::sync::atomic::AtomicU64,
    trimmed: std::sync::atomic::AtomicBool,
    /// Newest render generation per caller lane (see [`supersede`]).
    supersede: supersede::SupersedeTable,
}

/// A bitmap read back from a worker, already in the IPC wire format of the
/// render commands: `[width u32 LE][height u32 LE][RGBA bytes]`. It is built
/// with one copy out of the shared memory, so a command can hand it to the
/// webview without copying the pixels again.
pub struct WorkerBitmap {
    pub width: u32,
    pub height: u32,
    framed: Vec<u8>,
}

impl WorkerBitmap {
    fn from_shm(width: u32, height: u32, rgba: &[u8]) -> Self {
        let mut framed = Vec::with_capacity(8 + rgba.len());
        framed.extend_from_slice(&width.to_le_bytes());
        framed.extend_from_slice(&height.to_le_bytes());
        framed.extend_from_slice(rgba);
        Self { width, height, framed }
    }

    /// The RGBA pixels, without the size header.
    pub fn rgba(&self) -> &[u8] {
        &self.framed[8..]
    }

    /// The wire-format bytes (size header + RGBA).
    pub fn into_framed(self) -> Vec<u8> {
        self.framed
    }

}

struct QueueDepthGuard(Arc<WorkerState>);

impl QueueDepthGuard {
    fn new(worker: Arc<WorkerState>) -> Self {
        worker.queue_depth.fetch_add(1, Ordering::AcqRel);
        Self(worker)
    }
}

impl Drop for QueueDepthGuard {
    fn drop(&mut self) {
        self.0.queue_depth.fetch_sub(1, Ordering::AcqRel);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Bovengrens op één worker-response-lees. Ruim boven elke legitieme render
/// (zwaarste blad in het corpus ~28 s whole-page); vangt alleen een écht
/// vastgelopen of protocol-incompatibele worker (bv. een verouderde sidecar
/// die een nieuwe `op` niet kent en niets terugstuurt). Zonder deze grens
/// blokkeert `read_line` eeuwig met de request-lock vast, waardoor die worker
/// voor ALLE volgende requests wedged raakt en de pagina blanco blijft. Bij
/// timeout -> Err -> in-proc-PDFium-fallback + respawn van de worker.
const WORKER_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const BACKGROUND_QUEUE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
const FOREGROUND_QUEUE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn reported_render_error(error: &anyhow::Error) -> bool {
    // A worker that returned a structured render error is still alive. OCG
    // validation failures must reach the in-process fallback without forcing
    // needless worker respawns.
    let message = error.to_string();
    message.contains(" render error: ")
        || message.contains("does not support selected OCG visibility")
        || message.contains("worker render queue deadline exceeded")
        || message == RENDER_SUPERSEDED
}

/// Did the pool drop this request because its caller moved on?
pub fn render_superseded(error: &anyhow::Error) -> bool {
    error.to_string() == RENDER_SUPERSEDED
}

fn render_reply_metadata(reply: &serde_json::Value, request_id: u64, mapping_len: usize) -> Result<(u32, u32, usize)> {
    if reply["id"].as_u64() != Some(request_id) {
        return Err(anyhow!("worker render response ID mismatch"));
    }
    if reply["ok"].as_bool() != Some(true) {
        return Err(anyhow!("worker render error: {}", reply["error"].as_str().unwrap_or("unknown")));
    }
    let width = u32::try_from(reply["w"].as_u64().unwrap_or(0)).unwrap_or(0);
    let height = u32::try_from(reply["h"].as_u64().unwrap_or(0)).unwrap_or(0);
    let bytes = reply["shm_bytes"].as_u64().unwrap_or(0);
    let expected = u64::from(width).checked_mul(u64::from(height)).and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(bytes) || bytes > (mapping_len.saturating_sub(32)) as u64 {
        return Err(anyhow!("worker render response dimensions or byte count invalid"));
    }
    Ok((width, height, bytes as usize))
}

/// Pad naar de pdfium-worker-sidecar naast de hoofdbinary. Platform-correct
/// (`.exe` alleen op Windows) zodat respawn ook op Linux/macOS de juiste naam
/// zoekt.
pub(crate) fn worker_exe_path() -> std::path::PathBuf {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let current = std::env::current_exe().ok();
    // The sidecar is named after the main binary ("<binary>-pdfium-worker"),
    // so an installer with its own binary name keeps its own worker.
    if let Some(own) = current.as_ref().and_then(|p| {
        let stem = p.file_stem()?.to_str()?;
        Some(p.parent()?.join(format!("{stem}-pdfium-worker{exe}")))
    }) {
        if own.exists() { return own; }
    }
    let name = format!("ocudraw-community-pdfium-worker{exe}");
    current
        .and_then(|p| p.parent().map(|d| d.join(&name)))
        .unwrap_or_else(|| std::path::PathBuf::from(name))
}

/// Can this worker honour `show`? Positions need the newer capability.
fn worker_supports(worker: &WorkerState, show: &AnnotShow) -> bool {
    worker.supports_annot_appearance.load(Ordering::Acquire)
        && (show.indices.is_empty() || worker.supports_annot_appearance_index.load(Ordering::Acquire))
}

impl WorkerPool {
    pub fn new(workers: Vec<Arc<WorkerState>>) -> Self {
        Self {
            workers,
            next_request_id: std::sync::atomic::AtomicU64::new(1),
            last_used_ms: std::sync::atomic::AtomicU64::new(now_ms()),
            trimmed: std::sync::atomic::AtomicBool::new(true),
            supersede: supersede::SupersedeTable::default(),
        }
    }

    fn touch(&self, worker: &WorkerState) {
        let now = now_ms();
        self.last_used_ms.store(now, Ordering::Release);
        self.trimmed.store(false, Ordering::Release);
        worker.last_used_ms.store(now, Ordering::Release);
        worker.trimmed.store(false, Ordering::Release);
    }

    /// Stuur Trim naar iedere levende worker die zélf langer dan `idle_ms`
    /// niets gerenderd heeft (eenmalig per inactiviteitsperiode). Per-worker:
    /// na de parallelle eerste render koelen de niet-affinity-workers zo
    /// vanzelf af (~1 GB parse-state per stuk terug), terwijl de worker die de
    /// interactieve tegels bedient heet blijft. Onder de per-worker
    /// request_lock zodat het nooit door een lopende exchange vlecht.
    pub async fn trim_if_idle(&self, idle_ms: u64) {
        let now = now_ms();
        for worker in &self.workers {
            if worker.status() != Status::Ready {
                continue;
            }
            if worker.trimmed.load(Ordering::Acquire) {
                continue;
            }
            if now.saturating_sub(worker.last_used_ms.load(Ordering::Acquire)) < idle_ms {
                continue;
            }
            let _priority = worker.priority.acquire(Priority::Background).await;
            let request_lock = worker.request_lock.clone();
            let _exchange = request_lock.lock().await;
            if worker.status() != Status::Ready
                || worker.trimmed.load(Ordering::Acquire)
                || now_ms().saturating_sub(worker.last_used_ms.load(Ordering::Acquire)) < idle_ms {
                continue;
            }
            worker.trimmed.store(true, Ordering::Release);
            let mut stdin_guard = worker.stdin.lock().await;
            if let Some(stdin) = stdin_guard.as_mut() {
                let _ = stdin.write_all(b"{\"op\":\"trim\"}\n").await;
                let _ = stdin.flush().await;
                eprintln!("[pool] worker {} idle — pagina-handles getrimd", worker.slot);
            }
        }
    }

    /// Returns true if at least one worker is Ready.
    pub fn is_ready(&self) -> bool {
        self.workers.iter().any(|w| w.status() == Status::Ready)
    }

    /// Discard a rewritten document in every live worker. Each exchange uses
    /// the same per-worker lock as rendering, so its acknowledgement means all
    /// earlier requests on that worker have finished and the next one reloads.
    pub async fn invalidate(&self, path: &str) -> Result<()> {
        let mut first_error = None;
        for worker in &self.workers {
            if worker.status() != Status::Ready { continue; }
            let incarnation = worker.incarnation.load(Ordering::Acquire);
            if let Err(error) = self.invalidate_on_worker(worker, path).await {
                // A worker without an acknowledgement may still hold old
                // bytes. Stop routing to it before scheduling a fresh process.
                worker.set_status(Status::Dead);
                tokio::spawn(recovery::handle_worker_crash(worker.clone(), worker_exe_path(), incarnation));
                if first_error.is_none() { first_error = Some(error); }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    async fn invalidate_on_worker(&self, worker: &Arc<WorkerState>, path: &str) -> Result<()> {
        let _priority = worker.priority.acquire(Priority::Barrier).await;
        let _exchange = worker.request_lock.lock().await;
        if worker.status() != Status::Ready {
            return Err(anyhow!("worker {} unavailable for invalidation", worker.slot));
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Release);
        let request = format!("{}\n", json!({ "op": "invalidate", "id": id, "path": path }));
        {
            let mut stdin = worker.stdin.lock().await;
            let stdin = stdin.as_mut().ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin.write_all(request.as_bytes()).await?;
            stdin.flush().await?;
        }
        let mut line = String::new();
        {
            let mut stdout = worker.stdout.lock().await;
            let stdout = stdout.as_mut().ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
            tokio::time::timeout(std::time::Duration::from_secs(5), stdout.read_line(&mut line))
                .await.context("worker invalidation acknowledgement timeout")??;
        }
        let reply: serde_json::Value = serde_json::from_str(&line).context("worker invalidation reply")?;
        if reply["id"].as_u64() != Some(id) || reply["ok"].as_bool() != Some(true) {
            return Err(anyhow!("worker {} did not acknowledge invalidation: {}", worker.slot, line.trim()));
        }
        Ok(())
    }

    /// Snapshot of current queue depths (usize::MAX for dead slots).
    fn depths(&self) -> Vec<usize> {
        self.workers.iter().map(|w| match w.status() {
            Status::Ready => w.queue_depth.load(Ordering::Acquire),
            _ => usize::MAX,
        }).collect()
    }

    fn require_ocg_capability(&self, visibility: &[LayerVisibility]) -> Result<()> {
        if !visibility.is_empty() && self.workers.iter().any(|worker| {
            worker.status() == Status::Ready
                && !worker.supports_ocg_visibility.load(Ordering::Acquire)
        }) {
            return Err(anyhow!("worker does not support selected OCG visibility"));
        }
        Ok(())
    }

    fn require_annot_capability(&self, annot_appearance: Option<&AnnotShow>) -> Result<()> {
        if annot_appearance.is_some_and(|show| self.workers.iter().any(|worker| {
            worker.status() == Status::Ready && !worker_supports(worker, show)
        })) {
            return Err(anyhow!("worker does not support annotation appearances"));
        }
        Ok(())
    }

    /// Render via the pool. The pixels are [`WorkerBitmap::rgba`], a view
    /// into the framed buffer (no header strip, no memmove).
    pub async fn render(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        visibility: &[LayerVisibility],
    ) -> Result<WorkerBitmap> {
        self.render_with_annotations(path, page_index, scale, rotation, visibility, None).await
    }

    /// As [`Self::render`], with the markups named in `annot_appearance`
    /// (by /NM) rastered from their own appearance.
    pub async fn render_with_annotations(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        visibility: &[LayerVisibility],
        annot_appearance: Option<&AnnotShow>,
    ) -> Result<WorkerBitmap> {
        self.render_with_priority(path, page_index, scale, rotation, visibility, annot_appearance, Priority::Foreground).await
    }

    /// Sidebar thumbnails use the same page affinity but wait behind the
    /// active viewport. Their JS deadline is eight seconds, so stale queued
    /// work must not start afterward.
    pub async fn render_background_with_annotations(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        visibility: &[LayerVisibility],
        annot_appearance: Option<&AnnotShow>,
    ) -> Result<WorkerBitmap> {
        self.render_with_priority(path, page_index, scale, rotation, visibility, annot_appearance, Priority::Background).await
    }

    async fn render_with_priority(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        visibility: &[LayerVisibility],
        annot_appearance: Option<&AnnotShow>,
        priority: Priority,
    ) -> Result<WorkerBitmap> {
        self.require_ocg_capability(visibility)?;
        self.require_annot_capability(annot_appearance)?;
        let queue_deadline = tokio::time::Instant::now() + match priority {
            Priority::Background => BACKGROUND_QUEUE_TIMEOUT,
            _ => FOREGROUND_QUEUE_TIMEOUT,
        };
        // First attempt. Pinned: al het werk voor dezelfde (path, page) —
        // volledige render, thumbnail, tegels — blijft op één worker, ook
        // onder druk. Uitwijken naar een koude worker zou die eerst de hele
        // content-stream laten parsen (seconden + ~1 GB parse-state op zware
        // CAD-bladen), terwijl de warme worker in ~0,4 s klaar is.
        let depths = self.depths();
        if depths.iter().all(|&depth| depth == usize::MAX) {
            return Err(anyhow!("PDFium worker pool has no ready workers"));
        }
        let slot = routing::pick_worker(path, page_index, &depths, true);
        let worker = self.workers[slot].clone();
        let incarnation = worker.incarnation.load(Ordering::Acquire);
        self.touch(&worker);
        let _queued = QueueDepthGuard::new(worker.clone());
        let result = self.render_on_worker(worker.clone(), path, page_index, scale, rotation, visibility, annot_appearance, priority, queue_deadline).await;
        drop(_queued);

        if result.is_ok() || result.as_ref().err().is_some_and(reported_render_error) {
            return result;
        }

        // First attempt failed → mark crash, retry on a DIFFERENT live slot
        worker.set_status(Status::Dead);
        let recover_task = recovery::handle_worker_crash(worker.clone(), worker_exe_path(), incarnation);
        tokio::spawn(recover_task);

        let mut depths_retry = self.depths();
        depths_retry[slot] = usize::MAX; // mark as dead for this retry
        if depths_retry.iter().all(|&d| d == usize::MAX) {
            return result; // no other workers — bubble up the error
        }
        let slot2 = routing::pick_worker(path, page_index, &depths_retry, true);
        let worker2 = self.workers[slot2].clone();
        let incarnation2 = worker2.incarnation.load(Ordering::Acquire);
        self.touch(&worker2);
        let _queued = QueueDepthGuard::new(worker2.clone());
        let result2 = self.render_on_worker(worker2.clone(), path, page_index, scale, rotation, visibility, annot_appearance, priority, queue_deadline).await;
        drop(_queued);
        if result2.as_ref().err().is_some_and(|error| !reported_render_error(error)) {
            worker2.set_status(Status::Dead);
            tokio::spawn(recovery::handle_worker_crash(worker2, worker_exe_path(), incarnation2));
        }
        result2
    }

    async fn render_on_worker(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        visibility: &[LayerVisibility],
        annot_appearance: Option<&AnnotShow>,
        priority: Priority,
        queue_deadline: tokio::time::Instant,
    ) -> Result<WorkerBitmap> {
        // Eén request tegelijk per worker: het draadprotocol heeft geen id-demux
        // en de SHM-regio wordt per response overschreven.
        let _priority = tokio::time::timeout_at(queue_deadline, worker.priority.acquire(priority))
            .await.map_err(|_| anyhow!("worker render queue deadline exceeded"))?;
        let request_lock = worker.request_lock.clone();
        let _t_queue = std::time::Instant::now();
        let _exchange = request_lock.lock().await;
        if worker.status() != Status::Ready {
            return Err(anyhow!("worker {} unavailable for render", worker.slot));
        }
        if !visibility.is_empty() && !worker.supports_ocg_visibility.load(Ordering::Acquire) {
            return Err(anyhow!("worker does not support selected OCG visibility"));
        }
        let _t_run = std::time::Instant::now();
        let _plog = PoolTrace::new(worker.slot, "render", path, page_index, scale, _t_queue, _t_run);
        let id = self.next_request_id.fetch_add(1, Ordering::Release);

        let mut req = json!({
            "op": "render",
            "id": id,
            "path": path,
            "page_index": page_index,
            "scale": scale,
            "rotation": rotation,
        });
        if !visibility.is_empty() { req["ocg_visibility"] = json!(visibility); }
        if let Some(show) = annot_appearance {
            if !worker_supports(&worker, show) {
                return Err(anyhow!("worker does not support annotation appearances"));
            }
            req["annot_appearance"] = json!(show.names);
            if !show.indices.is_empty() { req["annot_appearance_index"] = json!(show.indices); }
        }
        let req_line = format!("{}\n", req);

        // Write request
        {
            let mut stdin_guard = worker.stdin.lock().await;
            let stdin = stdin_guard.as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin.write_all(req_line.as_bytes()).await
                .with_context(|| format!("write to worker {}", worker.slot))?;
            stdin.flush().await?;
        }

        // Read response (met timeout: een vastgelopen/verouderde worker die
        // niets terugstuurt mag de request-lock niet eeuwig vasthouden).
        let mut resp_line = String::new();
        {
            let mut stdout_guard = worker.stdout.lock().await;
            let stdout = stdout_guard.as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
            match tokio::time::timeout(WORKER_READ_TIMEOUT, stdout.read_line(&mut resp_line)).await {
                Ok(r) => { r.with_context(|| format!("read from worker {}", worker.slot))?; }
                Err(_) => return Err(anyhow!("worker {} read timeout ({}s)", worker.slot, WORKER_READ_TIMEOUT.as_secs())),
            }
        }

        if resp_line.is_empty() {
            return Err(anyhow!("worker {} EOF", worker.slot));
        }

        let resp: serde_json::Value = serde_json::from_str(&resp_line)
            .with_context(|| format!("parse worker {} response: {}", worker.slot, resp_line))?;

        // Read RGBA from SHM
        let shm_guard = worker.shm.lock().await;
        let mmap = shm_guard.as_ref()
            .ok_or_else(|| anyhow!("worker {} has no shm", worker.slot))?;
        const HEADER: usize = 32;
        let (w, h, shm_bytes) = render_reply_metadata(&resp, id, mmap.len())?;
        if u32::from_le_bytes(mmap[0..4].try_into().unwrap()) != w
            || u32::from_le_bytes(mmap[4..8].try_into().unwrap()) != h {
            return Err(anyhow!("worker {} SHM header disagrees with response", worker.slot));
        }
        Ok(WorkerBitmap::from_shm(w, h, &mmap[HEADER..HEADER + shm_bytes]))
    }

    /// Render a page REGION (tile) via the pool. Small tiles fit the 64 MB SHM
    /// easily, so — unlike whole huge pages — these succeed via the pool and
    /// render in a SEPARATE process (safe: no concurrent in-proc PDFium). One
    /// attempt; on error the caller falls back to in-proc.
    ///
    /// `spread`: true = tegels over alle workers spreiden (parallelle eerste
    /// render); false = affinity op (pad,pagina) zodat interactieve tegels
    /// steeds dezelfde worker (met hete pagina-handle) raken en de overige
    /// workers hun ~1 GB parse-state niet hoeven te dragen.
    pub async fn render_region(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
        spread: bool,
        visibility: &[LayerVisibility],
    ) -> Result<WorkerBitmap> {
        self.render_region_with_annotations(
            path, page_index, scale, rotation,
            region_x_pt, region_y_pt, region_w_pt, region_h_pt,
            spread, visibility, None, None,
        ).await
    }

    /// As [`Self::render_region`], with the /AP pass of
    /// [`Self::render_with_annotations`]. With a `ticket`, the request is
    /// dropped with [`RENDER_SUPERSEDED`] if a newer generation on its lane
    /// arrives before it reaches a worker.
    #[allow(clippy::too_many_arguments)]
    pub async fn render_region_with_annotations(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
        spread: bool,
        visibility: &[LayerVisibility],
        annot_appearance: Option<&AnnotShow>,
        ticket: Option<&RenderTicket>,
    ) -> Result<WorkerBitmap> {
        self.require_ocg_capability(visibility)?;
        self.require_annot_capability(annot_appearance)?;
        if let Some(ticket) = ticket {
            self.supersede.note(ticket);
            if self.supersede.superseded(ticket) {
                return Err(anyhow!(RENDER_SUPERSEDED));
            }
        }
        let queue_deadline = tokio::time::Instant::now() + FOREGROUND_QUEUE_TIMEOUT;
        let depths = self.depths();
        if depths.iter().all(|&depth| depth == usize::MAX) {
            return Err(anyhow!("PDFium worker pool has no ready workers"));
        }
        // Salt de affiniteit met de regio-coördinaten wanneer spreiding gewenst
        // is: tegels van DEZELFDE pagina landen dan op verschillende workers.
        let salt = if spread {
            region_x_pt.to_bits() ^ region_y_pt.to_bits().rotate_left(16)
        } else {
            0
        };
        // Zonder spread pinnen we op de affinity-worker (geen overflow-
        // uitwijk): één worker draagt de dure parse-state en serialiseert de
        // tegels à ~0,4 s. Met spread is uitwijken juist gewenst.
        let slot = routing::pick_worker(path, page_index ^ salt, &depths, !spread);
        let worker = self.workers[slot].clone();
        let incarnation = worker.incarnation.load(Ordering::Acquire);
        self.touch(&worker);
        let _queued = QueueDepthGuard::new(worker.clone());
        let result = self.render_region_on_worker(
            worker.clone(), path, page_index, scale, rotation,
            region_x_pt, region_y_pt, region_w_pt, region_h_pt,
            visibility, annot_appearance, ticket, queue_deadline,
        ).await;
        drop(_queued);
        // Geen retry (de aanroeper valt terug op in-proc PDFium), maar een
        // gefaalde/getimede worker is mogelijk gedesynchroniseerd — respawn
        // hem zodat de volgende tegel niet weer op een wedged worker landt.
        if result.as_ref().err().is_some_and(|error| !reported_render_error(error)) {
            worker.set_status(Status::Dead);
            tokio::spawn(recovery::handle_worker_crash(worker.clone(), worker_exe_path(), incarnation));
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn render_region_on_worker(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
        visibility: &[LayerVisibility],
        annot_appearance: Option<&AnnotShow>,
        ticket: Option<&RenderTicket>,
        queue_deadline: tokio::time::Instant,
    ) -> Result<WorkerBitmap> {
        // Zelfde volledige-round-trip-serialisatie als render_on_worker.
        let _priority = tokio::time::timeout_at(queue_deadline, worker.priority.acquire(Priority::Foreground))
            .await.map_err(|_| anyhow!("worker render queue deadline exceeded"))?;
        let request_lock = worker.request_lock.clone();
        let _t_queue = std::time::Instant::now();
        let _exchange = request_lock.lock().await;
        // Our turn on the worker. If the caller has since asked for a newer
        // view on this lane, it discards this tile: free the worker for it.
        if ticket.is_some_and(|ticket| self.supersede.superseded(ticket)) {
            return Err(anyhow!(RENDER_SUPERSEDED));
        }
        if worker.status() != Status::Ready {
            return Err(anyhow!("worker {} unavailable for region render", worker.slot));
        }
        if !visibility.is_empty() && !worker.supports_ocg_visibility.load(Ordering::Acquire) {
            return Err(anyhow!("worker does not support selected OCG visibility"));
        }
        let _t_run = std::time::Instant::now();
        let _plog = PoolTrace::new(worker.slot, "region", path, page_index, scale, _t_queue, _t_run);
        let id = self.next_request_id.fetch_add(1, Ordering::Release);

        let mut req = json!({
            "op": "render_region",
            "id": id,
            "path": path,
            "page_index": page_index,
            "scale": scale,
            "rotation": rotation,
            "region_x_pt": region_x_pt,
            "region_y_pt": region_y_pt,
            "region_w_pt": region_w_pt,
            "region_h_pt": region_h_pt,
        });
        if !visibility.is_empty() { req["ocg_visibility"] = json!(visibility); }
        if let Some(show) = annot_appearance {
            if !worker_supports(&worker, show) {
                return Err(anyhow!("worker does not support annotation appearances"));
            }
            req["annot_appearance"] = json!(show.names);
            if !show.indices.is_empty() { req["annot_appearance_index"] = json!(show.indices); }
        }
        let req_line = format!("{}\n", req);

        {
            let mut stdin_guard = worker.stdin.lock().await;
            let stdin = stdin_guard.as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin.write_all(req_line.as_bytes()).await
                .with_context(|| format!("write to worker {}", worker.slot))?;
            stdin.flush().await?;
        }

        let mut resp_line = String::new();
        {
            let mut stdout_guard = worker.stdout.lock().await;
            let stdout = stdout_guard.as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
            match tokio::time::timeout(WORKER_READ_TIMEOUT, stdout.read_line(&mut resp_line)).await {
                Ok(r) => { r.with_context(|| format!("read from worker {}", worker.slot))?; }
                Err(_) => return Err(anyhow!("worker {} region read timeout ({}s)", worker.slot, WORKER_READ_TIMEOUT.as_secs())),
            }
        }

        if resp_line.is_empty() {
            return Err(anyhow!("worker {} EOF", worker.slot));
        }

        let resp: serde_json::Value = serde_json::from_str(&resp_line)
            .with_context(|| format!("parse worker {} response: {}", worker.slot, resp_line))?;

        let shm_guard = worker.shm.lock().await;
        let mmap = shm_guard.as_ref()
            .ok_or_else(|| anyhow!("worker {} has no shm", worker.slot))?;
        const HEADER: usize = 32;
        let (w, h, shm_bytes) = render_reply_metadata(&resp, id, mmap.len())?;
        if u32::from_le_bytes(mmap[0..4].try_into().unwrap()) != w
            || u32::from_le_bytes(mmap[4..8].try_into().unwrap()) != h {
            return Err(anyhow!("worker {} SHM header disagrees with response", worker.slot));
        }
        Ok(WorkerBitmap::from_shm(w, h, &mmap[HEADER..HEADER + shm_bytes]))
    }
}

/// Tijdelijke meet-tracer (aan met env `OPDS_POOL_TRACE=1`): schrijft per
/// pool-request de rij-wachttijd en uitvoerduur naar
/// %TEMP%/opds-pool-trace.log. RAII: logt bij drop, dus ook bij fouten.
struct PoolTrace {
    line: Option<String>,
    t_run: std::time::Instant,
}

impl PoolTrace {
    fn new(slot: u32, op: &'static str, path: &str, page: u32, scale: f32,
           t_queue: std::time::Instant, t_run: std::time::Instant) -> Self {
        if std::env::var("OPDS_POOL_TRACE").ok().as_deref() != Some("1") {
            return Self { line: None, t_run };
        }
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let wait_ms = t_run.duration_since(t_queue).as_millis();
        Self {
            line: Some(format!("w{} {} p{} s{:.3} wait={}ms {}", slot, op, page, scale, wait_ms, name)),
            t_run,
        }
    }
}

impl Drop for PoolTrace {
    fn drop(&mut self) {
        if let Some(l) = self.line.take() {
            use std::io::Write;
            let p = std::env::temp_dir().join("opds-pool-trace.log");
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{} run={}ms", l, self.t_run.elapsed().as_millis());
            }
        }
    }
}

#[cfg(test)]
mod ocg_capability_tests {
    use super::*;

    #[test]
    fn queue_depth_guard_releases_a_cancelled_request() {
        let worker = Arc::new(WorkerState::new(0));
        let queued = QueueDepthGuard::new(worker.clone());
        assert_eq!(worker.queue_depth.load(Ordering::Acquire), 1);
        drop(queued);
        assert_eq!(worker.queue_depth.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn a_pool_with_no_live_workers_returns_errors_instead_of_panicking() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Dead);
        let pool = WorkerPool::new(vec![worker]);
        assert!(pool.render("drawing.pdf", 0, 1.0, 0, &[]).await.is_err());
        assert!(pool.render_region("drawing.pdf", 0, 1.0, 0, 0.0, 0.0, 10.0, 10.0, false, &[]).await.is_err());
    }

    #[test]
    fn render_reply_requires_matching_id_and_exact_rgba_length() {
        let good = json!({ "id": 7, "ok": true, "w": 2, "h": 3, "shm_bytes": 24 });
        assert_eq!(render_reply_metadata(&good, 7, 64).unwrap(), (2, 3, 24));
        assert!(render_reply_metadata(&good, 8, 64).is_err());
        assert!(render_reply_metadata(&good, 7, 55).is_err());
        let mut bad_length = good.clone();
        bad_length["shm_bytes"] = json!(20);
        assert!(render_reply_metadata(&bad_length, 7, 64).is_err());
    }

    #[test]
    fn old_worker_cannot_silently_render_selected_state() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let selected = [LayerVisibility { object_number: 6, generation: 0, visible: true }];
        assert!(pool.require_ocg_capability(&[]).is_ok());
        assert!(pool.require_ocg_capability(&selected).is_err());
        worker.supports_ocg_visibility.store(true, Ordering::Release);
        assert!(pool.require_ocg_capability(&selected).is_ok());
    }

    #[test]
    fn old_worker_cannot_silently_drop_annotation_appearances() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let show = AnnotShow { names: vec!["nm-1".to_string()], indices: vec![] };
        assert!(pool.require_annot_capability(None).is_ok());
        assert!(pool.require_annot_capability(Some(&show)).is_err());
        worker.supports_annot_appearance.store(true, Ordering::Release);
        assert!(pool.require_annot_capability(Some(&show)).is_ok());
        // A worker that only knows names must not silently drop positions.
        let by_index = AnnotShow { names: vec![], indices: vec![3] };
        assert!(pool.require_annot_capability(Some(&by_index)).is_err());
        worker.supports_annot_appearance_index.store(true, Ordering::Release);
        assert!(pool.require_annot_capability(Some(&by_index)).is_ok());
    }

    #[test]
    fn structured_ocg_error_does_not_trigger_worker_recovery() {
        assert!(reported_render_error(&anyhow!(
            "worker 0 render error: OCG visibility override does not name a catalog group"
        )));
        assert!(!reported_render_error(&anyhow!("worker 0 EOF")));
    }

    #[test]
    fn a_superseded_request_is_not_a_worker_failure() {
        let dropped = anyhow!(RENDER_SUPERSEDED);
        assert!(render_superseded(&dropped));
        assert!(reported_render_error(&dropped));
        assert!(!render_superseded(&anyhow!("worker 0 render error: {RENDER_SUPERSEDED}")));
    }
}

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
mod region_tiles;
mod page_text;

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
    /// Page texts the workers read, for the next scan (page_text.rs).
    text_cache: tokio::sync::Mutex<page_text::TextCache>,
    /// Pages whose render broke a worker (see [`CrashedPages`]).
    crashed_pages: std::sync::Mutex<CrashedPages>,
}

/// Start of the error returned while no worker can take a request because a
/// worker failed and is being replaced. Rendering in the app's own process
/// instead would repeat whatever broke the worker there.
pub const POOL_UNAVAILABLE_AFTER_CRASH: &str = "PDFium worker pool unavailable after a worker crash";

/// Is this the error of a pool that a worker failure took out of service?
pub fn pool_unavailable_after_crash(error: &anyhow::Error) -> bool {
    error.to_string().starts_with(POOL_UNAVAILABLE_AFTER_CRASH)
}

/// Pages (path, page index) whose exchange broke a worker: it died, its pipe
/// broke, or it did not answer in time. Such a page must not be rendered in
/// the app's own process, where the same native crash or hang would take the
/// whole app down. Bounded; the oldest entry goes first.
#[derive(Default)]
struct CrashedPages(std::collections::VecDeque<(String, u32)>);

const CRASHED_PAGES_CAP: usize = 256;

impl CrashedPages {
    fn note(&mut self, path: &str, page_index: u32) {
        if self.contains(path, page_index) {
            return;
        }
        if self.0.len() >= CRASHED_PAGES_CAP {
            self.0.pop_front();
        }
        self.0.push_back((path.to_string(), page_index));
    }

    fn contains(&self, path: &str, page_index: u32) -> bool {
        self.0.iter().any(|(p, i)| *i == page_index && p == path)
    }
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
/// Wall-clock budget for a region rendered in several tiles, counted from the
/// request's arrival at the pool, so the wait for the first tile counts too.
/// A region that fits one exchange may take up to WORKER_READ_TIMEOUT;
/// splitting it must not stretch that to one timeout per tile. A tile is only
/// sent while it can still end within the budget, judged by the slowest tile
/// so far (or [`REGION_FIRST_TILE_RESERVE`] before the first one), both before
/// waiting for the worker and again once its locks are held. Otherwise the
/// region fails with a reported error and the caller renders it in process.
/// A running tile cannot be interrupted without killing the worker, so only a
/// tile slower than every earlier one can still end past the budget.
const REGION_RENDER_BUDGET: std::time::Duration = WORKER_READ_TIMEOUT;
/// Time a tiled region keeps free for its first tile, which has no earlier
/// tile to judge it by. The first tile must start within the budget's first
/// 45 seconds.
const REGION_FIRST_TILE_RESERVE: std::time::Duration = std::time::Duration::from_secs(15);
const QUEUE_DEADLINE_ERROR: &str = "worker render queue deadline exceeded";

/// An error the worker side reports without being at fault: the caller
/// falls back in process and the worker is kept.
fn reported(detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("worker render error: {detail}")
}

fn reported_render_error(error: &anyhow::Error) -> bool {
    // A worker that returned a structured render error is still alive. OCG
    // validation failures must reach the in-process fallback without forcing
    // needless worker respawns.
    let message = error.to_string();
    message.contains(" render error: ")
        || message.contains("does not support selected OCG visibility")
        || message.contains(QUEUE_DEADLINE_ERROR)
        || message == RENDER_SUPERSEDED
}

/// Why a tiled region stopped without a worker failure. Each one is a
/// reported error (see [`reported_render_error`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegionGiveUp {
    /// The next tile could not end within [`REGION_RENDER_BUDGET`].
    Budget { done: usize, total: usize },
    /// The worker was respawned or invalidated after the first tile.
    DocumentChanged,
    /// The file's modification time or length moved during the region.
    FileChanged,
    /// The worker slot is no longer ready between tiles.
    WorkerRestarted { slot: u32 },
}

impl std::fmt::Display for RegionGiveUp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegionGiveUp::Budget { done, total } => {
                write!(f, "worker render error: region render budget exceeded after {done} of {total} tiles")
            }
            RegionGiveUp::DocumentChanged => write!(f, "worker render error: document changed between region tiles"),
            RegionGiveUp::FileChanged => write!(f, "worker render error: document file changed during region render"),
            RegionGiveUp::WorkerRestarted { slot } => {
                write!(f, "worker render error: worker {slot} restarted between region tiles")
            }
        }
    }
}

/// The worker process and the document versions it may hold. Tiles of one
/// region must all come from the same epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorkerEpoch {
    incarnation: u64,
    invalidations: u64,
}

impl WorkerEpoch {
    fn of(worker: &WorkerState) -> Self {
        Self {
            incarnation: worker.incarnation.load(Ordering::Acquire),
            invalidations: worker.invalidations.load(Ordering::Acquire),
        }
    }
}

/// Expected duration of the next tile: the slowest so far, or the reserve
/// before any tile has been measured.
fn tile_estimate(slowest: Option<std::time::Duration>) -> std::time::Duration {
    slowest.unwrap_or(REGION_FIRST_TILE_RESERVE)
}

/// The last moment a tile of `estimate` may start and still end by `deadline`.
fn tile_start_limit(deadline: tokio::time::Instant, estimate: std::time::Duration) -> Option<tokio::time::Instant> {
    deadline.checked_sub(estimate)
}

/// May tile `index` of `total` be sent now? Decided with the worker's locks
/// held, right before the request is written: the worker must still be the
/// process and document version of the first tile, and the tile must be able
/// to end within the region's deadline.
fn tile_gate(
    index: usize,
    total: usize,
    now: tokio::time::Instant,
    estimate: std::time::Duration,
    deadline: tokio::time::Instant,
    first: WorkerEpoch,
    current: WorkerEpoch,
) -> std::result::Result<(), RegionGiveUp> {
    if current != first {
        return Err(RegionGiveUp::DocumentChanged);
    }
    if !matches!(tile_start_limit(deadline, estimate), Some(limit) if now <= limit) {
        return Err(RegionGiveUp::Budget { done: index, total });
    }
    Ok(())
}

/// The path's modification time and length. The worker reloads a document
/// whose stamp changed without being told, so a region compares the stamp
/// from before its first tile with the one after its last.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    modified: Option<std::time::SystemTime>,
    len: u64,
}

async fn file_stamp(path: &str) -> Result<FileStamp> {
    let meta = tokio::fs::metadata(path).await
        .map_err(|e| reported(format!("region document unavailable: {e}")))?;
    Ok(FileStamp { modified: meta.modified().ok(), len: meta.len() })
}

/// Refuse a request with a non-finite number before it reaches a worker:
/// JSON has no NaN or infinity, so the worker would get `null` where it
/// expects a number. A reported error: the worker is kept.
fn require_finite(values: &[f32]) -> Result<()> {
    if values.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err(reported("non-finite render parameter"))
    }
}

/// Take a worker out of routing and recover it after a failed exchange with
/// process `incarnation`. If the slot already runs a newer process, the
/// failure is old news: that process must stay in service.
fn report_failed_exchange(worker: &Arc<WorkerState>, incarnation: u64) {
    worker.retire_incarnation(incarnation);
    tokio::spawn(recovery::handle_worker_crash(worker.clone(), worker_exe_path(), incarnation));
}

/// Prefix of the error for a worker found mid-replacement when a request's
/// turn came: retried elsewhere, never reported as a new failure.
const WORKER_UNAVAILABLE: &str = "render worker unavailable: slot";

fn worker_unavailable(error: &anyhow::Error) -> bool {
    error.to_string().starts_with(WORKER_UNAVAILABLE)
}

/// End of the error for a region whose worker was found mid-replacement.
const REGION_WORKER_UNAVAILABLE: &str = "unavailable for region render";

fn region_unavailable(error: &anyhow::Error) -> bool {
    error.to_string().ends_with(REGION_WORKER_UNAVAILABLE)
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
            text_cache: tokio::sync::Mutex::new(page_text::TextCache::default()),
            crashed_pages: std::sync::Mutex::new(CrashedPages::default()),
        }
    }

    /// Did rendering this page break a worker? The caller must then not
    /// render it in its own process.
    pub fn page_crashed_worker(&self, path: &str, page_index: u32) -> bool {
        self.crashed_pages.lock().map_or(true, |pages| pages.contains(path, page_index))
    }

    fn note_crashed_page(&self, path: &str, page_index: u32) {
        if let Ok(mut pages) = self.crashed_pages.lock() {
            pages.note(path, page_index);
        }
    }

    /// Is a failed worker being replaced right now? Once the pool runs, only
    /// a failure leaves a slot Dead and only a respawn makes it Spawning.
    fn recovering_from_failure(&self) -> bool {
        self.workers.iter().any(|worker| {
            !worker.stopping.load(Ordering::Acquire)
                && matches!(worker.status(), Status::Dead | Status::Spawning)
        })
    }

    /// The error for a request no worker could take. While a failed worker
    /// is being replaced it is [`POOL_UNAVAILABLE_AFTER_CRASH`]; otherwise
    /// (no worker started at all, the pool stopping) the plain error, after
    /// which the caller may render in its own process.
    fn no_worker_error(&self, error: anyhow::Error) -> anyhow::Error {
        if self.recovering_from_failure() {
            anyhow!("{POOL_UNAVAILABLE_AFTER_CRASH}: {error}")
        } else {
            error
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

    /// Stop every worker when the app exits: ask each one to shut down, close
    /// its pipe, and wait up to `grace` in total for the processes to end;
    /// whatever is still running then (a long native render) is killed. A
    /// worker that ends this way exits without PDFium's teardown (see the
    /// worker's `exit_without_teardown`). Returns how many workers had to be
    /// killed.
    pub async fn shutdown(&self, grace: std::time::Duration) -> usize {
        let deadline = tokio::time::Instant::now() + grace;
        let mut children = Vec::new();
        for worker in &self.workers {
            worker.stopping.store(true, Ordering::Release);
            worker.set_status(Status::DeadPermanent);
            // Only the pipe lock: an exchange in flight keeps its request
            // lock for the whole render, and the worker reads this request
            // as soon as that render is done.
            let stdin = tokio::time::timeout_at(deadline, worker.stdin.lock()).await
                .ok()
                .and_then(|mut guard| guard.take());
            if let Some(mut stdin) = stdin {
                let _ = tokio::time::timeout_at(deadline, async {
                    let _ = stdin.write_all(b"{\"op\":\"shutdown\"}\n").await;
                    let _ = stdin.flush().await;
                }).await;
                drop(stdin); // end of input: the worker stops after its current request
            }
            if let Ok(mut guard) = tokio::time::timeout_at(deadline, worker.child.lock()).await {
                if let Some(child) = guard.take() {
                    children.push((worker.slot, child));
                }
            }
        }
        let mut killed = 0;
        for (slot, mut child) in children {
            match tokio::time::timeout_at(deadline, child.wait()).await {
                Ok(Ok(status)) if !status.success() => {
                    eprintln!("[pool] worker {slot} ended with {status}");
                }
                Ok(_) => {}
                Err(_) => {
                    killed += 1;
                    let _ = child.kill().await;
                    eprintln!("[pool] worker {slot} did not stop in time; killed");
                }
            }
        }
        // Every worker has ended. Unmap this side and remove the SHM file:
        // Unix removed the name when the worker started, Windows only can
        // once neither process maps it any more.
        for worker in &self.workers {
            let unmapped = tokio::time::timeout(std::time::Duration::from_millis(250), worker.shm.lock()).await
                .map(|mut shm| { *shm = None; })
                .is_ok();
            if unmapped {
                let _ = std::fs::remove_file(spawn::shm_path(worker.slot));
            }
        }
        killed
    }

    /// Returns true if at least one worker is Ready.
    pub fn is_ready(&self) -> bool {
        self.workers.iter().any(|w| w.status() == Status::Ready)
    }

    /// Discard a rewritten document in every live worker. Each exchange uses
    /// the same per-worker lock as rendering, so its acknowledgement means all
    /// earlier requests on that worker have finished and the next one reloads.
    pub async fn invalidate(&self, path: &str) -> Result<()> {
        self.text_cache.lock().await.forget(path);
        let mut first_error = None;
        for worker in &self.workers {
            if worker.status() != Status::Ready { continue; }
            let incarnation = worker.incarnation.load(Ordering::Acquire);
            if let Err(error) = self.invalidate_on_worker(worker, path).await {
                // A worker without an acknowledgement may still hold old
                // bytes. Stop routing to it before scheduling a fresh process.
                worker.retire_incarnation(incarnation);
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
        // Counted before the request is sent: even a failed acknowledgement
        // may have dropped the worker's handle.
        worker.invalidations.fetch_add(1, Ordering::AcqRel);
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
        require_finite(&[scale])?;
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
            return Err(self.no_worker_error(anyhow!("PDFium worker pool has no ready workers")));
        }
        let slot = routing::pick_worker(path, page_index, &depths, true);
        let worker = self.workers[slot].clone();
        // Set to the process that served the exchange: the slot may be
        // respawned while this request waits for its turn.
        let mut served = worker.incarnation.load(Ordering::Acquire);
        self.touch(&worker);
        let _queued = QueueDepthGuard::new(worker.clone());
        let result = self.render_on_worker(worker.clone(), path, page_index, scale, rotation, visibility, annot_appearance, priority, queue_deadline, &mut served).await;
        drop(_queued);

        if result.is_ok() || result.as_ref().err().is_some_and(reported_render_error) {
            return result;
        }

        // First attempt failed → mark crash (unless the worker was already
        // being replaced), retry on a DIFFERENT live slot
        if !result.as_ref().err().is_some_and(worker_unavailable) {
            self.note_crashed_page(path, page_index);
            report_failed_exchange(&worker, served);
        }

        let mut depths_retry = self.depths();
        depths_retry[slot] = usize::MAX; // mark as dead for this retry
        if depths_retry.iter().all(|&d| d == usize::MAX) {
            // No other workers — bubble up the error.
            return result.map_err(|error| if worker_unavailable(&error) { self.no_worker_error(error) } else { error });
        }
        let slot2 = routing::pick_worker(path, page_index, &depths_retry, true);
        let worker2 = self.workers[slot2].clone();
        let mut served2 = worker2.incarnation.load(Ordering::Acquire);
        self.touch(&worker2);
        let _queued = QueueDepthGuard::new(worker2.clone());
        let result2 = self.render_on_worker(worker2.clone(), path, page_index, scale, rotation, visibility, annot_appearance, priority, queue_deadline, &mut served2).await;
        drop(_queued);
        if result2.as_ref().err().is_some_and(|error| !reported_render_error(error) && !worker_unavailable(error)) {
            self.note_crashed_page(path, page_index);
            report_failed_exchange(&worker2, served2);
        }
        result2.map_err(|error| if worker_unavailable(&error) { self.no_worker_error(error) } else { error })
    }

    #[allow(clippy::too_many_arguments)]
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
        served: &mut u64,
    ) -> Result<WorkerBitmap> {
        // Eén request tegelijk per worker: het draadprotocol heeft geen id-demux
        // en de SHM-regio wordt per response overschreven.
        let _priority = tokio::time::timeout_at(queue_deadline, worker.priority.acquire(priority))
            .await.map_err(|_| anyhow!(QUEUE_DEADLINE_ERROR))?;
        let request_lock = worker.request_lock.clone();
        let _t_queue = std::time::Instant::now();
        let _exchange = request_lock.lock().await;
        *served = worker.incarnation.load(Ordering::Acquire);
        if worker.status() != Status::Ready {
            // Already reported and being replaced: not a failure of its own.
            return Err(anyhow!("{} {}", WORKER_UNAVAILABLE, worker.slot));
        }
        if !visibility.is_empty() && !worker.supports_ocg_visibility.load(Ordering::Acquire) {
            return Err(anyhow!("worker does not support selected OCG visibility"));
        }
        let _t_run = std::time::Instant::now();
        let _plog = PoolTrace::new(worker.slot, "render", path, page_index, scale, _t_queue, _t_run);
        let id = self.next_request_id.fetch_add(1, Ordering::Release);

        let mut req = json!({
            "op": "render",
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
        self.bitmap_exchange(&worker, req, id).await
    }

    /// Render a page region in a separate process. Oversized regions are
    /// transferred in pixel-aligned pieces through the worker's fixed SHM
    /// slot, preserving the requested scale and original pixel transform.
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
        require_finite(&[scale, region_x_pt, region_y_pt, region_w_pt, region_h_pt])?;
        self.require_ocg_capability(visibility)?;
        self.require_annot_capability(annot_appearance)?;
        if let Some(ticket) = ticket {
            self.supersede.note(ticket);
            if self.supersede.superseded(ticket) {
                return Err(anyhow!(RENDER_SUPERSEDED));
            }
        }
        let arrived = tokio::time::Instant::now();
        let queue_deadline = arrived + FOREGROUND_QUEUE_TIMEOUT;
        let region_deadline = arrived + REGION_RENDER_BUDGET;
        let depths = self.depths();
        if depths.iter().all(|&depth| depth == usize::MAX) {
            return Err(self.no_worker_error(anyhow!("PDFium worker pool has no ready workers")));
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
        // Updated to the process that served the exchange once the request
        // reaches the worker; the slot may be respawned while it waits.
        let mut incarnation = worker.incarnation.load(Ordering::Acquire);
        self.touch(&worker);
        let _queued = QueueDepthGuard::new(worker.clone());
        let result = self.render_region_on_worker(
            worker.clone(), path, page_index, scale, rotation,
            region_x_pt, region_y_pt, region_w_pt, region_h_pt,
            visibility, annot_appearance, ticket, queue_deadline, region_deadline,
            &mut incarnation,
        ).await;
        drop(_queued);
        // Geen retry (de aanroeper valt terug op in-proc PDFium), maar een
        // gefaalde/getimede worker is mogelijk gedesynchroniseerd — respawn
        // hem zodat de volgende tegel niet weer op een wedged worker landt.
        if let Some(error) = result.as_ref().err().filter(|error| !reported_render_error(error)) {
            if !region_unavailable(error) {
                self.note_crashed_page(path, page_index);
            }
            report_failed_exchange(&worker, incarnation);
        }
        result.map_err(|error| if region_unavailable(&error) { self.no_worker_error(error) } else { error })
    }

    /// Wait until `deadline` for this worker's turn and take its exchange
    /// lock, then check the request is still wanted and the worker can serve
    /// it. The two guards together own the worker's pipe and SHM slot until
    /// they are dropped. `incarnation` is set to the process found once the
    /// lock is held, so a failure is reported against that process.
    #[allow(clippy::too_many_arguments)]
    async fn enter_region_exchange<'a>(
        &self,
        worker: &'a WorkerState,
        deadline: tokio::time::Instant,
        deadline_error: String,
        later_tile: bool,
        ticket: Option<&RenderTicket>,
        visibility: &[LayerVisibility],
        incarnation: &mut u64,
    ) -> Result<(priority::Permit<'a>, tokio::sync::OwnedMutexGuard<()>)> {
        let permit = tokio::time::timeout_at(deadline, worker.priority.acquire(Priority::Foreground))
            .await.map_err(|_| anyhow!(deadline_error))?;
        let exchange = worker.request_lock.clone().lock_owned().await;
        *incarnation = worker.incarnation.load(Ordering::Acquire);
        // Our turn on the worker. If the caller has since asked for a newer
        // view on this lane, it discards this tile: free the worker for it.
        if ticket.is_some_and(|ticket| self.supersede.superseded(ticket)) {
            return Err(anyhow!(RENDER_SUPERSEDED));
        }
        if worker.status() != Status::Ready {
            return Err(if later_tile {
                // Someone else already reported this incarnation; a plain
                // error here would mark its replacement dead as well.
                anyhow::Error::msg(RegionGiveUp::WorkerRestarted { slot: worker.slot })
            } else {
                anyhow!("worker {} {}", worker.slot, REGION_WORKER_UNAVAILABLE)
            });
        }
        if !visibility.is_empty() && !worker.supports_ocg_visibility.load(Ordering::Acquire) {
            return Err(anyhow!("worker does not support selected OCG visibility"));
        }
        Ok((permit, exchange))
    }

    /// A region whose RGBA fits the worker's SHM slot is one exchange. A
    /// larger one is rendered as a series of `pixel_clip` tiles on the same
    /// pixel grid (see [`region_tiles`]) and stitched here. Its bitmap is
    /// allocated before the first tile waits, so no worker is held while up
    /// to a gigabyte is zero-filled.
    ///
    /// Between tiles the worker is released, so interactive tiles for the
    /// page are not queued behind the whole region; each tile is copied out
    /// of the SHM slot before its locks drop. Because other requests run in
    /// between, the region gives up (with a reported error, so the worker is
    /// kept and the caller falls back to in-process rendering) when:
    /// - the worker was respawned or invalidated since the first tile, or the
    ///   file's modification time or length differs after the last tile from
    ///   before the first (the worker reloads a changed file on its own);
    ///   either could stitch two document versions together;
    /// - a tile could not start early enough to end within
    ///   [`REGION_RENDER_BUDGET`] (checked before the wait and again once the
    ///   worker's locks are held, right before the tile is sent); or
    /// - the region needs more than [`region_tiles::MAX_REGION_TILES`].
    ///
    /// `incarnation` is set to the worker process the last exchange used.
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
        region_deadline: tokio::time::Instant,
        incarnation: &mut u64,
    ) -> Result<WorkerBitmap> {
        let _t_queue = std::time::Instant::now();
        let mut req = json!({
            "op": "render_region",
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
            req["annot_appearance"] = json!(show.names);
            if !show.indices.is_empty() { req["annot_appearance_index"] = json!(show.indices); }
        }
        let width = (region_w_pt * scale).ceil() as i32;
        let height = (region_h_pt * scale).ceil() as i32;
        if width <= 0 || height <= 0 {
            return Err(reported("invalid region dimensions"));
        }
        let (width, height) = (width as u32, height as u32);
        // Every incarnation maps a slot of the same size, so the payload read
        // before the wait decides whether the region is tiled.
        let payload = worker.shm.lock().await.as_ref()
            .map(|mmap| mmap.len().saturating_sub(32))
            .ok_or_else(|| anyhow!("worker {} {}", worker.slot, REGION_WORKER_UNAVAILABLE))?;
        if region_tiles::rgba_bytes(width, height) <= payload as u128 {
            // Zelfde volledige-round-trip-serialisatie als render_on_worker.
            let _guards = self.enter_region_exchange(
                &worker, queue_deadline, QUEUE_DEADLINE_ERROR.to_string(), false, ticket, visibility, incarnation,
            ).await?;
            if annot_appearance.is_some_and(|show| !worker_supports(&worker, show)) {
                return Err(anyhow!("worker does not support annotation appearances"));
            }
            let _plog = PoolTrace::new(worker.slot, "region", path, page_index, scale, _t_queue, std::time::Instant::now());
            let id = self.next_request_id.fetch_add(1, Ordering::Release);
            return self.bitmap_exchange(&worker, req, id).await;
        }
        if !worker.supports_region_pixel_clip.load(Ordering::Acquire) {
            return Err(reported("region pixel clipping unsupported"));
        }
        let tiles = region_tiles::plan_region_tiles(width, height, payload, region_tiles::MAX_REGION_TILES)
            .map_err(reported)?;
        let length = region_tiles::framed_len(width, height)
            .ok_or_else(|| reported("region dimensions overflow"))?;
        let mut framed = Vec::new();
        framed.try_reserve_exact(length)
            .map_err(|e| reported(format!("region allocation: {e}")))?;
        framed.extend_from_slice(&width.to_le_bytes());
        framed.extend_from_slice(&height.to_le_bytes());
        framed.resize(length, 0);
        if std::env::var("OPDS_POOL_TRACE").ok().as_deref() == Some("1") {
            eprintln!("[pool] region tiled {}x{} px through {} transfers", width, height, tiles.len());
        }
        // Taken before the worker can see the file for the first tile.
        let file_before = file_stamp(path).await?;
        let total = tiles.len();
        let mut started_epoch: Option<WorkerEpoch> = None;
        let mut slowest: Option<std::time::Duration> = None;
        let mut _plog = None;
        for (index, tile) in tiles.iter().enumerate() {
            if ticket.is_some_and(|t| self.supersede.superseded(t)) {
                return Err(anyhow!(RENDER_SUPERSEDED));
            }
            // Stop before a tile that would end past the budget: the worker
            // cannot be interrupted mid-tile without killing it. The wait for
            // the worker ends at the last moment the tile may still start.
            let estimate = tile_estimate(slowest);
            let budget_spent = || anyhow::Error::msg(RegionGiveUp::Budget { done: index, total });
            let start_limit = tile_start_limit(region_deadline, estimate)
                .filter(|limit| tokio::time::Instant::now() <= *limit)
                .ok_or_else(budget_spent)?;
            let wait_until = if index == 0 { start_limit.min(queue_deadline) } else { start_limit };
            let guards = self.enter_region_exchange(
                &worker, wait_until, budget_spent().to_string(), index > 0, ticket, visibility, incarnation,
            ).await?;
            let current = WorkerEpoch::of(&worker);
            let first = *started_epoch.get_or_insert(current);
            if index == 0 {
                if !worker.supports_region_pixel_clip.load(Ordering::Acquire) {
                    return Err(reported("region pixel clipping unsupported"));
                }
                if annot_appearance.is_some_and(|show| !worker_supports(&worker, show)) {
                    return Err(anyhow!("worker does not support annotation appearances"));
                }
                _plog = Some(PoolTrace::new(worker.slot, "region", path, page_index, scale, _t_queue, std::time::Instant::now()));
            }
            // The wait may have used up the budget, or let a respawn or an
            // invalidation through: decide again now that nothing can.
            tile_gate(index, total, tokio::time::Instant::now(), estimate, region_deadline, first, current)
                .map_err(anyhow::Error::msg)?;
            let started = std::time::Instant::now();
            req["pixel_clip"] = json!([tile.x, tile.y, tile.w, tile.h]);
            let id = self.next_request_id.fetch_add(1, Ordering::Release);
            let piece = self.bitmap_exchange(&worker, req.clone(), id).await?;
            drop(guards);
            let elapsed = started.elapsed();
            slowest = Some(slowest.map_or(elapsed, |s| s.max(elapsed)));
            if piece.width != tile.w || piece.height != tile.h {
                return Err(anyhow!("worker region tile dimensions disagree with request"));
            }
            region_tiles::stitch_tile(&mut framed, width, height, *tile, piece.rgba())
                .map_err(|e| anyhow!("worker region tile: {e}"))?;
        }
        if file_stamp(path).await? != file_before {
            return Err(anyhow::Error::msg(RegionGiveUp::FileChanged));
        }
        Ok(WorkerBitmap { width, height, framed })
    }

    /// One render exchange (request `id`). The caller holds the worker's
    /// priority and exchange locks, so no other request can overwrite the SHM
    /// slot before the returned bitmap has been copied out of it.
    ///
    /// A failure other than an error the worker reported leaves the pipe in
    /// an unknown state (a late reply may still arrive): the worker is taken
    /// out of routing here, while the caller's locks are still held, so no
    /// request queued behind this one is sent to it.
    async fn bitmap_exchange(
        &self,
        worker: &WorkerState,
        req: serde_json::Value,
        id: u64,
    ) -> Result<WorkerBitmap> {
        let incarnation = worker.incarnation.load(Ordering::Acquire);
        let result = self.bitmap_exchange_inner(worker, req, id).await;
        if result.as_ref().err().is_some_and(|error| !reported_render_error(error)) {
            worker.retire_incarnation(incarnation);
        }
        result
    }

    async fn bitmap_exchange_inner(
        &self,
        worker: &WorkerState,
        mut req: serde_json::Value,
        id: u64,
    ) -> Result<WorkerBitmap> {
        req["id"] = json!(id);
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

#[cfg(test)]
mod region_failure_tests {
    use super::*;

    #[test]
    fn a_worker_found_mid_replacement_is_retried_not_reported() {
        let unavailable = anyhow!("{} {}", WORKER_UNAVAILABLE, 2);
        assert!(worker_unavailable(&unavailable));
        assert!(!reported_render_error(&unavailable), "retried on another worker");
        assert!(!worker_unavailable(&anyhow!("worker 2 read timeout")));
    }

    /// Giving up on a tiled region must reach the in-process fallback without
    /// respawning the worker, which did nothing wrong. The errors are built
    /// the way the region loop builds them.
    #[tokio::test]
    async fn region_give_ups_keep_the_worker() {
        let plan = region_tiles::plan_region_tiles(10_000, 14_000, 1 << 20, region_tiles::MAX_REGION_TILES)
            .unwrap_err();
        let missing = file_stamp("/nonexistent-dir/drawing.pdf").await.unwrap_err();
        let give_ups = [
            reported(plan),
            reported("region pixel clipping unsupported"),
            reported("region dimensions overflow"),
            anyhow::Error::msg(RegionGiveUp::Budget { done: 3, total: 9 }),
            anyhow::Error::msg(RegionGiveUp::DocumentChanged),
            anyhow::Error::msg(RegionGiveUp::FileChanged),
            anyhow::Error::msg(RegionGiveUp::WorkerRestarted { slot: 1 }),
            missing,
            anyhow!(QUEUE_DEADLINE_ERROR),
            anyhow!(RENDER_SUPERSEDED),
        ];
        for error in &give_ups {
            assert!(reported_render_error(error), "{error}");
        }
        assert!(!reported_render_error(&anyhow!("worker 1 region read timeout (60s)")));
        assert!(!reported_render_error(&anyhow!("worker 1 EOF")));
        assert!(!reported_render_error(&anyhow!("worker 1 unavailable for region render")));
    }

    fn at(base: tokio::time::Instant, ms: u64) -> tokio::time::Instant {
        base + std::time::Duration::from_millis(ms)
    }

    #[test]
    fn a_queue_wait_that_eats_the_first_tile_reserve_gives_up() {
        let arrived = tokio::time::Instant::now();
        let deadline = arrived + REGION_RENDER_BUDGET;
        let epoch = WorkerEpoch { incarnation: 1, invalidations: 0 };
        let first = tile_estimate(None);
        assert_eq!(first, REGION_FIRST_TILE_RESERVE);
        // On arrival the first tile may start...
        assert_eq!(tile_gate(0, 3, arrived, first, deadline, epoch, epoch), Ok(()));
        // ...up to the moment it still has the whole reserve left...
        let last_start = (REGION_RENDER_BUDGET - REGION_FIRST_TILE_RESERVE).as_millis() as u64;
        assert_eq!(tile_gate(0, 3, at(arrived, last_start), first, deadline, epoch, epoch), Ok(()));
        // ...but not once the queue wait has gone past it.
        assert_eq!(
            tile_gate(0, 3, at(arrived, last_start + 1), first, deadline, epoch, epoch),
            Err(RegionGiveUp::Budget { done: 0, total: 3 })
        );
        assert_eq!(tile_start_limit(deadline, first), Some(at(arrived, last_start)));
    }

    #[test]
    fn a_later_tile_is_judged_by_the_slowest_tile_so_far() {
        let arrived = tokio::time::Instant::now();
        let deadline = arrived + REGION_RENDER_BUDGET;
        let epoch = WorkerEpoch { incarnation: 4, invalidations: 2 };
        let slowest = tile_estimate(Some(std::time::Duration::from_secs(20)));
        assert_eq!(tile_gate(2, 5, at(arrived, 40_000), slowest, deadline, epoch, epoch), Ok(()));
        // A wait behind other requests between tiles pushes the next one out.
        assert_eq!(
            tile_gate(2, 5, at(arrived, 40_001), slowest, deadline, epoch, epoch),
            Err(RegionGiveUp::Budget { done: 2, total: 5 })
        );
        // Fast tiles may run up to the deadline, never past it.
        let fast = tile_estimate(Some(std::time::Duration::ZERO));
        assert_eq!(tile_gate(4, 5, deadline, fast, deadline, epoch, epoch), Ok(()));
        assert!(tile_gate(4, 5, at(deadline, 1), fast, deadline, epoch, epoch).is_err());
        // A tile slower than the whole budget never starts.
        let huge = tile_estimate(Some(REGION_RENDER_BUDGET * 2));
        assert!(tile_gate(1, 5, arrived, huge, deadline, epoch, epoch).is_err());
    }

    #[test]
    fn a_respawn_or_invalidation_between_tiles_stops_the_region() {
        let now = tokio::time::Instant::now();
        let deadline = now + REGION_RENDER_BUDGET;
        let estimate = std::time::Duration::from_millis(400);
        let first = WorkerEpoch { incarnation: 1, invalidations: 0 };
        let respawned = WorkerEpoch { incarnation: 2, ..first };
        let invalidated = WorkerEpoch { invalidations: 1, ..first };
        assert_eq!(tile_gate(1, 4, now, estimate, deadline, first, first), Ok(()));
        assert_eq!(tile_gate(1, 4, now, estimate, deadline, first, respawned), Err(RegionGiveUp::DocumentChanged));
        assert_eq!(tile_gate(1, 4, now, estimate, deadline, first, invalidated), Err(RegionGiveUp::DocumentChanged));
        // A changed worker is reported as such even when the budget is gone.
        assert_eq!(tile_gate(3, 4, at(deadline, 1), estimate, deadline, first, respawned), Err(RegionGiveUp::DocumentChanged));
        // The epoch is read from the worker itself.
        let worker = WorkerState::new(0);
        worker.incarnation.store(7, Ordering::Release);
        worker.invalidations.store(3, Ordering::Release);
        assert_eq!(WorkerEpoch::of(&worker), WorkerEpoch { incarnation: 7, invalidations: 3 });
    }

    #[tokio::test]
    async fn a_rewritten_file_changes_its_stamp() {
        let path = std::env::temp_dir().join(format!("region-stamp-{}-{:?}.pdf", std::process::id(), std::thread::current().id()));
        std::fs::write(&path, b"%PDF-1.4 first version").unwrap();
        let path_str = path.to_str().unwrap();
        let before = file_stamp(path_str).await.unwrap();
        assert_eq!(file_stamp(path_str).await.unwrap(), before);
        std::fs::write(&path, b"%PDF-1.4 a longer second version").unwrap();
        assert_ne!(file_stamp(path_str).await.unwrap(), before);
        let _ = std::fs::remove_file(&path);
    }

    /// A worker with a real SHM mapping but no process: enough for the region
    /// loop to plan tiles and wait for its turn.
    fn mapped_worker(payload_pixels: usize) -> (Arc<WorkerState>, std::path::PathBuf) {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        worker.supports_region_pixel_clip.store(true, Ordering::Release);
        let shm = std::env::temp_dir().join(format!("region-shm-{}-{:?}", std::process::id(), std::thread::current().id()));
        let file = std::fs::OpenOptions::new().create(true).truncate(true).read(true).write(true).open(&shm).unwrap();
        file.set_len(32 + payload_pixels as u64 * 4).unwrap();
        // Safety: the file is private to this test and outlives the mapping's use.
        let mmap = unsafe { memmap2::Mmap::map(&file) }.unwrap();
        *worker.shm.try_lock().unwrap() = Some(mmap);
        (worker, shm)
    }

    #[tokio::test]
    async fn a_tiled_region_gives_up_when_the_queue_wait_spends_its_budget() {
        let (worker, shm) = mapped_worker(16);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let pdf = shm.with_extension("pdf");
        std::fs::write(&pdf, b"%PDF-1.4").unwrap();
        // Another request holds the worker for the whole wait.
        let busy = worker.priority.acquire(Priority::Foreground).await;
        let now = tokio::time::Instant::now();
        let queue_deadline = now + FOREGROUND_QUEUE_TIMEOUT;
        // 8 x 8 px through a 16 px slot: four tiles. The budget leaves the
        // first tile 50 ms to start.
        let region_deadline = now + REGION_FIRST_TILE_RESERVE + std::time::Duration::from_millis(50);
        let mut incarnation = 0;
        let error = pool.render_region_on_worker(
            worker.clone(), pdf.to_str().unwrap(), 0, 1.0, 0, 0.0, 0.0, 8.0, 8.0,
            &[], None, None, queue_deadline, region_deadline, &mut incarnation,
        ).await.err().expect("the region must give up");
        assert_eq!(error.to_string(), RegionGiveUp::Budget { done: 0, total: 4 }.to_string());
        assert!(reported_render_error(&error));
        assert!(now.elapsed() < std::time::Duration::from_secs(5), "the wait must end at the tile's start limit");
        drop(busy);
        let _ = std::fs::remove_file(&pdf);
        let _ = std::fs::remove_file(&shm);
    }

    #[tokio::test]
    async fn a_missing_file_is_refused_before_the_first_tile() {
        let (worker, shm) = mapped_worker(16);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let now = tokio::time::Instant::now();
        let mut incarnation = 0;
        let error = pool.render_region_on_worker(
            worker.clone(), "/nonexistent-dir/drawing.pdf", 0, 1.0, 0, 0.0, 0.0, 8.0, 8.0,
            &[], None, None, now + FOREGROUND_QUEUE_TIMEOUT, now + REGION_RENDER_BUDGET, &mut incarnation,
        ).await.err().expect("the region must give up");
        assert!(reported_render_error(&error), "{error}");
        // Nothing was sent: the worker was never entered.
        assert_eq!(worker.status(), Status::Ready);
        let _ = std::fs::remove_file(&shm);
    }

    #[tokio::test]
    async fn a_failure_is_reported_against_the_process_that_served_it() {
        // The slot was respawned while the request waited: incarnation 1
        // failed earlier, 2 is serving now and must stay in service.
        let worker = Arc::new(WorkerState::new(0));
        worker.incarnation.store(2, Ordering::Release);
        worker.set_status(Status::Ready);
        report_failed_exchange(&worker, 1);
        tokio::task::yield_now().await;
        assert_eq!(worker.status(), Status::Ready);
        assert_eq!(worker.crashes.load(Ordering::Acquire), 0);
        // A failure of the current process takes it out of routing at once.
        report_failed_exchange(&worker, 2);
        assert_eq!(worker.status(), Status::Dead);
    }

    #[tokio::test]
    async fn the_exchange_records_the_incarnation_it_found() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        worker.incarnation.store(5, Ordering::Release);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let mut incarnation = 4; // read before the request queued
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let guards = pool.enter_region_exchange(&worker, deadline, String::new(), false, None, &[], &mut incarnation).await;
        assert!(guards.is_ok());
        assert_eq!(incarnation, 5);
    }

    #[tokio::test]
    async fn invalidation_is_counted_even_when_the_worker_is_gone() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        let pool = WorkerPool::new(vec![worker.clone()]);
        // No pipe: the exchange fails, but the count already moved, so a
        // region in flight on this worker refuses to stitch across it.
        assert!(pool.invalidate_on_worker(&worker, "drawing.pdf").await.is_err());
        assert_eq!(worker.invalidations.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn a_broken_exchange_takes_the_worker_out_before_its_locks_drop() {
        // Ready, but without a pipe: the exchange fails as a dead one would.
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let mut served = 0;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let error = pool.render_on_worker(
            worker.clone(), "drawing.pdf", 3, 1.0, 0, &[], None, Priority::Foreground, deadline, &mut served,
        ).await.err().expect("no pipe");
        assert!(!reported_render_error(&error));
        // Nothing else ran in between: the exchange itself retired the worker.
        assert_eq!(worker.status(), Status::Dead);
    }

    #[tokio::test]
    async fn a_page_that_broke_a_worker_is_remembered() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        let pool = WorkerPool::new(vec![worker.clone()]);
        assert!(!pool.page_crashed_worker("drawing.pdf", 3));
        assert!(pool.render("drawing.pdf", 3, 1.0, 0, &[]).await.is_err());
        assert!(pool.page_crashed_worker("drawing.pdf", 3));
        assert!(!pool.page_crashed_worker("drawing.pdf", 4));
        assert!(!pool.page_crashed_worker("other.pdf", 3));
    }

    #[tokio::test]
    async fn a_pool_waiting_for_a_respawn_says_so() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Dead);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let error = pool.render("drawing.pdf", 0, 1.0, 0, &[]).await.err().unwrap();
        assert!(pool_unavailable_after_crash(&error), "{error}");
        let error = pool.render_region("drawing.pdf", 0, 1.0, 0, 0.0, 0.0, 10.0, 10.0, false, &[]).await.err().unwrap();
        assert!(pool_unavailable_after_crash(&error), "{error}");
        // A pool that never started a worker, or is stopping, is no crash.
        worker.set_status(Status::DeadPermanent);
        let error = pool.render("drawing.pdf", 0, 1.0, 0, &[]).await.err().unwrap();
        assert!(!pool_unavailable_after_crash(&error), "{error}");
        worker.set_status(Status::Dead);
        worker.stopping.store(true, Ordering::Release);
        let error = pool.render("drawing.pdf", 0, 1.0, 0, &[]).await.err().unwrap();
        assert!(!pool_unavailable_after_crash(&error), "{error}");
    }

    #[test]
    fn the_crashed_page_list_is_bounded() {
        let mut pages = CrashedPages::default();
        for page in 0..(CRASHED_PAGES_CAP as u32 + 10) {
            pages.note("drawing.pdf", page);
        }
        pages.note("drawing.pdf", 300);
        assert_eq!(pages.0.len(), CRASHED_PAGES_CAP);
        assert!(!pages.contains("drawing.pdf", 0));
        assert!(pages.contains("drawing.pdf", CRASHED_PAGES_CAP as u32 + 9));
    }

    #[tokio::test]
    async fn a_non_finite_number_never_reaches_a_worker() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);
        let pool = WorkerPool::new(vec![worker.clone()]);
        let error = pool.render("drawing.pdf", 0, f32::NAN, 0, &[]).await.err().unwrap();
        assert!(reported_render_error(&error), "{error}");
        let error = pool.render_region("drawing.pdf", 0, 1.0, 0, f32::INFINITY, 0.0, 10.0, 10.0, false, &[])
            .await.err().unwrap();
        assert!(reported_render_error(&error), "{error}");
        // Refused before the worker: it stays in service.
        assert_eq!(worker.status(), Status::Ready);
        assert!(!pool.page_crashed_worker("drawing.pdf", 0));
    }

    #[tokio::test]
    async fn shutdown_unmaps_and_removes_the_shm_file() {
        // A slot number no real pool in this process uses.
        let worker = Arc::new(WorkerState::new(9_001));
        let shm = spawn::shm_path(worker.slot);
        let file = std::fs::OpenOptions::new().create(true).truncate(true).read(true).write(true).open(&shm).unwrap();
        file.set_len(64).unwrap();
        // Safety: the file is private to this test.
        *worker.shm.lock().await = Some(unsafe { memmap2::Mmap::map(&file) }.unwrap());
        drop(file);
        let pool = WorkerPool::new(vec![worker.clone()]);
        pool.shutdown(std::time::Duration::from_millis(100)).await;
        assert!(worker.shm.lock().await.is_none());
        assert!(!shm.exists(), "the SHM file must be gone after shutdown");
    }

    #[tokio::test]
    async fn report_failed_exchange_never_revives_a_permanent_slot() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::DeadPermanent);
        report_failed_exchange(&worker, 0);
        tokio::task::yield_now().await;
        assert_eq!(worker.status(), Status::DeadPermanent);
    }
}

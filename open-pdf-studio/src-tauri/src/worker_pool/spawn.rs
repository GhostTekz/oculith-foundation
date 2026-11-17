use super::state::{Status, WorkerState};
use anyhow::{anyhow, Context, Result};
use memmap2::MmapOptions;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

const SHM_SIZE: usize = 64 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// The SHM file of `slot`'s worker. Namespaced by this app process's id, the
/// same name the worker creates (pdfium-worker/src/shm.rs).
pub(crate) fn shm_path(slot: u32) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("pdfium-worker-{}-{}.shm", std::process::id(), slot))
}

pub async fn spawn_worker(worker: Arc<WorkerState>, exe_path: &std::path::Path) -> Result<()> {
    worker.set_status(Status::Spawning);
    worker.supports_ocg_visibility.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_annot_appearance.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_annot_appearance_index.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_region_pixel_clip.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_page_text.store(false, std::sync::atomic::Ordering::Release);

    // Namespace SHM by THIS app process's PID so a detached document window
    // running as its own process spawns workers with distinct SHM files
    // (else both processes fight over pdfium-worker-{slot}.shm → os error 1224).
    let ns = std::process::id().to_string();
    let mut cmd = Command::new(exe_path);
    cmd.arg(worker.slot.to_string())
        .arg(&ns)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // The bundled PDFium on Linux can leave its lazy PLT entry for C++ new
    // pointing at an unrelocated address. Resolve it when the worker starts;
    // otherwise the first FPDF_LoadMemDocument64 call can segfault.
    #[cfg(target_os = "linux")]
    cmd.env("LD_BIND_NOW", "1");
    // Hide the worker's console window — the GUI parent has no console to
    // share, so without this every pool worker pops up a black console box.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn()
        .with_context(|| format!("spawn worker {} from {:?}", worker.slot, exe_path))?;

    let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let mut reader = BufReader::new(stdout);

    // Wait for ready line (with timeout)
    let mut ready_line = String::new();
    timeout(READY_TIMEOUT, reader.read_line(&mut ready_line)).await
        .with_context(|| format!("worker {} ready timeout", worker.slot))?
        .with_context(|| format!("worker {} ready read", worker.slot))?;

    if !ready_line.contains("\"op\":\"ready\"") {
        return Err(anyhow!("worker {} did not send ready: {}", worker.slot, ready_line));
    }
    let ready: serde_json::Value = serde_json::from_str(&ready_line).context("parse worker ready")?;
    worker.supports_ocg_visibility.store(
        ready["ocg_visibility"].as_bool() == Some(true),
        std::sync::atomic::Ordering::Release,
    );
    worker.supports_annot_appearance.store(
        ready["annot_appearance"].as_bool() == Some(true),
        std::sync::atomic::Ordering::Release,
    );
    worker.supports_annot_appearance_index.store(
        ready["annot_appearance_index"].as_bool() == Some(true),
        std::sync::atomic::Ordering::Release,
    );
    worker.supports_region_pixel_clip.store(
        ready["region_pixel_clip"].as_bool() == Some(true),
        std::sync::atomic::Ordering::Release,
    );
    worker.supports_page_text.store(
        ready["page_text"].as_bool() == Some(true),
        std::sync::atomic::Ordering::Release,
    );

    // mmap the SHM file the worker created (same PID-namespaced path)
    let shm_path = shm_path(worker.slot);
    let file = std::fs::OpenOptions::new()
        .read(true).write(false)
        .open(&shm_path)
        .with_context(|| format!("open SHM {}", shm_path.display()))?;
    let mmap = unsafe {
        MmapOptions::new().len(SHM_SIZE).map(&file)
            .with_context(|| format!("mmap SHM {}", shm_path.display()))?
    };
    // Both sides have it mapped: the name can go. The mappings stay valid,
    // and a worker or app that dies leaves no file behind (in a RAM-backed
    // /tmp each one held 50 MB until the next reboot). Windows cannot remove
    // a mapped file: there the pool removes it when it stops
    // (WorkerPool::shutdown), and the next start sweeps what a crash left.
    #[cfg(unix)]
    let _ = std::fs::remove_file(&shm_path);

    // The app stopped the pool while this worker started (a respawn): it
    // must not outlive the shutdown.
    if worker.stopping.load(std::sync::atomic::Ordering::Acquire) {
        drop(stdin);
        let _ = child.kill().await;
        return Err(anyhow!("worker {} started while the pool was stopping", worker.slot));
    }

    // Stash handles in the WorkerState
    *worker.child.lock().await = Some(child);
    *worker.stdin.lock().await = Some(stdin);
    *worker.stdout.lock().await = Some(reader);
    *worker.shm.lock().await = Some(mmap);
    worker.incarnation.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    worker.set_status(Status::Ready);

    Ok(())
}

/// The app process id in a worker SHM file name
/// (`pdfium-worker-<pid>-<slot>.shm`), or None for any other file.
fn shm_file_owner(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("pdfium-worker-")?.strip_suffix(".shm")?;
    let (pid, slot) = rest.split_once('-')?;
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) || slot.parse::<u32>().is_err() {
        return None;
    }
    Some(pid)
}

/// Remove the SHM files of app processes that are gone: one per worker is
/// left behind whenever the app or a worker ended without cleaning up (on
/// Windows, where the name cannot go while it is mapped, every time).
fn remove_stale_shm_files() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    let own = std::process::id().to_string();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(shm_file_owner) else { continue };
        if pid != own && owner_gone(pid, &entry) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Only files named for a process id that no longer runs.
#[cfg(target_os = "linux")]
fn owner_gone(pid: &str, _entry: &std::fs::DirEntry) -> bool {
    !std::path::Path::new("/proc").join(pid).exists()
}

/// Windows refuses to delete a file that a live worker or app has mapped,
/// so a running instance's file survives the attempt. A file younger than a
/// minute is left alone as well: a worker that is just starting may not
/// have mapped it yet.
#[cfg(windows)]
fn owner_gone(_pid: &str, entry: &std::fs::DirEntry) -> bool {
    entry.metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= Duration::from_secs(60))
}

/// Elsewhere (macOS) the name is removed as soon as both sides map it.
#[cfg(not(any(target_os = "linux", windows)))]
fn owner_gone(_pid: &str, _entry: &std::fs::DirEntry) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_worker_shm_files_are_swept() {
        assert_eq!(shm_file_owner("pdfium-worker-1234-0.shm"), Some("1234"));
        assert_eq!(shm_file_owner("pdfium-worker-1234-12.shm"), Some("1234"));
        assert_eq!(shm_file_owner("pdfium-worker-1234-x.shm"), None);
        assert_eq!(shm_file_owner("pdfium-worker--0.shm"), None);
        assert_eq!(shm_file_owner("pdfium-worker-12a-0.shm"), None);
        assert_eq!(shm_file_owner("pdfium-worker-1234-0.shm.bak"), None);
        assert_eq!(shm_file_owner("drawing.pdf"), None);
    }

    #[test]
    fn the_shm_path_matches_the_worker_name() {
        let path = shm_path(3);
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(shm_file_owner(name), Some(std::process::id().to_string().as_str()));
        assert!(name.ends_with("-3.shm"));
    }
}

pub async fn spawn_pool(n_workers: u32, exe_path: &std::path::Path) -> Result<Vec<Arc<WorkerState>>> {
    remove_stale_shm_files();
    let mut workers = Vec::with_capacity(n_workers as usize);
    for slot in 0..n_workers {
        let w = Arc::new(WorkerState::new(slot));
        workers.push(w.clone());
        match spawn_worker(w.clone(), exe_path).await {
            Ok(_) => {
                eprintln!("[pool] worker {} ready", slot);
            }
            Err(e) => {
                eprintln!("[pool] worker {} spawn failed: {} — pool will run with N-1", slot, e);
                w.set_status(Status::DeadPermanent);
            }
        }
    }
    Ok(workers)
}

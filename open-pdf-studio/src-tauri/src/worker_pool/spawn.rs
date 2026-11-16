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

pub async fn spawn_worker(worker: Arc<WorkerState>, exe_path: &std::path::Path) -> Result<()> {
    worker.set_status(Status::Spawning);
    worker.supports_ocg_visibility.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_annot_appearance.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_annot_appearance_index.store(false, std::sync::atomic::Ordering::Release);
    worker.supports_region_pixel_clip.store(false, std::sync::atomic::Ordering::Release);

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

    // mmap the SHM file the worker created (same PID-namespaced path)
    let shm_path = format!(
        "{}/pdfium-worker-{}-{}.shm",
        std::env::temp_dir().to_string_lossy(),
        ns,
        worker.slot
    );
    let file = std::fs::OpenOptions::new()
        .read(true).write(false)
        .open(&shm_path)
        .with_context(|| format!("open SHM {}", shm_path))?;
    let mmap = unsafe {
        MmapOptions::new().len(SHM_SIZE).map(&file)
            .with_context(|| format!("mmap SHM {}", shm_path))?
    };
    // Both sides have it mapped: the name can go. The mappings stay valid,
    // and a worker or app that dies leaves no file behind (in a RAM-backed
    // /tmp each one held 50 MB until the next reboot). Windows cannot remove
    // a mapped file, so the name stays there as before.
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

/// Remove the SHM files of app processes that are gone: an earlier build
/// left one per worker behind whenever the app or a worker ended without
/// cleaning up. Only files named for a process id that no longer runs.
#[cfg(target_os = "linux")]
fn remove_stale_shm_files() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix("pdfium-worker-").and_then(|r| r.strip_suffix(".shm")) else { continue };
        let Some((pid, slot)) = rest.split_once('-') else { continue };
        if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) || slot.parse::<u32>().is_err() {
            continue;
        }
        if std::path::Path::new("/proc").join(pid).exists() {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

#[cfg(not(target_os = "linux"))]
fn remove_stale_shm_files() {}

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

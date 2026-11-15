use super::spawn::spawn_worker;
use super::state::{Status, WorkerState};
use super::priority::Priority;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const CRASH_WINDOW: Duration = Duration::from_secs(30);
const MAX_CRASHES_IN_WINDOW: usize = 3;
const RESPAWN_DELAY: Duration = Duration::from_secs(1);

/// Recover one failed process incarnation. Several queued requests may report
/// the same failure; only one of them may replace the child and SHM mapping.
pub async fn handle_worker_crash(worker: Arc<WorkerState>, exe_path: PathBuf, failed_incarnation: u64) {
    if worker.stopping.load(Ordering::Acquire)
        || worker.incarnation.load(Ordering::Acquire) != failed_incarnation
        || worker.recovery_requested.swap(true, Ordering::AcqRel) {
        return;
    }
    let _recovery = worker.recovery_lock.lock().await;
    if worker.stopping.load(Ordering::Acquire)
        || worker.incarnation.load(Ordering::Acquire) != failed_incarnation
        || worker.status() == Status::DeadPermanent {
        worker.recovery_requested.store(false, Ordering::Release);
        return;
    }
    worker.set_status(Status::Dead);
    let crashes = worker.crashes.fetch_add(1, Ordering::Release) + 1;
    let now = Instant::now();
    let recent_count = {
        let mut recent = worker.recent_crashes.lock().await;
        recent.retain(|time| now.duration_since(*time) < CRASH_WINDOW);
        recent.push_back(now);
        recent.len()
    };

    if recent_count < MAX_CRASHES_IN_WINDOW {
        eprintln!("[recovery] worker {} crashed (#{}); respawning in {:?}", worker.slot, crashes, RESPAWN_DELAY);
        tokio::time::sleep(RESPAWN_DELAY).await;
    }

    // No exchange may use the old pipe or mapping after this point. A timed
    // out native render may still be running, so terminate and wait for its
    // process before a replacement can reuse this slot's SHM filename.
    let _priority = worker.priority.acquire(Priority::Barrier).await;
    let _exchange = worker.request_lock.lock().await;
    if let Some(mut child) = worker.child.lock().await.take() {
        let _ = child.kill().await;
    }
    *worker.stdin.lock().await = None;
    *worker.stdout.lock().await = None;
    *worker.shm.lock().await = None;

    if recent_count >= MAX_CRASHES_IN_WINDOW {
        worker.set_status(Status::DeadPermanent);
        worker.recovery_requested.store(false, Ordering::Release);
        eprintln!("[recovery] worker {} crashed {}x in {:?} — marking DeadPermanent", worker.slot, recent_count, CRASH_WINDOW);
        return;
    }

    match spawn_worker(worker.clone(), &exe_path).await {
        Ok(_) => eprintln!("[recovery] worker {} respawned", worker.slot),
        Err(e) => {
            eprintln!("[recovery] worker {} respawn failed: {}", worker.slot, e);
            worker.set_status(Status::Dead);
        }
    }
    worker.recovery_requested.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn three_quick_crashes_marks_permanent() {
        // Use a non-existent exe path so respawn always fails — we just
        // care about the crash counter / DeadPermanent transition.
        let worker = Arc::new(WorkerState::new(0));
        let bad_path = PathBuf::from("C:/does-not-exist.exe");

        // First crash: status Dead, respawn attempted (fails, set Dead again)
        handle_worker_crash(worker.clone(), bad_path.clone(), 0).await;
        assert_eq!(worker.status(), Status::Dead);

        // Second crash within 30s: still Dead, not yet permanent
        handle_worker_crash(worker.clone(), bad_path.clone(), 0).await;
        // crashes counter is 2 now

        // Third crash: should hit MAX_CRASHES_IN_WINDOW
        handle_worker_crash(worker.clone(), bad_path, 0).await;
        assert_eq!(worker.status(), Status::DeadPermanent);
    }

    #[tokio::test]
    async fn old_incarnation_cannot_replace_a_new_worker() {
        let worker = Arc::new(WorkerState::new(0));
        worker.incarnation.store(2, Ordering::Release);
        worker.set_status(Status::Ready);
        handle_worker_crash(worker.clone(), PathBuf::from("missing-worker"), 1).await;
        assert_eq!(worker.status(), Status::Ready);
        assert_eq!(worker.crashes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn duplicate_failure_reports_start_only_one_recovery() {
        let worker = Arc::new(WorkerState::new(0));
        let path = PathBuf::from("missing-worker");
        let (first, second) = tokio::join!(
            handle_worker_crash(worker.clone(), path.clone(), 0),
            handle_worker_crash(worker.clone(), path, 0),
        );
        let _ = (first, second);
        assert_eq!(worker.crashes.load(Ordering::Acquire), 1);
    }
}

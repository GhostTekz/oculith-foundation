use super::spawn::spawn_worker;
use super::state::{Status, WorkerState};
use super::priority::Priority;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const CRASH_WINDOW: Duration = Duration::from_secs(30);
const MAX_CRASHES_IN_WINDOW: usize = 3;
#[cfg(not(test))]
const RESPAWN_DELAY: Duration = Duration::from_secs(1);
#[cfg(test)]
const RESPAWN_DELAY: Duration = Duration::from_millis(1);
/// Waits before each further attempt when a respawn fails (a busy disk, an
/// antivirus scan holding the executable, a full temp directory). After the
/// last one the slot is given up as DeadPermanent instead of staying Dead,
/// which nothing would ever recover.
#[cfg(not(test))]
const RESPAWN_RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
];
#[cfg(test)]
const RESPAWN_RETRY_BACKOFF: [Duration; 3] = [Duration::from_millis(1); 3];

/// Recover one failed process incarnation. Several queued requests may report
/// the same failure; only one of them may replace the child and SHM mapping.
pub async fn handle_worker_crash(worker: Arc<WorkerState>, exe_path: PathBuf, failed_incarnation: u64) {
    let respawn_worker = worker.clone();
    recover_with(worker, failed_incarnation, move || {
        let worker = respawn_worker.clone();
        let exe_path = exe_path.clone();
        async move { spawn_worker(worker, &exe_path).await }
    }).await
}

async fn recover_with<F, Fut>(worker: Arc<WorkerState>, failed_incarnation: u64, respawn: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
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
    worker.retire();
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

    let mut backoff = RESPAWN_RETRY_BACKOFF.iter();
    loop {
        match respawn().await {
            Ok(_) => {
                eprintln!("[recovery] worker {} respawned", worker.slot);
                break;
            }
            Err(e) => {
                eprintln!("[recovery] worker {} respawn failed: {}", worker.slot, e);
                worker.retire();
            }
        }
        let Some(wait) = backoff.next() else {
            worker.set_status(Status::DeadPermanent);
            eprintln!("[recovery] worker {} could not be respawned — marking DeadPermanent", worker.slot);
            break;
        };
        tokio::time::sleep(*wait).await;
        if worker.stopping.load(Ordering::Acquire) {
            break;
        }
    }
    worker.recovery_requested.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::AtomicUsize;

    /// A respawn that succeeds like spawn_worker: a new process, Ready.
    fn fake_respawn(worker: Arc<WorkerState>) -> impl Fn() -> std::future::Ready<anyhow::Result<()>> {
        move || {
            worker.incarnation.fetch_add(1, Ordering::AcqRel);
            worker.set_status(Status::Ready);
            std::future::ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn three_quick_crashes_marks_permanent() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::Ready);

        recover_with(worker.clone(), 0, fake_respawn(worker.clone())).await;
        assert_eq!(worker.status(), Status::Ready);
        recover_with(worker.clone(), 1, fake_respawn(worker.clone())).await;
        assert_eq!(worker.status(), Status::Ready);
        // Third crash within the window: the crash limit.
        recover_with(worker.clone(), 2, fake_respawn(worker.clone())).await;
        assert_eq!(worker.status(), Status::DeadPermanent);
    }

    #[tokio::test]
    async fn a_failed_respawn_is_retried_until_it_succeeds() {
        let worker = Arc::new(WorkerState::new(0));
        let attempts = Arc::new(AtomicUsize::new(0));
        let (w, a) = (worker.clone(), attempts.clone());
        recover_with(worker.clone(), 0, move || {
            let attempt = a.fetch_add(1, Ordering::AcqRel);
            if attempt < 2 {
                return std::future::ready(Err(anyhow::anyhow!("spawn failed")));
            }
            w.incarnation.fetch_add(1, Ordering::AcqRel);
            w.set_status(Status::Ready);
            std::future::ready(Ok(()))
        }).await;
        assert_eq!(attempts.load(Ordering::Acquire), 3);
        assert_eq!(worker.status(), Status::Ready);
        assert!(!worker.recovery_requested.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn a_slot_that_never_respawns_is_given_up_not_left_dead() {
        let worker = Arc::new(WorkerState::new(0));
        handle_worker_crash(worker.clone(), PathBuf::from("does-not-exist-worker"), 0).await;
        assert_eq!(worker.status(), Status::DeadPermanent);
        assert!(!worker.recovery_requested.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn a_permanent_slot_is_not_recovered_again() {
        let worker = Arc::new(WorkerState::new(0));
        worker.set_status(Status::DeadPermanent);
        let attempts = Arc::new(AtomicUsize::new(0));
        let a = attempts.clone();
        recover_with(worker.clone(), 0, move || {
            a.fetch_add(1, Ordering::AcqRel);
            std::future::ready(Ok(()))
        }).await;
        assert_eq!(attempts.load(Ordering::Acquire), 0);
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

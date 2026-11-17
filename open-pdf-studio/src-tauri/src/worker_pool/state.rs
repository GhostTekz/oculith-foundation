use memmap2::Mmap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout};
use super::priority::PriorityGate;
use tokio::sync::Mutex;

/// Status of a single worker slot.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Spawning = 0,
    Ready = 1,
    Dead = 2,
    DeadPermanent = 3,
}

pub struct WorkerState {
    pub slot: u32,
    pub status: AtomicU8,
    pub queue_depth: AtomicUsize,
    pub child: Arc<Mutex<Option<Child>>>,
    pub stdin: Arc<Mutex<Option<ChildStdin>>>,
    pub stdout: Arc<Mutex<Option<BufReader<ChildStdout>>>>,
    pub shm: Arc<Mutex<Option<Mmap>>>,
    pub crashes: AtomicUsize,
    pub recent_crashes: Arc<Mutex<VecDeque<std::time::Instant>>>,
    pub recovery_requested: AtomicBool,
    pub recovery_lock: Arc<Mutex<()>>,
    pub incarnation: AtomicU64,
    /// Serializes the FULL request round-trip (write request → read response →
    /// read SHM) per worker. The wire protocol has no request-id demux: with two
    /// in-flight requests on one worker, caller A could read caller B's response
    /// line and the SHM bitmap gets overwritten between response and read. Held
    /// across the whole exchange, concurrent callers queue instead of corrupting.
    pub request_lock: Arc<Mutex<()>>,
    pub priority: PriorityGate,
    /// Counts cache invalidations sent to this worker. A region rendered in
    /// several exchanges compares it between tiles, so an invalidation in
    /// between cannot stitch pixels of two document versions together.
    pub invalidations: AtomicU64,
    /// Laatste dispatch naar déze worker (ms sinds epoch) + of hij sindsdien al
    /// een Trim kreeg. Open pagina-handles kosten op zware CAD-pagina's ruim
    /// 1 GB per worker; per-worker trimmen laat de niet-affinity-workers na de
    /// parallelle eerste render vanzelf afkoelen terwijl de actieve heet blijft.
    pub last_used_ms: AtomicU64,
    pub trimmed: AtomicBool,
    /// Advertised by the sidecar Ready message. Older workers must not
    /// silently ignore a selected OCG state.
    pub supports_ocg_visibility: AtomicBool,
    /// Advertised by the sidecar Ready message: the worker rasters the
    /// requested annotation appearances. Older workers would ignore the
    /// field and leave those markups out of the bitmap.
    pub supports_annot_appearance: AtomicBool,
    /// The worker also selects markups by /Annots position.
    pub supports_annot_appearance_index: AtomicBool,
    /// The worker can render a pixel-aligned subsection of a large region.
    pub supports_region_pixel_clip: AtomicBool,
    /// The worker reads a page's text (op page_text).
    pub supports_page_text: AtomicBool,
    /// Set when the app stops the pool: a failure seen after this point is
    /// the shutdown itself, so recovery must not spawn a replacement.
    pub stopping: AtomicBool,
}

impl WorkerState {
    pub fn new(slot: u32) -> Self {
        Self {
            slot,
            status: AtomicU8::new(Status::Spawning as u8),
            queue_depth: AtomicUsize::new(0),
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            stdout: Arc::new(Mutex::new(None)),
            shm: Arc::new(Mutex::new(None)),
            crashes: AtomicUsize::new(0),
            recent_crashes: Arc::new(Mutex::new(VecDeque::new())),
            recovery_requested: AtomicBool::new(false),
            recovery_lock: Arc::new(Mutex::new(())),
            incarnation: AtomicU64::new(0),
            request_lock: Arc::new(Mutex::new(())),
            priority: PriorityGate::default(),
            invalidations: AtomicU64::new(0),
            last_used_ms: AtomicU64::new(0),
            trimmed: AtomicBool::new(true),
            supports_ocg_visibility: AtomicBool::new(false),
            supports_annot_appearance: AtomicBool::new(false),
            supports_annot_appearance_index: AtomicBool::new(false),
            supports_region_pixel_clip: AtomicBool::new(false),
            supports_page_text: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> Status {
        match self.status.load(Ordering::Acquire) {
            1 => Status::Ready,
            2 => Status::Dead,
            3 => Status::DeadPermanent,
            _ => Status::Spawning,
        }
    }

    pub fn set_status(&self, s: Status) {
        self.status.store(s as u8, Ordering::Release);
    }

    /// Take the slot out of routing after a failure: Dead, unless it is
    /// already DeadPermanent, which only a stop or the crash limit sets and
    /// nothing may undo. Returns whether the status changed to Dead.
    pub fn retire(&self) -> bool {
        let mut current = self.status.load(Ordering::Acquire);
        loop {
            if current == Status::DeadPermanent as u8 || current == Status::Dead as u8 {
                return false;
            }
            match self.status.compare_exchange_weak(current, Status::Dead as u8, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    /// As [`Self::retire`], only while the slot still runs process
    /// `incarnation`: a failure of an older process must not take its
    /// replacement out of service.
    pub fn retire_incarnation(&self, incarnation: u64) -> bool {
        self.incarnation.load(Ordering::Acquire) == incarnation && self.retire()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_status_is_spawning() {
        let w = WorkerState::new(0);
        assert_eq!(w.status(), Status::Spawning);
    }

    #[test]
    fn status_transitions() {
        let w = WorkerState::new(0);
        w.set_status(Status::Ready);
        assert_eq!(w.status(), Status::Ready);
        w.set_status(Status::Dead);
        assert_eq!(w.status(), Status::Dead);
    }

    #[test]
    fn retire_never_downgrades_dead_permanent() {
        let w = WorkerState::new(0);
        w.set_status(Status::Ready);
        assert!(w.retire());
        assert_eq!(w.status(), Status::Dead);
        w.set_status(Status::DeadPermanent);
        assert!(!w.retire());
        assert_eq!(w.status(), Status::DeadPermanent);
    }

    #[test]
    fn retire_incarnation_ignores_an_older_process() {
        let w = WorkerState::new(0);
        w.set_status(Status::Ready);
        w.incarnation.store(3, Ordering::Release);
        assert!(!w.retire_incarnation(2));
        assert_eq!(w.status(), Status::Ready);
        assert!(w.retire_incarnation(3));
        assert_eq!(w.status(), Status::Dead);
    }

    #[test]
    fn queue_depth_atomic_increments() {
        let w = WorkerState::new(0);
        w.queue_depth.fetch_add(1, Ordering::Release);
        w.queue_depth.fetch_add(1, Ordering::Release);
        assert_eq!(w.queue_depth.load(Ordering::Acquire), 2);
    }
}

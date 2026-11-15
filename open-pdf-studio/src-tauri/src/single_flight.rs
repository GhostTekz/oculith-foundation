//! One load per key at a time.
//!
//! The native caches read a file or parse a document outside their own lock,
//! so a cold read of one large file does not hold up every other document.
//! Without a gate, two requests that miss the cache together both did the
//! whole load: two full reads of a 600 MB drawing set, or two PDFium parses.
//! A caller runs its load inside `run`; a second caller for the same key
//! waits for the first to finish and then looks in the cache again, where it
//! normally finds the first caller's result. Different keys never wait for
//! each other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct SingleFlight {
    gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl SingleFlight {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `load` while no other `run` for `key` runs. The caller re-checks
    /// its cache at the start of `load`: a waiter usually finds the value the
    /// previous holder just stored.
    pub fn run<T>(&self, key: &str, load: impl FnOnce() -> T) -> T {
        let gate = {
            let mut gates = self.gates.lock().unwrap_or_else(|p| p.into_inner());
            gates.entry(key.to_string()).or_default().clone()
        };
        let result = {
            let _held = gate.lock().unwrap_or_else(|p| p.into_inner());
            load()
        };
        let mut gates = self.gates.lock().unwrap_or_else(|p| p.into_inner());
        // The map holds one reference and this caller one; any waiter that
        // took the gate from the map holds another, so the gate stays for it.
        if Arc::strong_count(&gate) == 2 {
            gates.remove(key);
        }
        result
    }

    /// Keys with a gate (a load running or waited for); for tests.
    #[cfg(test)]
    pub fn active(&self) -> usize {
        self.gates.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::SingleFlight;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};
    use std::time::Duration;

    #[test]
    fn concurrent_misses_for_one_key_load_once() {
        let flight = Arc::new(SingleFlight::new());
        let cache: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>> = Arc::default();
        let loads = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (flight, cache, loads, start) = (flight.clone(), cache.clone(), loads.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    flight.run("set.pdf", || {
                        if let Some(hit) = cache.lock().unwrap().get("set.pdf") {
                            return hit.clone();
                        }
                        loads.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(30));
                        let bytes = Arc::new(vec![7_u8; 1024]);
                        cache.lock().unwrap().insert("set.pdf".into(), bytes.clone());
                        bytes
                    })
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(results.iter().all(|r| Arc::ptr_eq(r, &results[0])));
        assert_eq!(flight.active(), 0, "the gate is gone once nobody waits");
    }

    #[test]
    fn different_keys_do_not_wait_for_each_other() {
        let flight = Arc::new(SingleFlight::new());
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let slow = {
            let flight = flight.clone();
            std::thread::spawn(move || {
                flight.run("a.pdf", || {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
            })
        };
        held_rx.recv().unwrap();
        assert_eq!(flight.run("b.pdf", || 2), 2);
        release_tx.send(()).unwrap();
        slow.join().unwrap();
        assert_eq!(flight.active(), 0);
    }

    #[test]
    fn a_panicking_load_does_not_wedge_the_key() {
        let flight = Arc::new(SingleFlight::new());
        let f = flight.clone();
        let _ = std::thread::spawn(move || f.run("x.pdf", || panic!("parse failed"))).join();
        assert_eq!(flight.run("x.pdf", || 5), 5);
    }
}

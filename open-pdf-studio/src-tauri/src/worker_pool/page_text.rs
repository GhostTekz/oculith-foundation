//! Page text read by the PDFium workers, for whole-set reads.
//!
//! A scan of a large set reads every page's text. Through PDF.js that runs
//! in the window's process, and each extra reader keeps a buffer the size
//! of the file. Here a worker process reads the page (pdfium-worker
//! text.rs builds PDF.js text items) and the main process keeps the result,
//! keyed by the file's modification time and length, so the next scan of
//! the same drawing reads no page twice.

use super::*;
use std::collections::{HashMap, VecDeque};

/// Pages' text kept for the next scan of the same file: a few large sets.
const TEXT_CACHE_BYTES: usize = 256 * 1024 * 1024;
/// A text read waits behind the view's renders (background priority) but
/// may take longer than a thumbnail's deadline to reach the head of the queue.
const TEXT_QUEUE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct Key {
    path: String,
    page: u32,
    modified: Option<std::time::SystemTime>,
    len: u64,
}

/// Least recently used page texts up to a byte budget.
#[derive(Default)]
pub struct TextCache {
    entries: HashMap<Key, Arc<Vec<u8>>>,
    order: VecDeque<Key>,
    bytes: usize,
    /// Bumped when a file is rewritten (forget): a read that began before
    /// is not kept, even if the new file has the old modification time and
    /// length (an atomic rewrite can).
    generations: HashMap<String, u64>,
}

impl TextCache {
    fn get(&mut self, key: &Key) -> Option<Arc<Vec<u8>>> {
        let hit = self.entries.get(key).cloned()?;
        if let Some(i) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(i).expect("position found");
            self.order.push_back(k);
        }
        Some(hit)
    }

    fn put(&mut self, key: Key, text: Arc<Vec<u8>>) {
        if text.len() > TEXT_CACHE_BYTES {
            return;
        }
        if let Some(old) = self.entries.insert(key.clone(), text.clone()) {
            self.bytes -= old.len();
            self.order.retain(|k| k != &key);
        }
        self.bytes += text.len();
        self.order.push_back(key);
        while self.bytes > TEXT_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(gone) = self.entries.remove(&oldest) {
                self.bytes -= gone.len();
            }
        }
    }

    fn generation(&self, path: &str) -> u64 {
        self.generations.get(path).copied().unwrap_or(0)
    }

    /// Forget every page of `path` (the file was rewritten).
    pub fn forget(&mut self, path: &str) {
        *self.generations.entry(path.to_string()).or_insert(0) += 1;
        let gone: Vec<Key> = self.entries.keys().filter(|k| k.path == path).cloned().collect();
        for k in gone {
            if let Some(t) = self.entries.remove(&k) {
                self.bytes -= t.len();
            }
        }
        self.order.retain(|k| k.path != path);
    }
}

impl WorkerPool {
    /// Whether every live worker reads page text (an older worker binary does not).
    pub fn reads_page_text(&self) -> bool {
        let live: Vec<_> = self.workers.iter().filter(|w| w.status() == Status::Ready).collect();
        !live.is_empty() && live.iter().all(|w| w.supports_page_text.load(Ordering::Acquire))
    }

    /// The text items of page `page_index` (0-based) of the file at `path`,
    /// as JSON `{"items":[...],"view":[...]}`. `expect_len` is the length of
    /// the file the caller has open: a file of another length is refused, so
    /// text never comes from a different version of the drawing.
    pub async fn page_text(&self, path: &str, page_index: u32, expect_len: Option<u64>) -> Result<Arc<Vec<u8>>> {
        let stamp = file_stamp(path).await?;
        if expect_len.is_some_and(|len| len != stamp.len) {
            return Err(reported("page text: the file on disk is not the drawing that is open"));
        }
        let key = Key { path: path.to_string(), page: page_index, modified: stamp.modified, len: stamp.len };
        let generation = {
            let mut cache = self.text_cache.lock().await;
            if let Some(hit) = cache.get(&key) {
                return Ok(hit);
            }
            cache.generation(path)
        };
        let queue_deadline = tokio::time::Instant::now() + TEXT_QUEUE_TIMEOUT;
        let mut tried: Vec<usize> = Vec::new();
        let mut last_error = anyhow!("PDFium worker pool has no ready workers");
        for _attempt in 0..2 {
            let mut depths = self.depths();
            for &slot in &tried {
                depths[slot] = usize::MAX;
            }
            for (slot, worker) in self.workers.iter().enumerate() {
                if !worker.supports_page_text.load(Ordering::Acquire) {
                    depths[slot] = usize::MAX;
                }
            }
            if depths.iter().all(|&d| d == usize::MAX) {
                return Err(last_error);
            }
            // Spread a set's pages over the workers; the page's own worker
            // when it is free (it may hold the document open already).
            let slot = routing::pick_worker(path, page_index, &depths, false);
            tried.push(slot);
            let worker = self.workers[slot].clone();
            let mut served = worker.incarnation.load(Ordering::Acquire);
            self.touch(&worker);
            let _queued = QueueDepthGuard::new(worker.clone());
            let result = self.text_on_worker(worker.clone(), path, page_index, queue_deadline, &mut served).await;
            drop(_queued);
            match result {
                Ok(text) => {
                    // The file may have been rewritten while the worker read it.
                    let after = file_stamp(path).await?;
                    if after.modified != stamp.modified || after.len != stamp.len {
                        return Err(reported("page text: the file changed while it was read"));
                    }
                    let text = Arc::new(text);
                    let mut cache = self.text_cache.lock().await;
                    // The file was rewritten while this read ran: not kept.
                    if cache.generation(path) == generation {
                        cache.put(key, text.clone());
                    }
                    return Ok(text);
                }
                Err(error) => {
                    if reported_render_error(&error) {
                        return Err(error);
                    }
                    if !worker_unavailable(&error) {
                        report_failed_exchange(&worker, served);
                    }
                    last_error = error;
                }
            }
        }
        Err(last_error)
    }

    async fn text_on_worker(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        queue_deadline: tokio::time::Instant,
        served: &mut u64,
    ) -> Result<Vec<u8>> {
        let _priority = tokio::time::timeout_at(queue_deadline, worker.priority.acquire(Priority::Background))
            .await.map_err(|_| anyhow!(QUEUE_DEADLINE_ERROR))?;
        let request_lock = worker.request_lock.clone();
        let _exchange = request_lock.lock().await;
        *served = worker.incarnation.load(Ordering::Acquire);
        if worker.status() != Status::Ready {
            return Err(anyhow!("{} {}", WORKER_UNAVAILABLE, worker.slot));
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Release);
        let req_line = format!("{}\n", json!({ "op": "page_text", "id": id, "path": path, "page_index": page_index }));
        {
            let mut stdin_guard = worker.stdin.lock().await;
            let stdin = stdin_guard.as_mut().ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin.write_all(req_line.as_bytes()).await.with_context(|| format!("write to worker {}", worker.slot))?;
            stdin.flush().await?;
        }
        let mut resp_line = String::new();
        {
            let mut stdout_guard = worker.stdout.lock().await;
            let stdout = stdout_guard.as_mut().ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
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
        let shm_guard = worker.shm.lock().await;
        let mmap = shm_guard.as_ref().ok_or_else(|| anyhow!("worker {} has no shm", worker.slot))?;
        let len = text_reply_length(&resp, id, mmap)?;
        Ok(mmap[TEXT_HEADER..TEXT_HEADER + len].to_vec())
    }
}

const TEXT_HEADER: usize = 32;

/// The length of the text in the SHM region for the reply to request `id`.
/// A worker's error (a page PDFium cannot read) is the caller's to report;
/// the worker itself is fine.
fn text_reply_length(reply: &serde_json::Value, id: u64, mapping: &[u8]) -> Result<usize> {
    if reply["id"].as_u64() != Some(id) {
        return Err(anyhow!("page text reply for another request: {reply}"));
    }
    if reply["ok"].as_bool() != Some(true) {
        return Err(reported(format!("page text: {}", reply["error"].as_str().unwrap_or("unreadable page"))));
    }
    let len = reply["text_bytes"].as_u64().ok_or_else(|| anyhow!("page text reply without length: {reply}"))? as usize;
    if mapping.len() < TEXT_HEADER + len
        || u64::from_le_bytes(mapping[8..16].try_into().expect("8 bytes")) as usize != len
        || mapping[0..8] != [0; 8]
    {
        return Err(anyhow!("page text: SHM header disagrees with the reply"));
    }
    Ok(len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str, page: u32) -> Key {
        Key { path: path.into(), page, modified: None, len: 10 }
    }

    #[test]
    fn the_cache_keeps_recent_pages_within_its_budget() {
        let mut cache = TextCache::default();
        let big = TEXT_CACHE_BYTES / 3 + 1;
        cache.put(key("a.pdf", 1), Arc::new(vec![0; big]));
        cache.put(key("a.pdf", 2), Arc::new(vec![0; big]));
        // Using page 1 makes page 2 the oldest.
        assert!(cache.get(&key("a.pdf", 1)).is_some());
        cache.put(key("a.pdf", 3), Arc::new(vec![0; big]));
        assert!(cache.get(&key("a.pdf", 2)).is_none());
        assert!(cache.get(&key("a.pdf", 1)).is_some());
        assert!(cache.get(&key("a.pdf", 3)).is_some());
        assert!(cache.bytes <= TEXT_CACHE_BYTES);
    }

    #[test]
    fn another_version_of_the_file_is_another_entry_and_forget_drops_the_path() {
        let mut cache = TextCache::default();
        cache.put(key("a.pdf", 1), Arc::new(b"old".to_vec()));
        let newer = Key { len: 11, ..key("a.pdf", 1) };
        assert!(cache.get(&newer).is_none());
        cache.put(key("b.pdf", 1), Arc::new(b"b".to_vec()));
        cache.forget("a.pdf");
        assert!(cache.get(&key("a.pdf", 1)).is_none());
        assert!(cache.get(&key("b.pdf", 1)).is_some());
        assert_eq!(cache.bytes, 1);
    }

    #[test]
    fn a_rewrite_bumps_the_file_generation() {
        let mut cache = TextCache::default();
        let before = cache.generation("a.pdf");
        cache.forget("a.pdf");
        assert_eq!(cache.generation("a.pdf"), before + 1);
        assert_eq!(cache.generation("b.pdf"), 0);
    }

    #[test]
    fn a_reply_must_match_its_request_and_the_shm_header() {
        let mut mapping = vec![0u8; 64];
        mapping[8..16].copy_from_slice(&5u64.to_le_bytes());
        let ok = serde_json::json!({ "id": 4, "ok": true, "text_bytes": 5 });
        assert_eq!(text_reply_length(&ok, 4, &mapping).unwrap(), 5);
        assert!(text_reply_length(&ok, 5, &mapping).is_err());
        let wrong_len = serde_json::json!({ "id": 4, "ok": true, "text_bytes": 6 });
        assert!(text_reply_length(&wrong_len, 4, &mapping).is_err());
        // A bitmap header (width set) is not text.
        mapping[0] = 1;
        assert!(text_reply_length(&ok, 4, &mapping).is_err());
        let failed = serde_json::json!({ "id": 4, "ok": false, "error": "page 9: bad" });
        let error = text_reply_length(&failed, 4, &[0; 64]).unwrap_err();
        assert!(reported_render_error(&error), "an unreadable page is not a worker failure");
    }
}

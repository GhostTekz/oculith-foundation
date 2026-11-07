//! A small LRU map bounded by entry count and by a byte total that is kept
//! as a running sum (no walk over the entries per insert). Used for the
//! path-keyed native caches (source bytes, PDFium documents, thumbnails).

use std::borrow::Borrow;
use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;

pub struct ByteLru<K, V> {
    map: HashMap<K, Slot<V>>,
    // Recency order: tick -> key. Every use moves the key to a new tick.
    order: BTreeMap<u64, K>,
    tick: u64,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

struct Slot<V> {
    value: V,
    size: usize,
    tick: u64,
}

impl<K: Eq + Hash + Clone, V> ByteLru<K, V> {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: BTreeMap::new(),
            tick: 0,
            bytes: 0,
            max_entries: max_entries.max(1),
            max_bytes,
        }
    }

    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }

    /// The value for `key`; a hit becomes the most recently used entry.
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        let tick = self.next_tick();
        let slot = self.map.get_mut(key)?;
        if let Some(k) = self.order.remove(&slot.tick) {
            self.order.insert(tick, k);
        }
        slot.tick = tick;
        Some(&slot.value)
    }

    pub fn contains_key<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.map.contains_key(key)
    }

    /// Insert (or replace) `key`, `size` bytes, as the most recent entry, then
    /// evict least recently used entries above the limits. The new entry is
    /// never evicted, even when it alone exceeds the byte limit. Returns the
    /// evicted and replaced values, so the caller can drop them where that
    /// is cheap (a PDFium document closes under the global FFI lock).
    pub fn insert(&mut self, key: K, value: V, size: usize) -> Vec<V> {
        let mut out = Vec::new();
        if let Some(old) = self.remove(&key) {
            out.push(old);
        }
        let tick = self.next_tick();
        self.order.insert(tick, key.clone());
        self.map.insert(key, Slot { value, size, tick });
        self.bytes += size;
        while self.map.len() > 1 && (self.map.len() > self.max_entries || self.bytes > self.max_bytes) {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            if let Some(slot) = self.map.remove(&oldest) {
                self.bytes -= slot.size;
                out.push(slot.value);
            }
        }
        out
    }

    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        let slot = self.map.remove(key)?;
        self.order.remove(&slot.tick);
        self.bytes -= slot.size;
        Some(slot.value)
    }

    /// Keep only the entries for which `keep` is true.
    pub fn retain(&mut self, mut keep: impl FnMut(&K, &V) -> bool) {
        let gone: Vec<K> = self.map.iter().filter(|(k, s)| !keep(k, &s.value)).map(|(k, _)| k.clone()).collect();
        for key in gone {
            self.remove(&key);
        }
    }

    /// Remove every entry and return the values.
    pub fn drain(&mut self) -> Vec<V> {
        self.order.clear();
        self.bytes = 0;
        self.map.drain().map(|(_, slot)| slot.value).collect()
    }

    pub fn clear(&mut self) {
        self.drain();
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::ByteLru;

    #[test]
    fn evicts_the_least_recently_used_entry_by_bytes() {
        let mut lru = ByteLru::new(10, 10);
        assert!(lru.insert("a", 1, 4).is_empty());
        assert!(lru.insert("b", 2, 4).is_empty());
        assert_eq!(lru.get("a"), Some(&1));
        assert_eq!(lru.insert("c", 3, 4), vec![2], "b was least recently used");
        assert_eq!(lru.bytes(), 8);
        assert!(lru.contains_key("a") && lru.contains_key("c"));
    }

    #[test]
    fn evicts_by_entry_count_and_keeps_an_oversized_newest_entry() {
        let mut lru = ByteLru::new(2, 100);
        lru.insert(1, 'a', 1);
        lru.insert(2, 'b', 1);
        assert_eq!(lru.insert(3, 'c', 1), vec!['a']);
        assert_eq!(lru.insert(4, 'd', 1000), vec!['b', 'c']);
        assert_eq!(lru.len(), 1);
        assert_eq!(lru.get(&4), Some(&'d'));
        assert_eq!(lru.bytes(), 1000);
    }

    #[test]
    fn replace_remove_retain_and_drain_keep_the_byte_total() {
        let mut lru = ByteLru::new(10, 100);
        lru.insert("a".to_string(), 1, 5);
        assert_eq!(lru.insert("a".to_string(), 2, 7), vec![1]);
        lru.insert("b".to_string(), 3, 3);
        assert_eq!(lru.bytes(), 10);
        lru.retain(|k, _| k != "a");
        assert_eq!(lru.bytes(), 3);
        assert_eq!(lru.remove("b"), Some(3));
        assert_eq!(lru.bytes(), 0);
        lru.insert("c".to_string(), 4, 2);
        assert_eq!(lru.drain(), vec![4]);
        assert!(lru.is_empty());
        assert_eq!(lru.bytes(), 0);
    }
}

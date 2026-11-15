// Byte-bounded LRU for the continuous view's low-resolution page previews.
//
// A preview is a canvas at half scale: an A0 sheet is ~1.2k×1.7k px, 8 MB.
// The previews used to sit in a plain Map that only a document close or a
// view switch emptied, so paging a large drawing set kept adding canvases
// that the shared bitmap budget never saw. This cache holds at most
// `maxBytes`, reports its bytes to the budget (bitmap-budget.js), and gives an
// evicted canvas its pixels back at once (width/height 0) instead of waiting
// for the garbage collector.
//
// Pure: no DOM, so it is unit-testable under plain node.

/** Bytes of pixels a canvas holds (RGBA). */
export function canvasBytes(canvas) {
  const w = Number(canvas?.width) || 0;
  const h = Number(canvas?.height) || 0;
  return w > 0 && h > 0 ? w * h * 4 : 0;
}

function releaseCanvas(canvas) {
  try { canvas.width = 0; canvas.height = 0; } catch { /* nothing to free */ }
}

/**
 * @param {{ maxBytes: number, release?: (canvas: any) => void }} opts
 */
export function createLowResPreviewCache({ maxBytes, release = releaseCanvas }) {
  /** @type {Map<string, { canvas: any, scale: number, bytes: number }>} */
  const entries = new Map();
  let total = 0;

  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return 0;
    entries.delete(key);
    total -= entry.bytes;
    release(entry.canvas);
    return entry.bytes;
  };

  const cache = {
    maxBytes,
    get size() { return entries.size; },
    bytes() { return total; },
    has(key) { return entries.has(key); },
    /** The entry for `key`, marked as most recently used. */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    /**
     * Keep `canvas` under `key`, then drop the least recently used previews
     * until the cache fits its cap. A canvas larger than the cap on its own is
     * released and not kept. @returns {boolean} kept
     */
    set(key, canvas, scale) {
      remove(key);
      const bytes = canvasBytes(canvas);
      if (bytes > maxBytes) {
        release(canvas);
        return false;
      }
      entries.set(key, { canvas, scale, bytes });
      total += bytes;
      while (total > maxBytes && entries.size > 1) {
        remove(entries.keys().next().value);
      }
      return true;
    },
    /** Drop the least recently used preview; the newest always stays. @returns {number} bytes freed */
    evictOldest() {
      if (entries.size <= 1) return 0;
      return remove(entries.keys().next().value);
    },
    clear() {
      for (const key of Array.from(entries.keys())) remove(key);
    },
  };
  return cache;
}

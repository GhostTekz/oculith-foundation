// Page changes: which page went where when pages are inserted, deleted,
// moved, replaced or merged in, for whatever keeps its own data by page
// number (a plug-in's records, read results or notes). The page operations
// (page-manager.js) announce each change, and undo and redo announce it
// again, so such data can follow its pages instead of naming the page that
// now sits at its old number.
//
// A listener gets one event at a time, awaited in order:
//   { type: 'write', change, source, target }  before the changed document
//     is written to bytes. `source` is the pdf-lib document the pages came
//     from (its catalog as it was before the change), `target` the one that
//     is written: the same document, or a new one the pages were copied
//     into. A listener may rewrite its own catalog entries in `target`.
//   { type: 'changed', change }  once the document shows the new pages,
//     before it is drawn.
//   { type: 'undone', change } / { type: 'redone', change }  after undo or
//     redo of the change restored the document's bytes.
// The `change` object is the same in all four, so a listener can keep what
// it needs to step back with it (a WeakMap keyed by the change).
//
// change: { doc, operation, before, after, pages, pageAt(old) }
//   operation  'insert' | 'paste' | 'merge' | 'delete' | 'move' | 'replace'
//   before / after  the page counts
//   pages  a Map of old page -> new page for every page that stayed (1-based)
//   pageAt(old)  the new number of old page `old`, or null when it went
// A page that is new (inserted, pasted, merged in, or a replacement) has
// no old page.

const listeners = new Set();

/** Listen to page changes; returns the function that stops listening. */
export function onPageChange(listener) {
  if (typeof listener !== 'function') throw new TypeError('A page change listener must be a function.');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The change of `doc` described by `pageMapping` (an object or Map of old
 * page -> new page, or null for a page that went), from `before` to `after`
 * pages. Null when nothing moved: same count, every page in its place.
 */
export function pageChange(doc, operation, pageMapping, before, after) {
  const pages = new Map();
  const entries = pageMapping instanceof Map ? [...pageMapping] : Object.entries(pageMapping || {});
  for (const [from, to] of entries) {
    const old = Number(from), next = Number(to);
    if (Number.isInteger(old) && old >= 1 && to != null && Number.isInteger(next) && next >= 1) pages.set(old, next);
  }
  if (before === after && pages.size === before && [...pages].every(([a, b]) => a === b)) return null;
  return new PageChange(doc, operation, before, after, pages);
}

// A class, not a plain object: the undo history keeps the very object (its
// copy of a command does not copy or walk into a class instance), so
// listeners find what they kept for it.
class PageChange {
  constructor(doc, operation, before, after, pages) {
    Object.assign(this, { doc, operation, before, after, pages });
    Object.freeze(this);
  }

  pageAt(old) { return this.pages.get(Number(old)) ?? null; }
}

async function announce(event) {
  for (const listener of [...listeners]) {
    try {
      await listener(event);
    } catch (error) {
      console.warn(`[pages] a page ${event.type} listener failed:`, error?.message || error);
    }
  }
}

/** Before the changed document is written to bytes (see the top of this file). */
export function writePageChange(change, source, target = source) {
  return change ? announce({ type: 'write', change, source, target }) : Promise.resolve();
}

/** The document holds the new pages. */
export function announcePageChange(change) {
  return change ? announce({ type: 'changed', change }) : Promise.resolve();
}

/** Undo (`undone`) or redo of the change restored the document's bytes. */
export function announcePageChangeStep(change, undone) {
  return change ? announce({ type: undone ? 'undone' : 'redone', change }) : Promise.resolve();
}

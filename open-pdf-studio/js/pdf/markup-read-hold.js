// While a save writes a document, markups read from its file wait to enter the
// model.
//
// A save takes the document's markups and its set of read pages at one moment
// and refuses to write when the model changed meanwhile ("The document changed
// while saving"): a page that became read during the save would otherwise be
// written from markups the save never took, and its markups in the file would
// be dropped. Pages are read lazily (the sheet on screen, a whole-document
// read, the pages left unread after a page change), so such a read landing in
// the middle of a save made the save fail for no edit of the user. The save
// holds those reads instead; each read adds its markups once the save is done.

import { $RAW } from 'solid-js/store';

// doc -> Set of promises, one per running save. Keyed by the raw document:
// the store hands out a proxy of the same document.
const holds = new WeakMap();
const raw = (doc) => (doc && typeof doc === 'object' ? doc[$RAW] || doc : null);

/** Hold markup reads of `doc` until the returned function is called. */
export function holdMarkupReads(doc) {
  doc = raw(doc);
  if (!doc) return () => {};
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let set = holds.get(doc);
  if (!set) holds.set(doc, (set = new Set()));
  set.add(held);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    set.delete(held);
    if (!set.size && holds.get(doc) === set) holds.delete(doc);
    release();
  };
}

/** Whether a save holds the markup reads of `doc`. */
export function markupReadsHeld(doc) {
  doc = raw(doc);
  return !!(doc && holds.get(doc)?.size);
}

/** Resolves once no save holds the markup reads of `doc`. */
export async function markupReadsReleased(doc) {
  while (markupReadsHeld(doc)) {
    await Promise.all([...holds.get(raw(doc))]);
  }
}

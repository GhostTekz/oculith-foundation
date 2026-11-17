// Document lifecycle events, for code that keeps state per open document.
//
// A module that holds something for a document (a cache, a session, a
// reference to its PDF) listens here and lets it go when the document closes,
// instead of watching the list of open documents. Part of the plug-in
// interface (plugin/host.js).
//
// - documentClosed fires from the tab close path (ui/chrome/tabs.js
//   closeTab) once the document has left `state.documents`, after its
//   unsaved-changes question was answered. A close that was cancelled fires
//   nothing.
// - documentPathChanged fires when an open document now goes by another
//   file path: Save As, Rename, a working copy the editor renders from, a
//   copy that replaced the tab's file.
//
// A listener gets `(doc, info)` and must not throw into the editor: errors
// are caught and logged, and the other listeners still run.

const closedListeners = new Set();
const pathListeners = new Set();

function subscribe(set, fn) {
  if (typeof fn !== 'function') throw new TypeError('A document lifecycle listener must be a function.');
  set.add(fn);
  return () => { set.delete(fn); };
}

function emit(set, what, doc, info) {
  for (const fn of [...set]) {
    try { fn(doc, info); } catch (e) { console.warn(`[document-lifecycle] a ${what} listener failed:`, e); }
  }
}

/**
 * Run `fn(doc, { filePath, openDocuments })` after a document closed:
 * `filePath` is the path it last went by, `openDocuments` the documents still
 * open (another tab may show the same file). Returns an unsubscribe function.
 */
export function onDocumentClosed(fn) { return subscribe(closedListeners, fn); }

/**
 * Run `fn(doc, { oldPath, newPath })` when an open document's file path
 * changed. Returns an unsubscribe function.
 */
export function onDocumentPathChanged(fn) { return subscribe(pathListeners, fn); }

/** Editor side: `doc` closed and is no longer in `openDocuments`. */
export function documentClosed(doc, openDocuments = []) {
  if (!doc) return;
  emit(closedListeners, 'close', doc, { filePath: doc.filePath || null, openDocuments: [...openDocuments] });
}

/** Editor side: `doc` now goes by `newPath` (it went by `oldPath`). Nothing fires when the path is the same. */
export function documentPathChanged(doc, oldPath, newPath = doc?.filePath) {
  if (!doc || (oldPath || null) === (newPath || null)) return;
  emit(pathListeners, 'path change', doc, { oldPath: oldPath || null, newPath: newPath || null });
}

// Successful disk writes and disk-backed document loads, for optional
// consumers that cache source files. The editor knows no consumer methods.
const listeners = new Set();

export function onDocumentFileChanged(listener) {
  if (typeof listener !== 'function') throw new TypeError('A document file listener must be a function.');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyDocumentFileChanged(change) {
  if (!change || typeof change.path !== 'string' || !change.path
      || !['saved', 'loaded'].includes(change.reason)) return;
  const event = Object.freeze({ documentId: change.documentId ?? null, path: change.path, reason: change.reason });
  // Synchronous publication lets consumers advance their file generation
  // before another operation starts. A consumer cannot turn a written file
  // into a failed save by throwing from its notification handler.
  for (const listener of [...listeners]) {
    try {
      const returned = listener(event);
      if (returned && typeof returned.then === 'function') {
        Promise.resolve(returned).catch(error => console.warn('[document-file] listener failed:', error));
      }
    }
    catch (error) { console.warn('[document-file] listener failed:', error); }
  }
}

/** The physical writer must finish before observers see a saved file.
 * Serialization-only paths never call this helper. A rejected writer emits
 * no event; later UI or preview failures do not undo a successful disk write. */
export async function writeDocumentFile(change, writer) {
  const result = await writer();
  notifyDocumentFileChanged({ ...change, reason: 'saved' });
  return result;
}

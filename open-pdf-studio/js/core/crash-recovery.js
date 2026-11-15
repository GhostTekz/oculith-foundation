// Unsaved markups kept on disk for after a crash.
//
// While a drawing has unsaved changes, its markups are written to the
// crash-recovery file in the app data directory (crash-recovery-runtime.js,
// every few seconds when something changed). When the page comes back after
// its web process ended, or the app starts after it stopped without closing
// its drawings, the drawings in that file are opened again and the user is
// offered their markups. A clean close or a save removes the entry.
//
// Kept per drawing: the markups of every page whose markups were read (the
// app reads them page by page), with the page count to check against when
// they come back. Pages never read are left to the file. Page structure
// edits live in the drawing's working copy (page-manager.js), which is the
// path kept here; text edits, watermarks and other unsaved document changes
// are not recovered.
//
// Pure: documents and clocks are passed in (crash-recovery.test.mjs).

export const RECOVERY_VERSION = 1;

// Markups are plain JSON data (annotations/factory.js cloneAnnotation).
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));

const pageOf = (annotation) => Number(annotation?.page);
const isPage = (page) => Number.isInteger(page) && page > 0;

function readPages(doc) {
  const pages = new Set();
  const ready = doc?._annotationPagesReady;
  if (ready && typeof ready[Symbol.iterator] === 'function') {
    for (const page of ready) if (isPage(page)) pages.add(page);
  }
  for (const annotation of doc?.annotations || []) {
    const page = pageOf(annotation);
    if (isPage(page)) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** The recovery entry of one document, or null when it has nothing unsaved. */
export function recoveryEntry(doc, { clone = jsonCopy } = {}) {
  if (!doc?.modified || typeof doc.filePath !== 'string' || !doc.filePath) return null;
  const pages = readPages(doc);
  const kept = new Set(pages);
  const annotations = [];
  for (const annotation of doc.annotations || []) {
    if (!kept.has(pageOf(annotation))) continue;
    try { annotations.push(clone(annotation)); } catch { /* a markup that cannot be copied stays out */ }
  }
  return {
    filePath: doc.filePath,
    fileName: typeof doc.fileName === 'string' ? doc.fileName : '',
    saveTargetPath: typeof doc.saveTargetPath === 'string' ? doc.saveTargetPath : null,
    isUntitled: !!doc.isUntitled,
    numPages: Number(doc.pdfDoc?.numPages) || 0,
    currentPage: Number(doc.currentPage) || 1,
    pages,
    annotations,
  };
}

/** What goes into the crash-recovery file for these documents. */
export function recoverySnapshot(documents, now = Date.now()) {
  const entries = [];
  for (const doc of documents || []) {
    const entry = recoveryEntry(doc);
    if (entry) entries.push(entry);
  }
  return { version: RECOVERY_VERSION, savedAt: now, documents: entries };
}

/**
 * A cheap fingerprint of what the snapshot depends on: when it is unchanged,
 * the file on disk is still right. `historyLength(doc)` is the length of the
 * document's undo history.
 */
export function recoverySignature(documents, historyLength = () => 0) {
  return (documents || []).map((doc) => [
    doc?.filePath || '',
    doc?.modified ? 1 : 0,
    historyLength(doc),
    doc?.annotations?.length || 0,
    doc?._annotationPagesReady?.size || 0,
  ].join('|')).join('\n');
}

/** The snapshot in the crash-recovery file's text, checked; null when it holds nothing usable. */
export function parseRecovery(text) {
  if (typeof text !== 'string' || !text) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || data.version !== RECOVERY_VERSION || !Array.isArray(data.documents)) return null;
  const documents = data.documents.filter((entry) => entry
    && typeof entry.filePath === 'string' && entry.filePath
    && Array.isArray(entry.pages) && entry.pages.every(isPage)
    && Array.isArray(entry.annotations)
    && entry.annotations.every((annotation) => annotation && typeof annotation === 'object' && entry.pages.includes(pageOf(annotation))));
  if (documents.length === 0) return null;
  return { version: RECOVERY_VERSION, savedAt: Number(data.savedAt) || 0, documents };
}

/**
 * Put a recovered entry's markups back into its (re)opened document. Each
 * kept page is read from the file first (`ensurePage(page, doc)`), then its
 * markups become the recovered ones; the document is marked as changed.
 * @returns {Promise<{restored: number, skipped?: string}>}
 */
export async function applyRecoveredMarkups(doc, entry, { ensurePage }) {
  if (!doc || !entry) return { restored: 0, skipped: 'missing' };
  const numPages = Number(doc.pdfDoc?.numPages) || 0;
  if (entry.numPages && numPages && entry.numPages !== numPages) {
    return { restored: 0, skipped: 'page-count' };
  }
  const pages = new Set(entry.pages.filter((page) => !numPages || page <= numPages));
  for (const page of pages) await ensurePage(page, doc);
  const recovered = entry.annotations.filter((annotation) => pages.has(pageOf(annotation)));
  doc.annotations = [
    ...(doc.annotations || []).filter((annotation) => !pages.has(pageOf(annotation))),
    ...recovered,
  ];
  if (entry.saveTargetPath && entry.saveTargetPath !== doc.filePath) {
    doc.saveTargetPath = entry.saveTargetPath;
    doc._renderTemp = true;
  }
  if (entry.isUntitled && !entry.saveTargetPath) doc.isUntitled = true;
  doc.modified = true;
  doc.savedUndoStackLength = -1;
  return { restored: recovered.length };
}

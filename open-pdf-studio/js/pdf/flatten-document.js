// Document ▸ Flatten… / Unflatten for the open document (docs/reference/editor/markup-tools.md).
//
// Flatten: the document is serialized the way a save would write it, but
// not written (saver.savedPdfBytes, which also tells which annotation each
// markup became); flatten.js burns the chosen ones into the page content;
// the document reloads from those bytes without them, like the other page
// operations (undo restores the previous bytes and markups). Saving writes
// the result.
//
// Unflatten: flatten.js puts the recorded markups of the current bytes back
// as annotations; they are read into the model with the loader's own
// conversion (flatten-models.js), so they come back with their IDs, values
// and Markups List columns.
import { state, getActiveDocument } from '../core/state.js';
import { PDFDocument } from 'pdf-lib';
import { $RAW } from 'solid-js/store';
import { getPdfBytes, ensureAnnotationsForPage } from './loader.js';
import { getCacheKey, reloadFromBytes, pageDataOf, pageDataChange } from './page-manager.js';
import { withHistoryLock } from '../core/history-lock.js';
import { recordPageStructure } from '../core/undo-manager.js';
import { cloneAnnotation } from '../annotations/factory.js';
import { showLoading, hideLoading } from '../ui/chrome/dialogs.js';
import { getAnnotationDisplayName } from '../utils/helpers.js';
import i18next from '../i18n/config.js';
import { flattenPdfDocument, unflattenPdfDocument, flattenedPages, pdfjsAnnotationId } from './flatten.js';

// The undo snapshot reads the raw markups: through the store proxy every
// markup and nested value of the drawing would be wrapped for one copy.
const raw = (value) => (value && value[$RAW]) || value;

// Not markups on the page: a viewport is a /VP entry, not an annotation.
const NOT_FLATTENABLE = new Set(['scaleRegion']);

const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

/** The markups Flatten may take, with their Markups List type name. */
export function flattenCandidates(doc = getActiveDocument()) {
  const all = doc?.annotations || [];
  return all.filter(a => a && !NOT_FLATTENABLE.has(a.type))
    .map(a => ({ annotation: a, typeName: getAnnotationDisplayName(a, all) }));
}

/** Type names with counts, for the dialog's markup type list. */
export function flattenTypeSummary(doc = getActiveDocument()) {
  const counts = new Map();
  for (const { typeName } of flattenCandidates(doc)) counts.set(typeName, (counts.get(typeName) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

async function allPagesLoaded(doc) {
  const total = doc.pdfDoc?.numPages || 0;
  for (let p = 1; p <= total; p++) await ensureAnnotationsForPage(p, doc);
  if (!doc._annotationPagesReady) return true;
  for (let p = 1; p <= total; p++) if (!doc._annotationPagesReady.has(p)) return false;
  return true;
}

const pdfjsAssets = () => ({
  cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
  standardFontDataUrl: '/pdfjs/web/standard_fonts/', wasmUrl: '/pdfjs/web/wasm/',
});

/**
 * Flatten markups of the active document.
 * @param {object} options
 * @param {number[]|null} [options.pages] 1-based pages (all when null)
 * @param {Set<string>|null} [options.types] Markups List type names (all when null)
 * @param {Set<string>|null} [options.ids] only these markup ids (a selection)
 * @param {boolean} [options.allowUnflatten=true]
 * @returns {Promise<{ flattened: number, skipped: number, reason?: string }>}
 *   reason: 'none' (nothing matched), 'loading' (markups still loading),
 *   'failed' (the document could not be serialized)
 */
export function flattenDocument(options = {}) {
  return withHistoryLock(() => flattenDocumentNu(options), { flattened: 0, skipped: 0, reason: 'failed' });
}

async function flattenDocumentNu({ pages = null, types = null, ids = null, allowUnflatten = true } = {}) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return { flattened: 0, skipped: 0, reason: 'none' };
  if (!(await allPagesLoaded(doc))) return { flattened: 0, skipped: 0, reason: 'loading' };
  if (getActiveDocument() !== doc) return { flattened: 0, skipped: 0, reason: 'none' };

  const pageSet = pages ? new Set(pages) : null;
  const chosen = flattenCandidates(doc).filter(({ annotation: a, typeName }) =>
    (!pageSet || pageSet.has(a.page)) && (!types || types.has(typeName)) && (!ids || ids.has(a.id)))
    .map(c => c.annotation);
  if (!chosen.length) return { flattened: 0, skipped: 0, reason: 'none' };

  const oldBytes = await getPdfBytes(getCacheKey(doc));
  const oldAnnotations = raw(doc.annotations).map(a => cloneAnnotation(a));
  const oldRotations = { ...(doc.pageRotations || {}) };
  const oldPage = doc.currentPage;
  const dataBefore = pageDataOf(doc);
  const sourcePdf = doc.pdfDoc;

  const refs = new Map();
  const bytes = await import('./saver.js').then(m => m.savedPdfBytes(doc, refs));
  if (!bytes) return { flattened: 0, skipped: 0, reason: 'failed' };
  if (getActiveDocument() !== doc || doc.pdfDoc !== sourcePdf) return { flattened: 0, skipped: 0, reason: 'failed' };

  showLoading(i18next.t('flattenMarkups.working', { ns: 'common' }));
  try {
    const wanted = new Set(chosen.map(a => refs.get(a)).filter(Boolean).map(refKey));
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    const result = flattenPdfDocument(lib, {
      pages: [...new Set(chosen.map(a => a.page))],
      select: (ref) => wanted.has(refKey(ref)),
      allowUnflatten,
    });
    if (!result.removed.length) return { flattened: 0, skipped: result.skipped.length, reason: 'none' };
    const gone = new Set(result.removed.map(r => refKey(r.ref)));
    const flattenedModels = doc.annotations.filter(a => refs.has(a) && gone.has(refKey(refs.get(a))));
    const remaining = doc.annotations.filter(a => !flattenedModels.includes(a)).map(a => cloneAnnotation(a));
    const newBytes = new Uint8Array(await lib.save());
    // The serializer applied the in-app page rotations to /Rotate.
    const newRotations = {};
    // The tab may have closed during the work above.
    if (!state.documents.includes(doc)) return { flattened: 0, skipped: 0, reason: 'failed' };
    await reloadFromBytes(newBytes, remaining, newRotations, oldPage, null, doc);
    // Fixed vector snippets were drawn into these bytes as well.
    const { markeerGebakken } = await import('./saver/vector-snippet.js');
    markeerGebakken(doc.annotations, doc.filePath);
    if (oldBytes) {
      recordPageStructure(oldBytes, oldAnnotations, oldRotations, oldPage,
        newBytes, remaining, newRotations, doc.currentPage, { doc, ...pageDataChange(dataBefore, doc) });
    }
    refreshLists();
    return { flattened: flattenedModels.length, skipped: result.skipped.length };
  } finally {
    hideLoading();
  }
}

/**
 * Unflatten every recoverable flattened markup of the active document.
 * @param {{ pages?: number[]|null }} [options]
 * @returns {Promise<{ restored: number, reason?: string }>}
 */
export function unflattenDocument(options = {}) {
  return withHistoryLock(() => unflattenDocumentNu(options), { restored: 0, reason: 'none' });
}

async function unflattenDocumentNu({ pages = null } = {}) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return { restored: 0, reason: 'none' };
  if (!(await allPagesLoaded(doc))) return { restored: 0, reason: 'loading' };
  const bytes = await getPdfBytes(getCacheKey(doc));
  if (!bytes || getActiveDocument() !== doc) return { restored: 0, reason: 'none' };

  showLoading(i18next.t('flattenMarkups.working', { ns: 'common' }));
  try {
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    if (!flattenedPages(lib).length) return { restored: 0, reason: 'none' };
    const { restored } = unflattenPdfDocument(lib, { pages });
    if (!restored.length) return { restored: 0, reason: 'none' };
    const newBytes = new Uint8Array(await lib.save());
    const only = new Map();
    for (const r of restored) {
      if (!only.has(r.page)) only.set(r.page, new Set());
      only.get(r.page).add(pdfjsAnnotationId(r.ref));
    }
    const { modelsFromPdf } = await import('./flatten-models.js');
    const models = await modelsFromPdf(newBytes, { only, existing: doc.annotations, pdfjsOptions: pdfjsAssets() });
    if (getActiveDocument() !== doc) return { restored: 0, reason: 'none' };
    const oldAnnotations = raw(doc.annotations).map(a => cloneAnnotation(a));
    const rotations = { ...(doc.pageRotations || {}) };
    const page = doc.currentPage;
    const dataBefore = pageDataOf(doc);
    const newAnnotations = [...oldAnnotations.map(a => cloneAnnotation(a)), ...models];
    await reloadFromBytes(newBytes, newAnnotations, rotations, page, null, doc);
    recordPageStructure(bytes, oldAnnotations, rotations, page, newBytes, newAnnotations, rotations, doc.currentPage,
      { doc, ...pageDataChange(dataBefore, doc) });
    refreshLists();
    return { restored: models.length };
  } finally {
    hideLoading();
  }
}

function refreshLists() {
  import('../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList?.()).catch(() => {});
  import('../annotations/rendering.js').then(m => {
    const doc = getActiveDocument();
    if (doc?.viewMode === 'continuous') m.redrawContinuous?.(); else m.redrawAnnotations?.();
  }).catch(() => {});
}

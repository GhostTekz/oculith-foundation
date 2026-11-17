// Page labels in the open document (Document > Page Labels): read them,
// write them into the PDF bytes as /PageLabels (one undoable step, like the
// other page operations), and read the text of a page region on every page.
// The Navigation bar and the Markups List read labels per PDF.js document,
// so the reload below refreshes both.

import { PDFDocument } from 'pdf-lib';
import { state, getActiveDocument, getPageRotation } from '../core/state.js';
import { getPdfBytes, ensureAnnotationsForPage } from './loader.js';
import { getCacheKey, reloadFromBytes, pageDataOf, pageDataChange } from './page-manager.js';
import { withHistoryLock } from '../core/history-lock.js';
import { recordPageStructure } from '../core/undo-manager.js';
import { writePageLabels, cleanPageLabel } from './page-labels.js';
import { extractRegionTexts, regionFractions } from './region-text.js';

/** The labels of the active document, one string per page ('' = none). */
export async function readDocumentLabels(doc = getActiveDocument()) {
  const count = doc?.pdfDoc?.numPages || 0;
  let labels = null;
  try { labels = await doc.pdfDoc.getPageLabels(); } catch { labels = null; }
  return Array.from({ length: count }, (_, i) => cleanPageLabel(labels?.[i]));
}

/** Load the markups of every page, so a reload from new bytes keeps them all. */
export async function loadAllAnnotations(doc = getActiveDocument()) {
  const count = doc?.pdfDoc?.numPages || 0;
  for (let p = 1; p <= count; p++) await ensureAnnotationsForPage(p, doc);
}

/**
 * Write `labels` into the active document. Returns false when the document
 * changed meanwhile or has no bytes to edit, or another page operation runs.
 */
export function applyDocumentLabels(labels) {
  return withHistoryLock(() => applyDocumentLabelsNu(labels), false);
}

async function applyDocumentLabelsNu(labels) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return false;
  await loadAllAnnotations(doc);
  if (getActiveDocument() !== doc) return false;
  const currentBytes = await getPdfBytes(getCacheKey(doc));
  if (!currentBytes) return false;
  const pdf = await PDFDocument.load(currentBytes, { ignoreEncryption: true });
  writePageLabels(pdf, labels);
  const newBytes = new Uint8Array(await pdf.save());
  if (getActiveDocument() !== doc || !state.documents.includes(doc)) return false;
  const annotations = doc.annotations.map(a => ({ ...a }));
  const rotations = { ...doc.pageRotations };
  const page = doc.currentPage;
  const dataBefore = pageDataOf(doc);
  const identity = {};
  for (let p = 1; p <= pdf.getPageCount(); p++) identity[p] = p;
  await reloadFromBytes(newBytes, doc.annotations, doc.pageRotations, page, { pageMapping: identity }, doc);
  recordPageStructure(currentBytes, annotations, rotations, page, newBytes, doc.annotations, doc.pageRotations, page,
    { doc, ...pageDataChange(dataBefore, doc) });
  return true;
}

/**
 * Text inside the region on every page of the active document.
 * @param {{ rect, pageWidth, pageHeight }} region  from pickPageRegion()
 * @returns {Promise<string[]|null>}
 */
export async function regionTextsOfDocument(region, onProgress) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc || !region) return null;
  const fractions = regionFractions(region.rect, region.pageWidth, region.pageHeight);
  if (!fractions) return null;
  const pdfDoc = doc.pdfDoc;
  return extractRegionTexts(pdfDoc, fractions, {
    rotationOf: (p) => getPageRotation(p) || 0,
    isCurrent: () => getActiveDocument() === doc && doc.pdfDoc === pdfDoc,
    onProgress,
  });
}

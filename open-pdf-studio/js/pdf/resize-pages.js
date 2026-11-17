import { state, getActiveDocument } from "../core/state.js";
import { getPdfBytes } from "./loader.js";
import { getCacheKey, reloadFromBytes, pageDataOf, pageDataChange } from "./page-manager.js";
import { withHistoryLock } from "../core/history-lock.js";
import { parsePageRange } from "./exporter.js";
import { recordPageStructure } from "../core/undo-manager.js";
import { showLoading, hideLoading } from "../ui/chrome/dialogs.js";
import { cloneAnnotation } from "../annotations/factory.js";
import { applyMoveGeneric } from "../annotations/transforms.js";
import { shiftAnnotation } from "./shift-page-geometry.js";
import { PDFDocument } from "pdf-lib";
import { resizePdfLibPages } from "./resize-pages-core.js";

const MM_TO_POINTS = 72 / 25.4;

/**
 * Translate an annotation in place by (dx, dy) in visual PDF points, so
 * that every part of it moves with the page content it belongs to.
 * Goes through the app's single move primitive (applyMoveGeneric), which
 * knows every position-bearing field — leader lines, angle vertices, spline
 * control points, hole contours, text-markup quads, textbox leaders — so no
 * annotation type is left behind or torn apart.
 */
export function translateAnnotation(ann, dx, dy) {
  shiftAnnotation(ann, dx, dy, applyMoveGeneric);
}

/**
 * Resize the media/document size of pages WITHOUT scaling their content.
 * The MediaBox and CropBox are both set to the requested size and the
 * existing content is centred inside the new box; annotations shift with it.
 *
 * @param {'current' | 'all' | 'range'} applyTo - Which pages to resize
 * @param {string} rangeStr - Page range string (only used when applyTo is 'range')
 * @param {number} widthMm - Target visual width in millimetres
 * @param {number} heightMm - Target visual height in millimetres
 * @returns {Promise<{resized: number}>}
 */
export function resizePages(applyTo, rangeStr, widthMm, heightMm) {
  return withHistoryLock(() => resizePagesNu(applyTo, rangeStr, widthMm, heightMm), { resized: 0 });
}

async function resizePagesNu(applyTo, rangeStr, widthMm, heightMm) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return { resized: 0 };
  if (!(widthMm > 0) || !(heightMm > 0)) return { resized: 0 };

  const cacheKey = getCacheKey(doc);
  const currentBytes = await getPdfBytes(cacheKey);
  if (!currentBytes) return { resized: 0 };

  const targetWpt = widthMm * MM_TO_POINTS;
  const targetHpt = heightMm * MM_TO_POINTS;

  const oldAnnotations = doc.annotations.map((a) => cloneAnnotation(a));
  const oldRotations = { ...doc.pageRotations };
  const oldPage = doc.currentPage;
  const dataBefore = pageDataOf(doc);

  const totalPages = doc.pdfDoc.numPages;
  let pageNumbers;
  if (applyTo === "current") {
    pageNumbers = [doc.currentPage];
  } else if (applyTo === "all") {
    pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pageNumbers = parsePageRange(rangeStr, totalPages);
  }
  if (pageNumbers.length === 0) return { resized: 0 };
  const targetPages = new Set(pageNumbers);

  showLoading("Resizing pages...");
  try {
    const pdfDoc = await PDFDocument.load(currentBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();

    // Work on a copy of the annotations so we can shift the ones on resized pages.
    const newAnnotations = doc.annotations.map((a) => cloneAnnotation(a));
    // Per-page visual offset applied to content, keyed by 1-based page number.
    const pageOffsets = resizePdfLibPages(pages, targetPages, targetWpt, targetHpt, oldRotations);

    if (pageOffsets.size === 0) return { resized: 0 };

    for (const ann of newAnnotations) {
      const off = pageOffsets.get(ann.page);
      if (off) translateAnnotation(ann, off.dx, off.dy);
    }

    const newBytes = new Uint8Array(await pdfDoc.save());
    const newRotations = { ...oldRotations };
    const targetPage = doc.currentPage;

    // The tab may have closed during the work above.
    if (!state.documents.includes(doc)) return { resized: 0 };
    await reloadFromBytes(newBytes, newAnnotations, newRotations, targetPage, null, doc);
    recordPageStructure(
      currentBytes,
      oldAnnotations,
      oldRotations,
      oldPage,
      newBytes,
      newAnnotations,
      newRotations,
      targetPage,
      { doc, ...pageDataChange(dataBefore, doc) }
    );

    return { resized: pageOffsets.size };
  } finally {
    hideLoading();
  }
}

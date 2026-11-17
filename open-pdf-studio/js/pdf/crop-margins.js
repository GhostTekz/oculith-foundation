import { state, getActiveDocument } from "../core/state.js";
import { getPdfBytes } from "./loader.js";
import { getCacheKey, reloadFromBytes, pageDataOf, pageDataChange } from "./page-manager.js";
import { withHistoryLock } from "../core/history-lock.js";
import { renderPageOffscreen, parsePageRange } from "./exporter.js";
import { recordPageStructure } from "../core/undo-manager.js";
import { showLoading, hideLoading } from "../ui/chrome/dialogs.js";
import { PDFDocument } from "pdf-lib";
import { MM_TO_POINTS, contentRenderScale, contentBoundsFromPixels, applyCropBoxes } from "./crop-margins-core.js";

/**
 * Detect the content bounds of a rendered page by edge-inward pixel scanning.
 * @param {number} pageNum - 1-based page number
 * @param {number} threshold - Whiteness threshold (0-255), pixels brighter are "white"
 * @returns {Promise<{minX: number, minY: number, maxX: number, maxY: number, width: number, height: number, scale: number} | null>}
 */
async function detectContentBounds(doc, pageNum, threshold) {
  // Determine render scale — reduce for very large pages
  const page = await doc.pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const scale = contentRenderScale(vp.width, vp.height);

  const canvas = await renderPageOffscreen(pageNum, scale, { doc });
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const bounds = contentBoundsFromPixels(ctx.getImageData(0, 0, width, height).data, width, height, threshold);
  return bounds ? { ...bounds, scale } : null;
}

/**
 * Crop margins from pages in the current document.
 * @param {'current' | 'all' | 'range'} applyTo - Which pages to crop
 * @param {string} rangeStr - Page range string (only used when applyTo is 'range')
 * @param {number} paddingMm - Padding around content in mm
 * @param {number} threshold - Whiteness threshold (200-255)
 * @returns {Promise<{cropped: number, skipped: number}>}
 */
export function cropMargins(applyTo, rangeStr, paddingMm, threshold) {
  return withHistoryLock(() => cropMarginsNu(applyTo, rangeStr, paddingMm, threshold), { cropped: 0, skipped: 0 });
}

async function cropMarginsNu(applyTo, rangeStr, paddingMm, threshold) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return { cropped: 0, skipped: 0 };

  const cacheKey = getCacheKey(doc);
  const currentBytes = await getPdfBytes(cacheKey);
  if (!currentBytes) return { cropped: 0, skipped: 0 };

  const oldAnnotations = doc.annotations.map((a) => ({ ...a }));
  const oldRotations = { ...doc.pageRotations };
  const oldPage = doc.currentPage;
  const dataBefore = pageDataOf(doc);

  // Determine which pages to process
  const totalPages = doc.pdfDoc.numPages;
  let pageNumbers;
  if (applyTo === "current") {
    pageNumbers = [doc.currentPage];
  } else if (applyTo === "all") {
    pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pageNumbers = parsePageRange(rangeStr, totalPages);
  }

  if (pageNumbers.length === 0) return { cropped: 0, skipped: 0 };

  const paddingPt = paddingMm * MM_TO_POINTS;

  showLoading("Detecting content bounds...");
  try {
    // First pass: detect bounds for all pages
    const boundsMap = new Map();
    // The analysis renders the pages as shown, which the exporter allows
    // only while their tab stays active: after a tab switch or close it
    // stops, and the crop with it, before anything changed.
    try {
      for (const pageNum of pageNumbers) {
        showLoading(`Analyzing page ${pageNum} of ${totalPages}...`);
        const bounds = await detectContentBounds(doc, pageNum, threshold);
        if (bounds) {
          boundsMap.set(pageNum, bounds);
        }
      }
    } catch (err) {
      if (getActiveDocument() !== doc || !state.documents.includes(doc)) return { cropped: 0, skipped: 0 };
      throw err;
    }

    if (boundsMap.size === 0) {
      return { cropped: 0, skipped: pageNumbers.length };
    }

    // Second pass: apply CropBox via pdf-lib
    showLoading("Applying crop...");
    const pdfDoc = await PDFDocument.load(currentBytes, {
      ignoreEncryption: true,
    });
    const pages = pdfDoc.getPages();

    applyCropBoxes(pages, boundsMap, paddingPt);

    const newBytes = new Uint8Array(await pdfDoc.save());

    // Annotations and rotations stay the same — CropBox doesn't change page structure
    const newAnnotations = oldAnnotations;
    const newRotations = { ...oldRotations };
    const targetPage = doc.currentPage;

    // The tab may have closed during the work above.
    if (!state.documents.includes(doc)) return { cropped: 0, skipped: 0 };
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

    return {
      cropped: boundsMap.size,
      skipped: pageNumbers.length - boundsMap.size,
    };
  } finally {
    hideLoading();
  }
}

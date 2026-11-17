// Title block templates in the app: the text of the page on screen, to mark
// the boxes on, and the text of every registered sheet, to apply them to.
// Reads selectable PDF text only (no OCR); the PDFs are never changed.

import { getActiveDocument, getPageRotation } from '../core/state.js';
import { modelViewport, textRuns } from '../pdf/region-text.js';
import { readRegisteredPages } from './sheet-title-suggest-app.js';

/** A PDF.js page as the template reads it: `{ width, height, runs }` in model space, /Rotate applied. */
export async function templatePage(page) {
  const viewport = modelViewport(page);
  let items = [];
  try { items = (await page.getTextContent()).items; } catch { items = []; }
  return { width: viewport.width, height: viewport.height, runs: textRuns(items, viewport) };
}

/**
 * The page on screen, to mark a template on: `{ doc, page, width, height, runs }`.
 * A page turned in the view is refused: the template is kept in the PDF's own orientation.
 */
export async function currentTemplatePage() {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) throw new Error('Open a sheet of the set first.');
  const pageNum = doc.currentPage || 1;
  if ((getPageRotation(pageNum) || 0) % 360 !== 0) {
    throw new Error('This page is turned in the view. Reset its rotation before marking a template.');
  }
  const read = await templatePage(await doc.pdfDoc.getPage(pageNum));
  return { doc, page: pageNum, ...read };
}

/** Every given registered sheet's page (Map of sheet id to page or `{ error }`), PDFs checked against their fingerprints. */
export function readTemplatePages(sheets) {
  return readRegisteredPages(sheets, templatePage);
}

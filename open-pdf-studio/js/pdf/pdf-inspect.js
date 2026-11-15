// Read a PDF that is not open in a tab: PDF.js opens the bytes, `read`
// receives the PDF.js document, and the document is destroyed afterwards
// (also when `read` throws). For looking at incoming PDFs (title blocks,
// text, line work) before deciding what to do with them.

import * as pdfjsLib from 'pdfjs-dist';
import { readerFonts } from './page-readers.js';

/**
 * `read(document)` on a PDF.js document of `bytes` (a copy is handed to
 * PDF.js). `fontFaces` false: a document that is never drawn, whose fonts
 * are not loaded into the window.
 */
export async function withPdfDocument(bytes, read, { fontFaces = true } = {}) {
  if (!bytes?.length) throw new Error('The PDF is empty or could not be read.');
  const task = pdfjsLib.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/web/standard_fonts/',
    wasmUrl: '/pdfjs/web/wasm/', isEvalSupported: false, verbosity: 0,
    ...readerFonts(fontFaces),
  });
  try {
    return await read(await task.promise);
  } finally {
    await task.destroy();
  }
}

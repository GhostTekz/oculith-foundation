// A page's text read by a PDFium worker process instead of PDF.js, for
// whole-set reads (Smart Review, set scans). The worker builds the items
// with PDF.js's own grouping rules (pdfium-worker/src/text.rs), so a scan
// reads the same items, while the window's process neither parses the page
// nor holds a copy of the file. The native process keeps what it read for
// the next scan of the same file.
//
// Only a drawing that PDF.js itself reads by range from its file on disk
// qualifies: then the file is exactly the open document. A drawing opened
// from bytes (a small file, a reload after page edits) reads through PDF.js.

import { invoke as platformInvoke, isTauri } from '../core/platform.js';

// PDF.js's text normalization (getTextContent without disableNormalization).
const NORMALIZE = /([ µ;ຳ -  Ωﬀ-ﬄﬆﬠ-זּטּ-לּמּנּסּףּפּצּ-ﮡﮤ-ﮩﮮ-ﮱﯓ-ﯜﯞ-ﯧﯪ-ﯸﯼﯽﰀ-ﱝﱤ-ﳱﳵ-ﴽﶈﷴﷺﷻﹱﹷﹹﹻﹽ]+)|(ﬅ+)/gu;
export const normalizeText = (str) => String(str).replaceAll(NORMALIZE, (_, p1, p2) => (p1 ? p1.normalize('NFKC') : 'ſt'.repeat(p2.length)));

/** Diagnostics only: `globalThis.__ocudrawNativeText = false` reads every page through PDF.js. */
const enabled = () => globalThis.__ocudrawNativeText !== false;

/**
 * Decode the worker's JSON into PDF.js-shaped `{ items }`, or null for a
 * page whose text the worker could not give exactly as PDF.js reads it
 * (text drawn twice, which PDFium reads once; text at an angle): that page
 * is read through PDF.js.
 */
export function decodeNativeText(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed?.items)) throw new Error('page text without items');
  if (parsed.exact !== true) return null;
  return {
    items: parsed.items.map((it) => ({
      str: normalizeText(it.str), transform: it.transform, width: it.width, height: it.height,
      dir: 'ltr', hasEOL: false,
    })),
  };
}

/**
 * A reader of `doc`'s pages through the workers, or null when the document
 * does not qualify. The reader returns `{ items }` for page `n` (1-based),
 * or null: the caller then reads that page through PDF.js. After the first
 * failure (an older worker, a file that changed) it returns null for good.
 */
export function nativePageTextReader(doc, { invoke = platformInvoke, desktop = isTauri() } = {}) {
  const source = doc?._rangeSource;
  const pdfDoc = doc?.pdfDoc;
  if (!desktop || !enabled() || !source || !pdfDoc || !doc.filePath || source.path !== doc.filePath) return null;
  let failed = false;
  return async (n) => {
    if (failed || !enabled() || doc.pdfDoc !== pdfDoc || doc._rangeSource !== source) return null;
    try {
      return decodeNativeText(await invoke('pdf_page_text_native', { path: source.path, pageIndex: n - 1, expectLen: source.length }));
    } catch (error) {
      const message = String(error?.message || error);
      // The workers cannot serve this drawing at all: stop asking. Any other
      // error (one page PDFium cannot read) falls back for that page alone.
      if (!/^page text: (?:page \d+:|page text:)/.test(message)) failed = true;
      console.warn(`[page-text] page ${n} through PDF.js: ${message}`);
      return null;
    }
  };
}

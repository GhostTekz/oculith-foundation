// Batch operations (docs/reference/editor/sets-and-batch.md): the single-document operations of
// the Document and File menus, applied to a PDF on disk. Each op takes the
// file's bytes and returns new bytes (or `bytes: null` for "nothing to
// change"); batch-ops-job.js runs them through the runner and writes the
// results. Every op calls the same core the single-document command uses:
//
//   flatten          pdf/flatten.js            flattenPdfDocument
//   rotate           pdf/rotate-pages-core.js  rotatePdfLibPage (the saver's /Rotate step)
//   headersFooters   pdf/saver/watermarks.js   saveWatermarksToPages
//   applyStamp       batch/stamp-place.js      the saver's dynamic stamp writer
//   cropPageSetup    pdf/crop-margins-core.js, pdf/resize-pages-core.js
//   reduceFileSize   pdf/compress-core.js      buildRasterPdf
//   ocr              pdf/saver/ocr-text-layer.js writeOcrResults (desktop: Tauri OCR)
//   print            flatten + pdf/print-vector.js, then the print spooler (desktop)
//   split            pdf/extract-pages-core.js extractPdfLibPages (Document ▸ Extract Pages)
//   repair           pdf-lib's tolerant read + a fresh write (no single-document command)
//
// No UI imports: the dialog passes PDF.js, the clock, the author and the
// desktop hooks, so node tests run these on real bytes.

import { PDFDocument } from 'pdf-lib';
import { flattenPdfDocument } from '../pdf/flatten.js';
import { rotatePdfLibPage } from '../pdf/rotate-pages-core.js';
import { saveWatermarksToPages } from '../pdf/saver/watermarks.js';
import { resizePdfLibPages, pageSizeMm, PAGE_MM_TO_POINTS } from '../pdf/resize-pages-core.js';
import { contentRenderScale, contentBoundsFromPixels, applyCropBoxes, MM_TO_POINTS } from '../pdf/crop-margins-core.js';
import { buildRasterPdf, COMPRESS_PRESETS, COMPRESS_SAVE_OPTIONS } from '../pdf/compress-core.js';
import { writeOcrResults } from '../pdf/saver/ocr-text-layer.js';
import { bouwVectorPrintPdf, verwijderOnbereikbaar } from '../pdf/print-vector.js';
import { parsePageRange } from '../pdf/exporter.js';
import { extractPdfLibPages } from '../pdf/extract-pages-core.js';
import { placeBatchStamps } from './stamp-place.js';
import { throwIfCancelled } from './runner.js';

/** Batch menu order (the external editor), with the op ids. */
export const BATCH_OP_IDS = Object.freeze([
  'cropPageSetup', 'rotate', 'split', 'headersFooters', 'applyStamp', 'ocr', 'reduceFileSize', 'repair', 'flatten', 'print',
]);

/** Ops that need the desktop app (Tauri OCR engine, printer spooler). */
export const DESKTOP_ONLY_OPS = Object.freeze(new Set(['ocr', 'print']));

/** Ops that write no file. */
export const NO_OUTPUT_OPS = Object.freeze(new Set(['print']));

/** Ops that write several files per source (never in place). */
export const MULTI_OUTPUT_OPS = Object.freeze(new Set(['split']));

/** The default file name suffix of each op's output. */
export const DEFAULT_SUFFIX = Object.freeze({
  flatten: '_flattened', ocr: '_ocr', applyStamp: '_stamped', headersFooters: '_headers',
  rotate: '_rotated', cropPageSetup: '_cropped', reduceFileSize: '_reduced', print: '',
  split: '_part', repair: '_repaired',
});

/** A typed message the dialog translates (`batchOps.detail.<code>`). */
export class BatchOpError extends Error {
  constructor(code, values = {}) {
    super(`${code}${Object.keys(values).length ? ` ${JSON.stringify(values)}` : ''}`);
    this.name = 'BatchOpError';
    this.code = code;
    this.values = values;
  }
}

/**
 * 1-based page numbers of a file for a page choice:
 * { mode: 'all' | 'first' | 'last' | 'range', range?: '1-3, 5' }.
 * A range that selects nothing in this file is an error for that file.
 */
export function resolvePages(choice, total) {
  const mode = choice?.mode || 'all';
  if (mode === 'first') return total >= 1 ? [1] : [];
  if (mode === 'last') return total >= 1 ? [total] : [];
  if (mode === 'range') {
    const pages = parsePageRange(String(choice?.range ?? ''), total).sort((a, b) => a - b);
    if (!pages.length) throw new BatchOpError('noPagesInRange', { range: String(choice?.range ?? ''), total });
    return pages;
  }
  return Array.from({ length: total }, (_, i) => i + 1);
}

/** The output name for a source name and suffix: `A-101.pdf` + `_flat` → `A-101_flat.pdf`. */
export function suffixedName(name, suffix) {
  const dot = name.toLowerCase().lastIndexOf('.pdf');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}${suffix || ''}.pdf`;
}

/** JPEG bytes of a canvas: a browser canvas (toBlob), OffscreenCanvas, or @napi-rs/canvas (node). */
export async function canvasJpeg(canvas, quality) {
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Failed to convert canvas to blob');
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof canvas.convertToBlob === 'function') {
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  }
  if (typeof canvas.encode === 'function') return new Uint8Array(await canvas.encode('jpeg', Math.round(quality * 100)));
  throw new Error('This canvas cannot encode JPEG.');
}

const unreadable = (error) => new BatchOpError('unreadable', { reason: String(error?.message || error).slice(0, 120) });

/** pdf-lib's load of a source file; a file it cannot parse is "not a readable PDF". */
async function loadPdf(bytes, options) {
  try {
    const lib = await PDFDocument.load(bytes, options);
    if (!(lib.getPageCount() > 0)) throw new Error('no pages');
    return lib;
  } catch (error) {
    throw unreadable(error);
  }
}

/** Open a file with PDF.js (its own copy of the bytes); `close()` destroys it. */
async function openPdfJs(ctx, bytes) {
  if (!ctx.pdfjs) throw new Error('This operation needs PDF.js.');
  const task = ctx.pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, ...(ctx.pdfjsOptions || {}) });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    throw unreadable(error);
  }
  return { doc, close: () => task.destroy() };
}

/** Render a page as displayed, with the annotation appearances drawn. */
async function renderPage(ctx, pdf, pageNum, scale) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const { canvas, context } = pdf.canvasFactory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  await page.render({ canvasContext: context, viewport, canvas, annotationMode: ctx.pdfjs.AnnotationMode.ENABLE }).promise;
  return { canvas, context, page };
}

const releaseCanvas = (pdf, rendered) => {
  try { pdf.canvasFactory.destroy({ canvas: rendered.canvas, context: rendered.context }); } catch { /* already gone */ }
};

const saveBytes = async (lib, options) => new Uint8Array(await lib.save(options));

// --- the ops -----------------------------------------------------------------

/** Flatten (docs/reference/editor/markup-tools.md): every markup on the chosen pages. */
async function flatten(file, ctx) {
  const lib = await loadPdf(file.bytes, { updateMetadata: false });
  const pages = resolvePages(ctx.options.pages, lib.getPageCount());
  const result = flattenPdfDocument(lib, { pages, allowUnflatten: ctx.options.allowUnflatten !== false });
  throwIfCancelled(ctx.signal);
  if (!result.removed.length) return { bytes: null, detail: { code: 'noMarkups' } };
  return { bytes: await saveBytes(lib), detail: { code: 'flattened', count: result.flattened.length, skipped: result.skipped.length } };
}

/** Rotate pages by a quarter turn multiple (Document ▸ Rotate Pages). */
async function rotate(file, ctx) {
  const lib = await loadPdf(file.bytes);
  const delta = Number(ctx.options.delta) || 90;
  if (delta % 90) throw new BatchOpError('badAngle');
  const pages = resolvePages(ctx.options.pages, lib.getPageCount());
  for (const pageNum of pages) rotatePdfLibPage(lib.getPage(pageNum - 1), delta);
  return { bytes: await saveBytes(lib), detail: { code: 'rotated', count: pages.length } };
}

/** The header/footer object the Header & Footer dialog makes, from batch options. */
export function headerFooterSpec(options = {}) {
  const pages = options.pages || { mode: 'all' };
  return {
    type: 'headerFooter',
    headerLeft: options.headerLeft || '', headerCenter: options.headerCenter || '', headerRight: options.headerRight || '',
    footerLeft: options.footerLeft || '', footerCenter: options.footerCenter || '', footerRight: options.footerRight || '',
    fontFamily: options.fontFamily || 'Helvetica',
    fontSize: parseInt(options.fontSize) || 10,
    color: options.color || '#000000',
    marginTop: parseInt(options.marginTop) || 30,
    marginBottom: parseInt(options.marginBottom) || 30,
    marginLeft: parseInt(options.marginLeft) || 40,
    marginRight: parseInt(options.marginRight) || 40,
    pageRange: pages.mode === 'first' ? 'first' : pages.mode === 'range' ? 'custom' : 'all',
    customPages: pages.mode === 'range' ? String(pages.range || '') : '',
    enabled: true,
  };
}

/** Headers & Footers ({page}, {pages}, {date}, {time}, {filename}). */
async function headersFooters(file, ctx) {
  const spec = headerFooterSpec(ctx.options);
  const slots = ['headerLeft', 'headerCenter', 'headerRight', 'footerLeft', 'footerCenter', 'footerRight'];
  if (!slots.some((k) => spec[k].trim())) throw new BatchOpError('noHeaderText');
  const lib = await loadPdf(file.bytes);
  const pages = lib.getPages();
  if (spec.pageRange === 'custom') resolvePages(ctx.options.pages, pages.length); // fail early on an empty range
  await saveWatermarksToPages(lib, pages, { watermarks: [spec], fileName: file.name }, { now: ctx.now });
  return { bytes: await saveBytes(lib), detail: { code: 'headersAdded', count: pages.length } };
}

/** Apply Stamp (docs/reference/editor/markup-tools.md): a stamp template on the chosen pages, fields per file and page. */
async function applyStamp(file, ctx) {
  const template = ctx.options.template;
  if (!template) throw new BatchOpError('noStamp');
  const lib = await loadPdf(file.bytes);
  const pages = resolvePages(ctx.options.pages, lib.getPageCount());
  let pageLabels = [];
  if (ctx.pdfjs) {
    const opened = await openPdfJs(ctx, file.bytes);
    try { pageLabels = (await opened.doc.getPageLabels()) || []; } catch { /* no labels: page numbers */ } finally { await opened.close(); }
    throwIfCancelled(ctx.signal);
  }
  const placed = await placeBatchStamps(lib, template, {
    pages, position: ctx.options.position, margin: Number(ctx.options.margin ?? 36),
    now: ctx.now, user: ctx.user || 'User', fileName: file.name, pageLabels,
  });
  return { bytes: await saveBytes(lib), detail: { code: 'stamped', count: placed.length } };
}

/** Crop & Page Setup: crop to the content (Document ▸ Crop Pages) or set the page size (Page Setup). */
async function cropPageSetup(file, ctx) {
  const options = ctx.options;
  if (options.mode === 'size') {
    const lib = await loadPdf(file.bytes, { ignoreEncryption: true });
    const pages = resolvePages(options.pages, lib.getPageCount());
    const { w, h } = pageSizeMm(options.preset || 'a4', options.orientation || 'portrait', [options.widthMm, options.heightMm]);
    if (!(w > 0) || !(h > 0)) throw new BatchOpError('badSize');
    const resized = resizePdfLibPages(lib.getPages(), pages, w * PAGE_MM_TO_POINTS, h * PAGE_MM_TO_POINTS);
    return { bytes: await saveBytes(lib), detail: { code: 'resized', count: resized.size } };
  }
  const threshold = Number(options.threshold) || 250;
  const paddingPt = Math.max(0, Math.min(50, Number(options.paddingMm) || 0)) * MM_TO_POINTS;
  const opened = await openPdfJs(ctx, file.bytes);
  const boundsMap = new Map();
  let pages;
  try {
    pages = resolvePages(options.pages, opened.doc.numPages);
    for (const pageNum of pages) {
      throwIfCancelled(ctx.signal);
      const page = await opened.doc.getPage(pageNum);
      const vp = page.getViewport({ scale: 1 });
      const rendered = await renderPage(ctx, opened.doc, pageNum, contentRenderScale(vp.width, vp.height));
      const { width, height } = rendered.canvas;
      const bounds = contentBoundsFromPixels(rendered.context.getImageData(0, 0, width, height).data, width, height, threshold);
      releaseCanvas(opened.doc, rendered);
      if (bounds) boundsMap.set(pageNum, bounds);
    }
  } finally {
    await opened.close();
  }
  throwIfCancelled(ctx.signal);
  if (!boundsMap.size) return { bytes: null, detail: { code: 'nothingToCrop' } };
  const lib = await loadPdf(file.bytes, { ignoreEncryption: true });
  applyCropBoxes(lib.getPages(), boundsMap, paddingPt);
  return { bytes: await saveBytes(lib), detail: { code: 'cropped', count: boundsMap.size, skipped: pages.length - boundsMap.size } };
}

/** Reduce File Size: pages as JPEG at the preset's DPI (text becomes an image, as in the single-document op). */
async function reduceFileSize(file, ctx) {
  const preset = COMPRESS_PRESETS[ctx.options.level] || COMPRESS_PRESETS.medium;
  const opened = await openPdfJs(ctx, file.bytes);
  let newPdf;
  try {
    const pdf = opened.doc;
    newPdf = await buildRasterPdf({
      pageCount: pdf.numPages, dpi: preset.dpi, quality: preset.quality,
      checkCancelled: () => throwIfCancelled(ctx.signal),
      renderPage: async (pageNum, scale) => {
        const rendered = await renderPage(ctx, pdf, pageNum, scale);
        return rendered;
      },
      toJpeg: async (rendered, quality) => {
        try { return await (ctx.toJpeg || canvasJpeg)(rendered.canvas, quality); } finally { releaseCanvas(pdf, rendered); }
      },
      pageSize: async (pageNum) => (await pdf.getPage(pageNum)).getViewport({ scale: 1 }),
    });
  } finally {
    await opened.close();
  }
  throwIfCancelled(ctx.signal);
  const bytes = await saveBytes(newPdf, COMPRESS_SAVE_OPTIONS);
  return { bytes, detail: { code: 'reduced', before: file.bytes.length, after: bytes.length } };
}

/** OCR (desktop): the Tauri engine reads each page of the source file; the words become a text layer. */
async function ocr(file, ctx) {
  if (typeof ctx.ocrPage !== 'function') throw new BatchOpError('desktopOnly');
  const lib = await loadPdf(file.bytes);
  const pages = resolvePages(ctx.options.pages, lib.getPageCount());
  const results = {};
  let words = 0;
  for (const pageNum of pages) {
    throwIfCancelled(ctx.signal);
    const found = await ctx.ocrPage(file.path, pageNum - 1, ctx.options.lang || 'auto');
    results[pageNum] = Array.isArray(found) ? found : [];
    words += results[pageNum].length;
  }
  throwIfCancelled(ctx.signal);
  if (!words) return { bytes: null, detail: { code: 'noText' } };
  await writeOcrResults(lib, lib.getPages(), results, ctx.ocrFontBytes || null);
  return { bytes: await saveBytes(lib), detail: { code: 'recognized', words, count: pages.length } };
}

/**
 * The PDF Batch ▸ Print sends: markups flattened into the page (as the print
 * dialog prints document and markups), then the pages as vectors at their own
 * size (print-vector.js, as "Save as PDF" in the print dialog). Exported for
 * the render-diff test.
 */
export async function batchPrintPdf(bytes, { pages = null } = {}) {
  const lib = await loadPdf(bytes, { updateMetadata: false });
  const chosen = pages || Array.from({ length: lib.getPageCount() }, (_, i) => i + 1);
  flattenPdfDocument(lib, { pages: chosen, allowUnflatten: false });
  const flat = await lib.save();
  const { pdf } = await bouwVectorPrintPdf({
    bronBytes: flat,
    paginas: chosen.map((pageNum) => ({ index: pageNum - 1, extraRotatie: 0 })),
    keuzes: { papier: null, orientatie: 'auto', schaling: 'fit', zoom: 100, centreren: true },
  });
  return new Uint8Array(await pdf.save());
}

/** Print (desktop): one print job per file, in order. */
async function print(file, ctx) {
  if (typeof ctx.spool !== 'function') throw new BatchOpError('desktopOnly');
  const lib = await loadPdf(file.bytes, { updateMetadata: false });
  const pages = resolvePages(ctx.options.pages, lib.getPageCount());
  const printable = await batchPrintPdf(file.bytes, { pages });
  throwIfCancelled(ctx.signal);
  await ctx.spool(printable, file.name, ctx.options);
  return { bytes: null, printed: true, detail: { code: 'printed', count: pages.length, copies: Math.max(1, Number(ctx.options.copies) || 1) } };
}

/**
 * Split (Document ▸ Extract Pages per part): every `every` pages, or at the
 * pages of a range ("1-2, 3, 4-6": one part per item), into their own file.
 * Returns `outputs` named `<stem><suffix><n>.pdf`.
 */
async function split(file, ctx) {
  const src = await loadPdf(file.bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const parts = [];
  if (ctx.options.by === 'ranges') {
    const items = String(ctx.options.ranges || '').split(',').map((item) => item.trim()).filter(Boolean);
    for (const item of items) {
      const pages = parsePageRange(item, total).sort((a, b) => a - b);
      if (!pages.length) throw new BatchOpError('noPagesInRange', { range: item, total });
      parts.push(pages);
    }
    if (!parts.length) throw new BatchOpError('noPagesInRange', { range: '', total });
  } else {
    const every = Math.max(1, Math.floor(Number(ctx.options.every) || 1));
    for (let start = 1; start <= total; start += every) {
      parts.push(Array.from({ length: Math.min(every, total - start + 1) }, (_, i) => start + i));
    }
  }
  const width = String(parts.length).length;
  const outputs = [];
  for (let i = 0; i < parts.length; i++) {
    throwIfCancelled(ctx.signal);
    const part = await extractPdfLibPages(src, parts[i]);
    outputs.push({ part: String(i + 1).padStart(width, '0'), bytes: await saveBytes(part) });
  }
  return { bytes: null, outputs, detail: { code: 'split', count: outputs.length } };
}

/**
 * Repair: read the file the tolerant way pdf-lib reads every PDF (objects
 * found by scanning, not by the cross-reference table) and write it fresh,
 * with a new cross-reference table and without the unreachable objects.
 */
async function repair(file, ctx) {
  const lib = await loadPdf(file.bytes, { updateMetadata: false, throwOnInvalidObject: false });
  throwIfCancelled(ctx.signal);
  const removed = verwijderOnbereikbaar(lib);
  return { bytes: await saveBytes(lib, { useObjectStreams: false }), detail: { code: 'repaired', pages: lib.getPageCount(), removed } };
}

export const BATCH_OPS = Object.freeze({
  flatten, ocr, applyStamp, headersFooters, rotate, cropPageSetup, reduceFileSize, print, split, repair,
});

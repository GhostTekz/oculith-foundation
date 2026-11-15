// Batch operations (docs/reference/editor/sets-and-batch.md) on real PDF bytes: three files written
// by the real saver (markups, page labels, a /Rotate 90 page, drawn text and
// lines) plus a corrupt file, through the runner. Each op over the set gives
// for every file what the single-document operation gives for that file:
// byte-equal where the single-document command calls a pure core on the same
// bytes, structurally equal to the real saver for Apply Stamp, Headers &
// Footers, Rotate and OCR, and a render diff for Reduce File Size and Print.
// The log lists every file, the corrupt one is reported, cancel leaves no
// output for unfinished files, and in place needs the desktop path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFHexString, PDFArray, StandardFonts, rgb, degrees, decodePDFRawStream, PDFRawStream } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();
// PDF.js schedules render steps with it in a window (the browser has it).
if (typeof window !== 'undefined' && !window.requestAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF } = await import('../pdf/saver.js');
const { flattenPdfDocument } = await import('../pdf/flatten.js');
const { rotatePdfLibPage } = await import('../pdf/rotate-pages-core.js');
const { resizePdfLibPages, PAGE_MM_TO_POINTS } = await import('../pdf/resize-pages-core.js');
const { extractPdfLibPages } = await import('../pdf/extract-pages-core.js');
const { contentRenderScale, contentBoundsFromPixels, applyCropBoxes, MM_TO_POINTS } = await import('../pdf/crop-margins-core.js');
const { CONTRACTOR_STAMPS } = await import('../annotations/stamp-templates.js');
const { runBatch, batchFileList } = await import('./runner.js');
const { batchOpJob } = await import('./batch-ops-job.js');
const { BATCH_OP_IDS, headerFooterSpec, batchPrintPdf, resolvePages, suffixedName } = await import('./ops.js');
const { batchStampModel, displayedPage } = await import('./stamp-place.js');
const { MENUS } = await import('../solid/commands/menus.js');

const fontBytes = new Uint8Array(await readFile(new URL('../../public/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));
const NOW = new Date(2026, 9, 14, 9, 5);
const USER = 'Jason Niewoit';

// --- fixtures: the real saver ---------------------------------------------------

async function source(pages, { labels = null, rotateFirst = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([842, 595]);
    // Inside the frame: the frame alone sets the content bounds (glyph rendering may vary).
    page.drawText(`SHEET ${i + 1} PLAN`, { x: 140, y: 300, size: 28, font, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 100, y: 120, width: 560, height: 260, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    if (i === 0 && rotateFirst) page.setRotation(degrees(90));
  }
  if (labels) {
    doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({
      Nums: [0, doc.context.obj({ S: PDFName.of('D'), P: PDFHexString.fromText(labels), St: 101 })] }));
  }
  return doc.save();
}

function openDocument(annotations, pages, extra = {}) {
  state.documents = [{ id: `ops-${Math.random()}`, filePath: 'C:/ops/input.pdf', fileName: 'input.pdf', pdfDoc: { numPages: pages },
    currentPage: 1, annotations, pageRotations: {}, watermarks: [], ocrResults: {},
    _annotationPagesReady: new Set(Array.from({ length: pages }, (_, i) => i + 1)), textEdits: [], ...extra }];
  state.activeDocumentIndex = 0;
  return state.documents[0];
}

/** Run the real saver over `bytes` with these models (the single-document save). */
async function save(bytes, annotations, pages, extra = {}) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_path, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_path, data) => { saved = data; return true; },
  } };
  openDocument(annotations, pages, extra);
  assert.equal(await savePDF('C:/ops/output.pdf', { zonderHandtekeningVraag: true }), true);
  return new Uint8Array(saved);
}

const box = (page, i) => createAnnotation({ type: 'box', page, x: 160 + i * 40, y: 200 + i * 12, width: 30, height: 20,
  color: '#e11d48', strokeColor: '#e11d48', lineWidth: 2, author: 'Site', subject: 'Clash' });

const sources = {
  A: await save(await source(2, { labels: 'A-', rotateFirst: true }), [box(1, 0), box(1, 1), box(2, 2)], 2),
  B: await save(await source(1), [box(1, 0), box(1, 3)], 1),
  C: await save(await source(3, { labels: 'S-' }), [box(1, 0), box(2, 1), box(3, 2), box(3, 4)], 3),
};
const files = new Map([
  ['/set/A-101.pdf', sources.A],
  ['/set/broken.pdf', new TextEncoder().encode('%PDF-1.7\nnot a pdf')],
  ['/set/B.pdf', sources.B],
  ['/set/S-201.pdf', sources.C],
]);
const good = [['/set/A-101.pdf', sources.A], ['/set/B.pdf', sources.B], ['/set/S-201.pdf', sources.C]];
const list = batchFileList([...files.keys()]);
const readFromMap = async (path) => files.get(path);

/** Run one op over the set into an in-memory folder. */
async function runOp(op, options = {}, { context = {}, output = {}, signal, onProgress } = {}) {
  const disk = new Map();
  const job = batchOpJob({
    op, options, context: { pdfjs, now: NOW, user: USER, ...context },
    output: { mode: 'folder', dir: '/out', suffix: `_${op}`, ...output },
    write: async (path, bytes) => { disk.set(path, new Uint8Array(bytes)); },
    exists: async (path) => disk.has(path) || files.has(path),
    sources: [...files.keys()],
  });
  const result = await runBatch({ files: list, readFile: readFromMap, job, signal, onProgress });
  return { result, disk };
}

function assertLog(result, op) {
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.log.map((e) => [e.name, e.ok]),
    [['A-101.pdf', true], ['broken.pdf', false], ['B.pdf', true], ['S-201.pdf', true]], `${op}: every file in the log`);
  assert.match(result.log[1].error, /^unreadable /u, `${op}: the corrupt file is reported as not a readable PDF`);
}

const outPath = (path, op) => `/out/${suffixedName(path.split('/').pop(), `_${op}`)}`;

// Same PDF apart from the save time: pdf-lib stamps /ModDate (seconds) on a
// load with metadata updates, so two saves a second apart differ there only.
async function assertSameIgnoringModDate(actual, expected, message) {
  const norm = async (bytes) => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    doc.setModificationDate(new Date(0));
    return new Uint8Array(await doc.save());
  };
  // No raw length check: the save time sits in a compressed object stream,
  // so the compressed length depends on it.
  assert.deepEqual(await norm(actual), await norm(expected), message);
}

async function withPdfJs(bytes, fn) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try { return await fn(doc); } finally { await task.destroy(); }
}

async function pageTexts(bytes) {
  return withPdfJs(bytes, async (doc) => {
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      out.push(content.items.map((item) => item.str).filter((s) => s.trim()).join(' | '));
    }
    return out;
  });
}

async function render(bytes, pageNum, scale = 0.5) {
  return withPdfJs(bytes, async (doc) => {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport, canvas, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
  });
}

/** Share of pixels whose channels differ by more than `tol`. */
function diffShare(a, b, tol = 48) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let differ = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > tol || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol
      || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) differ++;
  }
  return differ / (a.width * a.height);
}

async function annotsOf(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const ref = doc.getPages()[pageIndex].node.get(PDFName.of('Annots'));
  const arr = ref ? doc.context.lookup(ref) : null;
  return { doc, annots: arr instanceof PDFArray ? arr.asArray().map((r) => doc.context.lookup(r)) : [] };
}

const subtype = (dict) => dict.get(PDFName.of('Subtype'))?.toString();
const streamText = (doc, stream) => {
  const s = doc.context.lookup(stream);
  return new TextDecoder('latin1').decode(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
};

// --- tests -------------------------------------------------------------------------

test('Flatten over the set equals the single-document flatten of each file, byte for byte', async () => {
  const { result, disk } = await runOp('flatten', { pages: { mode: 'all' }, allowUnflatten: true });
  assertLog(result, 'flatten');
  for (const [path, bytes] of good) {
    // Document ▸ Flatten: the saver's bytes, then flattenPdfDocument on every markup.
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    flattenPdfDocument(lib, { pages: resolvePages({ mode: 'all' }, lib.getPageCount()), allowUnflatten: true });
    await assertSameIgnoringModDate(disk.get(outPath(path, 'flatten')), new Uint8Array(await lib.save()), path);
    const { annots } = await annotsOf(disk.get(outPath(path, 'flatten')));
    assert.equal(annots.filter((a) => subtype(a) === '/Square').length, 0, 'no markups left');
  }
  assert.equal(disk.size, 3);
  assert.deepEqual(result.log.filter((e) => e.ok).map((e) => e.detail.count), [3, 2, 4]);
  for (const [path, bytes] of good) assert.deepEqual(files.get(path), bytes, 'sources are not changed');
});

test('Rotate equals the saver applying an in-app page rotation: /Rotate turns, markups stay on the page', async () => {
  const { result, disk } = await runOp('rotate', { pages: { mode: 'range', range: '1' }, delta: 90 });
  assertLog(result, 'rotate');
  for (const [path, bytes] of good) {
    const out = disk.get(outPath(path, 'rotate'));
    const ref = await PDFDocument.load(bytes);
    rotatePdfLibPage(ref.getPage(0), 90);
    await assertSameIgnoringModDate(out, new Uint8Array(await ref.save()), `${path}: byte-equal to the shared rotate step`);
    const lib = await PDFDocument.load(out);
    const src = await PDFDocument.load(bytes);
    assert.equal(lib.getPage(0).getRotation().angle, (src.getPage(0).getRotation().angle + 90) % 360);
    if (lib.getPageCount() > 1) assert.equal(lib.getPage(1).getRotation().angle, src.getPage(1).getRotation().angle);
  }
  // The single-document path: the saver with pageRotations { 1: 90 } gives the same /Rotate.
  const viaSaver = await save(sources.B, [box(1, 0), box(1, 3)], 1, { pageRotations: { 1: 90 } });
  assert.equal((await PDFDocument.load(viaSaver)).getPage(0).getRotation().angle,
    (await PDFDocument.load(disk.get(outPath('/set/B.pdf', 'rotate')))).getPage(0).getRotation().angle);
  // A-101 page 1 was /Rotate 90 already: 180 now (normalised).
  assert.equal((await PDFDocument.load(disk.get(outPath('/set/A-101.pdf', 'rotate')))).getPage(0).getRotation().angle, 180);
});

test('Headers & Footers equal the Header & Footer dialog saved by the saver, text for text', async () => {
  const options = { headerLeft: '{filename}', headerRight: 'Page {page} of {pages}', footerCenter: 'Issued {date}', fontSize: 9, pages: { mode: 'all' } };
  // The saver fills {date} from the clock, so the batch run uses the clock too
  // (a fixed date only matched the saver on that one day).
  const today = new Date();
  const { result, disk } = await runOp('headersFooters', options, { context: { now: today } });
  assertLog(result, 'headersFooters');
  for (const [path, bytes] of good) {
    const name = path.split('/').pop();
    const pageCount = (await PDFDocument.load(bytes)).getPageCount();
    const viaSaver = await save(bytes, [], pageCount, { fileName: name, watermarks: [headerFooterSpec(options)],
      _annotationPagesReady: new Set() });
    const batch = await pageTexts(disk.get(outPath(path, 'headersFooters')));
    assert.deepEqual(batch, await pageTexts(viaSaver), path);
    assert.match(batch[0], new RegExp(`${name.replace('.', '\\.')}.*Page 1 of ${pageCount}`, 'u'));
    assert.match(batch[0], new RegExp(`Issued ${today.toLocaleDateString().replace(/[/.]/gu, '\\$&')}`, 'u'));
  }
});

test('Apply Stamp writes the stamp the saver writes for the same placement; fields per file and page', async () => {
  const template = CONTRACTOR_STAMPS.find((t) => t.id === 'ct:approved') || CONTRACTOR_STAMPS[0];
  const options = { template, pages: { mode: 'all' }, position: 'bottom-right', margin: 36 };
  const { result, disk } = await runOp('applyStamp', options);
  assertLog(result, 'applyStamp');
  assert.deepEqual(result.log.filter((e) => e.ok).map((e) => e.detail.count), [2, 1, 3]);

  for (const [path, bytes] of good) {
    const name = path.split('/').pop();
    const out = disk.get(outPath(path, 'applyStamp'));
    const src = await PDFDocument.load(bytes);
    const labels = await withPdfJs(bytes, (doc) => doc.getPageLabels());
    for (let p = 1; p <= src.getPageCount(); p++) {
      const shown = displayedPage(src.getPage(p - 1));
      const model = batchStampModel(template, { pageNum: p, pageW: shown.width, pageH: shown.height, position: 'bottom-right', margin: 36,
        fields: { now: NOW, user: USER, pageLabel: labels?.[p - 1] || '', fileName: name } });
      // The single-document path: the saver writes this model (no other markups on the page).
      const viaSaver = await save(bytes, [model], src.getPageCount(), { _annotationPagesReady: new Set([p]) });
      const a = (await annotsOf(out, p - 1));
      const b = (await annotsOf(viaSaver, p - 1));
      const stampA = a.annots.filter((d) => subtype(d) === '/Stamp');
      const stampB = b.annots.filter((d) => subtype(d) === '/Stamp');
      assert.equal(stampA.length, 1, `${name} p${p}: one stamp`);
      assert.equal(stampB.length, 1);
      for (const key of ['Rect', 'Name', 'Subj', 'C', 'CA', 'T', 'F', 'IT', 'OPS_StampName', 'OPS_StampDesign', 'OPS_StampText']) {
        assert.equal(stampA[0].get(PDFName.of(key))?.toString(), stampB[0].get(PDFName.of(key))?.toString(), `${name} p${p} /${key}`);
      }
      const apA = a.doc.context.lookup(stampA[0].get(PDFName.of('AP'))).get(PDFName.of('N'));
      const apB = b.doc.context.lookup(stampB[0].get(PDFName.of('AP'))).get(PDFName.of('N'));
      assert.equal(streamText(a.doc, apA), streamText(b.doc, apB), `${name} p${p}: same appearance`);
      // The existing markups are untouched (same count of boxes as the source).
      const srcBoxes = (await annotsOf(bytes, p - 1)).annots.filter((d) => subtype(d) === '/Square').length;
      assert.equal(a.annots.filter((d) => subtype(d) === '/Square').length, srcBoxes);
      const design = stampA[0].get(PDFName.of('OPS_StampDesign')).decodeText();
      assert.ok(design.includes(USER), 'the {user} field');
    }
  }
  // {pageLabel} / {fileName} evaluated per file: A-101's stamp knows its label.
  const textA = (await annotsOf(disk.get(outPath('/set/A-101.pdf', 'applyStamp')), 1)).annots
    .find((d) => subtype(d) === '/Stamp').get(PDFName.of('OPS_StampDesign')).decodeText();
  assert.ok(textA.includes('"templateId":"' + template.id + '"'));
});

test('Crop & Page Setup: crop equals the content scan + CropBox of Crop Pages; size equals Page Setup', async () => {
  const crop = await runOp('cropPageSetup', { mode: 'margins', pages: { mode: 'all' }, paddingMm: 2, threshold: 250 });
  assertLog(crop.result, 'crop');
  for (const [path, bytes] of good) {
    const lib = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const bounds = new Map();
    for (let p = 1; p <= lib.getPageCount(); p++) {
      const vp = await withPdfJs(bytes, async (doc) => (await doc.getPage(p)).getViewport({ scale: 1 }));
      const scale = contentRenderScale(vp.width, vp.height);
      const px = await render(bytes, p, scale);
      const b = contentBoundsFromPixels(px.data, px.width, px.height, 250);
      if (b) bounds.set(p, b);
    }
    applyCropBoxes(lib.getPages(), bounds, 2 * MM_TO_POINTS);
    const out = crop.disk.get(outPath(path, 'cropPageSetup'));
    await assertSameIgnoringModDate(out, new Uint8Array(await lib.save()), path);
    const page = (await PDFDocument.load(out)).getPage(0);
    assert.ok(page.getCropBox().width < page.getMediaBox().width, 'the margins are cropped');
  }

  const size = await runOp('cropPageSetup', { mode: 'size', pages: { mode: 'all' }, preset: 'a3', orientation: 'landscape' });
  assertLog(size.result, 'size');
  for (const [path, bytes] of good) {
    const lib = await PDFDocument.load(bytes, { ignoreEncryption: true });
    resizePdfLibPages(lib.getPages(), resolvePages({ mode: 'all' }, lib.getPageCount()), 420 * PAGE_MM_TO_POINTS, 297 * PAGE_MM_TO_POINTS);
    await assertSameIgnoringModDate(size.disk.get(outPath(path, 'cropPageSetup')), new Uint8Array(await lib.save()), path);
  }
});

test('Reduce File Size gives page images at the original size that render like the source', async () => {
  const { result, disk } = await runOp('reduceFileSize', { level: 'high' });
  assertLog(result, 'reduce');
  for (const [path, bytes] of good) {
    const out = disk.get(outPath(path, 'reduceFileSize'));
    const src = await PDFDocument.load(bytes);
    const lib = await PDFDocument.load(out);
    assert.equal(lib.getPageCount(), src.getPageCount());
    for (let p = 1; p <= src.getPageCount(); p++) {
      const shown = displayedPage(src.getPage(p - 1));
      const { width, height } = lib.getPage(p - 1).getSize();
      assert.ok(Math.abs(width - shown.width) < 0.01 && Math.abs(height - shown.height) < 0.01, `${path} p${p} size`);
      assert.ok(diffShare(await render(out, p), await render(bytes, p)) < 0.01, `${path} p${p} renders like the source`);
    }
    assert.deepEqual(await pageTexts(out), src.getPages().map(() => ''), 'text became image, as Document ▸ Reduce File Size');
  }
});

test('OCR (desktop) writes the words the saver writes from the same OCR results', async () => {
  const words = (path, index) => [{ text: `${path.split('/').pop()}-P${index + 1}`, left: 120, top: 150, width: 200, height: 28, confidence: 90 },
    { text: 'DOOR', left: 300, top: 300, width: 60, height: 14, confidence: 88 }];
  const calls = [];
  const ocrPage = async (path, pageIndex, lang) => { calls.push([path, pageIndex, lang]); return words(path, pageIndex); };
  const { result, disk } = await runOp('ocr', { pages: { mode: 'all' }, lang: 'eng' }, { context: { ocrPage, ocrFontBytes: fontBytes } });
  assertLog(result, 'ocr');
  assert.deepEqual(calls.map((c) => c[0]), ['/set/A-101.pdf', '/set/A-101.pdf', '/set/B.pdf', '/set/S-201.pdf', '/set/S-201.pdf', '/set/S-201.pdf']);
  assert.ok(calls.every((c) => c[2] === 'eng'));
  // The saver resolves the bundled OCR font through Tauri.
  globalThis.window.__TAURI__ = { core: { invoke: async () => 'font.ttf' }, fs: { readFile: async () => fontBytes } };
  for (const [path, bytes] of good) {
    const pageCount = (await PDFDocument.load(bytes)).getPageCount();
    const ocrResults = Object.fromEntries(Array.from({ length: pageCount }, (_, i) => [i + 1, words(path, i)]));
    const viaSaver = await save(bytes, [], pageCount, { ocrResults, _annotationPagesReady: new Set() });
    assert.deepEqual(await pageTexts(disk.get(outPath(path, 'ocr'))), await pageTexts(viaSaver), path);
  }
  const noEngine = await runOp('ocr', { pages: { mode: 'all' } });
  assert.ok(noEngine.result.log.filter((e) => e.name !== 'broken.pdf').every((e) => !e.ok && /desktopOnly/u.test(e.error)), 'browser: OCR needs the desktop');
});

test('Print (desktop) spools one job per file in order; the print PDF renders like document and markups', async () => {
  const jobs = [];
  const spool = async (bytes, name, options) => { jobs.push({ name, pages: (await PDFDocument.load(bytes)).getPageCount(), copies: options.copies }); };
  const { result, disk } = await runOp('print', { pages: { mode: 'all' }, copies: 2 }, { context: { spool } });
  assertLog(result, 'print');
  assert.equal(disk.size, 0, 'printing writes no file');
  assert.deepEqual(jobs, [{ name: 'A-101.pdf', pages: 2, copies: 2 }, { name: 'B.pdf', pages: 1, copies: 2 }, { name: 'S-201.pdf', pages: 3, copies: 2 }]);
  for (const [path, bytes] of good) {
    const printable = await batchPrintPdf(bytes);
    for (let p = 1; p <= (await PDFDocument.load(bytes)).getPageCount(); p++) {
      assert.ok(diffShare(await render(printable, p), await render(bytes, p)) < 0.01, `${path} p${p}: prints what is shown`);
    }
    assert.equal((await annotsOf(printable)).annots.length, 0, 'markups are drawn, not annotations');
  }
});

test('Split equals Document ▸ Extract Pages per part; parts are numbered, never in place', async () => {
  const { result, disk } = await runOp('split', { every: 2 });
  assertLog(result, 'split');
  assert.deepEqual([...disk.keys()], ['/out/A-101_split1.pdf', '/out/B_split1.pdf', '/out/S-201_split1.pdf', '/out/S-201_split2.pdf']);
  const c = await PDFDocument.load(sources.C, { ignoreEncryption: true });
  await assertSameIgnoringModDate(disk.get('/out/S-201_split2.pdf'), new Uint8Array(await (await extractPdfLibPages(c, [3])).save()), 'split2');
  await assertSameIgnoringModDate(disk.get('/out/S-201_split1.pdf'), new Uint8Array(await (await extractPdfLibPages(c, [1, 2])).save()), 'split1');
  // Ranges clamp to the file as in Extract Pages; a range wholly past the end fails that file.
  const ranges = await runOp('split', { by: 'ranges', ranges: '1, 2-3' });
  assert.deepEqual(ranges.result.log.map((e) => e.ok), [true, false, false, true]);
  assert.match(ranges.result.log[2].error, /noPagesInRange/u);
  assert.deepEqual([...ranges.disk.keys()], ['/out/A-101_split1.pdf', '/out/A-101_split2.pdf', '/out/S-201_split1.pdf', '/out/S-201_split2.pdf']);
  assert.equal((await PDFDocument.load(ranges.disk.get('/out/S-201_split2.pdf'))).getPageCount(), 2);
  const inPlace = await runOp('split', {}, { output: { mode: 'inPlace' } });
  assert.ok(inPlace.result.log.every((e) => !e.ok) && inPlace.disk.size === 0);
});

test('Repair writes a fresh cross-reference table that points at the right objects', async () => {
  // A classic cross-reference table whose startxref points into nowhere.
  const classic = await (await PDFDocument.load(sources.B)).save({ useObjectStreams: false });
  const text = Array.from(classic, (b) => String.fromCharCode(b)).join('');
  const damaged = Uint8Array.from(text.replace(/startxref\s+\d+/u, 'startxref\n12'), (c) => c.charCodeAt(0));
  files.set('/set/B.pdf', damaged);
  try {
    const { result, disk } = await runOp('repair');
    assertLog(result, 'repair');
    const out = disk.get('/out/B_repair.pdf');
    const written = Array.from(out, (b) => String.fromCharCode(b)).join('');
    const offset = Number(/startxref\s+(\d+)\s+%%EOF\s*$/u.exec(written)[1]);
    assert.equal(written.slice(offset, offset + 4), 'xref', 'startxref points at the table');
    assert.ok(diffShare(await render(out, 1), await render(sources.B, 1)) < 0.001, 'the repaired file shows the same page');
  } finally {
    files.set('/set/B.pdf', sources.B);
  }
});

test('cancel: finished files keep their output, unfinished files get none', async () => {
  const controller = new AbortController();
  const { result, disk } = await runOp('flatten', { pages: { mode: 'all' } }, {
    signal: controller.signal, onProgress: (p) => { if (p.phase === 'done' && p.index === 0) controller.abort(); } });
  assert.equal(result.cancelled, true);
  assert.deepEqual([...disk.keys()], ['/out/A-101_flatten.pdf']);
  assert.deepEqual(result.log.map((e) => e.name), ['A-101.pdf']);

  // Cancelled inside a file (between pages of a render): that file gets nothing.
  const inside = new AbortController();
  let pages = 0;
  const toJpeg = async (canvas, quality) => {
    if (++pages === 2) inside.abort();
    return new Uint8Array(await canvas.encode('jpeg', Math.round(quality * 100)));
  };
  const run = await runOp('reduceFileSize', { level: 'low' }, { context: { toJpeg }, signal: inside.signal });
  assert.equal(run.result.cancelled, true);
  assert.equal(run.disk.size, 0, 'A-101 (2 pages) was cut off after page 2 and wrote nothing');
});

test('in place writes the source itself, refuses files open in a tab, and never runs without the mode', async () => {
  const disk = new Map();
  const job = batchOpJob({
    op: 'rotate', options: { pages: { mode: 'all' }, delta: 180 }, context: { now: NOW },
    output: { mode: 'inPlace' }, write: async (path, bytes) => { disk.set(path, bytes); },
    sources: [...files.keys()], openPaths: ['/SET/b.pdf'],
  });
  const result = await runBatch({ files: list, readFile: readFromMap, job });
  assert.deepEqual(result.log.map((e) => [e.name, e.ok]), [['A-101.pdf', true], ['broken.pdf', false], ['B.pdf', false], ['S-201.pdf', true]]);
  assert.match(result.log[2].error, /openInTab/u);
  assert.deepEqual([...disk.keys()], ['/set/A-101.pdf', '/set/S-201.pdf']);
  assert.deepEqual(result.output.written, ['/set/A-101.pdf', '/set/S-201.pdf']);

  // Folder mode next to the sources: a name that exists gets " (2)", the source is never hit.
  const beside = await runOp('rotate', { delta: 90 }, { output: { dir: '/set', suffix: '' } });
  assert.deepEqual([...beside.disk.keys()], ['/set/A-101 (2).pdf', '/set/B (2).pdf', '/set/S-201 (2).pdf']);
});

test('a page range that selects nothing in a file fails that file only', async () => {
  const { result, disk } = await runOp('rotate', { pages: { mode: 'range', range: '3' }, delta: 90 });
  assert.deepEqual(result.log.map((e) => [e.name, e.ok]), [['A-101.pdf', false], ['broken.pdf', false], ['B.pdf', false], ['S-201.pdf', true]]);
  assert.match(result.log[0].error, /noPagesInRange/u);
  assert.deepEqual([...disk.keys()], ['/out/S-201_rotate.pdf']);
});

test('the Batch menu has a command for every op; only Security, Sign & Seal and Script stay placeholders', () => {
  const batch = MENUS.find((m) => m.id === 'batch').items;
  const placeholders = batch.filter((item) => item && typeof item === 'object' && item.placeholder).map((item) => item.placeholder);
  assert.deepEqual(placeholders, ['common:menu.batchPending.security', 'common:menu.batchPending.signSeal', 'common:menu.batchPending.script']);
  const ids = batch.map((item) => (typeof item === 'string' ? item : item?.command)).filter(Boolean);
  for (const op of BATCH_OP_IDS) assert.ok(ids.includes(`batch.${op}`), `batch.${op} is in the menu`);
  assert.ok(ids.includes('batch.slipSheet'));
});

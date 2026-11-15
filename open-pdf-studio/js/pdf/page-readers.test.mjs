// Page readers of an open file (openPageReaders): one over the file's
// bytes in memory, with its fonts kept out of the window, reads the same
// text and operator list as the document itself; closing a reader ends
// its worker (through its loading task: a PDF.js document has no destroy).
// One that reads no images leaves them out of its operator lists, its
// paths and text the same.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { closePageReaders, memoryRangeSource, readerFonts, readerImages } = await import('./page-readers.js');
const { createRangeTransport } = await import('./file-range.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) {
    const page = pdf.addPage([400, 300]);
    page.drawText(`PANEL LP-${n}`, { x: 40, y: 250, size: 14, font });
    page.drawLine({ start: { x: 20, y: 200 }, end: { x: 380, y: 200 }, thickness: 1, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 50, y: 50, width: 100 * n, height: 60, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
  }
  return pdf.save();
}

const textOf = async (doc, n) => (await (await doc.getPage(n)).getTextContent()).items.map((it) => it.str).join('|');
const opsOf = async (doc, n) => {
  const page = await doc.getPage(n);
  const list = await page.getOperatorList();
  // (A font is named after the document that loaded it.)
  return JSON.stringify([list.fnArray, list.argsArray]).replace(/g_d\d+_/g, 'g_d_');
};

test('readers keep their fonts out of the window only when asked', () => {
  assert.deepEqual(readerFonts(), {});
  assert.deepEqual(readerFonts(true), {});
  assert.deepEqual(readerFonts(false), { disableFontFace: true });
});

test('a reader over the bytes in memory reads each page as the document does, range by range', async () => {
  const bytes = await samplePdf();
  const own = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const source = memoryRangeSource(bytes);
  const reads = [];
  const read = source.read;
  source.read = async (begin, end) => { reads.push([begin, end]); return read(begin, end); };
  const reader = await pdfjs.getDocument({
    range: createRangeTransport(pdfjs, source), rangeChunkSize: 1024, disableAutoFetch: true, disableStream: true,
    isEvalSupported: false, verbosity: 0, ...readerFonts(false),
  }).promise;
  try {
    assert.equal(source.length, bytes.length);
    assert.equal(reader.numPages, own.numPages);
    for (let n = 1; n <= own.numPages; n++) {
      assert.equal(await textOf(reader, n), await textOf(own, n));
      assert.equal(await opsOf(reader, n), await opsOf(own, n));
    }
    assert.ok(reads.length > 1 && reads.every(([b, e]) => e - b < bytes.length), 'read by range, not whole');
    const copy = await source.read(0, 8);
    copy[0] = 0;
    assert.notEqual(bytes[0], 0, 'each read is a copy: the bytes in memory stay as they are');
  } finally {
    closePageReaders([reader]);
    await own.loadingTask.destroy();
  }
});

test('closing readers ends each one, also one closed already or none at all', async () => {
  const bytes = await samplePdf();
  const a = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const b = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  assert.equal(typeof a.destroy, 'undefined', 'a PDF.js document is destroyed through its loading task');
  closePageReaders([a, b]);
  closePageReaders([a, null, undefined]);
  closePageReaders(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(a.loadingTask.destroyed, true);
  assert.equal(b.loadingTask.destroyed, true);
});

test('readers leave the images out only when asked', () => {
  assert.deepEqual(readerImages(), {});
  assert.deepEqual(readerImages(true), {});
  assert.deepEqual(readerImages(false), { maxImageSize: 0 });
});

test('a reader without images reads the same paths and text, and no image', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // A 2 x 2 grey picture, painted as tiles over the page, with a line and text over them.
  const tile = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12O8e/cuAwMDEwMDAwMDAwAfPgKb/xleFwAAAABJRU5ErkJggg==', 'base64'));
  const page = pdf.addPage([400, 300]);
  for (let i = 0; i < 4; i++) page.drawImage(tile, { x: 100 * i, y: 0, width: 100, height: 300 });
  page.drawLine({ start: { x: 20, y: 200 }, end: { x: 380, y: 200 }, thickness: 1, color: rgb(0, 0, 0) });
  page.drawText('TRAY', { x: 40, y: 250, size: 14, font });
  const bytes = await pdf.save();
  const { OPS } = pdfjs;
  const images = new Set([OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  const own = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const reader = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, ...readerFonts(false), ...readerImages(false) }).promise;
  try {
    const withImages = await (await own.getPage(1)).getOperatorList();
    const without = await (await reader.getPage(1)).getOperatorList();
    assert.ok(withImages.fnArray.some((fn) => images.has(fn)), 'the document paints the picture');
    assert.ok(!without.fnArray.some((fn) => images.has(fn)), 'the reader leaves it out');
    const paths = (list) => JSON.stringify(list.fnArray.map((fn, i) => (fn === OPS.constructPath ? list.argsArray[i] : null)).filter(Boolean));
    assert.equal(paths(without), paths(withImages));
    assert.equal(await textOf(reader, 1), await textOf(own, 1));
  } finally {
    closePageReaders([reader]);
    await own.loadingTask.destroy();
  }
});

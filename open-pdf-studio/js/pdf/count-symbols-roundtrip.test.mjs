// Symbol counts through a real save -> reopen with PDF bytes: every count
// symbol is written as a vector appearance (no image XObject), PDF.js renders
// that appearance within a pixel-diff threshold of the canvas drawing of the
// same marker, and size / number visibility / symbol survive two saves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { degrees, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
// PDF.js schedules render steps with requestAnimationFrame when `window` exists (the stub).
globalThis.window.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);
const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF } = await import('./saver.js');
const { convertPdfAnnotation } = await import('./loader/annotation-converter.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { listCountSymbols } = await import('../symbols/count-symbols.js');
const { drawCountSymbolMarker } = await import('../annotations/count-marker.js');

const require = createRequire(import.meta.url);
let napiCanvas = null;
try { napiCanvas = require('@napi-rs/canvas'); } catch { /* optional (pdfjs-dist dependency) */ }
// Draw the canvas side with a Helvetica-metric font when the machine has one
// (Chromium in the app resolves "Helvetica, Arial" the same way).
let helveticaOnCanvas = false;
if (napiCanvas) {
  const { existsSync } = await import('node:fs');
  for (const [regular, bold] of [
    ['/usr/share/fonts/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/liberation/LiberationSans-Bold.ttf'],
    ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
    ['/usr/share/fonts/gsfonts/NimbusSans-Regular.otf', '/usr/share/fonts/gsfonts/NimbusSans-Bold.otf'],
  ]) {
    if (!existsSync(regular) || !existsSync(bold)) continue;
    napiCanvas.GlobalFonts.registerFromPath(regular, 'Helvetica');
    napiCanvas.GlobalFonts.registerFromPath(bold, 'Helvetica');
    helveticaOnCanvas = true;
    break;
  }
}
// PDF.js wants a trailing "/": a Windows path ends in "\\".
const STANDARD_FONTS = fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replace(/\\/g, '/');

async function save(bytes, annotations) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_path, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_path, data) => { saved = data; return true; },
  } };
  state.documents = [{ id: `count-sym-${Math.random()}`, filePath: 'C:/count/input.pdf', pdfDoc: {},
    annotations, pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  assert.equal(await savePDF('C:/count/output.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

async function rawCounts(bytes) {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const annots = ctx.lookup(doc.getPages()[0].node.get(PDFName.of('Annots')));
  return annots.asArray().map(ref => ctx.lookup(ref)).map(dict => {
    const ap = ctx.lookup(dict.get(PDFName.of('AP')));
    const n = ap ? ctx.lookup(ap.get(PDFName.of('N'))) : null;
    const content = n instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(n).decode()) : '';
    const resources = n ? ctx.lookup(n.dict.get(PDFName.of('Resources'))) : null;
    return { dict, content, resources, rect: ctx.lookup(dict.get(PDFName.of('Rect'))).asArray().map(v => v.asNumber()) };
  });
}

async function reopen(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const colors = await extractAnnotationColors(1, await PDFDocument.load(bytes.slice()));
    const models = [];
    for (const annotation of await page.getAnnotations()) {
      const model = await convertPdfAnnotation(annotation, 1, page.getViewport({ scale: 1 }), new Map(), colors);
      if (model) models.push(model);
    }
    return models.filter(m => m.type === 'count');
  } finally {
    await task.destroy();
  }
}

const PAGE = 120;
const SCALE = 3;

async function renderPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0,
    standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = napiCanvas.createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } finally {
    await task.destroy();
  }
}

function renderCanvas(ann, width = PAGE, height = PAGE) {
  const canvas = napiCanvas.createCanvas(width * SCALE, height * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(SCALE, SCALE);
  drawCountSymbolMarker(ctx, ann);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Share of ink pixels (non-white in either image) whose colour differs by more than 96 on a channel. */
function pixelDiff(a, b) {
  let ink = 0, off = 0;
  for (let i = 0; i < a.length; i += 4) {
    const inkA = a[i] < 240 || a[i + 1] < 240 || a[i + 2] < 240;
    const inkB = b[i] < 240 || b[i + 1] < 240 || b[i + 2] < 240;
    if (!inkA && !inkB) continue;
    ink++;
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 96) off++;
  }
  return { ink, off, ratio: ink ? off / ink : 0 };
}

const PIXEL_THRESHOLD = 0.03;
// Symbols with a letter: the canvas font is a Helvetica clone, not Helvetica.
const TEXT_PIXEL_THRESHOLD = helveticaOnCanvas ? 0.12 : 0.3;
const TEXT_SYMBOLS = new Set(['count.switch', 'count.smoke']);

test('every count symbol saves as a vector appearance and reopens with symbol, size and number', async () => {
  const symbols = listCountSymbols();
  assert.ok(symbols.length >= 15, 'the count symbol palette is offered');
  const source = await PDFDocument.create();
  source.addPage([595, 842]);
  const models = symbols.map((symbol, i) => createAnnotation({ type: 'count', page: 1,
    x: 60 + (i % 6) * 80, y: 80 + Math.floor(i / 6) * 90, categoryId: 'fixtures', number: i + 1,
    markerStyle: 'symbol', symbolId: symbol.id, symbolSize: 30, color: '#1d4ed8', opacity: 1 }));
  models[1].showNumber = false;
  const first = await save(await source.save(), models);
  const raw = await rawCounts(first);
  assert.equal(raw.length, symbols.length);
  for (const [i, entry] of raw.entries()) {
    assert.ok(entry.content.length > 40, `${symbols[i].id}: appearance has drawing operators`);
    assert.doesNotMatch(entry.content, /\bDo\b|\bBI\b/u, `${symbols[i].id}: no image or XObject in the appearance`);
    assert.equal(entry.resources?.get(PDFName.of('XObject')), undefined, `${symbols[i].id}: no XObject resource`);
    assert.match(entry.content, /\b(f|f\*|S)\n/u, `${symbols[i].id}: paints vector paths`);
    const cx = (entry.rect[0] + entry.rect[2]) / 2, cy = (entry.rect[1] + entry.rect[3]) / 2;
    assert.ok(Math.abs(cx - models[i].x) < 1e-6 && Math.abs(cy - (842 - models[i].y)) < 1e-6, 'Rect is centred on the count point');
    if (i !== 1) assert.match(entry.content, new RegExp(`\\(${i + 1}\\) Tj`, 'u'), `${symbols[i].id}: number label written`);
  }
  assert.doesNotMatch(raw[1].content, /\(2\) Tj/u, 'a hidden number is not written');

  const reopened = await reopen(first);
  assert.equal(reopened.length, symbols.length);
  for (const [i, model] of reopened.entries()) {
    assert.equal(model.markerStyle, 'symbol');
    assert.equal(model.symbolId, symbols[i].id);
    assert.equal(model.symbolSize, 30);
    assert.equal(model.number, i + 1);
    assert.ok(Math.abs(model.x - models[i].x) < 0.01 && Math.abs(model.y - models[i].y) < 0.01);
  }
  assert.equal(reopened[1].showNumber, false);
  assert.equal(reopened[0].showNumber, undefined);

  const second = await save(first, reopened);
  assert.equal((await rawCounts(second)).length, symbols.length, 'second save keeps one annotation per count');
  const again = await reopen(second);
  assert.deepEqual(again.map(m => [m.symbolId, m.symbolSize, m.number, m.showNumber]),
    reopened.map(m => [m.symbolId, m.symbolSize, m.number, m.showNumber]));
});

test('PDF.js renders each saved count symbol within the pixel-diff threshold of the canvas', { skip: !napiCanvas && '@napi-rs/canvas not installed' }, async () => {
  const results = [];
  for (const symbol of listCountSymbols()) {
    const source = await PDFDocument.create();
    source.addPage([PAGE, PAGE]);
    const ann = { type: 'count', page: 1, x: 60, y: 60, number: 7, showNumber: false,
      markerStyle: 'symbol', symbolId: symbol.id, symbolSize: 64, color: '#c2410c', opacity: 1 };
    const bytes = await save(await source.save(), [createAnnotation({ ...ann })]);
    const diff = pixelDiff(renderCanvas(ann), await renderPdf(bytes));
    results.push(`${symbol.id} ${(diff.ratio * 100).toFixed(2)}%`);
    if (process.env.COUNT_SYMBOL_DIFF) console.log(results.at(-1));
    assert.ok(diff.ink > 500, `${symbol.id}: the marker is visible`);
    assert.ok(diff.ratio < (TEXT_SYMBOLS.has(symbol.id) ? TEXT_PIXEL_THRESHOLD : PIXEL_THRESHOLD), `${symbol.id}: ${diff.off}/${diff.ink} ink pixels differ`);
  }
});

test('the number label renders next to the symbol in the saved PDF', { skip: !napiCanvas && '@napi-rs/canvas not installed' }, async () => {
  const source = await PDFDocument.create();
  source.addPage([PAGE, PAGE]);
  const ann = { type: 'count', page: 1, x: 40, y: 50, number: 28, markerStyle: 'symbol',
    symbolId: 'count.square', symbolSize: 40, color: '#15803d', opacity: 1 };
  const bytes = await save(await source.save(), [createAnnotation({ ...ann })]);
  const pdf = await renderPdf(bytes);
  // Ink to the right of the symbol box (x > 61 pt) comes from the number only.
  let inkRight = 0;
  for (let y = 40 * SCALE; y < 72 * SCALE; y++) {
    for (let x = 62 * SCALE; x < 90 * SCALE; x++) {
      const i = (y * PAGE * SCALE + x) * 4;
      if (pdf[i + 1] < 200) inkRight++;
    }
  }
  assert.ok(inkRight > 60, `number label ink pixels: ${inkRight}`);
  const diff = pixelDiff(renderCanvas(ann), pdf);
  assert.ok(diff.ratio < TEXT_PIXEL_THRESHOLD, `symbol + Helvetica number: ${(diff.ratio * 100).toFixed(2)}%`);
});

test('on a rotated page the saved symbol stays upright as on screen and reopens at its point', { skip: !napiCanvas && '@napi-rs/canvas not installed' }, async () => {
  // A 160 x 100 pt page turned 90 degrees shows as 100 x 160; the count point is in that view.
  const source = await PDFDocument.create();
  source.addPage([160, 100]).setRotation(degrees(90));
  const ann = { type: 'count', page: 1, x: 40, y: 95, number: 5, markerStyle: 'symbol',
    symbolId: 'count.pin', symbolSize: 48, color: '#0f766e', opacity: 1 };
  const bytes = await save(await source.save(), [createAnnotation({ ...ann })]);
  const [model] = await reopen(bytes);
  assert.ok(Math.abs(model.x - 40) < 0.01 && Math.abs(model.y - 95) < 0.01, `reopened at ${model.x}, ${model.y}`);
  const glyphOnly = { ...ann, showNumber: false };
  const glyphBytes = await save(await source.save(), [createAnnotation({ ...glyphOnly })]);
  const diff = pixelDiff(renderCanvas(glyphOnly, 100, 160), await renderPdf(glyphBytes));
  assert.ok(diff.ink > 500);
  assert.ok(diff.ratio < PIXEL_THRESHOLD, `rotated page: ${diff.off}/${diff.ink} ink pixels differ`);
});

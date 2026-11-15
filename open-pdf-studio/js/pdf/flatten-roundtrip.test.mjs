// Flatten / Unflatten on real PDF bytes (docs/reference/editor/markup-tools.md, WP1).
//
// A 3-page drawing with a line, a cloud, a text box, a count and a length
// measurement goes through the real saver; flatten burns them into the page
// content (pdf.js renders before and after are compared pixel by pixel),
// the saved file has no such /Annots left, Unflatten brings the same
// dictionaries back (IDs, values, Markups List columns), a second save does
// not duplicate anything, and without "allow unflatten" no private data
// stays in the file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFDict, PDFStream, PDFArray, PDFString, PDFHexString, rgb, degrees } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
// pdf.js schedules render steps on the window.
if (typeof window !== 'undefined' && !window.requestAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF, savedPdfBytes } = await import('./saver.js');
const { recalculateAllMeasurements } = await import('../annotations/measurement.js');
const { invalidateScaleRegionCache } = await import('../annotations/scale-region.js');
const { markupCsv } = await import('../annotations/markup-csv.js');
const { flattenPdfDocument, unflattenPdfDocument, flattenedPages, FLATTEN_KEY, appearanceTransform } =
  await import('./flatten.js');
const { modelsFromPdf } = await import('./flatten-models.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const SCALE = { pixelsPerUnit: 0.01, unit: 'mm' }; // 1 pt = 100 mm
const COLUMN = 'Trade';
const PAGES = 3;
const MARKUP_SUBTYPES = new Set(['/Line', '/Polygon', '/FreeText', '/Square', '/PolyLine', '/Text', '/Circle']);

function openDocument(annotations) {
  state.documents = [{ id: `flatten-${Math.random()}`, filePath: 'C:/flatten/input.pdf', pdfDoc: {},
    currentPage: 1, annotations, measureScale: SCALE, pageRotations: {},
    _annotationPagesReady: new Set([1, 2, 3]), textEdits: [], markupTextColumnName: COLUMN }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  invalidateScaleRegionCache();
  return state.documents[0];
}

function useBytes(bytes) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_p, data) => { saved = data; return true; },
  } };
  return () => saved;
}

async function save(bytes, annotations) {
  const written = useBytes(bytes);
  openDocument(annotations);
  assert.equal(await savePDF('C:/flatten/output.pdf', { zonderHandtekeningVraag: true }), true);
  assert.ok(written(), 'the saver wrote PDF bytes');
  return written();
}

function buildModels() {
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const dy = page * 7;
    const line = createAnnotation({ type: 'line', page, startX: 60, startY: 80 + dy, endX: 260, endY: 140 + dy,
      color: '#d0021b', strokeColor: '#d0021b', lineWidth: 3 });
    const cloud = createAnnotation({ type: 'cloud', page, x: 300, y: 90 + dy, width: 200, height: 120,
      color: '#1e40af', strokeColor: '#1e40af', lineWidth: 2 });
    const textbox = createAnnotation({ type: 'textbox', page, x: 70, y: 300 + dy, width: 220, height: 60,
      text: `Check beam ${page}`, fontSize: 14, color: '#000000', strokeColor: '#000000', fillColor: '#fff7cc',
      lineWidth: 1 });
    const count = createAnnotation({ type: 'count', page, x: 380, y: 340 + dy, categoryId: 'doors-A',
      number: page, markerStyle: 'dot', color: '#e11d48', opacity: 1 });
    const measure = createAnnotation({ type: 'measureDistance', page, startX: 80, startY: 520 + dy,
      endX: 380, endY: 520 + dy, color: '#047857', strokeColor: '#047857', lineWidth: 2 });
    for (const [i, m] of [line, cloud, textbox, count, measure].entries()) {
      m.markupTextValue = `p${page}-${i}`;
      m.subject = `Subject ${i}`;
      m.author = 'Reviewer';
      out.push(m);
    }
  }
  return out;
}

async function sourceBytes() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([612, 792]);
    // Content that leaves its graphics state changed: flatten must not
    // inherit this cm.
    page.drawRectangle({ x: 40, y: 40, width: 532, height: 712, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 1 });
    page.pushOperators();
  }
  // The last page is rotated: the content is in unrotated page space.
  doc.getPages()[2].setRotation(degrees(90));
  const bytes = await doc.save();
  // Append an unbalanced 'cm' to page 1's content.
  const lib = await PDFDocument.load(bytes);
  const p1 = lib.getPages()[0];
  const dangling = lib.context.register(lib.context.stream('1 0 0 1 15 15 cm 0.5 w\n'));
  const c = lib.context.lookup(p1.node.get(PDFName.of('Contents')));
  p1.node.set(PDFName.of('Contents'), lib.context.obj([...(c instanceof PDFArray ? c.asArray() : [p1.node.get(PDFName.of('Contents'))]), dangling]));
  return lib.save();
}

async function render(bytes, pageNum, annotationMode) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas, annotationMode }).promise;
    return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
  } finally {
    await task.destroy();
  }
}

// Share of pixels that differ by more than `tol` in any channel.
function diffShare(a, b, tol = 16) {
  assert.equal(a.data.length, b.data.length);
  let off = 0;
  let ink = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > tol) off++;
    if (a.data[i] < 200 || a.data[i + 1] < 200 || a.data[i + 2] < 200) ink++;
  }
  return { share: off / (a.data.length / 4), ink };
}

function annotsOf(lib) {
  return lib.getPages().map(page => {
    const arr = lib.context.lookup(page.node.get(PDFName.of('Annots')));
    return arr ? arr.asArray().map(ref => ({ ref, dict: lib.context.lookup(ref) })) : [];
  });
}

const markupAnnots = (lib) => annotsOf(lib).flat()
  .filter(({ dict }) => MARKUP_SUBTYPES.has(dict.get(PDFName.of('Subtype'))?.toString()));

// The Markups List rows. "Created" is stamped at load time (the saver keeps
// no creation date), so it is the one column two reopens never share.
// A save stamps "Modified" anew; `withoutModified` drops that one as well.
const csv = (models, { withoutModified = false } = {}) => markupCsv(models, null, COLUMN).split('\r\n')
  .map(row => row.split('","').filter((_, i) => i !== 7 && !(withoutModified && i === 8)).join('","')).join('\n');

async function flattenBytes(bytes, options) {
  const lib = await PDFDocument.load(bytes);
  const result = flattenPdfDocument(lib, options);
  return { bytes: await lib.save(), result };
}

async function unflattenBytes(bytes) {
  const lib = await PDFDocument.load(bytes);
  const result = unflattenPdfDocument(lib);
  return { bytes: await lib.save(), result };
}

let fixture;
async function savedFixture() {
  if (fixture) return fixture;
  const models = buildModels();
  openDocument(models);
  recalculateAllMeasurements();
  const bytes = await save(await sourceBytes(), models);
  fixture = { bytes, models };
  return fixture;
}

test('appearance transform follows the viewer rule (BBox × Matrix fitted to the Rect)', () => {
  assert.deepEqual(appearanceTransform([10, 20, 110, 70], [0, 0, 100, 50]), [1, 0, 0, 1, 10, 20]);
  assert.deepEqual(appearanceTransform([10, 20, 210, 120], [0, 0, 100, 50]), [2, 0, 0, 2, 10, 20]);
  // An appearance in absolute page coordinates (BBox = Rect).
  assert.deepEqual(appearanceTransform([50, 60, 80, 90], [50, 60, 80, 90]), [1, 0, 0, 1, 0, 0]);
});

test('flatten burns line, cloud, text box, count and measurement into the content; renders match', async () => {
  const { bytes, models } = await savedFixture();
  const before = await PDFDocument.load(bytes);
  const markups = markupAnnots(before);
  assert.equal(markups.length, PAGES * 5, 'the fixture has five markups per page');

  const { bytes: flat, result } = await flattenBytes(bytes, { allowUnflatten: true });
  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
  assert.equal(result.flattened.length, PAGES * 5);

  const after = await PDFDocument.load(flat);
  assert.equal(markupAnnots(after).length, 0, 'no markup annotations remain');
  assert.deepEqual(flattenedPages(after), [1, 2, 3]);

  for (let p = 1; p <= PAGES; p++) {
    const withAnnots = await render(bytes, p, pdfjs.AnnotationMode.ENABLE);
    const contentOnly = await render(bytes, p, pdfjs.AnnotationMode.DISABLE);
    const flattened = await render(flat, p, pdfjs.AnnotationMode.ENABLE);
    const flattenedNoAnnots = await render(flat, p, pdfjs.AnnotationMode.DISABLE);
    // The markups are visible in the fixture at all.
    assert.ok(diffShare(withAnnots, contentOnly).share > 0.005, `page ${p}: markups draw something`);
    const d = diffShare(withAnnots, flattened);
    assert.ok(d.share < 0.0002, `page ${p}: flattened render differs in ${(d.share * 100).toFixed(3)} % of pixels`);
    // And it is the content now, not an annotation.
    assert.ok(diffShare(flattened, flattenedNoAnnots).share < 0.0001, `page ${p}: nothing is left as an annotation`);
  }
});

test('reopen → Unflatten brings the same markups back: dictionaries, IDs, values, columns', async () => {
  const { bytes } = await savedFixture();
  const original = await modelsFromPdf(bytes);
  const { bytes: flat } = await flattenBytes(bytes, { allowUnflatten: true });
  assert.equal((await modelsFromPdf(flat)).length, 0, 'the flattened PDF reopens without markups');

  const { bytes: back, result } = await unflattenBytes(flat);
  assert.equal(result.restored.length, PAGES * 5);
  const lib = await PDFDocument.load(back);
  assert.equal(lib.getPages().some(p => p.node.get(PDFName.of(FLATTEN_KEY))), false, 'the private record is gone');
  const restored = await modelsFromPdf(back);
  assert.equal(restored.length, original.length);
  // Same Markups List rows and custom column values.
  assert.equal(csv(restored), csv(original));
  // Same durable IDs (the line's /OPS_MarkupIdV1) and the same PDF objects
  // (pdf.js annotation ids) for every markup.
  const durable = (ms) => ms.filter(m => m.type === 'line').map(m => m.id).sort();
  assert.equal(durable(original).length, PAGES);
  assert.deepEqual(durable(restored), durable(original));
  const pdfIds = (b) => PDFDocument.load(b).then(d => markupAnnots(d).map(a => a.ref.toString()).sort());
  assert.deepEqual(await pdfIds(back), await pdfIds(bytes));
  // Values: the measurement reads the same.
  const meas = (ms) => ms.filter(m => m.type === 'measureDistance').map(m => m.measureText);
  assert.deepEqual(meas(restored), meas(original));
  // And the page renders as before.
  for (let p = 1; p <= PAGES; p++) {
    const a = await render(bytes, p, pdfjs.AnnotationMode.ENABLE);
    const b = await render(back, p, pdfjs.AnnotationMode.ENABLE);
    assert.ok(diffShare(a, b).share < 0.0001, `page ${p} renders as before after unflatten`);
  }
});

test('saving the flattened and the unflattened document again adds no duplicates', async () => {
  const { bytes } = await savedFixture();
  const { bytes: flat } = await flattenBytes(bytes, { allowUnflatten: true });
  // Save the flattened PDF with its (now empty) markup model: still none,
  // and the record survives the saver.
  const flatSaved = await save(flat, await modelsFromPdf(flat));
  const flatLib = await PDFDocument.load(flatSaved);
  assert.equal(markupAnnots(flatLib).length, 0);
  assert.deepEqual(flattenedPages(flatLib), [1, 2, 3]);
  // A second flatten of the same PDF finds nothing new to do.
  const again = await flattenBytes(flatSaved, { allowUnflatten: true });
  assert.equal(again.result.flattened.length, 0);

  const { bytes: back } = await unflattenBytes(flatSaved);
  const restored = await modelsFromPdf(back);
  const resaved = await save(back, restored);
  const resavedLib = await PDFDocument.load(resaved);
  assert.equal(markupAnnots(resavedLib).length, PAGES * 5, 'each markup exactly once after a save');
  assert.equal(csv(await modelsFromPdf(resaved), { withoutModified: true }),
    csv(await modelsFromPdf(bytes), { withoutModified: true }));
  // Unflatten twice: nothing more comes back.
  const twice = await unflattenBytes(resaved);
  assert.equal(twice.result.restored.length, 0);
  // And flattening the saved result renders like the saved original.
  const { bytes: flat2 } = await flattenBytes(resaved, { allowUnflatten: false });
  for (let p = 1; p <= PAGES; p++) {
    const d = diffShare(await render(resaved, p, pdfjs.AnnotationMode.ENABLE),
      await render(flat2, p, pdfjs.AnnotationMode.ENABLE));
    assert.ok(d.share < 0.001, `page ${p}: ${(d.share * 100).toFixed(3)} %`);
  }
});

test('flatten without "allow unflatten" leaves no private data', async () => {
  const { bytes } = await savedFixture();
  const { bytes: flat, result } = await flattenBytes(bytes, { allowUnflatten: false });
  assert.equal(result.flattened.length, PAGES * 5);
  const lib = await PDFDocument.load(flat);
  assert.deepEqual(flattenedPages(lib), []);
  assert.equal(unflattenPdfDocument(lib).restored.length, 0, 'nothing to unflatten');
  // No annotation dictionary or OcuDraw markup data anywhere in the file,
  // reachable or not. (The document-level column definition stays: it is
  // the list's setup, not a markup.)
  const MARKUP_KEYS = ['/OPS_MarkupTextValue', '/OPS_MarkupIdV1', '/OPS_CountCategory', '/OPS_MeasureExtra',
    '/OPS_Subtype', '/IRT', `/${FLATTEN_KEY}`];
  for (const [, obj] of lib.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    assert.notEqual(dict.get(PDFName.of('Type'))?.toString(), '/Annot', 'an annotation dictionary survived');
    for (const [key, value] of dict.entries()) {
      assert.ok(!MARKUP_KEYS.includes(key.toString()), `private key ${key} survived`);
      const text = value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
      assert.ok(!/^p\d-\d$|^Subject \d$|^Check beam/.test(text), `markup text "${text}" survived`);
    }
  }
  for (let p = 1; p <= PAGES; p++) {
    const d = diffShare(await render(bytes, p, pdfjs.AnnotationMode.ENABLE),
      await render(flat, p, pdfjs.AnnotationMode.ENABLE));
    assert.ok(d.share < 0.001, `page ${p}: ${(d.share * 100).toFixed(3)} %`);
  }
});

test('page range and selection: only the chosen markups go; the rest stay annotations', async () => {
  const { bytes } = await savedFixture();
  const lib = await PDFDocument.load(bytes);
  const lines = new Set(markupAnnots(lib).filter(a => a.dict.get(PDFName.of('Subtype'))?.toString() === '/Line'
    && !a.dict.get(PDFName.of('Measure')) && !a.dict.get(PDFName.of('IT'))).map(a => a.ref.toString()));
  const { result } = (() => {
    const r = flattenPdfDocument(lib, { pages: [2], select: (ref) => lines.has(ref.toString()) });
    return { result: r };
  })();
  assert.ok(result.flattened.length >= 1);
  assert.ok(result.flattened.every(f => f.page === 2));
  const left = annotsOf(lib);
  assert.equal(left[0].length, annotsOf(await PDFDocument.load(bytes))[0].length, 'page 1 untouched');
  assert.equal(left[1].length, annotsOf(await PDFDocument.load(bytes))[1].length - result.removed.length);
});

test('savedPdfBytes reports the ref of every markup it writes and writes no file', async () => {
  const models = buildModels();
  const written = useBytes(await sourceBytes());
  const doc = openDocument(models);
  recalculateAllMeasurements();
  const refs = new Map();
  const out = await savedPdfBytes(doc, refs);
  assert.ok(out instanceof Uint8Array);
  assert.equal(written(), undefined, 'nothing written to disk');
  assert.equal(refs.size, models.length);
  const lib = await PDFDocument.load(out);
  const present = new Set(markupAnnots(lib).map(a => a.ref.toString()));
  // Keyed by the document's own model objects (the store's proxies).
  for (const m of doc.annotations) assert.ok(present.has(refs.get(m)?.toString()), m.type);
});

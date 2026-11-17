// Page scales in the PDF itself: every calibrated page gets a /VP viewport
// with an ISO 32000-1 §12.9 /Measure dictionary, so the external editor/Acrobat and the
// next opening read the scale per page. Real PDF bytes through the real
// saver, reopened with the real /VP reader and measured with the app's
// scale chain.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { degrees, PDFArray, PDFDocument, PDFName, PDFString } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { leesPdfViewports } = await import('./pdf-viewports.js');
const { schaalTekst } = await import('./pagina-schaal-vp.js');
const { decodePdfTextObject } = await import('./saver/pdf-text.js');
const { schaalOpPunt, paginaSchaal } = await import('../annotations/schaal-op-punt.js');
const { applyPageScale, calculateDistance, migrateDocumentScale } = await import('../annotations/measurement.js');
const { ratioPixelsPerUnit } = await import('../annotations/scale-entry.js');
const { legacySchaalSleutel } = await import('../annotations/pagina-schaal.js');
const { invalidateScaleRegionCache } = await import('../annotations/scale-region.js');
const undoManager = await import('../core/undo-manager.js');

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `${msg ?? ''} ${actual} != ${expected}`);

const FT_48 = { pixelsPerUnit: ratioPixelsPerUnit(48, 'ft'), unit: 'ft', method: 'ratio', scaleRatio: '1:48' };
const MM_100 = { pixelsPerUnit: ratioPixelsPerUnit(100, 'mm'), unit: 'mm', method: 'ratio', scaleRatio: '1:100' };

function openDocument(extra = {}) {
  state.documents = [{ id: `page-scale-${Math.random()}`, filePath: 'C:/scale/input.pdf', pdfDoc: { numPages: 2 },
    currentPage: 1, scale: 1, viewMode: 'single', annotations: [], measureScale: null,
    pageRotations: {}, _annotationPagesReady: new Set([1, 2, 3]), textEdits: [],
    undoStack: [], redoStack: [], savedUndoStackLength: 0, ...extra }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  invalidateScaleRegionCache();
  return state.documents[0];
}

async function save(bytes) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_path, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_path, data) => { saved = data; return true; },
  } };
  assert.equal(await savePDF('C:/scale/output.pdf', { zonderHandtekeningVraag: true }), true);
  assert.ok(saved, 'the saver wrote PDF bytes');
  return saved;
}

/** The reopened document as the app sees it: viewports read from the bytes, no in-memory page scales. */
async function reopen(bytes) {
  const lib = await PDFDocument.load(bytes);
  return { lib, doc: { annotations: [], pdfViewports: leesPdfViewports(lib), measureScale: null } };
}

function vpDicts(lib, pageIndex) {
  const arr = lib.getPages()[pageIndex].node.lookup(PDFName.of('VP'));
  if (!(arr instanceof PDFArray)) return [];
  return Array.from({ length: arr.size() }, (_, i) => arr.lookup(i));
}
const ownVps = (lib, pageIndex) => vpDicts(lib, pageIndex)
  .filter(d => d.lookup(PDFName.of('OPS_PageScale'))?.asBoolean?.() === true);

async function twoPagePdf() {
  const src = await PDFDocument.create();
  src.addPage([1224, 792]); // 17 x 11 in sheet
  src.addPage([1191, 842]); // A3 landscape
  return src.save();
}

test('1/4" = 1\'-0" on page 1 and 1:100 mm on page 2 survive save and reopen, without duplicate viewports', async () => {
  const doc = openDocument();
  applyPageScale(FT_48, [1]);
  applyPageScale(MM_100, [2]);
  const first = await save(await twoPagePdf());

  const { lib, doc: reopened } = await reopen(first);
  assert.equal(ownVps(lib, 0).length, 1);
  assert.equal(ownVps(lib, 1).length, 1);
  // Each page measures with its own scale: 36 pt on page 1 is 2 ft, 72 pt on page 2 is 25.4 mm * 100.
  const p1 = schaalOpPunt(reopened, 1, 300, 300);
  assert.equal(p1.unit, 'ft');
  near(36 / p1.pixelsPerUnit, 2, 'page 1');
  const p2 = schaalOpPunt(reopened, 2, 300, 300);
  assert.equal(p2.unit, 'mm');
  near(72 / p2.pixelsPerUnit, 2540, 'page 2');
  assert.equal(paginaSchaal(reopened, 1).method, 'ratio', 'the entry method is restored');

  // The app measurement path on the reopened document.
  openDocument({ pdfViewports: reopened.pdfViewports });
  const d1 = calculateDistance(0, 0, 36, 0, 1);
  assert.equal(d1.unit, 'ft');
  near(d1.value, 2);
  assert.equal(d1.calibrated, true);
  const d2 = calculateDistance(0, 0, 72, 0, 2);
  assert.equal(d2.unit, 'mm');
  near(d2.value, 2540);

  // Second save from the reopened bytes, page scales unchanged in memory: still one each.
  state.documents[0] = doc;
  const second = await save(first);
  const again = await PDFDocument.load(second);
  assert.equal(ownVps(again, 0).length, 1, 'no duplicate on page 1');
  assert.equal(ownVps(again, 1).length, 1, 'no duplicate on page 2');
  // And a reopened document without in-memory scales keeps the file's.
  openDocument({ pdfViewports: reopened.pdfViewports });
  const third = await PDFDocument.load(await save(second));
  assert.equal(ownVps(third, 0).length, 1);
  assert.equal(ownVps(third, 1).length, 1);
});

test('the written /Measure dictionary has the ISO 32000-1 §12.9 structure', async () => {
  openDocument();
  applyPageScale(FT_48, [1]);
  applyPageScale(MM_100, [2]);
  const lib = await PDFDocument.load(await save(await twoPagePdf()));
  const [vp] = ownVps(lib, 0);
  assert.equal(vp.lookup(PDFName.of('Type')).toString(), '/Viewport');
  assert.deepEqual(vp.lookup(PDFName.of('BBox')).asArray().map(n => n.asNumber()), [0, 0, 1224, 792]);
  assert.ok(decodePdfTextObject(vp.lookup(PDFName.of('Name'))));
  const m = vp.lookup(PDFName.of('Measure'));
  assert.equal(m.lookup(PDFName.of('Type')).toString(), '/Measure');
  assert.equal(m.lookup(PDFName.of('Subtype')).toString(), '/RL');
  assert.equal(decodePdfTextObject(m.lookup(PDFName.of('R'))), '1 in = 4 ft');
  const nf = (key) => m.lookup(PDFName.of(key)).lookup(0);
  // 1:48 in ft is 18 pt per foot, so one user unit (1/72 in) is 1/18 ft.
  assert.equal(decodePdfTextObject(nf('X').lookup(PDFName.of('U'))), 'ft');
  near(nf('X').lookup(PDFName.of('C')).asNumber(), 1 / 18, 'X C');
  assert.equal(nf('X').lookup(PDFName.of('F')).toString(), '/D');
  assert.equal(nf('X').lookup(PDFName.of('D')).asNumber(), 100);
  assert.equal(nf('X').lookup(PDFName.of('Type')).toString(), '/NumberFormat');
  // D and A convert from the X unit: factor 1, area in square units.
  assert.equal(nf('D').lookup(PDFName.of('C')).asNumber(), 1);
  assert.equal(decodePdfTextObject(nf('D').lookup(PDFName.of('U'))), 'ft');
  assert.equal(nf('A').lookup(PDFName.of('C')).asNumber(), 1);
  assert.equal(decodePdfTextObject(nf('A').lookup(PDFName.of('U'))), 'sq ft');

  const [vp2] = ownVps(lib, 1);
  const m2 = vp2.lookup(PDFName.of('Measure'));
  assert.equal(decodePdfTextObject(m2.lookup(PDFName.of('R'))), '1 mm = 100 mm');
  // 1:100 mm: one point is 25.4/72 mm on paper, 100x in reality.
  near(m2.lookup(PDFName.of('X')).lookup(0).lookup(PDFName.of('C')).asNumber(), 2540 / 72, 'mm C');

  assert.equal(schaalTekst({ pixelsPerUnit: ratioPixelsPerUnit(100, 'm'), unit: 'm' }), '1 mm = 0.1 m');
  assert.equal(schaalTekst({ pixelsPerUnit: ratioPixelsPerUnit(96, 'ft'), unit: 'ft' }), '1 in = 8 ft');
});

test('a rotated page with a nonzero-origin CropBox keeps its page scale', async () => {
  const src = await PDFDocument.create();
  const page = src.addPage([800, 600]);
  page.setCropBox(100, 50, 600, 500); // [100 50 700 550]
  page.setRotation(degrees(90));
  openDocument({ pdfDoc: { numPages: 1 } });
  applyPageScale(FT_48, 'all');
  const first = await save(await src.save());
  const { lib, doc } = await reopen(first);
  const [vp] = ownVps(lib, 0);
  // BBox is the visible box in default user space: crop origin, no rotation.
  assert.deepEqual(vp.lookup(PDFName.of('BBox')).asArray().map(n => n.asNumber()), [100, 50, 700, 550]);
  near(vp.lookup(PDFName.of('Measure')).lookup(PDFName.of('X')).lookup(0).lookup(PDFName.of('C')).asNumber(), 1 / 18);
  // In app space (rotated 90°: 500 wide, 600 high) the viewport covers the page.
  const [read] = doc.pdfViewports[1];
  assert.deepEqual([read.x, read.y, read.width, read.height], [0, 0, 500, 600]);
  assert.equal(read.paginaSchaal, true);
  const s = schaalOpPunt(doc, 1, 480, 590);
  assert.equal(s.method, 'page');
  near(36 / s.pixelsPerUnit, 2);
  // Second save: the rotation is untouched and still a single page scale.
  openDocument({ pdfDoc: { numPages: 1 }, pdfViewports: doc.pdfViewports });
  const second = await PDFDocument.load(await save(first));
  assert.equal(ownVps(second, 0).length, 1);
  assert.equal(second.getPages()[0].getRotation().angle, 90);
});

test('a foreign CAD viewport survives untouched and still wins inside its BBox', async () => {
  const src = await PDFDocument.create();
  const page = src.addPage([1224, 792]);
  const measure = (c, u, r) => src.context.obj({
    Type: 'Measure', Subtype: 'RL', R: PDFString.of(r),
    X: [src.context.obj({ U: PDFString.of(u), C: c, D: 1 })],
  });
  page.node.set(PDFName.of('VP'), src.context.obj([
    // Full-sheet CAD viewport at 1:1 mm and a detail at 1:50 mm.
    src.context.obj({ Type: 'Viewport', BBox: [0, 0, 1224, 792], Name: PDFString.of('Sheet'), Measure: measure(25.4 / 72, 'mm', '1:1') }),
    src.context.obj({ Type: 'Viewport', BBox: [100, 100, 300, 300], Name: PDFString.of('Detail'), Measure: measure(50 * 25.4 / 72, 'mm', '1:50') }),
  ]));
  const bytes = await src.save();

  // Before any user scale the full-sheet viewport is the page scale.
  const before = await reopen(bytes);
  assert.equal(schaalOpPunt(before.doc, 1, 600, 50).method, 'page');
  near(schaalOpPunt(before.doc, 1, 600, 50).pixelsPerUnit, 72 / 25.4);
  assert.equal(paginaSchaal(before.doc, 1).method, 'pdfPage');

  openDocument({ pdfDoc: { numPages: 1 }, pdfViewports: before.doc.pdfViewports });
  applyPageScale(FT_48, [1]);
  const first = await save(bytes);
  const second = await save(first);
  const lib = await PDFDocument.load(second);
  const dicts = vpDicts(lib, 0);
  assert.equal(dicts.length, 3, 'two foreign viewports + one page scale');
  const foreign = dicts.filter(d => !d.lookup(PDFName.of('OPS_PageScale')));
  assert.deepEqual(foreign.map(d => decodePdfTextObject(d.lookup(PDFName.of('Name')))), ['Sheet', 'Detail']);
  assert.deepEqual(foreign[1].lookup(PDFName.of('BBox')).asArray().map(n => n.asNumber()), [100, 100, 300, 300]);
  near(foreign[1].lookup(PDFName.of('Measure')).lookup(PDFName.of('X')).lookup(0).lookup(PDFName.of('C')).asNumber(), 50 * 25.4 / 72);

  const { doc } = await reopen(second);
  // Inside the detail (app y is from the top: 792 - 200 = 592) the CAD scale wins.
  const inside = schaalOpPunt(doc, 1, 200, 592);
  assert.equal(inside.method, 'pdfViewport');
  assert.equal(inside.unit, 'mm');
  near(inside.pixelsPerUnit, 72 / 25.4 / 50);
  // Elsewhere OcuDraw's page scale beats the foreign full-sheet viewport.
  const outside = schaalOpPunt(doc, 1, 600, 50);
  assert.equal(outside.method, 'page');
  assert.equal(outside.unit, 'ft');
  near(outside.pixelsPerUnit, 18);

  // Clearing the page scale removes only OcuDraw's viewport.
  openDocument({ pdfDoc: { numPages: 1 }, pdfViewports: doc.pdfViewports });
  applyPageScale(null, [1]);
  const cleared = await PDFDocument.load(await save(second));
  assert.deepEqual(vpDicts(cleared, 0).map(d => decodePdfTextObject(d.lookup(PDFName.of('Name')))), ['Sheet', 'Detail']);
});

test('an old localStorage document scale migrates to the pages and is written on save', async () => {
  const legacy = { pixelsPerUnit: ratioPixelsPerUnit(50, 'mm'), unit: 'mm', method: 'ratio', scaleRatio: '1:50' };
  localStorage.setItem(legacySchaalSleutel('C:/scale/input.pdf'), JSON.stringify(legacy));
  // Page 2 already carries a full-page CAD viewport: the file wins there.
  const src = await PDFDocument.create();
  src.addPage([1224, 792]);
  const p2 = src.addPage([1224, 792]);
  p2.node.set(PDFName.of('VP'), src.context.obj([src.context.obj({
    Type: 'Viewport', BBox: [0, 0, 1224, 792],
    Measure: src.context.obj({ Type: 'Measure', Subtype: 'RL', R: PDFString.of('1:20'),
      X: [src.context.obj({ U: PDFString.of('mm'), C: 20 * 25.4 / 72, D: 1 })] }),
  })]));
  const bytes = await src.save();
  const { doc: read } = await reopen(bytes);
  const doc = openDocument({ pdfViewports: read.pdfViewports, measureScale: legacy });
  migrateDocumentScale(doc, 2);
  assert.equal(doc.pageScales[1].method, 'legacy');
  near(doc.pageScales[1].pixelsPerUnit, legacy.pixelsPerUnit);
  assert.equal(Object.prototype.hasOwnProperty.call(doc.pageScales, 2), false, 'the CAD page keeps its own scale');
  assert.equal(doc.measureScale, null, 'the document-wide legacy scale is folded into the pages');
  near(calculateDistance(0, 0, 72, 0, 1).value, 25.4 * 50);
  near(calculateDistance(0, 0, 72, 0, 2).value, 25.4 * 20);

  const saved = await PDFDocument.load(await save(bytes));
  assert.equal(ownVps(saved, 0).length, 1, 'first save writes the migrated scale');
  assert.equal(decodePdfTextObject(ownVps(saved, 0)[0].lookup(PDFName.of('OPS_Method'))), 'legacy');
  assert.equal(ownVps(saved, 1).length, 0);
  assert.equal(localStorage.getItem(legacySchaalSleutel('C:/scale/input.pdf')), null, 'the old key is dropped after save');

  // Unreadable PDF (no page count): the old scale stays document-wide.
  localStorage.setItem(legacySchaalSleutel('C:/scale/input.pdf'), JSON.stringify(legacy));
  const fallback = openDocument();
  migrateDocumentScale(fallback, 0);
  assert.deepEqual(fallback.measureScale, legacy);
  assert.equal(fallback.pageScales, undefined);
  localStorage.removeItem(legacySchaalSleutel('C:/scale/input.pdf'));
});

test('undo restores the per-page scale map and the measurements', async () => {
  const doc = openDocument({ annotations: [
    { id: 'd1', type: 'measureDistance', page: 1, startX: 0, startY: 0, endX: 36, endY: 0 },
    { id: 'd2', type: 'measureDistance', page: 2, startX: 0, startY: 0, endX: 36, endY: 0 },
  ] });
  applyPageScale(FT_48, [1]);
  assert.deepEqual(Object.keys(doc.pageScales), ['1']);
  near(doc.annotations[0].measureValue, 2);
  assert.equal(doc.annotations[1].measureUnit, 'pt', 'page 2 stays uncalibrated');
  applyPageScale(MM_100, 'all');
  assert.equal(doc.pageScales[1].unit, 'mm');
  assert.equal(doc.pageScales[2].unit, 'mm');
  near(doc.annotations[1].measureValue, 36 / MM_100.pixelsPerUnit);
  await undoManager.undo();
  assert.deepEqual(Object.keys(doc.pageScales), ['1']);
  assert.equal(doc.pageScales[1].unit, 'ft');
  near(doc.annotations[0].measureValue, 2);
  assert.equal(doc.annotations[1].measureUnit, 'pt');
  await undoManager.undo();
  assert.equal(doc.pageScales, null);
  await undoManager.redo();
  assert.equal(doc.pageScales[1].unit, 'ft');
});

test('save, Undo, save: the file returns to the calibration before the change', async () => {
  // 1:48 ft saved into the PDF; the page has no entry of its own after reopening.
  openDocument();
  applyPageScale(FT_48, [1]);
  const ftBytes = await save(await twoPagePdf());
  const doc = openDocument({ pdfViewports: (await reopen(ftBytes)).doc.pdfViewports, selectedAnnotations: [] });
  assert.equal(doc.pageScales, undefined);

  // Without a save in between, Undo leaves the page following the PDF again.
  applyPageScale(MM_100, [1]);
  await undoManager.undo();
  assert.equal(doc.pageScales, null);
  assert.equal(paginaSchaal(doc, 1).unit, 'ft');

  // 1:100 mm is saved into the file; Undo and save again must put 1:48 ft back.
  applyPageScale(MM_100, [1]);
  const mmBytes = await save(ftBytes);
  await undoManager.undo();
  assert.equal(paginaSchaal(doc, 1).unit, 'ft');
  const again = await reopen(await save(mmBytes));
  const restored = paginaSchaal(again.doc, 1);
  assert.equal(restored.unit, 'ft');
  near(restored.pixelsPerUnit, FT_48.pixelsPerUnit);
  assert.equal(paginaSchaal(again.doc, 2), null, 'page 2 is untouched');
});

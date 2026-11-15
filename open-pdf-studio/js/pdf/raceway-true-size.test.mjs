// Size check for raceway runs: a cable tray is drawn at its entered width and
// a true-size conduit at its outside diameter, both converted through the
// page scale — on screen (drawRaceway on a recording canvas) and in the
// saved PDF (the rails in the /AP stream, and the scale read back from the
// /VP the saver writes). Scales: 1/4" = 1'-0", 1/8" = 1'-0", 1" = 20' and a
// plain 1:60 ratio in inches; plain and /Rotate 90 (offset CropBox) sheets.
// Example: a 24" tray at 1/4" = 1'-0" is 2 ft × 18 pt/ft = 36 pt wide.
//
// Conduit outside diameters: EMT 1/2" (0.706 in) is checked against
// published tables; 2" (2.197 in) and 4" (4.500 in) are nominal
// (docs/reference/editor/raceways.md). The test checks the drawing against the table, not the
// table itself.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { degrees, PDFDocument, PDFName } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { convertPdfAnnotation } = await import('./loader/annotation-converter.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { leesPdfViewports } = await import('./pdf-viewports.js');
const { invalidateScaleRegionCache } = await import('../annotations/scale-region.js');
const { recalculateAllMeasurements } = await import('../annotations/measurement.js');
const { ratioPixelsPerUnit } = await import('../annotations/scale-entry.js');
const { measureKindType, MEASURE_EXTRA_KEY } = await import('../annotations/measure-extras.js');
const { createRacewayAnnotation } = await import('../tools/raceway/raceway-creator.js');
const { racewayDrawing, conduitOD, SCHEMATIC_PX_PER_IN } = await import('../annotations/raceway.js');
const { drawRaceway } = await import('../annotations/rendering/raceway-draw.js');

// The saver writes coordinates to 0.001 pt.
const TOL = 0.003;
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b}`);

const SCALES = [
  { name: '1/4" = 1\'-0"', scale: { pixelsPerUnit: ratioPixelsPerUnit(48, 'ft'), unit: 'ft', method: 'ratio', scaleRatio: '1:48' }, ptPerIn: 1.5 },
  { name: '1/8" = 1\'-0"', scale: { pixelsPerUnit: ratioPixelsPerUnit(96, 'ft'), unit: 'ft', method: 'ratio', scaleRatio: '1:96' }, ptPerIn: 0.75 },
  { name: '1" = 20\'', scale: { pixelsPerUnit: ratioPixelsPerUnit(240, 'ft'), unit: 'ft', method: 'ratio', scaleRatio: '1:240' }, ptPerIn: 0.3 },
  { name: '1:60 (inches)', scale: { pixelsPerUnit: ratioPixelsPerUnit(60, 'in'), unit: 'in', method: 'ratio', scaleRatio: '1:60' }, ptPerIn: 1.2 },
];

const SHEETS = [
  ['a plain sheet', (p) => p],
  ['a /Rotate 90 sheet with an offset CropBox', (p) => { p.setCropBox(20, 30, 1180, 760); p.setRotation(degrees(90)); return p; }],
];

// Runs: a long straight leg, a 90° elbow, a second leg. Sizes per kind.
const RUNS = [
  { label: '12" ladder tray', rw: { kind: 'tray', trayStyle: 'ladder', widthIn: 12, railIn: 4 }, sizeIn: 12 },
  { label: '24" ladder tray', rw: { kind: 'tray', trayStyle: 'ladder', widthIn: 24, railIn: 4 }, sizeIn: 24 },
  { label: '36" ladder tray', rw: { kind: 'tray', trayStyle: 'ladder', widthIn: 36, railIn: 6 }, sizeIn: 36 },
  { label: '18" basket tray', rw: { kind: 'tray', trayStyle: 'basket', widthIn: 18, railIn: 2 }, sizeIn: 18 },
  { label: '1/2" EMT true size', rw: { kind: 'conduit', conduitType: 'EMT', tradeSize: '1/2', trueSize: true }, sizeIn: 0.706 },
  { label: '2" EMT true size', rw: { kind: 'conduit', conduitType: 'EMT', tradeSize: '2', trueSize: true }, sizeIn: 2.197 },
  { label: '4" EMT true size', rw: { kind: 'conduit', conduitType: 'EMT', tradeSize: '4', trueSize: true }, sizeIn: 4.5 },
];
const runPoints = (i) => [{ x: 60, y: 80 + i * 90 }, { x: 560, y: 80 + i * 90 }, { x: 560, y: 80 + i * 90 + 70 }];

function openDocument(pageScales, annotations = [], extra = {}) {
  state.documents = [{ id: `rw-size-${Math.random()}`, filePath: 'C:/rw/input.pdf', pdfDoc: { numPages: 1 },
    currentPage: 1, scale: 1, viewMode: 'single', annotations, measureScale: null, pageScales,
    pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [],
    undoStack: [], redoStack: [], savedUndoStackLength: 0, ...extra }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  invalidateScaleRegionCache();
  return state.documents[0];
}

async function save(bytes, doc) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_p, data) => { saved = data; return true; },
  } };
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  assert.equal(await savePDF('C:/rw/output.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

// ── Measuring the drawn width ──

function distToPolyline(p, path) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return best;
}

// Rail spacing of a run: from the first rail's start, the middle of its
// first leg and its end, to the other rail. All three equal the band width.
function railSpacing([a, b]) {
  const mid = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
  return [a[0], mid, a[a.length - 1]].map((p) => distToPolyline(p, b));
}

/** A canvas that records the stroked polylines and their line width. */
function recordingCanvas() {
  const strokes = [];
  let cur = [];
  const ctx = {
    strokes, lineWidth: 1, font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineJoin: '', lineCap: '',
    save() {}, restore() {}, setLineDash() {}, translate() {}, rotate() {}, fillRect() {}, fillText() {},
    measureText: (s) => ({ width: String(s).length * 5 }),
    beginPath() { cur = []; },
    moveTo(x, y) { cur.push([{ x, y }]); },
    lineTo(x, y) { cur[cur.length - 1].push({ x, y }); },
    stroke() { for (const p of cur) strokes.push({ path: p, lineWidth: ctx.lineWidth }); },
  };
  return ctx;
}

// The polylines of an /AP stream ('x y m', 'x y l', 'S'), in order.
function apPolylines(content) {
  const out = [];
  let cur = null;
  for (const line of content.split('\n')) {
    const m = line.match(/^(-?[\d.]+) (-?[\d.]+) ([ml])$/);
    if (m) {
      const p = { x: Number(m[1]), y: Number(m[2]) };
      if (m[3] === 'm') { cur = [p]; out.push(cur); } else cur.push(p);
    }
  }
  return out;
}

function runAppearances(saved) {
  return PDFDocument.load(saved).then((doc) => {
    const annots = doc.context.lookup(doc.getPages()[0].node.get(PDFName.of('Annots'))).asArray()
      .map((r) => doc.context.lookup(r)).filter((d) => d.get(PDFName.of(MEASURE_EXTRA_KEY)));
    return annots.map((d) => {
      const extra = JSON.parse(d.lookup(PDFName.of(MEASURE_EXTRA_KEY)).decodeText());
      const ap = doc.context.lookup(doc.context.lookup(d.get(PDFName.of('AP'))).get(PDFName.of('N')));
      const matrix = ap.dict.lookup(PDFName.of('Matrix')).asArray().map((n) => n.asNumber());
      return { extra, matrix, polylines: apPolylines(Buffer.from(ap.getContents()).toString('latin1')) };
    });
  });
}

async function reopenRuns(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const colors = await extractAnnotationColors(1, await PDFDocument.load(bytes.slice()));
    const models = [];
    for (const a of await page.getAnnotations()) {
      const m = await convertPdfAnnotation(a, 1, page.getViewport({ scale: 1 }), new Map(), colors);
      if (m && measureKindType(m) === 'measureRaceway') models.push(m);
    }
    return models;
  } finally {
    await task.destroy();
  }
}

const findRun = (runs, rw) => runs.find((r) => r.raceway.kind === rw.kind
  && (rw.kind === 'tray' ? r.raceway.widthIn === rw.widthIn && r.raceway.trayStyle === rw.trayStyle
    : r.raceway.tradeSize === rw.tradeSize));

test('the conduit outside diameters used here are the table values', () => {
  near(conduitOD({ conduitType: 'EMT', tradeSize: '1/2' }), 0.706, 1e-9, 'EMT 1/2"');
  near(conduitOD({ conduitType: 'EMT', tradeSize: '2' }), 2.197, 1e-9, 'EMT 2" (nominal)');
  near(conduitOD({ conduitType: 'EMT', tradeSize: '4' }), 4.5, 1e-9, 'EMT 4" (nominal)');
});

test('a 24" tray at 1/4" = 1\'-0" is 36 pt wide (2 ft × 18 pt/ft)', () => {
  openDocument({ 1: SCALES[0].scale });
  const run = createRacewayAnnotation(runPoints(0), { kind: 'tray', trayStyle: 'ladder', widthIn: 24 }, 1);
  near(run.measurePxPerIn, 1.5, 1e-12, 'pt per inch');
  const d = racewayDrawing(run.points, run.raceway, run.measurePxPerIn);
  near(d.widthPx, 36, 1e-9, 'band width');
  for (const s of railSpacing(d.lines.slice(-2))) near(s, 36, 1e-9, 'rail spacing');
});

for (const { name, scale, ptPerIn } of SCALES) {
  for (const [sheet, setup] of SHEETS) {
    test(`drawn widths equal the entered sizes at ${name} on ${sheet}: screen, saved appearance and reopened`, async () => {
      const source = await PDFDocument.create();
      setup(source.addPage([1224, 792]));
      const bytes = await source.save();
      const doc = openDocument({ 1: scale });
      const runs = RUNS.map((r, i) => createRacewayAnnotation(runPoints(i), r.rw, 1));
      doc.annotations.push(...runs);

      // On screen: drawRaceway strokes two rails (tray) or two walls
      // (true-size conduit) at the converted size.
      for (const [i, r] of RUNS.entries()) {
        const run = runs[i];
        const expected = r.sizeIn * ptPerIn;
        near(run.measurePxPerIn, ptPerIn, 1e-12, `${r.label}: pt per inch`);
        const ctx = recordingCanvas();
        drawRaceway(ctx, run, '#000000', 1);
        const main = ctx.strokes.filter((s) => s.lineWidth === 1).map((s) => s.path);
        assert.equal(main.length, 2, `${r.label}: two main lines on screen`);
        for (const s of railSpacing(main)) near(s, expected, 1e-9, `${r.label} on screen`);
        if (r.rw.kind === 'tray') {
          // Rungs / cross wires span the band from rail to rail.
          const rungs = ctx.strokes.filter((s) => s.lineWidth !== 1 && s.path.length === 2);
          assert.ok(rungs.length > 10, `${r.label}: rungs drawn`);
          near(Math.hypot(rungs[2].path[1].x - rungs[2].path[0].x, rungs[2].path[1].y - rungs[2].path[0].y),
            expected, 1e-9, `${r.label}: rung length`);
        }
      }

      // Saved: the /AP strokes the same rails; the rail spacing in PDF space
      // is the converted size (the /AP /Matrix only translates).
      const saved = await save(bytes, doc);
      const aps = await runAppearances(saved);
      assert.equal(aps.length, RUNS.length);
      for (const r of RUNS) {
        const ap = aps.find((a) => (r.rw.kind === 'tray' ? a.extra.rw.widthIn === r.rw.widthIn && a.extra.rw.trayStyle === r.rw.trayStyle
          : a.extra.rw.kind === 'conduit' && a.extra.rw.tradeSize === r.rw.tradeSize));
        assert.ok(ap, `${r.label}: appearance`);
        assert.deepEqual(ap.matrix.slice(0, 4), [1, 0, 0, 1], `${r.label}: no scaling in the /AP matrix`);
        near(ap.extra.out.ppi, ptPerIn, 1e-9, `${r.label}: stored pt per inch`);
        for (const s of railSpacing(ap.polylines.slice(0, 2))) near(s, r.sizeIn * ptPerIn, TOL, `${r.label} in the saved /AP`);
      }

      // Reopened: the scale comes back from the saved /VP (no page scales in
      // memory), and the recomputed drawing has the same width.
      const back = await reopenRuns(saved);
      assert.equal(back.length, RUNS.length);
      openDocument(undefined, back, { pdfViewports: leesPdfViewports(await PDFDocument.load(saved)) });
      recalculateAllMeasurements();
      for (const r of RUNS) {
        const run = findRun(back, r.rw);
        assert.ok(run, `${r.label}: reopened`);
        near(run.measurePxPerIn, ptPerIn, 1e-6, `${r.label}: pt per inch from the saved /VP`);
        const d = racewayDrawing(run.points, run.raceway, run.measurePxPerIn);
        for (const s of railSpacing(d.lines.slice(-2))) near(s, r.sizeIn * ptPerIn, 1e-5, `${r.label} after reopening`);
      }
    });
  }
}

test('without a scale a tray is drawn as schematic tray at 1/8" = 1\'-0", on screen and in the saved /AP', async () => {
  const source = await PDFDocument.create();
  source.addPage([1224, 792]);
  const doc = openDocument(undefined);
  const tray = createRacewayAnnotation(runPoints(0), { kind: 'tray', trayStyle: 'ladder', widthIn: 24 }, 1);
  const conduit = createRacewayAnnotation(runPoints(1), { kind: 'conduit', tradeSize: '2', trueSize: true }, 1);
  doc.annotations.push(tray, conduit);
  assert.equal(tray.measurePxPerIn, undefined, 'no scale stored');
  assert.match(tray.measureText, /^Scale not set · /u);
  const ctx = recordingCanvas();
  drawRaceway(ctx, tray, '#000000', 1);
  const main = ctx.strokes.filter((s) => s.lineWidth === 1).map((s) => s.path);
  assert.equal(main.length, 2, 'two rails, not one line');
  for (const s of railSpacing(main)) near(s, 24 * SCHEMATIC_PX_PER_IN, 1e-9, 'schematic width');
  assert.ok(ctx.strokes.length > 20, 'with rungs');
  const cctx = recordingCanvas();
  drawRaceway(cctx, conduit, '#000000', 1);
  assert.equal(cctx.strokes.filter((s) => s.lineWidth === 1).length, 1, 'conduit stays a centre line');
  const aps = await runAppearances(await save(await source.save(), doc));
  const ap = aps.find((a) => a.extra.rw.kind === 'tray');
  for (const s of railSpacing(ap.polylines.slice(0, 2))) near(s, 18, TOL, 'schematic width in the /AP');
});

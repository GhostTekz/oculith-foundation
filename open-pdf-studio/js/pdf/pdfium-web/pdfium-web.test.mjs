import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfiumMatrix, extraRotatie, pasToe } from './pdfium-matrix.js';
import { pdfiumWebToegestaan, pdfiumWebRasterizer, _zetModuleKapot } from './pdfium-web-rasterizer.js';

// A 3024 x 2160 pt sheet (42" x 30").
const W = 3024, H = 2160;

test('matrix without extra rotation: page points to bitmap pixels of a viewport region', () => {
  // 400 % on a dpr-2 screen, region starting at CSS (5000, 3000).
  const m = pdfiumMatrix({ W, H, rotatie: 0, schaal: 4, k: 2, minX: 5000, minY: 3000 });
  assert.deepEqual(pasToe(m, 1250, 750), [0, 0], 'region corner = bitmap origin');
  assert.deepEqual(pasToe(m, 1251, 750), [8, 0], 'one point = schaal x k pixels');
  // Whole page at the capped base ratio: the page fills the bitmap.
  const b = pdfiumMatrix({ W, H, schaal: 1.5, k: 4096 / (W * 1.5) });
  const [x, y] = pasToe(b, W, H);
  assert.ok(Math.abs(x - 4096) < 1e-6 && Math.abs(y - 4096 * H / W) < 1e-6);
});

test('matrix with an extra clockwise rotation keeps the page inside the rotated viewport (like PDF.js)', () => {
  for (const rot of [90, 180, 270]) {
    const m = pdfiumMatrix({ W, H, rotatie: rot, schaal: 1, k: 1 });
    const vw = rot === 180 ? W : H, vh = rot === 180 ? H : W;
    for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      const [x, y] = pasToe(m, px, py);
      assert.ok(x >= -1e-9 && x <= vw + 1e-9 && y >= -1e-9 && y <= vh + 1e-9, `${rot}: (${px},${py}) -> (${x},${y})`);
    }
  }
  // 90 degrees clockwise: the top-left corner of the page goes to the top-right.
  assert.deepEqual(pasToe(pdfiumMatrix({ W, H, rotatie: 90, schaal: 1, k: 1 }), 0, 0), [H, 0]);
  assert.deepEqual(pasToe(pdfiumMatrix({ W, H, rotatie: 270, schaal: 1, k: 1 }), 0, 0), [0, W]);
  assert.equal(extraRotatie(90, 90), 0, '/Rotate is already in the PDFium page space');
  assert.equal(extraRotatie(0, 90), 270);
  assert.equal(extraRotatie(180, 0), 180);
});

test('PDFium draws in the browser only when it can match the file; otherwise PDF.js', () => {
  const ja = { inTauri: false, voorkeur: true, heeftBytes: true, ocgAfwijkend: false, moduleKapot: false, docKapot: false };
  assert.equal(pdfiumWebToegestaan(ja), true);
  assert.equal(pdfiumWebToegestaan({ ...ja, voorkeur: undefined }), true, 'default on');
  assert.equal(pdfiumWebToegestaan({ ...ja, inTauri: true }), false, 'desktop: native PDFium');
  assert.equal(pdfiumWebToegestaan({ ...ja, voorkeur: false }), false, 'preference off');
  assert.equal(pdfiumWebToegestaan({ ...ja, heeftBytes: false }), false, 'blank document without bytes');
  assert.equal(pdfiumWebToegestaan({ ...ja, ocgAfwijkend: true }), false, 'user layer choice: PDF.js knows it');
  assert.equal(pdfiumWebToegestaan({ ...ja, moduleKapot: true }), false, 'wasm failed to load');
  assert.equal(pdfiumWebToegestaan({ ...ja, docKapot: true }), false, 'PDFium could not open this file');
  const args = { bytes: new Uint8Array([1, 2, 3]), inTauri: false, voorkeur: true, ocgAfwijkend: false, toonNms: () => null };
  assert.ok(pdfiumWebRasterizer(args), 'a rasterizer object');
  assert.equal(pdfiumWebRasterizer({ ...args, bytes: null }), null);
  _zetModuleKapot(true);
  try {
    assert.equal(pdfiumWebRasterizer(args), null);
  } finally {
    _zetModuleKapot(false);
  }
});

test('the base render uses the rasterizer first and PDF.js only when it returns nothing', async () => {
  const { renderPdfJsPageToCanvas } = await import('../pdfjs-canvas-render.js');
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ setTransform() {}, fillRect() {} }) }) };
  try {
    let pdfjs = 0;
    const page = { render: () => { pdfjs++; return { promise: Promise.resolve() }; } };
    const getekend = [];
    const canvas = { width: 1, height: 1, style: {}, getContext: () => ({ drawImage: (c) => getekend.push(c) }) };
    const bron = { width: 400, height: 200, marker: 'pdfium' };
    let gevraagd = null;
    const rasterizer = { naam: 'pdfium', renderPagina: async (o) => { gevraagd = o; return bron; } };
    await renderPdfJsPageToCanvas({ page, viewport: { width: 200, height: 100 }, canvas, dpr: 2, rasterizer, renderParams: { annotationMode: 1 } });
    assert.equal(pdfjs, 0, 'PDF.js not used');
    assert.equal(getekend[0], bron);
    assert.deepEqual([gevraagd.k, gevraagd.breedte, gevraagd.hoogte, gevraagd.renderParams.annotationMode], [2, 400, 200, 1]);
    await renderPdfJsPageToCanvas({ page, viewport: { width: 200, height: 100 }, canvas, dpr: 2,
      rasterizer: { renderPagina: async () => null } });
    assert.equal(pdfjs, 1, 'fallback to PDF.js');
  } finally {
    globalThis.document = oldDocument;
  }
});

test('the detail layer asks the rasterizer for the visible area first, PDF.js only as fallback', async () => {
  const { PdfJsDetailLayer } = await import('../pdfjs-detail-layer.js');
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, style: {}, dataset: {}, setAttribute() {},
    getContext: () => ({ fillRect() {}, drawImage() {}, setTransform() {} }) }) };
  try {
    let pdfjs = 0;
    const page = { render: () => { pdfjs++; return { promise: Promise.resolve(), cancel() {} }; } };
    const getekend = [];
    const zicht = { style: {}, dataset: {}, width: 0, height: 0, getContext: () => ({ drawImage: (c) => getekend.push(c) }) };
    const parent = { querySelector: () => zicht };
    zicht.parentElement = parent;
    const base = { parentElement: parent, offsetLeft: 0, offsetTop: 0, style: { width: '24192px' },
      getBoundingClientRect: () => ({ left: -4000, top: -3000, width: 24192, height: 17280 }) };
    const container = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 600 }) };
    const laag = new PdfJsDetailLayer({ getBaseCanvas: () => base, getContainer: () => container });
    const vanPdfium = { marker: 'pdfium' };
    let vraag = null;
    const rasterizer = { naam: 'pdfium', renderUitsnede: async (o) => { vraag = o; return vanPdfium; } };
    laag.zetPagina({ page, viewport: { width: 24192, height: 17280, rotation: 0 }, viewportVoor: () => ({}),
      dpr: 2, baseRatio: 4096 / 24192, sleutel: 'k', rasterizer, renderParams: { annotationMode: 1 } });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(pdfjs, 0, 'PDF.js not used');
    assert.equal(getekend[0], vanPdfium);
    assert.equal(zicht.dataset.engine, 'pdfium');
    assert.equal(vraag.dpr, 2);
    assert.equal(vraag.breedte, Math.round(vraag.uitsnede.width * 2));
    assert.equal(vraag.renderParams.annotationMode, 1, 'same markup rule as the base render');
  } finally {
    globalThis.document = oldDocument;
  }
});

test('UserUnit1 retains the historical matrix coefficients exactly', () => {
  const cases = [
    [0, [2.5, 0, 0, 2.5, -26, -14]],
    [90, [0, 2.5, -2.5, 0, 774, -14]],
    [180, [-2.5, 0, 0, -2.5, 374, 786]],
    [270, [0, -2.5, 2.5, 0, -26, 386]],
  ];
  for (const [rotatie, expected] of cases) {
    const args = { W: 160, H: 320, rotatie, schaal: 1.25, k: 2, minX: 13, minY: 7 };
    assert.deepEqual(pdfiumMatrix(args), expected);
    assert.deepEqual(pdfiumMatrix({ ...args, userUnit: 1 }), expected);
  }
});

test('cropped intrinsic rotation and UserUnit2 agree with hand-authored page markers', () => {
  // CropBox [-20,0,140,80], intrinsic /Rotate90: PDFium display point is
  // [rawY, rawX+20]. The scale-one PDF.js frame includes UserUnit2 already.
  const matrix = pdfiumMatrix({ W: 160, H: 320, schaal: 1, k: 1, userUnit: 2,
    rotatie: extraRotatie(90, 90) });
  assert.deepEqual(matrix, [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(pasToe(matrix, 10, 10), [20, 20], 'black marker after crop and intrinsic rotation');
  assert.deepEqual(pasToe(matrix, 60, 130), [120, 260], 'far blue marker');
  assert.deepEqual(pasToe(matrix, -10, -10), [-20, -20], 'outside-crop source stays outside');
  assert.deepEqual(pasToe(matrix, 80, 160), [160, 320], 'raw frame fills effective bitmap');
});

test('UserUnit2 extra rotations use effective translation once', () => {
  const cases = [
    [90, [300, 20], [60, 120]],
    [180, [140, 300], [40, 60]],
    [270, [20, 140], [260, 40]],
  ];
  for (const [rotatie, black, blue] of cases) {
    const matrix = pdfiumMatrix({ W: 160, H: 320, rotatie, schaal: 1, k: 1, userUnit: 2 });
    assert.deepEqual(pasToe(matrix, 10, 10), black);
    assert.deepEqual(pasToe(matrix, 60, 130), blue);
  }
});

test('UserUnit2 regions retain CSS crop offsets and device-pixel density', () => {
  const matrix = pdfiumMatrix({ W: 160, H: 320, schaal: 1.5, k: 2, userUnit: 2, minX: 30, minY: 30 });
  assert.deepEqual(matrix, [6, 0, 0, 6, -60, -60]);
  assert.deepEqual(pasToe(matrix, 10, 10), [0, 0], 'effective crop corner');
  assert.deepEqual(pasToe(matrix, 11, 10), [6, 0], 'one raw unit is two effective points');
  const rotated = pdfiumMatrix({ W: 160, H: 320, rotatie: 90, schaal: 1.5, k: 2,
    userUnit: 2, minX: 450, minY: 30 });
  assert.deepEqual(pasToe(rotated, 10, 10), [0, 0], 'rotated CSS crop corner');
  assert.deepEqual(pasToe(rotated, 10, 11), [-6, 0], 'rotated local scale');
});

test('fractional UserUnit works without changing effective frame translations', () => {
  const matrix = pdfiumMatrix({ W: 40, H: 80, rotatie: 90, schaal: 1, k: 2, userUnit: 0.5 });
  assert.deepEqual(pasToe(matrix, 0, 0), [160, 0]);
  assert.deepEqual(pasToe(matrix, 80, 160), [0, 80]);
});

test('invalid UserUnit and unrepresentable new scale cannot reach a PDFium matrix', () => {
  for (const userUnit of [null, '2', 0, -1, NaN, Infinity]) {
    assert.throws(() => pdfiumMatrix({ W: 160, H: 320, schaal: 1, k: 1, userUnit }), /UserUnit/);
  }
  for (const userUnit of [1e308, Number.MIN_VALUE]) {
    assert.throws(() => pdfiumMatrix({ W: 160, H: 320, schaal: 2, k: 2, userUnit }), /represented/);
  }
});

test('actual web rasterizer supplies page UserUnit to full and region worker requests', async () => {
  // Worker transport and canvas I/O are controlled; the actual rasterizer and
  // matrix helpers execute. This is not a WebAssembly or rendered-pixel test.
  const saved = { Worker: globalThis.Worker, document: globalThis.document, ImageData: globalThis.ImageData };
  const calls = [];
  globalThis.Worker = class {
    postMessage(message) {
      calls.push(message);
      const answer = message.type === 'render'
        ? { width: message.width, height: message.height, rgba: new Uint8Array(message.width * message.height * 4).buffer, ms: 0 }
        : {};
      queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, ...answer } }));
    }
  };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }) }) };
  try {
    const { pdfiumWebRasterizer: create } = await import(`./pdfium-web-rasterizer.js?unit-requests`);
    const rasterizer = create({ bytes: new Uint8Array([1, 2, 3]), inTauri: false, ocgAfwijkend: false, toonNms: () => null });
    const page = { pageNumber: 5, rotate: 90, userUnit: 2,
      getViewport: (args) => { assert.deepEqual(args, { scale: 1, rotation: 90 }); return { width: 160, height: 320 }; } };
    const viewport = { scale: 1, rotation: 90 };
    const full = await rasterizer.renderPagina({ page, viewport, k: 1, breedte: 160, hoogte: 320 });
    assert.deepEqual([full.width, full.height], [160, 320]);
    assert.deepEqual(calls.filter(c => c.type === 'render').at(-1).matrix, [2, 0, 0, 2, 0, 0]);
    const region = await rasterizer.renderUitsnede({ page, viewport, dpr: 1, breedte: 20, hoogte: 40,
      uitsnede: { minX: 30, minY: 30 } });
    assert.deepEqual([region.width, region.height], [20, 40]);
    const request = calls.filter(c => c.type === 'render').at(-1);
    assert.equal(request.pageIndex, 4);
    assert.deepEqual(request.matrix, [2, 0, 0, 2, -30, -30]);
    await rasterizer.renderPagina({ page, viewport: { scale: 1, rotation: 180 }, k: 1, breedte: 320, hoogte: 160 });
    assert.deepEqual(calls.filter(c => c.type === 'render').at(-1).matrix, [0, 2, -2, 0, 320, 0]);
    const defaultPage = { ...page, pageNumber: 1, rotate: 0, userUnit: 1,
      getViewport: () => ({ width: 200, height: 160 }) };
    await rasterizer.renderPagina({ page: defaultPage, viewport: { scale: 1, rotation: 0 }, k: 1, breedte: 200, hoogte: 160 });
    assert.deepEqual(calls.filter(c => c.type === 'render').at(-1).matrix, [1, 0, 0, 1, 0, 0]);
    assert.equal(calls.filter(c => c.type === 'open').length, 1, 'existing document reuse remains');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('actual web rasterizer leaves missing or invalid page units to PDF.js without worker I/O', async () => {
  const saved = globalThis.Worker;
  let workerCalls = 0;
  globalThis.Worker = class { constructor() { workerCalls++; throw new Error('unexpected worker'); } };
  try {
    const { pdfiumWebRasterizer: create } = await import(`./pdfium-web-rasterizer.js?invalid-unit-requests`);
    const rasterizer = create({ bytes: new Uint8Array([1]), inTauri: false, ocgAfwijkend: false, toonNms: () => null });
    for (const userUnit of [undefined, null, '1', 0, -1, NaN, Infinity]) {
      const page = { userUnit, getViewport: () => { throw new Error('metadata was not verified'); } };
      assert.equal(await rasterizer.renderPagina({ page, viewport: { scale: 1 }, k: 1, breedte: 1, hoogte: 1 }), null);
    }
    assert.equal(workerCalls, 0);
  } finally {
    if (saved === undefined) delete globalThis.Worker; else globalThis.Worker = saved;
  }
});

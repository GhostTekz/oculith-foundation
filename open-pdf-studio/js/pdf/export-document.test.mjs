import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { joinExportPath } from './export-path.js';
import { cappedExportScale } from './export-pixel-cap.js';

const source = readFileSync(new URL('./exporter.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pageRangeSource = source.slice(source.indexOf('export function parsePageRange'),
  source.indexOf('/**\n * Render a single PDF page'))
  .replace('export function', 'function');
const parsePageRange = new Function(`${pageRangeSource}\nreturn parsePageRange;`)();
const imageExport = source.slice(source.indexOf('export async function exportAsImages'),
  source.indexOf('/**\n * Export pages as a rasterized PDF'))
  .replace('export async function', 'async function');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('page ranges reject malformed or partly invalid input instead of exporting different pages', () => {
  assert.deepEqual(parsePageRange('1-3, 5, 3', 6), [1, 2, 3, 5]);
  assert.deepEqual(parsePageRange('3 - 1', 6), [1, 2, 3]);
  for (const input of ['2abc', '1, 2abc', '1,,2', '1-2-3', '0', '7', '1,7', '9999999999999999999']) {
    assert.deepEqual(parsePageRange(input, 6), [], input);
  }
});

function harness() {
  const a = { pdfDoc: {}, filePath: 'a.pdf' }, b = { pdfDoc: {}, filePath: 'b.pdf' };
  let active = a;
  const writes = [], renders = [], messages = [];
  const revisions = new WeakMap([[a, 0], [b, 0]]);
  const tiffCalls = [], densityCalls = [];
  const deps = {
    getActiveDocument: () => active, isTauri: () => true,
    nativeOcgSelectionForDocument: doc => ({ revision: revisions.get(doc) || 0 }),
    getPdfBaseName: () => 'a',
    saveFileDialog: async () => '/tmp/a_page0001.png',
    openFolderDialog: async () => '/tmp/pages',
    showLoading() {}, hideLoading() {},
    renderPageOffscreen: async (page, scale, options) => { renders.push({ page, scale, options }); return {}; },
    canvasToBytes: async () => new Uint8Array([1, 2, 3]),
    canvasToTiffBytes: (canvas, dpi) => { tiffCalls.push({ canvas, dpi }); return new Uint8Array([4, 5, 6]); },
    imageWithDpi: (bytes, format, dpi) => { densityCalls.push({ format, dpi }); return bytes; },
    joinExportPath,
    writeBinaryFileAtomic: async (path, bytes) => writes.push({ path, bytes }),
    showMessage: message => messages.push(message),
    exportChanged: () => new Error('Document changed during export'),
    exportPageSizePt: async () => ({ width: 612, height: 792 }),
    cappedExportScale,
    releaseCanvas() {},
    cappedExportWarning: (capped, dpi) => { if (capped.length) messages.push({ capped, dpi }); },
  };
  const exportAsImages = new Function(...Object.keys(deps), `${imageExport}\nreturn exportAsImages;`)(...Object.values(deps));
  return { deps, exportAsImages, writes, renders, messages, tiffCalls, densityCalls,
    switchToB: () => { active = b; }, changeLayers: () => revisions.set(a, (revisions.get(a) || 0) + 1) };
}

test('multi-page image export writes atomic files inside the chosen Linux folder', async () => {
  const h = harness();
  await h.exportAsImages({ pages: [1, 2], dpi: 300, includeAnnotations: false });
  assert.deepEqual(h.writes.map(write => write.path), ['/tmp/pages/a_page0001.png', '/tmp/pages/a_page0002.png']);
  assert.deepEqual(h.renders.map(render => render.scale), [300 / 72, 300 / 72]);
  assert.ok(h.renders.every(render => render.options.markeringen === false));
  assert.deepEqual(h.densityCalls, [{ format: 'png', dpi: 300 }, { format: 'png', dpi: 300 }]);
});

test('switching documents while rendering aborts before writing another document’s pixels', async () => {
  const h = harness(), entered = deferred(), release = deferred();
  h.deps.renderPageOffscreen = async () => { entered.resolve(); await release.promise; return {}; };
  const exportAsImages = new Function(...Object.keys(h.deps), `${imageExport}\nreturn exportAsImages;`)(...Object.values(h.deps));
  const exporting = exportAsImages({ pages: [1] });
  await entered.promise;
  h.switchToB(); release.resolve();
  assert.equal(await exporting, false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.messages[0], 'Document changed during export');
});

test('changing native layers while encoding aborts image export before writing', async () => {
  const h = harness(), entered = deferred(), release = deferred();
  h.deps.canvasToBytes = async () => { entered.resolve(); await release.promise; return new Uint8Array([1]); };
  const exportAsImages = new Function(...Object.keys(h.deps), `${imageExport}\nreturn exportAsImages;`)(...Object.values(h.deps));
  const exporting = exportAsImages({ pages: [1] });
  await entered.promise;
  h.changeLayers(); release.resolve();
  assert.equal(await exporting, false);
  assert.deepEqual(h.writes, []);
});

test('TIFF export uses the chosen DPI and extension', async () => {
  const h = harness();
  await h.exportAsImages({ format: 'tiff', pages: [1, 2], dpi: 300 });
  assert.deepEqual(h.writes.map(write => write.path), ['/tmp/pages/a_page0001.tiff', '/tmp/pages/a_page0002.tiff']);
  assert.deepEqual(h.tiffCalls.map(call => call.dpi), [300, 300]);
  assert.deepEqual([...h.writes[0].bytes], [4, 5, 6]);
});

test('a document captured before module loading cannot export a later active tab', async () => {
  const h = harness();
  const selected = h.deps.getActiveDocument();
  h.switchToB();
  assert.equal(await h.exportAsImages({ pages: [1], doc: selected }), false);
  assert.deepEqual(h.renders, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.messages[0], 'Document changed during export');
});

test('an A0 page at 600 dpi is exported at a capped resolution with a warning', async () => {
  const h = harness();
  h.deps.exportPageSizePt = async (_doc, _pdf, page) => (page === 1 ? { width: 3370, height: 2384 } : { width: 612, height: 792 });
  const exportAsImages = new Function(...Object.keys(h.deps), `${imageExport}\nreturn exportAsImages;`)(...Object.values(h.deps));
  await exportAsImages({ pages: [1, 2], dpi: 600 });
  const [big, small] = h.renders;
  const pixels = (3370 * big.scale) * (2384 * big.scale);
  assert.ok(pixels <= 100_000_000, `${pixels} pixels`);
  assert.ok(3370 * big.scale <= 16384);
  assert.equal(small.scale, 600 / 72);
  assert.equal(h.densityCalls[0].dpi, Math.round(big.scale * 72));
  assert.equal(h.densityCalls[1].dpi, 600);
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.messages, [{ capped: [{ page: 1, dpi: h.densityCalls[0].dpi }], dpi: 600 }]);
});

test('the pixel cap keeps small pages and whole dpi values', () => {
  assert.deepEqual(cappedExportScale(612, 792, 300 / 72), { scale: 300 / 72, capped: false, dpi: 300 });
  const a0 = cappedExportScale(3370, 2384, 600 / 72);
  assert.equal(a0.capped, true);
  assert.equal(Number.isInteger(a0.dpi), true);
  assert.ok(a0.dpi < 600 && a0.dpi > 150);
  const strip = cappedExportScale(20000, 200, 300 / 72);
  assert.ok(20000 * strip.scale <= 16384, 'a long strip stays under the side limit');
});

test('markups are drawn onto the page canvas, not composited from a second page-sized canvas', () => {
  const render = source.slice(source.indexOf('export async function renderPageOffscreen'),
    source.indexOf('export async function renderMarkeringenOffscreen'));
  assert.match(render, /renderMarkeringenOffscreen\(pageNum, exportScale, viewport, \{ deel, markeringen, doelCanvas: pdfCanvas \}\)/);
  assert.doesNotMatch(render, /drawImage\(annCanvas/);
});

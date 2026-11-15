// PDF.js's worker starts through pdfjs-worker-shim.js, which hides
// OffscreenCanvas and ImageDecoder on WebKitGTK: moving the GPU-backed
// ImageBitmaps PDF.js builds there into the window crashed the web process.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { HIDDEN_WORKER_APIS, hideWorkerCanvasApis, isWebKitGtkAgent, pdfjsWorkerUrlFrom } from './pdfjs-worker-shim.js';
import { shimmedWorkerSrc } from './pdfjs-worker-src.js';
import { isWebKitGtk } from './page-canvas-context.js';

const bron = (pad) => readFileSync(new URL(pad, import.meta.url), 'utf8');

const UA = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  '',
];

test('the shim detects WebKitGTK exactly like the page canvases do', () => {
  for (const ua of UA) assert.equal(isWebKitGtkAgent(ua), isWebKitGtk(ua), ua);
  assert.equal(isWebKitGtkAgent(UA[0]), true);
  assert.equal(isWebKitGtkAgent(UA[2]), false);
});

test('OffscreenCanvas and ImageDecoder are hidden from the worker scope', () => {
  class OffscreenCanvas {}
  class ImageDecoder {}
  const scope = { OffscreenCanvas, ImageDecoder, fetch() {} };
  assert.deepEqual(hideWorkerCanvasApis(scope), ['OffscreenCanvas', 'ImageDecoder']);
  for (const name of HIDDEN_WORKER_APIS) assert.equal(typeof scope[name], 'undefined', name);
  assert.equal(typeof scope.fetch, 'function');
  // Nothing to hide: nothing reported.
  assert.deepEqual(hideWorkerCanvasApis({}), []);
});

test('a global that is a getter on the prototype is hidden too', () => {
  const proto = { get OffscreenCanvas() { return class {}; } };
  const scope = Object.create(proto);
  assert.deepEqual(hideWorkerCanvasApis(scope), ['OffscreenCanvas']);
  assert.equal(typeof scope.OffscreenCanvas, 'undefined');
});

test('the worker URL travels in the shim URL and must stay on its origin', () => {
  const src = shimmedWorkerSrc('/assets/pdfjs-worker-shim-1a2b.js', '/assets/pdf.worker-3c4d.mjs', 'tauri://localhost/index.html');
  assert.equal(src, 'tauri://localhost/assets/pdfjs-worker-shim-1a2b.js?worker=tauri%3A%2F%2Flocalhost%2Fassets%2Fpdf.worker-3c4d.mjs');
  assert.equal(pdfjsWorkerUrlFrom(src), 'tauri://localhost/assets/pdf.worker-3c4d.mjs');

  const dev = shimmedWorkerSrc('http://localhost:3041/js/pdf/pdfjs-worker-shim.js', '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'http://localhost:3041/');
  assert.equal(pdfjsWorkerUrlFrom(dev), 'http://localhost:3041/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');

  assert.equal(pdfjsWorkerUrlFrom('tauri://localhost/assets/shim.js'), null);
  assert.equal(pdfjsWorkerUrlFrom('tauri://localhost/assets/shim.js?worker=https%3A%2F%2Fexample.com%2Fw.mjs'), null);
  assert.equal(pdfjsWorkerUrlFrom('http://localhost:3041/shim.js?worker=http%3A%2F%2Flocalhost%3A9999%2Fw.mjs'), null);
  assert.equal(pdfjsWorkerUrlFrom('not a url'), null);
});

test('PDF.js decides on OffscreenCanvas in its worker from the global, after load', () => {
  // The shim hides the globals before it imports the worker; this only works
  // while PDF.js tests the global lazily (FeatureTest getters).
  const worker = bron('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
  assert.match(worker, /static get isOffscreenCanvasSupported\(\) \{\s*return shadow\(this, "isOffscreenCanvasSupported", typeof OffscreenCanvas !== "undefined"\);/);
  assert.match(worker, /static get isImageDecoderSupported\(\) \{\s*return shadow\(this, "isImageDecoderSupported", typeof ImageDecoder !== "undefined"\);/);
});

test('every PDF.js worker of the app starts through the shim', () => {
  const shim = bron('./pdfjs-worker-shim.js');
  assert.doesNotMatch(shim, /^\s*import\s/m, 'the shim is served unbundled and imports nothing statically');
  assert.match(bron('./loader.js'), /GlobalWorkerOptions\.workerSrc = pdfjsWorkerSrc\(\);/);
  assert.match(bron('../solid/components/PrintQueueWindow.jsx'), /GlobalWorkerOptions\.workerSrc = pdfjsWorkerSrc\(\);/);
  assert.match(bron('./pdfjs-worker-src.js'), /new URL\('\.\/pdfjs-worker-shim\.js', import\.meta\.url\)/);
});

test('a build keeps the shim a file (a data: URL has no query for the worker URL)', async () => {
  const { default: config } = await import('../../vite.config.js');
  const limit = config.build.assetsInlineLimit;
  assert.equal(typeof limit, 'function');
  assert.equal(limit('/app/js/pdf/pdfjs-worker-shim.js', Buffer.from('x')), false);
  assert.equal(limit('/app/assets/icon.svg', Buffer.from('x')), undefined);
});

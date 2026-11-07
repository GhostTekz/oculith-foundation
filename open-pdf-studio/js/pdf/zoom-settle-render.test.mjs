// A zoom settle renders the page once, at the exact zoom * dpr, and a whole-
// page bitmap never exceeds the 4096 px axis cap. Before, every off-bucket
// zoom rendered twice (the rounded-up power-of-two bucket, then the exact
// scale), and the bucket was rounded up past the cap: an A1 sheet at high
// zoom asked PDFium for ~6700 px (180 MB, too big for the worker's slot).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
// The real pdf-viewport.js pulls in the whole canvas UI; the orchestrator only
// needs its viewport state.
register(`data:text/javascript,${encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('/js/pdf/pdf-viewport.js')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export const viewport = { dirty: false }; export function holdShownPage() {}',
    };
  }
  return nextLoad(url, context);
}`)}`);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();

const renders = [];
globalThis.window.devicePixelRatio = 2;
globalThis.ImageData ??= class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
globalThis.createImageBitmap ??= async (img) => ({ width: img.width, height: img.height, close() {} });
globalThis.window.__TAURI__ = {
  core: {
    async invoke(cmd, args) {
      if (cmd !== 'render_pdf_page') throw new Error(`unexpected ${cmd}`);
      renders.push(args.scale);
      // Same sizing as the worker: ceil(pt * f32 scale).
      const w = Math.ceil(Math.fround(Math.fround(viewportRef.pageW) * Math.fround(args.scale)));
      const h = Math.ceil(Math.fround(Math.fround(viewportRef.pageH) * Math.fround(args.scale)));
      const out = new Uint8Array(8 + w * h * 4);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, w, true);
      dv.setUint32(4, h, true);
      return out;
    },
  },
};

const { viewport } = await import('./pdf-viewport.js');
const viewportRef = viewport;
const orch = await import('./bitmap-orchestrator.js');
const cache = await import('./page-bitmap-cache.js');

const A4 = { w: 595.28, h: 841.89 };
const A1 = { w: 2383.94, h: 1683.78 };
const A0 = { w: 3370.39, h: 2383.94 };

function show(path, size, zoom) {
  Object.assign(viewport, {
    active: true, filePath: path, pageType: 'raster', pageNum: 1, rotation: 0,
    pageW: size.w, pageH: size.h, zoom,
  });
}

test('wholePageRenderScale keeps the native bitmap within 4096 px', () => {
  for (const size of [A4, A1, A0, { w: 841.89, h: 595.28 }, { w: 5156, h: 2384 }]) {
    const maxPt = Math.max(size.w, size.h);
    for (const target of [0.1, 0.75, 1, 1.5, 3, 4.865, 8 * 2, 64]) {
      const s = cache.wholePageRenderScale(target, maxPt);
      const px = Math.ceil(Math.fround(Math.fround(maxPt) * Math.fround(s)));
      assert.ok(px <= 4096, `${maxPt} pt at ${target} -> ${s} = ${px} px`);
      assert.ok(s <= target + 1e-9);
      assert.ok(s >= Math.min(target, 4096 / maxPt) - 0.0015, `not clamped further than needed (${s})`);
    }
  }
});

test('a zoom settle renders once, at the exact scale', async () => {
  renders.length = 0;
  cache.clearAllBitmaps();
  show('/synthetic/settle.pdf', A4, 0.6); // 1.2 at dpr 2: bucket 2 before
  await orch.ensureBitmapForCurrentView();
  assert.deepEqual(renders, [1.2]);
  assert.ok(viewport.currentBitmap);

  // Same zoom again: cache hit, no render.
  await orch.ensureBitmapForCurrentView();
  assert.equal(renders.length, 1);

  // A new zoom shows the 1.2 bitmap at once and renders only the new scale.
  viewport.zoom = 0.85;
  const pending = orch.ensureBitmapForCurrentView();
  assert.equal(viewport.currentBitmap.width, Math.ceil(Math.fround(Math.fround(A4.w) * Math.fround(1.2))), 'fallback shown first');
  await pending;
  assert.deepEqual(renders, [1.2, 1.7]);
});

test('a high zoom on an A1 sheet renders at the cap, not at the rounded-up bucket', async () => {
  renders.length = 0;
  cache.clearAllBitmaps();
  show('/synthetic/a1.pdf', A1, 8); // 16 at dpr 2
  await orch.ensureBitmapForCurrentView();
  assert.equal(renders.length, 1);
  const longest = Math.ceil(Math.fround(Math.fround(A1.w) * Math.fround(renders[0])));
  assert.ok(longest <= 4096, `longest axis ${longest} px`);
  assert.ok(longest >= 4090);
  assert.ok(viewport.currentBitmap.width <= 4096 && viewport.currentBitmap.height <= 4096);
});

test('getBestAvailableBitmap finds exact-scale entries by their render scale', () => {
  cache.clearAllBitmaps();
  const bmp = (w) => ({ width: w, height: w, close() {} });
  cache.setCachedBitmapEntry('/synthetic/best.pdf', 1, 0, 'x1.437', bmp(1), 10, 10, 1.437);
  cache.setCachedBitmapEntry('/synthetic/best.pdf', 1, 0, 'x0.3', bmp(2), 10, 10, 0.3);
  assert.equal(cache.getBestAvailableBitmap('/synthetic/best.pdf', 1, 0, 2).scale, 1.437);
  assert.equal(cache.getBestAvailableBitmap('/synthetic/best.pdf', 1, 0, 0.25).scale, 0.3);
  assert.equal(cache.getCachedBitmapNearScale('/synthetic/best.pdf', 1, 0, 1.44).scale, 1.437);
  assert.equal(cache.getCachedBitmapNearScale('/synthetic/best.pdf', 1, 0, 1.6), null);
});

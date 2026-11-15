// The continuous view's low-res previews stay under their byte cap while a
// large set is paged through, and every preview that leaves the cache gives
// its pixels back.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLowResPreviewCache, canvasBytes } from './low-res-preview-cache.js';
import { registerBitmapCache, enforceBitmapBudget, bitmapBudgetUsed } from './bitmap-budget.js';

const MB = 1024 * 1024;
// Half-scale previews of A0 and A1 sheets.
const A0 = { w: 1192, h: 1685 };
const A1 = { w: 842, h: 1192 };
const canvas = ({ w, h }) => ({ width: w, height: h });

test('paging 400 large sheets keeps the preview cache under its cap', () => {
  const cap = 64 * MB;
  const cache = createLowResPreviewCache({ maxBytes: cap });
  const made = [];
  let peak = 0;
  for (let page = 1; page <= 400; page++) {
    const c = canvas(page % 3 ? A1 : A0);
    made.push(c);
    cache.set(`doc.pdf|${page}|0|0`, c, 0.5);
    peak = Math.max(peak, cache.bytes());
    // A page scrolled into view reads its preview (touches it).
    if (page > 2) cache.get(`doc.pdf|${page - 2}|0|0`);
  }
  assert.ok(peak <= cap, `peak ${peak} > cap ${cap}`);
  const kept = made.filter((c) => c.width > 0);
  const keptBytes = kept.reduce((sum, c) => sum + canvasBytes(c), 0);
  assert.equal(keptBytes, cache.bytes(), 'every evicted canvas was released');
  assert.equal(kept.length, cache.size);
  assert.ok(cache.has('doc.pdf|400|0|0'), 'the newest preview stays');
});

test('least recently used previews go first', () => {
  const one = A1.w * A1.h * 4;
  const cache = createLowResPreviewCache({ maxBytes: one * 3 });
  const a = canvas(A1), b = canvas(A1), c = canvas(A1), d = canvas(A1);
  cache.set('a', a, 0.5);
  cache.set('b', b, 0.5);
  cache.set('c', c, 0.5);
  cache.get('a'); // a is in view again
  cache.set('d', d, 0.5);
  assert.equal(cache.has('b'), false);
  assert.equal(b.width, 0);
  assert.ok(cache.has('a') && cache.has('c') && cache.has('d'));
});

test('a preview larger than the cap is released and not kept', () => {
  const cache = createLowResPreviewCache({ maxBytes: 1 * MB });
  const big = canvas(A0);
  assert.equal(cache.set('big', big, 0.5), false);
  assert.equal(big.width, 0);
  assert.equal(cache.bytes(), 0);
});

test('replacing and clearing release the old canvases', () => {
  const cache = createLowResPreviewCache({ maxBytes: 64 * MB });
  const first = canvas(A1);
  const second = canvas(A1);
  cache.set('k', first, 0.5);
  cache.set('k', second, 0.5);
  assert.equal(first.width, 0);
  assert.equal(cache.bytes(), canvasBytes(second));
  cache.clear();
  assert.equal(second.width, 0);
  assert.equal(cache.bytes(), 0);
  assert.equal(cache.size, 0);
});

test('the previews count in the shared bitmap budget and give way to it', () => {
  const cache = createLowResPreviewCache({ maxBytes: 64 * MB });
  registerBitmapCache('test-previews', { bytes: () => cache.bytes(), evictOldest: () => cache.evictOldest() });
  const before = bitmapBudgetUsed();
  for (let page = 1; page <= 6; page++) cache.set(`p${page}`, canvas(A0), 0.5);
  assert.equal(bitmapBudgetUsed() - before, cache.bytes());
  const newest = cache.bytes() / cache.size;
  enforceBitmapBudget(before + newest);
  assert.equal(cache.size, 1, 'the budget evicts down to the newest preview');
  assert.ok(cache.has('p6'));
  registerBitmapCache('test-previews', { bytes: () => 0, evictOldest: () => 0 });
});

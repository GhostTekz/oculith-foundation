// A progressive run gives back its accumulator and intermediate bitmaps on
// every exit, and a stale or late publish never reaches the screen.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createProgressiveSurface } from './progressive-render.js';

function fakeBitmap(name) {
  return { name, closed: false, close() { this.closed = true; } };
}

function harness({ current = () => true } = {}) {
  const canvas = { width: 4096, height: 4096 };
  const pending = [];
  const shown = [];
  let n = 0;
  const surface = createProgressiveSurface({
    canvas,
    makeBitmap: () => {
      const name = `b${++n}`; // named in request order
      return new Promise((resolve, reject) => {
        pending.push({ resolve: () => resolve(fakeBitmap(name)), reject });
      });
    },
    isCurrent: () => current(),
    show: (bitmap) => shown.push(bitmap),
    close: (bitmap) => bitmap.close(),
  });
  const settleNext = async () => { pending.shift().resolve(); await new Promise((r) => setImmediate(r)); };
  return { canvas, surface, shown, settleNext, pending };
}

test('a stale run closes its snapshot instead of showing it, and release frees the accumulator', async () => {
  let live = true;
  const h = harness({ current: () => live });
  const first = h.surface.publish();
  await h.settleNext();
  assert.equal(await first, true);
  const intermediate = h.shown[0];

  const late = h.surface.publish();
  live = false; // a newer run started while the snapshot was being made
  await h.settleNext();
  assert.equal(await late, false);
  assert.equal(h.shown.length, 1);

  h.surface.release();
  assert.equal(intermediate.closed, true);
  assert.equal(h.canvas.width, 0);
  assert.equal(h.canvas.height, 0);
  assert.equal(h.surface.intermediate, null);
});

test('a late preview publish never replaces the final bitmap', async () => {
  const h = harness();
  const preview = h.surface.publish(); // un-awaited publish from a preview
  const final = h.surface.finalize();
  await h.settleNext(); // the preview snapshot lands after the run completed
  await h.settleNext(); // the final snapshot
  assert.equal(await preview, false);
  const finalBitmap = await final;
  assert.equal(h.shown.length, 0, 'nothing from the run reached the screen after it settled');
  assert.equal(finalBitmap.closed, false);
  assert.equal(h.canvas.width, 0);
  assert.equal(await h.surface.publish(), false);
});

test('an older snapshot that resolves after a newer one is dropped', async () => {
  const h = harness();
  const older = h.surface.publish();
  const newer = h.surface.publish();
  const [a, b] = h.pending.splice(0, 2);
  b.resolve();
  await new Promise((r) => setImmediate(r));
  a.resolve();
  assert.equal(await newer, true);
  assert.equal(await older, false);
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].name, 'b2');
  h.surface.release();
  assert.equal(h.shown[0].closed, true);
});

test('a failed run releases everything and a failed snapshot never rejects', async () => {
  const h = harness();
  const ok = h.surface.publish();
  await h.settleNext();
  await ok;
  const broken = h.surface.publish();
  h.pending.shift().reject(new Error('out of memory'));
  assert.equal(await broken, false);
  h.surface.release();
  h.surface.release(); // idempotent
  assert.equal(h.shown[0].closed, true);
  assert.equal(h.canvas.width, 0);
});

test('every intermediate but the one on screen is closed while the run fills', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    const p = h.surface.publish();
    await h.settleNext();
    await p;
  }
  assert.deepEqual(h.shown.map((b) => b.closed), [true, true, false]);
  h.surface.release();
  assert.ok(h.shown.every((b) => b.closed));
});

// Polygon and polyline vertices at full precision (read with pdf-lib) are
// used only when they belong to the markup: the extra data is found by /Rect,
// so a second markup with the same /Rect must keep its own geometry.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { sameVertices } = await import('./annotation-converter.js');

test('full-precision vertices are used only when PDF.js read the same points', () => {
  const exact = [100.123456789, 100, 300.987654321, 100, 200, 300];
  assert.equal(sameVertices(exact, new Float32Array(exact)), true);
  // A triangle must not take a square's vertices, nor another triangle's.
  assert.equal(sameVertices([100, 100, 300, 100, 300, 300, 100, 300], new Float32Array([100, 100, 300, 100, 200, 300])), false);
  assert.equal(sameVertices([100, 100, 300, 100, 250, 300], new Float32Array([100, 100, 300, 100, 200, 300])), false);
  assert.equal(sameVertices(undefined, new Float32Array(exact)), false);
});

// Cutouts on an area: when a dragged hole needs clipping, and when it does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cutoutInsideArea, subtractAreaCutout } from './area-cutout.js';

const square = (x, y, size) => [
  { x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size },
];
// A 100 x 100 area whose top edge is an arc.
const outer = [{ x: 0, y: 0 }, { x: 100, y: 0, arc: true, bulge: 0.2 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

test('a hole moved within the area needs no clipping, even with other holes present', () => {
  const holes = [square(10, 40, 10), square(60, 60, 10)];
  assert.equal(cutoutInsideArea(outer, holes.slice(1), square(15, 45, 10)), true);
});

test('a hole pushed across the boundary or into another hole is clipped', () => {
  const others = [square(60, 60, 10)];
  assert.equal(cutoutInsideArea(outer, others, square(95, 40, 10)), false, 'crosses the right edge');
  assert.equal(cutoutInsideArea(outer, others, square(55, 55, 10)), false, 'overlaps the other hole');
  const result = subtractAreaCutout(outer, others, square(95, 40, 10));
  assert.ok(result && !result.empty);
});

test('a hole dragged fully outside the area subtracts nothing', () => {
  assert.equal(cutoutInsideArea(outer, [], square(200, 200, 10)), false);
  assert.equal(subtractAreaCutout(outer, [], square(200, 200, 10)), null);
});

test('an area with a hole saved partly outside its outline still takes a new hole', () => {
  // An L-shaped area; the saved hole's corners are inside, but its edge cuts across the notch.
  const lShape = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }];
  const crossing = [{ x: 40, y: 70 }, { x: 30, y: 30 }, { x: 70, y: 40 }];
  const result = subtractAreaCutout(lShape, [crossing], square(5, 5, 10));
  assert.ok(result && !result.empty, 'subtracted instead of refused');
  assert.ok(result.holes.length >= 1);
});

test('a cutout where two parts overlap is subtracted, not appended as another part', () => {
  const outer = square(0, 0, 100);
  const part = [{ x: 50, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 80 }, { x: 50, y: 80 }];
  const cut = [{ x: 60, y: 30 }, { x: 90, y: 30 }, { x: 90, y: 70 }, { x: 60, y: 70 }];
  assert.equal(cutoutInsideArea(outer, [part], cut), false, 'inside both parts: appended it would add area');
  const result = subtractAreaCutout(outer, [part], cut);
  assert.ok(result && !result.empty);
});

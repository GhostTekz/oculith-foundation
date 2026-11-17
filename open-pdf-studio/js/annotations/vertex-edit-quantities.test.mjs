// A vertex drag on an area or perimeter measurement (applyResize with a
// polyline node or hole node handle) updates the stored quantity
// (measureValue / measureUnit) together with the caption (measureText).
// Quantities lists and exports read measureValue; a stale value after an edit
// reported the old area while the caption showed the new one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { state } = await import('../core/state.js');
const { applyResize } = await import('./transforms.js');
const { calculateArea, calculatePerimeter, formatMeasurement } = await import('./measurement.js');

state.documents = [{ id: 'vertex-edit', filePath: null, pdfDoc: { numPages: 1 }, currentPage: 1, scale: 1,
  annotations: [], pageRotations: {}, measureScale: null, pageScales: {} }];
state.activeDocumentIndex = 0;

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const square = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

function drag(ann, handle, dx, dy) {
  const original = JSON.parse(JSON.stringify(ann));
  const target = JSON.parse(JSON.stringify(ann));
  applyResize(target, handle, dx, dy, original, false, false);
  return target;
}

function areaAnn(points, holes) {
  const m = calculateArea(points, holes, 1);
  return { id: 'a1', type: 'measureArea', page: 1, points, ...(holes ? { holes } : {}),
    x: 100, y: 100, width: 100, height: 100,
    measureValue: m.value, measureUnit: m.unit, measureText: formatMeasurement(m) };
}

test('dragging an area vertex updates measureValue, measureUnit and the caption together', () => {
  const ann = areaAnn(square(100, 100, 100));
  const before = calculateArea(ann.points, null, 1);
  const moved = drag(ann, 'polyline_node_2', 50, 0); // (200,200) → (250,200)
  const expected = calculateArea(moved.points, null, 1);
  close(expected.pixels, 100 * 100 + 0.5 * 50 * 100);
  assert.ok(expected.value > before.value);
  close(moved.measureValue, expected.value);
  assert.equal(moved.measureUnit, expected.unit);
  assert.equal(moved.measureText, formatMeasurement(expected));
  assert.notEqual(moved.measureValue, ann.measureValue);
});

test('dragging a hole vertex updates the net area quantity', () => {
  const hole = square(130, 130, 20);
  const ann = areaAnn(square(100, 100, 100), [hole]);
  const moved = drag(ann, 'polyline_node_hole_0_2', 10, 10); // grows the hole
  const expected = calculateArea(moved.points, moved.holes, 1);
  assert.ok(expected.pixels < 100 * 100 - 20 * 20, `net ${expected.pixels}`);
  assert.notEqual(moved.measureValue, ann.measureValue);
  close(moved.measureValue, expected.value);
  assert.equal(moved.measureUnit, expected.unit);
  assert.equal(moved.measureText, formatMeasurement(expected));
});

test('dragging a perimeter vertex updates measureValue, measureUnit and the caption together', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const m = calculatePerimeter(points, 1);
  const ann = { id: 'p1', type: 'measurePerimeter', page: 1, points, x: 0, y: 0, width: 100, height: 100,
    measureValue: m.value, measureUnit: m.unit, measureText: formatMeasurement(m) };
  const moved = drag(ann, 'polyline_node_2', 0, 50); // (100,100) → (100,150)
  const expected = calculatePerimeter(moved.points, 1);
  close(expected.pixels, 250);
  assert.notEqual(moved.measureValue, ann.measureValue);
  close(moved.measureValue, expected.value);
  assert.equal(moved.measureUnit, expected.unit);
  assert.equal(moved.measureText, formatMeasurement(expected));
});

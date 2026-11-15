// WP13 Edit-menu tools, pure geometry (docs/reference/editor/markup-tools.md): Lasso enclosure
// and touching, Offset with mitred joins and calibrated distances, and the
// Markup Selection Cycle step.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pointInPolygon, segmentsIntersect, annotationOutline, lassoSelects, addLassoPoint,
} from './lasso-geometry.js';
import {
  offsetPolyline, offsetSide, offsetGeometry, offsetPathOf, canOffset, offsetDistanceToPoints,
  distanceToPath, MITRE_LIMIT,
} from './offset-geometry.js';
import { nextCycleId, sameSpot, cyclePosition } from './selection-cycle.js';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≈ ${b}`);

// Point-to-segment distance, written out here (not the module's helper).
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ── Lasso ──────────────────────────────────────────────────────────────────

// A concave "C"-shaped lasso: open towards the right between y 40 and 60.
const C_LASSO = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 30, y: 40 },
  { x: 30, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 100 }, { x: 0, y: 100 },
];

test('point in polygon and segment intersection', () => {
  assert.ok(pointInPolygon({ x: 10, y: 50 }, C_LASSO));
  assert.ok(!pointInPolygon({ x: 60, y: 50 }, C_LASSO), 'the notch is outside');
  assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }));
  assert.ok(!segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }));
  assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }), 'touching end points');
});

test('lasso selects only fully enclosed markups; Ctrl (touching) also the ones it crosses', () => {
  const inside = { type: 'line', startX: 5, startY: 10, endX: 90, endY: 20 };
  const crossing = { type: 'line', startX: 50, startY: 20, endX: 150, endY: 20 };
  // Both end points inside the C, but the line runs through the notch.
  const throughNotch = { type: 'line', startX: 10, startY: 30, endX: 10, endY: 70 };
  const spansNotch = { type: 'line', startX: 80, startY: 20, endX: 80, endY: 80 };
  const outside = { type: 'line', startX: 200, startY: 200, endX: 220, endY: 220 };
  const enclosed = (a) => lassoSelects(annotationOutline(a), C_LASSO, 'enclosed');
  const touching = (a) => lassoSelects(annotationOutline(a), C_LASSO, 'touching');
  assert.equal(enclosed(inside), true);
  assert.equal(enclosed(crossing), false);
  assert.equal(enclosed(throughNotch), true, 'x = 10 stays left of the notch');
  assert.equal(enclosed(spansNotch), false, 'end points inside, segment leaves the lasso');
  assert.equal(enclosed(outside), false);
  assert.equal(touching(inside), true);
  assert.equal(touching(crossing), true);
  assert.equal(touching(spansNotch), true);
  assert.equal(touching(outside), false);
});

test('outline: points, freehand path, and the bounding box for shapes', () => {
  const poly = annotationOutline({ type: 'polygon', points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }] });
  assert.equal(poly.closed, true);
  assert.equal(annotationOutline({ type: 'polyline', points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }] }).closed, false);
  assert.equal(annotationOutline({ type: 'draw', path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }).points.length, 2);
  const box = annotationOutline({ type: 'box', x: 10, y: 10, width: 20, height: 5 }, { x: 10, y: 10, width: 20, height: 5 });
  assert.deepEqual(box.points[2], { x: 30, y: 15 });
  assert.equal(annotationOutline({ type: 'box' }, null), null);
  // A lasso drawn inside a large rectangle touches it, but does not enclose it.
  const big = annotationOutline({ type: 'box' }, { x: -50, y: -50, width: 300, height: 300 });
  assert.equal(lassoSelects(big, C_LASSO, 'touching'), true);
  assert.equal(lassoSelects(big, C_LASSO, 'enclosed'), false);
  assert.equal(lassoSelects(big, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'touching'), false, 'needs 3 points');
});

test('addLassoPoint thins the pointer trail', () => {
  const pts = [];
  addLassoPoint(pts, { x: 0, y: 0 }, 2);
  addLassoPoint(pts, { x: 1, y: 0 }, 2);
  addLassoPoint(pts, { x: 2.5, y: 0 }, 2);
  assert.deepEqual(pts, [{ x: 0, y: 0 }, { x: 2.5, y: 0 }]);
});

// ── Offset ─────────────────────────────────────────────────────────────────

test('offset of a 10 ft line at 2 ft on a 1/4" = 1\'-0" sheet lands 2 ft away, measured', () => {
  // 1/4" = 1'-0": 0.25 in = 18 pt per foot (pixelsPerUnit 18, unit ft).
  const scale = { pixelsPerUnit: 18, unit: 'ft', calibrated: true };
  const line = { type: 'line', startX: 100, startY: 300, endX: 100 + 10 * 18, endY: 300 };
  const d = offsetDistanceToPoints(2, scale);
  assert.equal(d, 36);
  const below = offsetGeometry(line, d, offsetSide(offsetPathOf(line).points, { x: 150, y: 340 }));
  // Measured the way calculateDistance does: page points / pixelsPerUnit.
  near(segDist({ x: below.startX, y: below.startY }, { x: line.startX, y: line.startY }, { x: line.endX, y: line.endY }) / 18, 2);
  near(segDist({ x: below.endX, y: below.endY }, { x: line.startX, y: line.startY }, { x: line.endX, y: line.endY }) / 18, 2);
  near(Math.hypot(below.endX - below.startX, below.endY - below.startY) / 18, 10, 1e-9, 'same length');
  assert.ok(below.startY > line.startY, 'on the side that was clicked (below)');
  const above = offsetGeometry(line, d, offsetSide(offsetPathOf(line).points, { x: 150, y: 250 }));
  near(above.startY, 300 - 36);
  // A diagonal line too.
  const diag = { type: 'measureDistance', startX: 0, startY: 0, endX: 108, endY: 144 };
  const g = offsetGeometry(diag, 36, 1);
  near(segDist({ x: g.startX, y: g.startY }, { x: 0, y: 0 }, { x: 108, y: 144 }) / 18, 2);
});

test('an uncalibrated page takes the distance in page points', () => {
  assert.equal(offsetDistanceToPoints(12, { pixelsPerUnit: 1, unit: 'pt', calibrated: false }), 12);
  assert.equal(offsetDistanceToPoints(12, { pixelsPerUnit: 18, unit: 'ft', calibrated: false }), 12, 'no calibration, no scaling');
  assert.equal(offsetDistanceToPoints(0, { pixelsPerUnit: 18, calibrated: true }), null);
  assert.equal(offsetDistanceToPoints('x', { pixelsPerUnit: 18, calibrated: true }), null);
});

test('offset of a polyline keeps mitred corners, every segment at the distance', () => {
  // An L: right 100, then down 80, then right 60 (y down).
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 160, y: 80 }];
  const out = offsetPolyline(pts, 10, 1, false);
  assert.equal(out.length, 4, 'one point per vertex: mitre, no bevel');
  // Side +1 = left of travel = up for the first segment.
  near(out[0].x, 0); near(out[0].y, -10);
  near(out[1].x, 110); near(out[1].y, -10, 1e-6, 'outer mitre corner');
  near(out[2].x, 110); near(out[2].y, 70, 1e-6, 'inner mitre corner');
  near(out[3].x, 160); near(out[3].y, 70);
  for (let i = 0; i < out.length - 1; i++) {
    const mid = { x: (out[i].x + out[i + 1].x) / 2, y: (out[i].y + out[i + 1].y) / 2 };
    near(segDist(mid, pts[i], pts[i + 1]), 10, 1e-6, `segment ${i}`);
  }
  // Through the annotation API, with the side from the cursor.
  const poly = { type: 'polyline', points: pts };
  const side = offsetSide(pts, { x: 50, y: 20 });
  assert.equal(side, -1, 'below the first segment is the right side');
  const g = offsetGeometry(poly, 10, side);
  near(g.points[1].x, 90); near(g.points[1].y, 10);
  assert.deepEqual([g.x, g.width], [0, 160]);
});

test('closed polygons offset outward or inward as a whole, with mitred corners', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  for (const order of [square, [...square].reverse()]) {
    const ann = { type: 'measureArea', points: order };
    const outSide = offsetSide(order, { x: 150, y: 50 }, true);
    const inSide = offsetSide(order, { x: 50, y: 50 }, true);
    assert.equal(outSide, -inSide);
    const grown = offsetGeometry(ann, 10, outSide).points;
    const xs = grown.map((p) => p.x).sort((a, b) => a - b);
    assert.deepEqual([xs[0], xs.at(-1)].map(Math.round), [-10, 110], 'outward square');
    const shrunk = offsetGeometry(ann, 10, inSide).points;
    const ys = shrunk.map((p) => p.y).sort((a, b) => a - b);
    assert.deepEqual([ys[0], ys.at(-1)].map(Math.round), [10, 90], 'inward square');
    assert.equal(grown.length, 4);
  }
  // A polyline that closes on itself (L-shape tool) stays closed.
  const loop = { type: 'polyline', points: [...square, { x: 0, y: 0 }] };
  const p = offsetPathOf(loop);
  assert.equal(p.closed, true);
  const g = offsetGeometry(loop, 5, offsetSide(loop.points, { x: -20, y: 50 }, true));
  assert.equal(g.points.length, 5);
  assert.deepEqual(g.points[0], g.points[4]);
  near(g.points[0].x, -5); near(g.points[0].y, -5);
});

test('a near-reversal is bevelled instead of a mitre spike', () => {
  const spike = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 2 }];
  const out = offsetPolyline(spike, 10, -1, false);
  assert.equal(out.length, 4, 'bevel: two points at the sharp corner');
  for (const q of out) assert.ok(distanceToPath(spike, q) <= 10 * MITRE_LIMIT);
});

test('Offset takes lines, polylines, polygons, areas and perimeters only', () => {
  assert.ok(canOffset({ type: 'line', startX: 0, startY: 0, endX: 1, endY: 0 }));
  assert.ok(canOffset({ type: 'arrow', startX: 0, startY: 0, endX: 1, endY: 0 }));
  assert.ok(canOffset({ type: 'measurePerimeter', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }));
  assert.ok(canOffset({ type: 'cloudPolyline', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] }));
  assert.ok(!canOffset({ type: 'polygon', x: 0, y: 0, width: 10, height: 10, sides: 6 }), 'regular polygon without points');
  assert.ok(!canOffset({ type: 'filledArea', points: [{ x: 0, y: 0 }, { x: 5, y: 0, arc: true }, { x: 5, y: 5 }] }), 'arc vertex');
  assert.ok(!canOffset({ type: 'measureArea', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], holes: [[]] }), 'holes');
  assert.ok(!canOffset({ type: 'line', startX: 0, startY: 0, endX: 1, endY: 0, rotation: 30 }));
  assert.ok(!canOffset({ type: 'box', x: 0, y: 0, width: 5, height: 5 }));
  assert.equal(offsetPolyline([{ x: 1, y: 1 }, { x: 1, y: 1 }], 5, 1), null, 'degenerate');
});

// ── Selection cycle ────────────────────────────────────────────────────────

test('selection cycle walks the stack top first and wraps', () => {
  const stack = ['top', 'middle', 'bottom'];
  assert.equal(nextCycleId(stack, 'top'), 'middle');
  assert.equal(nextCycleId(stack, 'middle'), 'bottom');
  assert.equal(nextCycleId(stack, 'bottom'), 'top');
  assert.equal(nextCycleId(['only'], 'only'), null);
  assert.equal(nextCycleId(stack, 'elsewhere'), null);
  assert.deepEqual(cyclePosition(stack, 'bottom'), { index: 3, count: 3 });
  assert.ok(sameSpot({ page: 1, x: 10, y: 10 }, { page: 1, x: 12, y: 11 }, 3));
  assert.ok(!sameSpot({ page: 1, x: 10, y: 10 }, { page: 2, x: 10, y: 10 }, 3));
  assert.ok(!sameSpot(null, { page: 1, x: 0, y: 0 }, 3));
});

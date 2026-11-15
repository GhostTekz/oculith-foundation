// Raceway branches: tees, crosses and reducers derived from raceway.branchOf
// (docs/reference/editor/raceways.md, Branches).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  branchJunction, junctionFittings, normalizeBranchOf, normalizeRaceway, racewayDrawing, fittingsText, trimStart,
} from './raceway.js';
import { computeMeasureExtras, measureExtrasToJson, measureExtrasFromJson } from './measure-extras.js';

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
// 1/4" = 1'-0": 1.5 pt per inch, so a 24" tray is 36 pt wide.
const QUARTER = { pixelsPerUnit: 18, unit: 'ft', calibrated: true };
const fmt = {
  formatMeasurement: (m) => `${m.value.toFixed(2)} ${m.unit}`,
  formatDimensionText: (m) => `${m.value.toFixed(2)} ${m.unit}`,
};
const LADDER = (widthIn) => ({ kind: 'tray', trayStyle: 'ladder', widthIn, railIn: 4 });
const EMT = (tradeSize) => ({ kind: 'conduit', conduitType: 'EMT', tradeSize });

function run(id, points, raceway, branchOf) {
  return {
    id, page: 1, type: 'measurePerimeter', measureKind: 'raceway', points,
    raceway: normalizeRaceway({ ...raceway, ...(branchOf ? { branchOf } : {}) }),
  };
}
/** Compute every run's values against the whole set (like recalculateAllMeasurements). */
function compute(annotations, scale = QUARTER) {
  for (const a of annotations) Object.assign(a, computeMeasureExtras(a, scale, { ...fmt, annotations }));
  return annotations;
}
const main = () => run('main', [{ x: 0, y: 100 }, { x: 600, y: 100 }], LADDER(24));
const at = (x, y) => ({ id: 'main', at: { x, y } });
const kinds = (a) => (a.measureFittings || []).map((f) => f.angle);

test('a branch off the side of a straight leg is a tee; another size adds a reducer', () => {
  const same = run('b1', [{ x: 300, y: 100 }, { x: 300, y: 300 }], LADDER(24), at(300, 100));
  const [parent, b] = compute([main(), same]);
  const j = branchJunction(b, [parent, b]);
  assert.equal(j.fitting, 'tee');
  assert.equal(j.reducer, false);
  near(j.x, 300); near(j.y, 100);
  near(j.parentHalfPx, 18, 1e-9, '24" at 1.5 pt/in');
  assert.deepEqual(b.measureFittings, [{ angle: 'tee', count: 1 }]);
  assert.match(b.measureText, /24" Ladder tray, 4" rail · 1 × tee$/u);
  assert.equal(kinds(parent).length, 0, 'the parent itself gets no fitting');

  const smaller = run('b1', [{ x: 300, y: 100 }, { x: 300, y: 300 }], LADDER(12), at(300, 100));
  const [, r] = compute([main(), smaller]);
  assert.deepEqual(r.measureFittings, [{ angle: 'tee', count: 1 }, { angle: 'reducer', count: 1 }]);
  assert.equal(fittingsText(r.measureFittings), '1 × tee, 1 × reducer');
  assert.match(r.measureText, /1 × tee, 1 × reducer$/u);
  // The developed length stays centre line to end: 200 pt = 11.11 ft.
  near(r.measureValue, 200 / 18, 1e-9);
});

test('two branches at the same point on opposite sides make one cross', () => {
  const down = run('b1', [{ x: 300, y: 100 }, { x: 300, y: 300 }], LADDER(12), at(300, 100));
  const up = run('b2', [{ x: 301, y: 100 }, { x: 301, y: -100 }], LADDER(12), at(301, 100));
  const all = compute([main(), down, up]);
  const jd = branchJunction(down, all), ju = branchJunction(up, all);
  assert.equal(jd.fitting, 'cross');
  assert.equal(ju.fitting, 'cross');
  assert.equal(jd.counted, true, 'counted on the first branch in document order');
  assert.equal(ju.counted, false);
  assert.deepEqual(kinds(down), ['cross', 'reducer']);
  assert.deepEqual(kinds(up), ['reducer'], 'the cross is counted once');
  // Same side, or far apart along the parent: two tees.
  const same = run('b2', [{ x: 300, y: 100 }, { x: 400, y: 300 }], LADDER(12), at(300, 100));
  assert.equal(branchJunction(same, [main(), down, same]).fitting, 'tee');
  const apart = run('b2', [{ x: 420, y: 100 }, { x: 420, y: -100 }], LADDER(12), at(420, 100));
  assert.equal(branchJunction(apart, [main(), down, apart]).fitting, 'tee');
});

test('a run starting on the parent end point: straight connection, reducer when sizes differ', () => {
  const sameSize = run('b3', [{ x: 600, y: 100 }, { x: 900, y: 100 }], LADDER(24), at(600, 100));
  const [, s] = compute([main(), sameSize]);
  assert.equal(branchJunction(s, [main(), s]).fitting, 'end');
  assert.equal(s.measureFittings.length, 0, 'a straight connection is no fitting');
  const reducing = run('b3', [{ x: 600, y: 100 }, { x: 900, y: 100 }], LADDER(12), at(600, 100));
  const [, r] = compute([main(), reducing]);
  assert.deepEqual(r.measureFittings, [{ angle: 'reducer', count: 1 }]);
  assert.match(r.measureText, /1 × reducer$/u);
  // Conduit: 1" onto a 3/4" end.
  const c0 = run('c0', [{ x: 0, y: 400 }, { x: 300, y: 400 }], EMT('3/4'));
  const c1 = run('c1', [{ x: 300, y: 400 }, { x: 300, y: 600 }], EMT('1'), { id: 'c0', at: { x: 300, y: 400 } });
  compute([c0, c1]);
  assert.deepEqual(kinds(c1), ['reducer']);
});

test('the junction symbols are part of the drawing lines (saved appearance included)', () => {
  const b = run('b1', [{ x: 300, y: 100 }, { x: 300, y: 300 }], LADDER(12), at(300, 100));
  const all = compute([main(), b]);
  const j = branchJunction(b, all);
  const plain = racewayDrawing(b.points, normalizeRaceway({ ...b.raceway, branchOf: undefined }), 1.5);
  const tee = racewayDrawing(b.points, b.raceway, 1.5, j);
  assert.equal(tee.lines.length, plain.lines.length + 2, 'two chamfers');
  // The rails open into the parent's near rail (y = 100 + 18): the chamfers
  // end on it and the branch has no end plate at its start.
  const ends = tee.lines.slice(0, 2).map((l) => l[l.length - 1]);
  for (const p of ends) near(p.y, 118, 1e-6, 'chamfer ends on the parent rail');
  // The rails start where the chamfers do: parent rail + 9 pt (half the width).
  for (const rail of tee.lines.slice(2)) near(rail[0].y, 127, 1e-6, 'rail start');
  for (const c of tee.lines.slice(0, 2)) near(c[0].y, 127, 1e-6, 'chamfer start');
  assert.equal(tee.thin.filter((l) => l.length === 2 && Math.abs(l[0].y - l[1].y) < 1e-9 && l[0].y < 118).length, 0,
    'no rung or end plate inside the parent');
  assert.equal(tee.geom.fittings.find((f) => f.angle === 'tee').count, 1);
  // Conduit: a circle at the junction; a cross: a diamond.
  const c0 = run('c0', [{ x: 0, y: 400 }, { x: 300, y: 400 }], EMT('3/4'));
  const c1 = run('c1', [{ x: 150, y: 400 }, { x: 150, y: 600 }], EMT('3/4'), { id: 'c0', at: { x: 150, y: 400 } });
  const c2 = run('c2', [{ x: 150, y: 400 }, { x: 150, y: 200 }], EMT('3/4'), { id: 'c0', at: { x: 150, y: 400 } });
  const ca = compute([c0, c1]);
  const dc = racewayDrawing(c1.points, c1.raceway, 1.5, branchJunction(c1, ca));
  assert.equal(dc.lines.length, 2);
  for (const p of dc.lines[1]) near(Math.hypot(p.x - 150, p.y - 400), 3, 1e-9, 'tee circle');
  const cx = compute([c0, c1, c2]);
  const dx = racewayDrawing(c1.points, c1.raceway, 1.5, branchJunction(c1, cx));
  assert.equal(dx.lines[1].length, 5, 'cross diamond');
  // Reducer on an end point at true width: a taper from 36 pt to 18 pt wide.
  const r = run('b3', [{ x: 600, y: 100 }, { x: 900, y: 100 }], LADDER(12), at(600, 100));
  const ra = compute([main(), r]);
  const dr = racewayDrawing(r.points, r.raceway, 1.5, branchJunction(r, ra));
  const taper = dr.lines.find((l) => l.length === 2 && near2(l[0], { x: 600, y: 82 }));
  assert.ok(taper, 'taper from the parent rail');
  near(Math.abs(taper[1].y - 100), 9, 1e-9, 'to the branch rail');
});
const near2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

test('a missing, moved or other-kind parent leaves a plain run', () => {
  const b = run('b1', [{ x: 300, y: 100 }, { x: 300, y: 300 }], LADDER(12), at(300, 100));
  // Deleted parent.
  compute([b]);
  assert.equal(branchJunction(b, [b]), null);
  assert.equal(b.measureFittings.length, 0);
  assert.equal(b.measureJunction, undefined);
  assert.doesNotThrow(() => racewayDrawing(b.points, b.raceway, 1.5, null));
  assert.doesNotThrow(() => computeMeasureExtras(b, QUARTER, fmt), 'no annotations at all');
  assert.equal(branchJunction(b, undefined), null);
  // Parent moved off the branch start.
  const moved = main();
  moved.points = moved.points.map((p) => ({ x: p.x, y: p.y + 40 }));
  compute([moved, b]);
  assert.equal(branchJunction(b, [moved, b]), null);
  assert.equal(b.measureFittings.length, 0);
  // Moved back (or the branch moved onto it): the junction is recomputed.
  const back = main();
  compute([back, b]);
  assert.equal(branchJunction(b, [back, b]).fitting, 'tee');
  assert.equal(b.measureJunction, 'main|tee|1|1');
  // A conduit cannot branch off a tray; a broken parent is ignored.
  const c = run('c1', [{ x: 300, y: 100 }, { x: 300, y: 300 }], EMT('1'), at(300, 100));
  assert.equal(branchJunction(c, [main(), c]), null);
  const broken = { id: 'main', page: 1, type: 'measurePerimeter', measureKind: 'raceway', points: [{ x: 0, y: 0 }] };
  assert.equal(branchJunction(b, [broken, b]), null);
  assert.deepEqual(junctionFittings(null), []);
  assert.equal(trimStart([{ x: 0, y: 0 }, { x: 10, y: 0 }], 4)[0].x, 4);
});

test('branchOf is normalised and survives the /OPS_MeasureExtra JSON with the run id', () => {
  assert.deepEqual(normalizeBranchOf({ id: 'abc_1', at: { x: 1, y: 2 }, extra: 1 }), { id: 'abc_1', at: { x: 1, y: 2 } });
  assert.equal(normalizeBranchOf({ id: 'a b', at: { x: 1, y: 2 } }), null, 'unsafe id');
  assert.equal(normalizeBranchOf({ id: 'a', at: { x: NaN, y: 2 } }), null);
  assert.equal(normalizeBranchOf({ id: 'a', at: { x: '1', y: 2 } }), null);
  assert.equal(normalizeBranchOf({ id: 'a' }), null);
  assert.equal(normalizeBranchOf('a'), null);
  assert.equal(normalizeRaceway({ kind: 'tray', branchOf: { id: '' } }).branchOf, undefined);
  assert.deepEqual(normalizeRaceway({ kind: 'tray', branchOf: { id: 'm', at: { x: 3, y: 4, z: 1 } } }).branchOf,
    { id: 'm', at: { x: 3, y: 4 } });

  const b = run('b1', [{ x: 300, y: 100 }, { x: 300, y: -100 }], LADDER(12), at(300, 100));
  const d = run('b0', [{ x: 300, y: 100 }, { x: 300, y: 300 }], LADDER(12), at(300, 100));
  compute([main(), d, b]);
  assert.deepEqual(kinds(d), ['cross', 'reducer']);
  const json = measureExtrasToJson(d);
  const props = measureExtrasFromJson('measurePerimeter', json);
  assert.equal(props.id, 'b0', 'the run id comes back, so branches find their parent');
  assert.deepEqual(props.raceway.branchOf, { id: 'main', at: { x: 300, y: 100 } });
  assert.deepEqual(props.measureFittings, [{ angle: 'cross', count: 1 }, { angle: 'reducer', count: 1 }]);
  // A bad stored id is not taken over.
  const bad = JSON.parse(json);
  bad.rid = 'x y';
  assert.equal(measureExtrasFromJson('measurePerimeter', JSON.stringify(bad)).id, undefined);
});

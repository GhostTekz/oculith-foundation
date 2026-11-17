import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const { classifiedRings, refineMeasureArea, refineOffset, refineShapeArea, scheduleAreaRefine } = await import('./geos-area.js');

function openBarePage() {
  state.documents = [{ id: 'geos-area', currentPage: 1, annotations: [], measureScale: null }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
}

const square = (x, y, size) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

test('a ring inside the outer ring is a hole, and a ring beside it is a part', () => {
  const donut = classifiedRings(square(0, 0, 2), [square(0.5, 0.5, 1)]);
  assert.equal(donut.parts.length, 1);
  assert.equal(donut.holes.length, 1);

  const beside = classifiedRings(square(0, 0, 1), [square(2, 0, 1)]);
  assert.equal(beside.parts.length, 2);
  assert.equal(beside.holes.length, 0);
});

test('a missing geometry command leaves the shoelace area in place', async () => {
  openBarePage();
  const annotation = {
    type: 'measureArea',
    page: 1,
    points: square(0, 0, 1),
    holes: [square(0.5, 0, 1)],
    measureValue: 2,
    measureUnit: 'px²',
    measureText: '2 px²',
  };
  const changed = await refineMeasureArea(annotation, () => {
    throw new Error('geometry engine is not linked');
  });
  assert.equal(changed, false);
  assert.equal(annotation.measureValue, 2);
  assert.equal(annotation.measureText, '2 px²');
});

test('an engine area replaces the stored total when the overlap was counted twice', async () => {
  openBarePage();
  const annotation = {
    type: 'measureArea',
    page: 1,
    points: square(0, 0, 1),
    holes: [square(0.5, 0, 1)],
    measureValue: 2,
    measureUnit: 'px²',
    measureText: '2 px²',
  };
  const changed = await refineMeasureArea(annotation, (_command, rings) => {
    assert.equal(rings.parts.length, 2);
    assert.equal(rings.holes.length, 0);
    return 1.5;
  });
  assert.equal(changed, true);
  assert.equal(annotation.measureValue, 1.5);
  assert.match(annotation.measureText, /1\.5/);
});

test('a volume built on an overlapping area uses the engine total', async () => {
  openBarePage();
  const annotation = {
    type: 'measureArea',
    page: 1,
    points: square(0, 0, 1),
    holes: [square(0.5, 0, 1)],
    measureKind: 'volume',
    measureDepth: 2,
    measureDepthUnit: 'pt',
    measureValue: 2,
    measureUnit: 'pt²',
    measureText: '2 pt²',
  };
  const changed = await refineMeasureArea(annotation, () => 1.5);
  assert.equal(changed, true);
  assert.equal(annotation.measureValue, 1.5);
  assert.equal(annotation.measureVolumeValue, 3);
  assert.match(annotation.measureText, /3/);
});

test('scheduling does nothing when the desktop command is absent', () => {
  openBarePage();
  const annotation = {
    type: 'measureArea',
    page: 1,
    points: square(0, 0, 1),
    measureValue: 1,
    measureText: '1',
  };
  scheduleAreaRefine(annotation);
  assert.equal(annotation.measureValue, 1);
});

test('a polygonal takeoff stores the engine area and a box keeps its formula', async () => {
  openBarePage();
  const { buildSchedule } = await import('../quantities/engine.js');
  const shape = {
    type: 'filledArea',
    points: square(0, 0, 1),
    holes: [square(0.5, 0, 1)],
  };
  const changed = await refineShapeArea(shape, (_command, rings) => {
    assert.equal(rings.parts.length, 2);
    assert.equal(rings.holes.length, 0);
    return 1.5;
  });
  assert.equal(changed, true);
  assert.equal(shape.enginePixels, 1.5);
  const scheduled = buildSchedule(
    [{ ...shape, __pxPerUnit: 1, __unit: 'pt' }],
    { categories: ['area'], fields: ['area'], itemize: true },
  );
  assert.equal(scheduled.groups[0].rows[0].vals.area, 1.5);

  const box = { type: 'box', x: 0, y: 0, width: 10, height: 4, enginePixels: 1 };
  const boxSchedule = buildSchedule(
    [{ ...box, __pxPerUnit: 1, __unit: 'pt' }],
    { categories: ['area'], fields: ['area'], itemize: true },
  );
  assert.equal(boxSchedule.groups[0].rows[0].vals.area, 40);

  const untouched = { type: 'filledArea', points: square(0, 0, 1) };
  const kept = await refineShapeArea(untouched, () => {
    throw new Error('geometry engine is not linked');
  });
  assert.equal(kept, false);
  assert.equal(untouched.enginePixels, undefined);
});

test('a regular polygon asks for the inscribed ring, not the bounding box', async () => {
  const polygon = { type: 'polygon', x: 0, y: 0, width: 2, height: 2, sides: 4 };
  let sent = null;
  await refineShapeArea(polygon, (_command, rings) => {
    sent = rings.parts[0];
    return 2;
  });
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((point) => point.map((value) => Math.round(value * 1e6) / 1e6)), [
    [1, 0],
    [2, 1],
    [1, 2],
    [0, 1],
  ]);
  assert.equal(polygon.enginePixels, 2);
});

test('a self-crossing area keeps the drawing scale when the shoelace total is zero', async () => {
  openBarePage();
  state.documents[0].measureScale = { pixelsPerUnit: 10, unit: 'mm' };
  const annotation = {
    type: 'measureArea',
    page: 1,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
    measureValue: 0,
    measureUnit: 'mm²',
    measureText: '0',
  };
  const changed = await refineMeasureArea(annotation, () => 1);
  assert.equal(changed, true);
  assert.ok(Math.abs(annotation.measureValue - 0.01) < 1e-12, String(annotation.measureValue));
  assert.equal(annotation.measureUnit, 'mm²');
});

test('a committed offset uses the engine line and drops the request', async () => {
  const annotation = {
    type: 'line',
    startX: 0,
    startY: 0,
    endX: 10,
    endY: 0,
    offsetPending: true,
    offsetDistance: 2,
    offsetSide: 1,
    offsetClosed: false,
    offsetKind: 'line',
    offsetSourcePoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
  };
  const changed = await refineOffset(annotation, (command, payload) => {
    assert.equal(command, 'geos_offset_curve');
    assert.equal(payload.side, 1);
    assert.equal(payload.distance, 2);
    assert.equal(payload.closed, false);
    return [[0, -2], [10, -2]];
  });
  assert.equal(changed, true);
  assert.equal(annotation.startY, -2);
  assert.equal(annotation.endY, -2);
  assert.equal(annotation.offsetPending, false);
  assert.equal(annotation.offsetSourcePoints, undefined);
});

test('a missing offset command keeps the JavaScript curve', async () => {
  const annotation = {
    type: 'line',
    startX: 0,
    startY: 0,
    endX: 10,
    endY: 0,
    offsetPending: true,
    offsetDistance: 2,
    offsetSide: 1,
    offsetKind: 'line',
    offsetSourcePoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
  };
  const changed = await refineOffset(annotation, () => {
    throw new Error('geometry engine is not linked');
  });
  assert.equal(changed, false);
  assert.equal(annotation.startY, 0);
  assert.equal(annotation.endY, 0);
  assert.equal(annotation.offsetPending, false);
});

// Two tabs with different page scales; the engine answers after a tab switch.
function openTwoTabs() {
  const area = {
    id: 'area', type: 'measureArea', page: 1,
    points: square(0, 0, 10), holes: [square(5, 0, 10)],
    measureValue: 0, measureUnit: 'mm²', measureText: '',
  };
  const own = { id: 'own', currentPage: 1, annotations: [area], measureScale: null,
    pageScales: { 1: { pixelsPerUnit: 2, unit: 'mm' } } };
  const other = { id: 'other', currentPage: 1, annotations: [], measureScale: null,
    pageScales: { 1: { pixelsPerUnit: 10, unit: 'm' } } };
  state.documents = [own, other];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  return { area, own, other };
}

function deferredEngine() {
  let answer;
  const result = new Promise((resolve) => { answer = resolve; });
  return { invoke: () => result, answer };
}

test('an engine area that arrives after a tab switch uses the scale of its own document', async () => {
  const { area } = openTwoTabs();
  const engine = deferredEngine();
  const refining = refineMeasureArea(area, engine.invoke);
  state.activeDocumentIndex = 1;
  engine.answer(150);
  assert.equal(await refining, true);
  assert.equal(area.measureUnit, 'mm²');
  assert.equal(area.measureValue, 150 / 4);
});

test('an engine area for an outline edited meanwhile is not written', async () => {
  const { area } = openTwoTabs();
  const engine = deferredEngine();
  const refining = refineMeasureArea(area, engine.invoke);
  area.points = square(0, 0, 20);
  engine.answer(150);
  assert.equal(await refining, false);
  assert.equal(area.measureValue, 0);
});

test('an engine area for a closed document is not written', async () => {
  const { area, other } = openTwoTabs();
  const engine = deferredEngine();
  const refining = refineMeasureArea(area, engine.invoke);
  state.documents = [other];
  state.activeDocumentIndex = 0;
  engine.answer(150);
  assert.equal(await refining, false);
  assert.equal(area.measureValue, 0);
});

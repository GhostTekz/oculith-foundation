import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const { recalculateAllMeasurements, applyPageScale } = await import('./measurement.js');
const { invalidateScaleRegionCache } = await import('./scale-region.js');
const { createMeasurePerimeterAnnotation, createMeasureAreaAnnotation } = await import('../tools/annotation-creators.js');
const { createAnnotation } = await import('./factory.js');
const {
  asMeasureKind, defaultVolumeDepth, createArcMeasurement, createRadius3Measurement,
  createPolylengthMeasurement, createVolumeMeasurement,
} = await import('../tools/measure-extra-creators.js');
const extras = await import('./measure-extras.js');
const { sumMeasurements } = await import('../quantities/measurement-summary.js');
const { markupCsv, markupSummaryRows } = await import('./markup-csv.js');
const { readFile } = await import('node:fs/promises');
const { storeShowProperties, updateAnnotProp, annotProps } = await import('../solid/stores/propertiesStore.js');
const { getAnnotationDisplayName } = await import('../utils/helpers.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function openDocument({ measureScale = null, annotations = [] } = {}) {
  state.documents = [{ id: `extras-${Math.random()}`, currentPage: 1, annotations, measureScale,
    selectedAnnotations: [], selectedAnnotation: null }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  state.preferences.measureVolumeDepth = undefined;
  invalidateScaleRegionCache();
  return state.documents[0];
}

// 1 pt = 100 mm (pixelsPerUnit 0.01): 100 pt is 10 m.
const MM_100 = { pixelsPerUnit: 0.01, unit: 'mm' };
const L_POINTS = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }];

test('polylength gives the total and every segment in the calibrated unit', () => {
  openDocument({ measureScale: MM_100 });
  const ann = asMeasureKind(createMeasurePerimeterAnnotation(L_POINTS), 'polylength', { measureShowSegments: true });
  assert.equal(extras.measureKindType(ann), 'measurePolylength');
  close(ann.measureValue, 7000);
  assert.equal(ann.measureUnit, 'mm');
  assert.deepEqual(ann.measureSegmentValues.map(Math.round), [3000, 4000]);
  assert.deepEqual(ann.measureSegmentTexts, ['3000 mm', '4000 mm']);
  assert.equal(ann.measureText, '7000 mm');
  const labels = extras.segmentLabels(ann);
  assert.equal(labels.length, 2);
  assert.deepEqual([labels[1].x, labels[1].y], [30, 20]);
});

test('an uncalibrated polylength keeps page points and the warning', () => {
  openDocument();
  const ann = asMeasureKind(createMeasurePerimeterAnnotation(L_POINTS), 'polylength', { measureShowSegments: true });
  assert.equal(ann.measureUnit, 'pt');
  assert.equal(ann.measureCalibrated, false);
  assert.match(ann.measureText, /^Scale not set · 70 pt$/u);
  assert.deepEqual(ann.measureSegmentTexts, ['30 pt', '40 pt']);
});

test('volume is area times depth in unit³, shown in m³ and follows a scale change', () => {
  const doc = openDocument({ measureScale: MM_100 });
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const ann = asMeasureKind(createMeasureAreaAnnotation(square), 'volume',
    { measureDepth: 0.3, measureDepthUnit: 'm' });
  doc.annotations.push(ann);
  assert.equal(extras.measureKindType(ann), 'measureVolume');
  close(ann.measureValue, 1e8); // the area stays the measure value (quantities read it as area)
  assert.equal(ann.measureUnit, 'mm²');
  close(ann.measureVolumeValue, 3e10);
  assert.equal(ann.measureVolumeUnit, 'mm³');
  assert.equal(ann.measureText, '30.00 m³');
  applyPageScale({ pixelsPerUnit: 0.02, unit: 'mm' }, 'current');
  close(ann.measureVolumeValue, 0.75e10);
  assert.equal(ann.measureText, '7.50 m³');
  applyPageScale(null, 'current');
  assert.equal(ann.measureVolumeUnit, undefined, 'a metre depth cannot multiply a page-point area');
  assert.match(ann.measureText, /^Scale not set · Depth unit does not match scale$/u);
});

test('volume without a depth says so instead of inventing one', () => {
  openDocument({ measureScale: MM_100 });
  const ann = asMeasureKind(createMeasureAreaAnnotation([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), 'volume');
  assert.equal(ann.measureVolumeValue, undefined);
  assert.equal(ann.measureText, 'Depth not set');
});

test('the Volume tool starts with the last entered depth', () => {
  openDocument({ measureScale: MM_100 });
  state.preferences.measureVolumeDepth = 250;
  state.preferences.measureVolumeDepthUnit = 'mm';
  assert.deepEqual(defaultVolumeDepth(state.preferences), { measureDepth: 250, measureDepthUnit: 'mm' });
  state.preferences.measureVolumeDepth = undefined;
  assert.deepEqual(defaultVolumeDepth(state.preferences), {});
});

test('length with depth gives a wall area and slope adjusts the true length', () => {
  openDocument({ measureScale: MM_100 });
  const ann = createAnnotation({ type: 'measureDistance', page: 1, startX: 0, startY: 0, endX: 30, endY: 0,
    measureDepth: 2400 });
  extras.setMeasureExtraProp(ann, 'measureSlopeMode', 'degree');
  extras.setMeasureExtraProp(ann, 'measureSlope', '60');
  state.documents[0].annotations.push(ann);
  recalculateAllMeasurements();
  close(ann.measureBaseValue, 3000);
  close(ann.measureValue, 6000);
  close(ann.measureWallAreaValue, 6000 * 2400);
  assert.equal(ann.measureWallAreaUnit, 'mm²');
  assert.equal(ann.measureText, '6000 · Wall 14.40 m²');
  extras.setMeasureExtraProp(ann, 'measureCaption', ['length', 'depth', 'slope']);
  recalculateAllMeasurements();
  assert.equal(ann.measureText, '6000 · D 2400 mm · Slope 60°');
});

test('slope modes: grade and pitch give the sloped factor', () => {
  close(extras.slopeFactor('grade', 100), Math.SQRT2);
  close(extras.slopeFactor('pitch', 12), Math.SQRT2);
  close(extras.slopeFactor('degree', 45), Math.SQRT2);
  assert.equal(extras.slopeFactor('degree', 90), 1);
  assert.equal(extras.slopeFactor('pitch', -1), 1);
});

test('arc length from three points is r·θ, not the chord sum, and keeps its radius', () => {
  openDocument({ measureScale: { pixelsPerUnit: 1, unit: 'mm' } });
  const ann = createArcMeasurement({ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 });
  assert.equal(extras.measureKindType(ann), 'measureArc');
  assert.equal(ann.points.length, extras.ARC_SEGMENTS + 1);
  close(ann.measureValue, 50 * Math.PI, 1e-9);
  assert.equal(ann.measureText, `${Math.round(50 * Math.PI)} mm · R 50 mm`);
  // The middle stored point is on the arc: the arc survives a move.
  const moved = { ...ann, points: ann.points.map(p => ({ x: p.x + 10, y: p.y + 5 })) };
  const patch = extras.computeMeasureExtras(moved, { pixelsPerUnit: 1, unit: 'mm', calibrated: true },
    { formatMeasurement: (m) => `${m.value}`, formatDimensionText: (m) => `${m.value}` });
  close(patch.measureValue, 50 * Math.PI, 1e-9);
  assert.equal(extras.circleFrom3Points({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }), null);
});

test('3-point radius dimensions centre to the last point', () => {
  openDocument({ measureScale: { pixelsPerUnit: 1, unit: 'mm' } });
  const ann = createRadius3Measurement({ x: 140, y: 100 }, { x: 100, y: 140 }, { x: 60, y: 100 });
  assert.equal(ann.type, 'measureDistance');
  assert.equal(extras.measureKindType(ann), 'measureRadius');
  close(ann.startX, 100); close(ann.startY, 100);
  close(ann.measureValue, 40);
  assert.equal(ann.measureText, 'R 40');
  state.documents[0].annotations.push(ann);
  recalculateAllMeasurements();
  assert.equal(ann.measureText, 'R 40', 'a scale refresh keeps the radius label');
});

test('centroid marker is the area-weighted centroid', () => {
  const lShape = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
  const c = extras.polygonCentroid(lShape);
  close(c.x, 50 / 6); close(c.y, 50 / 6);
  assert.equal(extras.centroidMarker({ type: 'measureArea', points: lShape }), null);
  assert.ok(extras.centroidMarker({ type: 'measureArea', points: lShape, measureShowCentroid: true }));
});

test('totals never mix units: volumes sum unit³ and refuse mixed sources', () => {
  openDocument({ measureScale: MM_100 });
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const a = asMeasureKind(createMeasureAreaAnnotation(sq), 'volume', { measureDepth: 100, measureDepthUnit: 'mm' });
  const b = asMeasureKind(createMeasureAreaAnnotation(sq), 'volume', { measureDepth: 100, measureDepthUnit: 'mm' });
  const total = sumMeasurements([a, b].map(extras.summaryValue));
  assert.equal(total.unit, 'mm³');
  close(total.value, 2 * 1e6 * 100);
  openDocument();
  const c = asMeasureKind(createMeasureAreaAnnotation(sq), 'volume', { measureDepth: 100 });
  assert.equal(c.measureVolumeUnit, 'pt³');
  assert.equal(sumMeasurements([a, c].map(extras.summaryValue)), null);
});

test('markups list, CSV and PDF rows name the new types with their unit', () => {
  openDocument({ measureScale: MM_100 });
  const poly = asMeasureKind(createMeasurePerimeterAnnotation(L_POINTS), 'polylength');
  const vol = asMeasureKind(createMeasureAreaAnnotation([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]),
    'volume', { measureDepth: 1, measureDepthUnit: 'm' });
  const rows = markupSummaryRows([poly, vol]);
  assert.deepEqual(rows.map(r => r.type), ['measurePolylength', 'measureVolume']);
  assert.equal(rows[1].measurementText, '50.00 m³');
  const csv = markupCsv([poly, vol]);
  assert.match(csv, /"measureVolume".*"50\.00 m³","UNVERIFIED"/u);
  assert.equal(getAnnotationDisplayName(poly, []), 'Polylength');
  assert.equal(getAnnotationDisplayName(vol, []), 'Volume');
});

test('every new tool name is registered and the kind creators set their kind', async () => {
  const registry = await readFile(new URL('../tools/tools/index.js', import.meta.url), 'utf8');
  const registered = new Set([...registry.matchAll(/registerTool\('([^']+)'/gu)].map(m => m[1]));
  // The Measure workflow tab and Tools > Measure run the tools.measure.*
  // commands (commands/tools.js), which select the tool: one implementation.
  const ribbon = await readFile(new URL('../solid/commands/menus.js', import.meta.url), 'utf8');
  const commands = await readFile(new URL('../solid/commands/tools.js', import.meta.url), 'utf8');
  const table = commands.slice(commands.indexOf('const MEASURE_TOOLS = ['), commands.indexOf('];', commands.indexOf('const MEASURE_TOOLS = [')));
  const toolOf = new Map([...table.matchAll(/\['(\w+)', '(\w+)', \w+\]/gu)].map(m => [m[1], m[2]]));
  const used = [...ribbon.matchAll(/'tools\.measure\.(\w+)'/gu)].map(m => toolOf.get(m[1])).filter(Boolean);
  for (const name of ['measurePolylength', 'measureVolume', 'measureArc', 'measureRadius3']) {
    assert.ok(used.includes(name), `${name} is in Tools > Measure`);
  }
  for (const name of used) assert.ok(registered.has(name), `${name} is registered`);
  openDocument({ measureScale: MM_100 });
  const poly = createPolylengthMeasurement(L_POINTS.map(p => ({ ...p })));
  assert.equal(extras.measureKindType(poly), 'measurePolylength');
  assert.equal(poly.measureShowSegments, true);
  state.preferences.measureVolumeDepth = 120;
  const vol = createVolumeMeasurement([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(extras.measureKindType(vol), 'measureVolume');
  assert.equal(vol.measureDepth, 120);
});

test('the properties panel edits depth and recalculates the volume', () => {
  const doc = openDocument({ measureScale: MM_100 });
  const ann = asMeasureKind(createMeasureAreaAnnotation([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]), 'volume');
  doc.annotations.push(ann);
  doc.selectedAnnotation = ann; doc.selectedAnnotations = [ann];
  storeShowProperties(ann);
  updateAnnotProp('measureDepthUnit', 'mm');
  updateAnnotProp('measureDepth', '200');
  close(ann.measureVolumeValue, 1e8 * 200);
  assert.equal(ann.measureText, '20.00 m³');
  assert.equal(annotProps.measureExtraValues, '20.00 m³');
  assert.equal(state.preferences.measureVolumeDepth, 200, 'the next Volume starts with this depth');
  updateAnnotProp('measureCaption', ['area', 'volume', 'depth']);
  assert.equal(ann.measureText, '100.00 m² · 20.00 m³ · D 200 mm');
  updateAnnotProp('measureShowCentroid', true);
  assert.equal(ann.measureShowCentroid, true);
});

test('switching every extra off restores the plain measurement', () => {
  openDocument({ measureScale: MM_100 });
  const ann = createAnnotation({ type: 'measureDistance', page: 1, startX: 0, startY: 0, endX: 30, endY: 0, measureDepth: 1000 });
  state.documents[0].annotations.push(ann);
  recalculateAllMeasurements();
  assert.ok(ann.measureWallAreaValue > 0);
  extras.setMeasureExtraProp(ann, 'measureDepth', '');
  recalculateAllMeasurements();
  assert.equal(ann.measureWallAreaValue, undefined);
  assert.equal(ann.measureText, '3000');
});

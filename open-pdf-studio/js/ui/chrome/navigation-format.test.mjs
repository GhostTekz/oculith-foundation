// Navigation bar and status bar readouts (navigation-format.js): the page
// field with and without PDF page labels, the page size, the plan-review page
// scale text, cursor coordinates calibrated vs uncalibrated, and the content
// dimmer / dark-mode filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageLabel, formatPageField, parsePageInput, paperUnitFor, formatPageSize, pageScaleOf, scaleLabel,
  formatCursorCoords, contentFilterCss, clampDimmer, DIMMER_MAX,
} from './navigation-format.js';

const LABELS = ['A-101', 'A-102', 'A-103'];

test('page field shows the page label with "n of N", or just "n of N"', () => {
  assert.equal(formatPageField(1, 3, LABELS), 'A-101 (1 of 3)');
  assert.equal(formatPageField(2, 3, null), '2 of 3');
  assert.equal(formatPageField(2, 3, ['1', '2', '3']), '2 of 3', 'a label equal to the number adds nothing');
  assert.equal(formatPageField(2, 3, ['', ' ', 'x']), '2 of 3');
  assert.equal(formatPageField(2, 3, LABELS, (p, n) => `${p} van ${n}`), 'A-102 (2 van 3)');
  assert.equal(formatPageField(1, 0, LABELS), '');
  assert.equal(pageLabel(LABELS, 4), null);
});

test('page field parses labels, numbers and its own text; out of range is null', () => {
  assert.equal(parsePageInput('A-102', 3, LABELS), 2);
  assert.equal(parsePageInput(' a-103 ', 3, LABELS), 3, 'labels match case-insensitively');
  assert.equal(parsePageInput('2', 3, LABELS), 2);
  assert.equal(parsePageInput('2', 3, null), 2);
  assert.equal(parsePageInput('A-101 (1 of 3)', 3, LABELS), 1, 'unchanged field text');
  assert.equal(parsePageInput('3 of 3', 3, null), 3);
  assert.equal(parsePageInput('2 van 3', 3, null), 2, 'translated field text');
  assert.equal(parsePageInput('4', 3, LABELS), null);
  assert.equal(parsePageInput('0', 3, null), null);
  assert.equal(parsePageInput('-1', 3, null), null);
  assert.equal(parsePageInput('A-999', 3, LABELS), null);
  assert.equal(parsePageInput('', 3, LABELS), null);
  assert.equal(parsePageInput('1.5', 3, null), null);
  assert.equal(parsePageInput('2', 0, null), null, 'no pages');
  // A label wins over a number: in a PDF labelled i, ii, 1, 2 "2" is page 4.
  assert.equal(parsePageInput('2', 4, ['i', 'ii', '1', '2']), 4);
  assert.equal(parsePageInput('ii', 4, ['i', 'ii', '1', '2']), 2);
});

test('page size in inches or millimetres, as the page lies', () => {
  assert.equal(formatPageSize(1224, 792, 'in'), '17.00 x 11.00 in');
  assert.equal(formatPageSize(612, 792, 'in'), '8.50 x 11.00 in');
  assert.equal(formatPageSize(1224, 792, 'in', 90), '11.00 x 17.00 in');
  assert.equal(formatPageSize(1224, 792, 'in', 180), '17.00 x 11.00 in');
  assert.equal(formatPageSize(595.28, 841.89, 'mm'), '210 x 297 mm');
  assert.equal(formatPageSize(0, 792, 'in'), '');
});

test('paper unit follows the scale system, else the language', () => {
  assert.equal(paperUnitFor('ft', 'nl'), 'in');
  assert.equal(paperUnitFor('m', 'en'), 'mm');
  assert.equal(paperUnitFor(undefined, 'en'), 'in');
  assert.equal(paperUnitFor('pt', 'nl'), 'mm');
});

test('page scale text uses the external editor preset labels', () => {
  assert.equal(scaleLabel({ pixelsPerUnit: 18, unit: 'ft' }), '1/4" = 1\'-0"');
  assert.equal(scaleLabel({ pixelsPerUnit: 72 / 20, unit: 'ft' }), '1" = 20\'');
  assert.equal(scaleLabel({ pixelsPerUnit: 72 / 25.4 / 100, unit: 'mm' }), '1:100');
  assert.equal(scaleLabel({ pixelsPerUnit: 72 / 25.4 * 10, unit: 'm' }), '1:100');
  assert.equal(scaleLabel({ pixelsPerUnit: 13, unit: 'ft' }), '1 in = 5.538 ft', 'custom imperial: the equation');
  assert.equal(scaleLabel({ pixelsPerUnit: 72 / 25.4 / 53.4, unit: 'mm' }), '1:53.4');
  assert.equal(scaleLabel(null), '');
  assert.equal(scaleLabel({ pixelsPerUnit: 1, unit: 'pt' }), '', 'uncalibrated page points are no scale');
});

test('page scale source: the page scale, else the document scale, else none', () => {
  const doc = { annotations: [], pageScales: { 2: { pixelsPerUnit: 18, unit: 'ft', method: 'ratio' } } };
  assert.equal(pageScaleOf(doc, 2).pixelsPerUnit, 18);
  assert.equal(pageScaleOf(doc, 1), null);
  assert.equal(pageScaleOf({ ...doc, measureScale: { pixelsPerUnit: 3.6, unit: 'ft' } }, 1).pixelsPerUnit, 3.6);
  assert.equal(pageScaleOf(doc, 1, { pixelsPerUnit: 2, unit: 'mm' }).pixelsPerUnit, 2, 'legacy preference last');
  assert.equal(pageScaleOf(null, 1), null);
});

test('cursor coordinates: real lengths with a scale, paper lengths without', () => {
  const quarter = { pixelsPerUnit: 18, unit: 'ft', calibrated: true };
  assert.deepEqual(formatCursorCoords({ x: 144, y: 72 }, quarter), { text: '(8.00, 4.00) ft', calibrated: true, unit: 'ft' });
  // getMeasureScale() without a calibration reports PDF points, uncalibrated.
  const none = { pixelsPerUnit: 1, unit: 'pt', calibrated: false };
  assert.deepEqual(formatCursorCoords({ x: 144, y: 72 }, none, 'in'), { text: '(2.00, 1.00) in', calibrated: false, unit: 'in' });
  assert.deepEqual(formatCursorCoords({ x: 72, y: 36 }, none, 'mm'), { text: '(25.4, 12.7) mm', calibrated: false, unit: 'mm' });
  assert.equal(formatCursorCoords({ x: 72, y: 36 }, null, 'in').calibrated, false);
  assert.equal(formatCursorCoords({ x: -0.001, y: 0 }, null, 'in').text, '(0.00, 0.00) in', 'no "-0.00"');
  assert.equal(formatCursorCoords({ x: 10, y: 10 }, { pixelsPerUnit: 0, unit: 'ft' }, 'in').calibrated, false,
    'an invalid scale is uncalibrated');
  assert.equal(formatCursorCoords(null, quarter), null);
  assert.equal(formatCursorCoords({ x: NaN, y: 1 }, quarter), null);
});

test('dimmer maps the page linearly onto [level, 1]; dark mode inverts after it', () => {
  assert.equal(contentFilterCss(), 'none');
  assert.equal(contentFilterCss({ dimmer: false, level: 0.5 }), 'none');
  const css = contentFilterCss({ dimmer: true, level: 0.5 });
  assert.equal(css, 'contrast(0.3333) brightness(1.5)');
  // contrast(k): c -> (c - 0.5) k + 0.5, then brightness(b): c -> c b.
  const [k, b] = css.match(/[\d.]+/g).map(Number);
  const apply = (c) => ((c - 0.5) * k + 0.5) * b;
  assert.ok(Math.abs(apply(0) - 0.5) < 1e-3, 'black becomes 50 % grey');
  assert.ok(Math.abs(apply(1) - 1) < 1e-3, 'white stays white');
  assert.equal(contentFilterCss({ dark: true }), 'invert(1) hue-rotate(180deg)');
  assert.equal(contentFilterCss({ dimmer: true, level: 0.5, dark: true }), 'contrast(0.3333) brightness(1.5) invert(1) hue-rotate(180deg)');
  assert.equal(clampDimmer(2), DIMMER_MAX);
  assert.equal(clampDimmer(-1), 0);
  assert.equal(clampDimmer('x'), 0.5);
  assert.equal(contentFilterCss({ dimmer: true, level: 0 }), 'none');
});

test('a long page label is shortened so the counter stays visible', () => {
  const long = ['E-501.1 ELECTRICAL LIGHTING AND POWER PLAN LEVEL 1 NORTH WING', 'E-2'];
  assert.equal(formatPageField(1, 565, long), `${long[0]} (1 of 565)`, 'no limit: the full text');
  const cut = formatPageField(1, 565, long, undefined, 26);
  assert.equal(cut, 'E-501.1 ELECTR\u2026 (1 of 565)');
  assert.equal(cut.length, 26);
  assert.equal(formatPageField(2, 565, long, undefined, 26), 'E-2 (2 of 565)', 'a short label is kept');
  assert.equal(formatPageField(1, 565, long, undefined, 14), '1 of 565', 'no room: the counter alone');
  assert.equal(parsePageInput(cut, 565, long), 1, 'the shortened field text still reads back');
  assert.equal(parsePageInput('E-2 (2 of 565)', 565, long), 2);
});

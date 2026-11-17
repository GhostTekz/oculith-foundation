import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { diffAnnotationLists } = await import('./compare-annotations.js');
const { buildCompareChangeReport } = await import('./change-report.js');

const count = (overrides = {}) => ({
  type: 'count', x: 143, y: 257, number: 1, categoryId: 'receptacles',
  markerStyle: 'dot', color: '#e11d48', ...overrides,
});

test('a removed count is reported at its visible marker bounds', () => {
  assert.deepEqual(diffAnnotationLists([count()], []), [{
    type: 'removed', source: 'annotation', annType: 'count', label: 'count: receptacles #1',
    x: 132, y: 246, width: 22, height: 22,
  }]);
});

test('count quantity or category changes are reported without moving the marker', () => {
  const original = count();
  assert.deepEqual(diffAnnotationLists([original], [count()]), []);
  for (const update of [{ number: 2 }, { categoryId: 'lighting' }, { markerStyle: 'symbol', symbolId: 'fixture' }]) {
    const [change] = diffAnnotationLists([original], [count(update)]);
    assert.equal(change.type, 'modified');
    assert.equal(change.annType, 'count');
    assert.deepEqual([change.x, change.y, change.width, change.height], [132, 246, 22, 22]);
    assert.match(change.label, /count: receptacles #1 → /);
  }
});

test('co-located counts match by identity before position when list order changes', () => {
  const receptacle = count();
  const lighting = count({ categoryId: 'lighting', number: 2 });
  assert.deepEqual(diffAnnotationLists([receptacle, lighting], [lighting, receptacle]), []);

  const changed = count({ categoryId: 'lighting', number: 3 });
  const revisions = diffAnnotationLists([receptacle, lighting], [changed, receptacle]);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].type, 'modified');
  assert.equal(revisions[0].label, 'count: lighting #2 → lighting #3');
  const csv = buildCompareChangeReport({ oldPath: 'old.pdf', newPath: 'new.pdf',
    oldPage: 1, newPage: 1, changes: revisions });
  assert.match(csv, /count: lighting #2 → lighting #3/);
});

// ── Appearance: independent colours, text formatting and opacity ────────────

const box = (overrides = {}) => ({
  type: 'rectangle', x: 100, y: 100, width: 80, height: 40,
  color: '#ff0000', strokeColor: '#ff0000', fillColor: '#00ff00', lineWidth: 2, ...overrides,
});
const textbox = (overrides = {}) => ({
  type: 'textbox', x: 300, y: 300, width: 160, height: 40, text: 'GENERAL NOTE',
  color: '#000000', textColor: '#000000', fontFamily: 'Arial', ...overrides,
});
const modified = (before, after) => {
  const changes = diffAnnotationLists([before], [after]);
  return changes.length === 1 && changes[0].type === 'modified';
};

test('a fill-only colour change is reported even when the legacy color is unchanged', () => {
  assert.deepEqual(diffAnnotationLists([box()], [box()]), []);
  assert.ok(modified(box(), box({ fillColor: '#0000ff' })));
});

test('a stroke-only or text-colour change is reported independently', () => {
  assert.ok(modified(box(), box({ strokeColor: '#123456' })));
  assert.ok(modified(textbox(), textbox({ textColor: '#ff00ff' })));
});

test('a bold change is reported for a text box', () => {
  assert.ok(modified(textbox(), textbox({ fontBold: true })));
  // A run that makes only part of the text bold is also a change.
  const runs = [[{ text: 'GENERAL ', bold: false }, { text: 'NOTE', bold: true }]];
  assert.ok(modified(textbox(), textbox({ textRuns: runs })));
});

test('equivalent adjacent text runs are not a change', () => {
  const split = [[{ text: 'GENERAL ' }, { text: 'NOTE' }]];
  assert.deepEqual(diffAnnotationLists([textbox()], [textbox({ textRuns: split })]), []);
});

test('an opacity change is reported', () => {
  assert.ok(modified(box(), box({ opacity: 0.5 })));
  assert.ok(modified(box({ opacity: 0.5 }), box({ opacity: 0.5, fillOpacity: 0.2 })));
});

test('a highlight at the default 0.3 opacity equals an unset highlight opacity', () => {
  const hl = (o = {}) => ({ type: 'highlight', x: 50, y: 50, width: 120, height: 12, color: '#ffff00', ...o });
  assert.deepEqual(diffAnnotationLists([hl()], [hl({ opacity: 0.3 })]), []);
  assert.deepEqual(diffAnnotationLists([hl({ opacity: 0.3 })], [hl()]), []);
  assert.ok(modified(hl(), hl({ opacity: 1 })));
});

test('an implicit text box font size equals an explicit 14', () => {
  assert.deepEqual(diffAnnotationLists([textbox()], [textbox({ fontSize: 14 })]), []);
  assert.ok(modified(textbox(), textbox({ fontSize: 18 })));
});

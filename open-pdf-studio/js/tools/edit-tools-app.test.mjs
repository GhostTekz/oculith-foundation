// WP13 Edit-menu tools against the real state store, hit testing, measure
// scale and undo manager (docs/reference/editor/markup-tools.md): the Undo History jump equals
// N single undos and redo works afterwards; Offset copies measure the typed
// distance on a calibrated sheet and are one undo step named "offset"; the
// selection cycle walks three stacked markups; the lasso picks enclosed (or,
// with Ctrl, touching) markups on its page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { state } = await import('../core/state.ts');
const undo = await import('../core/undo-manager.js');
const { historyRows, undoEntryInfo } = await import('../core/undo-history.js');
const { calculateDistance } = await import('../annotations/measurement.js');
const { getAnnotationBounds } = await import('../core/stores/selection-helpers.ts');
const { nextCycleId, collectStack } = await import('./selection-cycle.js');
const edit = await import('./edit-tools-core.js');

const kloon = (x) => JSON.parse(JSON.stringify(x));

function openen(annotations, extra = {}) {
  state.documents = [{
    id: `doc-${Math.random().toString(36).slice(2, 8)}`, filePath: null, pdfDoc: { numPages: 2 },
    currentPage: 1, scale: 1, viewMode: 'single', annotations,
    selectedAnnotation: null, selectedAnnotations: [],
    undoStack: [], redoStack: [], savedUndoStackLength: 0, modified: false,
    textEdits: [], watermarks: [], bookmarks: [], pageRotations: {}, measureScale: null,
    ...extra,
  }];
  state.activeDocumentIndex = 0;
  return state.documents[0];
}

const vak = (id, x = 0, extra = {}) => ({ id, type: 'box', page: 1, x, y: 0, width: 20, height: 20, ...extra });

// A run of edits through the recorders the tools use.
function bewerkingen(doc) {
  const states = [kloon(doc.annotations)];
  const a = vak('a', 0); doc.annotations.push(a); undo.recordAdd(a); states.push(kloon(doc.annotations));
  const b = vak('b', 50); doc.annotations.push(b); undo.recordAdd(b); states.push(kloon(doc.annotations));
  const before = kloon(a); a.x = 5; a.color = '#ff0000'; undo.recordModify('a', before, a); states.push(kloon(doc.annotations));
  const c = vak('c', 90); const d = vak('d', 120);
  doc.annotations.push(c, d); undo.recordBulkAdd([c, d]); states.push(kloon(doc.annotations));
  const idx = doc.annotations.findIndex((x) => x.id === 'b'); doc.annotations.splice(idx, 1); undo.recordDelete(b, idx); states.push(kloon(doc.annotations));
  return states;
}

test('an Undo History jump of N steps equals N single undos, and redo works afterwards', async () => {
  for (const n of [1, 2, 3, 5]) {
    const single = openen([]);
    const states = bewerkingen(single);
    for (let i = 0; i < n; i++) await undo.undo();
    const viaSingle = kloon(single.annotations);
    assert.deepEqual(viaSingle, states[states.length - 1 - n], `${n} undos`);

    const jumped = openen([]);
    bewerkingen(jumped);
    const rows = historyRows(jumped.undoStack, jumped.redoStack);
    assert.equal(rows.length, 6, 'start row + 5 steps');
    const target = rows.find((r) => r.done && r.steps === n);
    assert.equal(await undo.undoSteps(target.steps), n);
    assert.deepEqual(kloon(jumped.annotations), viaSingle, `jump of ${n} = ${n} undos`);
    assert.equal(jumped.undoStack.length, 5 - n);
    assert.equal(jumped.redoStack.length, n);

    // The undone steps show greyed after the current one; redo one, then the rest.
    const after = historyRows(jumped.undoStack, jumped.redoStack);
    assert.deepEqual(after.filter((r) => !r.done).map((r) => r.steps), Array.from({ length: n }, (_, i) => i + 1));
    await undo.redo();
    assert.deepEqual(kloon(jumped.annotations), states[states.length - n]);
    assert.equal(await undo.redoSteps(99), n - 1, 'stops at the end of the redo stack');
    assert.deepEqual(kloon(jumped.annotations), states[states.length - 1]);
  }
});

test('the start row undoes everything; history entries are named by action and type', async () => {
  const doc = openen([]);
  const states = bewerkingen(doc);
  const names = doc.undoStack.map(undoEntryInfo);
  assert.deepEqual(names.map((i) => i.action), ['add', 'add', 'modify', 'add', 'delete']);
  assert.deepEqual(names.map((i) => i.annotationType), ['box', 'box', 'box', 'box', 'box']);
  assert.equal(names[3].count, 2);
  const start = historyRows(doc.undoStack, doc.redoStack)[0];
  assert.equal(start.start, true);
  await undo.undoSteps(start.steps);
  assert.deepEqual(kloon(doc.annotations), states[0]);
  assert.equal(undoEntryInfo({ type: 'compound', commands: [{ type: 'addAnnotation', annotation: vak('x') }, { type: 'deleteAnnotation', annotation: vak('y') }] }).action, 'edit');
});

test('Offset of a 10 ft line at 2 ft on a 1/4" = 1\'-0" sheet: measured 2 ft away, one named undo step', async () => {
  const line = { id: 'L', type: 'line', page: 1, startX: 100, startY: 300, endX: 280, endY: 300, color: '#000', lineWidth: 1 };
  const doc = openen([line], { measureScale: { pixelsPerUnit: 18, unit: 'ft' } });
  const scale = edit.offsetScaleOf(line);
  assert.deepEqual(scale, { pixelsPerUnit: 18, unit: 'ft', calibrated: true });
  assert.equal(calculateDistance(100, 300, 280, 300, 1).value, 10, 'the source is 10 ft');
  const copy = edit.createOffsetCopy(line, 2 * scale.pixelsPerUnit, -1, doc);
  assert.ok(copy && copy.id !== 'L');
  assert.equal(doc.annotations.length, 2);
  // Measured with the app's own distance: start to start, perpendicular.
  assert.equal(calculateDistance(line.startX, line.startY, copy.startX, copy.startY, 1).value, 2);
  assert.equal(calculateDistance(line.endX, line.endY, copy.endX, copy.endY, 1).value, 2);
  assert.equal(calculateDistance(copy.startX, copy.startY, copy.endX, copy.endY, 1).value, 10);
  const top = doc.undoStack.at(-1);
  assert.equal(undoEntryInfo(top).action, 'offset');
  await undo.undo();
  assert.deepEqual(doc.annotations.map((a) => a.id), ['L']);
  await undo.redo();
  assert.equal(doc.annotations.length, 2);
});

test('Offset of an uncalibrated page is in page points, and area copies re-measure', () => {
  const area = { id: 'A', type: 'measureArea', page: 1, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], measureText: 'old' };
  const doc = openen([area]);
  const scale = edit.offsetScaleOf(area);
  assert.equal(scale.calibrated, false);
  assert.equal(scale.unit, 'pt');
  const copy = edit.createOffsetCopy(area, 10, 1, doc);
  const xs = copy.points.map((p) => p.x);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)].map((v) => Math.round(v * 1e6) / 1e6), [-10, 110], 'side +1 of a clockwise square is outward');
  assert.notEqual(copy.measureText, 'old');
});

test('selection cycle: three stacked markups, top first, wrapping', () => {
  // geometry.js does not load under node (it pulls in the UI); this is its
  // findAnnotationAt contract: top first, page filter, the skip set.
  const doc = openen([vak('bottom', 0), vak('middle', 5), vak('top', 10)]);
  const find = (x, y, page, { skip } = {}) => {
    for (let i = doc.annotations.length - 1; i >= 0; i--) {
      const a = doc.annotations[i];
      if (a.page !== page || skip?.has(a)) continue;
      if (x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) return a;
    }
    return null;
  };
  const hits = collectStack(find, 15, 10, 1);
  assert.deepEqual(hits.map((a) => a.id), ['top', 'middle', 'bottom']);
  let current = hits[0];
  const walked = [current.id];
  for (let i = 0; i < 3; i++) { current = nextCycleId(hits, current); walked.push(current.id); }
  assert.deepEqual(walked, ['top', 'middle', 'bottom', 'top']);
  assert.deepEqual(collectStack(find, 2, 10, 1).map((a) => a.id), ['bottom']);
  assert.deepEqual(collectStack(find, 15, 10, 2), []);
  assert.equal(collectStack(() => doc.annotations[0], 0, 0, 1).length, 1, 'a finder that ignores skip cannot loop');
});

test('lasso: enclosed by default, touching with Ctrl, only on its page', () => {
  const doc = openen([
    vak('in', 10, { y: 10 }),
    vak('half', 80, { y: 10 }),
    { id: 'line', type: 'line', page: 1, startX: 20, startY: 60, endX: 40, endY: 70 },
    vak('other-page', 10, { y: 10, page: 2 }),
  ]);
  const lasso = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 90 }, { x: 0, y: 90 }];
  const ids = (anns) => anns.map((a) => a.id).sort();
  assert.deepEqual(ids(edit.lassoSelection(doc, 1, lasso, { boundsOf: getAnnotationBounds })), ['in', 'line']);
  assert.deepEqual(ids(edit.lassoSelection(doc, 1, lasso, { touching: true, boundsOf: getAnnotationBounds })), ['half', 'in', 'line']);
  assert.deepEqual(ids(edit.lassoSelection(doc, 2, lasso, { boundsOf: getAnnotationBounds })), ['other-page']);
  doc.annotations[0].hidden = true;
  assert.deepEqual(ids(edit.lassoSelection(doc, 1, lasso, { boundsOf: getAnnotationBounds })), ['line'], 'hidden markups are not picked');
});

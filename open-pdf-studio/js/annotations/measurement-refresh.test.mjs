// Measurements follow their scale source: deleting or moving a viewport,
// scale bar or scale region, or pasting a measurement onto a page with
// another scale, recomputes the stored values in the same undo step.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const { applyPageScale } = await import('./measurement.js');
const { invalidateScaleRegionCache } = await import('./scale-region.js');
const { deleteAnnotationsWithUndo } = await import('./mutations.js');
const { copyAnnotations, pasteAnnotationsInPlace } = await import('./clipboard.js');
const { snapshotMeasurements, recordMeasurementRefresh } = await import('./measurement-refresh.js');
const undoManager = await import('../core/undo-manager.js');
const { undoStackOf } = await import('../core/undo-stacks.js');

function openDocument(annotations = []) {
  state.documents = [{ id: `refresh-${Math.random()}`, currentPage: 1, scale: 1, pdfDoc: { numPages: 2 },
    viewMode: 'single', annotations, measureScale: null, detectedScale: null,
    selectedAnnotations: [], selectedAnnotation: null,
    undoStack: [], redoStack: [], savedUndoStackLength: 0 }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  state.preferences.measureRounding = 'none';
  invalidateScaleRegionCache();
  return state.documents[0];
}

const line = (id, page, length) => ({ id, type: 'measureDistance', page, startX: 0, startY: 0, endX: length, endY: 0 });
// 1:1 in mm: one millimetre on paper is 72 / 25.4 points.
const region = (id, x) => ({ id, type: 'scaleRegion', page: 1, x, y: -10, width: 200, height: 20,
  scaleString: '1:1', units: 'mm' });

test('deleting a scale region recomputes the measurement it covered, undone in one step', async () => {
  const doc = openDocument([region('r', -10), line('m', 1, 72)]);
  applyPageScale(null, [1]);
  const m = doc.annotations.find(a => a.id === 'm');
  assert.equal(Math.round(m.measureValue * 10) / 10, 25.4);
  assert.equal(m.measureUnit, 'mm');
  const depth = undoStackOf(doc).length;

  deleteAnnotationsWithUndo(doc, [doc.annotations.find(a => a.id === 'r')]);
  assert.equal(m.measureUnit, 'pt', 'without its region the line is no longer calibrated');
  assert.equal(undoStackOf(doc).length, depth + 1, 'delete and recompute are one undo step');

  await undoManager.undo();
  const back = doc.annotations.find(a => a.id === 'm');
  assert.ok(doc.annotations.some(a => a.id === 'r'));
  assert.equal(back.measureUnit, 'mm');
  assert.equal(Math.round(back.measureValue * 10) / 10, 25.4);
});

test('moving a scale region off a measurement recomputes it in the move transaction', () => {
  const doc = openDocument([region('r', -10), line('m', 1, 72)]);
  applyPageScale(null, [1]);
  const m = doc.annotations.find(a => a.id === 'm');
  const r = doc.annotations.find(a => a.id === 'r');
  const snapshot = snapshotMeasurements(doc);
  undoManager.beginUndoTransaction();
  const before = { ...r };
  r.x = 500;
  undoManager.recordModify(r.id, before, r);
  assert.equal(recordMeasurementRefresh(doc, snapshot), 1);
  undoManager.endUndoTransaction();
  assert.equal(m.measureUnit, 'pt');
});

test('a measurement pasted onto a page with another scale takes that scale', async () => {
  const doc = openDocument([line('m', 1, 72)]);
  applyPageScale({ pixelsPerUnit: 1, unit: 'mm' }, [1]);
  applyPageScale({ pixelsPerUnit: 4, unit: 'mm' }, [2]);
  assert.equal(doc.annotations[0].measureValue, 72);
  copyAnnotations([doc.annotations[0]]);
  doc.currentPage = 2;
  const depth = undoStackOf(doc).length;
  pasteAnnotationsInPlace();
  const pasted = doc.annotations[1];
  assert.equal(pasted.page, 2);
  assert.equal(pasted.measureValue, 18);
  assert.equal(undoStackOf(doc).length, depth + 1);
  await undoManager.undo();
  assert.equal(doc.annotations.length, 1);
  await undoManager.redo();
  assert.equal(doc.annotations[1].measureValue, 18, 'redo brings back the recomputed value');
});

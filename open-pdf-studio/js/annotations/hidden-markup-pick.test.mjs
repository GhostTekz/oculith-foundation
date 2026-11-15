// A markup hidden with the Markups List row eye (its own `hidden` flag, saved
// as /F bit 2, docs/reference/editor/layers.md) is not drawn and cannot be hit on the
// canvas: no click, no Select All, no grips. The Markups List can still
// select it. Real geometry, view filters and state run here.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();

const { state, selectAllOnPage } = await import('../core/state.js');
const { createAnnotation } = await import('./factory.js');
const { addLayer } = await import('./annotatie-lagen.js');
const { findAnnotationAt } = await import('./geometry.js');
const { isAnnotationHiddenInView, isAnnotationHiddenInOutput, isAnnotationPickableInView } = await import('./view-filters.js');

const box = (over = {}) => createAnnotation({ type: 'box', page: 1, x: 10, y: 10, width: 40, height: 30,
  color: '#000000', strokeColor: '#000000', lineWidth: 1, opacity: 1, ...over });

function opzet() {
  state.documents = [{ id: `hid-${Math.random().toString(36).slice(2, 7)}`, filePath: 'C:/hid/in.pdf',
    currentPage: 1, scale: 1, viewMode: 'single', annotations: [], selectedAnnotations: [], selectedAnnotation: null,
    undoStack: [], redoStack: [], savedUndoStackLength: 0, pdfDoc: { numPages: 1 }, pageRotations: {},
    _annotationPagesReady: new Set([1]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  state.currentTool = 'select';
  const doc = state.documents[0];
  const uit = addLayer(doc, { name: 'Off', visible: false }).layer;
  doc.annotations.push(box({ x: 10 }), box({ x: 110, hidden: true }), box({ x: 210, layer: uit.id }));
  const [vrij, verborgen, opUitLaag] = doc.annotations;
  return { doc, vrij, verborgen, opUitLaag };
}

test('a hidden markup is not drawn, not printed or exported, and not pickable', () => {
  const { vrij, verborgen, opUitLaag } = opzet();
  assert.deepEqual([vrij, verborgen, opUitLaag].map(isAnnotationHiddenInView), [false, true, true]);
  assert.deepEqual([vrij, verborgen, opUitLaag].map(isAnnotationHiddenInOutput), [false, true, true]);
  assert.deepEqual([vrij, verborgen, opUitLaag].map(isAnnotationPickableInView), [true, false, false]);
});

test('click and Select All skip a hidden markup; shown again it is hit as before', () => {
  const { doc, vrij, verborgen } = opzet();
  assert.equal(findAnnotationAt(10, 25, 1)?.id, vrij.id);
  assert.equal(findAnnotationAt(110, 25, 1), null, 'hidden: no hit');
  selectAllOnPage();
  assert.deepEqual(doc.selectedAnnotations.map((a) => a.id), [vrij.id]);
  delete verborgen.hidden;
  assert.equal(findAnnotationAt(110, 25, 1)?.id, verborgen.id);
  selectAllOnPage();
  assert.equal(doc.selectedAnnotations.length, 2, 'the markup on the hidden layer stays out');
});

test('a hidden markup selected in the Markups List gets no grips on the canvas', () => {
  // The select tool only looks for a grip on a pickable selection; the
  // renderer draws no frame for a markup the view hides (both views).
  const kies = readFileSync(new URL('../tools/tools/select-tool.js', import.meta.url), 'utf8');
  assert.match(kies, /const selAnn = selAnns\.length === 1 && isAnnotationPickableInView\(selAnns\[0\]\) \? selAnns\[0\] : null;/);
  assert.match(kies, /const hoverAnn = selAnns\.length === 1 && isAnnotationPickableInView\(selAnns\[0\]\) \? selAnns\[0\] : null;/);
  const teken = readFileSync(new URL('./rendering.js', import.meta.url), 'utf8');
  const grepen = teken.match(/if \(isAnnotationHiddenInView\(ann\)\) continue;\r?\n\s+drawSelectionHandles\(/g) || [];
  assert.equal(grepen.length, 2, 'single page and continuous');
});

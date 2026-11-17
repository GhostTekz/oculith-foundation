// Verborgen en vergrendelde markeringslagen (#468) zoals in the external editor: een
// verborgen laag wordt niet getekend, niet afgedrukt en is niet te selecteren;
// een vergrendelde laag is zichtbaar maar niet te bewerken. Hier de paden die
// een markering raken: aanklikken, alles selecteren, Format Painter, Multiply,
// verwijderen (Delete, knippen, contextmenu) en pijltjes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
// Schermcomponenten (.jsx) die de gereedschappen meetrekken, leeg laden.
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();

const { state, selectAllOnPage } = await import('../core/state.js');
const { createAnnotation, cloneAnnotation } = await import('./factory.js');
const { recordModify, undo } = await import('../core/undo-manager.js');
const { addLayer, updateLayer } = await import('./annotatie-lagen.js');
const { findAnnotationAt } = await import('./geometry.js');
const { isAnnotationHiddenInView, isAnnotationHiddenInOutput, isAnnotationPickableInView } = await import('./view-filters.js');
const { deleteAnnotationsWithUndo } = await import('./mutations.js');
const { formatPainterTool, armFormatPainter } = await import('../tools/tools/format-painter-tool.js');
const { multiplySelection, multiplyTargets } = await import('../tools/multiply.js');

const box = (over = {}) => createAnnotation({ type: 'box', page: 1, x: 10, y: 10, width: 40, height: 30,
  color: '#000000', strokeColor: '#000000', lineWidth: 1, opacity: 1, ...over });

// Drie vakken naast elkaar: vrij, op een verborgen laag, op een vergrendelde laag.
function opzet() {
  state.documents = [{ id: `lk-${Math.random().toString(36).slice(2, 7)}`, filePath: 'C:/lk/in.pdf',
    currentPage: 1, scale: 1, viewMode: 'single', annotations: [], selectedAnnotations: [], selectedAnnotation: null,
    undoStack: [], redoStack: [], savedUndoStackLength: 0, pdfDoc: { numPages: 1 }, pageRotations: {},
    _annotationPagesReady: new Set([1]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  state.currentTool = 'select';
  const doc = state.documents[0];
  const uit = addLayer(doc, { name: 'Uit', visible: false }).layer;
  const slot = addLayer(doc, { name: 'Slot', locked: true }).layer;
  doc.annotations.push(box({ x: 10 }), box({ x: 110, layer: uit.id }), box({ x: 210, layer: slot.id }));
  const [vrij, verborgen, vergrendeld] = doc.annotations;
  return { doc, vrij, verborgen, vergrendeld, uit, slot };
}

test('verborgen: niet getekend, niet in afdruk/export, niet te selecteren; vergrendeld: getekend en afgedrukt, niet te selecteren', () => {
  const { vrij, verborgen, vergrendeld } = opzet();
  assert.deepEqual([vrij, verborgen, vergrendeld].map(isAnnotationHiddenInView), [false, true, false]);
  assert.deepEqual([vrij, verborgen, vergrendeld].map(isAnnotationHiddenInOutput), [false, true, false]);
  assert.deepEqual([vrij, verborgen, vergrendeld].map(isAnnotationPickableInView), [true, false, false]);
});

test('aanklikken en alles selecteren slaan verborgen en vergrendelde lagen over', () => {
  const { doc, vrij, uit, slot } = opzet();
  assert.equal(findAnnotationAt(10, 25, 1)?.id, vrij.id);
  assert.equal(findAnnotationAt(110, 25, 1), null, 'verborgen laag: geen treffer');
  assert.equal(findAnnotationAt(210, 25, 1), null, 'vergrendelde laag: geen treffer');
  selectAllOnPage();
  assert.deepEqual(doc.selectedAnnotations.map((a) => a.id), [vrij.id]);
  // Tegenproef: ontgrendeld en weer aan zijn ze gewoon te raken.
  updateLayer(doc, slot.id, { locked: false });
  updateLayer(doc, uit.id, { visible: true });
  assert.ok(findAnnotationAt(210, 25, 1));
  assert.ok(findAnnotationAt(110, 25, 1));
  selectAllOnPage();
  assert.equal(doc.selectedAnnotations.length, 3);
});

test('Format Painter laat een markering op een vergrendelde of verborgen laag ongemoeid', () => {
  const { doc, vrij, verborgen, vergrendeld } = opzet();
  vrij.strokeColor = '#ff0000';
  vrij.lineWidth = 5;
  armFormatPainter([vrij]);
  let hit = null;
  // Ook als een treffer er toch doorheen komt (de tool controleert zelf).
  const ctx = { x: 0, y: 0, findAnnotationAt: () => hit, cloneAnnotation, recordModify, redraw() {} };
  for (const doel of [vergrendeld, verborgen]) { hit = doel; formatPainterTool.onPointerDown(ctx, { button: 0 }); }
  assert.equal(vergrendeld.strokeColor, '#000000');
  assert.equal(verborgen.lineWidth, 1);
  assert.equal(doc.undoStack.length, 0, 'geen undo-stap');
  formatPainterTool.onDeactivate();
});

test('Multiply kopieert geen markeringen van een vergrendelde of verborgen laag', () => {
  const { doc, vrij, verborgen, vergrendeld } = opzet();
  doc.selectedAnnotations = [vrij, verborgen, vergrendeld];
  assert.deepEqual(multiplyTargets(doc).map((a) => a.id), [vrij.id]);
  const kopie = multiplySelection({ count: 2, dx: 0, dy: 50 });
  assert.equal(kopie.length, 2, 'alleen de vrije markering, twee keer');
  assert.equal(doc.annotations.length, 5);
});

test('verwijderen laat markeringen op een vergrendelde laag staan, in één undo-stap voor de rest', () => {
  const { doc, vrij, vergrendeld } = opzet();
  const weg = deleteAnnotationsWithUndo(doc, [vrij, vergrendeld]);
  assert.deepEqual(weg.map((a) => a.id), [vrij.id]);
  assert.ok(state.documents[0].annotations.some((a) => a.id === vergrendeld.id), 'vergrendeld blijft');
  assert.equal(deleteAnnotationsWithUndo(state.documents[0], [vergrendeld]).length, 0);
  undo();
  assert.equal(state.documents[0].annotations.length, 3);
});

test('Delete, knippen en pijltjes op het canvas nemen alleen bewerkbare lagen mee', () => {
  const bron = readFileSync(new URL('../tools/keyboard-handlers.js', import.meta.url), 'utf8');
  const del = bron.slice(bron.indexOf("} else if (e.key === 'Delete') {"));
  assert.match(del.slice(0, 1200), /editableOnLayers\(delDoc, \[\.\.\.delDoc\.selectedAnnotations\]\)/);
  assert.match(bron, /const cutKeuze = cutDoc \? editableOnLayers\(cutDoc, /);
  assert.match(bron, /expandCorrectionGroups\(cutDoc\.annotations, cutKeuze\)/);
  const pijl = bron.slice(bron.indexOf('const movable ='));
  assert.match(pijl.slice(0, 200), /editableOnLayers\(/);
});

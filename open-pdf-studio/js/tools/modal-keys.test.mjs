// Global keys and open dialogs: while a modal is open, keys do not act on the
// drawing behind it; a focused <select> keeps its arrow keys; a Delete whose
// confirmation is answered after a tab switch deletes nothing.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.document.getElementsByClassName ??= () => [];

const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { openDialog, closeDialog, getDialogs } = await import('../solid/stores/dialogStore.js');
const { handleKeydown } = await import('./keyboard-handlers.js');
const { modalBlocksGlobalKey } = await import('../ui/chrome/global-key-guard.js');

// Some app modules keep timers alive; end the process once the tests are done.
test.after(() => setImmediate(() => process.exit()));

const box = () => createAnnotation({ type: 'box', page: 1, x: 10, y: 10, width: 40, height: 30,
  color: '#000000', strokeColor: '#000000', lineWidth: 1, opacity: 1 });

function makeDoc(id) {
  const a = box();
  return { id, filePath: `C:/mk/${id}.pdf`, currentPage: 1, scale: 1, viewMode: 'single',
    annotations: [a], selectedAnnotations: [a], selectedAnnotation: a,
    undoStack: [], redoStack: [], savedUndoStackLength: 0, pdfDoc: { numPages: 1 }, pageRotations: {},
    _annotationPagesReady: new Set([1]), textEdits: [] };
}

function useDocs(...docs) {
  state.documents = docs;
  state.activeDocumentIndex = 0;
  state.currentTool = 'select';
  for (const d of getDialogs()) closeDialog(d.name);
}

const body = { tagName: 'BODY', closest: () => null };
const key = (k, over = {}) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
  target: body, preventDefault() {}, stopPropagation() {}, ...over });

test('an arrow key nudges the selection only without a dialog and outside a <select>', async () => {
  const doc = makeDoc('a');
  useDocs(doc);
  const ann = doc.annotations[0];

  openDialog('preferences');
  await handleKeydown(key('ArrowRight'));
  assert.equal(ann.x, 10, 'a dialog in the store blocks the nudge');
  closeDialog('preferences');

  await handleKeydown(key('ArrowRight', { target: { tagName: 'BUTTON', closest: (s) => (s === '[aria-modal="true"]' ? {} : null) } }));
  assert.equal(ann.x, 10, 'a key inside an aria-modal element is the dialog\'s');

  await handleKeydown(key('ArrowDown', { target: { tagName: 'SELECT', closest: () => null } }));
  assert.equal(ann.y, 10, 'a focused <select> keeps its arrow keys');

  await handleKeydown(key('ArrowRight'));
  assert.equal(ann.x, 11, 'without a dialog the nudge runs');
});

test('Ctrl+Z behind an open dialog leaves the drawing alone', async () => {
  const doc = makeDoc('u');
  useDocs(doc);
  await handleKeydown(key('ArrowRight'));
  assert.equal(doc.annotations[0].x, 11);
  openDialog('documentProperties');
  await handleKeydown(key('z', { ctrlKey: true }));
  assert.equal(doc.annotations[0].x, 11, 'undo did not run');
  closeDialog('documentProperties');
  await handleKeydown(key('z', { ctrlKey: true }));
  assert.equal(doc.annotations[0].x, 10, 'undo runs once the dialog is closed');
});

test('a Delete confirmed after a tab switch deletes nothing in either tab', async () => {
  const first = makeDoc('d1');
  const second = makeDoc('d2');
  useDocs(first, second);
  state.preferences.confirmBeforeDelete = true;
  const pending = handleKeydown(key('Delete'));
  await new Promise((r) => setTimeout(r, 20));
  const confirm = getDialogs().find((d) => d.name === 'confirm');
  assert.ok(confirm, 'the confirmation is open');
  state.activeDocumentIndex = 1;
  closeDialog('confirm');
  confirm.data.resolve(true);
  await pending;
  assert.equal(first.annotations.length, 1, 'the first tab keeps its markup');
  assert.equal(second.annotations.length, 1, 'the second tab keeps its markup');
  assert.equal(second.selectedAnnotations.length, 1, 'the second tab keeps its selection');
  assert.equal((second.undoStack || []).length, 0, 'no undo step lands in the second tab');

  // Same tab throughout: the markup goes.
  useDocs(first);
  const again = handleKeydown(key('Delete'));
  await new Promise((r) => setTimeout(r, 20));
  const c2 = getDialogs().find((d) => d.name === 'confirm');
  closeDialog('confirm');
  c2.data.resolve(true);
  await again;
  assert.equal(first.annotations.length, 0);
});

test('the guard core: store dialogs, aria-modal targets, rendered modals, extra check', () => {
  const none = { querySelector: () => null };
  assert.equal(modalBlocksGlobalKey({ target: body }, { root: none }), false);
  assert.equal(modalBlocksGlobalKey({ target: body }, { dialogCount: 1, root: none }), true);
  assert.equal(modalBlocksGlobalKey({ target: body }, { modalOpen: true, root: none }), true);
  assert.equal(modalBlocksGlobalKey({ target: body }, { root: { querySelector: (s) => (s === '[aria-modal="true"]' ? {} : null) } }), true);
  assert.equal(modalBlocksGlobalKey({ target: { closest: () => ({}) } }, { root: none }), true);
  assert.equal(modalBlocksGlobalKey({}, {}), false);
});

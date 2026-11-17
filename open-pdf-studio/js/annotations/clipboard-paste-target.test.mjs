// Ctrl+V reads the system clipboard and decodes an image asynchronously. The
// paste lands in the drawing active when it started, and in nothing when the
// user switched or closed that tab meanwhile: never in the tab active by the
// time the image is ready.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const { pasteImageFromBlob, pasteImageOrMarkups, pasteTargetCurrent } = await import('./clipboard.js');
const { undoStackOf } = await import('../core/undo-stacks.js');

// An image decodes when `decoded` is called; FileReader answers at once.
let decoded = () => {};
globalThis.Image = class {
  set src(_) { decoded = () => this.onload?.(); }
  get naturalWidth() { return 40; }
  get naturalHeight() { return 30; }
};
globalThis.FileReader = class {
  readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; queueMicrotask(() => this.onloadend?.()); }
};
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = () => {};

function tab(id) {
  return { id, currentPage: 1, scale: 1, pdfDoc: { numPages: 1 }, viewMode: 'single', annotations: [],
    selectedAnnotations: [], selectedAnnotation: null, undoStack: [], redoStack: [], savedUndoStackLength: 0 };
}
// The open documents as the app holds them (the store's own objects, which
// getActiveDocument returns).
function twoTabs() {
  state.documents = [tab('paste-a'), tab('paste-b')];
  state.activeDocumentIndex = 0;
  const [a, b] = state.documents;
  return { a, b };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an image pastes into the tab where the paste started', async () => {
  const { a, b } = twoTabs();
  const done = pasteImageFromBlob(new Blob(['x']));
  decoded();
  await done;
  assert.equal(a.annotations.length, 1);
  assert.equal(a.annotations[0].type, 'image');
  assert.equal(undoStackOf(a).length, 1);
  assert.equal(b.annotations.length, 0);
});

test('a tab switch while the image decodes pastes nothing, into neither tab', async () => {
  const { a, b } = twoTabs();
  const done = pasteImageFromBlob(new Blob(['x']));
  state.activeDocumentIndex = 1;
  decoded();
  await done;
  assert.equal(a.annotations.length, 0);
  assert.equal(b.annotations.length, 0);
  assert.equal(undoStackOf(a).length + undoStackOf(b).length, 0, 'no undo step either');
});

test('a tab closed while the image decodes gets nothing', async () => {
  const { a, b } = twoTabs();
  const done = pasteImageFromBlob(new Blob(['x']));
  state.documents = [b];
  state.activeDocumentIndex = 0;
  decoded();
  await done;
  assert.equal(a.annotations.length, 0);
  assert.equal(b.annotations.length, 0);
});

test('reading the system clipboard: a tab switch meanwhile stops the paste of an image or of markups', async () => {
  for (const clipboardImage of [true, false]) {
    const { a, b } = twoTabs();
    state.clipboardAnnotation = { id: 'm', type: 'box', page: 1, x: 1, y: 1, width: 5, height: 5 };
    state.clipboardAnnotations = null;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        read: async () => {
          state.activeDocumentIndex = 1;
          return clipboardImage ? [{ types: ['image/png'], getType: async () => new Blob(['x']) }] : [];
        },
      },
    });
    assert.equal(pasteTargetCurrent(a), true);
    await pasteImageOrMarkups(a);
    decoded();
    await settle();
    assert.equal(a.annotations.length, 0, `image on the clipboard: ${clipboardImage}`);
    assert.equal(b.annotations.length, 0, `image on the clipboard: ${clipboardImage}`);
  }
  state.clipboardAnnotation = null;
});

test('pasteTargetCurrent: open, active and loaded', () => {
  const { a, b } = twoTabs();
  assert.equal(pasteTargetCurrent(a), true);
  assert.equal(pasteTargetCurrent(b), false);
  state.documents = [b];
  state.activeDocumentIndex = 0;
  assert.equal(pasteTargetCurrent(a), false);
  assert.equal(pasteTargetCurrent(null), false);
});

test('Ctrl+V handlers capture the drawing before their await and pass it on', () => {
  const source = readFileSync(new URL('../tools/keyboard-handlers.js', import.meta.url), 'utf8');
  // The deferred fallback: captured before the timer, checked in it, passed to the image paste.
  assert.match(source, /const pasteDoc = getActiveDocument\(\);\n\s*setTimeout\(async \(\) => \{/);
  assert.match(source, /getActiveDocument\(\) !== pasteDoc\) return;/);
  assert.match(source, /await pasteImageFromBlob\(blob, pasteDoc\);/);
  assert.match(source, /pasteImageOrMarkups\(pasteDoc\)/);
  assert.match(source, /placeLastScreenshotAsOverlay\(\{ opacity: 1, offset: 10, doc: pasteDoc \}\)/);
  // The native paste event.
  assert.match(source, /pasteImageFromBlob\(blob, pasteDoc\);\n\s*\}\);/);
  assert.equal((source.match(/if \(!pasteTargetCurrent\(pasteDoc\)\) return;/g) || []).length, 2,
    'both internal-markup fallbacks check the tab');
});

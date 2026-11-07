// The context-menu actions as commands (markup-actions.js): in the palette
// and a menu, disabled without what they act on, and the lock / marked /
// printable toggles change every selected markup in one undo step. Real
// registry and state store (see ../../core/app-test-hooks.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const reg = await import('./index.js');
const { menuPathOf } = await import('./menus.js');
const { paletteResults } = await import('./palette.js');
const { state } = await import('../../core/state.js');

const IDS = ['edit.addReply', 'edit.reviewHistory', 'edit.lockMarkup', 'edit.markMarkup', 'edit.printableMarkup',
  'edit.copyToPages', 'tools.assemblies', 'format.setDefaultStyle', 'format.applyDefaultStyle',
  'tools.measure.convertToMeasurement', 'edit.convertToPolyline', 'edit.convertToPolygon',
  'tools.measure.calibrateFromLine', 'edit.exportMarkupImage', 'document.addBookmark', 'document.replacePages',
  'document.insertFromFile', 'tools.markup.highlightText', 'tools.markup.strikeoutText', 'tools.markup.underlineText'];

const label = (key) => key;
const docWith = (anns, selected = anns) => {
  state.documents = [{ id: 'd', pdfDoc: { numPages: 2 }, currentPage: 1, annotations: anns, selectedAnnotations: selected,
    undoStack: [], redoStack: [] }];
  state.activeDocumentIndex = 0;
};

test('every context action is a command with an icon, in a menu and in the palette', () => {
  const palette = new Set(paletteResults('', label, 10_000).map((r) => r.cmd.id));
  for (const id of IDS) {
    const cmd = reg.getCommand(id);
    assert.ok(cmd, id);
    assert.match(cmd.icon || '', /^<svg/, `${id} icon`);
    assert.ok(menuPathOf(id), `${id} in a menu`);
    assert.ok(palette.has(id), `${id} in the palette`);
  }
});

test('without a selection the markup actions are disabled; with one they apply', async () => {
  docWith([]);
  for (const id of ['edit.addReply', 'edit.lockMarkup', 'edit.copyToPages', 'edit.convertToPolyline', 'tools.markup.highlightText']) {
    assert.equal(reg.isCommandEnabled(id), false, id);
  }
  assert.equal(reg.isCommandEnabled('document.addBookmark'), true, 'pages need only an open PDF');
  const line = { id: 'a', type: 'line', page: 1, startX: 0, startY: 0, endX: 10, endY: 0 };
  const box = { id: 'b', type: 'box', page: 1, locked: true };
  docWith([line, box], [line]);
  assert.equal(reg.isCommandEnabled('edit.addReply'), true);
  assert.equal(reg.isCommandEnabled('edit.convertToPolyline'), true, 'a line');
  assert.equal(reg.isCommandEnabled('tools.measure.calibrateFromLine'), false, 'not a measurement');
  docWith([line, box], [line, box]);
  assert.equal(reg.isCommandEnabled('edit.addReply'), false, 'one markup only');
  assert.equal(reg.isCommandChecked('edit.lockMarkup'), false);
  await reg.runCommand('edit.lockMarkup');
  assert.deepEqual([line.locked, box.locked], [true, true], 'locks all when one is unlocked');
  assert.equal(reg.isCommandChecked('edit.lockMarkup'), true);
  await reg.runCommand('edit.lockMarkup');
  assert.deepEqual([line.locked, box.locked], [false, false]);
  await reg.runCommand('edit.printableMarkup');
  assert.deepEqual([line.printable, box.printable], [false, false], 'printable by default, so off');
  state.documents = [];
  state.activeDocumentIndex = -1;
});

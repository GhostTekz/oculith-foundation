// Wiring that node cannot load as a module (Solid components, the Markups
// List with the renderer): every global key handler asks the modal guard,
// only the topmost dialog takes Escape, and the list's async select handlers
// stop when another tab became active during the page change.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isTopmostDialog, MODAL_DIALOG_SELECTOR } from '../../solid/components/dialog-stack.js';

const bron = (pad) => readFileSync(new URL(pad, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the topmost of stacked dialogs is the last modal in document order', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const root = { querySelectorAll: (s) => (s === MODAL_DIALOG_SELECTOR ? [a, b] : []) };
  assert.equal(isTopmostDialog(b, root), true);
  assert.equal(isTopmostDialog(a, root), false);
  assert.equal(isTopmostDialog(a, { querySelectorAll: () => [] }), false);
  assert.equal(isTopmostDialog(null, root), false);
});

test('Dialog.jsx closes on Escape only when topmost and stops the event there', () => {
  const src = bron('../../solid/components/Dialog.jsx');
  const fn = src.slice(src.indexOf('function onKeyDown'), src.indexOf('function keepTabInside'));
  assert.match(fn, /e\.key === 'Escape' && isTopmostDialog\(dialogRef, document\)/);
  assert.match(fn, /e\.stopImmediatePropagation\(\)/);
});

test('Ctrl+Tab, the view-history keys and the canvas keys ask the modal guard', () => {
  const tabs = bron('../../solid/components/DocumentTabs.jsx');
  const cycle = tabs.slice(tabs.indexOf('function onCycleKeyDown'), tabs.indexOf('function onDocMouseUp'));
  assert.match(cycle, /if \(!shouldHandleGlobalKey\(e\)\) return;/);
  assert.ok(cycle.indexOf('shouldHandleGlobalKey') < cycle.indexOf('preventDefault'));
  const nav = bron('./navigation-commands.js');
  assert.match(nav, /!shouldHandleGlobalKey\(e\)\) return;/);
  const kh = bron('../../tools/keyboard-handlers.js');
  assert.match(kh, /isTextEntryTarget \} from '\.\/shortcut-table\.js'/);
  assert.doesNotMatch(kh, /function isTextEntryTarget/, 'one definition, which counts <select>');
});

test('Markups List select handlers return when the active tab changed during goToPage', () => {
  const src = bron('../panels/annotations-list.js');
  const item = src.slice(src.indexOf('export async function selectAnnotationItem'), src.indexOf('updateAnnotationsList();', src.indexOf('export async function selectAnnotationItem')));
  const awaits = item.split('await goToPage(annotation.page);').slice(1);
  assert.equal(awaits.length, 2);
  for (const rest of awaits) assert.match(rest.slice(0, 160), /if \(getActiveDocument\(\) !== selDoc\) return;/);
  const range = src.slice(src.indexOf('export async function selectMarkupRange'));
  assert.match(range.slice(0, range.indexOf('live.selectedAnnotations')), /if \(!live \|\| live !== doc\) return;/);
  const group = src.slice(src.indexOf('export async function selectMarkupGroupItem'));
  assert.match(group.slice(0, group.indexOf('d.selectedAnnotations = ')), /if \(d !== doc\) return;/);
});

// MultiView commands (docs/reference/editor/workspace.md): the split commands
// are registered under the ids the View menu waited for, the menu entries
// are live, the keys reach them, and the Navigation bar, status bar Sync and
// tab menu run them. Runs the real registry, store and state (browser build
// of Solid, see ../../core/app-test-hooks.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { state } = await import('../../core/state.ts');
const reg = await import('./index.js');
const { walkMenus, menuPathOf } = await import('./menus.js');
const mv = await import('../stores/multiViewStore.js');
const { SHORTCUTS, resolveRegistryShortcut } = await import('../../tools/shortcut-table.js');

const lees = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const IDS = ['view.splitVertical', 'view.splitHorizontal', 'view.toggleSplit', 'view.switchPane',
  'view.unsplit', 'view.syncDocument', 'view.syncPage'];

function openDoc() {
  state.documents = [{ id: 'a', fileName: 'a.pdf', pdfDoc: { numPages: 3 }, currentPage: 2, scale: 1.5, annotations: [] }];
  state.activeDocumentIndex = 0;
}

test('split commands are registered in the View menu, no longer pending', () => {
  for (const id of IDS) {
    const cmd = reg.getCommand(id);
    assert.ok(cmd, id);
    assert.equal(cmd.category, 'view', id);
    assert.deepEqual(menuPathOf(id), ['common:menu.view'], id);
  }
  const pending = [];
  walkMenus((item) => { if (item.pending) pending.push(item.command); });
  assert.deepEqual(pending, []);
  assert.equal(reg.getCommand('view.splitVertical').shortcut, 'Ctrl+Alt+2');
  assert.equal(reg.getCommand('view.splitHorizontal').shortcut, 'Ctrl+H');
  assert.equal(reg.getCommand('view.unsplit').shortcut, 'Ctrl+Shift+2');
  // the external editor's Ctrl+1 / Ctrl+2 stay Fit Width / Fit Page here.
  assert.equal(reg.getCommand('view.fitPage').shortcut, 'Ctrl+2');
  assert.equal(reg.getCommand('view.fitWidth').shortcut, 'Ctrl+1');
});

test('menu entries light up: split with a PDF; unsplit, Switch and Sync with a split', () => {
  state.documents = [];
  state.activeDocumentIndex = -1;
  assert.equal(reg.isCommandEnabled('view.splitVertical'), false, 'no PDF');
  openDoc();
  assert.equal(reg.isCommandEnabled('view.splitVertical'), true);
  assert.equal(reg.isCommandEnabled('view.splitHorizontal'), true);
  for (const id of ['view.unsplit', 'view.toggleSplit', 'view.switchPane', 'view.syncDocument', 'view.syncPage']) {
    assert.equal(reg.isCommandEnabled(id), false, id);
  }
  reg.runCommand('view.splitVertical');
  assert.equal(mv.isSplitView(), true);
  assert.equal(mv.splitOrientation(), 'vertical');
  assert.equal(reg.isCommandChecked('view.splitVertical'), true);
  assert.equal(reg.isCommandChecked('view.splitHorizontal'), false);
  for (const id of ['view.unsplit', 'view.toggleSplit', 'view.switchPane', 'view.syncDocument', 'view.syncPage']) {
    assert.equal(reg.isCommandEnabled(id), true, id);
  }
  // The live view (page 2 at 150 %) is the second split's starting view.
  assert.deepEqual(mv.paneDocIds(1), ['a']);
  assert.equal(mv.storedPassiveView().view.page, 2);
  assert.equal(mv.storedPassiveView().view.scale, 1.5);

  reg.runCommand('view.toggleSplit');
  assert.equal(mv.splitOrientation(), 'horizontal');
  assert.equal(reg.isCommandChecked('view.splitHorizontal'), true);
  reg.runCommand('view.splitVertical');
  assert.equal(mv.splitOrientation(), 'vertical');
});

test('Sync: Synchronize Document / Page are a radio pair; the status toggle keeps the mode', () => {
  openDoc();
  if (!mv.isSplitView()) reg.runCommand('view.splitVertical');
  reg.runCommand('view.syncPage');
  assert.deepEqual({ ...mv.syncState(), pageOffset: undefined }, { enabled: true, mode: 'page', pageOffset: undefined });
  assert.equal(reg.isCommandChecked('view.syncPage'), true);
  assert.equal(reg.isCommandChecked('view.syncDocument'), false);
  reg.runCommand('view.syncDocument');
  assert.equal(mv.syncState().mode, 'document');
  assert.equal(reg.isCommandChecked('view.syncDocument'), true);
  mv.toggleSync();
  assert.equal(mv.syncState().enabled, false);
  assert.equal(mv.syncState().mode, 'document', 'off keeps the mode');
  mv.toggleSync();
  assert.equal(reg.isCommandChecked('view.syncDocument'), true);
  reg.runCommand('view.syncDocument');
  assert.equal(mv.syncState().enabled, false, 'choosing the mode that is on turns Sync off');
});

test('unsplit ends the split and Sync; the commands go quiet again', () => {
  openDoc();
  if (!mv.isSplitView()) reg.runCommand('view.splitVertical');
  mv.setSync({ enabled: true, mode: 'document' });
  reg.runCommand('view.unsplit');
  assert.equal(mv.isSplitView(), false);
  assert.equal(mv.syncState().enabled, false);
  assert.equal(reg.isCommandEnabled('view.unsplit'), false);
  assert.equal(mv.setSync({ enabled: true }), false, 'Sync needs a split');
});

test('keys: Ctrl+Alt+2, Ctrl+H and Ctrl+Shift+2 run the split commands; Ctrl+2 stays Fit Page', () => {
  const key = (k, code, mods) => ({ key: k, code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false, target: null, ...mods });
  assert.equal(resolveRegistryShortcut(key('2', 'Digit2', { altKey: true }))?.run, 'view.splitVertical');
  assert.equal(resolveRegistryShortcut(key('²', 'Digit2', { altKey: true }))?.run, 'view.splitVertical', 'AltGr layouts');
  assert.equal(resolveRegistryShortcut(key('h', 'KeyH'))?.run, 'view.splitHorizontal');
  assert.equal(resolveRegistryShortcut(key('@', 'Digit2', { shiftKey: true }))?.run, 'view.unsplit');
  assert.equal(resolveRegistryShortcut(key('2', 'Digit2')), null);
  assert.equal(SHORTCUTS.find((e) => e.id === 'fitPage').keys, 'Ctrl+2');
});

test('the Navigation bar, status bar Sync and tab menu run the MultiView commands', () => {
  const nav = lees('../components/NavigationBar.jsx');
  assert.match(nav, /\['splitVertical', ICON\.splitV, 'view\.splitVertical', 'vertical'\]/);
  assert.match(nav, /\['splitHorizontal', ICON\.splitH, 'view\.splitHorizontal', 'horizontal'\]/);
  assert.match(nav, /\['unsplit', ICON\.unsplit, 'view\.unsplit', null\]/);
  assert.match(nav, /runCommand\(id\)/);
  assert.doesNotMatch(nav, /title=\{splitTitle\(key\)\} disabled \/>/, 'no longer permanently disabled');
  const status = lees('../components/StatusBar.jsx');
  assert.match(status, /id="status-sync"[^>]*onClick=\{toggleSync\}/);
  assert.match(status, /id="status-sync-mode"/);
  const tabs = lees('../components/DocumentTabs.jsx');
  assert.match(tabs, /case 'splitVertical':\s*case 'splitHorizontal':/);
  assert.match(tabs, /case 'switch':[\s\S]*moveTabToPane\(doc\.id, from, 1 - from\)/);
  const app = lees('../App.jsx');
  assert.match(app, /<div class="mv-panes"[^>]*>\s*<Show when=\{isSplitView\(\)\}>\s*<MultiViewPanes \/>\s*<\/Show>\s*<div id="pdf-container">/);
  const css = lees('../../../styles/multiview.css');
  assert.match(css, /\.mv-panes \{\s*display: contents;/, 'unsplit layout unchanged');
});

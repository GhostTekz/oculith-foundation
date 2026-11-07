// Context menus (the external editor workspace WP4): plan-review order, every former item
// still reachable, the Arrange ▸ submenu built from the old Arrange tab, and
// the 26 px row style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ARRANGE_MENU, ARRANGE_MIN_SELECTION, arrangeMenuIds, arrangeAllowed } from '../commands/arrange-menu.js';

const lees = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const menu = lees('./ContextMenu.jsx');
const body = (name) => {
  const start = menu.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = menu.indexOf('\nfunction ', start + 10);
  return menu.slice(start, end < 0 ? undefined : end);
};
const single = body('AnnotationMenuContent');
const multi = body('MultiAnnotationMenuContent');
const page = body('PageMenuContent');
// Only the menu itself, not the vertex/system helpers above its return.
const singleMenu = single.slice(single.indexOf('{renderVertexActions()}'));

function assertOrder(src, markers, what) {
  let last = -1;
  for (const marker of markers) {
    const at = src.indexOf(marker, last + 1);
    assert.ok(at > last, `${what}: "${marker}" after the previous item`);
    last = at;
  }
}

test('markup menu follows the external editor: clipboard, reply/status, layer/arrange/group/lock/flatten/tool chest, Properties last', () => {
  assertOrder(singleMenu, [
    "label={tCommon('cut')}", "label={tCommon('copy')}", "label={tCommon('paste')}", "label={tCommon('delete')}",
    "t('annotation.addReply')", "t('annotation.status')",
    '<LayerSubmenu ', '<ArrangeSubmenu ', 'id="edit.group"', "t('annotation.locked')",
    "label={tCommon('flatten')}", '<AddToToolChestSubmenu ',
    "t('annotation.properties')",
  ], 'single');
  const lastItem = singleMenu.lastIndexOf('<MenuItem');
  assert.ok(singleMenu.slice(lastItem).includes("t('annotation.properties')"), 'Properties is the last item');
});

test('every former markup menu item is still there', () => {
  const former = ['annotation.openPopUpNote', 'annotation.hidePopUpNote', 'annotation.resetPopUpLocation',
    'annotation.editText', 'annotation.editViewportScale', 'annotation.addReply', 'annotation.locked',
    'annotation.marked', 'annotation.printable', 'annotation.status', 'annotation.showByStatus',
    'annotation.reviewHistory', 'annotation.transform', 'annotation.flipLine',
    'annotation.convertToMeasurement', 'annotation.convertToPolyline', 'annotation.convertToPolygon',
    'annotation.calibrateFromLine', 'annotation.setScale', 'annotation.dimChainAdd', 'annotation.dimChainRemove',
    'annotation.selectRoom', 'annotation.addHole', 'annotation.styleTools', 'annotation.setAsDefaultStyle',
    'annotation.applyDefaultStyle', 'annotation.exportSubmenu', 'annotation.exportAsImage', 'annotation.properties',
    'annotation.wallJoinAllow', 'annotation.wallJoinDisallow', 'contextMenu.deleteVertex', 'contextMenu.insertVertex',
    'contextMenu.convertToArc', 'contextMenu.convertToLine'];
  for (const key of former) assert.ok(single.includes(`t('${key}')`), key);
  assert.match(body('ArrangeSubmenu'), /label=\{t\('annotation\.arrange'\)\}/);
  for (const key of ['cut', 'copy', 'paste', 'pasteInPlace', 'delete', 'flatten', 'duplicate']) {
    assert.ok(single.includes(`tCommon('${key}')`), key);
  }
  // The old Arrange icon grid (z-order, rotate 90°, flip) now runs the
  // arrange commands on the right-clicked markup.
  assert.match(single, /run=\{\(id\) => \{ const a = ann\(\); if \(a\) runCommand\(id, \[a\]\); \}\}/);
  const ids = arrangeMenuIds();
  for (const id of ['arrange.bringToFront', 'arrange.sendToBack', 'arrange.bringForward', 'arrange.sendBackward',
    'arrange.rotateCcw', 'arrange.rotateCw', 'arrange.flipHorizontal', 'arrange.flipVertical']) {
    assert.ok(ids.includes(id), id);
  }
});

test('multi-selection menu keeps every former item (align/distribute/order now under Arrange ▸)', () => {
  for (const key of ['multiSelect.copyAnnotations', 'multiSelect.cutAnnotations', 'multiSelect.deleteAnnotations',
    'multiSelect.trimWallCorners']) {
    assert.ok(multi.includes(`t('${key}'`), key);
  }
  assert.match(multi, /<LayerSubmenu /);
  assert.match(multi, /<ArrangeSubmenu count=\{count\} run=\{\(id\) => runCommand\(id\)\} \/>/);
  // Former flat items → arrange commands (smart-guides alignAnnotations map).
  const formerToCommand = {
    'multiSelect.bringAllToFront': 'arrange.bringToFront', 'multiSelect.sendAllToBack': 'arrange.sendToBack',
    'multiSelect.alignLeft': 'arrange.alignLeft', 'multiSelect.alignRight': 'arrange.alignRight',
    'multiSelect.alignTop': 'arrange.alignTop', 'multiSelect.alignBottom': 'arrange.alignBottom',
    'multiSelect.centerHorizontally': 'arrange.alignCenter', 'multiSelect.centerVertically': 'arrange.alignMiddle',
    'multiSelect.distributeHorizontally': 'arrange.distributeSpaceH', 'multiSelect.distributeVertically': 'arrange.distributeSpaceV',
  };
  const ids = arrangeMenuIds();
  for (const [former, id] of Object.entries(formerToCommand)) assert.ok(ids.includes(id), `${former} → ${id}`);
  assertOrder(multi, ["t('multiSelect.cutAnnotations'", "t('multiSelect.copyAnnotations'", "t('multiSelect.deleteAnnotations'",
    '<LayerSubmenu ', '<ArrangeSubmenu ', 'id="edit.group"', "t('annotation.properties')"], 'multi');
});

test('page menu keeps every former item and ends with Properties', () => {
  for (const key of ['page.addBookmark', 'page.addImage', 'page.addStickyNote', 'page.findMenu', 'page.firstPage',
    'page.goTo', 'page.handTool', 'page.lastPage', 'page.nextPage', 'page.previousPage', 'page.printMenu',
    'page.propertiesMenu', 'page.selectText', 'page.snapshotTool']) {
    assert.ok(page.includes(`t('${key}')`), key);
  }
  // Search opens the Search panel (its own command and key), not a second find bar.
  assert.ok(page.includes('<CommandMenuItem id="window.panel.search" />'), 'Search panel');
  for (const key of ['copy', 'cut', 'delete', 'deselect', 'paste', 'pasteInPlace', 'select']) {
    assert.ok(page.includes(`tCommon('${key}')`), key);
  }
  assert.match(page, /revealInFileManagerLabelKey\(\)/);
  const lastItem = page.lastIndexOf('<MenuItem');
  assert.ok(page.slice(lastItem).includes("t('page.propertiesMenu')"), 'Properties is the last item');
});

test('Arrange ▸ covers every command of the former ribbon Arrange tab', () => {
  const tabToCommand = {
    'arr-align-left': 'alignLeft', 'arr-align-center': 'alignCenter', 'arr-align-right': 'alignRight',
    'arr-align-top': 'alignTop', 'arr-align-middle': 'alignMiddle', 'arr-align-bottom': 'alignBottom',
    'arr-dist-space-h': 'distributeSpaceH', 'arr-dist-space-v': 'distributeSpaceV',
    'arr-dist-left': 'distributeLeft', 'arr-dist-top': 'distributeTop', 'arr-dist-center': 'distributeCenter',
    'arr-dist-middle': 'distributeMiddle', 'arr-dist-right': 'distributeRight', 'arr-dist-bottom': 'distributeBottom',
    'arr-same-size': 'sameSize', 'arr-same-width': 'sameWidth', 'arr-same-height': 'sameHeight',
    'arr-rotate-ccw': 'rotateCcw', 'arr-rotate-cw': 'rotateCw', 'arr-rotate-180': 'rotate180',
    'arr-flip-h': 'flipHorizontal', 'arr-flip-v': 'flipVertical',
    'arr-bring-forward': 'bringForward', 'arr-bring-front': 'bringToFront',
    'arr-send-backward': 'sendBackward', 'arr-send-back': 'sendToBack',
  };
  const tabIds = Object.keys(tabToCommand);
  const ids = arrangeMenuIds();
  const registered = lees('../commands/arrange.js');
  for (const tabId of tabIds) {
    const id = `arrange.${tabToCommand[tabId]}`;
    assert.ok(ids.includes(id), `${tabId} → ${id} in Arrange ▸`);
    assert.ok(registered.includes(`['${tabToCommand[tabId]}'`), `${id} registered`);
    assert.ok(id in ARRANGE_MIN_SELECTION, `${id} has a selection minimum`);
  }
  assert.equal(ARRANGE_MENU.filter((e) => e && e.submenu).map((e) => e.submenu).join(','), 'align,distribute,size,rotate');
  assert.equal(arrangeAllowed('arrange.alignLeft', 1), false);
  assert.equal(arrangeAllowed('arrange.alignLeft', 2), true);
  assert.equal(arrangeAllowed('arrange.distributeSpaceH', 2), false);
  assert.equal(arrangeAllowed('arrange.bringToFront', 1), true);
});

test('new menu variants exist: document ▾, markup style ▾, doc tab, doc list, panel tab', () => {
  const store = lees('../stores/contextMenuStore.js');
  for (const fn of ['showDocumentMenu', 'showMarkupStyleMenu', 'showDocTabMenu', 'showDocListMenu', 'showPanelTabMenu']) {
    assert.match(store, new RegExp(`export function ${fn}\\(`), fn);
  }
  for (const type of ['document', 'markupStyle', 'docTab', 'docList', 'panelTab']) {
    assert.ok(menu.includes(`<Match when={menuType() === '${type}'}>`), type);
  }
  const panel = body('PanelTabMenuContent');
  assertOrder(panel, ["t('panelTab.show')", "t('panelTab.hide')", "t('panelTab.attach')", "t('panelTab.detach')"], 'panel tab');
  assert.match(panel, /attachPanel\(panel\(\)\.id, h\)/);
  assert.match(lees('./panels/AccessBar.jsx'), /showPanelTabMenu\(e\.clientX, e\.clientY, panelId/);
  // Properties toolbar doc ▾ = the menu bar's Document menu.
  assert.match(body('DocumentMenuContent'), /MENUS\.find\(\(m\) => m\.id === 'document'\)/);
});

test('rows are 26 px with a 16 px icon column and a right-aligned shortcut column', () => {
  const css = lees('../../../styles/context-menu.css');
  const row = css.match(/\.context-menu \.context-menu-item \{[^}]*\}/)[0];
  assert.match(row, /height: 26px;/);
  const icon = css.match(/\.context-menu \.context-menu-icon \{[^}]*\}/)[0];
  assert.match(icon, /width: 16px;/);
  assert.match(css.match(/\.context-menu-shortcut \{[^}]*\}/)[0], /text-align: end;/);
  assert.match(menu, /<span class="context-menu-shortcut">\{props\.shortcut \|\| ''\}<\/span>/);
  assert.doesNotMatch(menu, /arrange-icon-grid|ArrangeButton/);
});

// the external editor workspace WP3 wiring: the Navigation bar sits at the bottom of the
// canvas column, the status bar shows icon toggles in the external editor's order bound to
// the same preferences, F4 / F8 visibility goes through
// workspaceLayout.toolbars, the commands are in the registry, and the
// dimmer filter reaches only the PDF raster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { state } = await import('../../core/state.ts');
const { SNAP_TOGGLES } = await import('../../tools/snap-toggles.js');
const registry = await import('../commands/registry.js');
const wl = await import('../stores/workspaceLayout.js');
const nav = await import('../../ui/chrome/navigation-commands.js');
await import('../commands/tools.js');
const display = await import('../stores/contentDisplay.js');

const lees = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const app = lees('../App.jsx');
const statusBar = lees('./StatusBar.jsx');
const navBar = lees('./NavigationBar.jsx');
const navCss = lees('../../../styles/navigation-bar.css');
const statusCss = lees('../../../styles/status-bar.css');
const keys = lees('../../tools/keyboard-handlers.js');
const locale = (taal) => JSON.parse(lees(`../../i18n/locales/${taal}/statusbar.json`));

test('the Navigation bar is the last child of the canvas column', () => {
  const mainView = app.slice(app.indexOf('<div class="main-view">'), app.indexOf('<OrderedDockedPalettes side="right" />'));
  // #pdf-container sits in the MultiView wrapper (display: contents unsplit).
  assert.match(mainView, /<Show when=\{compareUsed\(\)\}><CompareView \/><\/Show>\s*<\/div>\s*<\/div>\s*<NavigationBar \/>\s*<\/div>\s*$/);
  assert.equal(app.match(/<NavigationBar \/>/g).length, 1);
  assert.match(navBar, /<Show when=\{isToolbarVisible\('navigation'\) && hasPdf\(\)\}>/);
  assert.match(navCss, /\.nav-bar \{[^}]*height: 34px;/);
});

test('status toggles: icons in the external editor order, same preference binding, pressed state', () => {
  const order = statusBar.match(/const TOGGLE_ORDER = \[([^\]]*)\]/)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(order, ['showGrid', 'grid', 'content', 'markup', 'ortho', 'reuse']);
  assert.deepEqual([...order].sort(), SNAP_TOGGLES.map((t) => t.id).sort(), 'every preference toggle is shown');
  for (const id of order) assert.match(statusBar, new RegExp(`${id}: lucide\\('[a-z0-9-]+'\\)`), `${id} icon`);
  assert.match(statusBar, /<For each=\{STATUS_TOGGLES\}>/);
  assert.match(statusBar, /aria-pressed=\{isSnapToggleOn\(state\.preferences, toggle\.id\) \? 'true' : 'false'\}/);
  assert.match(statusBar, /onClick=\{\(\) => toggleSnapPreference\(toggle\.id\)\}/);
  assert.match(statusBar, /title=\{toggleTitle\(toggle\)\}/);
  assert.match(statusBar, /<span class="status-icon" innerHTML=\{TOGGLE_ICONS\[toggle\.id\]\} \/>/);
  assert.match(statusBar, /id="status-sync"[^>]*disabled=\{!isSplitView\(\)\}/, 'Sync needs a split view');
  assert.match(statusBar, /id="status-sync"[^>]*onClick=\{toggleSync\}/);
  assert.match(statusCss, /\.status-bar \{[^}]*height: 30px;/);
});

test('status bar: hint, scale, page size, cursor; page navigation and zoom moved out', () => {
  assert.match(statusBar, /<Show when=\{isToolbarVisible\('status'\)\}>/);
  assert.match(statusBar, /id="status-hint"/);
  assert.match(statusBar, /return t\('ready'\);/);
  assert.match(statusBar, /id="status-measure-readout"/);
  assert.match(statusBar, /id="status-scale"/);
  assert.match(statusBar, /id="status-page-size"/);
  assert.match(statusBar, /formatCursorCoords\(p, getMeasureScale\(p\.page, p\.x, p\.y\), paperUnit\(\)\)/);
  for (const gone of ['status-page-input', 'status-zoom-input', 'goToPage', 'setViewMode', 'zoomIn']) {
    assert.ok(!statusBar.includes(gone), `${gone} left the status bar`);
  }
  for (const id of ['nav-page-input', 'nav-zoom-input', 'nav-first', 'nav-last', 'nav-previous-view', 'nav-next-view',
    'nav-page-size', 'nav-scale', 'nav-doc-properties', 'nav-dimmer', 'nav-profile', 'nav-layout-single', 'nav-layout-continuous']) {
    assert.match(navBar, new RegExp(`id="${id}"`), id);
  }
  assert.match(navBar, /openScaleChip\(chip\(\), page\(\)\)/, 'the scale text opens Set Scale, or the review of a detected scale');
});

test('F4 / F8 toggle the bars through workspaceLayout.toolbars', () => {
  state.preferences = {};
  wl.restoreWorkspaceLayout();
  assert.equal(wl.isToolbarVisible('navigation'), true);
  assert.equal(wl.isToolbarVisible('status'), true);
  registry.runCommand('tools.toolbar.navigation');
  assert.equal(wl.isToolbarVisible('navigation'), false);
  assert.equal(registry.isCommandChecked('tools.toolbar.navigation'), false);
  assert.equal(state.preferences.workspaceLayout.toolbars.navigation.visible, false, 'persisted');
  nav.toggleNavigationBar();
  assert.equal(wl.isToolbarVisible('navigation'), true);
  registry.runCommand('tools.toolbar.status');
  assert.equal(wl.isToolbarVisible('status'), false);
  nav.toggleStatusBar();
  assert.equal(wl.isToolbarVisible('status'), true);
  assert.equal(registry.getCommand('tools.toolbar.navigation').shortcut, 'F4');
  assert.equal(registry.getCommand('tools.toolbar.status').shortcut, 'F8');
});

test('commands are registered once, in the view menu where they belong', () => {
  const ids = nav.NAVIGATION_COMMANDS.map((c) => c.id);
  assert.deepEqual(ids, ['view.previousView', 'view.nextView', 'view.dimmer', 'view.darkMode']);
  for (const id of ['view.previousView', 'view.nextView', 'view.dimmer', 'view.darkMode']) {
    assert.equal(registry.getCommand(id).category, 'view', id);
  }
  for (const c of nav.NAVIGATION_COMMANDS) assert.match(c.label, /^statusbar:navbar\./);
  assert.equal(registry.isCommandEnabled('view.previousView'), false, 'no history yet');
});

test('keys: F4, Alt+Left/Right and Ctrl+3 map to commands; handled keys are left alone', () => {
  const k = (key, mods = {}) => nav.navigationKeyCommand({ key, ...mods });
  assert.equal(k('F4'), 'tools.toolbar.navigation');
  assert.equal(k('F4', { shiftKey: true }), null, 'Shift+F4 is Hide Panels');
  assert.equal(k('ArrowLeft', { altKey: true }), 'view.previousView');
  assert.equal(k('ArrowRight', { altKey: true }), 'view.nextView');
  assert.equal(k('ArrowLeft'), null, 'plain arrows still nudge');
  assert.equal(k('ArrowLeft', { altKey: true, shiftKey: true }), null);
  assert.equal(k('3', { ctrlKey: true }), 'view.darkMode');
  assert.equal(k('3'), null, 'plain 3 is a My Tools slot');
  assert.equal(k('F8'), null, 'F8 goes through the shortcut table only');
  const src = lees('../../ui/chrome/navigation-commands.js');
  assert.match(src, /if \(e\.defaultPrevented \|\| isTextEntry\(e\.target\)\) return;/);
  assert.match(src, /window\.__ocuNavigationKeys/);
  assert.ok(!/'F4'/.test(keys), 'keyboard-handlers.js does not bind F4 (no double binding)');
});

test('dimmer and dark mode: preferences, and the filter reaches only the PDF raster', () => {
  state.preferences = {};
  assert.equal(display.contentFilter(), 'none');
  registry.runCommand('view.dimmer');
  assert.equal(state.preferences.contentDimmer, undefined, 'disabled without a PDF');
  state.documents = [{ pdfDoc: { numPages: 1 }, currentPage: 1 }];
  state.activeDocumentIndex = 0;
  registry.runCommand('view.dimmer');
  assert.equal(state.preferences.contentDimmer, true);
  assert.equal(registry.isCommandChecked('view.dimmer'), true);
  assert.equal(display.contentFilter(), 'contrast(0.3333) brightness(1.5)', 'default 50 %');
  display.setDimmerLevel(0.9);
  display.setDimmerLevel(0.95);
  assert.equal(display.dimmerLevel(), 0.9, '90 % at most');
  registry.runCommand('view.darkMode');
  assert.equal(state.preferences.contentDarkMode, true);
  assert.match(display.contentFilter(), /invert\(1\) hue-rotate\(180deg\)$/);
  const css = navCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]*)\{\s*filter: var\(--ocu-content-filter, none\);\s*\}/g)];
  assert.equal(rules.length, 1, 'one filter rule');
  const selectors = rules[0][1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(selectors, ['#pdf-canvas', '#pdf-detail-canvas', '.continuous-container canvas.pdf-canvas', '.continuous-container canvas.pdf-canvas-sharp', '.continuous-container canvas.pdf-detail-canvas']);
  assert.ok(!css.includes('annotation-canvas'), 'markup canvases keep full strength');
  state.documents = [];
  state.activeDocumentIndex = -1;
});

test('en and nl carry every new string', () => {
  const navKeys = ['label', 'unsplit', 'splitVertical', 'splitHorizontal', 'splitUnavailable', 'pan', 'select', 'selectText',
    'pageField', 'pageOf', 'previousView', 'nextView', 'zoomField', 'scaleAuto', 'documentProperties', 'dimmer',
    'dimmerTitle', 'dimmerOptions', 'dimmerLevel', 'darkMode', 'darkModeTitle', 'profile', 'navigationBar', 'statusBar'];
  for (const taal of ['en', 'nl']) {
    const sb = locale(taal);
    for (const k of ['ready', 'cursorTitle', 'cursorPaperTitle', 'pageSizeTitle', 'sync', 'syncTitle']) assert.ok(sb[k], `${taal} ${k}`);
    for (const k of navKeys) assert.ok(sb.navbar?.[k], `${taal} navbar.${k}`);
    assert.match(sb.navbar.pageOf, /\{\{page\}\}.*\{\{total\}\}/);
  }
});

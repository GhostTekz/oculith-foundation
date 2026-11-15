// Tool set sharing UI wiring (docs/reference/editor/tool-chest.md): source-level
// checks for the panel, menus, Properties panel and the i18n keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../SymbolPalette.jsx');
const menu = read('../ContextMenu.jsx');
const manage = read('../dialogs/ManageToolSetsDialog.jsx');
const add = read('../dialogs/AddToToolChestDialog.jsx');
const messages = read('../dialogs/tool-set-share-messages.js');
const library = read('../../stores/toolSetLibrary.js');

test('Detail view shows Subject and Comment; double-click switches the mode; shared sets show a lock', () => {
  assert.match(panel, /tc-tool-subject/u);
  assert.match(panel, /tc-tool-comment/u);
  assert.match(panel, /onDblClick=\{\(\) => \{[\s\S]{0,300}toggleToolPresetMode/u);
  assert.match(panel, /ALWAYS_DRAWING_TOOL_TYPES\.includes\(tool\.preset\.tool\)\) toggleToolPresetMode/u,
    'groups and stamps never switch');
  assert.match(panel, /data-share-state=/u);
  assert.match(panel, /toolSetVisible\(set, activeProfile\(\)\)/u, 'Display and profile filter the sections');
});

test('Add to Tool Chest: several sets, groups from the multi-selection menu, reasons for refused markups', () => {
  assert.match(menu, /openDialog\('add-to-tool-chest'/u);
  assert.match(menu, /selectionIsOneGroup\(selected\(\)/u);
  assert.match(menu, /toolSetSharing\.blocked_\$\{target\(\)\.reason\}/u);
  assert.match(menu, /disabled=\{!canEditToolSet\(set\.id\)\}/u, 'read-only sets are not offered');
});

test('Set as Default sits at the bottom of the Properties panel', () => {
  const props = read('../properties-panel/PropertiesPanel.jsx');
  const at = props.indexOf('id="pp-set-default"');
  assert.ok(at > props.indexOf('<ActionsSection />'), 'after the last section');
  assert.match(props.slice(at, at + 600), /setAsDefaultStyle\(ann\)/u);
});

test('every toolSetSharing key used exists in en and nl, and the object is the last top-level key', () => {
  const used = new Set();
  for (const source of [panel, menu, manage, add, messages, read('../properties-panel/PropertiesPanel.jsx'), read('../panels/panelRegistry.js')]) {
    for (const m of source.matchAll(/toolSetSharing\.([A-Za-z_]+)/gu)) used.add(m[1]);
    for (const m of source.matchAll(/\btt\('([A-Za-z_]+)'/gu)) used.add(m[1]);
    for (const m of source.matchAll(/\btShare\('([A-Za-z_]+)'/gu)) used.add(m[1]);
  }
  for (const reason of ['note', 'hyperlink', 'attachment', 'textMarkup', 'sequenceSymbol', 'unsupported']) used.add(`blocked_${reason}`);
  for (const reason of ['measurement', 'freePolygon', 'ink', 'stamp', 'note', 'hyperlink', 'attachment', 'textMarkup',
    'unsupportedType', 'unreadable']) used.add(`reason_${reason}`);
  used.delete('blocked_');
  used.delete('reason_');
  for (const lang of ['en', 'nl']) {
    const common = JSON.parse(read(`../../../i18n/locales/${lang}/common.json`));
    const keys = Object.keys(common);
    assert.equal(keys[keys.length - 1], 'toolSetSharing', `${lang}: last top-level key`);
    for (const key of used) assert.ok(common.toolSetSharing[key], `${lang}: toolSetSharing.${key}`);
  }
  assert.match(library, /sharingAvailable = \(\) => isTauri\(\)/u, 'the browser build degrades to import/export');
});

test('tool layer items are disabled with the read-only hint on a read-only shared set', () => {
  assert.match(panel, /readOnlyHint = \(setId\) => tShare\('readOnlySet'/u);
  const layerItem = panel.slice(panel.indexOf("t('common:markupLayers.toolLayer')"));
  assert.match(layerItem.slice(0, 400), /disabled: !canEdit, title: canEdit \? undefined : readOnlyHint\(preset\.setId\)/u);
  for (const key of ['assignSetToLayer', 'clearSetLayers']) {
    const item = panel.slice(panel.indexOf(`t('common:markupLayers.${key}'`));
    assert.match(item.slice(0, 400), /disabled: !canEdit \|\|/u, `${key} disabled`);
    assert.match(item.slice(0, 400), /title: canEdit \? undefined : readOnlyHint\(section\.setId\)/u, `${key} hint`);
  }
  assert.match(panel, /const startToolLayer = \(preset\) => \{\s*if \(!editable\(preset\.setId\)\)/u);
  assert.match(panel, /const assignSetLayer = \(section, name\) => \{\s*if \(!editable\(section\.setId\)\)/u);
  assert.match(read('../panels/PanelMenu.jsx'), /title=\{item\.title \|\| undefined\}/u);
});

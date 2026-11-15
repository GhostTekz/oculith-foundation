// The shortcut table (shortcut-table.js): one source for the keyboard handler
// and the Shortcuts dialog. No binding twice, every action reaches a real
// tool or command, nothing fires while typing, and en/nl name every entry.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHORTCUTS, SHORTCUT_CATEGORIES, MEASURE_TOOL_NAMES, shortcutKeys, eventKeys, resolveShortcut,
  singleLetterEntry, displayKeys, isTextEntryTarget, MY_TOOLS_SLOT_KEYS, myToolsSlotForKey, myToolsSlotKey,
} from './shortcut-table.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const lees = (rel) => fs.readFileSync(path.join(hier, rel), 'utf8');
const locale = (taal) => JSON.parse(lees(`../i18n/locales/${taal}/dialogs.json`));

function registeredToolNames() {
  const names = new Set();
  for (const m of lees('tools/index.js').matchAll(/registerTool\(\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
  return names;
}

const key = (k, extra = {}) => ({ key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : '', target: { tagName: 'DIV' }, ...extra });

test('no binding appears twice in the table', () => {
  const seen = new Map();
  const dubbel = [];
  for (const entry of SHORTCUTS) {
    for (const binding of shortcutKeys(entry)) {
      const k = entry.sequence ? `seq:${binding}` : binding;
      if (seen.has(k)) dubbel.push(`${binding}: ${seen.get(k)} and ${entry.id}`);
      else seen.set(k, entry.id);
    }
  }
  assert.deepEqual(dubbel, []);
  assert.equal(new Set(SHORTCUTS.map(e => e.id)).size, SHORTCUTS.length, 'ids are unique');
});

test('bindings are canonical (Ctrl, Shift, Alt order; upper-case letters)', () => {
  for (const entry of SHORTCUTS) {
    if (entry.sequence) continue;
    for (const binding of shortcutKeys(entry)) {
      const parts = binding.endsWith('++') ? [...binding.slice(0, -2).split('+'), '+'] : binding.split('+');
      const mods = parts.slice(0, -1);
      const order = ['Ctrl', 'Shift', 'Alt'];
      assert.deepEqual(mods, order.filter(m => mods.includes(m)), `${entry.id}: ${binding}`);
      assert.doesNotMatch(parts.at(-1), /^[a-z]$/, `${entry.id}: ${binding} letter in upper case`);
    }
  }
});

test('every tool action targets a registered tool; every entry has one kind of action', () => {
  const registered = registeredToolNames();
  for (const entry of SHORTCUTS) {
    assert.ok(SHORTCUT_CATEGORIES.includes(entry.category), `${entry.id}: category`);
    const kinds = ['tool', 'command', 'builtin'].filter(k => entry[k]);
    assert.equal(kinds.length, 1, `${entry.id}: exactly one of tool/command/builtin`);
    if (entry.tool) assert.ok(registered.has(entry.tool), `${entry.id}: tool '${entry.tool}' is not registered`);
  }
  for (const tool of MEASURE_TOOL_NAMES) assert.ok(registered.has(tool), `measure tool ${tool}`);
});

test('every command exists in keyboard-handlers TABLE_COMMANDS', () => {
  const src = lees('keyboard-handlers.js');
  const block = src.match(/const TABLE_COMMANDS = \{([\s\S]*?)\n\};/)?.[1] || '';
  assert.ok(block, 'TABLE_COMMANDS block');
  for (const entry of SHORTCUTS.filter(e => e.command)) {
    assert.match(block, new RegExp(`\\n\\s*${entry.command}:`), `command ${entry.command}`);
  }
});

test('the external editor bindings resolve to the expected tools', () => {
  const tool = (e) => resolveShortcut(e)?.tool ?? resolveShortcut(e)?.command ?? null;
  assert.equal(tool(key('v')), 'select');
  assert.equal(tool(key('V', { shiftKey: true })), 'hand');
  assert.equal(tool(key('h')), 'highlight');
  assert.equal(tool(key('L', { shiftKey: true })), 'measureDistance');
  assert.equal(tool(key('C', { shiftKey: true })), 'arc');
  assert.equal(tool(key('P', { shiftKey: true })), 'polygon');
  assert.equal(tool(key('k')), 'cloudPolyline');
  assert.equal(tool(key('m')), 'lastMeasure');
  assert.equal(tool(key('3')), 'myToolsSlot', 'digits are My Tools slots (the external editor), no longer Line');
  // Shift+Alt: on macOS Alt changes e.key; the physical key decides.
  assert.equal(tool(key('L', { shiftKey: true, altKey: true })), 'measureDistance');
  assert.equal(tool({ key: 'Ò', code: 'KeyL', shiftKey: true, altKey: true, target: {} }), 'measureDistance');
  assert.equal(tool(key('A', { shiftKey: true, altKey: true })), 'measureArea');
  assert.equal(tool(key('C', { shiftKey: true, altKey: true })), 'count');
  assert.equal(tool(key('L', { ctrlKey: true, shiftKey: true })), 'toggleLock');
  assert.equal(tool(key('l', { metaKey: true, shiftKey: true })), 'toggleLock', 'Cmd counts as Ctrl');
  assert.equal(tool(key('g', { ctrlKey: true })), 'group');
  assert.equal(tool(key('G', { ctrlKey: true, shiftKey: true })), 'ungroup');
});

test('a held modifier is part of the binding: Ctrl+V is not Select, Alt+L is not Line', () => {
  assert.equal(resolveShortcut(key('v', { ctrlKey: true })), null);
  assert.equal(resolveShortcut(key('l', { altKey: true })), null);
  assert.equal(resolveShortcut(key('L', { ctrlKey: true })), null, 'Ctrl+L stays full screen (builtin)');
  assert.equal(resolveShortcut(key('Shift', { shiftKey: true })), null, 'a lone modifier');
  assert.equal(resolveShortcut(key('v', { repeat: true })), null, 'a held key does not repeat');
});

test('keys are ignored while typing in an input, textarea, select or contenteditable', () => {
  const typing = [
    { tagName: 'INPUT' },
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true },
    { tagName: 'SPAN', closest: (sel) => (sel === '[contenteditable="true"]' ? {} : null) },
  ];
  for (const target of typing) {
    assert.ok(isTextEntryTarget(target));
    assert.equal(resolveShortcut(key('v', { target })), null, target.tagName);
    assert.equal(resolveShortcut(key('L', { shiftKey: true, altKey: true, target })), null);
    assert.equal(resolveShortcut(key('L', { ctrlKey: true, shiftKey: true, target })), null);
  }
  assert.equal(resolveShortcut(key('v', { target: { tagName: 'CANVAS', closest: () => null } }))?.tool, 'select');
});

test('eventKeys and displayKeys', () => {
  assert.equal(eventKeys(key('a', { ctrlKey: true, shiftKey: true, altKey: true })), 'Ctrl+Shift+Alt+A');
  assert.equal(eventKeys({ key: 'F9', shiftKey: true }), 'Shift+F9');
  assert.equal(eventKeys({ key: '!', code: 'Digit1', shiftKey: true }), 'Shift+1');
  assert.deepEqual(displayKeys('Ctrl+Shift+L'), ['Ctrl', 'Shift', 'L']);
  assert.deepEqual(displayKeys('Ctrl+Shift++'), ['Ctrl', 'Shift', '+']);
  assert.deepEqual(displayKeys('T R'), ['T', 'R']);
});

test('the letters that start a CAD chord also have their the external editor tool', () => {
  const chordStarts = new Set();
  const src = lees('keyboard-handlers.js');
  const block = src.match(/const CAD_CHORDS = \{([\s\S]*?)\n\};/)?.[1] || '';
  for (const m of block.matchAll(/\n\s*'([a-z]{2})':/g)) chordStarts.add(m[1][0]);
  assert.deepEqual([...chordStarts].sort(), ['c', 'e', 'm', 'r', 't']);
  for (const letter of chordStarts) assert.ok(singleLetterEntry(letter), `single key for '${letter}'`);
  assert.equal(singleLetterEntry('t').tool, 'textbox');
  assert.doesNotMatch(block, /\n\s*'t':/, 'T is no longer a chord command: it fires at once');
});

test('keyboard handler and dialog read the table', () => {
  const src = lees('keyboard-handlers.js');
  const dispatch = src.indexOf('const tableEntry = resolveShortcut(e);');
  assert.ok(dispatch > 0);
  assert.ok(dispatch < src.indexOf("} else if (ctrl && (e.key === 'l' || e.key === 'L')) {"), 'before Ctrl+L full screen');
  assert.ok(dispatch > src.indexOf('_activeTool.onKeyDown(_keyCtx, e);'), 'after the tool key hooks (A = arc mode)');
  assert.doesNotMatch(src, /e\.key === 'h' \|\| e\.key === 'H'/, 'the old hard-coded tool keys are gone');
  assert.doesNotMatch(src, /Clear all annotations on current page/, 'Ctrl+Shift+C no longer clears the page');
  assert.match(src, /!ctrl && !e\.altKey && !shift && \/\^\[a-zA-Z\]\$\/\.test\(e\.key\)/, 'Shift+letter never starts a chord');
  const dialog = lees('../solid/components/dialogs/ShortcutsDialog.jsx');
  assert.match(dialog, /import \{ SHORTCUTS, shortcutKeys, displayKeys \} from '\.\.\/\.\.\/\.\.\/tools\/shortcut-table\.js'/);
  const columns = dialog.match(/const COLUMNS = \[([\s\S]*?)\];/)[1];
  for (const c of SHORTCUT_CATEGORIES) assert.match(columns, new RegExp(`'${c}'`), `dialog shows ${c}`);
  assert.match(lees('manager.js'), /if \(MEASURE_TOOL_NAMES\.includes\(tool\)\) state\.lastMeasureTool = tool;/);
});

test('en and nl name every category and entry', () => {
  for (const taal of ['en', 'nl']) {
    const s = locale(taal).shortcuts;
    assert.ok(s?.title, `${taal} title`);
    for (const c of SHORTCUT_CATEGORIES) assert.ok(s.categories?.[c], `${taal} category ${c}`);
    for (const entry of SHORTCUTS) {
      // An entry may name its label in another namespace ('common:spaces.shortcut').
      if (entry.label) {
        const [ns, key] = entry.label.split(':');
        const v = key.split('.').reduce((o, k) => o?.[k], JSON.parse(lees(`../i18n/locales/${taal}/${ns}.json`).replace(/^\uFEFF/, '')));
        assert.ok(v, `${taal} ${entry.label}`);
      } else assert.ok(s.actions?.[entry.id], `${taal} shortcuts.actions.${entry.id}`);
    }
  }
});

test('digits 1-9 and 0 are the ten My Tools slots and nothing else binds a bare digit', () => {
  const digit = (d, extra = {}) => ({ key: d, code: `Digit${d}`, target: { tagName: 'DIV' }, ...extra });
  assert.deepEqual(MY_TOOLS_SLOT_KEYS, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
  for (const [index, d] of MY_TOOLS_SLOT_KEYS.entries()) {
    const entry = resolveShortcut(digit(d));
    assert.equal(entry?.id, 'myToolsSlot', `digit ${d}`);
    assert.equal(entry.command, 'myToolsSlot');
    assert.equal(myToolsSlotForKey(eventKeys(digit(d))), index + 1);
    assert.equal(myToolsSlotKey(index + 1), d);
  }
  assert.equal(myToolsSlotForKey('Shift+1'), null);
  assert.equal(myToolsSlotKey(11), '');
  // Highlight, Pen, Line, Rectangle and Ellipse lost their digit alternates
  // and keep their the external editor letters.
  for (const [id, letter] of [['highlight', 'H'], ['pen', 'P'], ['line', 'L'], ['rectangle', 'R'], ['ellipse', 'E']]) {
    assert.deepEqual(shortcutKeys(SHORTCUTS.find(entry => entry.id === id)), [letter], id);
  }
  const bareDigits = SHORTCUTS.filter(entry => entry.id !== 'myToolsSlot' && !entry.sequence)
    .flatMap(entry => shortcutKeys(entry).filter(k => /^[0-9]$/u.test(k)).map(k => `${entry.id}:${k}`));
  assert.deepEqual(bareDigits, []);
  // Ctrl+digit stays a view key, not a slot.
  assert.equal(resolveShortcut(digit('1', { ctrlKey: true })), null);
  assert.equal(resolveShortcut(digit('3', { repeat: true })), null);
  assert.equal(resolveShortcut(digit('3', { target: { tagName: 'INPUT' } })), null);
});

test('the Shortcuts dialog shows the slot range once and keyboard-handlers passes the pressed key', () => {
  const entry = SHORTCUTS.find(e => e.id === 'myToolsSlot');
  assert.equal(entry.display, '1-0');
  assert.deepEqual(displayKeys(entry.display), ['1-0']);
  assert.match(lees('../solid/components/dialogs/ShortcutsDialog.jsx'), /entry\.display \? \[entry\.display\]/u);
  const src = lees('keyboard-handlers.js');
  assert.match(src, /myToolsSlot: \(keys\) => useMyToolsSlot\(myToolsSlotForKey\(keys\)\)/u);
  assert.match(src, /runTableShortcut\(tableEntry, eventKeys\(e\)\)/u);
  for (const taal of ['en', 'nl']) assert.match(locale(taal).shortcuts.actions.myToolsSlot, /1-9, 0/u);
});

test('PageUp / PageDown turn the page in the document view, also held down', async () => {
  const { resolveRegistryShortcut, inDocumentView } = await import('./shortcut-table.js');
  const inView = { tagName: 'BUTTON', closest: (sel) => (sel === '.main-view' ? {} : null) };
  const inPanel = { tagName: 'DIV', closest: () => null };
  const inDialog = { tagName: 'DIV', closest: (sel) => ({}) };
  const body = { tagName: 'BODY' };
  for (const [k, run] of [['PageDown', 'view.nextPage'], ['PageUp', 'view.previousPage']]) {
    assert.equal(resolveRegistryShortcut({ key: k, code: k, target: body })?.run, run);
    assert.equal(resolveRegistryShortcut({ key: k, code: k, target: inView })?.run, run);
    assert.equal(resolveRegistryShortcut({ key: k, code: k, target: body, repeat: true })?.run, run, `${k} held repeats`);
    assert.equal(resolveRegistryShortcut({ key: k, code: k, target: inPanel }), null, 'a panel or list keeps its own key');
    assert.equal(resolveRegistryShortcut({ key: k, code: k, target: inDialog }), null, 'a dialog keeps its own key');
    assert.equal(resolveRegistryShortcut({ key: k, code: k, target: { tagName: 'INPUT' } }), null);
  }
  assert.equal(inDocumentView(null), true);
  // Other registry keys still do not repeat.
  assert.equal(resolveRegistryShortcut({ key: 'j', code: 'KeyJ', ctrlKey: true, target: body })?.run, 'view.goToSheet');
  assert.equal(resolveRegistryShortcut({ key: 'j', code: 'KeyJ', ctrlKey: true, target: body, repeat: true }), null);
});

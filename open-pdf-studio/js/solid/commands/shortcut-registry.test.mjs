// Advertised shortcuts are real: every key a command shows (menus, palette,
// tooltips) is bound in the shortcut table to that command or its tool, the
// tool keys show on the command whose tool they select, and every key hint in
// a context menu is a binding. Real registry (browser build of Solid, see
// ../../core/app-test-hooks.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const reg = await import('./index.js');
const { TOOL_OF_COMMAND } = await import('./tools.js');
const st = await import('../../tools/shortcut-table.js');

// Keys the window or the OS handles, not the table.
const NATIVE = new Set(['Alt+F4']);
// Commands outside tools.js that select a tool.
const TOOL_OF = { ...TOOL_OF_COMMAND, 'edit.select': 'select', 'edit.pan': 'hand', 'edit.snapshot': 'snapshot',
  'edit.lasso': 'lasso', 'edit.offset': 'offset' };
const norm = (k) => k.trim().replace(/\bLeft$/, 'ArrowLeft').replace(/\bRight$/, 'ArrowRight');
const table = new Map();
for (const entry of st.SHORTCUTS) {
  if (entry.sequence) continue;
  for (const k of st.shortcutKeys(entry)) table.set(k, entry);
}
const shown = (cmd) => String(cmd.shortcut).split(/\s+\/\s+|,\s+/).map(norm);

test('every shortcut a command shows is bound to that command or its tool', () => {
  const wrong = [];
  for (const cmd of reg.listCommands()) {
    if (!cmd.shortcut) continue;
    for (const key of shown(cmd)) {
      if (NATIVE.has(key)) continue;
      const entry = table.get(key);
      const ok = entry && (entry.run ? entry.run === cmd.id
        : entry.tool ? TOOL_OF[cmd.id] === entry.tool
          : true); // builtin branch or table command in keyboard-handlers.js
      if (!ok) wrong.push(`${cmd.id} shows ${key} → ${entry ? entry.id : 'unbound'}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('Ctrl+J runs Go to Sheet; E is Ellipse; Shift+Alt+U is 3-Point Radius', () => {
  const ev = (key, mods = {}) => ({ key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '', target: { tagName: 'DIV' }, ...mods });
  assert.equal(st.resolveRegistryShortcut(ev('j', { ctrlKey: true }))?.run, 'view.goToSheet');
  assert.equal(st.resolveShortcut(ev('e'))?.tool, 'ellipse');
  assert.equal(reg.getCommand('tools.markup.ellipse').shortcut, 'E');
  assert.equal(reg.getCommand('tools.markup.circle').shortcut, null);
  assert.equal(st.resolveShortcut(ev('U', { shiftKey: true, altKey: true }))?.tool, 'measureRadius3');
  assert.equal(reg.getCommand('tools.measure.radius3').shortcut, 'Shift+Alt+U');
  assert.equal(reg.getCommand('tools.measure.radius').shortcut, null);
});

test('every key hint in a context menu is a binding', () => {
  const menu = readFileSync(new URL('../components/ContextMenu.jsx', import.meta.url), 'utf8');
  // Tab: the room-tag menu item mirrors the Select tool's own Tab key.
  const hints = [...menu.matchAll(/shortcut="([^"]+)"/g)].map((m) => m[1]).filter((k) => k !== 'Tab');
  assert.ok(hints.length > 3);
  assert.deepEqual(hints.filter((k) => !table.has(k)), []);
});

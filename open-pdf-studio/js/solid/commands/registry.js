// Command registry: the one place a menu item, toolbar button, shortcut or
// the command palette (Help > Find Tools + Commands) looks a command up.
// Contract for the plan-review workspace, see docs/reference/editor/workspace.md
// ("Contract").
//
// A command:
//   {
//     id:       'file.open'            unique, '<category-ish>.<camelCase>'
//     label:    'common:open'          i18n key as '<namespace>:<key>' (never a
//                                      translated string); resolve it with
//                                      commandLabel(cmd, t)
//     icon:     '<svg …>'              SVG markup (lucide()/ribbonIcons.js), or null
//     shortcut: 'Ctrl+O'               display text of the binding, or null;
//                                      the registry does not bind keys
//     category: 'file'                 one of COMMAND_CATEGORIES (= the menus)
//     run(...args)                     does the work; may return a Promise
//     enabled?() -> boolean            default: always enabled
//     checked?() -> boolean            only for toggles; omit otherwise
//     keywords?: ['load', 'pdf']       extra search terms (any language)
//   }
//
// Reactivity: enabled() and checked() are evaluated on every call to
// isCommandEnabled / isCommandChecked. Read them inside JSX or a memo and
// Solid tracks whatever they read (state is a createMutable store, so most
// conditions are reactive by themselves). Both helpers also read
// commandsVersion(), so a condition that depends on non-reactive data can
// force a refresh with notifyCommandsChanged(). Registering or unregistering
// a command bumps commandsVersion() too, so listCommands() inside JSX picks
// up commands registered later.

import { createSignal } from 'solid-js';
import { state } from '../../core/state.js';
import { undoDepth, redoDepth } from '../../core/undo-stacks.js';
import { lucide } from '../data/lucideIcons.js';

export const COMMAND_CATEGORIES = Object.freeze([
  'oculith', 'file', 'edit', 'view', 'document', 'batch',
  'tools', 'tools.markup', 'tools.measure', 'tools.form', 'tools.signature',
  'window', 'help', 'arrange', 'format',
]);

const commands = new Map();
const [commandsVersion, setCommandsVersion] = createSignal(0);

export { commandsVersion };

/** Bump commandsVersion() so menus re-read enabled()/checked(). */
export function notifyCommandsChanged() {
  setCommandsVersion((v) => v + 1);
}

/**
 * Register a command. Throws on a duplicate id, an unknown category or a
 * missing run(). Returns a function that unregisters it.
 */
export function registerCommand(def) {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('registerCommand: id is required');
  if (commands.has(def.id)) throw new Error(`registerCommand: duplicate command id "${def.id}"`);
  if (typeof def.label !== 'string' || !def.label) throw new Error(`registerCommand: "${def.id}" needs an i18n label key`);
  if (!COMMAND_CATEGORIES.includes(def.category)) {
    throw new Error(`registerCommand: "${def.id}" has unknown category "${def.category}"`);
  }
  if (typeof def.run !== 'function') throw new Error(`registerCommand: "${def.id}" needs run()`);
  const command = Object.freeze({
    id: def.id,
    label: def.label,
    icon: def.icon ?? null,
    shortcut: def.shortcut ?? null,
    category: def.category,
    run: def.run,
    enabled: typeof def.enabled === 'function' ? def.enabled : null,
    checked: typeof def.checked === 'function' ? def.checked : null,
    keywords: Object.freeze([...(def.keywords || [])]),
  });
  commands.set(command.id, command);
  notifyCommandsChanged();
  return () => unregisterCommand(command.id);
}

export function unregisterCommand(id) {
  const removed = commands.delete(id);
  if (removed) notifyCommandsChanged();
  return removed;
}

export function getCommand(id) {
  return commands.get(id) || null;
}

/** All commands in registration order, optionally of one category. */
export function listCommands({ category } = {}) {
  commandsVersion();
  const all = [...commands.values()];
  return category ? all.filter((c) => c.category === category) : all;
}

function resolve(cmdOrId) {
  return typeof cmdOrId === 'string' ? commands.get(cmdOrId) || null : cmdOrId || null;
}

export function isCommandEnabled(cmdOrId) {
  commandsVersion();
  const cmd = resolve(cmdOrId);
  if (!cmd) return false;
  return cmd.enabled ? !!cmd.enabled() : true;
}

/** true/false for a toggle command, undefined for a plain command. */
export function isCommandChecked(cmdOrId) {
  commandsVersion();
  const cmd = resolve(cmdOrId);
  if (!cmd?.checked) return undefined;
  return !!cmd.checked();
}

/**
 * Run a command. Throws for an unknown id (ids are the contract; a typo
 * should fail loudly). A disabled command is not run and yields undefined;
 * otherwise the result of run(...args) is returned (often a Promise).
 */
export function runCommand(id, ...args) {
  const cmd = commands.get(id);
  if (!cmd) throw new Error(`runCommand: unknown command "${id}"`);
  if (!isCommandEnabled(cmd)) return undefined;
  for (const listener of runListeners) {
    try { listener(id); } catch { /* a listener never stops the command */ }
  }
  return cmd.run(...args);
}

const runListeners = new Set();

/**
 * Call listener(id) each time runCommand runs an enabled command (menus,
 * toolbars, keys, the palette). Used for the palette's recent and frequent
 * commands. Returns a function that removes the listener.
 */
export function onCommandRun(listener) {
  runListeners.add(listener);
  return () => runListeners.delete(listener);
}

/**
 * The label to show. Pass the `t` from useTranslation(); the label key
 * carries its own namespace ('common:open'), so any namespace's t works.
 * Without t the last key segment is returned.
 */
export function commandLabel(cmdOrId, t) {
  const cmd = resolve(cmdOrId);
  if (!cmd) return '';
  if (typeof t === 'function') return t(cmd.label);
  return cmd.label.split(/[:.]/).pop();
}

function normalize(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Higher is better: exact > prefix > word prefix > substring > subsequence.
function scoreText(query, text) {
  if (!query || !text) return 0;
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  if (text.split(/[^a-z0-9]+/).some((w) => w && w.startsWith(query))) return 60;
  if (text.includes(query)) return 40;
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i === query.length ? 10 : 0;
}

/**
 * Ranked search for the command palette. Every word of the query must match
 * the label, a keyword or the id; label matches weigh most (x3), then
 * keywords (x2), then the id (x1); the whole query matching the label adds a
 * bonus. Ties keep registration order. An empty query returns every command.
 * Options: t (translate labels, as for commandLabel), limit.
 */
export function searchCommands(query, { t, limit } = {}) {
  const all = listCommands();
  const q = normalize(query);
  if (!q) return limit ? all.slice(0, limit) : all;
  const words = q.split(/\s+/);
  const scored = [];
  all.forEach((cmd, order) => {
    const label = normalize(commandLabel(cmd, t));
    const keywords = cmd.keywords.map(normalize);
    const id = normalize(cmd.id);
    let total = 0;
    for (const w of words) {
      const best = Math.max(
        scoreText(w, label) * 3,
        ...keywords.map((k) => scoreText(w, k) * 2),
        scoreText(w, id),
      );
      if (best === 0) return;
      total += best;
    }
    if (words.length > 1) total += scoreText(q, label) * 3;
    scored.push({ cmd, total, order });
  });
  scored.sort((a, b) => b.total - a.total || a.order - b.order);
  const result = scored.map((s) => s.cmd);
  return limit ? result.slice(0, limit) : result;
}

// --- Seed commands --------------------------------------------------------
// Thin wrappers around the existing handlers (same calls as the TitleBar
// quick access, ribbon Home/View tabs and keyboard-handlers.js). Imports are
// lazy, as in TitleBar.jsx, so the registry loads without the renderer.
// shortcut shows today's binding; WP1 moves the bindings onto the registry.

const activeDoc = () => state.documents[state.activeDocumentIndex];
const hasPdf = () => !!activeDoc()?.pdfDoc;

registerCommand({
  id: 'file.open', label: 'common:open', icon: lucide('folder-open'), shortcut: 'Ctrl+O',
  category: 'file', keywords: ['pdf', 'load', 'file'],
  run: () => import('../../pdf/loader.js').then((m) => m.openPDFFile()),
});
registerCommand({
  id: 'file.save', label: 'common:save', icon: lucide('save'), shortcut: 'Ctrl+S',
  category: 'file', enabled: hasPdf, keywords: ['write'],
  run: () => { const d = activeDoc(); return import('../../pdf/saver.js').then((m) => m.savePDF(null, {}, d)); },
});
registerCommand({
  id: 'file.saveAs', label: 'common:saveAs', icon: lucide('save-all'), shortcut: 'Ctrl+Shift+S',
  category: 'file', enabled: hasPdf, keywords: ['copy', 'export'],
  run: () => { const d = activeDoc(); return import('../../pdf/saver.js').then((m) => m.savePDFAs(d)); },
});
registerCommand({
  id: 'file.print', label: 'common:print', icon: lucide('printer'), shortcut: 'Ctrl+P',
  category: 'file', enabled: hasPdf, keywords: ['printer', 'plot'],
  run: () => import('../../ui/chrome/dialogs.js').then((m) => m.showPrintDialog()),
});
registerCommand({
  id: 'edit.undo', label: 'common:undo', icon: lucide('undo-2'), shortcut: 'Ctrl+Z',
  category: 'edit', enabled: () => undoDepth(activeDoc()) > 0, keywords: ['back', 'revert'],
  run: () => import('../../core/undo-manager.js').then((m) => m.undo()),
});
registerCommand({
  id: 'edit.redo', label: 'common:redo', icon: lucide('redo-2'), shortcut: 'Ctrl+Y',
  category: 'edit', enabled: () => redoDepth(activeDoc()) > 0, keywords: ['repeat'],
  run: () => import('../../core/undo-manager.js').then((m) => m.redo()),
});
registerCommand({
  id: 'view.fitPage', label: 'ribbon:home.fitPageLabel', icon: lucide('expand'), shortcut: 'Ctrl+2',
  category: 'view', enabled: hasPdf, keywords: ['zoom', 'whole page'],
  run: () => import('../../pdf/renderer.js').then((m) => m.fitPage()),
});
registerCommand({
  id: 'view.fitWidth', label: 'ribbon:home.fitWidth', icon: lucide('arrow-left-right'), shortcut: 'Ctrl+1',
  category: 'view', enabled: hasPdf, keywords: ['zoom'],
  run: () => import('../../pdf/renderer.js').then((m) => m.fitWidth()),
});
registerCommand({
  id: 'view.zoomIn', label: 'ribbon:home.zoomIn', icon: lucide('zoom-in'), shortcut: 'Ctrl+=',
  category: 'view', enabled: hasPdf, keywords: ['magnify', 'larger'],
  run: () => import('../../pdf/renderer.js').then((m) => m.zoomIn()),
});
registerCommand({
  id: 'view.zoomOut', label: 'ribbon:home.zoomOut', icon: lucide('zoom-out'), shortcut: 'Ctrl+-',
  category: 'view', enabled: hasPdf, keywords: ['smaller'],
  run: () => import('../../pdf/renderer.js').then((m) => m.zoomOut()),
});

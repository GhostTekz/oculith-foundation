// Edit-menu completeness (WP13, docs/reference/editor/markup-tools.md): Lasso (Shift+O),
// Offset (O), Markup Selection Cycle (Shift+Space steps; a toggle turns the
// repeated-click cycle on or off) and Undo History (Ctrl+Shift+H).

import { registerCommand } from './registry.js';
import { state } from '../../core/state.js';
import { lucide } from '../data/lucideIcons.js';
import { hasPdf, editable, isTool, useTool, redrawView, activeDoc } from './util.js';

const C = 'edit';
const L = (key) => `common:editTools.commands.${key}`;

// Oculith tool drawings (24px viewBox, currentColor); Lucide has no lasso or
// offset glyph in the vendored set.
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const lassoIcon = svg('<path d="M7 18.5C4.6 17.2 3 15 3 12.5 3 8.4 7 5 12 5s9 3.4 9 7.5-4 7.5-9 7.5c-.9 0-1.8-.1-2.6-.3"/><circle cx="8" cy="19" r="2"/><path d="M6.5 20.5 5 22"/>');
const offsetIcon = svg('<path d="M3 17 9 9h12"/><path d="M3 21l7.5-9H21" stroke-dasharray="2 2"/>');

registerCommand({
  id: 'edit.lasso', label: L('lasso'), icon: lassoIcon, shortcut: 'Shift+O', category: C,
  enabled: hasPdf, checked: () => isTool('lasso'), keywords: ['select', 'freeform', 'polygon', 'lasso'],
  run: () => useTool('lasso'),
});

registerCommand({
  id: 'edit.offset', label: L('offset'), icon: offsetIcon, shortcut: 'O', category: C,
  enabled: editable, checked: () => isTool('offset'), keywords: ['parallel', 'copy', 'distance', 'sketch to scale'],
  run: () => useTool('offset'),
});

registerCommand({
  // The same step as a repeated click, at the spot of the last click.
  id: 'edit.cycleSelection', label: L('cycleSelection'), icon: lucide('layers'), shortcut: 'Shift+Space', category: C,
  enabled: hasPdf, keywords: ['overlapping', 'stack', 'next', 'selection cycle'],
  run: async () => {
    const { cycleSelectionAtLastSpot } = await import('../../tools/tools/select-tool.js');
    const ann = cycleSelectionAtLastSpot();
    if (!ann) return;
    const { showProperties } = await import('../../ui/panels/properties-panel.js');
    showProperties(ann);
    redrawView();
  },
});

registerCommand({
  // Markup Selection Cycle on repeated clicks (default on).
  id: 'edit.selectionCycle', label: L('selectionCycle'), icon: null, category: C,
  checked: () => state.preferences?.markupSelectionCycle !== false, keywords: ['overlapping', 'click'],
  run: async () => {
    state.preferences.markupSelectionCycle = state.preferences.markupSelectionCycle === false;
    try { (await import('../../core/preferences.js')).savePreferences?.(); } catch (_) { /* node tests */ }
  },
});

registerCommand({
  id: 'edit.undoHistory', label: L('undoHistory'), icon: lucide('history'), shortcut: 'Ctrl+Shift+H', category: C,
  enabled: () => !!activeDoc(), keywords: ['undo', 'redo', 'history', 'steps'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('undoHistory')),
});

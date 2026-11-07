// One table for the keyboard shortcuts: keyboard-handlers.js dispatches the
// entries with an action from it, and the Shortcuts dialog (F1) lists every
// entry from it. Pure data and helpers, no app imports, so tests can load it.
//
// Entry fields:
//   id        stable name; label = dialogs:shortcuts.actions.<id>
//   label     optional 'ns:key' label in another namespace instead
//   keys      one canonical binding ('V', 'Shift+V', 'Ctrl+Shift+L',
//             'Shift+Alt+L') or an array of alternatives. Modifier order is
//             Ctrl, Shift, Alt; letters upper case; Ctrl also means Cmd.
//   category  dialog section: file, edit, view, tools, measure, markup, cad
//   tool      action: setTool(<tool>) (needs an open, editable PDF)
//   command   action: a named command in keyboard-handlers.js
//             (TABLE_COMMANDS); every command must exist there
//   builtin   no action here: the key is handled by its own branch in
//             keyboard-handlers.js. Listed for the dialog and the clash check.
//   run       with builtin: the command-registry id this key runs
//             (js/solid/commands). keyboard-handlers.js dispatches these
//             through runCommand (resolveRegistryShortcut); they work
//             without an open PDF. Menu mnemonics (Alt+F etc.) are builtin
//             entries without `run`: MenuBar.jsx handles them.
//   display   optional: the dialog shows this instead of every binding
//             (a key range such as '1-0').
//   sequence  a CAD command chord typed as separate letters ('T R'); not a
//             simultaneous key combination, so it never clashes with 'T'.
//
// the external editor (an external publisher) bindings that this app cannot take, and why:
//   H         the external editor: Highlight. Taken: H now selects Highlight (was Pan);
//             Pan moved to Shift+V like the external editor.
//   G         the external editor: Snapshot. Shared: with a selection G keeps starting the
//             Blender-style move (g-move-mode); without one G starts
//             Snapshot (a hovered markup no longer counts for G; the ribbon
//             Move button and the MV chord keep the hover target).
//   C, E, M, R, T  Also the first letter of a CAD chord (CO, CS, EX, MV, RO,
//             TR, TX, TL). The single-letter tool switches at once; when the
//             chord's second letter follows within the chord time, the
//             previous tool comes back and the chord runs.
//   Ctrl+Shift+C  Was Clear Page; now Format Painter (the external editor). Clear Page stays
//             on the ribbon. Multiply has no the external editor key; it is on the ribbon.
//   Shift+O   the external editor: Lasso (free-form selection, edit-tools.js).
//   O         the external editor: Offset. O is also the second letter of the CO (copy)
//             and RO (rotate) chords: within the chord time after C or R the
//             chord wins; a lone O (or O after the chord time) is Offset.
//   Shift+Space  Select Next Overlapping Markup (Markup Selection Cycle,
//             current plan-review releases; the external editor has no key for it). Free before.
//   Ctrl+Shift+H  Edit > Undo History (the external editor has no key for it). Free
//             before; Ctrl+Y / Ctrl+Shift+Z stay Redo.
//   Z         the external editor: Zoom tool. No zoom tool exists (zoom is Ctrl+=/-, wheel);
//             not bound.
//   1-9, 0    the external editor reserves the digit keys for My Tools: 1-9 pick My Tools
//             slots 1-9 and 0 picks slot 10 (myToolsSlot). The digits used
//             to be extra keys for Highlight (1), Pen (2), Line (3),
//             Rectangle (4) and Ellipse (5); those keep their letters (H, P,
//             L, R, E). Ctrl+0/1/2/5 stay view keys. While a length is typed
//             (type-length input) digits still go to that input first.
//
// the external editor workspace shell keys (docs/WORKSPACE-SPEC.md §1.11), and the
// clashes resolved for them:
//   F9        the external editor: Menu Bar. Was snap to grid (AutoCAD); snap to grid stays
//             on Ctrl+Shift+F9 (the external editor), Show Grid on Shift+F9 and F7.
//   Ctrl+K    the external editor: Preferences. Here Ctrl+K (Cmd+K) opens Find Tools +
//             Commands, the usual command-palette key; Preferences is Ctrl+,.
//   Shift+F4  the external editor: Hide Panels.
//   Alt+X/L/T/P/U/Y/B/N/1/2  the external editor panel keys (Tool Chest, Markups List,
//             Thumbnails, Properties, Measurements, Layers, Bookmarks,
//             Links, Search, Sets/Drawing Set).
//   Alt+B, Alt+T  Also the Batch and Tools menu mnemonics. The panels win
//             (the external editor's documented keys); Batch and Tools open with a lone Alt
//             press and then B or T, or by mouse. The other menu letters
//             (Alt+O/F/E/V/D/W/H) open their menu.
//   Ctrl+4/6/7  the external editor page modes: Single Page, Side-by-Side, Continuous
//             Side-by-Side. Ctrl+5 (the external editor: Continuous) stays Thin Lines, and
//             Ctrl+0/1/2 stay Actual Size / Fit Width / Fit Page (the external editor:
//             Ctrl+8/0/9, Ctrl+1/2 are split views there).
//   F4, F8    the external editor: Navigation Bar and Status Bar. F8 was the left panel
//             (toggle it with the left access bar, Window > Navigation Panel
//             or Shift+F4). F11 (the external editor: Full Screen) stays the Markups list
//             and Ctrl+L full screen.
//   Ctrl+F5   the external editor: Dimmer. main.js blocks the F5 reload; the keydown still
//             reaches keyboard-handlers.js, which runs view.dimmer.
//   Ctrl+3    the external editor: Dark Mode (content). Was free.
//   Alt+Left, Alt+Right  the external editor: Previous View / Next View.
//   Alt+Q, Alt+4  Form Fields and Signatures panels (panelRegistry.js).
//   Ctrl+Tab, Ctrl+Shift+Tab  the external editor: next / previous document tab
//             (DocumentTabs.jsx).
//   Ctrl+1, Ctrl+2  the external editor: Switch split / Split Vertical; here still Fit
//             Width / Fit Page. MultiView (docs/MULTIVIEW.md) takes the external editor's
//             Ctrl+H (Split Horizontal) and Ctrl+Shift+2 (Unsplit); Split
//             Vertical is Ctrl+Alt+2 (the external editor "2" plus Alt).
//   Ctrl+Shift+P  Find Tools + Commands too (our addition, beside Ctrl+K).
//   Ctrl+G    Group (the external editor). Go to Sheet (view.goToSheet) is Ctrl+J
//             ("jump"), a free key.
//   F         the external editor: File Attachment. Was free (no single-key or CAD-chord
//             use; Shift+F stays Flag, Ctrl+F Find, F1-F12 their own keys).

import { edition } from '../editions/active.js';

export const SHORTCUT_CATEGORIES = ['tools', 'measure', 'markup', 'file', 'edit', 'view', 'cad'];

// Measurement tools that "M" (last measure tool) may return to.
export const MEASURE_TOOL_NAMES = [
  'measureDistance', 'measurePolylength', 'measureArea', 'measurePerimeter',
  'measureVolume', 'measureAngle', 'measureArc', 'measureRadius3', 'diameter', 'radius', 'count', 'dynamicFill',
];

// Digit keys of the My Tools slots, in slot order: 1 = slot 1 … 0 = slot 10.
export const MY_TOOLS_SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** My Tools slot (1-10) of a binding ('1' → 1, '0' → 10), or null. */
export function myToolsSlotForKey(binding) {
  const index = MY_TOOLS_SLOT_KEYS.indexOf(binding);
  return index < 0 ? null : index + 1;
}

/** Hot key of a My Tools slot (1-10), or '' for a slot without one. */
export function myToolsSlotKey(slot) {
  return Number.isInteger(slot) && slot >= 1 && slot <= 10 ? MY_TOOLS_SLOT_KEYS[slot - 1] : '';
}

export const SHORTCUTS = [
  // ── Markup tools (the external editor single keys) ──
  { id: 'select', keys: 'V', category: 'tools', tool: 'select' },
  { id: 'pan', keys: 'Shift+V', category: 'tools', tool: 'hand' },
  { id: 'line', keys: 'L', category: 'tools', tool: 'line' },
  { id: 'arrow', keys: 'A', category: 'tools', tool: 'arrow' },
  { id: 'rectangle', keys: 'R', category: 'tools', tool: 'box' },
  { id: 'ellipse', keys: 'E', category: 'tools', tool: 'ellipse' },
  { id: 'cloud', keys: 'C', category: 'tools', tool: 'cloud' },
  { id: 'cloudPolyline', keys: 'K', category: 'tools', tool: 'cloudPolyline' },
  { id: 'callout', keys: 'Q', category: 'tools', tool: 'callout' },
  { id: 'textBox', keys: 'T', category: 'tools', tool: 'textbox' },
  { id: 'note', keys: 'N', category: 'tools', tool: 'comment' },
  { id: 'pen', keys: 'P', category: 'tools', tool: 'draw' },
  { id: 'highlight', keys: 'H', category: 'tools', tool: 'highlight' },
  { id: 'stamp', keys: 'S', category: 'tools', tool: 'stamp' },
  { id: 'image', keys: 'I', category: 'tools', command: 'pickImage' },
  { id: 'typewriter', keys: 'W', category: 'tools', tool: 'typewriter' },
  { id: 'hyperlink', keys: 'Shift+H', category: 'tools', tool: 'hyperlink' },
  { id: 'flag', keys: 'Shift+F', category: 'tools', tool: 'flag' },
  { id: 'fileAttachment', keys: 'F', category: 'tools', tool: 'fileAttachment' },
  // G with a selection starts the move session first (keyboard-handlers.js,
  // g-move-mode); otherwise Snapshot.
  { id: 'snapshot', keys: 'G', category: 'tools', tool: 'snapshot' },
  { id: 'dimension', keys: 'Shift+L', category: 'tools', tool: 'measureDistance' },
  { id: 'arc', keys: 'Shift+C', category: 'tools', tool: 'arc' },
  { id: 'eraser', keys: 'Shift+E', category: 'tools', tool: 'eraser' },
  { id: 'polyline', keys: 'Shift+N', category: 'tools', tool: 'polyline' },
  { id: 'polygon', keys: 'Shift+P', category: 'tools', tool: 'polygon' },
  // the external editor: the digit keys pick the first ten My Tools (Tool Chest); see
  // myToolsSlotForKey. The dialog shows the range once ('1-0').
  { id: 'myToolsSlot', keys: MY_TOOLS_SLOT_KEYS, display: '1-0', category: 'tools', command: 'myToolsSlot' },

  // ── Measure ──
  { id: 'lastMeasure', keys: 'M', category: 'measure', command: 'lastMeasure' },
  { id: 'length', keys: 'Shift+Alt+L', category: 'measure', tool: 'measureDistance' },
  { id: 'polylength', keys: 'Shift+Alt+Q', category: 'measure', tool: 'measurePolylength' },
  { id: 'area', keys: 'Shift+Alt+A', category: 'measure', tool: 'measureArea' },
  { id: 'perimeter', keys: 'Shift+Alt+P', category: 'measure', tool: 'measurePerimeter' },
  { id: 'volume', keys: 'Shift+Alt+V', category: 'measure', tool: 'measureVolume' },
  { id: 'diameter', keys: 'Shift+Alt+D', category: 'measure', tool: 'diameter' },
  { id: 'radius3', keys: 'Shift+Alt+U', category: 'measure', tool: 'measureRadius3' },
  { id: 'angle', keys: 'Shift+Alt+G', category: 'measure', tool: 'measureAngle' },
  { id: 'count', keys: 'Shift+Alt+C', category: 'measure', tool: 'count' },
  // the external editor: J = Dynamic Fill.
  { id: 'dynamicFill', keys: 'J', category: 'measure', tool: 'dynamicFill' },

  // ── Markup editing ──
  { id: 'group', keys: 'Ctrl+G', category: 'markup', command: 'group' },
  { id: 'ungroup', keys: 'Ctrl+Shift+G', category: 'markup', command: 'ungroup' },
  { id: 'lock', keys: 'Ctrl+Shift+L', category: 'markup', command: 'toggleLock' },
  { id: 'formatPainter', keys: 'Ctrl+Shift+C', category: 'markup', command: 'formatPainter' },
  // Edit menu completeness (docs/EDIT-TOOLS.md).
  { id: 'lasso', keys: 'Shift+O', category: 'tools', tool: 'lasso' },
  { id: 'offset', keys: 'O', category: 'tools', tool: 'offset' },

  // ── Handled by their own branch in keyboard-handlers.js ──
  { id: 'newDoc', keys: 'Ctrl+N', category: 'file', builtin: true },
  { id: 'open', keys: 'Ctrl+O', category: 'file', builtin: true },
  { id: 'save', keys: 'Ctrl+S', category: 'file', builtin: true },
  { id: 'saveAs', keys: 'Ctrl+Shift+S', category: 'file', builtin: true },
  { id: 'print', keys: 'Ctrl+P', category: 'file', builtin: true },
  { id: 'close', keys: 'Ctrl+W', category: 'file', builtin: true },
  { id: 'docProperties', keys: 'Ctrl+D', category: 'file', builtin: true, run: 'document.properties' },
  { id: 'flattenMarkups', keys: 'Ctrl+Shift+M', category: 'file', builtin: true, run: 'document.flatten' },
  { id: 'unflattenMarkups', keys: 'Ctrl+Shift+U', category: 'file', builtin: true, run: 'document.unflatten' },
  { id: 'preferences', keys: 'Ctrl+,', category: 'file', builtin: true, run: 'oculith.preferences' },
  { id: 'commandPalette', keys: ['Ctrl+K', 'Ctrl+Shift+P'], category: 'file', builtin: true, run: 'help.findCommands' },

  { id: 'undo', keys: 'Ctrl+Z', category: 'edit', builtin: true },
  { id: 'redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], category: 'edit', builtin: true },
  { id: 'delete', keys: 'Delete', category: 'edit', builtin: true },
  { id: 'selectAll', keys: 'Ctrl+A', category: 'edit', builtin: true },
  { id: 'cut', keys: 'Ctrl+X', category: 'edit', builtin: true },
  { id: 'copy', keys: 'Ctrl+C', category: 'edit', builtin: true },
  { id: 'paste', keys: 'Ctrl+V', category: 'edit', builtin: true },
  { id: 'pasteInPlace', keys: 'Ctrl+Shift+V', category: 'edit', builtin: true },
  { id: 'nudge', keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], category: 'edit', builtin: true },
  { id: 'escape', keys: 'Escape', category: 'edit', builtin: true },
  { id: 'selectionCycle', keys: 'Shift+Space', category: 'edit', builtin: true, run: 'edit.cycleSelection' },
  { id: 'undoHistory', keys: 'Ctrl+Shift+H', category: 'edit', builtin: true, run: 'edit.undoHistory' },

  { id: 'zoomIn', keys: 'Ctrl+=', category: 'view', builtin: true },
  { id: 'zoomOut', keys: 'Ctrl+-', category: 'view', builtin: true },
  { id: 'actualSize', keys: 'Ctrl+0', category: 'view', builtin: true },
  { id: 'fitWidth', keys: 'Ctrl+1', category: 'view', builtin: true },
  { id: 'fitPage', keys: 'Ctrl+2', category: 'view', builtin: true },
  { id: 'thinLines', keys: 'Ctrl+5', category: 'view', builtin: true },
  { id: 'rotatePageRight', keys: 'Ctrl+Shift++', category: 'view', builtin: true },
  { id: 'rotatePageLeft', keys: 'Ctrl+Shift+_', category: 'view', builtin: true },
  { id: 'find', keys: 'Ctrl+F', category: 'view', builtin: true },
  { id: 'findNext', keys: 'F3', category: 'view', builtin: true },
  { id: 'fullscreen', keys: 'Ctrl+L', category: 'view', builtin: true },
  { id: 'shortcuts', keys: 'F1', category: 'view', builtin: true },
  { id: 'navigationBar', keys: 'F4', category: 'view', builtin: true, run: 'tools.toolbar.navigation' },
  { id: 'showGridF7', keys: 'F7', category: 'view', builtin: true },
  { id: 'statusBar', keys: 'F8', category: 'view', builtin: true, run: 'tools.toolbar.status' },
  { id: 'menuBar', keys: 'F9', category: 'view', builtin: true, run: 'view.menuBar' },
  { id: 'polarTracking', keys: 'F10', category: 'view', builtin: true },
  { id: 'markupsList', keys: 'F11', category: 'view', builtin: true },
  { id: 'properties', keys: 'F12', category: 'view', builtin: true },
  { id: 'objectSnap', keys: 'Shift+F3', category: 'view', builtin: true },
  { id: 'snapContent', keys: 'Ctrl+Shift+F8', category: 'view', builtin: true },
  { id: 'snapMarkup', keys: 'Ctrl+Shift+F7', category: 'view', builtin: true },
  { id: 'snapGrid', keys: 'Ctrl+Shift+F9', category: 'view', builtin: true },
  { id: 'showGrid', keys: 'Shift+F9', category: 'view', builtin: true },
  { id: 'singlePage', keys: 'Ctrl+4', category: 'view', builtin: true, run: 'view.singlePage' },
  { id: 'sideBySide', keys: 'Ctrl+6', category: 'view', builtin: true, run: 'view.sideBySide' },
  { id: 'continuousSideBySide', keys: 'Ctrl+7', category: 'view', builtin: true, run: 'view.continuousSideBySide' },
  { id: 'darkMode', keys: 'Ctrl+3', category: 'view', builtin: true, run: 'view.darkMode' },
  { id: 'dimmer', keys: 'Ctrl+F5', category: 'view', builtin: true, run: 'view.dimmer' },
  { id: 'splitVertical', keys: 'Ctrl+Alt+2', category: 'view', builtin: true, run: 'view.splitVertical' },
  { id: 'splitHorizontal', keys: 'Ctrl+H', category: 'view', builtin: true, run: 'view.splitHorizontal' },
  { id: 'unsplit', keys: 'Ctrl+Shift+2', category: 'view', builtin: true, run: 'view.unsplit' },
  { id: 'previousView', keys: 'Alt+ArrowLeft', category: 'view', builtin: true },
  { id: 'nextView', keys: 'Alt+ArrowRight', category: 'view', builtin: true },
  // Go to Sheet: main.js still blocks the webview's own Ctrl+J (its
  // downloads/console key); that only prevents the default, so this runs.
  { id: 'goToSheet', keys: 'Ctrl+J', category: 'view', builtin: true, run: 'view.goToSheet' },
  { id: 'nextDocument', keys: ['Ctrl+Tab', 'Ctrl+Shift+Tab'], display: 'Ctrl+(Shift+)Tab', category: 'view', builtin: true },

  // Workspace: panels (the external editor keys) and the menu bar mnemonics.
  { id: 'hidePanels', keys: 'Shift+F4', category: 'view', builtin: true, run: 'window.hidePanels' },
  { id: 'leftPanel', keys: 'Ctrl+B', category: 'view', builtin: true, run: 'window.leftPanel' },
  { id: 'panelToolChest', keys: 'Alt+X', category: 'view', builtin: true, run: 'window.panel.toolChest' },
  { id: 'panelMarkupsList', keys: 'Alt+L', category: 'view', builtin: true, run: 'window.panel.markupsList' },
  { id: 'panelThumbnails', keys: 'Alt+T', category: 'view', builtin: true, run: 'window.panel.thumbnails' },
  { id: 'panelProperties', keys: 'Alt+P', category: 'view', builtin: true, run: 'window.panel.properties' },
  { id: 'panelMeasurements', keys: 'Alt+U', category: 'view', builtin: true, run: 'window.panel.measurements' },
  { id: 'panelLayers', keys: 'Alt+Y', category: 'view', builtin: true, run: 'window.panel.layers' },
  { id: 'panelBookmarks', keys: 'Alt+B', category: 'view', builtin: true, run: 'window.panel.bookmarks' },
  { id: 'panelLinks', keys: 'Alt+N', category: 'view', builtin: true, run: 'window.panel.links' },
  { id: 'panelSearch', keys: 'Alt+1', category: 'view', builtin: true, run: 'window.panel.search' },
  { id: 'panelSheets', keys: 'Alt+2', category: 'view', builtin: true, run: 'window.panel.sheets' },
  { id: 'panelFormFields', keys: 'Alt+Q', category: 'view', builtin: true, run: 'window.panel.formFields' },
  { id: 'panelSignatures', keys: 'Alt+4', category: 'view', builtin: true, run: 'window.panel.signatures' },
  { id: 'panelSpaces', keys: 'Alt+S', category: 'view', builtin: true, run: 'window.panel.spaces', label: 'common:spaces.shortcut' },
  ...edition.panels.filter((panel) => panel.shortcut).map((panel) => ({
    id: `panel:${panel.id}`, keys: panel.shortcut, category: 'view', builtin: true,
    run: `window.panel.${panel.id}`, label: panel.commandLabel || panel.title,
  })),
  { id: 'menuMnemonics', keys: ['Alt+O', 'Alt+F', 'Alt+E', 'Alt+V', 'Alt+D', 'Alt+W', 'Alt+H'], display: 'Alt+O/F/E/V/D/W/H', category: 'view', builtin: true },

  // CAD command chords (CAD_CHORDS in keyboard-handlers.js), typed in turn.
  { id: 'cadTrim', keys: 'T R', category: 'cad', builtin: true, sequence: true },
  { id: 'cadExtend', keys: 'E X', category: 'cad', builtin: true, sequence: true },
  { id: 'cadText', keys: 'T X', category: 'cad', builtin: true, sequence: true },
  { id: 'cadLineweight', keys: 'T L', category: 'cad', builtin: true, sequence: true },
  { id: 'cadCreateSimilar', keys: 'C S', category: 'cad', builtin: true, sequence: true },
  { id: 'cadMove', keys: 'M V', category: 'cad', builtin: true, sequence: true },
  { id: 'cadCopy', keys: 'C O', category: 'cad', builtin: true, sequence: true },
  { id: 'cadRotate', keys: 'R O', category: 'cad', builtin: true, sequence: true },
];

/** All bindings of an entry as an array. */
export function shortcutKeys(entry) {
  return Array.isArray(entry.keys) ? entry.keys : [entry.keys];
}

/**
 * Is focus in a place where the user is typing (input, textarea, select,
 * contenteditable)? Shortcuts without Ctrl never fire there.
 */
export function isTextEntryTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return typeof t.closest === 'function' && !!t.closest('[contenteditable="true"]');
}

/**
 * Canonical binding of a keydown event ('Shift+Alt+L'), or '' for a lone
 * modifier. Letters come from e.key when it is a letter, else from e.code
 * (Alt can turn e.key into another character, e.g. on macOS).
 */
export function eventKeys(e) {
  if (!e || typeof e.key !== 'string') return '';
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return '';
  let key;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (/^Key[A-Z]$/.test(e.code || '')) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code || '') && (e.altKey || !/^[0-9]$/.test(e.key))) key = e.code.slice(5);
  else key = e.key === ' ' ? 'Space' : e.key;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  return [...mods, key].join('+');
}

const _actionIndex = new Map();
for (const entry of SHORTCUTS) {
  if (entry.builtin || entry.sequence) continue;
  for (const k of shortcutKeys(entry)) _actionIndex.set(k, entry);
}

/**
 * The table entry with an action for this keydown, or null. Nothing fires
 * while typing in a text field or for a repeated (held) key.
 */
export function resolveShortcut(e) {
  if (!e || e.repeat) return null;
  if (isTextEntryTarget(e.target)) return null;
  const keys = eventKeys(e);
  if (!keys) return null;
  return _actionIndex.get(keys) || null;
}

const _registryIndex = new Map();
for (const entry of SHORTCUTS) {
  if (!entry.run) continue;
  for (const k of shortcutKeys(entry)) _registryIndex.set(k, entry);
}

/**
 * The entry whose `run` command this keydown triggers, or null (same rules
 * as resolveShortcut: not while typing, not for a held key).
 */
export function resolveRegistryShortcut(e) {
  if (!e || e.repeat) return null;
  if (isTextEntryTarget(e.target)) return null;
  const keys = eventKeys(e);
  return keys ? _registryIndex.get(keys) || null : null;
}

/** The plain single-letter entry for a letter ('c' → Cloud), or null. */
export function singleLetterEntry(letter) {
  if (typeof letter !== 'string' || !/^[a-z]$/i.test(letter)) return null;
  return _actionIndex.get(letter.toUpperCase()) || null;
}

/** Keys of a binding for display: 'Ctrl+Shift+L' → ['Ctrl', 'Shift', 'L']. */
export function displayKeys(binding) {
  if (binding.includes(' ')) return binding.split(' ');
  if (binding.endsWith('++')) return [...binding.slice(0, -2).split('+'), '+'];
  return binding.split('+').map(k => ({
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Del', Escape: 'Esc',
  }[k] || k));
}

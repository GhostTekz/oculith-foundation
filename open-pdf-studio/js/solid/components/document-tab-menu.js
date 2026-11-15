// Document tab strip helpers (external plan-review files tabs, docs/reference/editor/workspace.md
// and WP4). Pure: no Solid, no app state, so node tests can cover them.

/**
 * Items of a tab's right-click menu, in order, with `null` for a separator.
 * the external editor: Close / Close All / Close Others | Split Vertical / Split Horizontal /
 * Switch (+ Detach) | Show in folder | Properties. Split Vertical /
 * Horizontal split the workspace (MultiView, docs/reference/editor/workspace.md); Switch
 * moves the tab to the other split, so it needs a split view (`split`).
 * Detach and Show in folder need the desktop shell; Show in folder also
 * needs a real file on disk.
 */
export function docTabMenuItems({ index = 0, count = 0, desktop = false, canReveal = false, split = false } = {}) {
  const valid = index >= 0 && index < count;
  const items = [
    { id: 'close', disabled: !valid, shortcut: 'Ctrl+W' },
    { id: 'closeAll', disabled: count === 0 },
    { id: 'closeOthers', disabled: !valid || count < 2 },
    null,
    // the external editor's Ctrl+2 is Fit Page here; Split Vertical is Ctrl+Alt+2.
    { id: 'splitVertical', disabled: !valid, shortcut: 'Ctrl+Alt+2' },
    { id: 'splitHorizontal', disabled: !valid, shortcut: 'Ctrl+H' },
    { id: 'switch', disabled: !valid || !split },
  ];
  if (desktop) items.push({ id: 'detach', disabled: !valid });
  if (desktop && canReveal) items.push(null, { id: 'showInFolder', disabled: !valid });
  items.push(null, { id: 'properties', disabled: !valid, shortcut: 'Ctrl+D' });
  return items;
}

/**
 * Document indices a close action closes, highest first so closing one does
 * not shift the indices still to come.
 */
export function tabsToClose(action, index, count) {
  const all = Array.from({ length: Math.max(0, count) }, (_, i) => count - 1 - i);
  if (action === 'closeAll') return all;
  if (action === 'closeOthers') return index >= 0 && index < count ? all.filter((i) => i !== index) : [];
  if (action === 'close') return index >= 0 && index < count ? [index] : [];
  return [];
}

/** Ctrl+Tab (+1) / Ctrl+Shift+Tab (-1): the next tab, wrapping around. */
export function cycleTabIndex(active, count, direction) {
  if (!(count > 0)) return -1;
  const from = active >= 0 && active < count ? active : (direction < 0 ? 0 : count - 1);
  return (((from + (direction < 0 ? -1 : 1)) % count) + count) % count;
}

/** Visible tab label: file name, with a leading '*' when there are unsaved changes. */
export function tabLabel(doc) {
  if (!doc) return '';
  return `${doc.modified ? '*' : ''}${doc.fileName || ''}`;
}

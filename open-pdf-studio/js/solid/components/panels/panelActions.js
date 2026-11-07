// What the access bars, panel headers, menus and shortcuts do to the
// workspace layout. Every change goes through the workspaceLayout setters
// (they persist to preferences); the decisions come from panelHostLogic.js.
//
// For WP1 (menu bar / command registry): Window ▸ Panels ▸ <panel> can call
// togglePanel(id) or activatePanel(id); Window ▸ Hide Panels (Shift+F4) calls
// hideAllPanels(). installPanelShortcuts() binds Shift+F4 and the Alt panel
// keys on window (bubble phase) and skips any keydown that an earlier handler
// already preventDefault()-ed, so a registry binding in keyboard-handlers.js
// (on document) wins without double toggling.

import { untrack } from 'solid-js';
import {
  HOSTS, workspaceLayout, getHost, findPanelHost,
  setActivePanel, movePanel, showPanel, hidePanel, setHostCollapsed, saveWorkspaceLayout,
} from '../../stores/workspaceLayout.js';
import { setFocusedPanel, toLegacyId } from '../../stores/leftPanelStore.js';
import { isPanelShown, toggleAllHosts, attachTargets, showMenuItems } from './panelHostLogic.js';
import { panelForShortcut, PANEL_ORDER, getPanelEntry, panelTitle } from './panelRegistry.js';

// Panels whose list is built on demand (ui/panels/left-panel.js refreshes them
// when they come up).
const REFRESHED = new Set(['markupsList', 'attachments', 'signatures', 'layers', 'formFields', 'links', 'tags', 'bookmarks']);

function refreshContent(panelId) {
  if (!REFRESHED.has(panelId)) return;
  import('../../../ui/panels/left-panel.js')
    .then((m) => {
      m.refreshLeftPanelTab?.(toLegacyId(panelId));
      if (panelId === 'links') m.refreshLeftPanelTab?.('destinations');
    })
    .catch(() => {});
}

/** Is this panel on screen (active in its host, the host open)? For add-on commands' checked state. */
export { panelShown } from '../../stores/leftPanelStore.js';

/** Bring a panel up wherever it lives (a hidden one returns to its default host). */
export function activatePanel(panelId) {
  showPanel(panelId);
  setFocusedPanel(panelId);
  refreshContent(panelId);
}

/** Show it, or collapse its host when it is already on screen (Alt+P etc.). */
export function togglePanel(panelId) {
  const layout = untrack(workspaceLayout);
  if (isPanelShown(layout, panelId)) {
    setHostCollapsed(findPanelHost(layout, panelId), true);
    return false;
  }
  activatePanel(panelId);
  return true;
}

/** Access-bar click: the open active tab collapses its host, any other tab activates. */
export function clickAccessTab(host, panelId) {
  const h = untrack(() => getHost(host));
  if (!h || !h.tabs.includes(panelId)) return;
  if (h.active === panelId && !h.collapsed) {
    setHostCollapsed(host, true);
    return;
  }
  setActivePanel(host, panelId);
  setFocusedPanel(panelId);
  refreshContent(panelId);
}

/** Attach ▸ Left / Right / Bottom. */
export function attachPanel(panelId, host) {
  if (!HOSTS.includes(host)) return;
  if (findPanelHost(untrack(workspaceLayout), panelId) === host) setActivePanel(host, panelId);
  else movePanel(panelId, host);
  setFocusedPanel(panelId);
  refreshContent(panelId);
}

/** Hide (remove from its host; Window ▸ Panels / Show ▸ bring it back). */
export function hidePanelById(panelId) {
  hidePanel(panelId);
}

/** Collapse / expand a whole host (edge click, bottom » toggle). */
export function toggleHost(host) {
  const h = untrack(() => getHost(host));
  if (!h) return;
  setHostCollapsed(host, !h.collapsed);
}

let hiddenMemory = null;

/** Shift+F4 Hide Panels: collapse every open host; again restores them. */
export function hideAllPanels() {
  const before = untrack(workspaceLayout);
  const { layout, memory } = toggleAllHosts(before, hiddenMemory);
  hiddenMemory = memory;
  let changed = false;
  for (const host of HOSTS) {
    if (layout.hosts[host].collapsed !== before.hosts[host].collapsed) {
      setHostCollapsed(host, layout.hosts[host].collapsed, { persist: false });
      changed = true;
    }
  }
  if (changed) saveWorkspaceLayout();
  return changed;
}

/** Keydown handler for Shift+F4 and the Alt panel shortcuts; true when handled. */
export function handlePanelShortcut(event) {
  if (!event || event.defaultPrevented) return false;
  if (event.key === 'F4' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    hideAllPanels();
    return true;
  }
  const panelId = panelForShortcut(event);
  if (!panelId) return false;
  event.preventDefault();
  togglePanel(panelId);
  return true;
}

let installed = false;

/** Bind the panel keys once (guarded against a second install). */
export function installPanelShortcuts(target = globalThis.window) {
  if (installed || !target?.addEventListener) return false;
  installed = true;
  target.addEventListener('keydown', handlePanelShortcut);
  return true;
}

/**
 * Menu items for a panel (PanelMenu.jsx shape). The access-bar tab menu is
 * Show ▸ / Hide / Attach ▸ (the external editor); the header ▾ menu puts the panel's own
 * items first and leaves Show ▸ out.
 */
export function panelMenuItems(panelId, t, { header = false } = {}) {
  const layout = untrack(workspaceLayout);
  const where = findPanelHost(layout, panelId);
  const items = [];
  if (header) {
    for (const extra of getPanelEntry(panelId)?.menu || []) items.push({ label: t(extra.label), run: extra.run });
    if (items.length) items.push({ separator: true });
  } else {
    items.push({
      label: t('common:panelHost.show'),
      items: showMenuItems(layout, PANEL_ORDER).map(({ id, shown }) => ({
        label: panelTitle(id, t), icon: getPanelEntry(id)?.icon, checked: shown, run: () => activatePanel(id),
      })),
    });
  }
  items.push({ label: t('common:panelHost.hide'), disabled: !where, run: () => hidePanelById(panelId) });
  items.push({
    label: t('common:panelHost.attach'),
    items: attachTargets(layout, panelId).map(({ host, current }) => ({
      label: t(`common:panelHost.${host}`), checked: current, run: () => attachPanel(panelId, host),
    })),
  });
  return items;
}

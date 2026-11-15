// Pure helpers behind the panel hosts (PanelHost / AccessBar / PanelHeader).
// No Solid, no DOM: layout in, answer (or new layout) out, so the node tests
// can cover what the hosts render and do. The layout is the workspaceLayout
// shape (docs/reference/editor/workspace.md).

import {
  HOSTS, PANEL_IDS, clampHostSize, findPanelHost,
  withActivePanel, withHostCollapsed, withPanelMoved,
} from '../../stores/workspaceLayout.js';

export const ACCESS_BAR_PX = 36;
export const EDGE_PX = 5;
// Pointer travel (px) below which a press on a host edge counts as a click.
export const EDGE_CLICK_SLOP = 3;

/** True when the host shows its panel area (it has tabs and is not collapsed). */
export function isHostOpen(layout, host) {
  const h = layout?.hosts?.[host];
  return !!h && h.tabs.length > 0 && !h.collapsed && !!h.active;
}

/**
 * Whether the host's access bar is drawn. Left: always (the external editor keeps the left
 * bar even with every panel closed, so panels can come back). Right and
 * bottom: only while they hold tabs.
 */
export function isAccessBarVisible(layout, host) {
  const h = layout?.hosts?.[host];
  if (!h) return false;
  return host === 'left' ? true : h.tabs.length > 0;
}

/** The access-bar buttons of a host: [{ id, active }] in tab order. */
export function accessBarItems(layout, host) {
  const h = layout?.hosts?.[host];
  if (!h) return [];
  return h.tabs.map((id) => ({ id, active: id === h.active && !h.collapsed }));
}

/** True when panelId is in a host, is that host's active tab, and the host is open. */
export function isPanelShown(layout, panelId) {
  const host = findPanelHost(layout, panelId);
  return !!host && layout.hosts[host].active === panelId && isHostOpen(layout, host);
}

/**
 * Clicking an access-bar tab (the external editor): the active tab of an open host collapses
 * the host; any other tab (or the active tab of a collapsed host) is activated
 * and the host opens.
 */
export function withTabClicked(layout, host, panelId) {
  const h = layout?.hosts?.[host];
  if (!h || !h.tabs.includes(panelId)) return layout;
  if (h.active === panelId && !h.collapsed) return withHostCollapsed(layout, host, true);
  return withActivePanel(layout, host, panelId);
}

/**
 * Toggle a panel (Alt+P and friends): shown → collapse its host; hidden or
 * collapsed → show it (a hidden panel returns to its default host).
 */
export function withPanelToggled(layout, panelId, showFn) {
  if (isPanelShown(layout, panelId)) return withHostCollapsed(layout, findPanelHost(layout, panelId), true);
  return showFn(layout, panelId);
}

/**
 * Shift+F4 "Hide Panels": collapse every open host and remember which were
 * open; pressing it again opens those again. When nothing was remembered
 * (all were already closed), every host with tabs opens.
 * Returns { layout, memory } (memory = host names to reopen, or null).
 */
export function toggleAllHosts(layout, memory) {
  const open = HOSTS.filter((h) => isHostOpen(layout, h));
  if (open.length) {
    let next = layout;
    for (const h of open) next = withHostCollapsed(next, h, true);
    return { layout: next, memory: open };
  }
  const reopen = (memory?.length ? memory : HOSTS).filter((h) => layout.hosts[h].tabs.length > 0);
  let next = layout;
  for (const h of reopen) next = withHostCollapsed(next, h, false);
  return { layout: next, memory: null };
}

/** Attach ▸ targets for a panel: [{ host, current }] (current = where it is now). */
export function attachTargets(layout, panelId) {
  const where = findPanelHost(layout, panelId);
  return HOSTS.map((host) => ({ host, current: host === where }));
}

/** Attach a panel to a host (no-op when it is already there; it is then activated). */
export function withPanelAttached(layout, panelId, host) {
  if (findPanelHost(layout, panelId) === host) return withActivePanel(layout, host, panelId);
  return withPanelMoved(layout, panelId, host);
}

/** Show ▸ list for the tab context menu: every panel, shown = in a host. */
export function showMenuItems(layout, order = PANEL_IDS) {
  return order.map((id) => ({ id, host: findPanelHost(layout, id), shown: !!findPanelHost(layout, id) }));
}

/**
 * Host size while dragging its inner edge. Left grows to the right, right and
 * bottom grow towards the canvas (left / up); RTL mirrors the side hosts.
 * delta = pointer position now − at pointerdown (clientX, or clientY for bottom).
 */
export function resizedHostSize(host, startSize, delta, { rtl = false } = {}) {
  let sign = host === 'left' ? 1 : -1;
  if (rtl && host !== 'bottom') sign = -sign;
  return clampHostSize(host, startSize + sign * delta);
}

/** Keyboard resize on a focused edge: 16 px per arrow key, toward the canvas = bigger. */
export function keyResizedHostSize(host, size, key, { rtl = false } = {}) {
  const grow = host === 'bottom' ? 'ArrowUp' : ((host === 'left') !== rtl ? 'ArrowRight' : 'ArrowLeft');
  const shrink = host === 'bottom' ? 'ArrowDown' : ((host === 'left') !== rtl ? 'ArrowLeft' : 'ArrowRight');
  if (key === grow) return clampHostSize(host, size + 16);
  if (key === shrink) return clampHostSize(host, size - 16);
  return null;
}

/** True when a pointer press on an edge stayed within the click slop. */
export function isEdgeClick(dx, dy) {
  return Math.abs(dx) <= EDGE_CLICK_SLOP && Math.abs(dy) <= EDGE_CLICK_SLOP;
}

// Footer size slider (Thumbnails, Tool Chest): a zoom factor per panel.
export const PANEL_ZOOM_RANGE = Object.freeze({ min: 0.6, max: 1.6, step: 0.1 });

/** A stored zoom factor, clamped to the slider range (1 when missing or bad). */
export function clampPanelZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const { min, max } = PANEL_ZOOM_RANGE;
  return Math.round(Math.max(min, Math.min(max, n)) * 10) / 10;
}

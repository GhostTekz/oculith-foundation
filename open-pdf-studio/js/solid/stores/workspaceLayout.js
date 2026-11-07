// Workspace layout: which panels sit in which host (left / right / bottom),
// the host sizes, which toolbars show, and the active profile. Contract for
// the plan-review workspace, see docs/WORKSPACE-SPEC.md §5 and "Contract".
//
// Shape (WorkspaceLayout, version 1):
//   { version: 1, profile: 'oculith',
//     hosts: { left:   { tabs: [panelId…], active: panelId|null, size, collapsed },
//              right:  { … }, bottom: { … } },
//     toolbars: { standard:{visible}, markup:{visible,dock,order},
//                 measure:{visible,dock,order}, properties:{visible},
//                 navigation:{visible}, status:{visible}, menu:{visible},
//                 locked: true },
//     autoHidePanelAccess: false,
//     profileSizes: { [profile]: { left?, right?, bottom? } },
//     workflow: workflowId|null,        the workflow tab the profile opens on
//     workflows: [workflowId…]|null,    the workflow tabs shown (null = all)
//     workflowBar: 1 }                  marks layouts saved since the workflow
//                                       toolbar ('standard') renders
//
// Profiles: the built-in ones below plus any an edition brings
// (edition.profiles: { id, label, base, workflow?, workflows?, hosts?,
// toolbars? }; docs/foundation/GUIDE.md, Profiles); an edition profile starts from its
// base built-in profile and overrides what it names.
//
// A panel is in at most one host; a panel in no host is hidden (Window >
// Panels shows it again with showPanel). Tab order = access-bar order.
//
// The with*/create*/normalize*/migrate* functions are pure (layout in, new
// layout out) and never touch Solid or preferences. The store below wraps
// them: workspaceLayout() is a Solid signal, every setter commits a new
// layout object and, unless { persist: false }, writes it to
// state.preferences.workspaceLayout and calls savePreferences().
// Nothing reads the old workspaceProfile / workspacePanelSizes keys after
// migration, but they are left in place for one release.

import { createSignal } from 'solid-js';
import { state } from '../../core/state.js';
import { savePreferences } from '../../core/preferences.js';
import { edition } from '../../editions/active.js';

export const LAYOUT_VERSION = 1;
export const HOSTS = Object.freeze(['left', 'right', 'bottom']);
export const PANEL_IDS = Object.freeze([
  'thumbnails', 'sheets', 'bookmarks', 'layers', 'toolChest', 'links',
  'measurements', 'properties', 'formFields', 'signatures', 'attachments',
  'search', 'tags', 'quantities', 'markupsList', 'elementVisibility',
  'annotationLayers', 'spaces', ...edition.panelIds,
]);
export const TOOLBAR_IDS = Object.freeze(['standard', 'markup', 'measure', 'properties', 'navigation', 'status', 'menu']);
export const TOOLBAR_DOCKS = Object.freeze(['top', 'left', 'right', 'bottom']);
export const BUILTIN_PROFILE_IDS = Object.freeze(['oculith', 'basic', 'reviewer', 'oculithAdvanced', 'quantityTakeoff', 'document']);
const EDITION_PROFILES = (edition.profiles || []).filter((p) => !BUILTIN_PROFILE_IDS.includes(p.id));
export const PROFILE_IDS = Object.freeze([...BUILTIN_PROFILE_IDS, ...EDITION_PROFILES.map((p) => p.id)]);
/** Label key (or text) of a profile: an edition profile names its own. */
export function profileLabelKey(id) {
  return EDITION_PROFILES.find((p) => p.id === id)?.label || `common:panelHost.profile.${id}`;
}
export const DEFAULT_PROFILE = 'oculith';
export const SIZE_LIMITS = Object.freeze({ side: Object.freeze([200, 520]), bottom: Object.freeze([140, 520]) });
// Old WORKSPACE_PROFILES (workspaceProfiles.js) → new profile ids (spec R12).
export const LEGACY_PROFILE_MAP = Object.freeze({
  review: 'oculithAdvanced', markup: 'oculith', takeoff: 'quantityTakeoff', document: 'document',
});

// Access-bar order of the left host (spec R5).
const LEFT_ORDER = [
  'thumbnails', 'sheets', 'bookmarks', 'layers', 'toolChest', 'links',
  'measurements', 'properties', 'formFields', 'signatures', 'attachments',
  'search', 'tags', 'spaces', ...edition.panelIds,
];
const BOTTOM_TABS = ['markupsList', 'quantities'];

const host = (tabs, active, size, collapsed) => ({ tabs: [...tabs], active, size, collapsed });
const without = (list, id) => list.filter((x) => x !== id);

function toolbars({ standard = true, markup = true, measure = true } = {}) {
  return {
    standard: { visible: standard },
    markup: { visible: markup, dock: 'right', order: 0 },
    measure: { visible: measure, dock: 'right', order: 1 },
    properties: { visible: true },
    navigation: { visible: true },
    status: { visible: true },
    menu: { visible: true },
    locked: true,
  };
}

// Built-in profiles (spec §5 table). Each opens the workflow toolbar on one
// workflow tab and may limit the tabs it shows (null = every workflow).
const PROFILES = {
  oculith: () => ({
    hosts: {
      left: host(LEFT_ORDER, 'toolChest', 300, false),
      right: host([], null, 300, true),
      bottom: host(BOTTOM_TABS, 'markupsList', 230, false),
    },
    toolbars: toolbars(),
    workflow: 'markup',
    workflows: null,
  }),
  // The essentials: review, simple markup and measuring, pages and output.
  basic: () => ({
    hosts: {
      left: host(LEFT_ORDER, 'thumbnails', 260, false),
      right: host([], null, 300, true),
      bottom: host(BOTTOM_TABS, 'markupsList', 230, true),
    },
    toolbars: toolbars({ markup: false, measure: false }),
    workflow: 'review',
    workflows: ['review', 'markup', 'measure', 'sheets', 'output', 'view'],
  }),
  // Drawing review: comments, compare, the Properties panel at the right.
  // No side toolbar: the workflow toolbar holds the same markup tools.
  reviewer: () => ({
    hosts: {
      left: host(without(LEFT_ORDER, 'properties'), 'thumbnails', 260, false),
      right: host(['properties'], 'properties', 300, false),
      bottom: host(BOTTOM_TABS, 'markupsList', 230, false),
    },
    toolbars: toolbars({ markup: false, measure: false }),
    workflow: 'review',
    workflows: ['review', 'markup', 'compare', 'sheets', 'output', 'view'],
  }),
  oculithAdvanced: () => ({
    hosts: {
      left: host(without(LEFT_ORDER, 'properties'), 'thumbnails', 260, false),
      right: host(['properties'], 'properties', 300, false),
      bottom: host(BOTTOM_TABS, 'markupsList', 230, false),
    },
    toolbars: toolbars({ standard: true }),
    workflow: 'review',
    workflows: null,
  }),
  quantityTakeoff: () => ({
    hosts: {
      left: host(LEFT_ORDER, 'measurements', 300, false),
      right: host([], null, 300, true),
      bottom: host(BOTTOM_TABS, 'quantities', 260, false),
    },
    toolbars: toolbars({ standard: true, markup: false }),
    workflow: 'takeoff',
    workflows: null,
  }),
  document: () => ({
    hosts: {
      left: host(LEFT_ORDER, 'thumbnails', 260, false),
      right: host([], null, 300, true),
      bottom: host(BOTTOM_TABS, 'markupsList', 230, true),
    },
    toolbars: toolbars({ markup: false, measure: false }),
    workflow: 'sheets',
    workflows: ['sheets', 'review', 'compare', 'output', 'view'],
    // Page work only: no workflow tab an edition or add-on adds.
    addOnWorkflows: false,
  }),
};

// An edition profile: its base built-in profile with the hosts, toolbars and
// workflows it names. Unknown panels in its hosts are ignored.
function editionProfile(def) {
  const base = PROFILES[BUILTIN_PROFILE_IDS.includes(def.base) ? def.base : DEFAULT_PROFILE]();
  for (const h of HOSTS) {
    const o = def.hosts?.[h];
    if (!o) continue;
    const hs = base.hosts[h];
    if (Array.isArray(o.tabs)) hs.tabs = o.tabs.filter((id) => PANEL_IDS.includes(id));
    if (typeof o.active === 'string' && PANEL_IDS.includes(o.active)) {
      if (!hs.tabs.includes(o.active)) hs.tabs.push(o.active);
      hs.active = o.active;
    }
    if (o.size !== undefined) hs.size = clampHostSize(h, o.size);
    if (typeof o.collapsed === 'boolean') hs.collapsed = o.collapsed;
  }
  for (const [id, visible] of Object.entries(def.toolbars || {})) {
    if (base.toolbars[id] && typeof visible === 'boolean') base.toolbars[id].visible = visible;
  }
  if (typeof def.workflow === 'string') base.workflow = def.workflow;
  if (Array.isArray(def.workflows)) base.workflows = [...def.workflows];
  delete base.addOnWorkflows;
  return base;
}
for (const def of EDITION_PROFILES) PROFILES[def.id] = () => editionProfile(def);

const NO_ADDON_WORKFLOWS = new Set(PROFILE_IDS.filter((id) => PROFILES[id]().addOnWorkflows === false));

/**
 * Does this profile show the workflow tabs an edition or add-on adds? A
 * built-in profile can leave them out (addOnWorkflows: false).
 */
export function profileShowsAddOnWorkflows(id) {
  return !NO_ADDON_WORKFLOWS.has(id);
}

const isHost = (h) => HOSTS.includes(h);
const isPanel = (id) => PANEL_IDS.includes(id);
const clone = (layout) => JSON.parse(JSON.stringify(layout));

/** Clamp a host size to SIZE_LIMITS (side 200–520, bottom 140–520). */
export function clampHostSize(hostName, size) {
  const [min, max] = hostName === 'bottom' ? SIZE_LIMITS.bottom : SIZE_LIMITS.side;
  const n = Number(size);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** The default layout of a built-in profile (unknown name → oculith). */
export function createProfileLayout(name = DEFAULT_PROFILE, profileSizes = {}) {
  const profile = PROFILE_IDS.includes(name) ? name : DEFAULT_PROFILE;
  const def = PROFILES[profile]();
  const sizes = profileSizes?.[profile] || {};
  for (const h of HOSTS) {
    if (sizes[h] !== undefined) def.hosts[h].size = clampHostSize(h, sizes[h]);
  }
  return {
    version: LAYOUT_VERSION,
    profile,
    hosts: def.hosts,
    toolbars: def.toolbars,
    autoHidePanelAccess: false,
    profileSizes: clone(profileSizes || {}),
    // The panels this layout has seen: one added later is placed once.
    knownPanels: [...PANEL_IDS],
    workflow: def.workflow ?? null,
    workflows: def.workflows ? [...def.workflows] : null,
    workflowBar: 1,
  };
}

/** Name of the host holding panelId, or null when it is hidden/unknown. */
export function findPanelHost(layout, panelId) {
  return HOSTS.find((h) => layout.hosts[h].tabs.includes(panelId)) || null;
}

/** Make panelId the active tab of hostName and expand that host. */
export function withActivePanel(layout, hostName, panelId) {
  if (!isHost(hostName) || !layout.hosts[hostName].tabs.includes(panelId)) return layout;
  const next = clone(layout);
  next.hosts[hostName].active = panelId;
  next.hosts[hostName].collapsed = false;
  return next;
}

function removeFromHosts(next, panelId) {
  for (const h of HOSTS) {
    const hs = next.hosts[h];
    if (!hs.tabs.includes(panelId)) continue;
    const at = hs.tabs.indexOf(panelId);
    hs.tabs.splice(at, 1);
    if (hs.active === panelId) hs.active = hs.tabs[Math.min(at, hs.tabs.length - 1)] ?? null;
  }
}

/**
 * Move panelId into hostName (at index, default the end) and make it the
 * active tab there. The host it left picks its neighbour as active.
 */
export function withPanelMoved(layout, panelId, hostName, { index } = {}) {
  if (!isPanel(panelId) || !isHost(hostName)) return layout;
  const next = clone(layout);
  removeFromHosts(next, panelId);
  const tabs = next.hosts[hostName].tabs;
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, tabs.length)) : tabs.length;
  tabs.splice(at, 0, panelId);
  next.hosts[hostName].active = panelId;
  next.hosts[hostName].collapsed = false;
  return next;
}

/** Remove panelId from its host (hidden until showPanel/movePanel). */
export function withPanelHidden(layout, panelId) {
  if (!findPanelHost(layout, panelId)) return layout;
  const next = clone(layout);
  removeFromHosts(next, panelId);
  return next;
}

/**
 * Show panelId: activate it where it is, or put a hidden panel back in the
 * host the default profile gives it (left when it has none).
 */
export function withPanelShown(layout, panelId) {
  if (!isPanel(panelId)) return layout;
  const where = findPanelHost(layout, panelId);
  if (where) return withActivePanel(layout, where, panelId);
  const home = findPanelHost(createProfileLayout(DEFAULT_PROFILE), panelId) || 'left';
  return withPanelMoved(layout, panelId, home);
}

/** Set a host size (clamped) and remember it for the current profile. */
export function withHostSize(layout, hostName, size) {
  if (!isHost(hostName)) return layout;
  const next = clone(layout);
  const clamped = clampHostSize(hostName, size);
  next.hosts[hostName].size = clamped;
  next.profileSizes[next.profile] = { ...(next.profileSizes[next.profile] || {}), [hostName]: clamped };
  return next;
}

export function withHostCollapsed(layout, hostName, collapsed) {
  if (!isHost(hostName)) return layout;
  const next = clone(layout);
  next.hosts[hostName].collapsed = !!collapsed;
  return next;
}

export function withToolbarVisible(layout, toolbarId, visible) {
  if (!TOOLBAR_IDS.includes(toolbarId)) return layout;
  const next = clone(layout);
  next.toolbars[toolbarId].visible = !!visible;
  return next;
}

/** Switch to a built-in profile; remembered sizes per profile carry over. */
export function withProfile(layout, name) {
  if (!PROFILE_IDS.includes(name)) return layout;
  const next = createProfileLayout(name, layout.profileSizes);
  next.autoHidePanelAccess = !!layout.autoHidePanelAccess;
  return next;
}

/**
 * Validate a stored version-1 layout. Anything else (missing, garbage, an
 * unknown or old version) yields null so the caller can migrate or reset.
 * Unknown panels are dropped, duplicates keep their first host, sizes are
 * clamped, missing toolbars fall back to the profile default.
 */
export function normalizeLayout(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== LAYOUT_VERSION) return null;
  const base = createProfileLayout(raw.profile, sanitizeProfileSizes(raw.profileSizes));
  const defaults = clone(base.hosts);
  const seen = new Set();
  for (const h of HOSTS) {
    const src = raw.hosts?.[h];
    if (!src || typeof src !== 'object') continue;
    const tabs = (Array.isArray(src.tabs) ? src.tabs : []).filter((id) => {
      if (!isPanel(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    base.hosts[h] = {
      tabs,
      active: tabs.includes(src.active) ? src.active : tabs[0] ?? null,
      size: src.size === undefined ? base.hosts[h].size : clampHostSize(h, src.size),
      collapsed: typeof src.collapsed === 'boolean' ? src.collapsed : base.hosts[h].collapsed,
    };
  }
  const tb = raw.toolbars && typeof raw.toolbars === 'object' ? raw.toolbars : {};
  for (const id of TOOLBAR_IDS) {
    const src = tb[id];
    if (!src || typeof src !== 'object') continue;
    const dst = base.toolbars[id];
    if (typeof src.visible === 'boolean') dst.visible = src.visible;
    if ('dock' in dst && TOOLBAR_DOCKS.includes(src.dock)) dst.dock = src.dock;
    if ('order' in dst && Number.isInteger(src.order)) dst.order = src.order;
  }
  if (typeof tb.locked === 'boolean') base.toolbars.locked = tb.locked;
  // Before the workflow toolbar rendered, the 'standard' flag drew nothing;
  // such a layout takes the profile's default for it once.
  if (raw.workflowBar !== 1) base.toolbars.standard.visible = createProfileLayout(base.profile).toolbars.standard.visible;
  if (typeof raw.workflow === 'string' && raw.workflow) base.workflow = raw.workflow;
  if (raw.workflows === null) base.workflows = null;
  else if (Array.isArray(raw.workflows)) base.workflows = raw.workflows.filter((id) => typeof id === 'string' && id);
  base.autoHidePanelAccess = raw.autoHidePanelAccess === true;
  // A panel added since this layout was saved goes where the profile puts
  // it, once; a panel the user closed later stays closed. A layout from
  // before the list was kept gets the edition's panels it does not show.
  const known = Array.isArray(raw.knownPanels) ? new Set(raw.knownPanels) : null;
  for (const id of PANEL_IDS) {
    if (seen.has(id) || (known ? known.has(id) : !edition.panelIds.includes(id))) continue;
    const h = HOSTS.find((name) => defaults[name].tabs.includes(id));
    if (!h) continue;
    base.hosts[h].tabs.push(id);
    base.hosts[h].active ??= id;
    seen.add(id);
  }
  return base;
}

function sanitizeProfileSizes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const p of PROFILE_IDS) {
    const src = raw[p];
    if (!src || typeof src !== 'object') continue;
    for (const h of HOSTS) {
      if (Number.isFinite(src[h])) (out[p] ??= {})[h] = clampHostSize(h, src[h]);
    }
  }
  return out;
}

/**
 * Build a layout from the pre-contract preferences: workspaceProfile
 * (review/markup/takeoff/document) picks the profile, workspacePanelSizes
 * (panelLayout.js: { [oldProfile]: { left, properties, markups } }) gives
 * the sizes, propertiesPanelVisible=false collapses a right host that holds
 * Properties. leftPanelStore keeps no preferences, so nothing to read there.
 */
export function migrateLegacyPreferences(prefs = {}) {
  const profile = LEGACY_PROFILE_MAP[prefs.workspaceProfile] || DEFAULT_PROFILE;
  const profileSizes = {};
  const old = prefs.workspacePanelSizes;
  if (old && typeof old === 'object') {
    for (const [oldName, sizes] of Object.entries(old)) {
      const p = LEGACY_PROFILE_MAP[oldName];
      if (!p || !sizes || typeof sizes !== 'object') continue;
      const s = {};
      if (Number.isFinite(sizes.left)) s.left = clampHostSize('left', sizes.left);
      if (Number.isFinite(sizes.properties)) s.right = clampHostSize('right', sizes.properties);
      if (Number.isFinite(sizes.markups)) s.bottom = clampHostSize('bottom', sizes.markups);
      if (Object.keys(s).length) profileSizes[p] = s;
    }
  }
  const layout = createProfileLayout(profile, profileSizes);
  if (prefs.propertiesPanelVisible === false && layout.hosts.right.tabs.includes('properties')) {
    layout.hosts.right.collapsed = true;
  }
  return layout;
}

/**
 * The layout to start with: a valid stored workspaceLayout; else, when none
 * is stored yet, a migration of the old keys; else (unknown/old version or
 * garbage) the default Oculith layout.
 */
export function layoutFromPreferences(prefs = {}) {
  const stored = prefs.workspaceLayout;
  const valid = normalizeLayout(stored);
  if (valid) return valid;
  if (stored === undefined || stored === null) return migrateLegacyPreferences(prefs);
  return createProfileLayout(DEFAULT_PROFILE);
}

// --- Store ----------------------------------------------------------------

const [workspaceLayout, setLayoutSignal] = createSignal(createProfileLayout(DEFAULT_PROFILE));

/** Reactive accessor for the whole layout (treat it as read-only). */
export { workspaceLayout };

export const getHost = (hostName) => workspaceLayout().hosts[hostName] || null;
export const getActivePanel = (hostName) => getHost(hostName)?.active ?? null;
export const getPanelHost = (panelId) => findPanelHost(workspaceLayout(), panelId);
export const isToolbarVisible = (toolbarId) => !!workspaceLayout().toolbars[toolbarId]?.visible;
export const activeProfile = () => workspaceLayout().profile;

function commit(next, { persist = true } = {}) {
  const changed = next !== workspaceLayout();
  if (changed) setLayoutSignal(next);
  if (persist && changed) saveWorkspaceLayout();
  return changed;
}

/** Write the current layout to state.preferences.workspaceLayout and save. */
export function saveWorkspaceLayout() {
  if (!state.preferences) return;
  state.preferences.workspaceLayout = clone(workspaceLayout());
  savePreferences();
}

/** Load from state.preferences (call once after loadPreferences()). */
export function restoreWorkspaceLayout() {
  setLayoutSignal(layoutFromPreferences(state.preferences || {}));
  return workspaceLayout();
}

// Every setter returns true when the layout changed. Options: { persist }
// (default true; pass false while dragging a splitter, then commit once).
export const setActivePanel = (hostName, panelId, opts) => commit(withActivePanel(workspaceLayout(), hostName, panelId), opts);
export const movePanel = (panelId, hostName, opts = {}) => commit(withPanelMoved(workspaceLayout(), panelId, hostName, opts), opts);
export const showPanel = (panelId, opts) => commit(withPanelShown(workspaceLayout(), panelId), opts);
export const hidePanel = (panelId, opts) => commit(withPanelHidden(workspaceLayout(), panelId), opts);
export const setHostSize = (hostName, size, opts) => commit(withHostSize(workspaceLayout(), hostName, size), opts);
export const setHostCollapsed = (hostName, collapsed, opts) => commit(withHostCollapsed(workspaceLayout(), hostName, collapsed), opts);
export const toggleHostCollapsed = (hostName, opts) => commit(withHostCollapsed(workspaceLayout(), hostName, !getHost(hostName)?.collapsed), opts);
export const setToolbarVisible = (toolbarId, visible, opts) => commit(withToolbarVisible(workspaceLayout(), toolbarId, visible), opts);
export function setAutoHidePanelAccess(on, opts) {
  const next = clone(workspaceLayout());
  next.autoHidePanelAccess = !!on;
  return commit(next, opts);
}
export const applyProfile = (name, opts) => commit(withProfile(workspaceLayout(), name), opts);

// Workspace layout (contract for the plan-review workspace): profile
// defaults (spec §5), moving panels between hosts, size limits, the
// preferences round trip and the migration from the old workspaceProfile /
// workspacePanelSizes keys. Echte state-store; preferences.js is een stub
// die zijn aanroepen telt (zie ../../core/app-test-hooks.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { createRoot, createMemo } = await import('solid-js');
const { state } = await import('../../core/state.ts');
const wl = await import('./workspaceLayout.js');

const saves = () => globalThis.__stubCalls?.savePreferences || 0;
const allTabs = (layout) => wl.HOSTS.flatMap((h) => layout.hosts[h].tabs);

function reset(prefs = {}) {
  state.preferences = { ...prefs };
  wl.restoreWorkspaceLayout();
}

test('default layout is the Oculith profile', () => {
  const l = wl.createProfileLayout();
  assert.equal(l.version, 1);
  assert.equal(l.profile, 'oculith');
  assert.deepEqual(l.hosts.left.tabs, [
    'thumbnails', 'sheets', 'bookmarks', 'layers', 'toolChest', 'links', 'measurements',
    'properties', 'formFields', 'signatures', 'attachments', 'search', 'tags', 'spaces',
  ]);
  assert.deepEqual([l.hosts.left.active, l.hosts.left.size, l.hosts.left.collapsed], ['toolChest', 300, false]);
  assert.deepEqual(l.hosts.right, { tabs: [], active: null, size: 300, collapsed: true });
  assert.deepEqual(l.hosts.bottom, { tabs: ['markupsList', 'quantities'], active: 'markupsList', size: 230, collapsed: false });
  // The workflow toolbar ('standard') shows by default, on the Markup tab.
  assert.equal(l.toolbars.standard.visible, true);
  assert.deepEqual([l.workflow, l.workflows, l.workflowBar], ['markup', null, 1]);
  assert.deepEqual(l.toolbars.markup, { visible: true, dock: 'right', order: 0 });
  assert.deepEqual(l.toolbars.measure, { visible: true, dock: 'right', order: 1 });
  for (const id of ['properties', 'navigation', 'status', 'menu']) assert.equal(l.toolbars[id].visible, true, id);
  assert.equal(l.toolbars.locked, true);
  assert.equal(l.autoHidePanelAccess, false);
  assert.equal(wl.createProfileLayout('nope').profile, 'oculith');
});

test('every profile: panels unique and known, active inside its host, sizes in limits', () => {
  for (const p of wl.PROFILE_IDS) {
    const l = wl.createProfileLayout(p);
    const tabs = allTabs(l);
    assert.equal(new Set(tabs).size, tabs.length, p);
    assert.ok(tabs.every((id) => wl.PANEL_IDS.includes(id)), p);
    for (const h of wl.HOSTS) {
      const hs = l.hosts[h];
      assert.ok(hs.active === null || hs.tabs.includes(hs.active), `${p}.${h}`);
      assert.equal(wl.clampHostSize(h, hs.size), hs.size, `${p}.${h} size`);
    }
    assert.ok(!tabs.includes('elementVisibility') && !tabs.includes('annotationLayers'), 'hidden by default');
  }
  const adv = wl.createProfileLayout('oculithAdvanced');
  assert.deepEqual([adv.hosts.left.active, adv.hosts.left.size], ['thumbnails', 260]);
  assert.deepEqual(adv.hosts.right, { tabs: ['properties'], active: 'properties', size: 300, collapsed: false });
  assert.equal(adv.toolbars.standard.visible, true);
  const qto = wl.createProfileLayout('quantityTakeoff');
  assert.deepEqual([qto.hosts.left.active, qto.hosts.left.size], ['measurements', 300]);
  assert.deepEqual([qto.hosts.bottom.active, qto.hosts.bottom.size], ['quantities', 260]);
  assert.equal(qto.hosts.right.collapsed, true);
  assert.deepEqual([qto.toolbars.markup.visible, qto.toolbars.measure.visible, qto.toolbars.standard.visible], [false, true, true]);
  const doc = wl.createProfileLayout('document');
  assert.deepEqual([doc.hosts.left.active, doc.hosts.left.size], ['thumbnails', 260]);
  assert.equal(doc.hosts.bottom.collapsed, true);
  assert.equal(doc.hosts.right.collapsed, true);
  assert.deepEqual([doc.toolbars.markup.visible, doc.toolbars.measure.visible, doc.toolbars.standard.visible], [false, false, true]);
  assert.equal(doc.workflow, 'sheets');
  // Basic: the essential workflows only, no side toolbars.
  const basic = wl.createProfileLayout('basic');
  assert.deepEqual(basic.workflows, ['review', 'markup', 'measure', 'sheets', 'output', 'view']);
  assert.deepEqual([basic.workflow, basic.toolbars.markup.visible, basic.hosts.left.active], ['review', false, 'thumbnails']);
  // Reviewer: review workflows and the Properties panel at the right.
  const reviewer = wl.createProfileLayout('reviewer');
  assert.ok(reviewer.workflows.includes('compare') && !reviewer.workflows.includes('takeoff'));
  assert.deepEqual(reviewer.hosts.right.tabs, ['properties']);
  // The right side toolbar repeats the workflow toolbar's markup and measure
  // tools: hidden in Basic and Reviewer (an edition's Field profile keeps it).
  for (const l of [basic, reviewer]) assert.deepEqual([l.toolbars.markup.visible, l.toolbars.measure.visible], [false, false]);
});

test('workflow fields: kept when stored, and the old never-rendered standard flag is reset once', () => {
  const stored = { ...wl.createProfileLayout('oculith'), workflow: 'measure', workflows: ['review', 'measure'] };
  stored.toolbars.standard.visible = false;
  const kept = wl.normalizeLayout(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual([kept.workflow, kept.workflows, kept.toolbars.standard.visible], ['measure', ['review', 'measure'], false]);
  // Saved before the workflow toolbar rendered: its standard flag drew nothing.
  const old = JSON.parse(JSON.stringify(stored));
  delete old.workflowBar;
  delete old.workflow;
  delete old.workflows;
  const migrated = wl.normalizeLayout(old);
  assert.deepEqual([migrated.toolbars.standard.visible, migrated.workflow, migrated.workflowBar], [true, 'markup', 1]);
  assert.equal(wl.profileLabelKey('basic'), 'common:panelHost.profile.basic');
  // A tab the profile no longer offers leaves a layout saved with it.
  const basic = { ...wl.createProfileLayout('basic'), workflow: 'takeoff', workflows: ['review', 'takeoff', 'markup'] };
  const trimmed = wl.normalizeLayout(JSON.parse(JSON.stringify(basic)));
  assert.deepEqual(trimmed.workflows, ['review', 'markup']);
});

test('movePanel between hosts, show/hide, active neighbour', () => {
  reset();
  assert.equal(wl.movePanel('properties', 'right'), true);
  let l = wl.workspaceLayout();
  assert.ok(!l.hosts.left.tabs.includes('properties'));
  assert.deepEqual(l.hosts.right, { tabs: ['properties'], active: 'properties', size: 300, collapsed: false });
  assert.equal(wl.getPanelHost('properties'), 'right');
  assert.equal(wl.getActivePanel('left'), 'toolChest');

  wl.movePanel('toolChest', 'bottom', { index: 0 });
  l = wl.workspaceLayout();
  assert.deepEqual(l.hosts.bottom.tabs, ['toolChest', 'markupsList', 'quantities']);
  assert.equal(l.hosts.bottom.active, 'toolChest');
  assert.equal(l.hosts.left.active, 'links', 'left host takes the next tab');

  wl.movePanel('properties', 'left', { index: 1 });
  assert.deepEqual(wl.getHost('left').tabs.slice(0, 2), ['thumbnails', 'properties']);
  assert.deepEqual(wl.getHost('right'), { tabs: [], active: null, size: 300, collapsed: false });

  assert.equal(wl.movePanel('bogus', 'left'), false);
  assert.equal(wl.movePanel('search', 'top'), false);

  wl.hidePanel('search');
  assert.equal(wl.getPanelHost('search'), null);
  assert.equal(wl.hidePanel('search'), false);
  wl.showPanel('search');
  assert.equal(wl.getPanelHost('search'), 'left');
  assert.equal(wl.getActivePanel('left'), 'search');
  wl.showPanel('annotationLayers');
  assert.equal(wl.getPanelHost('annotationLayers'), 'left', 'no default host → left');

  wl.setHostCollapsed('left', true);
  assert.equal(wl.setActivePanel('left', 'layers'), true);
  assert.equal(wl.getHost('left').collapsed, false, 'activating expands the host');
  assert.equal(wl.setActivePanel('left', 'markupsList'), false, 'not in that host');
  assert.equal(allTabs(wl.workspaceLayout()).length, new Set(allTabs(wl.workspaceLayout())).size);
});

test('size clamping, collapse toggle, toolbars, auto-hide', () => {
  reset();
  assert.equal(wl.clampHostSize('left', 50), 200);
  assert.equal(wl.clampHostSize('right', 9999), 520);
  assert.equal(wl.clampHostSize('bottom', 100), 140);
  assert.equal(wl.clampHostSize('bottom', 600), 520);
  assert.equal(wl.clampHostSize('left', 333.6), 334);
  assert.equal(wl.clampHostSize('bottom', NaN), 140);
  wl.setHostSize('left', 10);
  wl.setHostSize('bottom', 9000);
  assert.equal(wl.getHost('left').size, 200);
  assert.equal(wl.getHost('bottom').size, 520);
  wl.toggleHostCollapsed('bottom');
  assert.equal(wl.getHost('bottom').collapsed, true);
  wl.toggleHostCollapsed('bottom');
  assert.equal(wl.getHost('bottom').collapsed, false);
  wl.setToolbarVisible('standard', true);
  assert.equal(wl.isToolbarVisible('standard'), true);
  assert.equal(wl.setToolbarVisible('ribbon', true), false);
  wl.setAutoHidePanelAccess(true);
  assert.equal(wl.workspaceLayout().autoHidePanelAccess, true);
});

test('applyProfile resets the layout, keeps sizes per profile and auto-hide', () => {
  reset();
  wl.setHostSize('left', 410);
  wl.setAutoHidePanelAccess(true);
  wl.applyProfile('oculithAdvanced');
  let l = wl.workspaceLayout();
  assert.equal(l.profile, 'oculithAdvanced');
  assert.equal(wl.activeProfile(), 'oculithAdvanced');
  assert.equal(l.hosts.left.size, 260);
  assert.equal(l.autoHidePanelAccess, true);
  wl.setHostSize('right', 350);
  wl.applyProfile('oculith');
  l = wl.workspaceLayout();
  assert.equal(l.hosts.left.size, 410, 'oculith left width remembered');
  assert.equal(l.hosts.left.active, 'toolChest');
  wl.applyProfile('oculithAdvanced');
  assert.equal(wl.getHost('right').size, 350);
  assert.equal(wl.applyProfile('field'), false);
});

test('setters persist to state.preferences.workspaceLayout; persist:false does not', () => {
  reset();
  const before = saves();
  wl.setHostSize('left', 333, { persist: false });
  assert.equal(saves(), before);
  assert.equal(state.preferences.workspaceLayout, undefined);
  wl.setHostSize('left', 340);
  assert.equal(saves(), before + 1);
  assert.equal(state.preferences.workspaceLayout.hosts.left.size, 340);
  assert.notEqual(state.preferences.workspaceLayout, wl.workspaceLayout(), 'stored as a copy');
  assert.equal(wl.movePanel('nope', 'left'), false);
  assert.equal(saves(), before + 1, 'no save when nothing changed');
});

test('persistence round trip through preferences JSON', () => {
  reset();
  wl.applyProfile('quantityTakeoff');
  wl.movePanel('properties', 'right');
  wl.hidePanel('tags');
  wl.setHostSize('bottom', 300);
  wl.setToolbarVisible('navigation', false);
  const saved = wl.workspaceLayout();
  const prefs = JSON.parse(JSON.stringify(state.preferences));
  reset({ theme: 'default' });
  assert.equal(wl.workspaceLayout().profile, 'oculith');
  reset(prefs);
  assert.deepEqual(wl.workspaceLayout(), saved);
  assert.equal(wl.getPanelHost('tags'), null, 'hidden stays hidden');
});

test('stored layout is sanitised: unknown panels, duplicates, bad sizes, bad active', () => {
  const raw = {
    version: 1, profile: 'oculith',
    hosts: {
      left: { tabs: ['thumbnails', 'ghost', 'layers', 'thumbnails'], active: 'ghost', size: 9999, collapsed: 'yes' },
      right: { tabs: ['layers', 'properties'], active: 'properties', size: 10, collapsed: false },
    },
    toolbars: { markup: { visible: false, dock: 'sideways', order: 2.5 }, measure: { dock: 'left', order: 3 }, locked: false, nope: {} },
    autoHidePanelAccess: 'true',
    profileSizes: { oculith: { left: 1 }, other: { left: 300 } },
  };
  const l = wl.normalizeLayout(raw);
  assert.deepEqual(l.hosts.left, { tabs: ['thumbnails', 'layers'], active: 'thumbnails', size: 520, collapsed: false });
  assert.deepEqual(l.hosts.right, { tabs: ['properties'], active: 'properties', size: 200, collapsed: false });
  assert.deepEqual(l.hosts.bottom, wl.createProfileLayout().hosts.bottom, 'missing host → profile default');
  assert.deepEqual(l.toolbars.markup, { visible: false, dock: 'right', order: 0 });
  assert.deepEqual(l.toolbars.measure, { visible: true, dock: 'left', order: 3 });
  assert.equal(l.toolbars.locked, false);
  assert.ok(!('nope' in l.toolbars));
  assert.equal(l.autoHidePanelAccess, false);
  assert.deepEqual(l.profileSizes, { oculith: { left: 200 } });
  assert.equal(wl.normalizeLayout({ ...raw, profile: 'field' }).profile, 'oculith');
});

test('unknown or old version and garbage reset to the default; missing migrates', () => {
  const legacy = { workspaceProfile: 'takeoff' };
  for (const bad of [{ version: 0, profile: 'document' }, { version: 2, profile: 'document' }, 'x', 42, []]) {
    const l = wl.layoutFromPreferences({ ...legacy, workspaceLayout: bad });
    assert.deepEqual(l, wl.createProfileLayout('oculith'), JSON.stringify(bad));
  }
  assert.equal(wl.layoutFromPreferences({ ...legacy, workspaceLayout: null }).profile, 'quantityTakeoff');
  assert.equal(wl.layoutFromPreferences(legacy).profile, 'quantityTakeoff');
  assert.equal(wl.layoutFromPreferences({}).profile, 'oculith');
});

test('migration from workspaceProfile / workspacePanelSizes / propertiesPanelVisible', () => {
  const map = { review: 'oculithAdvanced', markup: 'oculith', takeoff: 'quantityTakeoff', document: 'document', weird: 'oculith' };
  for (const [old, neu] of Object.entries(map)) {
    assert.equal(wl.migrateLegacyPreferences({ workspaceProfile: old }).profile, neu, old);
  }
  const prefs = {
    workspaceProfile: 'review',
    workspacePanelSizes: {
      review: { left: 250, properties: 380, markups: 100 },
      markup: { left: 999 },
      takeoff: { markups: 'x' },
      unknown: { left: 300 },
    },
    propertiesPanelVisible: false,
  };
  const l = wl.migrateLegacyPreferences(prefs);
  assert.equal(l.profile, 'oculithAdvanced');
  assert.deepEqual([l.hosts.left.size, l.hosts.right.size, l.hosts.bottom.size], [250, 380, 140]);
  assert.equal(l.hosts.right.collapsed, true, 'hidden properties panel stays hidden');
  assert.deepEqual(l.profileSizes, { oculithAdvanced: { left: 250, right: 380, bottom: 140 }, oculith: { left: 520 } });
  assert.equal(wl.withProfile(l, 'oculith').hosts.left.size, 520);
  // Old keys are read, not removed.
  reset(prefs);
  wl.setHostSize('left', 260);
  assert.equal(state.preferences.workspaceProfile, 'review');
  assert.ok(state.preferences.workspacePanelSizes.review);
  assert.equal(state.preferences.workspaceLayout.profile, 'oculithAdvanced');
});

test('pure helpers do not mutate their input; the signal drives memos', () => {
  const l = wl.createProfileLayout();
  const copy = JSON.parse(JSON.stringify(l));
  wl.withPanelMoved(l, 'properties', 'right');
  wl.withHostSize(l, 'left', 400);
  wl.withToolbarVisible(l, 'status', false);
  wl.withPanelHidden(l, 'tags');
  wl.withProfile(l, 'document');
  assert.deepEqual(l, copy);
  reset();
  createRoot((dispose) => {
    const active = createMemo(() => wl.getActivePanel('left'));
    const std = createMemo(() => wl.isToolbarVisible('standard'));
    assert.equal(active(), 'toolChest');
    wl.setActivePanel('left', 'bookmarks', { persist: false });
    assert.equal(active(), 'bookmarks');
    wl.applyProfile('oculithAdvanced', { persist: false });
    assert.equal(std(), true);
    dispose();
  });
});

test('a panel added after a layout was saved is placed once; a closed one stays closed', () => {
  const saved = wl.createProfileLayout();
  // Saved before "spaces" existed: it is placed where the profile puts it.
  const before = { ...saved, knownPanels: saved.knownPanels.filter((id) => id !== 'spaces'),
    hosts: { ...saved.hosts, left: { ...saved.hosts.left, tabs: saved.hosts.left.tabs.filter((id) => id !== 'spaces') } } };
  const placed = wl.normalizeLayout(JSON.parse(JSON.stringify(before)));
  assert.ok(placed.hosts.left.tabs.includes('spaces'));
  assert.ok(placed.knownPanels.includes('spaces'));
  // Known and closed: it stays closed.
  const closed = { ...saved, hosts: { ...saved.hosts, left: { ...saved.hosts.left, tabs: saved.hosts.left.tabs.filter((id) => id !== 'spaces') } } };
  assert.ok(!wl.normalizeLayout(JSON.parse(JSON.stringify(closed))).hosts.left.tabs.includes('spaces'));
});

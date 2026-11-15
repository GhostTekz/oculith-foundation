// An edition panel with `host: 'right'` (a chat beside the drawing) is a tab
// of the right host in every profile, keeps the host's collapsed state, and
// comes back there when shown again. Other edition panels stay at the left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { edition: foundation } = await import('../../editions/community.js');
globalThis.__ocudrawEdition = {
  ...foundation,
  panels: [{ id: 'side', title: 'Side' }, { id: 'chatPane', title: 'Chat', host: 'right' }],
  panelIds: ['side', 'chatPane'],
  profiles: [{ id: 'tidy', label: 'Tidy', base: 'reviewer', hosts: { left: { active: 'side' } } }],
};
const wl = await import('./workspaceLayout.js');

test('a right-host edition panel is a right tab in every profile and the host keeps its state', () => {
  for (const id of wl.PROFILE_IDS) {
    const l = wl.createProfileLayout(id);
    assert.equal(wl.findPanelHost(l, 'chatPane'), 'right', id);
    assert.equal(wl.findPanelHost(l, 'side'), 'left', id);
  }
  const folded = wl.createProfileLayout('oculith').hosts.right;
  assert.deepEqual([folded.collapsed, folded.active], [true, null], 'still folded, and not active there: it loads when opened');
  const reviewer = wl.createProfileLayout('reviewer').hosts.right;
  assert.deepEqual([reviewer.tabs, reviewer.active], [['properties', 'chatPane'], 'properties']);
});

test('a hidden right-host panel comes back at the right; a stored layout from before gets it there once', () => {
  const hidden = wl.withPanelHidden(wl.createProfileLayout('oculith'), 'chatPane');
  assert.equal(wl.findPanelHost(hidden, 'chatPane'), null);
  const shown = wl.withPanelShown(hidden, 'chatPane');
  assert.equal(wl.findPanelHost(shown, 'chatPane'), 'right');
  assert.equal(shown.hosts.right.collapsed, false);

  const old = JSON.parse(JSON.stringify(wl.createProfileLayout('oculith')));
  old.hosts.right.tabs = [];
  old.hosts.right.active = null;
  old.knownPanels = old.knownPanels.filter((id) => id !== 'chatPane');
  assert.equal(wl.findPanelHost(wl.normalizeLayout(old), 'chatPane'), 'right');
  // Closed by the user since: it stays closed.
  old.knownPanels.push('chatPane');
  assert.equal(wl.findPanelHost(wl.normalizeLayout(old), 'chatPane'), null);
});

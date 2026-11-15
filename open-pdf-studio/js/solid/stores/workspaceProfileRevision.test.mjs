// An edition profile's revision: a layout stored under an older revision of
// the profile opens on the profile's current layout once (sizes kept); one
// stored under the current revision keeps the user's arrangement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const { edition: foundation } = await import('../../editions/community.js');
globalThis.__ocudrawEdition = {
  ...foundation,
  profiles: [
    { id: 'tidy', label: 'Tidy', base: 'quantityTakeoff', revision: 2,
      hosts: { bottom: { tabs: ['markupsList'], active: 'markupsList', collapsed: true } } },
    { id: 'plain', label: 'Plain', base: 'basic' },
  ],
};
const wl = await import('./workspaceLayout.js');
const stored = (layout) => JSON.parse(JSON.stringify(layout));

test('a layout saved under an older revision of the profile takes its layout once, with the sizes kept', () => {
  const now = wl.createProfileLayout('tidy');
  assert.equal(now.profileRevision, 2);
  assert.deepEqual(now.hosts.bottom.tabs, ['markupsList']);

  // Saved before the revision: the old bottom tabs, open, a custom size.
  const old = stored(now);
  delete old.profileRevision;
  old.hosts.bottom = { tabs: ['markupsList', 'quantities'], active: 'quantities', size: 300, collapsed: false };
  old.profileSizes = { tidy: { bottom: 300 } };
  old.autoHidePanelAccess = true;
  const reset = wl.normalizeLayout(old);
  assert.deepEqual([reset.hosts.bottom.tabs, reset.hosts.bottom.collapsed, reset.hosts.bottom.size], [['markupsList'], true, 300]);
  assert.equal(reset.profileRevision, 2);
  assert.equal(reset.autoHidePanelAccess, true);

  // Saved again (current revision): the user's own arrangement stays.
  const mine = stored(reset);
  mine.hosts.bottom = { ...mine.hosts.bottom, tabs: ['markupsList', 'quantities'], active: 'quantities', collapsed: false };
  assert.deepEqual(wl.normalizeLayout(mine).hosts.bottom.tabs, ['markupsList', 'quantities']);
});

test('profiles without a revision keep a stored layout as before', () => {
  for (const id of ['plain', 'quantityTakeoff']) {
    const l = wl.createProfileLayout(id);
    assert.equal('profileRevision' in l, false, id);
    const s = stored(l);
    s.hosts.bottom = { ...s.hosts.bottom, tabs: ['quantities'], active: 'quantities' };
    assert.deepEqual(wl.normalizeLayout(s).hosts.bottom.tabs, ['quantities'], id);
  }
});

// Shared tool sets (docs/reference/editor/tool-chest.md): two simulated users, each
// with their own Tool Chest and link storage, against one temporary
// "network" folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, rename, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolSetShareManager, nodeToolSetFs, lockPathFor, parseLock, buildLock, storedLinkPath, resolveLinkPath,
} from './tool-set-share.js';
import { buildToolSetFile, parseToolSetFile, TOOL_SET_FILE_FORMAT } from './tool-set-file.js';

const line = (id, color) => ({ id, name: `Line ${id}`, tool: 'line', style: { strokeColor: color, lineWidth: 2 }, mode: 'properties' });

/** One app instance: its own Tool Chest copy (the offline cache) and link storage. */
function profile(user, folderFs, clock) {
  const chest = new Map();
  let links = [];
  const manager = new ToolSetShareManager({
    fs: folderFs,
    identity: { user, instance: `${user}-pc` },
    now: () => clock.now,
    store: { load: () => links, save: (next) => { links = JSON.parse(JSON.stringify(next)); } },
    tools: {
      read: (setId) => JSON.parse(JSON.stringify(chest.get(setId))),
      write: (setId, content) => {
        chest.set(setId, { name: content.name, tools: JSON.parse(JSON.stringify(content.tools)) });
        return { accepted: content.tools.length, rejected: 0 };
      },
    },
  });
  return { user, chest, manager, links: () => links };
}

async function withFolder(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ocudraw-share-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a shared set: lock prevents concurrent edits, edits reach the other user, offline is read-only', () => withFolder(async (dir) => {
  const shared = join(dir, 'share');
  await fsp.mkdir(shared);
  const path = join(shared, 'site.ocudraw-toolset');
  await writeFile(path, buildToolSetFile({ name: 'Site', tools: [line('t1', '#ff0000')] }));
  const clock = { now: Date.parse('2026-10-15T08:00:00Z') };
  const folderFs = nodeToolSetFs(fsp);
  const anna = profile('anna', folderFs, clock);
  const bram = profile('bram', folderFs, clock);

  // Add Existing on both machines: same file, read-only until checked out.
  assert.equal((await anna.manager.addExisting('set_a', path)).accepted, 1);
  await bram.manager.addExisting('set_b', path);
  assert.equal(anna.manager.canEdit('set_a'), false);
  assert.equal(bram.manager.canEdit('set_b'), false);
  assert.equal(anna.manager.canEdit('set_local'), true, 'unshared sets are always editable');

  // Anna checks out: a lock file with her name and time appears.
  assert.deepEqual(await anna.manager.checkOut('set_a'), { ok: true });
  const lock = parseLock(new Uint8Array(await readFile(lockPathFor(path))));
  assert.equal(lock.user, 'anna');
  assert.equal(lock.time, clock.now);
  assert.equal(anna.manager.canEdit('set_a'), true);

  // Bram cannot check out at the same time; the panel can say who has it.
  const refused = await bram.manager.checkOut('set_b');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'locked');
  assert.equal(refused.lockedBy, 'anna');
  assert.equal(bram.manager.canEdit('set_b'), false);
  await bram.manager.refresh('set_b');
  assert.equal(bram.manager.status('set_b').lockedBy, 'anna');

  // Anna edits locally and checks in (atomic write, lock removed).
  anna.chest.get('set_a').tools.push(line('t2', '#00ff00'));
  anna.chest.get('set_a').tools[0].style.strokeColor = '#0000ff';
  clock.now += 60000;
  assert.deepEqual(await anna.manager.checkIn('set_a'), { ok: true });
  await assert.rejects(stat(lockPathFor(path)), /ENOENT/u);
  assert.equal(anna.manager.canEdit('set_a'), false, 'checked in: read-only again');

  // Bram's next refresh (focus / periodic mtime check) picks the edit up.
  assert.equal((await bram.manager.refresh('set_b')).status, 'updated');
  assert.deepEqual(bram.chest.get('set_b').tools.map(tool => [tool.id, tool.style.strokeColor]),
    [['t1', '#0000ff'], ['t2', '#00ff00']]);
  assert.equal((await bram.manager.refresh('set_b')).status, 'unchanged');
  assert.equal(bram.manager.status('set_b').lockedBy, null);

  // Now Bram can check it out.
  assert.equal((await bram.manager.checkOut('set_b')).ok, true);
  await bram.manager.cancelCheckOut('set_b');

  // The share goes offline: Bram keeps the cached copy, read-only.
  await rename(shared, `${shared}-away`);
  assert.equal((await bram.manager.refresh('set_b')).status, 'offline');
  assert.equal(bram.manager.status('set_b').offline, true);
  assert.equal(bram.manager.canEdit('set_b'), false);
  assert.equal(bram.chest.get('set_b').tools.length, 2, 'the offline cache still serves the tools');
  assert.deepEqual(await bram.manager.checkOut('set_b'), { ok: false, reason: 'offline' });
  // The link (with its offline state) survives a restart of the profile.
  assert.equal(bram.links()[0].offline, true);
  await rename(`${shared}-away`, shared);
  assert.equal((await bram.manager.refresh('set_b')).status, 'unchanged');
  assert.equal(bram.manager.status('set_b').offline, false);
}));

test('stale locks can be broken; the former owner then cannot check in', () => withFolder(async (dir) => {
  const path = join(dir, 'doors.ocudraw-toolset');
  await writeFile(path, buildToolSetFile({ name: 'Doors', tools: [line('d1', '#111111')] }));
  const clock = { now: Date.parse('2026-10-15T08:00:00Z') };
  const folderFs = nodeToolSetFs(fsp);
  const anna = profile('anna', folderFs, clock);
  const bram = profile('bram', folderFs, clock);
  await anna.manager.addExisting('a', path);
  await bram.manager.addExisting('b', path);
  assert.equal((await anna.manager.checkOut('a')).ok, true);

  clock.now += 9 * 60 * 60 * 1000;
  const stale = await bram.manager.checkOut('b');
  assert.equal(stale.reason, 'stale', 'an old lock is reported as stale, not broken silently');
  assert.equal((await bram.manager.checkOut('b', { breakStale: true })).ok, true);
  assert.equal(parseLock(new Uint8Array(await readFile(lockPathFor(path)))).user, 'bram');

  anna.chest.get('a').tools[0].name = 'Anna late edit';
  const lost = await anna.manager.checkIn('a');
  assert.equal(lost.reason, 'lockLost');
  assert.equal(anna.manager.canEdit('a'), false);
  assert.equal(parseToolSetFile(new Uint8Array(await readFile(path))).tools[0].name, 'Line d1', 'the file is untouched');
  assert.equal((await bram.manager.checkIn('b')).ok, true);
}));

test('check-in refuses when the file changed behind the lock; unknown tool fields survive a rewrite', () => withFolder(async (dir) => {
  const path = join(dir, 'mixed.ocudraw-toolset');
  const future = { ...line('x1', '#222222'), futureTag: 'E-POWER', futureField: { keep: true } };
  await writeFile(path, buildToolSetFile({ name: 'Mixed', tools: [future] }));
  const clock = { now: Date.parse('2026-10-15T08:00:00Z') };
  const anna = profile('anna', nodeToolSetFs(fsp), clock);
  await anna.manager.addExisting('a', path);
  // This app's Tool Chest does not know the extra fields: it drops them locally.
  const local = anna.chest.get('a');
  local.tools = local.tools.map(({ futureTag: _l, futureField: _f, ...tool }) => tool);
  assert.equal((await anna.manager.checkOut('a')).ok, true);
  anna.chest.get('a').tools = anna.chest.get('a').tools.map(({ futureTag: _l, futureField: _f, ...tool }) => ({ ...tool, name: 'Renamed' }));

  // Someone writes the file without the lock: check-in must not overwrite it.
  const original = await readFile(path);
  await writeFile(path, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from(' \n')]));
  await utimes(path, new Date(clock.now / 1000 + 5), new Date(clock.now / 1000 + 5));
  assert.equal((await anna.manager.checkIn('a')).reason, 'conflict');
  assert.equal((await anna.manager.checkIn('a', { force: true })).ok, true);

  const written = parseToolSetFile(new Uint8Array(await readFile(path)));
  assert.equal(written.tools[0].name, 'Renamed');
  assert.equal(written.tools[0].futureTag, 'E-POWER', 'a field this app does not know is carried through');
  assert.deepEqual(written.tools[0].futureField, { keep: true });
}));

test('Add New with a save location creates the file exclusively; relative paths resolve against the base', () => withFolder(async (dir) => {
  const clock = { now: 1 };
  const anna = profile('anna', nodeToolSetFs(fsp), clock);
  anna.chest.set('n', { name: 'New set', tools: [line('n1', '#333333')] });
  const path = join(dir, 'new.ocudraw-toolset');
  await anna.manager.createShared('n', path);
  const parsed = parseToolSetFile(new Uint8Array(await readFile(path)));
  assert.equal(parsed.name, 'New set');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).format, TOOL_SET_FILE_FORMAT);
  anna.chest.set('m', { name: 'Other', tools: [] });
  await assert.rejects(anna.manager.createShared('m', path), /already exists/u, 'never overwrites an existing file');

  assert.deepEqual(storedLinkPath('/data/app/sets/a.ocudraw-toolset', '/data/app', true),
    { path: 'sets/a.ocudraw-toolset', relativePath: true });
  assert.deepEqual(storedLinkPath('/elsewhere/a.ocudraw-toolset', '/data/app', true),
    { path: '/elsewhere/a.ocudraw-toolset', relativePath: false });
  assert.equal(resolveLinkPath({ path: 'sets/a.ocudraw-toolset', relativePath: true }, '/other/base'),
    '/other/base/sets/a.ocudraw-toolset');
  assert.equal(parseLock(buildLock({ user: 'x', instance: 'y' }, 0)).user, 'x');
  assert.equal(parseLock(new TextEncoder().encode('{"format":"other"}')), null);
}));

test('the Tool Chest enforces read-only shared sets through the edit guard', async () => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    await withFolder(async (dir) => {
      const chest = await import(`./tool-chest-presets.js?shareGuard=${Date.now()}`);
      const path = join(dir, 'guarded.ocudraw-toolset');
      await writeFile(path, buildToolSetFile({ name: 'Guarded', tools: [line('g1', '#444444')] }));
      const set = chest.createToolSet('Guarded');
      const manager = new ToolSetShareManager({ fs: nodeToolSetFs(fsp), identity: { user: 'anna', instance: 'pc' },
        store: { load: () => [], save: () => {} },
        tools: { read: chest.readToolSetContent, write: chest.replaceToolSetTools } });
      chest.setToolSetEditGuard((setId) => manager.canEdit(setId));
      await manager.addExisting(set.id, path);
      const [tool] = chest.getToolChestPresets().filter(item => item.setId === set.id);
      assert.equal(tool.id, 'g1');
      const markup = { type: 'line', strokeColor: '#abcdef', lineWidth: 1 };
      assert.equal(chest.saveToolPreset(markup, 'New', set.id), null, 'read-only: no new tools');
      assert.equal(chest.renameToolPreset('g1', 'Changed'), null);
      assert.equal(chest.deleteToolPreset('g1'), false);
      assert.equal(chest.toggleToolPresetMode('g1'), null);
      assert.ok(chest.saveToolPreset(markup, 'Mine'), 'My Tools stays editable');

      assert.equal((await manager.checkOut(set.id)).ok, true);
      assert.ok(chest.saveToolPreset(markup, 'Added', set.id));
      assert.ok(chest.renameToolPreset('g1', 'Changed'));
      assert.equal((await manager.checkIn(set.id)).ok, true);
      const file = parseToolSetFile(new Uint8Array(await readFile(path)));
      assert.deepEqual(file.tools.map(item => item.name), ['Changed', 'Added']);
      assert.equal(chest.saveToolPreset(markup, 'Again', set.id), null, 'checked in: read-only again');
      chest.setToolSetEditGuard(null);
    });
  } finally {
    globalThis.localStorage = previous;
  }
});

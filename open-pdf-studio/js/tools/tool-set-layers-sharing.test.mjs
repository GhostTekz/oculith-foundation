// Tool layers on shared tool sets (docs/reference/editor/layers.md,
// docs/reference/editor/tool-chest.md): two simulated users, each with their own Tool
// Chest (tool-chest-presets.js with its own storage) wired to the share
// manager like toolSetLibrary.js does, against one temporary folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ToolSetShareManager, nodeToolSetFs } from './tool-set-share.js';
import { buildToolSetFile, parseToolSetFile } from './tool-set-file.js';
import { parseBtx } from './btx-import.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

/** One app instance: its own Tool Chest module, storage and share manager. */
async function user(name, folderFs) {
  const local = storage();
  const previous = globalThis.localStorage;
  globalThis.localStorage = local;
  const chest = await import(`./tool-chest-presets.js?layersShare${name}=${Date.now()}${Math.random()}`);
  chest.getToolChestPresets();
  globalThis.localStorage = previous;
  let links = [];
  const manager = new ToolSetShareManager({
    fs: folderFs,
    identity: { user: name, instance: `${name}-pc` },
    store: { load: () => links, save: (next) => { links = JSON.parse(JSON.stringify(next)); } },
    tools: { read: (setId) => chest.readToolSetContent(setId), write: (setId, content) => chest.replaceToolSetTools(setId, content) },
  });
  chest.setToolSetEditGuard((setId) => manager.canEdit(setId));
  // Every call runs against this user's storage.
  const as = async (run) => {
    const before = globalThis.localStorage;
    globalThis.localStorage = local;
    try { return await run(chest, manager); } finally { globalThis.localStorage = before; }
  };
  return { as };
}

const tool = (id, layer) => ({ id, name: `Tool ${id}`, tool: 'box', style: { strokeColor: '#ff0000', lineWidth: 2 },
  mode: 'properties', ...(layer ? { layer } : {}) });

test('a shared set with layered tools survives check-out, a layer edit, check-in and a second user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocudraw-layers-share-'));
  try {
    const path = join(dir, 'site.ocudraw-toolset');
    await writeFile(path, buildToolSetFile({ name: 'Site', tools: [tool('t1', 'Electrical'), tool('t2')] }));
    const folderFs = nodeToolSetFs(fsp);
    const anna = await user('anna', folderFs);
    const bram = await user('bram', folderFs);

    const annaSet = await anna.as(async (chest, manager) => {
      const set = chest.createToolSet('Site');
      assert.equal((await manager.addExisting(set.id, path)).accepted, 2);
      const tools = chest.getToolChestPresets().filter(item => item.setId === set.id);
      assert.deepEqual(tools.map(item => item.layer || null), ['Electrical', null], 'the file layer is read');
      // Read-only until checked out: the layer edits go through the edit guard.
      assert.equal(chest.setToolPresetLayer(tools[1].id, 'Fire'), null);
      assert.equal(chest.setToolSetLayer(set.id, 'Site'), 0);
      assert.deepEqual((await manager.checkOut(set.id)), { ok: true });
      assert.equal(chest.setToolPresetLayer(tools[1].id, 'Fire')?.layer, 'Fire');
      assert.equal(chest.setToolPresetLayer(tools[0].id, null)?.layer, undefined, 'a layer can be removed');
      assert.deepEqual(await manager.checkIn(set.id), { ok: true });
      assert.equal(chest.setToolPresetLayer(tools[1].id, 'Other'), null, 'checked in: read-only again');
      return set;
    });

    const onDisk = parseToolSetFile(new Uint8Array(await readFile(path)));
    assert.deepEqual(onDisk.tools.map(item => [item.id, item.layer ?? null]), [['t1', null], ['t2', 'Fire']],
      'the removed layer is not brought back from the old file');

    await bram.as(async (chest, manager) => {
      const set = chest.createToolSet('Site');
      await manager.addExisting(set.id, path);
      const tools = chest.getToolChestPresets().filter(item => item.setId === set.id);
      assert.deepEqual(tools.map(item => [item.id, item.layer ?? null]), [['t1', null], ['t2', 'Fire']]);
      assert.equal(chest.setToolSetLayer(set.id, 'Site'), 0, 'read-only for the second user too');
      assert.deepEqual(await manager.checkOut(set.id), { ok: true });
      assert.equal(chest.setToolSetLayer(set.id, 'Site'), 2, 'Assign all tools to layer <set>');
      assert.deepEqual(await manager.checkIn(set.id), { ok: true });
    });

    await anna.as(async (chest, manager) => {
      assert.equal((await manager.refresh(annaSet.id, { force: true })).status, 'updated');
      assert.deepEqual(chest.getToolChestPresets().filter(item => item.setId === annaSet.id).map(item => item.layer),
        ['Site', 'Site'], 'the first user reads the second user\'s layers');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export and import keep each tool\'s layer (set file, portable JSON and the external editor .btx /OC)', async () => {
  const user1 = await user('carla', nodeToolSetFs(fsp));
  await user1.as(async (chest) => {
    const set = chest.createToolSet('Electrical');
    chest.saveToolPreset({ type: 'box', strokeColor: '#00aa00', lineWidth: 2, x: 0, y: 0, width: 20, height: 10 }, 'Panel', set.id);
    chest.saveToolPreset({ type: 'circle', strokeColor: '#0000ff', lineWidth: 1, x: 0, y: 0, width: 8, height: 8 }, 'Outlet', set.id);
    assert.equal(chest.setToolSetLayer(set.id, 'Electrical'), 2);

    // Tool set file (Manage Tool Sets ▸ Export / Import).
    const bytes = buildToolSetFile(chest.readToolSetContent(set.id));
    const imported = chest.importToolSetContent(parseToolSetFile(bytes));
    assert.equal(imported.accepted, 2);
    assert.notEqual(imported.set.id, set.id);
    assert.deepEqual(chest.getToolChestPresets().filter(item => item.setId === imported.set.id).map(item => item.layer),
      ['Electrical', 'Electrical']);

    // Portable JSON (Tool Chest ▸ Export / Import).
    const again = chest.importToolSet(chest.exportToolSet(set.id));
    assert.deepEqual(chest.getToolChestPresets().filter(item => item.setId === again.set.id).map(item => item.layer),
      ['Electrical', 'Electrical']);
  });

  // the external editor .btx: an inline /OC optional content group's /Name becomes the layer.
  const raw = (oc) => deflateSync(Buffer.from(`<< /Subtype /Square /Rect [0 0 60 30] /C [1 0 0] ${oc} >>`, 'latin1')).toString('hex');
  const item = (oc) => `<ToolChestItem Version="1"><Name>X</Name><Type>Bluebeam.PDF.Annotations.AnnotationSquare</Type><Raw>${raw(oc)}</Raw><Mode>properties</Mode></ToolChestItem>`;
  const btx = new TextEncoder().encode(`<?xml version="1.0"?><BluebeamRevuToolSet Version="1"><Title>T</Title>${
    item('/OC << /Type /OCG /Name (Electrical) >>')}${item('/OC 12 0 R')}${item('')}</BluebeamRevuToolSet>`);
  const parsed = await parseBtx(btx);
  assert.deepEqual(parsed.tools.map(entry => entry.layer ?? null), ['Electrical', null, null],
    'an indirect /OC reference cannot be resolved from the tool alone');
});

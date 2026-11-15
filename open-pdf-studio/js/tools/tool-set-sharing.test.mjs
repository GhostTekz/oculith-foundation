// Manage Tool Sets, Add to Tool Chest rules, groups, modes and views
// (docs/reference/editor/tool-chest.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addToToolChestBlockReason, captureGroupTool, placeGroupTool, groupMembersOf, selectionIsOneGroup, cleanGroupMembers,
} from './tool-chest-groups.js';
import {
  buildToolSetFile, parseToolSetFile, mergeUnknownToolFields, suggestedToolSetFileName, looksLikeToolSetFile,
  MAX_TOOL_SET_FILE_BYTES,
} from './tool-set-file.js';
import { sectionView, withSectionView, emptySectionState } from '../solid/components/tool-chest/tool-chest-view.js';

function withStorage(run) {
  return async () => {
    const values = new Map();
    const previous = globalThis.localStorage;
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    try { await run(values); } finally { globalThis.localStorage = previous; }
  };
}
const load = (tag) => import(`./tool-chest-presets.js?sharing${tag}=${Date.now()}${Math.random()}`);

// Simple bounds/move for the plain shapes used here (the app passes
// getAnnotationBounds and applyMoveGeneric).
const bounds = (a) => (a.type === 'line'
  ? { x: Math.min(a.startX, a.endX), y: Math.min(a.startY, a.endY), width: Math.abs(a.endX - a.startX), height: Math.abs(a.endY - a.startY) }
  : { x: a.x, y: a.y, width: a.width, height: a.height });
const move = (a, dx, dy) => {
  for (const [kx, ky] of [['x', 'y'], ['startX', 'startY'], ['endX', 'endY']]) {
    if (typeof a[kx] === 'number') { a[kx] += dx; a[ky] += dy; }
  }
};

test('Add to Tool Chest follows the external editor restrictions', () => {
  assert.equal(addToToolChestBlockReason({ type: 'comment', icon: 'note' }), 'note');
  assert.equal(addToToolChestBlockReason({ type: 'comment', icon: 'flag' }), null, 'a flag is a tool');
  assert.equal(addToToolChestBlockReason({ type: 'comment', icon: 'pushpin', attachedFile: {} }), 'attachment');
  assert.equal(addToToolChestBlockReason({ type: 'fileAttachment' }), 'attachment');
  assert.equal(addToToolChestBlockReason({ type: 'hyperlink' }), 'hyperlink');
  for (const type of ['textHighlight', 'textUnderline', 'textSquiggly', 'textStrikeout', 'caret']) {
    assert.equal(addToToolChestBlockReason({ type }), 'textMarkup', type);
  }
  assert.equal(addToToolChestBlockReason({ type: 'highlight', rects: [{ x: 0 }] }), 'textMarkup', 'a text highlight');
  assert.equal(addToToolChestBlockReason({ type: 'highlight', x: 0, y: 0, width: 5, height: 5 }), null, 'an area highlight');
  assert.equal(addToToolChestBlockReason({ type: 'stamp', symbolId: 's', sequence: { prefix: 'A' } }), 'sequenceSymbol');
  assert.equal(addToToolChestBlockReason({ type: 'stamp', stampName: 'Approved', action: { uri: 'x' } }), 'sequenceSymbol');
  assert.equal(addToToolChestBlockReason({ type: 'box' }), null);
});

test('Add to Tool Chest saves into several sets at once and skips read-only ones', withStorage(async () => {
  const chest = await load('Multi');
  const a = chest.createToolSet('Electrical');
  const b = chest.createToolSet('Fire');
  const c = chest.createToolSet('Shared');
  chest.setToolSetEditGuard((setId) => setId !== c.id);
  const markup = { type: 'box', strokeColor: '#ff0000', lineWidth: 2, x: 0, y: 0, width: 50, height: 20, subject: 'Mine' };
  const result = chest.saveToolPresetToSets(markup, 'Red box', [chest.DEFAULT_TOOL_SET_ID, a.id, b.id, c.id, a.id],
    { subject: 'Equipment', comment: 'Check clearance' });
  assert.deepEqual(result.saved.map(tool => tool.setId), [chest.DEFAULT_TOOL_SET_ID, a.id, b.id]);
  assert.deepEqual(result.skipped, [c.id]);
  assert.ok(result.saved.every(tool => tool.subject === 'Equipment' && tool.comment === 'Check clearance'));
  assert.equal(chest.canSaveToolPreset({ type: 'comment', icon: 'note', color: '#ffff00' }), false);
  assert.equal(chest.canSaveToolPreset({ type: 'textHighlight', color: '#ffff00' }), false);
  chest.setToolSetEditGuard(null);
}));

test('a group becomes one Drawing Mode tool and places a fresh copy as one new group', withStorage(async () => {
  const chest = await load('Group');
  const doc = [
    { id: 'a1', type: 'box', page: 3, groupId: 'grp_1', x: 100, y: 200, width: 40, height: 20, strokeColor: '#ff0000',
      author: 'Someone', createdAt: '2020', subject: 'Door leaf' },
    { id: 'a2', type: 'line', page: 3, groupId: 'grp_1', startX: 100, startY: 220, endX: 160, endY: 260, strokeColor: '#0000ff' },
    { id: 'a3', type: 'box', page: 3, x: 0, y: 0, width: 5, height: 5 },
  ];
  assert.equal(groupMembersOf(doc[0], doc).length, 2);
  assert.equal(selectionIsOneGroup([doc[0], doc[1]], doc), true);
  assert.equal(selectionIsOneGroup([doc[0], doc[2]], doc), false);
  const capture = captureGroupTool(groupMembersOf(doc[0], doc), { bounds, move });
  assert.deepEqual(capture.geometry, { kind: 'box', width: 60, height: 60, rotation: 0 });
  assert.deepEqual([capture.members[0].x, capture.members[0].y], [0, 0]);
  assert.ok(capture.members.every(m => !('id' in m) && !('page' in m) && !('groupId' in m) && !('author' in m)));
  assert.equal(captureGroupTool([doc[0], { type: 'comment', icon: 'note', x: 0, y: 0, width: 1, height: 1 }], { bounds, move }).error,
    'blockedMember', 'a group with a note cannot be a tool');

  const set = chest.createToolSet('Doors');
  const { saved } = chest.saveGroupToolPreset(capture, 'Door', [set.id]);
  const [tool] = saved;
  assert.equal(tool.tool, 'group');
  assert.equal(tool.mode, 'drawing');
  assert.equal(chest.toggleToolPresetMode(tool.id), null, 'groups are always Drawing Mode');
  assert.equal(chest.setToolSetMode(set.id, 'properties'), 0);

  let n = 0;
  const placed = placeGroupTool(tool, 7, 500, 500, { move, makeId: () => `n${++n}`, now: () => 'now' });
  assert.equal(placed.length, 2);
  assert.deepEqual([placed[0].x, placed[0].y, placed[0].page], [470, 470, 7], 'centred on the click');
  assert.deepEqual([placed[1].startX, placed[1].startY, placed[1].endX, placed[1].endY], [470, 490, 530, 530]);
  assert.equal(placed[0].groupId, placed[1].groupId);
  assert.notEqual(placed[0].groupId, 'grp_1');
  assert.notEqual(placed[0].id, placed[1].id);
  assert.equal(placed[0].subject, 'Door leaf', 'an exact copy keeps the members\' own properties');
  assert.ok(placed.every(m => m.author === undefined), 'no author of the original document is carried');
  const mine = placeGroupTool(tool, 7, 500, 500, { move, makeId: () => `m${++n}`, now: () => 'now', author: 'Field Crew' });
  assert.ok(mine.every(m => m.author === 'Field Crew'), 'placed members belong to the person placing them');

  // The group tool survives a restart (storage) intact.
  const reloaded = await load('GroupReload');
  const again = reloaded.getToolChestPresets().find(item => item.id === tool.id);
  assert.deepEqual(again.members, tool.members);
  assert.equal(cleanGroupMembers([{ type: 'box' }]), null, 'a group needs two members');
}));

test('Drawing Mode places the saved size, Properties Mode only the look; stamps are always Drawing Mode', withStorage(async () => {
  const chest = await load('Modes');
  const box = chest.saveToolPreset({ type: 'box', strokeColor: '#00aa00', lineWidth: 3, x: 5, y: 5, width: 80, height: 30 }, 'Box');
  assert.equal(box.mode, 'properties');
  chest.activateToolPreset(box.id);
  const drawn = { type: 'box', x: 10, y: 10, width: 12, height: 9, page: 1 };
  const properties = chest.applyActiveToolPreset('box', drawn);
  assert.deepEqual([properties.width, properties.height, properties.strokeColor], [12, 9, '#00aa00'],
    'Properties Mode: a new markup with the saved colour, drawn size');
  chest.toggleToolPresetMode(box.id); // a double-click on the tile
  const drawing = chest.applyActiveToolPreset('box', drawn, 10, 10);
  assert.deepEqual([drawing.width, drawing.height, drawing.strokeColor], [80, 30, '#00aa00'],
    'Drawing Mode: an exact copy at the saved size');

  const stamp = chest.saveToolPreset({ type: 'stamp', stampName: 'Approved', stampText: 'APPROVED', stampColor: '#22c55e',
    x: 0, y: 0, width: 160, height: 50, rotation: 0 }, 'Approved');
  assert.equal(stamp.mode, 'drawing', 'a stamp tool starts in Drawing Mode');
  assert.equal(chest.toggleToolPresetMode(stamp.id), null, 'and stays there');
  assert.ok(chest.ALWAYS_DRAWING_TOOL_TYPES.includes('group'));
}));

test('Detail view fields: Subject and Comment are kept, edited and Subject reaches new markups', withStorage(async () => {
  const chest = await load('Details');
  const line = chest.saveToolPreset({ type: 'line', strokeColor: '#123456', startX: 0, startY: 0, endX: 10, endY: 0 },
    'Feeder', undefined, { subject: 'Power feeder', comment: '  3x2.5 mm2  ' });
  assert.equal(line.subject, 'Power feeder');
  assert.equal(line.comment, '3x2.5 mm2');
  const edited = chest.setToolPresetDetails(line.id, { subject: 'Lighting', comment: '' });
  assert.equal(edited.subject, 'Lighting');
  assert.equal('comment' in edited, false);
  chest.activateToolPreset(line.id);
  assert.equal(chest.applyActiveToolPreset('line', { type: 'line', startX: 0, startY: 0, endX: 1, endY: 1 }).subject, 'Lighting');
  assert.equal(chest.applyActiveToolPreset('line', { type: 'line', subject: 'Own' }).subject, 'Own', 'an existing subject wins');

  // Symbol view is the default; Detail view is a per-set choice.
  let state = emptySectionState();
  assert.equal(sectionView(state, 'set:my-tools'), 'symbol');
  state = withSectionView(state, 'set:my-tools', 'detail');
  assert.equal(sectionView(state, 'set:my-tools'), 'detail');
}));

test('Manage Tool Sets: display, profile, order, remove with tools; set file round trip', withStorage(async () => {
  const chest = await load('Manage');
  const a = chest.addToolSet('Alpha');
  const b = chest.addToolSet('Beta', { display: false });
  const c = chest.addToolSet('Gamma', { profile: 'quantityTakeoff' });
  assert.equal(chest.toolSetVisible(chest.getToolChestSets().find(s => s.id === b.id), 'oculith'), false, 'Display off');
  const gamma = () => chest.getToolChestSets().find(s => s.id === c.id);
  assert.equal(chest.toolSetVisible(gamma(), 'oculith'), false, 'only in its own profile');
  assert.equal(chest.toolSetVisible(gamma(), 'quantityTakeoff'), true);
  chest.setToolSetProfile(c.id, null);
  assert.equal(chest.toolSetVisible(gamma(), 'oculith'), true, 'Show In All Profiles');
  chest.setToolSetDisplay(b.id, true);
  assert.equal(chest.toolSetVisible(chest.getToolChestSets().find(s => s.id === b.id), 'oculith'), true);

  assert.equal(chest.reorderToolSet(c.id, -1), true);
  assert.deepEqual(chest.getToolChestSets().map(s => s.name), ['My tools', 'Alpha', 'Gamma', 'Beta']);
  assert.equal(chest.reorderToolSet(a.id, -1), false, 'My Tools stays first');
  const reloaded = await load('ManageReload');
  assert.deepEqual(reloaded.getToolChestSets().map(s => s.name), ['My tools', 'Alpha', 'Gamma', 'Beta']);

  chest.saveToolPreset({ type: 'box', strokeColor: '#ff0000', x: 0, y: 0, width: 5, height: 5 }, 'In alpha', a.id);
  const content = chest.readToolSetContent(a.id);
  const bytes = buildToolSetFile(content);
  assert.equal(looksLikeToolSetFile(bytes), true);
  const parsed = parseToolSetFile(bytes);
  assert.deepEqual(parsed.tools.map(t => t.name), ['In alpha']);
  assert.equal('setId' in parsed.tools[0], false, 'the file does not carry local set ids');
  const imported = chest.importToolSetContent(parsed);
  assert.equal(imported.set.name, 'Alpha (2)', 'Import makes an independent copy');
  assert.notEqual(chest.getToolChestPresets().find(t => t.setId === imported.set.id).id, content.tools[0].id);

  assert.equal(chest.dropToolSet(a.id), true);
  assert.equal(chest.getToolChestPresets().some(t => t.setId === a.id), false, 'a removed shared set takes its tools');

  // File parsing is defensive.
  assert.throws(() => parseToolSetFile(new Uint8Array(MAX_TOOL_SET_FILE_BYTES + 1)), /at most/u);
  assert.throws(() => parseToolSetFile(new TextEncoder().encode('{"format":"ocudraw.tool-set-file","version":9,"tools":[]}')), /version/u);
  const odd = parseToolSetFile(new TextEncoder().encode('{"format":"ocudraw.tool-set-file","version":1,"name":"X\\u0000Y",' +
    '"tools":[{"id":"ok","name":"n","tool":"line","style":{},"__proto__":{"polluted":1}},{"bad":true}]}'));
  assert.equal(Object.hasOwn(odd.tools[0], '__proto__'), false, 'prototype keys are dropped');
  assert.equal(odd.name, 'X Y');
  assert.equal(odd.rejected, 1);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(mergeUnknownToolFields([{ id: 'a', name: 'n' }], [{ id: 'a', name: 'old', tag: 'T1', layer: 'L1', sequence: { x: 1 } }]),
    [{ id: 'a', name: 'n', tag: 'T1' }], 'unknown fields carry over; known removed fields (layer, sequence) do not come back');
  // A tool's layer (markup layers) travels through the set file as written.
  assert.equal(parseToolSetFile(buildToolSetFile({ name: 'L', tools: [{ id: 'l1', name: 'n', tool: 'line', style: {}, layer: 'E-POWER' }] }))
    .tools[0].layer, 'E-POWER');
  assert.equal(suggestedToolSetFileName('Fire / Safety'), 'Fire_Safety.ocudraw-toolset');
}));

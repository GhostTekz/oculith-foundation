// the external editor .btx import (docs/reference/editor/tool-chest.md): the synthetic fixture from
// scripts/make-synthetic-btx.mjs, and hostile input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseBtx, looksLikeBtx, parseXmlSafely, parsePdfObject, decodeExtBlob, MAX_BTX_BYTES } from './btx-import.js';

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/synthetic-ext-toolset.btx', import.meta.url)));
const encode = (text) => new TextEncoder().encode(text);
const btx = (items, title = 'T') => encode(`<?xml version="1.0"?><BluebeamRevuToolSet Version="1"><Title>${title}</Title>${items}</BluebeamRevuToolSet>`);
const item = (raw, mode = 'properties') => `<ToolChestItem Version="1"><Name>X</Name><Type>Bluebeam.PDF.Annotations.AnnotationSquare</Type><Raw>${deflateSync(Buffer.from(raw, 'latin1')).toString('hex')}</Raw><Mode>${mode}</Mode></ToolChestItem>`;

test('the synthetic .btx imports the supported tools and lists every other item', async () => {
  assert.equal(looksLikeBtx(fixture), true);
  const result = await parseBtx(fixture);
  assert.equal(result.name, 'Synthetic Site Set', 'the zlib/hex title is decoded');
  assert.deepEqual(result.tools.map(tool => [tool.name, tool.tool, tool.mode]), [
    ['Door box', 'box', 'drawing'],
    ['Arrow', 'arrow', 'drawing'],
    ['Ring', 'circle', 'properties'],
    ['Callout', 'callout', 'properties'],
    ['Revision cloud', 'cloud', 'drawing'],
    ['Run', 'polyline', 'drawing'],
    ['Plain raw', 'box', 'properties'],
  ]);
  const door = result.tools[0];
  assert.deepEqual(door.style, { strokeColor: '#ff0000', color: '#ff0000', lineWidth: 2, borderStyle: 'dashed',
    opacity: 0.5, fillColor: '#ffff00' });
  assert.deepEqual(door.geometry, { kind: 'box', width: 60, height: 30, rotation: 0 });
  assert.equal(door.subject, 'Door box');
  assert.equal(door.comment, 'Swing clear');
  assert.deepEqual(result.tools[1].style, { strokeColor: '#0000ff', color: '#0000ff', lineWidth: 1.5,
    startHead: 'none', endHead: 'open' });
  assert.deepEqual(result.tools[1].geometry, { kind: 'line', dx: 100, dy: 0 });
  assert.equal(result.tools[3].style.fontSize, 12);
  assert.equal(result.tools[3].comment, 'Note (see) A', 'PDF string escapes are decoded');
  assert.deepEqual(result.tools[5].geometry.points, [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: -30 }],
    'PDF y-up vertices become page y-down offsets');
  assert.deepEqual(result.unsupported.map(entry => [entry.index, entry.reason]), [
    [6, 'ink'], [7, 'textMarkup'], [8, 'note'], [9, 'measurement'], [11, 'unreadable'],
  ]);
});

test('the imported .btx becomes a local Tool Chest set with cleaned tools', async () => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const chest = await import(`./tool-chest-presets.js?btx=${Date.now()}`);
    const parsed = await parseBtx(fixture);
    const result = chest.importToolSetContent(parsed);
    assert.equal(result.set.name, 'Synthetic Site Set');
    assert.equal(result.accepted, 7);
    assert.equal(result.rejected, 0);
    const tools = chest.getToolChestPresets().filter(tool => tool.setId === result.set.id);
    assert.deepEqual(tools.map(tool => tool.tool), ['box', 'arrow', 'circle', 'callout', 'cloud', 'polyline', 'box']);
    assert.equal(tools[0].mode, 'drawing');
    assert.equal(tools[0].subject, 'Door box');
    assert.ok(tools.every(tool => /^tc_/u.test(tool.id)), 'imported tools get fresh ids');
    // Import is a copy: the set is a normal, editable local set.
    assert.equal(chest.canEditToolSet(result.set.id), true);
  } finally {
    globalThis.localStorage = previous;
  }
});

test('a tool made of several markups becomes one group, and a vertex polygon keeps its outline', async () => {
  const raw = (body) => deflateSync(Buffer.from(body, 'latin1')).toString('hex');
  const grouped = btx(`<ToolChestItem Version="1"><Name>X</Name><Type>Bluebeam.PDF.Annotations.AnnotationPolygon</Type><Raw>${raw('<</Subtype/Line/Subj(Door)/OC(Doors)/L[0 0 40 0]/C[1 0 0]>>')}</Raw><Mode>drawing</Mode><Child><Raw>${raw('<</Subtype/Line/L[0 0 0 20]>>')}</Raw></Child></ToolChestItem>`);
  const group = await parseBtx(grouped);
  assert.equal(group.tools.length, 1);
  assert.equal(group.unsupported.length, 0);
  const door = group.tools[0];
  assert.equal(door.name, 'Door');
  assert.equal(door.tool, 'group');
  assert.equal(door.mode, 'drawing');
  assert.equal(door.layer, 'Doors');
  assert.equal(door.members.length, 2);
  assert.deepEqual(door.members.map(member => member.type), ['line', 'line']);
  assert.deepEqual(door.geometry, { kind: 'box', width: 40, height: 20, rotation: 0 });
  assert.deepEqual(
    door.members.map(member => [member.startX, member.startY, member.endX, member.endY]),
    [[0, 20, 40, 20], [0, 20, 0, 0]],
  );

  const outline = await parseBtx(btx(item('<</Subtype/Polygon/Vertices[0 0 30 0 30 30]/Rect[0 0 30 30]/C[0 0 1]>>')));
  assert.equal(outline.tools.length, 1);
  assert.equal(outline.tools[0].tool, 'polygon');
  assert.equal(outline.tools[0].geometry.kind, 'points');
  assert.deepEqual(outline.tools[0].geometry.points, [{ x: 0, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 0 }]);

  const stamps = btx(`<ToolChestItem><Type>Bluebeam.PDF.Annotations.AnnotationStamp</Type><Raw>${raw('<</Subtype/Stamp/Rect[0 0 10 10]>>')}</Raw><Child><Raw>${raw('<</Subtype/Stamp/Rect[0 0 4 4]>>')}</Raw></Child></ToolChestItem>`);
  const pictures = await parseBtx(stamps);
  assert.equal(pictures.tools.length, 0);
  assert.equal(pictures.unsupported[0].reason, 'stamp');

  const outlined = btx(`<ToolChestItem><Type>Bluebeam.PDF.Annotations.AnnotationPolygon</Type><Raw>${raw('<</Subtype/Polygon/Subj(Chair)/Vertices[0 0 30 0 30 30]/Rect[0 0 30 30]/C[0 0 1]>>')}</Raw><Child><Raw>${raw('<</Subtype/Stamp/Rect[0 0 30 30]>>')}</Raw></Child></ToolChestItem>`);
  const chair = await parseBtx(outlined);
  assert.equal(chair.unsupported.length, 0);
  assert.equal(chair.tools[0].tool, 'polygon');
  assert.equal(chair.tools[0].name, 'Chair');
  assert.equal(chair.tools[0].geometry.kind, 'points');
});

test('hostile .btx input is refused or bounded', async () => {
  await assert.rejects(parseBtx(encode('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><BluebeamRevuToolSet><Title>&e;</Title></BluebeamRevuToolSet>')),
    /DTD or entities/u, 'no external entities (XXE)');
  await assert.rejects(parseBtx(new Uint8Array(MAX_BTX_BYTES + 1)), /at most/u);
  await assert.rejects(parseBtx(encode('PK\u0003\u0004zip')), /ZIP/u);
  await assert.rejects(parseBtx(encode('<Other/>')), /not a supported tool set/u);
  await assert.rejects(parseBtx(encode('<BluebeamRevuToolSet><Title>x</Title>')), /well-formed/u);
  let deep = '';
  for (let i = 0; i < 40; i++) deep += '<a>';
  await assert.rejects(parseBtx(encode(`<BluebeamRevuToolSet>${deep}`)), /nested too deeply|well-formed/u);

  // A zlib bomb stops at the inflate cap and is listed as unreadable.
  const bomb = deflateSync(Buffer.alloc(4 * 1024 * 1024, 0x20)).toString('hex');
  const bombed = await parseBtx(encode(`<BluebeamRevuToolSet><Title>B</Title><ToolChestItem><Type>A</Type><Raw>${bomb}</Raw></ToolChestItem></BluebeamRevuToolSet>`));
  assert.equal(bombed.tools.length, 0);
  assert.equal(bombed.unsupported[0].reason, 'unreadable');
  await assert.rejects(decodeExtBlob(bomb), /size limit/u);

  // Deeply nested PDF arrays are refused.
  assert.throws(() => parsePdfObject('['.repeat(100)), /nested too deeply/u);
  // Prototype keys in markup data stay plain data.
  const proto = await parseBtx(btx(item('<</Subtype/Square/__proto__<</polluted true>>/Rect[0 0 10 10]/C[0 0 0]>>')));
  assert.equal(({}).polluted, undefined);
  assert.equal(proto.tools[0].tool, 'box');
  // Entities are limited to the XML five and numeric references.
  assert.equal(parseXmlSafely('<a>&lt;&#65;&#x42;&unknown;</a>').children[0].text, '<AB&unknown;');
  // Too many items.
  await assert.rejects(parseBtx(btx(item('<</Subtype/Square>>').repeat(201))), /at most 200/u);
});

// A Tool Chest preset keeps its custom line style (docs/reference/editor/markup-tools.md):
// the style id plus a clean copy of a user style, through local storage,
// placement and portable export (version 3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presetLineStyle } from './tool-preset-line-style.js';
import { buildPortableToolSetBytes, parsePortableToolSetBytes, validatePortableToolSet,
  TOOL_SET_SEQUENCE_VERSION } from './tool-set-portable.js';

function withStorage(run) {
  return async () => {
    const values = new Map();
    const previous = globalThis.localStorage;
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    try { await run(values); } finally { globalThis.localStorage = previous; }
  };
}

const USER = { id: 'user-gas-ab', name: 'Gas as-built', scaleWithWidth: false,
  lines: [{ offset: 0, dash: [], width: 1 }],
  marks: [{ kind: 'text', text: 'G', size: 8, interval: 50, start: null, gap: 2, offset: 0 }] };

test('presetLineStyle: built-in id only, user style with its definition, garbage dropped', () => {
  assert.deepEqual(presetLineStyle({ lineStyleId: 'gas' }, 'polyline'), { lineStyleId: 'gas' });
  assert.deepEqual(presetLineStyle({ lineStyleId: USER.id, lineStyleDef: USER }, 'line'),
    { lineStyleId: USER.id, lineStyleDef: USER });
  assert.deepEqual(presetLineStyle({ lineStyleId: 'gas' }, 'box'), {}, 'only line tools');
  assert.deepEqual(presetLineStyle({ lineStyleId: '<x>' }, 'line'), {});
  assert.deepEqual(presetLineStyle({ lineStyleId: USER.id, lineStyleDef: { ...USER, id: 'other' } }, 'line'),
    { lineStyleId: USER.id });
});

test('a polyline and a line preset keep their line style through storage and placement', withStorage(async (values) => {
  const tools = await import(`./tool-chest-presets.js?lineStyle=${Date.now()}`);
  const poly = tools.saveToolPreset({ type: 'polyline', page: 2, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
    strokeColor: '#cc0000', lineWidth: 1.5, lineStyleId: 'gas' }, 'Gas as-built');
  assert.equal(poly.style.lineStyleId, 'gas');
  const line = tools.saveToolPreset({ type: 'line', page: 2, startX: 0, startY: 0, endX: 50, endY: 0,
    strokeColor: '#0000cc', lineWidth: 1, lineStyleId: USER.id, lineStyleDef: USER }, 'Fibre');
  assert.deepEqual(line.style.lineStyleDef, USER);
  assert.ok(values.get('oculith-tool-chest-presets-v1').includes('"lineStyleId":"gas"'));

  // A fresh load (restart) still has them.
  const again = await import(`./tool-chest-presets.js?lineStyleReload=${Date.now()}`);
  const stored = again.getToolChestPresets();
  assert.equal(stored.find(p => p.name === 'Gas as-built').style.lineStyleId, 'gas');
  assert.equal(stored.find(p => p.name === 'Fibre').style.lineStyleDef.name, 'Gas as-built');

  // Placing with the preset gives the new markup the style.
  again.activateToolPreset(stored.find(p => p.name === 'Gas as-built').id);
  const drawn = again.applyActiveToolPreset('polyline', { type: 'polyline', page: 1, points: [{ x: 5, y: 5 }, { x: 9, y: 9 }] });
  assert.equal(drawn.lineStyleId, 'gas');
  assert.equal(drawn.strokeColor, '#cc0000');
}));

test('portable export: a styled line tool needs version 3 and round-trips', () => {
  const presets = [{ name: 'Fibre', tool: 'line', style: { strokeColor: '#0000cc', lineWidth: 1,
    lineStyleId: USER.id, lineStyleDef: USER } }];
  const bytes = buildPortableToolSetBytes('Utilities', presets);
  const set = parsePortableToolSetBytes(bytes);
  assert.equal(set.version, TOOL_SET_SEQUENCE_VERSION);
  assert.deepEqual(set.tools[0].style.lineStyleDef, USER);
  assert.throws(() => validatePortableToolSet({ format: 'ocudraw.tool-set', version: 1, name: 'x',
    tools: [{ name: 'a', tool: 'line', style: { lineStyleId: 'gas' } }] }), /version 3/);
  assert.throws(() => validatePortableToolSet({ format: 'ocudraw.tool-set', version: 3, name: 'x',
    tools: [{ name: 'a', tool: 'line', style: { lineStyleId: 'gas', lineStyleDef: { id: 'gas' } } }] }), /invalid/);
});

// Dynamic stamp templates (docs/reference/editor/markup-tools.md): field evaluation, validation,
// JSON export/import, the shared layout and the Tool Chest stamp tool.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACTOR_STAMPS, cleanStampDesign, cleanStampTemplate, evaluateStampText, formatStampDate,
  instantiateStampTemplate, parseUserStampsJson, serializeUserStamps, stampDesignText, stampFileName,
  stampUsesFields,
} from './stamp-templates.js';
import { layoutStampDesign, stampTextWidth } from './stamp-layout.js';

const NOW = new Date(2026, 9, 4, 14, 7);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('dynamic fields evaluate to text at placement', () => {
  const context = { now: NOW, user: 'Jason N', page: 7, pageLabel: 'A-101', fileName: 'C:\\jobs\\Tower\\A-101 Plan.pdf', status: 'Approved' };
  assert.equal(evaluateStampText('{user} {date} {time}', { ...context, dateFormat: 'iso' }), 'Jason N 2026-10-04 14:07');
  assert.equal(evaluateStampText('{date} {time}', { ...context, dateFormat: 'us' }), '10/04/2026 2:07 PM');
  assert.equal(evaluateStampText('{date}', { ...context, dateFormat: 'eu' }), '04-10-2026');
  assert.equal(evaluateStampText('Sheet {pageLabel} of {fileName}', context), 'Sheet A-101 of A-101 Plan.pdf');
  assert.equal(evaluateStampText('{pageLabel}', { ...context, pageLabel: '  ' }), '7', 'no label: the page number');
  assert.equal(evaluateStampText('{status} {unknown} {user}', { status: 'Void' }), 'Void {unknown} User');
  assert.equal(formatStampDate(NOW, 'locale', 'en-US'), '10/04/2026');
  assert.equal(stampFileName('/home/a/b.pdf'), 'b.pdf');
});

test('a placed design stores the evaluated text and keeps its template id', () => {
  const approved = CONTRACTOR_STAMPS.find(t => t.id === 'ct:approvedAsNoted');
  assert.ok(stampUsesFields(approved));
  const design = instantiateStampTemplate({ ...approved, dateFormat: 'iso' }, { now: NOW, user: 'Ana' });
  assert.equal(design.templateId, 'ct:approvedAsNoted');
  assert.deepEqual(design.lines.map(l => l.text), ['APPROVED AS NOTED', 'Ana  2026-10-04']);
  assert.equal(stampDesignText(design), 'APPROVED AS NOTED\nAna  2026-10-04');
  assert.ok(!JSON.stringify(design).includes('{'.concat('user}')), 'no field left in the design');
  // A line that evaluates to nothing goes.
  const empty = instantiateStampTemplate({ ...approved, id: 'user:x', lines: [{ text: 'OK', size: 12 },
    { text: '{status}', size: 8 }], status: '' }, { now: NOW });
  assert.deepEqual(empty.lines.map(l => l.text), ['OK']);
  assert.deepEqual(cleanStampDesign(JSON.parse(JSON.stringify(design))), design);
  assert.equal(cleanStampDesign({ ...design, templateId: 'evil' }), null);
});

test('the ten built-in contractor stamps are valid and named as the external editor names them', () => {
  assert.deepEqual(CONTRACTOR_STAMPS.map(t => t.name), ['Reviewed', 'Approved', 'Approved as Noted',
    'Revise & Resubmit', 'Rejected', 'Field Verified', 'As-Built', 'For Construction', 'Not for Construction', 'Void']);
  for (const template of CONTRACTOR_STAMPS) assert.deepEqual(cleanStampTemplate(template), { ...template, lines: [...template.lines] });
});

test('validation keeps only known keys and safe values', () => {
  const base = { version: 1, id: 'user:abc', name: 'Mine', lines: [{ text: 'HELLO', size: 200, bold: 1 }] };
  const clean = cleanStampTemplate({ ...base, color: 'red', border: 'cloud', extra: 1, image: { dataUrl: 'data:image/svg+xml;base64,AA', width: 1, height: 1 } });
  assert.deepEqual(clean, { version: 1, id: 'user:abc', name: 'Mine', color: '#b91c1c', border: 'rounded',
    dateFormat: 'locale', status: 'Mine', lines: [{ text: 'HELLO', size: 72, bold: false }] });
  assert.equal(cleanStampTemplate({ ...base, id: 'other:abc' }), null);
  assert.equal(cleanStampTemplate({ ...base, lines: [{ text: '  ', size: 8 }] }), null);
  assert.equal(cleanStampTemplate({ ...base, version: 2 }), null);
  assert.equal(cleanStampTemplate({ ...base, image: { dataUrl: PNG, width: 1, height: 1 } }).image.dataUrl, PNG);
  assert.equal(cleanStampTemplate({ ...base, lines: [{ text: 'a\u0000b', size: 9 }] }).lines[0].text, 'a b');
});

test('user stamps export to JSON and import with fresh ids on a clash', () => {
  const mine = [
    { version: 1, id: 'user:one', name: 'Checked by', color: '#123456', border: 'double', dateFormat: 'iso', status: '',
      lines: [{ text: 'CHECKED', size: 16, bold: true }, { text: '{user} {date}', size: 8, bold: false }] },
    { version: 1, id: 'user:two', name: 'Logo', color: '#000000', border: 'none', dateFormat: 'locale', status: 'Logo',
      image: { dataUrl: PNG, width: 1, height: 1 }, lines: [{ text: 'ACME', size: 12, bold: false }] },
  ];
  const json = serializeUserStamps([...mine, CONTRACTOR_STAMPS[0], { junk: true }]);
  const data = JSON.parse(json);
  assert.equal(data.format, 'ocudraw-stamps');
  assert.deepEqual(data.stamps, mine, 'built-ins and invalid entries are not exported');
  let n = 0;
  const { stamps, skipped } = parseUserStampsJson(json, ['user:one'], () => `user:new${++n}`);
  assert.deepEqual(stamps.map(s => s.id), ['user:new1', 'user:two']);
  assert.deepEqual(stamps[1], mine[1]);
  assert.equal(skipped, 0);
  const withBad = JSON.stringify({ ...data, stamps: [...data.stamps, { id: 'user:x', version: 1, name: '', lines: [] }] });
  assert.equal(parseUserStampsJson(withBad, []).skipped, 1);
  assert.throws(() => parseUserStampsJson('{"format":"other","version":1,"stamps":[]}'), /Not an OcuDraw stamps file/u);
  assert.throws(() => parseUserStampsJson('nope'), /not valid JSON/u);
});

test('the layout centres lines, sizes the box from Helvetica metrics and reserves the image', () => {
  const design = { color: '#000000', border: 'double', lines: [{ text: 'APPROVED', size: 18, bold: true }, { text: 'Ana', size: 8, bold: false }] };
  const layout = layoutStampDesign(design);
  assert.equal(layout.borders.length, 2);
  const [title, sub] = layout.texts;
  const titleW = stampTextWidth('APPROVED', 18, true);
  assert.ok(Math.abs((title.x + titleW / 2) - (sub.x + stampTextWidth('Ana', 8, false) / 2)) < 1e-9, 'centred');
  assert.ok(title.baseline < sub.baseline);
  assert.ok(Math.abs(layout.width - (titleW + 2 * title.x)) < 1e-9, 'symmetric padding');
  const withImage = layoutStampDesign({ ...design, image: { width: 2, height: 1 } });
  assert.ok(withImage.image && withImage.width > layout.width + withImage.image.w);
  assert.equal(layoutStampDesign({ ...design, border: 'none' }).borders.length, 0);
  assert.equal(layoutStampDesign({ ...design, border: 'rounded' }).borders[0].r, 4);
});

test('a dynamic stamp saves to the Tool Chest by template id and places again from it', async () => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const tools = await import(`../tools/tool-chest-presets.js?stamps=${Date.now()}`);
    const design = instantiateStampTemplate(CONTRACTOR_STAMPS[1], { now: NOW, user: 'Ana' });
    const placed = { type: 'stamp', page: 2, x: 10, y: 20, width: 120, height: 40, rotation: 0, opacity: 0.9,
      stampName: design.name, stampTemplateId: design.templateId, stampDesign: design, stampColor: design.color };
    assert.equal(tools.canSaveToolPreset(placed), true);
    const preset = tools.saveToolPreset(placed, 'Approved (signed)');
    assert.deepEqual(preset.style, { stampTemplateId: 'ct:approved', stampName: 'Approved', color: '#15803d', opacity: 0.9 });
    assert.ok(!JSON.stringify(preset).includes('Ana'), 'no evaluated text or author in the preset');
    tools.activateToolPreset(preset.id);
    const props = tools.applyActiveToolPreset('stamp', { type: 'stamp', page: 1, x: 0, y: 0, width: 50, height: 20 });
    assert.equal(props.stampTemplateId, 'ct:approved');
    assert.equal(tools.saveToolPreset({ ...placed, stampTemplateId: 'nope' }, 'Bad'), null);
  } finally {
    globalThis.localStorage = previous;
  }
});

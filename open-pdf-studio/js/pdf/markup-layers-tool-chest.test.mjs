// Tool Chest tools on markup layers (the external editor "Add tool sets to PDF layers",
// docs/reference/editor/layers.md), through the real tool creator, saver and PDF.js:
// two tools with the layer "Electrical" share one OCG; markups placed before
// the assignment stay where they were; PDF.js hides both markups when the
// OCG is off; save/reopen keeps the membership.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { convertPdfAnnotation } = await import('./loader/annotation-converter.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { leesAnnotatieLagen, pasGelezenLagenToe } = await import('./saver/annotatie-lagen.js');
const { getLayers, findLayer, isLayerHidden, ensureLayerNamed, updateLayer, DEFAULT_LAYER_ID } =
  await import('../annotations/annotatie-lagen.js');
const { createAnnotationFromTool } = await import('../tools/annotation-creators.js');
const tools = await import('../tools/tool-chest-presets.js');
const { parsePortableToolSetBytes, TOOL_SET_SEQUENCE_VERSION } = await import('../tools/tool-set-portable.js');

const N = (s) => PDFName.of(s);

async function save(bytes, model) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_p, data) => { saved = data; return true; },
  } };
  state.documents = [{ id: 'tool-layers', filePath: 'C:/layers/tools.pdf', pdfDoc: {},
    annotations: model.annotations.map((a) => ({ ...a })),
    annotationLayers: model.annotationLayers?.map((l) => ({ ...l })),
    currentLayerId: model.currentLayerId, pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  assert.equal(await savePDF('C:/layers/tools-out.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

async function reopen(bytes) {
  const lib = await PDFDocument.load(bytes.slice());
  const doc = { annotations: [] };
  pasGelezenLagenToe(doc, leesAnnotatieLagen(lib));
  const colors = await extractAnnotationColors(1, lib);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    for (const a of await page.getAnnotations()) {
      const m = await convertPdfAnnotation(a, 1, page.getViewport({ scale: 1 }), new Map(), colors);
      if (m) doc.annotations.push(m);
    }
  } finally {
    await task.destroy();
  }
  return doc;
}

/** PDF.js in node: annotation id -> visible, with some groups switched off by name. */
async function pdfjsZichtbaar(bytes, uit = []) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const config = await pdf.getOptionalContentConfig();
    for (const [id, groep] of config) if (uit.includes(groep.name)) config.setVisibility(id, false);
    const page = await pdf.getPage(1);
    return (await page.getAnnotations()).map((a) => ({ subtype: a.subtype, oc: a.oc?.id ?? null, zichtbaar: config.isVisible(a.oc) }));
  } finally {
    await task.destroy();
  }
}

test('ensureLayerNamed: one layer per name (case-insensitive), a hidden one is shown again', () => {
  const doc = { annotations: [] };
  const a = ensureLayerNamed(doc, '  Electrical ');
  assert.equal(a.created, true);
  const b = ensureLayerNamed(doc, 'electrical');
  assert.deepEqual(b, { id: a.id, created: false, shown: false });
  updateLayer(doc, a.id, { visible: false });
  assert.deepEqual(ensureLayerNamed(doc, 'ELECTRICAL'), { id: a.id, created: false, shown: true });
  assert.equal(findLayer(doc, a.id).visible, true);
  assert.equal(ensureLayerNamed(doc, '   '), null);
  assert.equal(getLayers(doc).length, 2, 'default + Electrical');
});

test('two tools on "Electrical": one OCG, both markups /OC to it, hidden together in PDF.js, kept on reopen', async () => {
  const set = tools.createToolSet(`Electrical ${Date.now()}`);
  const red = tools.saveToolPreset({ type: 'line', strokeColor: '#ff0000', color: '#ff0000', lineWidth: 2 }, 'Red cable', set.id);
  const box = tools.saveToolPreset({ type: 'box', strokeColor: '#0000ff', color: '#0000ff', lineWidth: 2 }, 'Socket', set.id);
  assert.ok(red && box);
  const source = await PDFDocument.create();
  source.addPage([595, 842]);
  const model = { annotations: [], currentPage: 1, scale: 1 };
  state.documents = [model];
  state.activeDocumentIndex = 0;

  // A markup placed with the tool BEFORE the layer assignment is not moved.
  tools.activateToolPreset(red.id);
  const before = createAnnotationFromTool('line', 40, 40, 90, 60, null);
  model.annotations.push(before);
  assert.equal(before.layer, undefined);

  // Layer… on both tools ("Electrical"), and the set-level convenience.
  assert.equal(tools.setToolPresetLayer(red.id, ' Electrical ').layer, 'Electrical');
  assert.equal(tools.setToolPresetLayer(box.id, 'Electrical').layer, 'Electrical');
  assert.equal(tools.setToolPresetLayer(red.id, 'x'.repeat(121)), null, 'too long');
  assert.equal(tools.setToolSetLayer(set.id, 'Electrical'), 0, 'already on that layer');
  let created = 0;
  tools.setToolChestLayerListener((_doc, placed) => { if (placed.created) created++; });

  tools.activateToolPreset(red.id);
  const line = createAnnotationFromTool('line', 100, 120, 200, 180, null);
  model.annotations.push(line);
  tools.activateToolPreset(box.id);
  const rect = createAnnotationFromTool('box', 250, 250, 320, 300, null);
  model.annotations.push(rect);
  tools.clearActiveToolPreset();
  const plain = createAnnotationFromTool('box', 400, 400, 450, 450, null);
  model.annotations.push(plain);

  assert.equal(created, 1, 'the layer is created once, on the first placement');
  const electrical = getLayers(model).find((l) => l.name === 'Electrical');
  assert.ok(electrical);
  assert.equal(line.layer, electrical.id);
  assert.equal(rect.layer, electrical.id);
  assert.equal(plain.layer, undefined, 'a markup without the tool stays on the current layer');
  assert.equal(before.layer, undefined, 'placed before the assignment: not moved');
  assert.equal(model.annotations.length, 4);

  const saved = await save(await source.save(), model);
  const lib = await PDFDocument.load(saved);
  const oc = lib.catalog.lookup(N('OCProperties'));
  const ocgs = lib.context.lookup(oc.get(N('OCGs'))).asArray();
  const named = ocgs.filter((r) => lib.context.lookup(r).lookup(N('Name')).decodeText() === 'Electrical');
  assert.equal(named.length, 1, 'one OCG "Electrical"');
  const annots = lib.getPages()[0].node.lookup(N('Annots')).asArray().map((r) => lib.context.lookup(r));
  const onElectrical = annots.filter((d) => d.get(N('OC'))?.tag === named[0].tag);
  assert.equal(onElectrical.length, 2, 'both tool markups point at it');

  const aan = await pdfjsZichtbaar(saved);
  assert.ok(aan.every((a) => a.zichtbaar));
  const uit = await pdfjsZichtbaar(saved, ['Electrical']);
  assert.equal(uit.filter((a) => !a.zichtbaar).length, 2, 'PDF.js hides both when Electrical is off');
  assert.equal(uit.filter((a) => a.zichtbaar).length, 2, 'the others stay visible');

  const doc = await reopen(saved);
  const layer = getLayers(doc).find((l) => l.name === 'Electrical');
  assert.equal(layer.id, electrical.id);
  assert.equal(doc.annotations.filter((a) => a.layer === electrical.id).length, 2);
  assert.equal(doc.annotations.filter((a) => (a.layer || DEFAULT_LAYER_ID) === DEFAULT_LAYER_ID).length, 2);
  // Toggling the layer hides both on the canvas (view-filters use isLayerHidden).
  updateLayer(doc, electrical.id, { visible: false });
  assert.equal(doc.annotations.filter((a) => isLayerHidden(doc, a)).length, 2);
});

test('a tool layer survives copy, update and portable export/import (version 3)', () => {
  const set = tools.createToolSet(`Plumbing ${Date.now()}`);
  const pipe = tools.saveToolPreset({ type: 'line', strokeColor: '#00aa00', lineWidth: 3 }, 'Pipe', set.id);
  tools.setToolSetLayer(set.id, 'Plumbing');
  assert.equal(tools.getToolChestPresets().find((p) => p.id === pipe.id).layer, 'Plumbing');
  const copy = tools.copyToolPreset(pipe.id, tools.DEFAULT_TOOL_SET_ID);
  assert.equal(copy.layer, 'Plumbing');
  const updated = tools.updateToolPresetFromAnnotation(pipe.id, { type: 'line', strokeColor: '#008800', lineWidth: 4,
    startX: 0, startY: 0, endX: 10, endY: 0 });
  assert.equal(updated.layer, 'Plumbing');
  const bytes = tools.exportToolSet(set.id);
  const parsed = parsePortableToolSetBytes(bytes);
  assert.equal(parsed.version, TOOL_SET_SEQUENCE_VERSION);
  assert.equal(parsed.tools[0].layer, 'Plumbing');
  const imported = tools.importToolSet(bytes);
  assert.equal(imported.tools[0].layer, 'Plumbing');
  assert.equal(tools.setToolSetLayer(set.id, null), 1);
  assert.equal(tools.getToolChestPresets().find((p) => p.id === pipe.id).layer, undefined);
  // Version 1 files cannot carry a layer.
  const v1 = new TextEncoder().encode(JSON.stringify({ format: 'ocudraw.tool-set', version: 1, name: 'X',
    tools: [{ name: 'A', tool: 'line', style: { strokeColor: '#000000' }, layer: 'L' }] }));
  assert.throws(() => parsePortableToolSetBytes(v1), /extra fields/);
  for (const p of tools.getToolChestPresets()) tools.deleteToolPreset(p.id);
});

test('Properties Mode, Drawing Mode and group tools all place on the tool layer; the PDF keeps /OC', async () => {
  const { toolChestGroupTool } = await import('../tools/tools/tool-chest-group-tool.js');
  const { captureGroupTool } = await import('../tools/tool-chest-groups.js');
  const { applyMoveGeneric } = await import('../annotations/transforms.js');
  const getAnnotationBounds = (a) => (a.type === 'line'
    ? { x: Math.min(a.startX, a.endX), y: Math.min(a.startY, a.endY), width: Math.abs(a.endX - a.startX), height: Math.abs(a.endY - a.startY) }
    : { x: a.x, y: a.y, width: a.width, height: a.height });
  const set = tools.createToolSet(`Electrical modes ${Date.now()}`);
  const box = tools.saveToolPreset({ type: 'box', strokeColor: '#0000ff', color: '#0000ff', lineWidth: 2,
    x: 0, y: 0, width: 40, height: 20 }, 'Panel', set.id);
  assert.equal(box.mode, 'properties');
  assert.ok(box.geometry, 'the box size is saved, so Drawing Mode is available');
  const members = [
    { id: 'm1', type: 'box', page: 1, groupId: 'g', layer: 'layer_from_another_document', x: 10, y: 10, width: 30, height: 20,
      strokeColor: '#ff0000', color: '#ff0000', lineWidth: 1 },
    { id: 'm2', type: 'line', page: 1, groupId: 'g', startX: 10, startY: 40, endX: 60, endY: 40,
      strokeColor: '#00aa00', color: '#00aa00', lineWidth: 1 },
  ];
  const capture = captureGroupTool(members, { bounds: getAnnotationBounds, move: applyMoveGeneric });
  assert.ok(capture.members, capture.error);
  assert.ok(capture.members.every((m) => !('layer' in m)), 'a member keeps no document-specific layer id');
  const [group] = tools.saveGroupToolPreset(capture, 'Door', [set.id]).saved;
  assert.ok(group);
  assert.equal(tools.setToolSetLayer(set.id, 'Electrical'), 2);

  const source = await PDFDocument.create();
  source.addPage([595, 842]);
  const model = { annotations: [], currentPage: 1, scale: 1 };
  state.documents = [model];
  state.activeDocumentIndex = 0;

  tools.activateToolPreset(box.id);
  const properties = createAnnotationFromTool('box', 100, 100, 160, 130, null);
  model.annotations.push(properties);
  tools.toggleToolPresetMode(box.id);
  tools.activateToolPreset(box.id);
  assert.equal(tools.activeToolPreset().mode, 'drawing');
  const drawing = createAnnotationFromTool('box', 200, 200, 200, 200, null);
  model.annotations.push(drawing);

  tools.activateToolPreset(group.id);
  const ctx = { state: { isDrawing: true, startX: 300, startY: 300 }, pageNum: 1, redraw: () => {} };
  assert.equal(toolChestGroupTool.onPointerUp(ctx), true);
  const placedGroup = model.annotations.filter((a) => a.groupId && a.groupId !== 'g');
  assert.equal(placedGroup.length, 2);
  tools.clearActiveToolPreset();

  const electrical = getLayers(model).find((l) => l.name === 'Electrical');
  assert.ok(electrical);
  model.annotations = [properties, drawing, ...placedGroup];
  for (const a of model.annotations) assert.equal(a.layer, electrical.id, `${a.type} on Electrical`);

  const saved = await save(await source.save(), model);
  const lib = await PDFDocument.load(saved);
  const ocgs = lib.context.lookup(lib.catalog.lookup(N('OCProperties')).get(N('OCGs'))).asArray();
  const named = ocgs.filter((r) => lib.context.lookup(r).lookup(N('Name')).decodeText() === 'Electrical');
  assert.equal(named.length, 1);
  const annots = lib.getPages()[0].node.lookup(N('Annots')).asArray().map((r) => lib.context.lookup(r));
  assert.equal(annots.filter((d) => d.get(N('OC'))?.tag === named[0].tag).length, 4, 'all four markups carry /OC');
  const uit = await pdfjsZichtbaar(saved, ['Electrical']);
  assert.ok(uit.every((a) => !a.zichtbaar), 'switching Electrical off hides every one');
  for (const p of tools.getToolChestPresets()) tools.deleteToolPreset(p.id);
});

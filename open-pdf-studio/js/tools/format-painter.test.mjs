// Format Painter (Ctrl+Shift+C) and Multiply (the external editor): the rules, the tool
// against the real undo manager, and Multiply's copies through real bytes.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { register } from 'node:module';
import { PDFDocument, PDFName } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { createAnnotation, cloneAnnotation } = await import('../annotations/factory.js');
const { undo, recordModify } = await import('../core/undo-manager.js');
const { formatFamily, canPaintFormat, formatPatch, multiplyOffsets } = await import('../annotations/format-painter.js');
const { formatPainterTool, armFormatPainter, formatPainterSource } = await import('./tools/format-painter-tool.js');
const { multiplySelection, multiplyScale } = await import('./multiply.js');
const { savePDF } = await import('../pdf/saver.js');

const box = (over = {}) => createAnnotation({ type: 'box', page: 1, x: 10, y: 10, width: 40, height: 30,
  color: '#000000', strokeColor: '#000000', fillColor: 'none', lineWidth: 1, borderStyle: 'solid', opacity: 1, ...over });

function useDoc(annotations, selected = []) {
  state.documents = [{ id: 'fp', filePath: 'C:/fp/in.pdf', currentPage: 1, viewMode: 'single', annotations,
    selectedAnnotations: selected, selectedAnnotation: selected[0] || null,
    pdfDoc: { numPages: 1 }, pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  state.currentTool = 'select';
  return state.documents[0];
}

test('type families: same family paints, other families and locked markups do not', () => {
  assert.equal(formatFamily('box'), formatFamily('circle'));
  assert.equal(formatFamily('line'), formatFamily('arrow'));
  assert.notEqual(formatFamily('box'), formatFamily('line'));
  assert.equal(formatFamily('stamp'), 'type:stamp');
  const src = box();
  assert.ok(canPaintFormat(src, box({ type: 'circle' })));
  assert.ok(!canPaintFormat(src, createAnnotation({ type: 'line', page: 1, startX: 0, startY: 0, endX: 9, endY: 9 })));
  assert.ok(!canPaintFormat(src, box({ locked: true })), 'locked target');
  assert.ok(!canPaintFormat(src, src), 'not on itself');
  const tw = createAnnotation({ type: 'textbox', page: 1, x: 0, y: 0, width: 50, height: 14, noWrap: true });
  const tb = createAnnotation({ type: 'textbox', page: 1, x: 0, y: 0, width: 50, height: 14 });
  assert.ok(!canPaintFormat(tw, tb), 'typewriter text and a text box are not the same kind');
});

test('the patch is appearance only: colours, fill, line width/style, opacity, font', () => {
  const src = createAnnotation({ type: 'textbox', page: 1, x: 1, y: 2, width: 3, height: 4, text: 'source',
    color: '#ff0000', strokeColor: '#ff0000', fillColor: '#ffff00', lineWidth: 3, borderStyle: 'dashed', opacity: 0.5,
    textColor: '#0000ff', fontFamily: 'Courier', fontSize: 18, fontBold: true });
  const dst = createAnnotation({ type: 'callout', page: 1, x: 50, y: 60, width: 70, height: 20, text: 'target', fontSize: 9 });
  const patch = formatPatch(src, dst);
  assert.deepEqual(
    Object.fromEntries(['strokeColor', 'fillColor', 'lineWidth', 'borderStyle', 'opacity', 'textColor', 'fontFamily', 'fontSize', 'fontBold'].map(k => [k, patch[k]])),
    { strokeColor: '#ff0000', fillColor: '#ffff00', lineWidth: 3, borderStyle: 'dashed', opacity: 0.5, textColor: '#0000ff', fontFamily: 'Courier', fontSize: 18, fontBold: true });
  for (const k of ['x', 'y', 'width', 'height', 'text', 'id', 'page', 'type', 'author']) assert.ok(!(k in patch), `no ${k}`);
  // A shape gets no font keys.
  const shapePatch = formatPatch(box({ fontSize: 30 }), box({ type: 'circle' }));
  assert.ok(!('fontSize' in shapePatch));
});

test('Format Painter tool: selection is the source, each click paints with its own undo step, Esc ends', async () => {
  const src = box({ strokeColor: '#00aa00', color: '#00aa00', lineWidth: 4, borderStyle: 'dashed', opacity: 0.6, fillColor: '#ccffcc' });
  const a = box({ x: 100 });
  const b = box({ type: 'circle', x: 200 });
  const line = createAnnotation({ type: 'line', page: 1, startX: 0, startY: 0, endX: 50, endY: 0, color: '#123456', lineWidth: 1 });
  const doc = useDoc([src, a, b, line]);
  // The store wraps the markups: work with what the document holds.
  const [sSrc, sA, sB, sLine] = doc.annotations;
  // startFormatPainter: setTool('formatPainter'), then the selection arms it.
  armFormatPainter([sSrc, sA]);
  assert.equal(formatPainterSource(), null, 'two selected: the first click picks the source');
  let hit = sSrc;
  const ctx = { x: 0, y: 0, findAnnotationAt: () => hit, cloneAnnotation, recordModify, redraw() {} };
  formatPainterTool.onPointerDown(ctx, { button: 0 });
  assert.equal(formatPainterSource(), sSrc, 'picked by click');
  armFormatPainter([sSrc]);
  assert.equal(formatPainterSource(), sSrc, 'one selected markup is the source');
  for (const target of [sA, sB, sLine]) { hit = target; formatPainterTool.onPointerDown(ctx, { button: 0 }); }
  for (const t of [sA, sB]) {
    assert.equal(t.strokeColor, '#00aa00');
    assert.equal(t.lineWidth, 4);
    assert.equal(t.borderStyle, 'dashed');
    assert.equal(t.opacity, 0.6);
    assert.equal(t.fillColor, '#ccffcc');
  }
  assert.equal(sA.x, 100, 'geometry stays');
  assert.equal(sLine.color, '#123456', 'another family is left alone');
  undo();
  const docB = state.documents[0].annotations.find(x => x.id === b.id);
  assert.equal(docB.lineWidth, 1, 'undo restores the last painted markup');
  assert.equal(state.documents[0].annotations.find(x => x.id === a.id).lineWidth, 4, 'the earlier one stays painted');
  assert.equal(formatPainterTool.onEscape(), false, 'Esc falls through to the select-tool switch');
  assert.equal(formatPainterSource(), null);
});

test('Multiply: count copies at growing offsets, one undo step, groups get their own id', () => {
  const g1 = box({ groupId: 'grp_a' });
  const g2 = box({ x: 60, groupId: 'grp_a' });
  const doc = useDoc([g1, g2], [g1, g2]);
  assert.equal(multiplyScale().calibrated, false, 'a blank page has no calibration');
  const copies = multiplySelection({ count: 3, dx: 120, dy: 0 });
  assert.equal(copies.length, 6);
  assert.deepEqual(copies.map(c => c.x), [130, 180, 250, 300, 370, 420]);
  assert.ok(copies.every(c => c.y === 10));
  assert.equal(new Set(copies.map(c => c.groupId)).size, 3, 'one new group per copy');
  assert.ok(copies.every(c => c.groupId !== 'grp_a'));
  assert.equal(new Set(copies.map(c => c.id)).size, 6);
  assert.equal(doc.annotations.length, 8);
  undo();
  assert.equal(state.documents[0].annotations.length, 2, 'all copies go in one undo step');
  assert.deepEqual(multiplyOffsets(0, 1, 1), []);
  assert.deepEqual(multiplyOffsets(2, 5, -3), [{ dx: 5, dy: -3 }, { dx: 10, dy: -6 }]);
  assert.equal(multiplyOffsets(10_000, 1, 0).length, 500, 'capped');
});

test('Multiply copies save as separate PDF markups', async () => {
  const src = box({ x: 20, y: 30, width: 50, height: 40 });
  useDoc([src], [src]);
  multiplySelection({ count: 2, dx: 0, dy: 60 });
  const empty = await PDFDocument.create();
  empty.addPage([595, 842]);
  const bytesIn = await empty.save();
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytesIn,
    writeBinaryFile: (_p, d) => { saved = d; return true; },
    writeBinaryFileAtomic: (_p, d) => { saved = d; return true; },
  } };
  assert.equal(await savePDF('C:/fp/out.pdf', { zonderHandtekeningVraag: true }), true);
  const out = await PDFDocument.load(saved);
  const ctx = out.context;
  const squares = ctx.lookup(out.getPages()[0].node.get(PDFName.of('Annots'))).asArray()
    .map(r => ctx.lookup(r)).filter(d => d.get(PDFName.of('Subtype'))?.toString() === '/Square');
  const tops = squares.map(d => ctx.lookup(d.get(PDFName.of('Rect'))).asArray()[3].asNumber()).sort((p, q) => q - p);
  assert.deepEqual(tops, [812, 752, 692], 'original plus two copies, 60 pt apart');
});

test('wiring: shortcut, menu, dialog, i18n', () => {
  const lees = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(lees('./shortcut-table.js'), /\{ id: 'formatPainter', keys: 'Ctrl\+Shift\+C', category: 'markup', command: 'formatPainter' \}/);
  assert.match(lees('./keyboard-handlers.js'), /formatPainter: \(\) => \{ if \(!isPdfAReadOnly\(\)\) startFormatPainter\(\); \}/);
  assert.match(lees('./tools/format-painter-tool.js'), /setTool\('formatPainter'\);\n\s*if \(state\.currentTool !== 'formatPainter'\) return;[^\n]*\n\s*armFormatPainter\(sel\);/);
  const menus = lees('../solid/commands/menus.js');
  assert.match(menus, /'edit\.formatPainter'/);
  assert.match(menus, /'edit\.multiply'/);
  const edit = lees('../solid/commands/edit.js');
  assert.match(edit, /id: 'edit\.formatPainter'[\s\S]*?m\.startFormatPainter\(\)/);
  assert.match(edit, /id: 'edit\.multiply'[\s\S]*?m\.openDialog\('multiply'\)/);
  assert.match(lees('../solid/components/DialogHost.jsx'), /'multiply': MultiplyDialog,/);
  for (const taal of ['en', 'nl']) {
    const sb = JSON.parse(lees(`../i18n/locales/${taal}/statusbar.json`));
    for (const k of ['pickSource', 'pickTargets', 'locked', 'otherFamily']) assert.ok(sb.formatPainter[k], `${taal} ${k}`);
    const d = JSON.parse(lees(`../i18n/locales/${taal}/dialogs.json`));
    for (const k of ['title', 'selected', 'count', 'offsetX', 'offsetY', 'uncalibrated']) assert.ok(d.multiply[k], `${taal} multiply.${k}`);
    const r = JSON.parse(lees(`../i18n/locales/${taal}/ribbon.json`)).drawing;
    for (const k of ['formatPainter', 'formatPainterTitle', 'multiply', 'multiplyTitle']) assert.ok(r[k], `${taal} ${k}`);
  }
});

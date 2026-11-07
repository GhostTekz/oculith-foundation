// Set Scale in the app: its Calibrate button keeps the dialog's draft while
// the two-point pick runs and the dialog comes back with the picked paper
// length; Apply commits through applyPageScale (one undo step, every
// measurement recalculated) and the scale's precision reaches the
// measurement text. Every scale entry point opens this one dialog.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const {
  applyPageScale, calculateDistance, formatMeasurement, getMeasureScale, rememberSetScaleDraft,
  showCalibrationDialog, showSetScaleDialog,
} = await import('./measurement.js');
const { invalidateScaleRegionCache } = await import('./scale-region.js');
const { paginaOfDocumentSchaal } = await import('./schaal-op-punt.js');
const { initialSetScaleForm, setScaleCommit } = await import('./set-scale-form.js');
const { getDialogs, closeDialog } = await import('../solid/stores/dialogStore.js');
const undoManager = await import('../core/undo-manager.js');

// Same loader as scale-entry-app.test.mjs: the real pick tool with setTool
// recorded and the preview transform stubbed.
const toolUrl = new URL('../tools/tools/calibration-pick-tool.js', import.meta.url);
const toolSource = readFileSync(toolUrl, 'utf8')
  .replace(/^import\s[\s\S]*?from\s+'([^']+)';[ \t]*\r?$/gm, (whole, spec) => (spec === '../manager.js'
    ? 'const setTool = (tool) => { globalThis.__toolSwitches.push(tool); };'
    : spec === '../tool-context.js'
      ? 'const applyToolTransform = () => {};'
      : whole.replace(`'${spec}'`, `'${new URL(spec, toolUrl).href}'`)));
globalThis.__toolSwitches = [];
const { calibrationPickTool } = await import('data:text/javascript;base64,'
  + Buffer.from(toolSource, 'utf8').toString('base64'));

function openDocument({ annotations = [], numPages = 3 } = {}) {
  state.documents = [{ id: `set-scale-${Math.random()}`, currentPage: 1, scale: 1, pdfDoc: { numPages },
    viewMode: 'single', annotations, measureScale: null, detectedScale: null,
    undoStack: [], redoStack: [], savedUndoStackLength: 0 }];
  state.activeDocumentIndex = 0;
  state.preferences.measureScale = null;
  state.preferences.measureRounding = 'none';
  state.calibrationPoints = [];
  globalThis.__toolSwitches = [];
  for (const d of getDialogs()) closeDialog(d.name);
  invalidateScaleRegionCache();
  return state.documents[0];
}

const line = (id, page, length) => ({ id, type: 'measureDistance', page, startX: 0, startY: 0, endX: length, endY: 0 });
const pickCtx = (x, y, pageNum = 1) => ({ x, y, pageNum, state, scale: 1, redraw() {}, snap: () => ({ snapped: false }) });

/** What the dialog does: open on its data, then Apply with a patch typed by the user. */
function applyDialog(patch) {
  const dialog = getDialogs().find(d => d.name === 'setScale');
  assert.ok(dialog, 'Set Scale is open');
  const doc = state.documents[0];
  const pageNum = dialog.data.pageNum || doc.currentPage;
  const form = initialSetScaleForm(dialog.data, paginaOfDocumentSchaal(doc, pageNum));
  const result = setScaleCommit({ ...form, ...patch }, { pageNum, pageCount: doc.pdfDoc.numPages });
  assert.ok(!result.error, result.error);
  applyPageScale(result.scaleData, result.pages);
  closeDialog('setScale');
  return { form, result };
}

test('Calibrate from Set Scale: the draft and the picked paper length come back, Apply sets the range in one undo step', async () => {
  const doc = openDocument({ annotations: [line('a', 1, 36), line('b', 3, 72), line('c', 2, 72)] });
  // The dialog's Calibrate button: switch to the pick, keep the draft, close.
  rememberSetScaleDraft({ pagesMode: 'custom', rangeText: '1,3', paperUnit: 'in', realUnit: 'ft', realText: '1', precision: 'fi16' });
  calibrationPickTool.onPointerDown(pickCtx(10, 10), { button: 0 });
  calibrationPickTool.onPointerDown(pickCtx(10, 64), { button: 0 });
  const dialog = getDialogs().find(d => d.name === 'setScale');
  assert.equal(dialog.data.referencePixelLength, 54);
  assert.equal(dialog.data.draft.rangeText, '1,3');
  assert.deepEqual(globalThis.__toolSwitches, ['select']);

  const before = doc.undoStack.length;
  const { form } = applyDialog({ realText: '10\'-6"' });
  // 54 pt = 0.75 in on paper = 10'-6" real: 1:168.
  assert.deepEqual([form.paperText, form.paperUnit, form.focus], ['0.75', 'in', 'real']);
  assert.equal(doc.pageScales[1].scaleRatio, '1:168');
  assert.deepEqual(Object.keys(doc.pageScales), ['1', '3']);
  assert.equal(doc.pageScales[3].precision, 'fi16');
  assert.equal(doc.annotations[0].measureText, '7\'-0"');
  assert.equal(doc.annotations[1].measureText, '14\'-0"');
  assert.match(doc.annotations[2].measureText, /Scale not set/u, 'page 2 is not in the range');
  assert.equal(doc.undoStack.length, before + 1, 'one undo step');
  await undoManager.undo();
  assert.equal(doc.pageScales, null);
});

test('a cancelled pick drops the draft; other entry points open the same dialog without one', () => {
  openDocument();
  rememberSetScaleDraft({ pagesMode: 'all' });
  calibrationPickTool.onPointerDown(pickCtx(10, 10), { button: 0 });
  calibrationPickTool.onEscape(pickCtx(0, 0));
  calibrationPickTool.onDeactivate(pickCtx(0, 0)); // the keyboard handler then switches tools
  showCalibrationDialog(36, { pageNum: 2 });
  assert.deepEqual(getDialogs()[0], { name: 'setScale', data: { pageNum: 2, referencePixelLength: 36 } });
  closeDialog('setScale');
  rememberSetScaleDraft({ pagesMode: 'all' });
  showSetScaleDialog(3);
  assert.deepEqual(getDialogs()[0], { name: 'setScale', data: { detectedRatio: null, detectedImperial: false, pageNum: 3 } });
  closeDialog('setScale');
  showCalibrationDialog(36);
  assert.equal(getDialogs()[0].data.draft, undefined, 'Set Scale (no Calibrate) forgets an old draft');
});

test('a preset applied to all pages, with feet-inch precision on every measurement', () => {
  const doc = openDocument({ annotations: [line('a', 1, 18 * 12.375), line('b', 2, 18 * 4)] });
  showSetScaleDialog();
  applyDialog({ pagesMode: 'all', presetId: 'arch:1/4', paperText: '1/4', paperUnit: 'in', realText: '1', realUnit: 'ft', precision: 'fi2' });
  assert.deepEqual(Object.keys(doc.pageScales), ['1', '2', '3']);
  assert.equal(doc.pageScales[2].pixelsPerUnit, 18);
  assert.equal(doc.annotations[0].measureText, '12\'-4 1/2"');
  assert.equal(doc.annotations[1].measureText, '4\'-0"');
  const d = calculateDistance(0, 0, 18 * 12.375, 0, 1);
  assert.equal(d.precision, 'fi2');
  assert.equal(formatMeasurement(d), '12\'-4 1/2"');
  assert.equal(getMeasureScale(1).precision, 'fi2');
});

test('decimal precision, defaults without one, and an unset scale still says so', () => {
  const doc = openDocument({ annotations: [line('a', 1, 36)] });
  applyPageScale({ pixelsPerUnit: 18, unit: 'ft', method: 'ratio', scaleRatio: '1:48', precision: 4 }, [1]);
  assert.equal(doc.annotations[0].measureText, '2.0000 ft');
  applyPageScale({ pixelsPerUnit: 18, unit: 'ft', method: 'ratio', scaleRatio: '1:48' }, [1]);
  assert.equal(doc.annotations[0].measureText, '2\'-0"', 'a ft scale without precision shows feet-inches');
  assert.equal(calculateDistance(0, 0, 36, 0, 1).precision, undefined);
  applyPageScale(null, [1]);
  assert.match(doc.annotations[0].measureText, /^Scale not set/u);
  // Areas keep their default formatting under a length precision.
  assert.equal(formatMeasurement({ value: 12.5, unit: 'ft²', calibrated: true, precision: 'fi16' }), '12.50 ft²');
});

test('every scale entry point is the Set Scale dialog', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const host = read('../solid/components/DialogHost.jsx');
  assert.match(host, /'setScale': SetScaleDialog/u);
  assert.doesNotMatch(host, /CalibrationDialog|\/ScaleDialog\.jsx|'calibration':|'scale':/u);
  const menu = read('../solid/components/ContextMenu.jsx');
  assert.doesNotMatch(menu, /openDialog\('scale'/u);
  assert.match(menu, /showCalibrationDialog\(px, \{ pageNum: a\.page/u);
  assert.match(menu, /showSetScaleDialog\(a\.page\)/u);
  const dialog = read('../solid/components/dialogs/SetScaleDialog.jsx');
  assert.match(dialog, /applyPageScale\(result\.scaleData, result\.pages\)/u);
  assert.match(dialog, /<ScaleEquationEditor/u);
  // The pick tool drops the draft on deactivation, so the draft is stored
  // only after the switch to the pick tool.
  assert.ok(dialog.indexOf("setTool('calibrationPick')") < dialog.indexOf('rememberSetScaleDraft({'), 'draft after setTool');
  // The workflow toolbar, the Tools > Measure menu and the palette all run
  // the one tools.measure.setScale command.
  assert.match(read('../solid/commands/tools.js'), /id: 'tools\.measure\.setScale'[\s\S]*?m\.showSetScaleDialog\(\)/u);
  for (const src of ['../solid/commands/workflows.js', '../solid/commands/menus.js']) {
    assert.match(read(src), /'tools\.measure\.setScale'/u, src);
  }
});

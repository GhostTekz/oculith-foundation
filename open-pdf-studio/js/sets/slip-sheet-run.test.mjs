// Slip sheet run (slip-sheet-run.js) and the save it makes, on real PDF bytes.
//
// - A revised PDF that receives no markups is recorded as received: it is not
//   opened as a tab and no "-slip-sheet.pdf" copy is written.
// - A revised PDF that receives markups is opened, and the copy holds them.
// - A save waits for the loader's catalog reads (doc._catalogApplied): a read
//   that lands while the save runs no longer fails it as "The document
//   changed while saving".

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF } = await import('../pdf/saver.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { runSlipSheet } = await import('./slip-sheet-run.js');
const { createSheetRegister, updateSheet } = await import('./sheet-register.js');
const { addPdfPages, fingerprintPdfBytes } = await import('./pdf-page-import.js');

const OLD = 'C:/set/old.pdf';
const NEW_A = 'C:/set/A-101-rev-b.pdf';
const NEW_B = 'C:/set/A-102-rev-b.pdf';
const FP = 'a'.repeat(64);

async function buildPdf(labels) {
  const doc = await PDFDocument.create();
  for (const _ of labels) {
    const page = doc.addPage([842, 595]);
    page.drawRectangle({ x: 30, y: 30, width: 782, height: 535, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  }
  const nums = [];
  labels.forEach((label, index) => nums.push(doc.context.obj(index), doc.context.obj({ P: PDFString.of(label) })));
  doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({ Nums: nums }));
  return doc.save();
}

/** A stand-in for the app's tabs, loader and file access, writing to a map. */
async function app(files, annotationsOf = {}) {
  const disk = new Map(Object.entries(files));
  const opened = [];
  const written = [];
  state.documents = [];
  state.activeDocumentIndex = -1;
  const open = async (path, index) => {
    const doc = state.documents[index];
    if (doc.pdfDoc) return;
    const bytes = disk.get(path);
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
    doc.pdfDoc = await task.promise;
    doc._task = task;
    doc.annotations = annotationsOf[path] || [];
    doc._annotationPagesReady = new Set(Array.from({ length: doc.pdfDoc.numPages }, (_, i) => i + 1));
  };
  globalThis.__saverTest = { impl: {
    isTauri: () => false,
    readBinaryFile: async (path) => disk.get(path) || null,
    getCachedPdfBytes: (path) => disk.get(path) || null,
    getPdfBytes: async (path) => disk.get(path) || null,
    fileExists: async (path) => disk.has(path),
    extractFileName: (path) => String(path).replace(/^.*[\\/]/u, ''),
    createTab: (path) => {
      let index = state.documents.findIndex(doc => doc.filePath === path);
      if (index < 0) {
        opened.push(path);
        state.documents.push({ id: `doc-${path}`, filePath: path, fileName: path, currentPage: 1, annotations: [],
          pageRotations: {}, textEdits: [] });
        index = state.documents.length - 1;
      }
      state.activeDocumentIndex = index;
      return { index };
    },
    loadPDFIfNeeded: open,
    writeBinaryFile: (path, data) => { disk.set(path, data); written.push(path); return true; },
    writeBinaryFileAtomic: (path, data) => { disk.set(path, data); written.push(path); return true; },
  } };
  return { disk, opened, written,
    async close() { for (const doc of state.documents) await doc._task?.destroy(); state.documents = []; } };
}

async function slipSet() {
  let set = createSheetRegister('Tower');
  set = addPdfPages(set, OLD, 2, ['A-101', 'A-102'], FP).register;
  for (const sheet of set.sheets) set = updateSheet(set, sheet.id, { revision: 'A' });
  return set;
}

const rowsFor = (set) => [
  { key: 'a', include: true, filePath: NEW_A, page: 1, sheetId: set.sheets[0].id },
  { key: 'b', include: true, filePath: NEW_B, page: 1, sheetId: set.sheets[1].id },
];

test('a revised PDF that receives no markups is recorded as received: not opened, no copy written', async () => {
  const files = { [OLD]: await buildPdf(['A-101', 'A-102']), [NEW_A]: await buildPdf(['A-101']), [NEW_B]: await buildPdf(['A-102']) };
  const env = await app(files);
  try {
    const set = await slipSet();
    const result = await runSlipSheet({ register: set, rows: rowsFor(set), pageCounts: { [NEW_A]: 1, [NEW_B]: 1 }, revision: 'B' });
    assert.deepEqual(env.opened, [OLD], 'only the old revision is opened, to read its markups');
    assert.deepEqual(env.written, [], 'no -slip-sheet.pdf copy');
    assert.equal(result.carried, 0);
    assert.deepEqual(result.replaced, set.sheets.map(sheet => sheet.id));
    const a = result.register.sheets.find(sheet => sheet.id === set.sheets[0].id);
    assert.equal(a.filePath, NEW_A, 'the set points at the revised PDF as received');
    assert.equal(a.revision, 'B');
    assert.equal(a.sourceSha256, await fingerprintPdfBytes(files[NEW_A]));
    assert.equal(a.history[0].filePath, OLD, 'the old revision stays in the history');
  } finally { await env.close(); }
});

test('only the revised PDF that receives markups is opened and copied', async () => {
  const files = { [OLD]: await buildPdf(['A-101', 'A-102']), [NEW_A]: await buildPdf(['A-101']), [NEW_B]: await buildPdf(['A-102']) };
  const box = createAnnotation({ type: 'box', page: 2, x: 120, y: 140, width: 160, height: 90,
    strokeColor: '#d32f2f', color: '#d32f2f', lineWidth: 2, layer: null });
  const env = await app(files, { [OLD]: [box] });
  try {
    const set = await slipSet();
    const result = await runSlipSheet({ register: set, rows: rowsFor(set), pageCounts: { [NEW_A]: 1, [NEW_B]: 1 }, revision: 'B' });
    const copy = 'C:/set/A-102-rev-b-slip-sheet.pdf';
    assert.deepEqual(env.opened, [OLD, NEW_B]);
    assert.deepEqual(env.written, [copy]);
    assert.equal(result.carried, 1);
    const sheets = Object.fromEntries(result.register.sheets.map(sheet => [sheet.label, sheet.filePath]));
    assert.deepEqual(sheets, { 'A-101': NEW_A, 'A-102': copy });
    const saved = await PDFDocument.load(env.disk.get(copy));
    const subtypes = saved.getPage(0).node.Annots().asArray().map(ref => saved.context.lookup(ref).get(PDFName.of('Subtype'))?.toString());
    assert.deepEqual(subtypes.filter(type => type === '/Square'), ['/Square'], 'the copy holds the carried markup');
  } finally { await env.close(); }
});

test('a save waits for the loader\'s catalog reads instead of failing as changed during the save', async () => {
  const bytes = await buildPdf(['A-101']);
  const env = await app({ [NEW_A]: bytes });
  try {
    const { index } = globalThis.__saverTest.impl.createTab(NEW_A);
    await globalThis.__saverTest.impl.loadPDFIfNeeded(NEW_A, index);
    const doc = state.documents[index];
    doc.annotations = [createAnnotation({ type: 'box', page: 1, x: 100, y: 100, width: 50, height: 40,
      strokeColor: '#000000', color: '#000000', lineWidth: 1, layer: null })];
    // The loader's spaces read: doc.spaces is unset until the catalog lands.
    doc._spacesRead = false;
    let landed = false;
    const land = () => { if (!landed) { landed = true; doc.spaces = []; doc._spacesRead = true; } };
    // It lands when the save waits for it, or else during the write (as a
    // slow read did on a busy main thread).
    doc._catalogApplied = { then(resolve) { land(); resolve(); } };
    const write = globalThis.__saverTest.impl.writeBinaryFileAtomic;
    globalThis.__saverTest.impl.writeBinaryFileAtomic = (path, data) => { land(); return write(path, data); };
    const errors = [];
    const error = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    let saved;
    try { saved = await savePDF('C:/set/out.pdf', { zonderHandtekeningVraag: true }, doc); } finally { console.error = error; }
    assert.deepEqual(errors.filter(line => /changed while saving/u.test(line)), []);
    assert.equal(saved, true);
    assert.equal(landed, true);
    const out = await PDFDocument.load(env.disk.get('C:/set/out.pdf'));
    const subtypes = out.getPage(0).node.Annots().asArray().map(ref => out.context.lookup(ref).get(PDFName.of('Subtype'))?.toString());
    assert.deepEqual(subtypes.filter(type => type !== '/Popup'), ['/Square']);
  } finally { await env.close(); }
});

// The renderer the run imports keeps timers alive under node.
test.after(() => setImmediate(() => process.exit()));

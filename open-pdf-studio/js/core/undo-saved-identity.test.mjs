// Undo and Redo keep the PDF identity (/NM and pdfSource) that a save gave a
// markup. The history snapshot taken before the save describes the editing
// state, not the saved bytes: restoring it must not drop or roll back the
// identity, or the next save writes a duplicate / replaces the wrong object.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName } from 'pdf-lib';

register('./app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('./app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();

const { state } = await import('./state.js');
const undo = await import('./undo-manager.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF } = await import('../pdf/saver.js');
const { decodePdfTextObject } = await import('../pdf/saver/pdf-text.js');

let bytes = null;

function open(initialBytes) {
  bytes = initialBytes;
  state.documents = [{
    id: `undo-id-${Math.random().toString(36).slice(2, 8)}`, filePath: 'C:/undo/plan.pdf', pdfDoc: { numPages: 1 },
    currentPage: 1, scale: 1, viewMode: 'single', annotations: [],
    selectedAnnotation: null, selectedAnnotations: [],
    undoStack: [], redoStack: [], savedUndoStackLength: 0, modified: false,
    textEdits: [], watermarks: [], bookmarks: [], pageRotations: {}, measureScale: null,
    _annotationPagesReady: new Set([1]),
  }];
  state.activeDocumentIndex = 0;
  return state.documents[0];
}

async function save() {
  let saved = null;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_path, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_path, data) => { saved = data; return true; },
  } };
  assert.equal(await savePDF('C:/undo/plan.pdf', { zonderHandtekeningVraag: true }), true);
  assert.ok(saved, 'the saver wrote PDF bytes');
  bytes = saved;
  return saved;
}

async function squares(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  const annots = doc.getPages()[0].node.get(PDFName.of('Annots'));
  if (!annots) return [];
  return doc.context.lookup(annots).asArray().map(ref => doc.context.lookup(ref))
    .filter(d => d.get(PDFName.of('Subtype'))?.toString() === '/Square')
    .map(d => ({ nm: decodePdfTextObject(d.get(PDFName.of('NM'))),
      width: d.get(PDFName.of('BS')) ? Number(doc.context.lookup(d.get(PDFName.of('BS'))).get(PDFName.of('W'))?.toString()) : null }));
}

async function blankPdf() {
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  return source.save();
}

const box = () => createAnnotation({ type: 'box', page: 1, x: 100, y: 120, width: 80, height: 50,
  color: '#275ca1', strokeColor: '#275ca1', lineWidth: 2 });
const live = (doc, id) => doc.annotations.find(a => a.id === id);
const identity = (ann) => JSON.parse(JSON.stringify({ nm: ann.nm, pdfSource: ann.pdfSource }));

test('add, save, undo, redo: the redone markup keeps the identity the save gave it', async () => {
  const doc = open(await blankPdf());
  const ann = box();
  doc.annotations.push(ann);
  undo.recordAdd(ann);

  const first = await save();
  const saved = identity(live(doc, ann.id));
  assert.ok(saved.nm, 'the save assigned /NM');
  assert.equal(saved.pdfSource?.modelId, ann.id, 'the save recorded the PDF source');
  assert.deepEqual((await squares(first)).map(s => s.nm), [saved.nm]);

  await undo.undo();
  assert.equal(live(doc, ann.id), undefined);
  await undo.redo();
  const back = live(doc, ann.id);
  assert.ok(back, 'redo restored the markup');
  assert.deepEqual(identity(back), saved);

  // The next save replaces the saved square instead of adding a second one.
  assert.deepEqual((await squares(await save())).map(s => s.nm), [saved.nm]);
});

test('undoing an edit recorded between two saves does not restore the stale first-save pdfSource', async () => {
  const doc = open(await blankPdf());
  const ann = box();
  doc.annotations.push(ann);
  undo.recordAdd(ann);
  await save();
  const firstIdentity = identity(live(doc, ann.id));

  // Edit after the first save: the snapshot carries the first save's pdfSource.
  const before = JSON.parse(JSON.stringify(live(doc, ann.id)));
  live(doc, ann.id).lineWidth = 6;
  undo.recordModify(ann.id, before, JSON.parse(JSON.stringify(live(doc, ann.id))));
  await save();
  const secondIdentity = identity(live(doc, ann.id));
  assert.equal(secondIdentity.nm, firstIdentity.nm, 'the /NM does not change on a rewrite');
  assert.equal(secondIdentity.pdfSource?.modelId, ann.id);
  assert.notEqual(secondIdentity.pdfSource.ref, firstIdentity.pdfSource.ref, 'the rewrite moved the PDF object');

  await undo.undo();
  const undone = live(doc, ann.id);
  assert.equal(undone.lineWidth, 2, 'the property edit is undone');
  assert.deepEqual(identity(undone), secondIdentity, 'identity follows the latest saved bytes');

  // A save afterwards succeeds and still holds exactly one square.
  const third = await save();
  const list = await squares(third);
  assert.equal(list.length, 1);
  assert.equal(list[0].nm, firstIdentity.nm);
});

test('an edit recorded before any save keeps the identity assigned by the later save', async () => {
  const doc = open(await blankPdf());
  const ann = box();
  doc.annotations.push(ann);
  undo.recordAdd(ann);
  const before = JSON.parse(JSON.stringify(ann));
  live(doc, ann.id).color = '#ff0000';
  live(doc, ann.id).strokeColor = '#ff0000';
  undo.recordModify(ann.id, before, JSON.parse(JSON.stringify(live(doc, ann.id))));
  assert.equal(before.nm, undefined);

  await save();
  const saved = identity(live(doc, ann.id));
  assert.ok(saved.nm);

  await undo.undo();
  assert.equal(live(doc, ann.id).strokeColor, '#275ca1');
  assert.deepEqual(identity(live(doc, ann.id)), saved, 'undo keeps the saved /NM and pdfSource');
  await undo.redo();
  assert.equal(live(doc, ann.id).strokeColor, '#ff0000');
  assert.deepEqual(identity(live(doc, ann.id)), saved, 'redo keeps the saved /NM and pdfSource');

  const list = await squares(await save());
  assert.deepEqual(list.map(s => s.nm), [saved.nm]);
});

test('bulk add, save, undo, redo keeps each saved identity', async () => {
  const doc = open(await blankPdf());
  const a = box();
  const b = createAnnotation({ type: 'box', page: 1, x: 300, y: 400, width: 60, height: 60,
    color: '#00aa00', strokeColor: '#00aa00', lineWidth: 1 });
  doc.annotations.push(a, b);
  undo.recordBulkAdd([a, b]);
  await save();
  const saved = [identity(live(doc, a.id)), identity(live(doc, b.id))];
  assert.ok(saved.every(s => s.nm));
  await undo.undo();
  assert.equal(doc.annotations.length, 0);
  await undo.redo();
  assert.deepEqual([identity(live(doc, a.id)), identity(live(doc, b.id))], saved);
  assert.deepEqual((await squares(await save())).map(s => s.nm).sort(), saved.map(s => s.nm).sort());
});

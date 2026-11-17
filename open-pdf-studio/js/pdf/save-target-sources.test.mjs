// A document that renders from a working copy saves to its original file
// (saveTargetPath) and keeps saving from the working copy. The PDF source of
// each loaded markup must stay on the working copy's objects, or the next
// save loses the fields another producer wrote on that markup. Save As makes
// the output the document's file: there the sources follow the new bytes.
// Real PDF bytes through the real saver.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { PDFArray, PDFDocument, PDFName, PDFString } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();

const { state } = await import('../core/state.js');
const { savePDF, savePDFAs } = await import('./saver.js');

const COPY = 'C:/tmp/opds-edit-1.pdf';
const ORIGINAL = 'C:/drawings/sheet.pdf';
const OWNER = PDFName.of('ZZ_Owner');

async function sheetWithForeignMarkup() {
  const lib = await PDFDocument.create();
  const page = lib.addPage([600, 400]);
  const ref = lib.context.register(lib.context.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 160], C: [0, 0, 1], Border: [0, 0, 2],
    NM: PDFString.of('sq-1'), ZZ_Owner: PDFString.of('kept by the other producer'),
  }));
  page.node.set(PDFName.of('Annots'), lib.context.obj([ref]));
  return { bytes: new Uint8Array(await lib.save()), ref: ref.toString() };
}

function openOnWorkingCopy(bytes, ref) {
  const files = new Map([[COPY, bytes]]);
  const cache = new Map([[COPY, bytes]]);
  const model = { id: 'm-sq-1', type: 'box', page: 1, nm: 'sq-1', x: 100, y: 240, width: 100, height: 60,
    color: '#0000ff', strokeColor: '#0000ff', lineWidth: 2, opacity: 1,
    pdfSource: { ref, modelId: 'm-sq-1', nm: 'sq-1' } };
  state.documents = [{ id: 'working-copy', filePath: COPY, saveTargetPath: ORIGINAL, _renderTemp: true,
    pdfDoc: { numPages: 1 }, currentPage: 1, annotations: [model], pageRotations: {},
    _annotationPagesReady: new Set([1]), textEdits: [], undoStack: [], redoStack: [],
    savedUndoStackLength: 0, modified: true }];
  state.activeDocumentIndex = 0;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: (path) => cache.get(path),
    setCachedPdfBytes: (path, data) => { cache.set(path, data); },
    writeBinaryFileAtomic: (path, data) => { files.set(path, data.slice()); return true; },
    saveFileDialog: async () => 'C:/drawings/copy.pdf',
    bevestigOpslaanMetHandtekeningen: async () => true,
    opslaanAlsStandaardPad: (doc) => doc.filePath,
  } };
  return { doc: state.documents[0], files };
}

async function owner(bytes) {
  const lib = await PDFDocument.load(bytes);
  const annots = lib.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).asArray();
  assert.equal(annots.length, 1, 'one markup on the page');
  return lib.context.lookup(annots[0]).get(OWNER)?.decodeText?.() ?? null;
}

test('saving a working copy to its original twice keeps the other producer\'s field on the markup', async () => {
  const { bytes, ref } = await sheetWithForeignMarkup();
  const { doc, files } = openOnWorkingCopy(bytes, ref);
  assert.equal(await savePDF(null, { zonderHandtekeningVraag: true }, doc), true);
  assert.equal(await owner(files.get(ORIGINAL)), 'kept by the other producer');
  assert.equal(doc.annotations[0].pdfSource.ref, ref, 'the source stays on the working copy the next save starts from');

  doc.annotations[0].color = '#ff0000';
  doc.annotations[0].strokeColor = '#ff0000';
  assert.equal(await savePDF(null, { zonderHandtekeningVraag: true }, doc), true);
  assert.equal(await owner(files.get(ORIGINAL)), 'kept by the other producer');
});

test('after Save As the sources follow the new file, and the next save keeps the field', async () => {
  const { bytes, ref } = await sheetWithForeignMarkup();
  const { doc, files } = openOnWorkingCopy(bytes, ref);
  assert.equal(await savePDFAs(doc), true);
  assert.equal(doc.filePath, 'C:/drawings/copy.pdf');
  doc.annotations[0].color = '#ff0000';
  doc.annotations[0].strokeColor = '#ff0000';
  assert.equal(await savePDF(null, { zonderHandtekeningVraag: true }, doc), true);
  assert.equal(await owner(files.get('C:/drawings/copy.pdf')), 'kept by the other producer');
});

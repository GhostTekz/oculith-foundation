// the external editor measurements without a caption (docs/reference/editor/markup-interop.md): an external editor
// measurement whose appearance draws no text shows no value on the drawing
// in the external editor, so OcuDraw opens it with its label off (measureShowLabel false)
// instead of writing the value over the drawing; a dense the external editor sheet with
// polylength runs was covered in overlapping labels. Switched off labels
// are kept on save (/OPS_NoLabel) and left out of the written appearance.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
globalThis.Image ??= class { constructor() { this.src = ''; } };
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { convertAndPushAnnotations } = await import('./loader/convert-page.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { apZonderTekst } = await import('./ext-interop.js');
const { bouwExtBlad } = await import('./saver/test-fixtures/ext-fixture.mjs');

const N = (s) => PDFName.of(s);

async function open(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const doc = { id: `bijschrift-${Math.random()}`, filePath: 'C:/ext/in.pdf', currentPage: 1, annotations: [],
    selectedAnnotations: [], selectedAnnotation: null, viewMode: 'single', undoStack: [], redoStack: [],
    savedUndoStackLength: 0, pdfDoc: { numPages: pdf.numPages }, pageRotations: {},
    _annotationPagesReady: new Set([1]), textEdits: [] };
  try {
    const page = await pdf.getPage(1);
    const lib = await PDFDocument.load(bytes.slice());
    const colors = await extractAnnotationColors(1, lib);
    await convertAndPushAnnotations(await page.getAnnotations(), 1, page.getViewport({ scale: 1 }), new Map(), colors, doc);
  } finally {
    await task.destroy();
  }
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  return state.documents[0];
}

async function save(bytes, doc) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_p, data) => { saved = data; return true; },
  } };
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  assert.equal(await savePDF('C:/ext/out.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

const modelVan = (doc, refs, naam) => doc.annotations.find((a) => a.extBron?.ref === refs[naam]);
const apTekst = (ctx, dict) => {
  const n = ctx.lookup(ctx.lookup(dict.get(N('AP'))).get(N('N')));
  return Buffer.from(decodePDFRawStream(n).decode()).toString('latin1');
};

test('apZonderTekst: an appearance without Tj/TJ, also in its forms; none or unreadable counts as text', async () => {
  const lib = await PDFDocument.create();
  const ctx = lib.context;
  const ap = (inhoud, res) => ctx.obj({ N: ctx.register(ctx.stream(inhoud, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], ...(res ? { Resources: res } : {}) })) });
  const met = (apDict) => ctx.obj({ Type: 'Annot', AP: apDict });
  assert.equal(apZonderTekst(ctx, met(ap('0 0 1 RG 1 w 0 0 m 10 10 l S'))), true);
  assert.equal(apZonderTekst(ctx, met(ap('BT /Helv 9 Tf 1 1 Td (12\' 3") Tj ET'))), false);
  assert.equal(apZonderTekst(ctx, met(ap('BT [(A) 10 (B)] TJ ET'))), false);
  const vorm = ctx.register(ctx.stream('BT (x) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  assert.equal(apZonderTekst(ctx, met(ap('/F0 Do', ctx.obj({ XObject: ctx.obj({ F0: vorm }) })))), false, 'text in a form');
  assert.equal(apZonderTekst(ctx, ctx.obj({ Type: 'Annot' })), false, 'no appearance: OcuDraw draws as before');
});

test('an external editor measurement without a caption opens with its label off; an untouched save keeps it as it was', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const meting = modelVan(doc, refs, 'meting');
  assert.equal(meting.type, 'measureArea');
  assert.ok(meting.measureText, 'the value is still there (Markups list)');
  assert.equal(meting.measureShowLabel, false);
  const lib = await PDFDocument.load(await save(bytes, doc), { updateMetadata: false });
  const voor = await PDFDocument.load(bytes, { updateMetadata: false });
  const tag = refs.meting;
  const dict = (d) => d.getPages()[0].node.lookup(N('Annots')).asArray().map((r) => [r.tag, d.context.lookup(r)]).find(([t]) => t === tag)[1];
  assert.equal(apTekst(lib.context, dict(lib)), apTekst(voor.context, dict(voor)), 'the external editor\'s appearance is kept');
});

test('an external editor measurement whose appearance shows its value keeps the label', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const lib = await PDFDocument.load(bytes);
  const ref = lib.getPages()[0].node.lookup(N('Annots')).asArray().find((r) => r.tag === refs.meting);
  const dict = lib.context.lookup(ref);
  const n = lib.context.lookup(dict.lookup(N('AP')).get(N('N')));
  lib.context.assign(dict.lookup(N('AP')).get(N('N')),
    lib.context.stream('0 0 1 RG 5 w 100 100 m 400 100 l S BT /Helv 12 Tf 200 200 Td (12 sf) Tj ET', Object.fromEntries(
      n.dict.entries().filter(([k]) => !['Length', 'Filter'].includes(k.asString().slice(1))).map(([k, v]) => [k.asString().slice(1), v]))));
  const metTekst = await lib.save({ useObjectStreams: false });
  const doc = await open(metTekst);
  assert.notEqual(modelVan(doc, refs, 'meting').measureShowLabel, false);
});

test('a polylength with its label off: saved with /OPS_NoLabel and no text in the appearance, and reopened so', async () => {
  const { bytes } = await bouwExtBlad();
  const doc = await open(bytes);
  const run = createAnnotation({ type: 'measurePerimeter', page: 1, points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 160 }],
    strokeColor: '#ff0000', color: '#ff0000', lineWidth: 1, opacity: 1, measureText: '160 pt', measureShowLabel: false });
  doc.annotations.push(run);
  const opgeslagen = await save(bytes, doc);
  const lib = await PDFDocument.load(opgeslagen, { updateMetadata: false });
  const dicts = lib.getPages()[0].node.lookup(N('Annots')).asArray().map((r) => lib.context.lookup(r));
  const poly = dicts.find((d) => d.get(N('Subtype'))?.toString() === '/PolyLine');
  assert.ok(poly);
  assert.ok(poly.get(N('OPS_NoLabel')));
  assert.equal(/\bTj\b/.test(apTekst(lib.context, poly)), false, 'no label in the appearance');
  const doc2 = await open(opgeslagen);
  const terug = doc2.annotations.find((a) => a.type === 'measurePerimeter');
  assert.equal(terug.measureShowLabel, false);
  // With the label on, the appearance shows the value (as before).
  terug.measureShowLabel = true;
  const lib2 = await PDFDocument.load(await save(opgeslagen, doc2), { updateMetadata: false });
  const poly2 = lib2.getPages()[0].node.lookup(N('Annots')).asArray().map((r) => lib2.context.lookup(r))
    .find((d) => d.get(N('Subtype'))?.toString() === '/PolyLine');
  assert.equal(poly2.get(N('OPS_NoLabel')), undefined);
  assert.ok(/\bTj\b/.test(apTekst(lib2.context, poly2)));
});

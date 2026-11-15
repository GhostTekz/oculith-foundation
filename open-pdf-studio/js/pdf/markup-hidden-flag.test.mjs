// The Markups List row eye (docs/reference/editor/layers.md) through real PDF bytes:
// a markup's own `hidden` flag is the annotation Hidden flag (/F bit 2). The
// the external editor layers fixture is opened with the real load pipeline, a markup is
// hidden or shown with the real list action, and the real saver writes it.
// Only the toggled markup changes; every other markup stays byte-equal (WP7
// rule 1), and a markup the external editor saved hidden loads hidden and stays as it was.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

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
const { leesAnnotatieLagen, pasGelezenLagenToe } = await import('./saver/annotatie-lagen.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { list } = await import('../ui/panels/annotations-list.testhulp.mjs');
const { bouwExtLagenBlad } = await import('./saver/test-fixtures/ext-layers-fixture.mjs');
const { dictTekst } = await import('./saver/test-fixtures/ext-fixture.mjs');

const N = (s) => PDFName.of(s);
const HIDDEN = 2;

async function pdfjsDoc(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  return { task, pdf: await task.promise };
}

async function open(bytes) {
  const { task, pdf } = await pdfjsDoc(bytes);
  const doc = { id: `verborgen-${Math.random()}`, filePath: 'C:/ext/verborgen.pdf', currentPage: 1, annotations: [],
    selectedAnnotations: [], selectedAnnotation: null, viewMode: 'single',
    undoStack: [], redoStack: [], savedUndoStackLength: 0,
    pdfDoc: { numPages: pdf.numPages }, pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] };
  try {
    const lib = await PDFDocument.load(bytes.slice());
    pasGelezenLagenToe(doc, leesAnnotatieLagen(lib));
    const page = await pdf.getPage(1);
    const colors = await extractAnnotationColors(1, lib);
    await convertAndPushAnnotations(await page.getAnnotations(), 1, page.getViewport({ scale: 1 }), new Map(), colors, doc);
  } finally {
    await task.destroy();
  }
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  return doc;
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
  assert.equal(await savePDF('C:/ext/verborgen-uit.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

async function dicts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const perRef = new Map();
  for (const r of doc.getPages()[0].node.lookup(N('Annots')).asArray()) perRef.set(r.tag, ctx.lookup(r));
  return { doc, ctx, perRef };
}

const vlag = (dict) => dict.get(N('F'))?.asNumber?.() ?? 0;
const modelVan = (doc, refs, naam) => doc.annotations.find((a) => a.extBron?.ref === refs[naam]);

/** The external editor fixture with "los" saved Hidden by the external editor (/F 6 = Print + Hidden). */
async function blad() {
  const { bytes, refs } = await bouwExtLagenBlad();
  const lib = await PDFDocument.load(bytes);
  const [num] = refs.los.split(' ');
  const losRef = lib.getPages()[0].node.lookup(N('Annots')).asArray().find((r) => String(r.objectNumber) === num);
  lib.context.lookup(losRef).set(N('F'), PDFNumber.of(4 | HIDDEN));
  return { bytes: await lib.save({ useObjectStreams: false }), refs };
}

/** /F per annotation id as PDF.js reads it, for the display and print intents. */
async function pdfjsVlaggen(bytes) {
  const { task, pdf } = await pdfjsDoc(bytes);
  try {
    const page = await pdf.getPage(1);
    const scherm = Object.fromEntries((await page.getAnnotations()).map((a) => [a.id, a.annotationFlags]));
    const afdruk = new Set((await page.getAnnotations({ intent: 'print' })).map((a) => a.id));
    return { scherm, afdruk };
  } finally {
    await task.destroy();
  }
}
const pdfjsId = (tag) => tag.replace(/^(\d+) 0 R$/, '$1R');

function zelfde(voor, na, behalve = []) {
  for (const [tag, d] of voor.perRef) {
    if (behalve.includes(tag)) continue;
    assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag} byte-equal`);
  }
}

test('a markup the external editor saved Hidden loads hidden; an untouched save keeps every markup byte-equal', async () => {
  const { bytes, refs } = await blad();
  const doc = await open(bytes);
  assert.equal(modelVan(doc, refs, 'los').hidden, true, '/F bit 2 → hidden');
  for (const naam of ['stopcontact', 'kabel', 'afvoer']) {
    assert.equal('hidden' in modelVan(doc, refs, naam), false, `${naam}: no hidden key`);
  }
  const voor = await dicts(bytes);
  const na = await dicts(await save(bytes, doc));
  zelfde(voor, na);
  assert.equal(vlag(na.perRef.get(refs.los)), 4 | HIDDEN);
});

test('row eye hides one the external editor markup: only that one is rewritten, /F gets Hidden, it round-trips', async () => {
  const { bytes, refs } = await blad();
  const doc = await open(bytes);
  const kabel = modelVan(doc, refs, 'kabel');
  assert.equal(list.toggleMarkupHidden(kabel.id), true);
  assert.equal(kabel.hidden, true);
  const opgeslagen = await save(bytes, doc);
  const voor = await dicts(bytes);
  const na = await dicts(opgeslagen);
  zelfde(voor, na, [refs.kabel]);
  const nieuw = na.perRef.get(refs.kabel);
  assert.ok(nieuw, 'same object number');
  assert.equal(vlag(nieuw) & HIDDEN, HIDDEN, 'Hidden flag written');
  assert.equal(vlag(nieuw) & 4, 4, 'still printable by its own flag');
  assert.equal(nieuw.get(N('OC'))?.tag, voor.perRef.get(refs.kabel).get(N('OC'))?.tag, 'layer kept');

  // Other viewers: PDF.js reads the flag and leaves it out of print.
  const pdfjs = await pdfjsVlaggen(opgeslagen);
  assert.equal(pdfjs.scherm[pdfjsId(refs.kabel)] & HIDDEN, HIDDEN);
  assert.equal(pdfjs.afdruk.has(pdfjsId(refs.kabel)), false);
  assert.equal(pdfjs.afdruk.has(pdfjsId(refs.stopcontact)), true);

  // Reopen: hidden again, and a second save leaves it as it is.
  const doc2 = await open(opgeslagen);
  assert.equal(modelVan(doc2, refs, 'kabel').hidden, true);
  assert.equal('hidden' in modelVan(doc2, refs, 'stopcontact'), false);
  const tweede = await dicts(await save(opgeslagen, doc2));
  zelfde(na, tweede);
});

test('row eye shows the markup the external editor hid: Hidden cleared, nothing else touched; undo hides it again', async () => {
  const { bytes, refs } = await blad();
  const doc = await open(bytes);
  const los = modelVan(doc, refs, 'los');
  assert.equal(list.toggleMarkupHidden(los.id), false);
  assert.equal('hidden' in los, false, 'showing removes the key');
  const voor = await dicts(bytes);
  const na = await dicts(await save(bytes, doc));
  zelfde(voor, na, [refs.los]);
  assert.equal(vlag(na.perRef.get(refs.los)) & HIDDEN, 0);
  const { undo } = await import('../core/undo-manager.js');
  await undo();
  assert.equal(state.documents[0].annotations.find((a) => a.id === los.id).hidden, true);
});

test('hide and show again is no change: the save is byte-equal', async () => {
  const { bytes, refs } = await blad();
  const doc = await open(bytes);
  const kabel = modelVan(doc, refs, 'kabel');
  list.toggleMarkupHidden(kabel.id);
  list.toggleMarkupHidden(kabel.id);
  zelfde(await dicts(bytes), await dicts(await save(bytes, doc)));
});

test('the row eye does nothing for a markup on a hidden layer (Plumbing is off)', async () => {
  const { bytes, refs } = await blad();
  const doc = await open(bytes);
  const afvoer = modelVan(doc, refs, 'afvoer');
  const stapels = doc.undoStack.length;
  assert.equal(list.toggleMarkupHidden(afvoer.id), null);
  assert.equal('hidden' in afvoer, false);
  assert.equal(doc.undoStack.length, stapels, 'no undo step');
});

test('an OcuDraw markup saved hidden reopens hidden', async () => {
  const { bytes } = await blad();
  await open(bytes);
  // The app's document holds its own list (state.js): add the markup there.
  state.documents[0].annotations.push(createAnnotation({ type: 'box', page: 1, x: 100, y: 500, width: 80, height: 40,
    color: '#ff0000', strokeColor: '#ff0000', lineWidth: 2, opacity: 1, hidden: true }));
  const opgeslagen = await save(bytes, state.documents[0]);
  const doc2 = await open(opgeslagen);
  const d = await dicts(opgeslagen);
  const nieuw = [...d.perRef.values()].find((x) => x.get(N('Subtype'))?.toString() === '/Square' && x.get(N('OPS_MarkupIdV1')));
  assert.equal(vlag(nieuw) & HIDDEN, HIDDEN, 'written with the Hidden flag');
  const vak = doc2.annotations.find((a) => !a.extBron);
  assert.ok(vak, 'reopened');
  assert.equal(vak.hidden, true);
});

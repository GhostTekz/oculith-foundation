// externally marked markup layers (docs/reference/editor/layers.md) through real PDF bytes: a
// synthetic the external editor sheet with /OCProperties and /OC on its markups is opened
// with the real load pipeline and saved with the real saver. Markup-only
// OCGs become markup layers; the drawing's own OCG stays native (K-001);
// untouched markups are written back unchanged (WP7 rule 1).

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
globalThis.Image ??= class { constructor() { this.src = ''; } };
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { convertAndPushAnnotations } = await import('./loader/convert-page.js');
const { leesAnnotatieLagen, pasGelezenLagenToe, vreemdeMarkeringOcgs } = await import('./saver/annotatie-lagen.js');
const { lagenLijst } = await import('../ui/panels/lagen-lijst.js');
const { getLayers, isLayerHidden, isLayerPrintable, findLayer } = await import('../annotations/annotatie-lagen.js');
const { bouwExtLagenBlad } = await import('./saver/test-fixtures/ext-layers-fixture.mjs');
const { dictTekst } = await import('./saver/test-fixtures/ext-fixture.mjs');

const N = (s) => PDFName.of(s);

async function pdfjsDoc(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  return { task, pdf: await task.promise };
}

async function open(bytes) {
  const { task, pdf } = await pdfjsDoc(bytes);
  const doc = { id: 'ext-lagen', filePath: 'C:/ext/lagen.pdf', currentPage: 1, annotations: [],
    pdfDoc: { numPages: pdf.numPages }, pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] };
  try {
    const lib = await PDFDocument.load(bytes.slice());
    // As the loader does: the layer list first, then the page's markups.
    pasGelezenLagenToe(doc, leesAnnotatieLagen(lib));
    const page = await pdf.getPage(1);
    const colors = await extractAnnotationColors(1, lib);
    await convertAndPushAnnotations(await page.getAnnotations(), 1, page.getViewport({ scale: 1 }), new Map(), colors, doc);
  } finally {
    await task.destroy();
  }
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
  assert.equal(await savePDF('C:/ext/lagen-uit.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

async function dicts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const arr = doc.getPages()[0].node.lookup(N('Annots'));
  const perRef = new Map();
  for (const r of arr.asArray()) perRef.set(r.tag, ctx.lookup(r));
  return { doc, ctx, perRef };
}

const modelVan = (doc, refs, naam) => doc.annotations.find((a) => a.extBron?.ref === refs[naam]);
const laagNaam = (doc, ann) => findLayer(doc, ann.layer)?.name;

/** Per annotation /NM: is it visible in PDF.js with the document's own optional content config? */
async function pdfjsZichtbaar(bytes, uitzetten = []) {
  const { task, pdf } = await pdfjsDoc(bytes);
  try {
    const config = await pdf.getOptionalContentConfig();
    const namen = new Map([...config].map(([id, g]) => [g.name, id]));
    for (const naam of uitzetten) config.setVisibility(namen.get(naam), false);
    const page = await pdf.getPage(1);
    const uit = {};
    for (const a of await page.getAnnotations()) {
      uit[a.id] = { oc: a.oc ? [...config].find(([id]) => id === a.oc.id)?.[1]?.name : null, zichtbaar: config.isVisible(a.oc) };
    }
    return { uit, groepen: [...config].map(([, g]) => g.name) };
  } finally {
    await task.destroy();
  }
}

test('the external editor markup OCGs load as markup layers; the drawing OCG stays native', async () => {
  const { bytes, refs, ocg } = await bouwExtLagenBlad();
  const lib = await PDFDocument.load(bytes);
  const vreemd = vreemdeMarkeringOcgs(lib.context);
  assert.deepEqual([...vreemd.values()].map((r) => r.tag), [ocg.Electrical, ocg.Plumbing],
    'A-WALL switches page content, so it is not a markup layer');
  const doc = await open(bytes);
  const lagen = getLayers(doc);
  assert.deepEqual(lagen.map((l) => l.name), ['', 'Electrical', 'Plumbing']);
  const plumbing = lagen.find((l) => l.name === 'Plumbing');
  assert.equal(plumbing.visible, false, '/D /OFF');
  assert.equal(plumbing.printable, false, '/Usage /Print /PrintState /OFF');
  assert.equal(laagNaam(doc, modelVan(doc, refs, 'stopcontact')), 'Electrical');
  assert.equal(laagNaam(doc, modelVan(doc, refs, 'kabel')), 'Electrical');
  assert.equal(laagNaam(doc, modelVan(doc, refs, 'afvoer')), 'Plumbing');
  assert.equal(modelVan(doc, refs, 'los').layer, undefined, 'no /OC: default layer');
  assert.equal(isLayerHidden(doc, modelVan(doc, refs, 'afvoer')), true, 'hidden on canvas');
  assert.equal(isLayerPrintable(doc, modelVan(doc, refs, 'afvoer')), false);
  assert.equal(isLayerHidden(doc, modelVan(doc, refs, 'kabel')), false);

  // The Layers panel's native section lists only the drawing layer.
  const { task, pdf } = await pdfjsDoc(bytes);
  try {
    const regels = lagenLijst(await pdf.getOptionalContentConfig(), { overslaan: doc._annotatieLaagOcgIds });
    assert.deepEqual(regels.map((r) => r.name), ['A-WALL']);
  } finally {
    await task.destroy();
  }
});

test('save without edits: the external editor markups byte-equal, layers and /OC kept, A-WALL untouched', async () => {
  const { bytes, refs, ocg } = await bouwExtLagenBlad();
  const voor = await dicts(bytes);
  const doc = await open(bytes);
  const opgeslagen = await save(bytes, doc);
  const na = await dicts(opgeslagen);
  for (const [tag, d] of voor.perRef) {
    assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag} unchanged`);
  }
  // The A-WALL OCG and the page content are as the external editor wrote them.
  const wandRef = voor.ctx.lookup(voor.doc.catalog.lookup(N('OCProperties')).get(N('OCGs'))).asArray()[0];
  assert.equal(wandRef.tag, ocg['A-WALL']);
  assert.equal(dictTekst(na.ctx, na.ctx.lookup(wandRef)), dictTekst(voor.ctx, voor.ctx.lookup(wandRef)));
  // The external editor layer OCGs themselves are not rewritten either.
  for (const naam of ['Electrical', 'Plumbing']) {
    const ref = [...voor.perRef.values()].map((d) => d.get(N('OC'))).find((r) => r?.tag === ocg[naam]);
    assert.equal(dictTekst(na.ctx, na.ctx.lookup(ref)), dictTekst(voor.ctx, voor.ctx.lookup(ref)), `${naam} OCG unchanged`);
  }
  // Reopen: same layers, same membership, same visibility.
  const doc2 = await open(opgeslagen);
  assert.deepEqual(getLayers(doc2).map((l) => [l.name, l.visible]), [['', true], ['Electrical', true], ['Plumbing', false]]);
  assert.equal(laagNaam(doc2, modelVan(doc2, refs, 'kabel')), 'Electrical');
  assert.equal(laagNaam(doc2, modelVan(doc2, refs, 'afvoer')), 'Plumbing');
  // Other viewers: PDF.js hides the Plumbing markup, and Electrical when switched off.
  const pdfjs = await pdfjsZichtbaar(opgeslagen);
  const perNaam = (id) => pdfjs.uit[id.replace(/^(\d+) 0 R$/, '$1R')];
  assert.equal(perNaam(refs.afvoer).zichtbaar, false);
  assert.equal(perNaam(refs.kabel).zichtbaar, true);
  const elektraUit = await pdfjsZichtbaar(opgeslagen, ['Electrical']);
  assert.equal(elektraUit.uit[refs.kabel.replace(/^(\d+) 0 R$/, '$1R')].zichtbaar, false);
  assert.equal(elektraUit.uit[refs.stopcontact.replace(/^(\d+) 0 R$/, '$1R')].zichtbaar, false);
  assert.equal(elektraUit.uit[refs.los.replace(/^(\d+) 0 R$/, '$1R')].zichtbaar, true);
  // A second save keeps the markups byte-equal too.
  const tweede = await dicts(await save(opgeslagen, doc2));
  for (const [tag, d] of voor.perRef) assert.equal(dictTekst(tweede.ctx, tweede.perRef.get(tag)), dictTekst(voor.ctx, d));
});

test('moving an external editor markup to another layer rewrites only that markup, /OC to the same OCG', async () => {
  const { bytes, refs, ocg } = await bouwExtLagenBlad();
  const voor = await dicts(bytes);
  const doc = await open(bytes);
  const los = modelVan(doc, refs, 'los');
  los.layer = getLayers(doc).find((l) => l.name === 'Electrical').id;
  const na = await dicts(await save(bytes, doc));
  const nieuw = na.perRef.get(refs.los);
  assert.ok(nieuw, 'same object number');
  assert.equal(nieuw.get(N('OC')).tag, ocg.Electrical, 'the external editor OCG, not a new one');
  assert.equal(nieuw.lookup(N('NM')).decodeText(), voor.perRef.get(refs.los).lookup(N('NM')).decodeText());
  for (const [tag, d] of voor.perRef) {
    if (tag === refs.los) continue;
    assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag} untouched`);
  }
  const oc = na.doc.catalog.lookup(N('OCProperties'));
  const namen = na.ctx.lookup(oc.get(N('OCGs'))).asArray().map((r) => na.ctx.lookup(r).lookup(N('Name')).decodeText());
  assert.equal(namen.filter((n) => n === 'Electrical').length, 1, 'one Electrical OCG');
});

test('rename, hide and delete an external editor layer: written to the same OCG, a deleted one leaves /OCProperties', async () => {
  const lagenApi = await import('../annotations/annotatie-lagen.js');
  const { bytes, refs, ocg } = await bouwExtLagenBlad();
  const doc = await open(bytes);
  const elektra = getLayers(doc).find((l) => l.name === 'Electrical');
  const plumbing = getLayers(doc).find((l) => l.name === 'Plumbing');
  assert.equal(lagenApi.renameLayer(doc, elektra.id, 'Electrical (rev B)').ok, true);
  assert.equal(lagenApi.updateLayer(doc, elektra.id, { visible: false }).ok, true);
  // Delete Plumbing; its markup moves to the default layer first (as the panel does).
  lagenApi.assignLayer(lagenApi.annotationsOnLayer(doc, plumbing.id), lagenApi.DEFAULT_LAYER_ID);
  assert.equal(lagenApi.deleteLayer(doc, plumbing.id).ok, true);
  const opgeslagen = await save(bytes, doc);
  const na = await dicts(opgeslagen);
  const oc = na.doc.catalog.lookup(N('OCProperties'));
  const ocgTags = na.ctx.lookup(oc.get(N('OCGs'))).asArray().map((r) => r.tag);
  assert.ok(ocgTags.includes(ocg.Electrical));
  assert.ok(ocgTags.includes(ocg['A-WALL']));
  assert.ok(!ocgTags.includes(ocg.Plumbing), 'the deleted the external editor layer is gone from /OCGs');
  const elektraDict = na.ctx.lookup(na.perRef.get(refs.kabel).get(N('OC')));
  assert.equal(elektraDict.lookup(N('Name')).decodeText(), 'Electrical (rev B)');
  const off = na.ctx.lookup(na.ctx.lookup(oc.get(N('D'))).get(N('OFF'))).asArray().map((r) => r.tag);
  assert.ok(off.includes(ocg.Electrical), 'hidden in /D /OFF');
  const afvoer = na.perRef.get(refs.afvoer);
  assert.notEqual(afvoer.get(N('OC'))?.tag, ocg.Plumbing, 'the moved markup no longer points at Plumbing');
  const doc2 = await open(opgeslagen);
  assert.deepEqual(getLayers(doc2).filter((l) => l.name).map((l) => [l.name, l.visible]), [['Electrical (rev B)', false]]);
  assert.equal(laagNaam(doc2, modelVan(doc2, refs, 'kabel')), 'Electrical (rev B)');
});

// externally marked PDFs (docs/reference/editor/markup-interop.md) through real PDF bytes: a
// synthetic external plan-review files sheet (saver/test-fixtures/ext-fixture.mjs) is opened
// with the real load pipeline (pdf.js annotations + pdf-lib extras +
// converter + page conversion) and saved with the real saver.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFDict, PDFString } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
// The converter caches a decoded picture; node has no Image.
globalThis.Image ??= class { constructor() { this.src = ''; } };
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { convertAndPushAnnotations } = await import('./loader/convert-page.js');
const { bouwExtBlad, dictTekst } = await import('./saver/test-fixtures/ext-fixture.mjs');
const interop = await import('./ext-interop.js');
const { herrekenExtMaat, extSchaalLabel } = await import('../annotations/ext-measure.js');
const { extBeeldVorm, getalUitExtTekst } = await import('./loader/ext-load.js');
const { relinkCopiedGroups } = await import('../annotations/markup-groups.js');

const N = (s) => PDFName.of(s);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0sAAAAASUVORK5CYII=';

async function open(bytes, beelden = new Map()) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const doc = { id: 'ext', filePath: 'C:/ext/in.pdf', currentPage: 1, annotations: [], pdfDoc: { numPages: pdf.numPages },
    pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] };
  try {
    const page = await pdf.getPage(1);
    const lib = await PDFDocument.load(bytes.slice());
    const colors = await extractAnnotationColors(1, lib);
    await convertAndPushAnnotations(await page.getAnnotations(), 1, page.getViewport({ scale: 1 }), beelden, colors, doc);
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
  assert.equal(await savePDF('C:/ext/out.pdf', { zonderHandtekeningVraag: true }), true);
  return saved;
}

async function dicts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const arr = doc.getPages()[0].node.lookup(N('Annots'));
  const perRef = new Map();
  for (const r of arr.asArray()) perRef.set(r.tag, ctx.lookup(r));
  return { doc, ctx, perRef, volgorde: arr.asArray().map((r) => r.tag), objecten: ctx.enumerateIndirectObjects().length };
}

const modelVan = (doc, refs, naam) => doc.annotations.find((a) => a.extBron?.ref === refs[naam]);

test('every markup of the external editor sheet is recognised as the external editor and modelled', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  // Popup is not a markup of its own; every other one is a model.
  assert.equal(doc.annotations.length, Object.keys(refs).length - 1);
  for (const naam of Object.keys(refs)) {
    if (naam === 'popup') continue;
    assert.ok(modelVan(doc, refs, naam), `${naam} carries its the external editor origin`);
  }
  assert.equal(doc._extBron.size, doc.annotations.length);
});

test('mapping: fill opacity, Multiply, alignment, typewriter, callout, rotated polygon, group', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const rect = modelVan(doc, refs, 'rechthoek');
  assert.equal(rect.type, 'box');
  assert.equal(rect.fillOpacity, 0.5, 'the external editor /FillOpacity, not the opaque outer appearance state');
  assert.equal(rect.blendMode, 'multiply');
  assert.equal(rect.subject, 'Rectangle', 'listed under its the external editor subject');
  const typ = modelVan(doc, refs, 'typemachine');
  assert.equal(typ.type, 'textbox');
  assert.equal(typ.noWrap, true, 'a one-line typewriter box does not wrap');
  assert.equal(typ.text, 'Level 2');
  const groepTekst = modelVan(doc, refs, 'groepTekst');
  assert.equal(groepTekst.textAlign, 'center', 'text-align from /DS');
  const callout = modelVan(doc, refs, 'callout');
  assert.equal(callout.type, 'callout');
  assert.equal(callout.textAlign, 'center');
  assert.equal(callout.textVAlign, 'middle');
  assert.ok(Math.abs(callout.arrowX - 605) < 0.01, 'leader tip from /CL');
  const draai = modelVan(doc, refs, 'gedraaid');
  const xs = draai.points.map((p) => p.x);
  const ys = draai.points.map((p) => p.y);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 200) < 0.01, 'rotated polygon is wide on the sheet');
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 100) < 0.01);
  // Group: the text box moves and selects with its rectangle.
  assert.ok(rect.groupId);
  assert.equal(groepTekst.groupId, rect.groupId);
  assert.equal(modelVan(doc, refs, 'lijn').groupId, undefined);
});

test('the external editor area measurement: value from /Measure within 0.5 %, scale labelled "from the file scale"', async () => {
  const { bytes, refs, vlakWaarde } = await bouwExtBlad();
  const doc = await open(bytes);
  const m = modelVan(doc, refs, 'meting');
  assert.equal(m.type, 'measureArea');
  assert.equal(m.measureScaleSource, 'revu');
  assert.ok(Math.abs(m.measureValue - vlakWaarde) / vlakWaarde < 0.005, `${m.measureValue} vs ${vlakWaarde}`);
  assert.ok(Math.abs(getalUitExtTekst(m.measureText) - vlakWaarde) / vlakWaarde < 0.005, 'the external editor text kept');
  assert.equal(m.measureUnit, 'sf');
  assert.equal(extSchaalLabel(m), "from the file scale (0.1370578 in = 3 ft' in\")");
  // Editing the shape recomputes with the external editor's scale, not the (unset) page scale.
  m.points = m.points.map((p, i) => (i === 1 || i === 2 ? { ...p, x: p.x + 300 } : p));
  assert.equal(herrekenExtMaat(m), true);
  assert.ok(Math.abs(m.measureValue - vlakWaarde * 2) / (vlakWaarde * 2) < 0.005);
  assert.match(m.measureText, / sf$/);
  assert.doesNotMatch(m.measureText, /Scale not set/);
});

test('save without edits: every the external editor dictionary, appearance and /Annots stays as it was', async () => {
  const { bytes } = await bouwExtBlad();
  const voor = await dicts(bytes);
  const doc = await open(bytes);
  const opgeslagen = await save(bytes, doc);
  const na = await dicts(opgeslagen);
  assert.deepEqual(na.volgorde, voor.volgorde, 'same objects, same order');
  for (const [tag, d] of voor.perRef) {
    assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag} unchanged`);
  }
  // A second save of the saved file: still the same.
  const doc2 = await open(opgeslagen);
  const tweede = await dicts(await save(opgeslagen, doc2));
  for (const [tag, d] of voor.perRef) assert.equal(dictTekst(tweede.ctx, tweede.perRef.get(tag)), dictTekst(voor.ctx, d));
  assert.ok(Math.abs(tweede.objecten - voor.objecten) <= 1, `object count ${voor.objecten} -> ${tweede.objecten}`);
});

test('move one markup: same object and place, private keys carried, the rest untouched', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const voor = await dicts(bytes);
  const doc = await open(bytes);
  const rect = modelVan(doc, refs, 'rechthoek');
  rect.x += 40;
  const na = await dicts(await save(bytes, doc));
  assert.deepEqual(na.volgorde, voor.volgorde, 'the rewritten markup keeps its object number and z-order');
  const oud = voor.perRef.get(refs.rechthoek);
  const nieuw = na.perRef.get(refs.rechthoek);
  assert.notEqual(dictTekst(na.ctx, nieuw), dictTekst(voor.ctx, oud), 'it was rewritten');
  const rectNieuw = nieuw.lookup(N('Rect')).asArray().map((n) => n.asNumber());
  assert.ok(Math.abs(rectNieuw[0] - 140) < 0.01, 'moved');
  for (const k of ['NM', 'Subj', 'CreationDate', 'GroupNesting', 'Popup']) {
    assert.equal(dictTekst(na.ctx, ctxDict(na.ctx, nieuw, k)), dictTekst(voor.ctx, ctxDict(voor.ctx, oud, k)), `${k} carried over`);
  }
  assert.equal(nieuw.get(N('FillOpacity')).asNumber(), 0.5);
  assert.equal(nieuw.get(N('BM')).toString(), '/Multiply');
  assert.match(nieuw.lookup(N('M')).decodeText(), /^D:\d{14}Z$/, 'the external editor reads a PDF date');
  assert.equal(nieuw.get(N('Contents')), undefined, 'the external editor subject does not become a comment');
  // The group child still points at the same parent object.
  assert.equal(na.perRef.get(refs.groepTekst).get(N('IRT')).tag, refs.rechthoek);
  for (const [tag, d] of voor.perRef) {
    if (tag === refs.rechthoek) continue;
    assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag} untouched`);
  }
});

function ctxDict(ctx, dict, k) {
  const v = dict.get(N(k));
  return v instanceof PDFDict ? v : ctx.obj({ v });
}

test('moved image markup keeps the external editor\'s appearance and /Image; the cleanup keeps referenced objects', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const voor = await dicts(bytes);
  // The picture as the loader's image extraction delivers it (a canvas
  // decode in the app; a fixed PNG here).
  const pdfjsId = refs.beeld.replace(/^(\d+) 0 R$/, '$1R');
  const doc = await open(bytes, new Map([[`id:${pdfjsId}`, { kind: 'square-image', space: 'pdf', dataUrl: PNG }]]));
  const m = modelVan(doc, refs, 'beeld');
  assert.equal(m.type, 'image');
  m.x += 25;
  // A the external editor measurement edited: /Measure and the external editor keys carried, new value in /Contents.
  const meting = modelVan(doc, refs, 'meting');
  meting.points = meting.points.map((p) => ({ ...p, x: p.x + 10 }));
  herrekenExtMaat(meting);
  const na = await dicts(await save(bytes, doc));
  const oud = voor.perRef.get(refs.beeld);
  const nieuw = na.perRef.get(refs.beeld);
  assert.equal(dictTekst(na.ctx, ctxDict(na.ctx, nieuw, 'AP')), dictTekst(voor.ctx, ctxDict(voor.ctx, oud, 'AP')), 'same appearance');
  assert.equal(nieuw.get(N('Image')).tag, oud.get(N('Image')).tag, '/Image kept');
  assert.ok(na.ctx.lookup(nieuw.get(N('Image'))), 'the image object survived the orphan cleanup');
  const r = nieuw.lookup(N('Rect')).asArray().map((n) => n.asNumber());
  assert.ok(Math.abs(r[0] - 125) < 0.01);
  const mNieuw = na.perRef.get(refs.meting);
  const mOud = voor.perRef.get(refs.meting);
  for (const k of ['Measure', 'DepthUnit', 'SlopeType', 'PitchRun', 'AlignOnSegment', 'MeasurementTypes', 'Label', 'NM']) {
    assert.equal(dictTekst(na.ctx, ctxDict(na.ctx, mNieuw, k)), dictTekst(voor.ctx, ctxDict(voor.ctx, mOud, k)), `${k} carried over`);
  }
  assert.equal(mNieuw.get(N('IT')).toString(), '/PolygonDimension');
  assert.equal(mNieuw.lookup(N('Contents')).decodeText(), meting.measureText);
  // Nothing else on the page changed.
  for (const [tag, d] of voor.perRef) {
    if (tag === refs.beeld || tag === refs.meting) continue;
    assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag} untouched`);
  }
});

test('a copy of an external editor markup gets the private keys but not the identity of the original', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const rect = modelVan(doc, refs, 'rechthoek');
  const kopie = { ...structuredClone(rect), id: 'kopie-1', x: rect.x + 300 };
  // As a paste does (clipboard.js): one markup copied out of its group is no member.
  relinkCopiedGroups([rect], [kopie]);
  doc.annotations.push(kopie);
  const na = await dicts(await save(bytes, doc));
  const nieuw = [...na.perRef.entries()].filter(([tag]) => !Object.values(refs).includes(tag)).map(([, d]) => d);
  assert.equal(nieuw.length, 1, 'one new object for the copy');
  assert.equal(nieuw[0].get(N('BM')).toString(), '/Multiply');
  assert.equal(nieuw[0].get(N('FillOpacity')).asNumber(), 0.5);
  for (const k of ['GroupNesting', 'Popup', 'IRT']) assert.equal(nieuw[0].get(N(k)), undefined, `no ${k}`);
  // Its own name: the external editor lists it as another markup than the original.
  const nm = nieuw[0].get(N('NM'))?.decodeText?.();
  assert.ok(nm, 'a /NM of its own');
  assert.notEqual(nm, na.ctx.lookup(na.perRef.get(refs.rechthoek)?.get(N('NM')))?.decodeText?.() ?? na.perRef.get(refs.rechthoek)?.get(N('NM'))?.decodeText?.());
  // The original is untouched.
  const voor = await dicts(bytes);
  assert.equal(dictTekst(na.ctx, na.perRef.get(refs.rechthoek)), dictTekst(voor.ctx, voor.perRef.get(refs.rechthoek)));
});

test('a deleted the external editor markup leaves the file; its group child stays', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  doc.annotations = doc.annotations.filter((a) => a.extBron?.ref !== refs.lijn);
  const na = await dicts(await save(bytes, doc));
  assert.equal(na.perRef.has(refs.lijn), false);
  assert.equal(na.perRef.size, Object.keys(refs).length - 1);
});

test('pure helpers: detection, the external editor scale, rotation, picture shape', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const eigen = ctx.obj({ Type: 'Annot', Subtype: 'Square', NM: interopNm(), M: PDFString.of('D:20260101') });
  eigen.set(N('OPS_Subtype'), ctx.obj('box'));
  assert.equal(interop.isExtAnnotDict(eigen, ctx, { producerIsExt: true }), false, 'an OcuDraw dict is not the external editor');
  const kaal = ctx.obj({ Type: 'Annot', Subtype: 'Square' });
  kaal.set(N('NM'), interopNm());
  assert.equal(interop.isExtAnnotDict(kaal, ctx, { producerIsExt: true }), true, '16-letter /NM in an external editor file');
  assert.equal(interop.isExtAnnotDict(kaal, ctx, { producerIsExt: false }), false);
  const sleutel = ctx.obj({ Type: 'Annot', Subtype: 'Square' });
  sleutel.set(N('GroupNesting'), ctx.obj([]));
  assert.equal(interop.isExtAnnotDict(sleutel, ctx), true, 'an external editor private key');
  assert.deepEqual(interop.extGedraaidePunten([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 40 }, { x: 0, y: 40 }], 270)
    .map((p) => [Math.round(p.x), Math.round(p.y)]), [[25, 15], [25, 25], [-15, 25], [-15, 15]]);
  assert.deepEqual(extBeeldVorm([0, -2, 2, 0, 0, 0], [0, 0, 50, 10]), { width: 100, height: 20, rotation: 90 });
  assert.equal(interop.extDecimalen({ denominator: 1000 }), 3);
  assert.equal(interop.formatExtWaarde(22633.7712, { unit: 'sf', denominator: 100 }), '22,633.77 sf');
  assert.equal(interop.vingerafdruk({ a: 1, _cache: 2, imageId: 'x' }), interop.vingerafdruk({ a: 1 }));
  assert.equal(getalUitExtTekst('1,234.5 sf'), 1234.5);
});

function interopNm() {
  return PDFString.of('ABCDEFGHIJKLMNOP');
}

test('bookmarks are rewritten without leaving the old outline behind (stable object count)', async () => {
  const { bytes } = await bouwExtBlad();
  const doc = await open(bytes);
  doc.bookmarks = [
    { id: 'b1', title: 'Sheet 1', page: 1, sortOrder: 0 },
    { id: 'b2', title: 'Detail', page: 1, sortOrder: 1, parentId: 'b1' },
  ];
  const eerste = await save(bytes, doc);
  const tweede = await save(eerste, doc);
  const derde = await save(tweede, doc);
  const n = async (b) => (await PDFDocument.load(b, { updateMetadata: false })).context.enumerateIndirectObjects().length;
  assert.equal(await n(derde), await n(tweede));
  assert.equal(await n(tweede), await n(eerste));
});

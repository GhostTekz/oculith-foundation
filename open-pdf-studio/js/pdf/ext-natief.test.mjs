// OcuDraw <-> the external editor round trip (docs/reference/editor/markup-interop.md, "Markups made in
// OcuDraw" and "the external editor markups edited in OcuDraw"), through real PDF bytes with
// the real saver and load pipeline. Synthetic sheets only: a blank page and
// the synthetic the external editor sheets of saver/test-fixtures.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';

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
const { assignLayer, addLayer } = await import('../annotations/annotatie-lagen.js');
const { herrekenExtMaat } = await import('../annotations/ext-measure.js');
const { bouwExtBlad } = await import('./saver/test-fixtures/ext-fixture.mjs');
const { bouwExtLagenBlad } = await import('./saver/test-fixtures/ext-layers-fixture.mjs');
const { formatGetalOpmaak } = await import('./ext-getalopmaak.js');
const { rcPlatteTekst, rcVoorTekst, extOnderwerp, schaalVanMeting } = await import('./saver/ext-natief.js');
const { bladwijzerHandtekening } = await import('./saver/bookmarks.js');

const N = (s) => PDFName.of(s);
const tekst = (ctx, v) => { const o = v instanceof PDFRef ? ctx.lookup(v) : v; return o?.decodeText?.(); };

async function open(bytes, id = 'rt') {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const doc = { id, filePath: `C:/rt/${id}.pdf`, currentPage: 1, annotations: [], pdfDoc: { numPages: pdf.numPages },
    pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] };
  try {
    const lib = await PDFDocument.load(bytes.slice());
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
  assert.equal(await savePDF('C:/rt/out.pdf', { zonderHandtekeningVraag: true }, state.documents[0]), true);
  return saved;
}

async function annots(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const page = doc.getPages()[0];
  const arr = page.node.lookup(N('Annots'));
  const lijst = arr instanceof PDFArray ? arr.asArray().map((r) => ({ ref: r, d: ctx.lookup(r) })) : [];
  return { doc, ctx, page, lijst };
}

async function blank() {
  const d = await PDFDocument.create();
  d.addPage([1224, 792]);
  return d.save();
}

const basis = { page: 1, author: 'Tester', color: '#ff0000', strokeColor: '#ff0000', lineWidth: 2, opacity: 1 };
function nieuweMarkeringen() {
  return [
    createAnnotation({ ...basis, type: 'box', x: 50, y: 50, width: 80, height: 40 }),
    createAnnotation({ ...basis, type: 'circle', x: 150, y: 50, width: 80, height: 40 }),
    createAnnotation({ ...basis, type: 'cloud', x: 250, y: 50, width: 80, height: 40 }),
    createAnnotation({ ...basis, type: 'line', startX: 50, startY: 120, endX: 200, endY: 120 }),
    createAnnotation({ ...basis, type: 'arrow', startX: 50, startY: 150, endX: 200, endY: 180 }),
    createAnnotation({ ...basis, type: 'polyline', points: [{ x: 250, y: 120 }, { x: 300, y: 160 }, { x: 350, y: 120 }] }),
    createAnnotation({ ...basis, type: 'polygon', points: [{ x: 400, y: 50 }, { x: 480, y: 60 }, { x: 470, y: 110 }], fillColor: '#00ff00' }),
    createAnnotation({ ...basis, type: 'draw', path: [{ x: 50, y: 220 }, { x: 70, y: 240 }, { x: 90, y: 225 }] }),
    createAnnotation({ ...basis, type: 'textbox', x: 50, y: 300, width: 160, height: 50, text: 'Line one\nLine <two> & more',
      textColor: '#0000ff', strokeColor: '#ff0000', fillColor: 'none', fontSize: 12, fontFamily: 'Helvetica', lineSpacing: 1.15 }),
    createAnnotation({ ...basis, type: 'textbox', noWrap: true, x: 250, y: 300, width: 120, height: 20, text: 'Typed',
      textColor: '#000000', strokeColor: 'none', lineWidth: 0, fillColor: 'none', fontSize: 12, fontFamily: 'Helvetica' }),
    createAnnotation({ ...basis, type: 'callout', x: 400, y: 300, width: 140, height: 40, text: 'Look here',
      textColor: '#000000', fontSize: 12, fontFamily: 'Helvetica', arrowX: 380, arrowY: 380, kneeX: 390, kneeY: 360 }),
    createAnnotation({ ...basis, type: 'measureDistance', startX: 50, startY: 450, endX: 250, endY: 450,
      measureValue: 10, measureUnit: 'm', measureText: '10.00 m' }),
    createAnnotation({ ...basis, type: 'measureArea', points: [{ x: 300, y: 450 }, { x: 400, y: 450 }, { x: 400, y: 550 }, { x: 300, y: 550 }],
      measureValue: 25, measureUnit: 'm²', measureText: '25.00 m²' }),
    createAnnotation({ ...basis, type: 'measurePerimeter', points: [{ x: 450, y: 450 }, { x: 650, y: 450 }],
      measureValue: 10, measureUnit: 'm', measureText: '10.00 m' }),
  ];
}

test('every markup made in OcuDraw carries what the external editor writes: /P, /NM, /Subj, /T, dates, /F, /AP', async () => {
  const bron = await blank();
  const doc = await open(bron, 'nieuw');
  const modellen = nieuweMarkeringen();
  doc.annotations.push(...modellen);
  const bytes = await save(bron, doc);
  const { ctx, page, lijst } = await annots(bytes);
  assert.equal(lijst.length, modellen.length);
  const namen = new Set();
  for (const { d } of lijst) {
    const soort = `${d.get(N('Subtype'))}${d.get(N('IT')) ?? ''}`;
    assert.equal(d.get(N('P'))?.toString(), page.ref.toString(), `${soort}: /P is its page`);
    const nm = tekst(ctx, d.get(N('NM')));
    assert.ok(nm && !namen.has(nm), `${soort}: a unique /NM`);
    assert.doesNotMatch(nm, /^[A-Z]{16}$/, `${soort}: not mistaken for an external editor name`);
    namen.add(nm);
    assert.ok(tekst(ctx, d.get(N('Subj'))), `${soort}: /Subj`);
    assert.equal(tekst(ctx, d.get(N('T'))), 'Tester');
    assert.match(tekst(ctx, d.get(N('CreationDate'))), /^D:\d{14}/, `${soort}: /CreationDate as PDF date`);
    assert.match(tekst(ctx, d.get(N('M'))), /^D:\d{14}/, `${soort}: /M as PDF date`);
    assert.ok(d.get(N('F')) instanceof PDFNumber);
    assert.ok(d.lookup(N('AP'))?.lookup(N('N')) instanceof PDFStream, `${soort}: /AP /N`);
  }
  const subj = lijst.map(({ d }) => tekst(ctx, d.get(N('Subj'))));
  for (const s of ['Rectangle', 'Ellipse', 'Cloud', 'Line', 'Arrow', 'Polyline', 'Polygon', 'Pen', 'Text Box',
    'Typewritten Text', 'Callout', 'Length Measurement', 'Area Measurement', 'Perimeter Measurement']) {
    assert.ok(subj.includes(s), `the file's Subject ${s}`);
  }
});

test('names and dates of an unchanged OcuDraw markup stay the same from save to save; the model keeps its subject', async () => {
  const bron = await blank();
  const doc = await open(bron, 'stabiel');
  doc.annotations.push(...nieuweMarkeringen());
  const eerste = await save(bron, doc);
  const terug = await open(eerste, 'stabiel2');
  // the external editor's default Subject is not a subject the user gave.
  assert.equal(terug.annotations.filter((m) => m.subject && m.subject === extOnderwerp(m)).length, 0, 'no default Subject on the models');
  const tweede = await save(eerste, terug);
  const a = await annots(eerste);
  const b = await annots(tweede);
  const sleutel = (ctx, d) => ['NM', 'CreationDate', 'M', 'Subj'].map((k) => tekst(ctx, d.get(N(k)))).join('|');
  assert.deepEqual(b.lijst.map(({ d }) => sleutel(b.ctx, d)).sort(), a.lijst.map(({ d }) => sleutel(a.ctx, d)).sort());
});

test('a new FreeText: /RC with the text of /Contents, /DS line height in points, /DA the line colour, the external editor typewriter spelling', async () => {
  const bron = await blank();
  const doc = await open(bron, 'tekst');
  doc.annotations.push(...nieuweMarkeringen().filter((m) => m.type === 'textbox' || m.type === 'callout'));
  const bytes = await save(bron, doc);
  const { ctx, lijst } = await annots(bytes);
  for (const { d } of lijst) {
    const inhoud = tekst(ctx, d.get(N('Contents')));
    const rc = tekst(ctx, d.get(N('RC')));
    assert.ok(rc?.includes('xmlns="http://www.w3.org/1999/xhtml"'), '/RC is XHTML');
    assert.equal(rcPlatteTekst(rc).replace(/\s+/g, ''), inhoud.replace(/\s+/g, ''), '/RC holds the /Contents text');
  }
  const vak = lijst.map(({ d }) => d).find((d) => tekst(ctx, d.get(N('Contents')))?.startsWith('Line one'));
  assert.match(tekst(ctx, vak.get(N('RC'))), /Line &lt;two&gt; &amp; more/, 'escaped');
  assert.match(tekst(ctx, vak.get(N('DS'))), /line-height:13\.8pt;/);
  assert.match(tekst(ctx, vak.get(N('DS'))), /color:#0000ff/, 'text colour in /DS');
  assert.match(tekst(ctx, vak.get(N('DA'))), /^1 0 0 rg /, 'the border colour in /DA, as the external editor reads it');
  const typ = lijst.map(({ d }) => d).find((d) => d.get(N('IT')));
  assert.ok(lijst.some(({ d }) => d.get(N('IT'))?.toString() === '/FreeTextTypeWriter'));
  assert.ok(typ);
  // Back in OcuDraw: the text colour comes from /DS, the typewriter stays one.
  const terug = await open(bytes, 'tekst2');
  const tb = terug.annotations.find((m) => m.type === 'textbox' && !m.noWrap);
  assert.equal(tb.textColor.toLowerCase(), '#0000ff');
  assert.equal(tb.strokeColor.toLowerCase(), '#ff0000');
  assert.ok(terug.annotations.some((m) => m.type === 'textbox' && m.noWrap), 'typewriter');
});

test('a new measurement gets an external editor /Measure whose scale gives its value back', async () => {
  const bron = await blank();
  const doc = await open(bron, 'meting');
  const modellen = nieuweMarkeringen().filter((m) => m.type.startsWith('measure'));
  doc.annotations.push(...modellen);
  const bytes = await save(bron, doc);
  const { ctx, lijst } = await annots(bytes);
  assert.equal(lijst.length, 3);
  for (const { d } of lijst) {
    assert.match(d.get(N('IT')).toString(), /Dimension$/);
    const m = d.lookup(N('Measure'));
    assert.equal(m.get(N('Subtype')).toString(), '/RL');
    for (const k of ['X', 'D', 'A']) assert.ok(m.lookup(N(k)) instanceof PDFArray, `/${k}`);
    const x = m.lookup(N('X')).lookup(0);
    assert.ok(Math.abs(x.lookup(N('C')).asNumber() - 0.05) < 1e-9, '10 m over 200 pt, 25 m² over 100x100 pt');
    assert.equal(tekst(ctx, x.get(N('U'))), 'm');
  }
  assert.ok(Math.abs(schaalVanMeting(modellen[1]) - 0.05) < 1e-12);
  // OcuDraw keeps its own scale: the derived /Measure is not read as one.
  const terug = await open(bytes, 'meting2');
  for (const m of terug.annotations) assert.equal(m.measureScale, undefined, m.type);
  const again = await save(bytes, terug);
  const b = await annots(again);
  assert.equal(b.lijst.filter(({ d }) => d.lookup(N('Measure'))?.get(N('OPS_RevuMeasure'))).length, 3, 'stays derived');
});

test('the external editor number formats: feet-inches with fractions, carry, the external editor decimals, thousands', () => {
  const ftIn = [{ u: "'", c: 1, f: 'F', d: 8, ps: '', ss: '-' }, { u: '"', c: 12, f: 'F', d: 8, ps: '', ss: '' }];
  assert.equal(formatGetalOpmaak(123.541667, ftIn), "123'-6 1/2\"");
  assert.equal(formatGetalOpmaak(48.0625, ftIn), "48'-3/4\"");
  assert.equal(formatGetalOpmaak(50, ftIn), "50'-0\"");
  assert.equal(formatGetalOpmaak(9.9999, ftIn), "10'-0\"", 'a rest that rounds up carries');
  const sf = [{ u: 'sf', c: 1, f: 'D', d: 1000, ss: '' }];
  assert.equal(formatGetalOpmaak(1234.779, sf), '1,234.77 sf', 'the external editor shows one place less than /D and cuts off');
  assert.equal(formatGetalOpmaak(1234.705, sf), '1,234.7 sf');
  assert.equal(formatGetalOpmaak(12, [{ u: 'm', c: 2, f: 'D', d: 100 }]), '24 m');
});

test('an edited the external editor measurement: the external editor text format, rise/drop and label; its keys are kept', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes, 'ext-meting');
  const meting = doc.annotations.find((a) => a.extBron?.ref === refs.meting);
  assert.ok(meting.extMeasure.areaChain, 'the whole /A chain is read');
  meting.points = meting.points.map((p, i) => (i === 1 ? { ...p, x: p.x + 50 } : p));
  assert.equal(herrekenExtMaat(meting), true);
  const waarde = (350 + 300) / 2 * 200 * 0.304008 ** 2;
  assert.ok(Math.abs(meting.measureValue - waarde) < 0.01);
  assert.equal(meting.measureText, `${(Math.floor(waarde * 100) / 100).toLocaleString('en-US')} sf`);
  // A run with /RiseDrop and /Label, as the external editor writes it.
  const loop = { type: 'measurePerimeter', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    extMeasure: { xFactor: 1, xUnit: "'", distance: { factor: 1, unit: "'" }, riseDrop: 25, labelText: 'Run A',
      distanceChain: [{ u: "'", c: 1, f: 'F', d: 4, ps: '', ss: '-' }, { u: '"', c: 12, f: 'F', d: 4, ps: '', ss: '' }] } };
  herrekenExtMaat(loop);
  assert.equal(loop.measureText, "Run A\rL = 125'-0\"\rRise/Drop = 25'-0\"");
  assert.equal(loop.measureValue, 125);
  // Saved: the external editor's dictionary keeps its keys, /Contents is the new text.
  const uit = await save(bytes, doc);
  const { ctx, lijst } = await annots(uit);
  const d = lijst.find(({ ref }) => ref.tag === refs.meting).d;
  assert.equal(tekst(ctx, d.get(N('Contents'))), meting.measureText);
  assert.ok(d.lookup(N('Measure')).get(N('TargetUnitConversion')), "the file's /Measure is carried");
  assert.ok(tekst(ctx, d.get(N('DS'))), "the file's label style is carried");
});

test('a rewritten the external editor markup keeps /P, /NM, /CreationDate; its /RC is plan-reviewd with the new text', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes, 'ext-tekst');
  const callout = doc.annotations.find((a) => a.extBron?.ref === refs.callout);
  callout.text = 'See detail 5\nand 6';
  delete callout.textRuns;
  const uit = await save(bytes, doc);
  const voor = await annots(bytes);
  const { ctx, lijst, page } = await annots(uit);
  const d = lijst.find(({ ref }) => ref.tag === refs.callout).d;
  const o = voor.lijst.find(({ ref }) => ref.tag === refs.callout).d;
  assert.equal(d.get(N('P')).toString(), page.ref.toString());
  for (const k of ['NM', 'CreationDate', 'Subj']) assert.equal(tekst(ctx, d.get(N(k))), tekst(voor.ctx, o.get(N(k))), k);
  const rc = tekst(ctx, d.get(N('RC')));
  assert.match(rc, /xfa:APIVersion="BluebeamPDFRevu:2018"/, "the file's body element");
  assert.match(rc, /<p>See detail 5<\/p><p>and 6<\/p>/);
  assert.match(tekst(ctx, d.get(N('M'))), /^D:/);
});

test('a moved the external editor polygon turned a quarter keeps /Rotation and unturned /Vertices', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes, 'ext-draai');
  const veelhoek = doc.annotations.find((a) => a.extBron?.ref === refs.gedraaid);
  const getoond = veelhoek.points.map((p) => ({ ...p }));
  veelhoek.points = veelhoek.points.map((p) => ({ x: p.x + 10, y: p.y }));
  const uit = await save(bytes, doc);
  const d = (await annots(uit)).lijst.find(({ ref }) => ref.tag === refs.gedraaid).d;
  assert.equal(d.get(N('Rotation')).asNumber(), 270);
  const v = d.lookup(N('Vertices')).asArray().map((n) => Math.round(n.asNumber()));
  assert.deepEqual(v, [910, 100, 1010, 100, 1010, 300, 910, 300], 'as the external editor keeps them, moved 10 pt');
  const terug = await open(uit, 'ext-draai2');
  const weer = terug.annotations.find((a) => a.extBron?.ref === refs.gedraaid);
  weer.points.forEach((p, i) => {
    assert.ok(Math.abs(p.x - (getoond[i].x + 10)) < 1e-6 && Math.abs(p.y - getoond[i].y) < 1e-6, `point ${i}`);
  });
});

test('a deleted the external editor markup takes its popup along', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes, 'ext-weg');
  doc.annotations = doc.annotations.filter((a) => a.extBron?.ref !== refs.rechthoek);
  const { ctx, lijst } = await annots(await save(bytes, doc));
  assert.equal(lijst.some(({ ref }) => ref.tag === refs.popup), false, 'no orphan popup');
  for (const { d } of lijst) {
    const ouder = d.get(N('Parent'));
    if (ouder) assert.ok(lijst.some(({ ref }) => ref.tag === ouder.tag), 'every popup has its markup');
  }
  assert.ok(ctx);
});

test('the external editor markup layers: no empty Default layer; a markup without layer stays without /OC; a new layer is a full OCG', async () => {
  const { bytes, refs } = await bouwExtLagenBlad();
  const voor = await PDFDocument.load(bytes);
  const ocgsVoor = voor.catalog.lookup(N('OCProperties')).lookup(N('OCGs')).size();
  const doc = await open(bytes, 'lagen');
  const los = doc.annotations.find((a) => a.extBron?.ref === refs.los);
  los.x += 10;
  const nieuw = createAnnotation({ ...basis, type: 'box', x: 600, y: 600, width: 50, height: 30 });
  doc.annotations.push(nieuw);
  const uit = await save(bytes, doc);
  let na = await PDFDocument.load(uit);
  let ocp = na.catalog.lookup(N('OCProperties'));
  assert.equal(ocp.lookup(N('OCGs')).size(), ocgsVoor, 'no Default OCG added');
  const { lijst } = await annots(uit);
  assert.equal(lijst.find(({ ref }) => ref.tag === refs.los).d.get(N('OC')), undefined, 'still no layer');
  const nieuwDict = lijst.find(({ d }) => d.get(N('OPS_MarkupIdV1')) && !d.get(N('OPS_RevuOrigin'))).d;
  assert.equal(nieuwDict.get(N('OC')), undefined, 'a new markup on the default layer: no /OC');

  // A new layer: an OCG in /OCGs and in /D /Order, the markup's /OC points at it.
  const doc2 = await open(uit, 'lagen2');
  const { layer } = addLayer(doc2, { name: 'Field changes' });
  const vak = doc2.annotations.find((a) => !a.extBron && a.type === 'box');
  assignLayer([vak], layer.id);
  const uit2 = await save(uit, doc2);
  na = await PDFDocument.load(uit2);
  ocp = na.catalog.lookup(N('OCProperties'));
  const ocgs = ocp.lookup(N('OCGs')).asArray();
  const veld = ocgs.find((r) => tekst(na.context, na.context.lookup(r).get(N('Name'))) === 'Field changes');
  assert.ok(veld, 'new OCG');
  assert.equal(na.context.lookup(veld).get(N('Type')).toString(), '/OCG');
  assert.ok(ocp.lookup(N('D')).lookup(N('Order')).asArray().some((r) => r.tag === veld.tag), 'in /D /Order');
  const vakDict = (await annots(uit2)).lijst.find(({ d }) => d.get(N('OPS_MarkupIdV1')) && !d.get(N('OPS_RevuOrigin'))).d;
  assert.equal(vakDict.get(N('OC')).tag, veld.tag);
});

test('unchanged bookmarks keep the file outline (its /Fit views); changed ones are written anew', async () => {
  const d = await PDFDocument.create();
  const p = d.addPage([600, 400]);
  const ctx = d.context;
  const outlines = ctx.obj({ Type: 'Outlines' });
  const oRef = ctx.register(outlines);
  const item = ctx.obj({ Title: PDFString.of('Plan A'), Parent: oRef, Dest: ctx.obj([p.ref, N('Fit')]) });
  const iRef = ctx.register(item);
  outlines.set(N('First'), iRef); outlines.set(N('Last'), iRef); outlines.set(N('Count'), PDFNumber.of(1));
  d.catalog.set(N('Outlines'), oRef);
  const bytes = await d.save();
  const doc = await open(bytes, 'bladwijzers');
  doc.bookmarks = [{ id: 'bm_1', title: 'Plan A', page: 1, top: null, left: null, zoom: null, parentId: null, expanded: true,
    bold: false, italic: false, color: null, sortOrder: 0, fromPdf: true }];
  doc._bookmarksBron = bladwijzerHandtekening(doc.bookmarks);
  doc.bookmarks[0].expanded = false; // the panel's open state is no change
  const uit = await PDFDocument.load(await save(bytes, doc));
  const eerste = uit.catalog.lookup(N('Outlines')).lookup(N('First'));
  assert.equal(eerste.lookup(N('Dest')).get(1).toString(), '/Fit', 'the file outline is kept');
  doc.bookmarks[0].title = 'Plan A (rev)';
  const uit2 = await PDFDocument.load(await save(bytes, doc));
  assert.equal(tekst(uit2.context, uit2.catalog.lookup(N('Outlines')).lookup(N('First')).get(N('Title'))), 'Plan A (rev)');
});

test('loading: the external editor /DS text colour wins over /DA, and PDF dates keep their time zone', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes, 'ext-kleur');
  const callout = doc.annotations.find((a) => a.extBron?.ref === refs.callout);
  assert.equal(callout.textColor.toLowerCase(), '#008000');
  // "D:20260311143527-05'00'" is 19:35:27 UTC.
  assert.equal(callout.createdAt, '2026-03-11T19:35:27.000Z');
});

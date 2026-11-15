// Markup groups through real PDF bytes (docs/reference/editor/markups-list.md). The
// synthetic the external editor sheet (saver/test-fixtures/ext-fixture.mjs) has one the external editor
// group: a rectangle (dominant, /GroupNesting) and a text box (/IRT + /RT
// /Group). It is opened with the real load pipeline and saved with the real
// saver: an untouched group stays byte-equal, an ungroup or a new group is
// written the way the external editor writes groups, and the result reads back the same.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';

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
const { bouwExtBlad, dictTekst } = await import('./saver/test-fixtures/ext-fixture.mjs');
const G = await import('../annotations/markup-groups.js');

const N = (s) => PDFName.of(s);

async function open(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const doc = { id: `groepen-${Math.random()}`, filePath: 'C:/ext/in.pdf', currentPage: 1, annotations: [],
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
  // The app's document holds its own list (state.js): work on that one.
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

async function dicts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const perRef = new Map();
  for (const r of doc.getPages()[0].node.lookup(N('Annots')).asArray()) perRef.set(r.tag, ctx.lookup(r));
  return { ctx, perRef };
}

const modelVan = (doc, refs, naam) => doc.annotations.find((a) => a.extBron?.ref === refs[naam]);
const box = (x, extra = {}) => createAnnotation({ type: 'box', page: 1, x, y: 300, width: 40, height: 20,
  color: '#ff0000', strokeColor: '#ff0000', lineWidth: 1, opacity: 1, ...extra });

test('an external editor group loads with its name and dominant; an untouched save keeps it byte-equal', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const rect = modelVan(doc, refs, 'rechthoek');
  const tekst = modelVan(doc, refs, 'groepTekst');
  const plat = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plat(rect.groupPath), [{ id: rect.groupId, name: 'Group', dominant: rect.id }]);
  assert.deepEqual(plat(tekst.groupPath), plat(rect.groupPath));
  assert.ok(doc.annotations.every((a) => !('_groupKeys' in a)), 'no load-time keys left on the model');
  const voor = await dicts(bytes);
  const na = await dicts(await save(bytes, doc));
  for (const [tag, d] of voor.perRef) assert.equal(dictTekst(na.ctx, na.perRef.get(tag)), dictTekst(voor.ctx, d), `${tag}`);
});

test('ungroup an external editor group: the save drops /IRT, /RT and /GroupNesting, and it reopens ungrouped', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  G.ungroupMarkups(doc.annotations, [modelVan(doc, refs, 'rechthoek')]);
  const opgeslagen = await save(bytes, doc);
  const na = await dicts(opgeslagen);
  const rect = na.perRef.get(refs.rechthoek);
  const tekst = na.perRef.get(refs.groepTekst);
  assert.equal(rect.get(N('GroupNesting')), undefined);
  assert.equal(tekst.get(N('IRT')), undefined);
  assert.equal(tekst.get(N('RT')), undefined);
  const doc2 = await open(opgeslagen);
  assert.equal(modelVan(doc2, refs, 'rechthoek').groupId, undefined);
  assert.equal(modelVan(doc2, refs, 'groepTekst').groupId, undefined);
});

test('rename an external editor group: /GroupNesting carries the new name', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  G.renameGroup(doc.annotations, modelVan(doc, refs, 'rechthoek').groupId, 'Zone 9');
  const opgeslagen = await save(bytes, doc);
  const gn = (await dicts(opgeslagen)).perRef.get(refs.rechthoek).lookup(N('GroupNesting'), PDFArray);
  assert.equal(gn.get(0).decodeText(), 'Zone 9');
  const doc2 = await open(opgeslagen);
  assert.equal(modelVan(doc2, refs, 'groepTekst').groupPath[0].name, 'Zone 9');
});

test('a group made in OcuDraw is written as the external editor writes one and reopens with name and dominant', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const [a, b, c] = [box(100), box(200), box(300)];
  doc.annotations.push(a, b, c);
  G.groupMarkups(doc.annotations, [b, a, c], { name: 'Feeder A' });
  const opgeslagen = await save(bytes, doc);
  const { ctx, perRef } = await dicts(opgeslagen);
  const nieuw = [...perRef.entries()].filter(([tag, d]) => d.get(N('Subtype'))?.toString() === '/Square' && !Object.values(refs).includes(tag));
  assert.equal(nieuw.length, 3);
  const dominant = nieuw.find(([, d]) => d.get(N('GroupNesting')));
  assert.ok(dominant, 'one dominant with /GroupNesting');
  const gn = dominant[1].lookup(N('GroupNesting'), PDFArray).asArray();
  assert.equal(gn[0].decodeText(), 'Feeder A');
  assert.equal(gn.length, 4, 'name + the NM of each member');
  for (const [tag, d] of nieuw) {
    if (tag === dominant[0]) continue;
    assert.equal(d.get(N('IRT')).tag, dominant[0]);
    assert.equal(d.get(N('RT')).toString(), '/Group');
    assert.ok(ctx.lookup(d.get(N('NM'))), 'a member has an /NM');
  }
  const doc2 = await open(opgeslagen);
  const leden = doc2.annotations.filter((x) => !x.extBron && x.groupId);
  assert.equal(leden.length, 3);
  assert.equal(new Set(leden.map((x) => x.groupId)).size, 1);
  assert.equal(leden[0].groupPath[0].name, 'Feeder A');
  // The dominant is the first selected (b, x = 200).
  const dom = leden.find((x) => x.id === leden[0].groupPath[0].dominant);
  assert.ok(Math.abs(dom.x - 200) < 1, 'the dominant markup round-trips');
  // A second save of the reopened file is stable.
  const doc3 = await open(await save(opgeslagen, doc2));
  assert.equal(doc3.annotations.filter((x) => !x.extBron && x.groupId).length, 3);
});

test('nesting made in OcuDraw round-trips through /OPS_GroupPathV1; the external editor sees one group', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const [a, b] = [box(100), box(200)];
  doc.annotations.push(a, b);
  G.groupMarkups(doc.annotations, [a, b], { name: 'Inner' });
  G.groupMarkups(doc.annotations, [a, modelVan(doc, refs, 'rechthoek')], { name: 'Outer' });
  const opgeslagen = await save(bytes, doc);
  const { perRef } = await dicts(opgeslagen);
  // the external editor's keys: every member points at the one dominant (a).
  const leden = [...perRef.values()].filter((d) => d.get(N('RT'))?.toString() === '/Group');
  assert.equal(leden.length, 3, 'b, the rectangle and the text box point at the dominant');
  assert.equal(new Set(leden.map((d) => d.get(N('IRT')).tag)).size, 1);
  const doc2 = await open(opgeslagen);
  const namen = (x) => G.groupPathOf(x).map((g) => g.name);
  const nieuw = doc2.annotations.filter((x) => !x.extBron);
  assert.deepEqual(nieuw.map(namen), [['Outer', 'Inner'], ['Outer', 'Inner']]);
  assert.deepEqual(namen(modelVan(doc2, refs, 'groepTekst')), ['Outer', 'Group'], 'the external editor group is a subgroup');
});

test('Remove Selected from Group in an external editor group of two dissolves it in the file', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  G.removeFromGroup(doc.annotations, [modelVan(doc, refs, 'groepTekst')]);
  const doc2 = await open(await save(bytes, doc));
  assert.equal(modelVan(doc2, refs, 'rechthoek').groupId, undefined);
  assert.equal(modelVan(doc2, refs, 'groepTekst').groupId, undefined);
});

test('a subject assigned to an external editor markup is written as the external editor\'s /Subj, not as a comment', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  modelVan(doc, refs, 'rechthoek').subject = 'Branch Feed';
  const opgeslagen = await save(bytes, doc);
  const d = (await dicts(opgeslagen)).perRef.get(refs.rechthoek);
  assert.equal(d.lookup(N('Subj')).decodeText(), 'Branch Feed');
  assert.equal(d.get(N('Contents')), undefined);
  const doc2 = await open(opgeslagen);
  assert.equal(modelVan(doc2, refs, 'rechthoek').subject, 'Branch Feed');
});

// Deleting from a group, as the Delete key does: the markup leaves the list.
const verwijder = (doc, ...markups) => {
  const weg = new Set(markups.map((a) => a.id));
  for (let i = doc.annotations.length - 1; i >= 0; i--) if (weg.has(doc.annotations[i].id)) doc.annotations.splice(i, 1);
};
const groepKind = (d) => d.get(N('RT'))?.toString() === '/Group';
const nmVan = (ctx, d) => ctx.lookup(d.get(N('NM')))?.decodeText?.();

// The external editor sheet with a third markup in its group, saved and reopened.
async function groepVanDrie() {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const derde = box(500);
  doc.annotations.push(derde);
  G.addToGroup(doc.annotations, [derde], modelVan(doc, refs, 'rechthoek').groupId);
  const opgeslagen = await save(bytes, doc);
  return { bytes: opgeslagen, refs, doc: await open(opgeslagen) };
}

test('delete the dominant of a group of two: the other markup has no /IRT to a deleted markup', async () => {
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  verwijder(doc, modelVan(doc, refs, 'rechthoek'));
  const opgeslagen = await save(bytes, doc);
  const tekst = (await dicts(opgeslagen)).perRef.get(refs.groepTekst);
  assert.equal(tekst.get(N('IRT')), undefined);
  assert.equal(tekst.get(N('RT')), undefined);
  assert.equal(modelVan(await open(opgeslagen), refs, 'groepTekst').groupId, undefined);
});

test('delete the dominant of a larger group: the next member becomes dominant, with the name', async () => {
  const { bytes, refs, doc } = await groepVanDrie();
  assert.equal(doc.annotations.filter((a) => a.groupId).length, 3);
  verwijder(doc, modelVan(doc, refs, 'rechthoek'));
  const opgeslagen = await save(bytes, doc);
  const { ctx, perRef } = await dicts(opgeslagen);
  assert.equal(perRef.has(refs.rechthoek), false);
  const leden = [...perRef.entries()].filter(([, d]) => d.get(N('GroupNesting')) || groepKind(d));
  assert.equal(leden.length, 2);
  const [domTag, dom] = leden.find(([, d]) => d.get(N('GroupNesting')));
  const gn = dom.lookup(N('GroupNesting'), PDFArray).asArray();
  assert.equal(gn[0].decodeText(), 'Group', 'the name moves to the new dominant');
  assert.equal(gn.length, 3);
  const [, ander] = leden.find(([tag]) => tag !== domTag);
  assert.equal(ander.get(N('IRT')).tag, domTag, 'the other member points at the new dominant');
  assert.ok(gn.slice(1).every((n) => [nmVan(ctx, dom), nmVan(ctx, ander)].includes(n.decodeText())));
  const doc2 = await open(opgeslagen);
  const groep = doc2.annotations.filter((a) => a.groupId);
  assert.equal(groep.length, 2, 'still a group on reopen');
  assert.equal(groep[0].groupPath[0].name, 'Group');
});

test('delete a member: the dominant\'s /GroupNesting lists no deleted /NM', async () => {
  const { bytes, refs, doc } = await groepVanDrie();
  const weg = modelVan(doc, refs, 'groepTekst');
  verwijder(doc, weg);
  const opgeslagen = await save(bytes, doc);
  const { ctx, perRef } = await dicts(opgeslagen);
  const nms = new Set([...perRef.values()].map((d) => nmVan(ctx, d)).filter(Boolean));
  const gn = perRef.get(refs.rechthoek).lookup(N('GroupNesting'), PDFArray).asArray();
  assert.equal(gn.length, 3, 'name + dominant + the one other member');
  for (const n of gn.slice(1)) assert.ok(nms.has(n.decodeText()), `${n.decodeText()} is on the page`);
  assert.equal((await open(opgeslagen)).annotations.filter((a) => a.groupId).length, 2);
});

test('copy one group member (CO / Ctrl+drag): the copy is not in the group, in the app and in the file', async () => {
  const { duplicateTargets } = await import('../tools/edit-ops.js');
  const { bytes, refs } = await bouwExtBlad();
  const doc = await open(bytes);
  const tekst = modelVan(doc, refs, 'groepTekst');
  doc.selectedAnnotations = [tekst];
  doc.selectedAnnotation = tekst;
  const [kopie] = duplicateTargets();
  assert.ok(kopie);
  assert.equal(kopie.groupId, undefined, 'the external editor: a member copied alone is pasted ungrouped');
  assert.equal('groupPath' in kopie, false);
  const doc2 = await open(await save(bytes, doc));
  const groep = doc2.annotations.filter((a) => a.groupId);
  assert.equal(groep.length, 2, 'the original group is unchanged; the copy is loose');
  // A whole group copied is a new group, in the file too.
  const doc3 = await open(bytes);
  doc3.selectedAnnotations = [modelVan(doc3, refs, 'rechthoek'), modelVan(doc3, refs, 'groepTekst')];
  doc3.selectedAnnotation = doc3.selectedAnnotations[0];
  const kopieen = duplicateTargets();
  assert.equal(kopieen.length, 2);
  assert.equal(new Set(kopieen.map((a) => a.groupId)).size, 1);
  assert.notEqual(kopieen[0].groupId, modelVan(doc3, refs, 'rechthoek').groupId);
  const doc4 = await open(await save(bytes, doc3));
  assert.equal(new Set(doc4.annotations.filter((a) => a.groupId).map((a) => a.groupId)).size, 2, 'two groups on reopen');
});

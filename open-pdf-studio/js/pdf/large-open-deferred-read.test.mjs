// A large set defers the pdf-lib read of the whole file until the open window
// of sheets is read (loader.js, _deferSharedPdfLib). A sheet in that window
// whose markups need the read (text boxes, notes, stamps, hyperlinks) waits
// for it: it is not marked ready and holds no markups of the file until it is
// read again with its names, styling and custom fields. A sheet of plain
// hyperlinks does not start the read before the window is read.
//
// The real loader page reads (pdf.js, color extraction, conversion) and the
// real saver on synthetic PDF bytes. The documents are marked large as
// loadPDF marks them.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFArray, PDFString } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url, { data: { real: ['js/pdf/loader.js'] } });
register('./loader-test-hooks.mjs', import.meta.url, { data: { keep: [
  'pdf-lib', './pdf-lib-catalog.js', './loader/color-extraction.js', './loader/convert-page.js',
] } });
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
globalThis.Image ??= class { constructor() { this.src = ''; } };
const { state } = await import('../core/state.js');
const L = await import('./loader.js');
const { savePDF } = await import('./saver.js');
const { createAnnotation } = await import('../annotations/factory.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

// The editor's own code logs each read; keep the test output quiet.
console.log = () => {};

const PAGES = 4; // window of sheet 1: sheets 1 and 2

/** A blank set whose sheets carry plain /URI hyperlinks (`links`: sheet numbers). */
async function plainSet(links) {
  const lib = await PDFDocument.create();
  for (let p = 1; p <= PAGES; p++) {
    const page = lib.addPage([600, 400]);
    if (!links.includes(p)) continue;
    const link = lib.context.register(lib.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [400, 300, 520, 330], Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of(`https://example.com/sheet-${p}`) },
    }));
    page.node.set(PDFName.of('Annots'), lib.context.obj([link]));
  }
  return new Uint8Array(await lib.save());
}

let written = null;
globalThis.__saverTest = { impl: {
  writeBinaryFile: (_p, data) => { written = new Uint8Array(data); return true; },
  writeBinaryFileAtomic: (_p, data) => { written = new Uint8Array(data); return true; },
} };

function editorDoc(filePath, extra) {
  return {
    id: `large-${Math.random()}`, filePath, currentPage: 1, scale: 1, viewMode: 'single', annotations: [],
    pageRotations: {}, textEdits: [], undoStack: [], redoStack: [], savedUndoStackLength: 0, selectedAnnotations: [],
    _annotationLoadId: 0, _loadedAnnotationPages: new Set(), _annotationPagesReady: new Set(),
    _pagesNeedingColorUpdate: new Set(), ...extra,
  };
}

async function save(doc) {
  if (!state.documents.includes(doc)) {
    state.documents = [doc];
    state.activeDocumentIndex = 0;
  }
  written = null;
  assert.equal(await savePDF(doc.filePath, { zonderHandtekeningVraag: true }), true, 'the save succeeded');
  assert.ok(written, 'the saver wrote PDF bytes');
  return written;
}

/** Sheet 1: a text box with styling and a custom field, and an app-made hyperlink. Sheet 2: a plain link. Sheet 4: a text box. */
async function markupSet(filePath) {
  const doc = editorDoc(filePath, { pdfDoc: { numPages: PAGES }, markupTextColumnName: 'Zone' });
  L.setCachedPdfBytes(filePath, await plainSet([2]));
  doc.annotations = [
    createAnnotation({ type: 'textbox', page: 1, x: 40, y: 40, width: 160, height: 50, text: 'NOTE A',
      textColor: '#1144aa', fontSize: 17, subject: 'Coordination', author: 'Reviewer', markupTextValue: 'Zone 4' }),
    createAnnotation({ type: 'hyperlink', page: 1, x: 300, y: 40, width: 80, height: 30, linkUrl: 'https://example.com/a' }),
    createAnnotation({ type: 'textbox', page: 4, x: 40, y: 40, width: 160, height: 50, text: 'NOTE D', textColor: '#aa4411', fontSize: 11 }),
  ];
  for (let p = 1; p <= PAGES; p++) { doc._loadedAnnotationPages.add(p); doc._annotationPagesReady.add(p); }
  return save(doc);
}

/** pdf.js opens `bytes`; `reads` lists each sheet whose annotations were asked for. */
async function openPdfjs(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const reads = [];
  const getPage = pdf.getPage.bind(pdf);
  pdf.getPage = async (p) => {
    const page = await getPage(p);
    if (!page.__counted) {
      const getAnnotations = page.getAnnotations.bind(page);
      page.getAnnotations = (...args) => { reads.push(p); return getAnnotations(...args); };
      page.__counted = true;
    }
    return page;
  };
  return { pdf, reads, close: () => task.destroy() };
}

/** Counts the whole-file pdf-lib parses and what was read when the first started. */
function watchParses(reads) {
  const load = PDFDocument.load;
  const seen = { count: 0, readsAtFirst: null };
  PDFDocument.load = function (...args) {
    seen.count++;
    seen.readsAtFirst ??= [...new Set(reads)].sort((a, b) => a - b);
    return load.apply(this, args);
  };
  return { seen, restore: () => { PDFDocument.load = load; } };
}

/** Each model of `page` without its random model id (and the read time a /Link without a date gets), for comparison. */
function pageModels(doc, page) {
  return doc.annotations.filter((a) => a.page === page).map((a) => {
    const copy = JSON.parse(JSON.stringify(a));
    delete copy.id;
    delete copy.createdAt;
    if (copy.pdfSource) delete copy.pdfSource.modelId;
    return copy;
  }).sort((a, b) => String(a.type).localeCompare(String(b.type)));
}

/** The markups as the loader reads them when the file is not a large set (the full read). */
async function fullRead(bytes, filePath) {
  L.setCachedPdfBytes(filePath, bytes);
  const { pdf, close } = await openPdfjs(bytes);
  state.documents = [editorDoc(filePath, { pdfDoc: pdf })];
  state.activeDocumentIndex = 0;
  const doc = state.documents[0]; // the store's view of it, as the app holds it
  for (let p = 1; p <= PAGES; p++) await L.ensureAnnotationsForPage(p, doc);
  const models = Object.fromEntries([1, 2, 3, 4].map((p) => [p, pageModels(doc, p)]));
  state.documents = [];
  await close();
  return models;
}

/** A large set as loadPDF opens it. `ready` snapshots each page's models when it is marked ready. */
async function openLarge(bytes, filePath) {
  L.setCachedPdfBytes(filePath, bytes);
  const opened = await openPdfjs(bytes);
  state.documents = [editorDoc(filePath, { pdfDoc: opened.pdf, _largeOpen: true, _deferSharedPdfLib: true })];
  state.activeDocumentIndex = 0;
  const doc = state.documents[0];
  const atReady = new Map();
  const add = doc._annotationPagesReady.add.bind(doc._annotationPagesReady);
  doc._annotationPagesReady.add = (p) => { if (!atReady.has(p)) atReady.set(p, pageModels(doc, p)); return add(p); };
  return { doc, atReady, ...opened };
}

/** Per sheet: the /NM, custom text field and app subtype of each markup dictionary. */
async function savedMarkups(bytes) {
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  const text = (d, key) => d.lookup(PDFName.of(key))?.decodeText?.() ?? null;
  return lib.getPages().map((page) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return (annots ? annots.asArray() : []).map((r) => lib.context.lookup(r)).map((d) => ({
      subtype: d.get(PDFName.of('Subtype'))?.toString(),
      nm: text(d, 'NM'), field: text(d, 'OPS_MarkupTextValue'), ops: text(d, 'OPS_Subtype'),
    })).sort((a, b) => a.subtype.localeCompare(b.subtype));
  });
}

test('a large set: a text box and hyperlink sheet in the open window keeps names, styling and fields after load and save', async (t) => {
  const filePath = 'C:/set/large-markups.pdf';
  const bytes = await markupSet(filePath);
  const reference = await fullRead(bytes, filePath);
  // The fixture is sensitive: the full read has the app hyperlink and the custom field.
  assert.deepEqual(reference[1].map((m) => m.type), ['hyperlink', 'textbox']);
  assert.equal(reference[1][1].markupTextValue, 'Zone 4');
  assert.equal(reference[1][1].textColor, '#1144aa');
  assert.ok(reference[1][1].nm, 'the text box keeps its /NM');

  const { doc, atReady, reads, close } = await openLarge(bytes, filePath);
  t.after(async () => { state.documents = []; await close(); });
  const parses = watchParses(reads);
  try {
    await L.loadExistingAnnotations(doc);
  } finally {
    parses.restore();
  }
  assert.deepEqual([...doc._annotationPagesReady].sort(), [1, 2], 'the open window is ready');
  assert.equal(doc._pagesNeedingColorUpdate.size, 0, 'no sheet waits for markup data');
  assert.deepEqual(pageModels(doc, 1), reference[1], 'sheet 1 as the full read has it');
  assert.deepEqual(atReady.get(1), reference[1], 'sheet 1 was never ready with markups that lacked their data');
  assert.equal(parses.seen.count, 1, 'one pdf-lib parse, after the open window');
  assert.deepEqual(parses.seen.readsAtFirst, [1, 2], 'the parse started after the open window was read');

  // A sheet outside the window loads with its data when shown.
  await L.ensureAnnotationsForPage(4, doc);
  assert.deepEqual(pageModels(doc, 4), reference[4]);

  const saved = await save(doc);
  const before = await savedMarkups(bytes);
  const after = await savedMarkups(saved);
  assert.deepEqual(after, before, 'the saved file has the same names, fields and app hyperlink');
  // A save writes the markups as new objects (and a hyperlink anew): compare without those.
  const content = (pages) => JSON.parse(JSON.stringify(pages, (k, v) => (k === 'pdfSource' || k === 'modifiedAt' ? undefined : v)));
  assert.deepEqual(content(await fullRead(saved, 'C:/set/large-markups-saved.pdf')), content(reference), 'and reads back the same');
});

test('a large set: the renderer leaves a sheet waiting for the pdf-lib read; any other caller reads it complete', async (t) => {
  const filePath = 'C:/set/large-waiting.pdf';
  const bytes = await markupSet(filePath);
  const { doc, reads, close } = await openLarge(bytes, filePath);
  t.after(async () => { state.documents = []; await close(); });
  const parses = watchParses(reads);
  try {
    await L.ensureAnnotationsForPage(1, doc, { mayDefer: true });
    assert.equal(parses.seen.count, 0, 'no parse for the sheet on screen');
  } finally {
    parses.restore();
  }
  assert.equal(doc._annotationPagesReady.has(1), false, 'sheet 1 is not ready');
  assert.equal(doc._pagesNeedingColorUpdate.has(1), true, 'sheet 1 waits for the pdf-lib read');
  assert.equal(doc.annotations.length, 0, 'no markup without its data entered the model');
  // Asked again by the renderer while the read is deferred: still waiting, not read stripped.
  await L.ensureAnnotationsForPage(1, doc, { mayDefer: true });
  assert.equal(doc.annotations.length, 0);

  // A caller that reads the page to change it (crash recovery, search, a
  // plug-in) releases the read and gets the sheet complete, once.
  await L.ensureAnnotationsForPage(1, doc);
  assert.equal(doc._deferSharedPdfLib, false, 'the deferred read was released');
  assert.equal(doc._annotationPagesReady.has(1), true);
  const reference = await fullRead(bytes, 'C:/set/large-waiting-ref.pdf');
  assert.deepEqual(pageModels(doc, 1), reference[1]);
  // The window read afterwards does not read it a second time.
  await L.loadExistingAnnotations(doc);
  assert.deepEqual(pageModels(doc, 1), reference[1], 'no doubled markups');
});


test('a large set of plain sheet hyperlinks reads its open window before any pdf-lib parse', async (t) => {
  const filePath = 'C:/set/large-links.pdf';
  const bytes = await plainSet([1, 2, 3, 4]);
  const { doc, atReady, reads, close } = await openLarge(bytes, filePath);
  t.after(async () => { state.documents = []; await close(); });
  const parses = watchParses(reads);
  try {
    await L.loadExistingAnnotations(doc);
  } finally {
    parses.restore();
  }
  assert.deepEqual(parses.seen.readsAtFirst, [1, 2], 'the first parse started after sheets 1 and 2 were read');
  assert.equal(parses.seen.count, 1);
  assert.deepEqual([...doc._annotationPagesReady].sort(), [1, 2]);
  assert.equal(doc.annotations.length, 0, 'plain hyperlinks are not markups');
  assert.deepEqual(atReady.get(1), []);
  assert.equal(reads.includes(3), false, 'sheets outside the window are not read');
});

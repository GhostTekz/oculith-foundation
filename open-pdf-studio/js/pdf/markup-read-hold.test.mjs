// A save holds the markup reads of its document (markup-read-hold.js): a page
// whose markups are read from the file while the save runs adds them after
// the save, instead of failing it with "The document changed while saving".
// Real load conversion (pdf.js + convert-page.js) and the real saver on
// synthetic PDF bytes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { PDFDocument, PDFName, PDFArray, PDFString } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
globalThis.Image ??= class { constructor() { this.src = ''; } };
const { state } = await import('../core/state.js');
const { savePDF } = await import('./saver.js');
const { convertAndPushAnnotations } = await import('./loader/convert-page.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { holdMarkupReads, markupReadsHeld, markupReadsReleased } = await import('./markup-read-hold.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Two pages, two square markups each, named p<page><a|b>. */
async function drawing() {
  const lib = await PDFDocument.create();
  for (let p = 1; p <= 2; p++) {
    const page = lib.addPage([300, 300]);
    const refs = ['a', 'b'].map((s, i) => lib.context.register(lib.context.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [20 + i * 60, 20, 60 + i * 60, 60], C: [1, 0, 0], Border: [0, 0, 1],
      NM: PDFString.of(`p${p}${s}`),
    })));
    page.node.set(PDFName.of('Annots'), lib.context.obj(refs));
  }
  return new Uint8Array(await lib.save());
}

/** Each page's pdf.js annotations, viewport and pdf-lib extras (colours, names). */
async function pdfjsPages(bytes) {
  const lib = await PDFDocument.load(bytes.slice());
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdf = await task.promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    pages.push({ annots: await page.getAnnotations(), viewport: page.getViewport({ scale: 1 }), colors: await extractAnnotationColors(p, lib) });
  }
  await task.destroy();
  return pages;
}

/** Page -> markup names in saved bytes. */
async function namesByPage(bytes) {
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  return lib.getPages().map((page) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return (annots ? annots.asArray() : []).map((r) => lib.context.lookup(r))
      .filter((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Square')
      .map((d) => d.lookup(PDFName.of('NM')).decodeText()).sort();
  });
}

test('holds nest: reads wait until every hold of the document is released', async () => {
  const doc = {};
  assert.equal(markupReadsHeld(doc), false);
  const a = holdMarkupReads(doc);
  const b = holdMarkupReads(doc);
  let released = false;
  const waiting = markupReadsReleased(doc).then(() => { released = true; });
  a();
  await tick();
  assert.equal(released, false, 'one hold left');
  a(); // twice is harmless
  b();
  await waiting;
  assert.equal(released, true);
  assert.equal(markupReadsHeld(doc), false);
  assert.equal(markupReadsHeld({}), false, 'another document is never held');
});

test('a page conversion waits for the hold; stillCurrent false pushes nothing; beforePush runs before the push', async () => {
  const [page1] = await pdfjsPages(await drawing());
  const doc = { id: 'held', annotations: [], pageRotations: {} };
  const release = holdMarkupReads(doc);
  const order = [];
  const pushing = convertAndPushAnnotations(page1.annots, 1, page1.viewport, new Map(), page1.colors, doc, {
    beforePush: () => order.push(`before:${doc.annotations.length}`),
  });
  await tick(20);
  assert.equal(doc.annotations.length, 0, 'nothing enters the model while held');
  release();
  const pushed = await pushing;
  assert.deepEqual(order, ['before:0']);
  assert.deepEqual(pushed.map((a) => a.nm).sort(), ['p1a', 'p1b']);
  assert.equal(doc.annotations.length, 2);

  const stale = await convertAndPushAnnotations(page1.annots, 1, page1.viewport, new Map(), page1.colors, doc, {
    stillCurrent: () => false, beforePush: () => order.push('stale'),
  });
  assert.equal(stale, null);
  assert.equal(doc.annotations.length, 2, 'a cancelled read adds nothing');
  assert.deepEqual(order, ['before:0']);
});

test('a page read landing while a save runs: the save succeeds, the page keeps its markups once', async () => {
  const bytes = await drawing();
  const [page1, page2] = await pdfjsPages(bytes);
  const doc = {
    id: 'lazy', filePath: 'C:/lazy/in.pdf', currentPage: 1, annotations: [], pdfDoc: { numPages: 2 },
    pageRotations: {}, textEdits: [], _loadedAnnotationPages: new Set([1]), _annotationPagesReady: new Set([1]),
  };
  await convertAndPushAnnotations(page1.annots, 1, page1.viewport, new Map(), page1.colors, doc);
  // Page 2 is read (as ensureAnnotationsForPage does) while the save writes.
  let read2 = null;
  let saved = null;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: async (_p, data) => {
      doc._loadedAnnotationPages.add(2);
      read2 = convertAndPushAnnotations(page2.annots, 2, page2.viewport, new Map(), page2.colors, doc)
        .then(() => doc._annotationPagesReady.add(2));
      await tick(30);
      saved = data;
      return true;
    },
  } };
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  let ok;
  try { ok = await savePDF('C:/lazy/out.pdf', { zonderHandtekeningVraag: true }); }
  finally { console.error = consoleError; }
  assert.deepEqual(errors, []);
  assert.equal(ok, true, 'the save is not failed by a read of the file');
  await read2;
  assert.deepEqual(doc.annotations.map((a) => `${a.page}:${a.nm}`).sort(), ['1:p1a', '1:p1b', '2:p2a', '2:p2b']);
  // Page 2 was not read when the save started: the file's markups stay.
  assert.deepEqual(await namesByPage(saved), [['p1a', 'p1b'], ['p2a', 'p2b']]);
});

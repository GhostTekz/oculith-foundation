// A page change while a sheet's markups are being read (loader.js).
//
// A page change destroys the old PDF.js document; a read waiting on it then
// never finishes. Requests for that page number after the change, and a
// whole-document read running across it, must read the new pages instead of
// waiting on that read for ever. The real loader on stub PDF.js documents:
// the old one never answers, the new one answers at once.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./loader-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const L = await import('./loader.js');

const never = () => new Promise(() => {});
// The editor's own code logs each read; keep the test output quiet.
console.log = () => {};

/** A PDF.js document stub. `stuck(p)`: getPage(p) never settles. */
function pdfDoc(numPages, stuck = () => false) {
  const asked = [];
  return {
    numPages, asked,
    getPage(p) {
      asked.push(p);
      if (stuck(p)) return never();
      return Promise.resolve({ pageNumber: p, getViewport: () => ({ width: 100, height: 100 }), getAnnotations: async () => [] });
    },
  };
}

function lazyDoc(pdf) {
  const doc = {
    id: 'doc-page-loads', pdfDoc: pdf, annotations: [], _largeOpen: true,
    _annotationLoadId: 0, _loadedAnnotationPages: new Set(), _annotationPagesReady: new Set(),
    _pagesNeedingColorUpdate: new Set(),
  };
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  return state.documents[0];
}

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms)),
]);

/** What reloadFromBytes does to the loading state and the PDF.js document. */
function changePages(doc, pdf) {
  L.cancelAnnotationLoading(doc);
  doc.pdfDoc = pdf;
}

test('a page asked for after a page change is read from the new pages, not the stuck old read', async (t) => {
  const doc = lazyDoc(pdfDoc(6, () => true));
  t.after(() => { state.documents = []; });
  const old = L.ensureAnnotationsForPage(2, doc);
  await new Promise((r) => setTimeout(r, 0));
  const next = pdfDoc(5);
  changePages(doc, next);

  // The caller of the old read goes on; that read adds nothing.
  await within(old, 1000, 'the read started before the change');
  assert.equal(doc._annotationPagesReady.has(2), false);

  await within(L.ensureAnnotationsForPage(2, doc), 1000, 'page 2 after the change');
  assert.deepEqual(next.asked, [2]);
  assert.equal(doc._annotationPagesReady.has(2), true);

  await within(L.ensureAllAnnotations(doc), 2000, 'ensureAllAnnotations after the change');
  assert.deepEqual([...doc._annotationPagesReady].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('a whole-document read running across a page change finishes on the new pages', async (t) => {
  // The old document answers pages 1 and 2, then hangs on page 3.
  const doc = lazyDoc(pdfDoc(6, (p) => p >= 3));
  t.after(() => { state.documents = []; });
  const all = L.ensureAllAnnotations(doc);
  while (!doc._loadedAnnotationPages.has(3)) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...doc._annotationPagesReady], [1, 2]);

  // A page deleted: the read pages are kept on their new numbers by the page
  // manager (markAnnotationPagesLoaded); here page 1 stays page 1.
  const next = pdfDoc(5);
  changePages(doc, next);
  L.markAnnotationPagesLoaded([1], doc);

  await within(all, 2000, 'ensureAllAnnotations');
  assert.deepEqual([...doc._annotationPagesReady].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual(next.asked.sort((a, b) => a - b), [2, 3, 4, 5], 'each new page read once, none past the end');
});

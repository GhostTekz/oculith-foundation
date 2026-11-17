// The search text cache holds every page's text of a document. It must go
// when the tab closes (the document-closed event) and must not serve the
// text of an earlier PDF.js document for the same tab.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const { performSearch, hasCachedText } = await import('./find-controller.js');
const { documentClosed } = await import('../core/document-lifecycle.js');

class FakePdf {
  constructor(words) { this.words = words; this.numPages = 1; this.reads = 0; }
  async getPage() {
    this.reads++;
    const words = this.words;
    return { view: [0, 0, 600, 800], async getTextContent() {
      return { items: words.map((str, i) => ({ str, transform: [10, 0, 0, 10, 20 + i * 60, 700], width: 50, height: 10 })) };
    } };
  }
}

function open(id, pdfDoc) {
  state.documents = [{ id, pdfDoc, currentPage: 1, annotations: [], textEdits: [] }];
  state.activeDocumentIndex = 0;
  return state.documents[0];
}

test('closing a tab drops its cached search text', async () => {
  const doc = open('search-a', new FakePdf(['alpha', 'beta']));
  assert.equal((await performSearch('beta')).length, 1);
  assert.equal(hasCachedText('search-a'), true);
  state.documents = [];
  documentClosed(doc, state.documents);
  assert.equal(hasCachedText('search-a'), false);
});

test('a reloaded PDF in the same tab is searched again, not served from the old text', async () => {
  const first = new FakePdf(['old']);
  const doc = open('search-b', first);
  assert.equal((await performSearch('old')).length, 1);
  assert.equal((await performSearch('old')).length, 1);
  assert.equal(first.reads, 1, 'the second search used the cache');
  doc.pdfDoc = new FakePdf(['new']);
  assert.equal((await performSearch('old')).length, 0);
  assert.equal((await performSearch('new')).length, 1);
});

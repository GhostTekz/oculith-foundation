// Page text read by the PDFium workers (native-page-text.js): only for a
// drawing PDF.js reads by range from its own file, decoded to PDF.js
// items with PDF.js's normalization, and back to PDF.js when the workers
// cannot serve it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeNativeText, nativePageTextReader, normalizeText } from './native-page-text.js';

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const ranged = () => {
  const pdfDoc = {};
  return { filePath: '/jobs/set.pdf', pdfDoc, _rangeSource: { path: '/jobs/set.pdf', length: 1000 } };
};

test('only a drawing read by range from its own file on the desktop qualifies', () => {
  const invoke = async () => bytes({ items: [], exact: true });
  assert.equal(typeof nativePageTextReader(ranged(), { invoke, desktop: true }), 'function');
  assert.equal(nativePageTextReader(ranged(), { invoke, desktop: false }), null);
  assert.equal(nativePageTextReader({ ...ranged(), _rangeSource: null }, { invoke, desktop: true }), null, 'read from bytes');
  const elsewhere = ranged();
  elsewhere._rangeSource.path = '/jobs/other.pdf';
  assert.equal(nativePageTextReader(elsewhere, { invoke, desktop: true }), null);
});

test('the reader asks for the 0-based page of the open file and its length', async () => {
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args]); return bytes({ items: [{ str: 'E-101', transform: [1, 0, 0, 1, 2, 3], width: 9, height: 1 }], exact: true }); };
  const read = nativePageTextReader(ranged(), { invoke, desktop: true });
  const text = await read(208);
  assert.deepEqual(calls, [['pdf_page_text_native', { path: '/jobs/set.pdf', pageIndex: 207, expectLen: 1000 }]]);
  assert.deepEqual(text.items, [{ str: 'E-101', transform: [1, 0, 0, 1, 2, 3], width: 9, height: 1, dir: 'ltr', hasEOL: false }]);
});

test('PDF.js normalization applies to the worker text', () => {
  assert.equal(normalizeText('ﬁxture A'), 'fixture A');
  assert.equal(normalizeText('ﬅ'), 'ſt');
  assert.equal(normalizeText('LP-1 #3'), 'LP-1 #3');
  assert.deepEqual(decodeNativeText(bytes({ items: [{ str: 'ﬂow', transform: [], width: 0, height: 0 }], exact: true })).items[0].str, 'flow');
  assert.throws(() => decodeNativeText(bytes({})), /without items/);
});

test('a page the worker reads only inexactly is read by PDF.js, the next one by the worker again', async () => {
  let n = 0;
  const invoke = async () => { n += 1; return bytes({ items: [{ str: 'X', transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 }], exact: n !== 1 }); };
  const read = nativePageTextReader(ranged(), { invoke, desktop: true });
  assert.equal(await read(1), null, 'text drawn twice: PDF.js reads both copies');
  assert.equal((await read(2)).items[0].str, 'X');
  assert.equal(decodeNativeText(bytes({ items: [] })), null, 'an older worker that does not say');
});

test('a page the worker cannot read falls back alone; workers that cannot serve the file stop the reader', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    let n = 0;
    const pageError = async () => { n += 1; if (n === 1) throw new Error('page text: page 4: bad object'); return bytes({ items: [], exact: true }); };
    const read = nativePageTextReader(ranged(), { invoke: pageError, desktop: true });
    assert.equal(await read(5), null);
    assert.deepEqual(await read(6), { items: [] });
    let calls = 0;
    const mismatch = async () => { calls += 1; throw new Error('page text: the file on disk is not the drawing that is open'); };
    const stopped = nativePageTextReader(ranged(), { invoke: mismatch, desktop: true });
    assert.equal(await stopped(1), null);
    assert.equal(await stopped(2), null);
    assert.equal(calls, 1, 'not asked again after the workers refused the file');
  } finally { console.warn = warn; }
});

test('a document replaced after the reader was made is read by PDF.js', async () => {
  const doc = ranged();
  const read = nativePageTextReader(doc, { invoke: async () => bytes({ items: [], exact: true }), desktop: true });
  doc.pdfDoc = {};
  assert.equal(await read(1), null);
});

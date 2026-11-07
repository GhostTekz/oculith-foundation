// Bookmarks read from an outline keep their depth-first ids and order while
// the destinations resolve concurrently, each name and page only once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBookmarksFromPdf } from './outline-bookmarks.js';

function fakePdf(outline, { delay = 1 } = {}) {
  const calls = { dest: 0, page: 0, inFlight: 0, maxInFlight: 0 };
  const later = async (v) => {
    calls.inFlight++;
    calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
    await new Promise((r) => setTimeout(r, delay));
    calls.inFlight--;
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    calls,
    getOutline: async () => outline,
    getDestination: (name) => { calls.dest++; return later(name === 'missing' ? null : [{ num: 10 + Number(name.slice(1)), gen: 0 }, { name: 'XYZ' }, 36, 700]); },
    getPageIndex: (ref) => { calls.page++; return later(ref.num === 99 ? new Error('bad ref') : ref.num - 10); },
  };
}

test('outline bookmarks: order, ids, pages and coordinates', async () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ title: `S${i}`, dest: `p${i % 5}`, items: [] }));
  items[0].items = [{ title: 'child', dest: [{ num: 12, gen: 0 }, { name: 'Fit' }], items: [] }];
  items[1].dest = 'missing';
  items[2].dest = [{ num: 99, gen: 0 }];
  items[3].dest = null;
  items[4].color = [1, 0, 0.5];
  const pdf = fakePdf(items);
  const bms = await loadBookmarksFromPdf(pdf);
  assert.equal(bms.length, 41);
  assert.deepEqual(bms.slice(0, 3).map((b) => [b.id, b.title, b.parentId]), [['bm_1', 'S0', null], ['bm_2', 'child', 'bm_1'], ['bm_3', 'S1', null]]);
  assert.deepEqual([bms[0].page, bms[0].left, bms[0].top], [1, 36, 700]);
  assert.deepEqual([bms[1].page, bms[1].left, bms[1].top], [3, null, null]);
  assert.equal(bms[2].page, 1, 'unresolved name falls back to page 1');
  assert.equal(bms[3].page, 1, 'a bad page reference falls back to page 1');
  assert.equal(bms[4].page, 1, 'no destination');
  assert.equal(bms[5].color, '#ff0080');
  assert.equal(bms[40].page, 5, 'S39 -> p4');
  assert.equal(pdf.calls.dest, 6, 'each named destination resolved once (p0-p4 and missing)');
  assert.ok(pdf.calls.page <= 7, `each page reference resolved once (${pdf.calls.page})`);
  assert.ok(pdf.calls.maxInFlight > 1 && pdf.calls.maxInFlight <= 16, `bounded concurrency (${pdf.calls.maxInFlight})`);
  assert.deepEqual(bms.map((b) => b.sortOrder).slice(0, 4), [0, 0, 1, 2]);
});

test('no outline gives no bookmarks', async () => {
  assert.deepEqual(await loadBookmarksFromPdf(null), []);
  assert.deepEqual(await loadBookmarksFromPdf({ getOutline: async () => null }), []);
});

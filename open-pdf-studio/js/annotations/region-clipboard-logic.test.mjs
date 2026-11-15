// Cutting a region of a drawing: which copy pastes, the box a drag spans, and
// where the region lands on the target page (region-clipboard-logic.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { latestCopy, regionFromDrag, intersectWithPage, pastePosition } from './region-clipboard-logic.js';

test('the most recent copy pastes', () => {
  assert.equal(latestCopy({ region: 300, markups: 200, snapshot: 100 }), 'region');
  assert.equal(latestCopy({ region: 100, markups: 200 }), 'markups', 'a markup copy after the region wins');
  assert.equal(latestCopy({ region: 100, markups: 50, snapshot: 150 }), 'snapshot', 'a later snapshot wins');
  assert.equal(latestCopy({ region: 400, markups: 200, snapshot: 300 }), 'region', 'and a later region wins back');
  assert.equal(latestCopy({ region: 100 }), 'region');
  assert.equal(latestCopy({ markups: 100, snapshot: 100, region: 100 }), 'markups', 'a tie keeps the markups');
  assert.equal(latestCopy({ snapshot: 100, region: 100 }), 'snapshot', 'then the snapshot');
  assert.equal(latestCopy({ region: 0, markups: null, snapshot: undefined }), null, 'nothing copied');
  assert.equal(latestCopy({ region: Number.NaN, markups: 5 }), 'markups');
  assert.equal(latestCopy(), null);
});

test('a drag spans a region in any direction; a click or a line does not', () => {
  assert.deepEqual(regionFromDrag({ x: 260, y: 200 }, { x: 100, y: 80 }), { x: 100, y: 80, width: 160, height: 120 });
  assert.deepEqual(regionFromDrag({ x: 100, y: 200 }, { x: 260, y: 80 }), { x: 100, y: 80, width: 160, height: 120 });
  assert.equal(regionFromDrag({ x: 10, y: 10 }, { x: 10.5, y: 10.5 }), null, 'a click');
  assert.equal(regionFromDrag({ x: 10, y: 10 }, { x: 200, y: 10.2 }), null, 'a line');
  assert.equal(regionFromDrag({ x: 10, y: 10 }, { x: 14, y: 14 }, 5), null, 'below the minimum size');
  assert.deepEqual(regionFromDrag({ x: 10, y: 10 }, { x: 16, y: 16 }, 5), { x: 10, y: 10, width: 6, height: 6 });
  assert.equal(regionFromDrag({ x: Number.NaN, y: 0 }, { x: 10, y: 10 }), null);
  assert.equal(regionFromDrag(null, { x: 10, y: 10 }), null);
});

test('a region drawn past the page edge keeps only the part on the page', () => {
  const page = { width: 600, height: 400 };
  assert.deepEqual(intersectWithPage({ x: 100, y: 80, width: 160, height: 120 }, page), { x: 100, y: 80, width: 160, height: 120 });
  assert.deepEqual(intersectWithPage({ x: -20, y: 350, width: 100, height: 100 }, page), { x: 0, y: 350, width: 80, height: 50 });
  assert.equal(intersectWithPage({ x: 700, y: 10, width: 50, height: 50 }, page), null, 'entirely off the page');
  assert.deepEqual(intersectWithPage({ x: 5, y: 5, width: 10, height: 10 }, null), { x: 5, y: 5, width: 10, height: 10 }, 'unknown page size');
});

test('a pasted region lands where it was taken, moved onto a smaller page', () => {
  const size = { width: 160, height: 120 };
  assert.deepEqual(pastePosition({ x: 100, y: 80 }, size, { width: 800, height: 600 }), { x: 100, y: 80 }, 'same spot');
  assert.deepEqual(pastePosition({ x: 500, y: 350 }, size, { width: 600, height: 400 }), { x: 440, y: 280 }, 'kept on the page');
  assert.deepEqual(pastePosition({ x: 100, y: 80 }, { width: 900, height: 700 }, { width: 600, height: 400 }), { x: 0, y: 0 }, 'larger than the page: top-left');
  assert.deepEqual(pastePosition({ x: 500, y: 350 }, size, null), { x: 500, y: 350 }, 'no page size: as taken');
  assert.deepEqual(pastePosition({}, size, { width: 600, height: 400 }), { x: 0, y: 0 });
});

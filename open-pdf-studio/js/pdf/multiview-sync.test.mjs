// MultiView Sync math (docs/reference/editor/workspace.md): Synchronize Document matches the
// page number, Synchronize Page keeps the page offset; zoom follows and pan
// maps the viewport centre onto the other split's content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncedPage, pageOffsetFor, mapScroll, contentSize, syncView } from './multiview-sync.js';

test('Synchronize Document: same page number, clamped to the other document', () => {
  assert.equal(syncedPage({ mode: 'document', sourcePage: 2, targetPageCount: 3 }), 2);
  assert.equal(syncedPage({ mode: 'document', sourcePage: 7, targetPageCount: 3 }), 3);
  assert.equal(syncedPage({ mode: 'document', sourcePage: 0, targetPageCount: 3 }), 1);
  assert.equal(syncedPage({ mode: 'document', sourcePage: 2, pageOffset: 5, targetPageCount: 9 }), 2, 'offset ignored');
});

test('Synchronize Page: keeps the page offset in both directions', () => {
  const offset = pageOffsetFor(1, 2); // pane 0 on 1, pane 1 on 2
  assert.equal(offset, 1);
  assert.equal(syncedPage({ mode: 'page', sourcePage: 2, sourcePane: 0, pageOffset: offset, targetPageCount: 3 }), 3);
  assert.equal(syncedPage({ mode: 'page', sourcePage: 3, sourcePane: 1, pageOffset: offset, targetPageCount: 3 }), 2);
  assert.equal(syncedPage({ mode: 'page', sourcePage: 3, sourcePane: 0, pageOffset: offset, targetPageCount: 3 }), 3, 'clamped');
  assert.equal(syncedPage({ mode: 'page', sourcePage: 1, sourcePane: 1, pageOffset: offset, targetPageCount: 3 }), 1, 'clamped low');
  assert.equal(pageOffsetFor(3, 1), -2);
  assert.equal(pageOffsetFor(undefined, 2), 1);
});

test('pan: the viewport centre lands on the same fraction of the content', () => {
  const src = { scrollLeft: 400, scrollTop: 100, clientWidth: 600, clientHeight: 400, scrollWidth: 2000, scrollHeight: 1200 };
  // Same size: same scroll.
  assert.deepEqual(mapScroll(src, { clientWidth: 600, clientHeight: 400, scrollWidth: 2000, scrollHeight: 1200 }),
    { scrollLeft: 400, scrollTop: 100 });
  // Narrower split, same content: the centre (700, 300) stays the centre.
  assert.deepEqual(mapScroll(src, { clientWidth: 300, clientHeight: 400, scrollWidth: 2000, scrollHeight: 1200 }),
    { scrollLeft: 550, scrollTop: 100 });
  // Content half the size (other page smaller): the fraction is kept.
  assert.deepEqual(mapScroll(src, { clientWidth: 600, clientHeight: 400, scrollWidth: 1000, scrollHeight: 600 }),
    { scrollLeft: 50, scrollTop: 0 });
  // Clamped to the scroll range; no content means no scroll.
  assert.deepEqual(mapScroll({ ...src, scrollLeft: 1400 }, { clientWidth: 600, clientHeight: 400, scrollWidth: 2000, scrollHeight: 1200 }).scrollLeft, 1400);
  assert.deepEqual(mapScroll(src, { clientWidth: 600, clientHeight: 400, scrollWidth: 0, scrollHeight: 0 }), { scrollLeft: 0, scrollTop: 0 });
});

test('content size of a page at a zoom', () => {
  assert.deepEqual(contentSize(1224, 792, 0.5), { width: 612, height: 396 });
  assert.deepEqual(contentSize(612, 792, 2, 10), { width: 1244, height: 1604 });
});

test('syncView: page, zoom and (when both boxes are known) pan', () => {
  const box = { scrollLeft: 0, scrollTop: 300, clientWidth: 500, clientHeight: 500, scrollWidth: 1000, scrollHeight: 1100 };
  const v = syncView({ mode: 'document', source: { page: 2, scale: 1.25, box }, target: { pageCount: 3, box: { ...box, scrollTop: 0 } } });
  assert.deepEqual(v, { page: 2, scale: 1.25, scrollLeft: 0, scrollTop: 300 });
  // Continuous live view: no box, so only page and zoom.
  assert.deepEqual(syncView({ mode: 'page', sourcePane: 0, pageOffset: 1, source: { page: 1, scale: 2, box: null }, target: { pageCount: 3, box } }),
    { page: 2, scale: 2 });
});

test('passive split markups: page space → screen on a cropped, rotated sheet (real PDF.js viewports)', async () => {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const pdfjsLib = await import('pdfjs-dist');
  const { annotationToScreen, applyMatrix } = await import('./multiview-sync.js');
  const doc = await PDFDocument.create();
  const p = doc.addPage([600, 400]);
  p.setCropBox(50, 60, 450, 240);
  p.setRotation(degrees(90));
  const bytes = await doc.save();
  const task = pdfjsLib.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const rotation = page.rotate; // 90, plus no document page rotation
  const base = page.getViewport({ scale: 1, rotation });
  assert.deepEqual([Math.round(base.width), Math.round(base.height)], [240, 450]);
  const near = (pt, x, y) => { assert.ok(Math.abs(pt.x - x) < 1e-6 && Math.abs(pt.y - y) < 1e-6, `${JSON.stringify(pt)} ≠ (${x}, ${y})`); };

  // No view rotation: a plain zoom, whatever the CropBox origin and /Rotate.
  const m = annotationToScreen(base, page.getViewport({ scale: 2, rotation }));
  m.forEach((v, i) => assert.ok(Math.abs(v - [2, 0, 0, 2, 0, 0][i]) < 1e-9, `m[${i}] = ${v}`));

  // View rotated 90° clockwise: top-left → top-right, top-right → bottom-right.
  const screen = page.getViewport({ scale: 0.5, rotation: (rotation + 90) % 360 });
  const r = annotationToScreen(base, screen);
  near(applyMatrix(r, 0, 0), screen.width, 0);
  near(applyMatrix(r, 240, 0), screen.width, screen.height);
  near(applyMatrix(r, 240, 450), 0, screen.height);
  await task.destroy();
});

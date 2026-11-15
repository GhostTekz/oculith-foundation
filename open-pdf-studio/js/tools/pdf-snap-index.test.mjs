// PDF vector snap index: one R-tree item per edge. A long edge far from the
// cursor stays out, a short edge at the cursor is returned once. Each edge
// read from a page carries its pen (colour and dash).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const {
  pdfSnapIndex, pdfSnapIndexInSlices, searchPdfSnapIndex, getPdfSnapPointsNear, getPdfEdgeSegmentsNear, extractPageGeometry,
} = await import('./pdf-snap-extractor.js');

test('a long edge across y=0 is absent at y=500; the short edge is present once', () => {
  const longEdge = { x1: 0, y1: 0, x2: 4000, y2: 0 };
  const shortEdge = { x1: 10, y1: 500, x2: 30, y2: 500 };
  const points = [{ x: 20, y: 500, type: 'endpoint' }, { x: 100, y: 0, type: 'endpoint' }];
  const index = pdfSnapIndex(points, [longEdge, shortEdge]);
  const hit = searchPdfSnapIndex(index, 20, 500, 12);
  assert.equal(hit.edges.includes(longEdge), false);
  assert.equal(hit.edges.filter((e) => e === shortEdge).length, 1);
  assert.equal(hit.points.filter((p) => p === points[0]).length, 1);
  assert.equal(hit.points.includes(points[1]), false);
  assert.equal(Object.hasOwn(shortEdge, 'minX'), false);
  assert.equal(Object.hasOwn(points[0], 'minX'), false);

  const wide = searchPdfSnapIndex(index, 20, 500, 80);
  assert.equal(wide.edges.filter((e) => e === shortEdge).length, 1);
});

test('a sliced index returns the same points and edges as one load', async () => {
  const points = [];
  const edges = [];
  for (let i = 0; i < 20000; i++) {
    const x = (i * 17) % 3000;
    const y = (i * 13) % 2000;
    points.push({ id: i, x, y, type: 'endpoint' });
    edges.push({ id: i, x1: x, y1: y, x2: x + (i % 40), y2: y + (i % 7) });
  }
  const once = pdfSnapIndex(points, edges);
  const sliced = await pdfSnapIndexInSlices(points, edges);
  const ids = (list) => list.map((item) => item.id).sort((a, b) => a - b);
  for (const [x, y, radius] of [[10, 10, 12], [1500, 900, 30], [2990, 1990, 80], [0, 0, 1]]) {
    const a = searchPdfSnapIndex(once, x, y, radius);
    const b = searchPdfSnapIndex(sliced, x, y, radius);
    assert.deepEqual(ids(b.points), ids(a.points));
    assert.deepEqual(ids(b.edges), ids(a.edges));
  }
});

test('an uncached page returns no snap points or edges', () => {
  assert.deepEqual(getPdfSnapPointsNear(9, 0, 0, 12), []);
  assert.deepEqual(getPdfEdgeSegmentsNear(9, 0, 0, 12), []);
});

test('each edge carries its pen: the colour it was painted in and its dash pattern in page points', async () => {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const { state } = await import('../core/state.js');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  page.drawLine({ start: { x: 10, y: 150 }, end: { x: 190, y: 150 }, thickness: 1.5, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 10, y: 100 }, end: { x: 190, y: 100 }, thickness: 1.5, color: rgb(0.8, 0, 0) });
  page.drawLine({ start: { x: 10, y: 50 }, end: { x: 190, y: 50 }, thickness: 1.5, color: rgb(0, 0, 0), dashArray: [6, 3] });
  const bytes = await pdf.save();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const pdfDoc = await task.promise;
  try {
    state.documents = [{ id: 'pen-test', filePath: null, pdfDoc, currentPage: 1, annotations: [], pageRotations: {}, textEdits: [] }];
    state.activeDocumentIndex = 0;
    const { edges } = await extractPageGeometry(1, { document: state.documents[0], edgesOnly: true });
    const at = (y) => edges.find((e) => Math.abs(e.y1 - y) < 0.5 && Math.abs(e.y2 - y) < 0.5 && Math.abs(e.x2 - e.x1) > 100);
    assert.deepEqual([at(50)?.c, at(50)?.d], ['#000000', '']);
    assert.deepEqual([at(100)?.c, at(100)?.d], ['#cc0000', '']);
    assert.deepEqual([at(150)?.c, at(150)?.d], ['#000000', '6,3']);
  } finally {
    state.documents = [];
    await task.destroy();
  }
});

test('the line work read through a reader of the file: its edges, with the document\'s rotation', async () => {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const { state } = await import('../core/state.js');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const drawn = await PDFDocument.create();
  drawn.addPage([200, 200]).drawLine({ start: { x: 10, y: 150 }, end: { x: 190, y: 150 }, thickness: 1, color: rgb(0, 0, 0) });
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  const open = async (pdf, extra = {}) => pdfjs.getDocument({ data: (await pdf.save()).slice(), isEvalSupported: false, verbosity: 0, ...extra }).promise;
  const shown = await open(blank); // what the document itself would read: nothing
  const reader = await open(drawn, { disableFontFace: true });
  try {
    state.documents = [{ id: 'reader-test', filePath: null, pdfDoc: shown, currentPage: 1, annotations: [], pageRotations: { 1: 90 }, textEdits: [] }];
    state.activeDocumentIndex = 0;
    const doc = state.documents[0];
    const own = await extractPageGeometry(1, { document: doc, edgesOnly: true });
    assert.equal(own.edges.length, 0);
    const { edges } = await extractPageGeometry(1, { document: doc, reader, edgesOnly: true });
    assert.equal(edges.length, 1);
    // The document's rotation (90°): the horizontal line runs down the page.
    assert.ok(Math.abs(edges[0].x1 - edges[0].x2) < 0.01 && Math.abs(edges[0].y1 - edges[0].y2) > 170);
  } finally {
    state.documents = [];
    await shown.loadingTask.destroy();
    await reader.loadingTask.destroy();
  }
});

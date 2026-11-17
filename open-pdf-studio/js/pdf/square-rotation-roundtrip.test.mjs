import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { degrees, PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { renderPagePng } from '../../scripts/pdfium-page-png.mjs';
import { createCompareChangeReportModel } from '../compare/change-report.js';
import { buildRevisionMarkupPdf } from '../compare/revision-markup-pdf.js';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();

const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF } = await import('./saver.js');
const { convertPdfAnnotation } = await import('./loader/annotation-converter.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

async function save(bytes, annotations) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFileAtomic: (_path, data) => { saved = data; return true; },
  } };
  state.documents = [{ id: 'square-rotation', filePath: 'C:/square/input.pdf', pdfDoc: {},
    annotations, pageRotations: {}, _annotationPagesReady: new Set([1]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  assert.equal(await savePDF('C:/square/output.pdf', { zonderHandtekeningVraag: true }), true);
  assert.ok(saved, 'the saver wrote PDF bytes');
  return saved;
}

async function reopen(bytes) {
  const lib = await PDFDocument.load(bytes.slice());
  const colors = await extractAnnotationColors(1, lib);
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const reader = await task.promise;
  try {
    const page = await reader.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const raw = (await page.getAnnotations()).find(a => a.subtype === 'Square');
    assert.ok(raw, 'native Square annotation exists');
    const model = await convertPdfAnnotation(raw, 1, viewport, new Map(), colors);
    return { model, raw, viewport };
  } finally {
    await task.destroy();
  }
}

async function greenBounds(bytes) {
  const { data, info } = await sharp(await renderPagePng(bytes, { dpi: 72, annotations: true }))
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 3;
        const [red, green, blue] = data.subarray(i, i + 3);
        if (red < 140 && green > red * 1.4 && green > blue * 1.15) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
          count++;
        }
      }
    }
    assert.ok(count > 100, `expected visible green border, got ${count} pixels`);
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function closeRect(actual, expected, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 0.01,
      `${label}.${key}: expected ${expected[key]}, got ${actual[key]}`);
  }
}

for (const rotation of [90, 270]) {
  test(`Square stays in place after two saves on cropped /Rotate ${rotation} page`, async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([600, 800]);
    page.setCropBox(100, 150, 360, 260);
    page.setRotation(degrees(rotation));
    const original = createAnnotation({ type: 'box', page: 1, x: 36, y: 82,
      width: 112, height: 61, color: '#275ca1', strokeColor: '#275ca1',
      fillColor: '#b8d6f4', lineWidth: 2 });
    const firstBytes = await save(await source.save(), [original]);
    const first = await reopen(firstBytes);
    assert.equal(first.model.type, 'box');
    closeRect(first.model, original, 'first reopen');
    const expectedCorners = [
      first.viewport.convertToPdfPoint(original.x, original.y),
      first.viewport.convertToPdfPoint(original.x + original.width, original.y + original.height),
    ];
    const expectedRect = [
      Math.min(expectedCorners[0][0], expectedCorners[1][0]),
      Math.min(expectedCorners[0][1], expectedCorners[1][1]),
      Math.max(expectedCorners[0][0], expectedCorners[1][0]),
      Math.max(expectedCorners[0][1], expectedCorners[1][1]),
    ];
    first.raw.rect.forEach((value, i) => assert.ok(Math.abs(value - expectedRect[i]) < 0.01,
      `PDF /Rect[${i}]: expected ${expectedRect[i]}, got ${value}`));
    const second = await reopen(await save(firstBytes, [first.model]));
    closeRect(second.model, original, 'second reopen');
  });
}

for (const rotation of [90, 270]) {
  test(`a compare-exported Square keeps its visual region after OcuDraw save at /Rotate ${rotation}`, async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([600, 800]);
    page.setCropBox(40, 60, 400, 500);
    page.setRotation(degrees(rotation));
    const sourceBytes = await source.save();
    const task = pdfjs.getDocument({ data: sourceBytes.slice(), isEvalSupported: false, verbosity: 0 });
    let exported;
    try {
      const reader = await task.promise;
      const pdfPage = await reader.getPage(1);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const corners = [viewport.convertToViewportPoint(90, 120), viewport.convertToViewportPoint(180, 210)];
      const change = { type: 'added', x: Math.min(corners[0][0], corners[1][0]),
        y: Math.min(corners[0][1], corners[1][1]),
        width: Math.abs(corners[0][0] - corners[1][0]), height: Math.abs(corners[0][1] - corners[1][1]), detectScale: 1 };
      const report = createCompareChangeReportModel({ oldPath: '/plans/old.pdf', newPath: '/plans/new.pdf',
        oldPage: 1, newPage: 1, pairing: { source: 'manual', oldPage: 1, newPage: 1 },
        offset: { dx: 0, dy: 0, rotation: 0 }, changes: [change] });
      exported = await buildRevisionMarkupPdf({ newBytes: sourceBytes, report, change: report.changes[0],
        pdfPage, targetPath: report.newPath, markupId: 'comparison-square' });
    } finally {
      await task.destroy();
    }

    const loaded = await reopen(exported.bytes);
    assert.equal(loaded.model.type, 'box');
    const before = await greenBounds(exported.bytes);
    const savedBytes = await save(exported.bytes, [loaded.model]);
    const after = await reopen(savedBytes);
    closeRect(after.model, loaded.model, 'saved comparison markup');
    assert.match(after.model.subject, /UNREVIEWED OcuDraw comparison difference/u);
    after.raw.rect.forEach((value, i) => assert.ok(Math.abs(value - exported.region.pdfRect[i]) < 0.01,
      `saved /Rect[${i}]: expected ${exported.region.pdfRect[i]}, got ${value}`));
    if (before) {
      const afterPixels = await greenBounds(savedBytes);
      closeRect(afterPixels, before, 'rendered comparison border');
    }
  });
}

test('a rectangle with a non-integer rotation reopens with the exact angle, twice', async () => {
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  const original = createAnnotation({ type: 'box', page: 1, x: 150, y: 200,
    width: 120, height: 60, rotation: 12.5, color: '#275ca1', strokeColor: '#275ca1', lineWidth: 2 });
  const firstBytes = await save(await source.save(), [original]);
  const first = await reopen(firstBytes);
  assert.equal(first.model.type, 'box');
  assert.ok(Math.abs(first.model.rotation - 12.5) < 1e-6, `rotation ${first.model.rotation}`);
  closeRect(first.model, original, 'first reopen');
  const second = await reopen(await save(firstBytes, [first.model]));
  assert.ok(Math.abs(second.model.rotation - 12.5) < 1e-6, `rotation ${second.model.rotation}`);
  closeRect(second.model, original, 'second reopen');
});

// An in-app page rotation is written as /Rotate by the save. The bytes a
// same-path save writes are the base of the next save, so the rotation must
// not be applied again: rotate, save, edit, save and reopen keeps /Rotate and
// every markup where it was. Real PDF bytes through the real saver, on a
// cropped sheet.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { degrees, PDFDocument } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();

const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF, savePDFAs } = await import('./saver.js');
const { convertPdfAnnotation } = await import('./loader/annotation-converter.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const PATH = 'C:/rotation/sheet.pdf';

async function croppedSheet(nativeRotation = 0) {
  const lib = await PDFDocument.create();
  const page = lib.addPage([600, 800]);
  page.setCropBox(100, 150, 360, 260);
  if (nativeRotation) page.setRotation(degrees(nativeRotation));
  return new Uint8Array(await lib.save());
}

/** A document on `PATH` with a byte cache and file system as the app keeps them. */
function openSheet(bytes, rotation) {
  const files = new Map([[PATH, bytes]]);
  const cache = new Map([[PATH, bytes]]);
  const reloads = [];
  const doc = { id: `rotation-${Math.random()}`, filePath: PATH, pdfDoc: { numPages: 1 }, currentPage: 1,
    annotations: [], pageRotations: { 1: rotation }, _annotationPagesReady: new Set([1]), textEdits: [],
    undoStack: [], redoStack: [], savedUndoStackLength: 0, modified: true };
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: (path) => cache.get(path),
    setCachedPdfBytes: (path, data) => { cache.set(path, data); },
    writeBinaryFileAtomic: (path, data) => { files.set(path, data.slice()); return true; },
    saveFileDialog: async () => 'C:/rotation/copy.pdf',
    bevestigOpslaanMetHandtekeningen: async () => true,
    opslaanAlsStandaardPad: (target) => target.filePath,
    // page-manager.js reloadFromBytes outside the desktop shell: the same path
    // now renders and saves from the new bytes, with the given rotations.
    reloadFromBytes: async (data, annotations, rotations, page, _update, target) => {
      reloads.push({ rotations });
      cache.set(target.filePath, data.slice());
      target.annotations = annotations;
      target.pageRotations = rotations;
      target.currentPage = page;
    },
  } };
  return { doc: state.documents[0], files, reloads };
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
    assert.ok(raw, 'the markup is in the file');
    const model = await convertPdfAnnotation(raw, 1, viewport, new Map(), colors);
    return { model, rotate: lib.getPage(0).getRotation().angle };
  } finally {
    await task.destroy();
  }
}

function near(actual, expected, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 0.01, `${label}.${key}: expected ${expected[key]}, got ${actual[key]}`);
  }
}

for (const native of [0, 270]) {
  test(`rotate 90 on a cropped /Rotate ${native} sheet, save, edit, save: /Rotate ${(native + 90) % 360} and the markup in place`, async () => {
    const { doc, files, reloads } = openSheet(await croppedSheet(native), 90);
    const box = createAnnotation({ type: 'box', page: 1, x: 30, y: 40, width: 50, height: 30,
      color: '#275ca1', strokeColor: '#275ca1', lineWidth: 2 });
    doc.annotations = [box];
    const where = { x: box.x, y: box.y, width: box.width, height: box.height };

    assert.equal(await savePDF(null, { zonderHandtekeningVraag: true }, doc), true);
    const first = await reopen(files.get(PATH));
    assert.equal(first.rotate, (native + 90) % 360);
    near(first.model, where, 'first save');
    assert.deepEqual(reloads.at(-1)?.rotations, {}, 'the rotation is in the file now, not in the app');
    assert.deepEqual({ ...doc.pageRotations }, {});

    doc.annotations[0].color = '#a12727';
    doc.annotations[0].strokeColor = '#a12727';
    assert.equal(await savePDF(null, { zonderHandtekeningVraag: true }, doc), true);
    const second = await reopen(files.get(PATH));
    assert.equal(second.rotate, (native + 90) % 360, 'the second save does not rotate the page again');
    near(second.model, where, 'second save');
  });
}

test('Save As of a rotated sheet: the copy is the new base and the next save keeps its /Rotate', async () => {
  const { doc, files, reloads } = openSheet(await croppedSheet(0), 180);
  const box = createAnnotation({ type: 'box', page: 1, x: 20, y: 10, width: 40, height: 25,
    color: '#275ca1', strokeColor: '#275ca1', lineWidth: 2 });
  doc.annotations = [box];
  const where = { x: box.x, y: box.y, width: box.width, height: box.height };
  assert.equal(await savePDFAs(doc), true);
  assert.equal(doc.filePath, 'C:/rotation/copy.pdf');
  assert.deepEqual(reloads.at(-1)?.rotations, {});
  assert.equal(await savePDF(null, { zonderHandtekeningVraag: true }, doc), true);
  const copy = await reopen(files.get('C:/rotation/copy.pdf'));
  assert.equal(copy.rotate, 180);
  near(copy.model, where, 'after Save As and save');
});

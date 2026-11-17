// Dynamic stamps (docs/reference/editor/markup-tools.md) through the real saver and loader: the
// placed design (fields evaluated to text, template id kept) survives save and
// reopen, the appearance is vector (fonts and paths, no image for a text
// stamp), and PDF.js renders the saved PDF like the canvas draws the stamp.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

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
const { decodePdfTextObject } = await import('./saver/pdf-text.js');
const { CONTRACTOR_STAMPS, instantiateStampTemplate, stampDesignText } = await import('../annotations/stamp-templates.js');
const { stampDesignSize } = await import('../annotations/stamp-layout.js');
const { drawStampDesign } = await import('../annotations/stamp-draw.js');
const { STAMP_DESIGN_KEY } = await import('./saver/stamp-design-ap.js');
const { toggleMarkupCheck, isMarkupChecked } = await import('../annotations/markup-check.js');

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const NOW = new Date(2026, 9, 14, 9, 5);
const FIELDS = { now: NOW, user: 'Jason Niewoit', page: 1, pageLabel: 'A-101', fileName: 'C:/jobs/Tower/A-101.pdf' };

function stamp(templateId, props, scale = 1.5) {
  const design = instantiateStampTemplate(CONTRACTOR_STAMPS.find(t => t.id === templateId), FIELDS);
  const size = stampDesignSize(design);
  return createAnnotation({ type: 'stamp', page: 1, width: size.width * scale, height: size.height * scale,
    rotation: 0, opacity: 1, stampName: design.name, stampText: stampDesignText(design),
    stampTemplateId: design.templateId, stampDesign: design, stampColor: design.color, color: design.color,
    author: 'Jason Niewoit', ...props });
}

async function save(bytes, annotations, before = null) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_path, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_path, data) => { saved = data; return true; },
  } };
  state.documents = [{ id: `stamp-rt-${Math.random()}`, filePath: 'C:/stamps/in.pdf', pdfDoc: {},
    currentPage: 1, annotations, pageRotations: {}, _annotationPagesReady: new Set([1, 2]), textEdits: [] }];
  state.activeDocumentIndex = 0;
  if (before) await before(state.documents[0]);
  assert.equal(await savePDF('C:/stamps/out.pdf', { zonderHandtekeningVraag: true }), true);
  assert.ok(saved, 'the saver wrote PDF bytes');
  return saved;
}

async function reopen(bytes, pageNum = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNum);
    const colors = await extractAnnotationColors(pageNum, await PDFDocument.load(bytes.slice()));
    const models = [];
    for (const annotation of await page.getAnnotations()) {
      const model = await convertPdfAnnotation(annotation, pageNum, page.getViewport({ scale: 1 }), new Map(), colors);
      if (model) models.push(model);
    }
    return models;
  } finally {
    await task.destroy();
  }
}

async function rawStamps(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  return ctx.lookup(doc.getPages()[pageIndex].node.get(PDFName.of('Annots'))).asArray()
    .map(ref => ctx.lookup(ref)).filter(d => d.get(PDFName.of(STAMP_DESIGN_KEY)))
    .map(d => {
      const n = ctx.lookup(ctx.lookup(d.get(PDFName.of('AP'))).get(PDFName.of('N')));
      const res = ctx.lookup(n.dict.get(PDFName.of('Resources')));
      return { dict: d, content: Buffer.from(n.getContents()).toString('latin1'), res, ctx,
        design: JSON.parse(decodePdfTextObject(d.get(PDFName.of(STAMP_DESIGN_KEY)))) };
    });
}

test('a dynamic stamp keeps its evaluated text, template id and box through two saves', async () => {
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  const placed = [stamp('ct:approvedAsNoted', { x: 80, y: 90 }), stamp('ct:fieldVerified', { x: 300, y: 400, rotation: 30 })];
  const first = await save(await source.save(), placed);
  const raw = await rawStamps(first);
  assert.equal(raw.length, 2);
  for (const r of raw) {
    assert.match(r.content, /\bTj\b/u, 'text is drawn as text');
    assert.match(r.content, / (?:re|c)\n/u, 'the border is a vector path');
    assert.equal(r.res.get(PDFName.of('XObject')), undefined, 'no image in a text stamp appearance');
    const fonts = r.ctx.lookup(r.res.get(PDFName.of('Font')));
    assert.equal(r.ctx.lookup(fonts.get(PDFName.of('F2'))).get(PDFName.of('BaseFont')).toString(), '/Helvetica-Bold');
    assert.equal(r.design.templateId.startsWith('ct:'), true);
  }
  assert.match(raw[0].content, /\(Jason Niewoit {2}10\/14\/2026\) Tj/u, 'the date and author are text in the appearance');
  const models = await reopen(first);
  const stamps = models.filter(m => m.type === 'stamp');
  assert.equal(stamps.length, 2);
  const [a, b] = stamps;
  assert.equal(a.stampTemplateId, 'ct:approvedAsNoted');
  assert.deepEqual(a.stampDesign.lines.map(l => l.text), ['APPROVED AS NOTED', 'Jason Niewoit  10/14/2026']);
  assert.equal(a.stampName, 'Approved as Noted');
  close(a.x, 80); close(a.y, 90); close(a.width, placed[0].width); close(a.height, placed[0].height);
  assert.equal(b.stampTemplateId, 'ct:fieldVerified');
  assert.equal(b.rotation, 30);
  close(b.x, 300); close(b.y, 400); close(b.width, placed[1].width); close(b.height, placed[1].height);
  // A second save of the reopened models writes the same design.
  const second = await save(first, stamps);
  const again = (await reopen(second)).filter(m => m.type === 'stamp');
  assert.deepEqual(again.map(m => m.stampDesign), stamps.map(m => m.stampDesign));
  close(again[1].x, 300); close(again[1].width, placed[1].width);
});

test('on a /Rotate 90 page with a CropBox the stamp box comes back where it was placed', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([700, 900]);
  page.setCropBox(40, 50, 600, 800);
  page.setRotation(degrees(90));
  const placed = [stamp('ct:asBuilt', { x: 120, y: 140 })];
  const bytes = await save(await source.save(), placed);
  const [raw] = await rawStamps(bytes);
  assert.deepEqual(raw.design.box.map(v => Math.round(v * 1000) / 1000),
    [placed[0].width, placed[0].height].map(v => Math.round(v * 1000) / 1000));
  const [back] = (await reopen(bytes)).filter(m => m.type === 'stamp');
  close(back.x, 120); close(back.y, 140); close(back.width, placed[0].width); close(back.height, placed[0].height);
  assert.equal(back.rotation || 0, 0);
});

// Pixels: PDF.js (a third-party renderer) against the canvas renderer.
const SCALE = 2;
function inkMask(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    mask[i] = lum < 200 ? 1 : 0;
  }
  return mask;
}
/** Share of ink pixels in either image that have no ink within 1 px in the other. */
function inkMismatch(a, b, w, h) {
  const near = (m, x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && m[yy * w + xx]) return true;
    }
    return false;
  };
  let ink = 0, miss = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (a[i]) { ink++; if (!near(b, x, y)) miss++; }
    if (b[i]) { ink++; if (!near(a, x, y)) miss++; }
  }
  return { ink, ratio: ink ? miss / ink : 1 };
}

test('PDF.js renders every built-in stamp like the canvas draws it', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([700, 900]);
  page.setCropBox(20, 30, 640, 840);
  const placed = CONTRACTOR_STAMPS.map((template, i) => stamp(template.id, {
    x: 20 + (i % 2) * 310, y: 30 + Math.floor(i / 2) * 150, rotation: i === 3 ? 15 : 0,
  }, 1.25));
  const bytes = await save(await source.save(), placed);

  const W = 640 * SCALE, H = 840 * SCALE;
  const reference = createCanvas(W, H);
  const rctx = reference.getContext('2d');
  rctx.fillStyle = '#ffffff';
  rctx.fillRect(0, 0, W, H);
  for (const ann of placed) {
    rctx.save();
    rctx.scale(SCALE, SCALE);
    rctx.translate(ann.x + ann.width / 2, ann.y + ann.height / 2);
    rctx.rotate(ann.rotation * Math.PI / 180);
    rctx.translate(-ann.width / 2, -ann.height / 2);
    drawStampDesign(rctx, ann.stampDesign, ann.width, ann.height);
    rctx.restore();
  }

  // The app's browser stubs define a window without animation frames.
  if (typeof globalThis.window?.requestAnimationFrame !== 'function') {
    globalThis.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // PDF.js wants a trailing "/": a Windows path ends in "\\".
  const fontDir = fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replace(/\\/g, '/');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0,
    standardFontDataUrl: fontDir });
  const doc = await task.promise;
  const rendered = createCanvas(W, H);
  const pctx = rendered.getContext('2d');
  try {
    const pdfPage = await doc.getPage(1);
    const viewport = pdfPage.getViewport({ scale: SCALE });
    assert.equal(Math.round(viewport.width), W);
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, W, H);
    await pdfPage.render({ canvasContext: pctx, canvas: rendered, viewport }).promise;
  } finally {
    await task.destroy();
  }
  const a = inkMask(rctx, W, H), b = inkMask(pctx, W, H);
  const { ink, ratio } = inkMismatch(a, b, W, H);
  if (process.env.STAMP_PIXEL_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${process.env.STAMP_PIXEL_OUT}-canvas.png`, reference.toBuffer('image/png'));
    writeFileSync(`${process.env.STAMP_PIXEL_OUT}-pdfjs.png`, rendered.toBuffer('image/png'));
    writeFileSync(`${process.env.STAMP_PIXEL_OUT}.pdf`, bytes);
  }
  assert.ok(ink > 20000, `the stamps put ink on the page (${ink})`);
  console.log(`stamp pixel diff: ${(ratio * 100).toFixed(2)}% of ${ink} ink pixels`);
  // macOS draws the canvas reference's text with its own font rasteriser
  // (6.4% of ink pixels apart there); elsewhere the two agree within 2%.
  const limit = process.platform === 'darwin' ? 0.08 : 0.02;
  assert.ok(ratio < limit, `PDF.js and canvas differ in ${(ratio * 100).toFixed(2)}% of ink pixels`);
});

test('a user stamp with an image saves the image in its appearance and in its design', async () => {
  const logo = createCanvas(8, 4);
  const lctx = logo.getContext('2d');
  lctx.fillStyle = '#ff0000';
  lctx.fillRect(0, 0, 8, 4);
  const dataUrl = `data:image/png;base64,${logo.toBuffer('image/png').toString('base64')}`;
  const template = { version: 1, id: 'user:logo', name: 'Site Check', color: '#334455', border: 'rectangle',
    dateFormat: 'iso', status: 'OK', image: { dataUrl, width: 8, height: 4 },
    lines: [{ text: 'SITE CHECK {status}', size: 14, bold: true }, { text: '{fileName} p. {pageLabel}', size: 7 }] };
  const design = instantiateStampTemplate(template, FIELDS);
  assert.deepEqual(design.lines.map(l => l.text), ['SITE CHECK OK', 'A-101.pdf p. A-101']);
  const size = stampDesignSize(design);
  const ann = createAnnotation({ type: 'stamp', page: 1, x: 50, y: 60, width: size.width, height: size.height,
    stampName: design.name, stampText: stampDesignText(design), stampTemplateId: design.templateId,
    stampDesign: design, color: design.color });
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  const bytes = await save(await source.save(), [ann]);
  const [raw] = await rawStamps(bytes);
  assert.ok(raw.res.get(PDFName.of('XObject')), 'the image is an XObject of the appearance');
  assert.match(raw.content, /\/Im0 Do/u);
  const [back] = (await reopen(bytes)).filter(m => m.type === 'stamp');
  assert.equal(back.stampTemplateId, 'user:logo');
  assert.equal(back.stampDesign.image.dataUrl, dataUrl);
  assert.equal(back.imageData, undefined, 'the stamp is not turned into a bitmap stamp');
});

test('Lock and Check from the context menu save with the PDF', async () => {
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  const a = stamp('ct:reviewed', { x: 40, y: 40 });
  const b = stamp('ct:void', { x: 300, y: 40 });
  const bytes = await save(await source.save(), [a, b], async (doc) => {
    const result = await toggleMarkupCheck(doc, [a, b]);
    assert.deepEqual(result, { value: 'checked', count: 2 });
    assert.equal(doc.markupCheckmarkColumn.name, 'Checkmark', 'a document without the column gets one');
    b.locked = true;
    // Locked markups are not changed by Check.
    assert.deepEqual(await toggleMarkupCheck(doc, [b]), null);
  });
  const models = (await reopen(bytes)).filter(m => m.type === 'stamp');
  assert.deepEqual(models.map(m => isMarkupChecked(m)), [true, true]);
  assert.deepEqual(models.map(m => m.locked), [false, true]);
});

test('a stamp keeps its /NM across two consecutive saves', async () => {
  const nms = async (bytes) => (await rawStamps(bytes)).map(r => decodePdfTextObject(r.dict.get(PDFName.of('NM'))));
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  const placed = [stamp('ct:approvedAsNoted', { x: 80, y: 90 }), stamp('ct:fieldVerified', { x: 300, y: 400 })];
  const first = await save(await source.save(), placed);
  const firstNames = await nms(first);
  assert.equal(firstNames.length, 2);
  assert.ok(firstNames.every(n => typeof n === 'string' && n.length > 0), 'each stamp has an /NM');
  assert.notEqual(firstNames[0], firstNames[1]);

  // The live models saved again (the in-app Save, Save sequence).
  const second = await save(first, placed);
  assert.deepEqual(await nms(second), firstNames);

  // Reopened models saved again keep the same identity too.
  const reopened = (await reopen(second)).filter(m => m.type === 'stamp');
  assert.deepEqual(reopened.map(m => m.nm), firstNames);
  const third = await save(second, reopened);
  assert.deepEqual(await nms(third), firstNames);
});

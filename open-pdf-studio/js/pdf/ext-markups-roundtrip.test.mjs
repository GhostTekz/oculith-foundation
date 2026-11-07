// the external editor markup tools through real PDF bytes: Typewriter (W), Hyperlink
// (Shift+H) and Flag (Shift+F) are made with the real tool creators, saved
// with the real saver and reopened with the real load pipeline (pdf.js
// annotations + pdf-lib extras + annotation converter).

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { register } from 'node:module';
import { degrees, PDFDocument, PDFName, PDFString } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('./saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('./tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { createAnnotationFromTool } = await import('../tools/annotation-creators.js');
const { savePDF } = await import('./saver.js');
const { convertPdfAnnotation } = await import('./loader/annotation-converter.js');
const { extractAnnotationColors } = await import('./loader/color-extraction.js');
const { decodePdfTextObject } = await import('./saver/pdf-text.js');
const { normalizeHyperlinkUrl, hyperlinkTarget } = await import('./saver/hyperlink-dict.js');
const { dragRect } = await import('../tools/tools/ext-tools.js');

function useDoc(annotations, pages = 1) {
  state.documents = [{ id: 'ext', filePath: 'C:/ext/in.pdf', currentPage: 1, annotations,
    pdfDoc: { numPages: pages }, pageRotations: {}, _annotationPagesReady: new Set(Array.from({ length: pages }, (_, i) => i + 1)), textEdits: [] }];
  state.activeDocumentIndex = 0;
}

async function save(bytes, annotations, pages = 1) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_p, data) => { saved = data; return true; },
  } };
  useDoc(annotations, pages);
  assert.equal(await savePDF('C:/ext/out.pdf', { zonderHandtekeningVraag: true }), true);
  assert.ok(saved, 'the saver wrote PDF bytes');
  return saved;
}

async function rawAnnots(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const arr = ctx.lookup(doc.getPages()[pageIndex].node.get(PDFName.of('Annots')));
  return { doc, ctx, dicts: arr ? arr.asArray().map(r => ctx.lookup(r)) : [] };
}

async function reopen(bytes, pageNum = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNum);
    const colors = await extractAnnotationColors(pageNum, await PDFDocument.load(bytes.slice()));
    const models = [];
    for (const a of await page.getAnnotations()) {
      const m = await convertPdfAnnotation(a, pageNum, page.getViewport({ scale: 1 }), new Map(), colors);
      if (m) models.push(m);
    }
    return { models, pdfjsAnnots: await page.getAnnotations() };
  } finally {
    await task.destroy();
  }
}

async function blank({ pages = 1, rotation = 0 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    if (rotation) p.setRotation(degrees(rotation));
  }
  return doc.save();
}

const close = (a, b, tol = 0.05) => Math.abs(a - b) < tol;

test('Typewriter: borderless, unwrapped FreeText /IT /FreeTextTypeWriter (the external editor and ISO spelling), back as typewriter text', async () => {
  useDoc([]);
  const ann = createAnnotationFromTool('typewriter', 100, 200, 220, 220, null);
  assert.equal(ann.type, 'textbox');
  assert.equal(ann.noWrap, true);
  assert.equal(ann.lineWidth, 0, 'no border');
  assert.equal(ann.fillColor, 'none', 'no fill');
  ann.text = 'Field verified 2026-10-14';
  const bytes = await save(await blank(), [ann]);
  const { dicts } = await rawAnnots(bytes);
  const ft = dicts.filter(d => d.get(PDFName.of('Subtype'))?.toString() === '/FreeText');
  assert.equal(ft.length, 1);
  assert.equal(ft[0].get(PDFName.of('IT'))?.toString(), '/FreeTextTypeWriter');
  const { models } = await reopen(bytes);
  const back = models.filter(m => m.type === 'textbox');
  assert.equal(back.length, 1);
  assert.equal(back[0].noWrap, true, 'reopens as typewriter text');
  assert.equal(back[0].text, 'Field verified 2026-10-14');
  assert.ok(close(back[0].x, 100, 0.5) && close(back[0].y, 200, 0.5), `position ${back[0].x},${back[0].y}`);
  assert.ok(!(back[0].lineWidth > 0), 'still borderless');
  // Second save: still one typewriter text.
  const again = await save(bytes, back);
  assert.equal((await rawAnnots(again)).dicts.filter(d => d.get(PDFName.of('IT'))?.toString() === '/FreeTextTypeWriter').length, 1);
});

test('Hyperlink to a web address: /Link /A /URI, reopened as a hyperlink markup, rewritten once', async () => {
  // A foreign link already in the file stays a plain PDF link.
  const srcDoc = await PDFDocument.load(await blank());
  const foreign = srcDoc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0],
    A: srcDoc.context.obj({ S: 'URI', URI: PDFString.of('https://foreign.example/') }) });
  srcDoc.getPages()[0].node.set(PDFName.of('Annots'), srcDoc.context.obj([srcDoc.context.register(foreign)]));
  const source = await srcDoc.save();

  useDoc([]);
  const ann = createAnnotationFromTool('hyperlink', 50, 100, 250, 130, null);
  assert.equal(ann.type, 'hyperlink');
  ann.linkUrl = normalizeHyperlinkUrl('www.example.com/specs');
  assert.equal(ann.linkUrl, 'https://www.example.com/specs');
  const bytes = await save(source, [ann]);
  const { dicts, ctx } = await rawAnnots(bytes);
  const links = dicts.filter(d => d.get(PDFName.of('Subtype'))?.toString() === '/Link');
  assert.equal(links.length, 2, 'own link plus the foreign one');
  const own = links.find(d => d.get(PDFName.of('OPS_Subtype')));
  assert.equal(decodePdfTextObject(own.get(PDFName.of('OPS_Subtype'))), 'hyperlink');
  const action = ctx.lookup(own.get(PDFName.of('A')));
  assert.equal(action.get(PDFName.of('S'))?.toString(), '/URI');
  assert.equal(decodePdfTextObject(action.get(PDFName.of('URI'))), 'https://www.example.com/specs');
  assert.deepEqual(ctx.lookup(own.get(PDFName.of('Rect'))).asArray().map(n => n.asNumber()), [50, 712, 250, 742]);

  const { models, pdfjsAnnots } = await reopen(bytes);
  // What link-layer.js follows: pdf.js reads both as Link with a url.
  assert.deepEqual(pdfjsAnnots.filter(a => a.subtype === 'Link').map(a => a.url).sort(),
    ['https://foreign.example/', 'https://www.example.com/specs']);
  const back = models.filter(m => m.type === 'hyperlink');
  assert.equal(back.length, 1, 'only the own link is a markup (Markups List)');
  assert.equal(back[0].linkUrl, 'https://www.example.com/specs');
  assert.ok(close(back[0].x, 50) && close(back[0].y, 100) && close(back[0].width, 200) && close(back[0].height, 30));

  back[0].x += 10;
  const again = await save(bytes, back);
  const second = (await rawAnnots(again)).dicts.filter(d => d.get(PDFName.of('Subtype'))?.toString() === '/Link');
  assert.equal(second.length, 2, 'the own link is replaced, not duplicated; the foreign one is kept');
  const reopened = (await reopen(again)).models.filter(m => m.type === 'hyperlink');
  assert.equal(reopened.length, 1);
  assert.ok(close(reopened[0].x, 60), 'the moved position is saved');
});

test('Hyperlink to a page: /Dest [page /Fit], also on a rotated sheet', async () => {
  useDoc([], 3);
  const ann = createAnnotationFromTool('hyperlink', 300, 400, 400, 430, null);
  ann.linkPage = 3;
  const bytes = await save(await blank({ pages: 3, rotation: 90 }), [ann], 3);
  const { dicts, ctx, doc } = await rawAnnots(bytes);
  const own = dicts.find(d => d.get(PDFName.of('Subtype'))?.toString() === '/Link');
  const dest = ctx.lookup(own.get(PDFName.of('Dest'))).asArray();
  assert.equal(dest[0].toString(), doc.getPages()[2].ref.toString(), 'destination is page 3');
  assert.equal(dest[1].toString(), '/Fit');
  assert.equal(own.get(PDFName.of('A')), undefined);
  const { models, pdfjsAnnots } = await reopen(bytes);
  assert.ok(Array.isArray(pdfjsAnnots.find(a => a.subtype === 'Link').dest), 'pdf.js sees an explicit destination');
  const back = models.filter(m => m.type === 'hyperlink');
  assert.equal(back.length, 1);
  assert.equal(back[0].linkPage, 3);
  assert.equal(back[0].linkUrl, '');
  assert.ok(close(back[0].x, 300, 0.5) && close(back[0].y, 400, 0.5), `rotated sheet keeps the place: ${back[0].x},${back[0].y}`);
  assert.ok(close(back[0].width, 100, 0.5) && close(back[0].height, 30, 0.5));
});

test('a hyperlink without a valid target is not written; unsafe addresses are refused', async () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '   ']) {
    assert.equal(normalizeHyperlinkUrl(bad), '', bad);
  }
  assert.equal(normalizeHyperlinkUrl('jan@example.com'), 'mailto:jan@example.com');
  assert.equal(normalizeHyperlinkUrl('localhost:8080/x'), 'https://localhost:8080/x');
  assert.equal(hyperlinkTarget({ linkPage: 4 }, 3), null, 'page outside the document');
  useDoc([]);
  const ann = createAnnotationFromTool('hyperlink', 10, 10, 60, 30, null);
  ann.linkUrl = 'javascript:alert(1)';
  const bytes = await save(await blank(), [ann]);
  assert.equal((await rawAnnots(bytes)).dicts.filter(d => d.get(PDFName.of('Subtype'))?.toString() === '/Link').length, 0);
});

test('Flag: a note with the flag icon, /Text /Name /Flag, reopened as a flag', async () => {
  const ann = createAnnotation({ type: 'comment', page: 1, x: 80, y: 90, width: 24, height: 24,
    text: '', icon: 'flag', color: '#dc2626', fillColor: '#dc2626', popupOpen: false });
  const bytes = await save(await blank(), [ann]);
  const { dicts } = await rawAnnots(bytes);
  const note = dicts.find(d => d.get(PDFName.of('Subtype'))?.toString() === '/Text');
  assert.equal(note.get(PDFName.of('Name'))?.toString(), '/Flag');
  const back = (await reopen(bytes)).models.filter(m => m.type === 'comment');
  assert.equal(back.length, 1);
  assert.equal(back[0].icon, 'flag');
  assert.equal(back[0].color.toLowerCase(), '#dc2626');
  assert.ok(close(back[0].x, 80) && close(back[0].y, 90));
});

test('tools, list names and snapshot wiring', () => {
  assert.deepEqual(dragRect(30, 40, 10, 5), { x: 10, y: 5, width: 20, height: 35 });
  const lees = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const index = lees('../tools/tools/index.js');
  for (const t of ['typewriter', 'hyperlink', 'flag', 'snapshot']) assert.match(index, new RegExp(`registerTool\\('${t}'`));
  const helpers = lees('../utils/helpers.js');
  assert.match(helpers, /ann\?\.type === 'textbox' && ann\.noWrap\) return i18next\.t\('types\.typewriter'/);
  assert.match(helpers, /ann\?\.type === 'comment' && ann\.icon === 'flag'\) return i18next\.t\('types\.flag'/);
  const shot = lees('../tools/screenshot.js');
  assert.match(shot, /export async function snapshotRegion\(pageNum, rect\)/);
  assert.match(shot, /canvas = await _renderRegionHighRes\(pageNum, appRect\)/, 'same high-res region render');
  assert.match(lees('../tools/keyboard-handlers.js'), /placeLastScreenshotAsOverlay\(\{ opacity: 1, offset: 10 \}\)/, 'Ctrl+V places the snapshot');
  // Tools > Markup runs the registry commands, which select the tool.
  const ribbon = lees('../solid/commands/menus.js');
  const tools = lees('../solid/commands/tools.js');
  for (const t of ['polygon', 'cloudPolyline', 'typewriter', 'hyperlink', 'flag']) {
    assert.match(tools, new RegExp(`\\['${t}', '${t}', \\w+Icon\\]`), `tools.markup.${t} selects ${t}`);
    assert.match(ribbon, new RegExp(`'tools\\.markup\\.${t}'`), `Tools > Markup: ${t}`);
  }
  assert.match(lees('../solid/commands/edit.js'), /id: 'edit\.snapshot'[\s\S]*?run: \(\) => useTool\('snapshot'\)/);
  assert.match(ribbon, /'edit\.snapshot'/, 'Edit > Snapshot');
  for (const taal of ['en', 'nl']) {
    const types = JSON.parse(lees(`../i18n/locales/${taal}/properties.json`)).types;
    for (const k of ['typewriter', 'hyperlink', 'flag']) assert.ok(types[k], `${taal} types.${k}`);
    const r = JSON.parse(lees(`../i18n/locales/${taal}/ribbon.json`)).comment;
    for (const k of ['typewriter', 'hyperlink', 'flag', 'snapshot', 'polygonTitle', 'cloudPolylineTitle']) assert.ok(r[k], `${taal} ribbon comment.${k}`);
    assert.ok(JSON.parse(lees(`../i18n/locales/${taal}/dialogs.json`)).hyperlink.pageInDocument);
  }
});

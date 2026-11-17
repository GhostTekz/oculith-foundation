// Slip sheet (WP6): matching, alignment and carry-forward with real PDF bytes.
//
// Fixture: an old set of four labelled sheets (A-101..A-104, revision A) with
// markups; a revised PDF that reissues A-101 (unchanged), A-102 (now with
// /Rotate 90), A-104 (renumbered: page 4 -> page 3) and a new A-105. Markups
// are saved with the real saver, read back with the real converter, carried,
// saved onto the new revision and read back again.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { degrees, PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';

register('../core/app-test-hooks.mjs', import.meta.url);
register('../pdf/saver-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { installeerCanvas } = await import('../pdf/tekstvak-canvas.testhulp.mjs');
installeerCanvas();
const { state } = await import('../core/state.js');
const { createAnnotation } = await import('../annotations/factory.js');
const { savePDF } = await import('../pdf/saver.js');
const { convertPdfAnnotation } = await import('../pdf/loader/annotation-converter.js');
const { extractAnnotationColors } = await import('../pdf/loader/color-extraction.js');
const { commentReplyFromPdfAnnotation, applyCommentReplies } = await import('../pdf/loader/comment-replies.js');
const { statusReplyFromPdfAnnotation } = await import('../pdf/loader/status-replies.js');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const { planSlipSheet, containsSheetId, titleBlockText, slipSheetCollisionText } = await import('./slip-sheet-match.js');
const { pageAlignTransform, twoPointTransform, compareOffsetTransform, applyPoint, similarityParts, transformMarkupGeometry, isIdentity } = await import('./slip-sheet-transform.js');
const { carryMarkups, carryableMarkups, applySlipSheet, appendedSheetLabel } = await import('./slip-sheet-carry.js');
const { createSheetRegister, updateSheet, parseSheetRegister } = await import('./sheet-register.js');
const { addPdfPages } = await import('./pdf-page-import.js');
const { parseCarriedFrom, carriedFromText } = await import('../annotations/carried-from.js');

const OLD = 'C:/set/rev-a.pdf';
const NEW = 'C:/set/rev-b.pdf';
const OUT = 'C:/set/rev-b-slip-sheet.pdf';
const FP = 'a'.repeat(64);

function setPageLabels(doc, labels) {
  const nums = [];
  labels.forEach((label, index) => nums.push(doc.context.obj(index), doc.context.obj({ P: PDFString.of(label) })));
  doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({ Nums: nums }));
}

async function buildPdf(sheets) {
  const doc = await PDFDocument.create();
  for (const sheet of sheets) {
    const page = doc.addPage([842, 595]);
    page.drawRectangle({ x: 30, y: 30, width: 782, height: 535, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawRectangle({ x: 600, y: 40, width: 200, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    if (sheet.crop) page.setCropBox(...sheet.crop);
    if (sheet.rotate) page.setRotation(degrees(sheet.rotate));
  }
  setPageLabels(doc, sheets.map(sheet => sheet.label));
  return doc.save();
}

async function save(bytes, annotations, pages, path) {
  let saved;
  globalThis.__saverTest = { impl: {
    getCachedPdfBytes: () => bytes,
    writeBinaryFile: (_p, data) => { saved = data; return true; },
    writeBinaryFileAtomic: (_p, data) => { saved = data; return true; },
  } };
  state.documents = [{ id: `doc-${path}`, filePath: path, currentPage: 1, annotations, pdfDoc: { numPages: pages },
    pageRotations: {}, _annotationPagesReady: new Set(Array.from({ length: pages }, (_, i) => i + 1)), textEdits: [] }];
  state.activeDocumentIndex = 0;
  assert.equal(await savePDF(`${path}.out`, { zonderHandtekeningVraag: true }), true);
  assert.ok(saved, 'the saver wrote PDF bytes');
  return saved;
}

// The loader's page conversion (loader.js _convertAndPushAnnotations), with reply threads.
async function readPage(bytes, pageNum) {
  const lib = await PDFDocument.load(bytes.slice());
  const colors = await extractAnnotationColors(pageNum, lib);
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  const reader = await task.promise;
  try {
    const page = await reader.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const models = [];
    const byPdfId = new Map();
    const replies = [];
    const raw = await page.getAnnotations();
    for (const annot of raw) {
      if (statusReplyFromPdfAnnotation(annot)) continue;
      const reply = commentReplyFromPdfAnnotation(annot);
      if (reply) { replies.push({ ...reply, annot }); continue; }
      const model = await convertPdfAnnotation(annot, pageNum, viewport, new Map(), colors);
      if (!model || model.__textboxLeader) continue;
      if (annot.id) byPdfId.set(annot.id, model);
      models.push(model);
    }
    applyCommentReplies(replies, byPdfId);
    return { models, viewport, raw: raw.filter(a => !commentReplyFromPdfAnnotation(a)) };
  } finally {
    await task.destroy();
  }
}

function pdfRects(raw) {
  return raw.map(a => ({ subtype: a.subtype, rect: a.rect, line: a.lineCoordinates }))
    .sort((a, b) => a.subtype.localeCompare(b.subtype) || a.rect[0] - b.rect[0]);
}

function oldMarkups() {
  return [
    createAnnotation({ type: 'box', page: 1, x: 120, y: 140, width: 160, height: 90,
      strokeColor: '#d32f2f', color: '#d32f2f', lineWidth: 2, layer: null }),
    createAnnotation({ type: 'line', page: 1, startX: 330, startY: 300, endX: 520, endY: 360,
      strokeColor: '#1565c0', color: '#1565c0', lineWidth: 2, layer: null }),
    createAnnotation({ type: 'circle', page: 2, x: 400, y: 200, width: 120, height: 80,
      strokeColor: '#2e7d32', color: '#2e7d32', lineWidth: 2, layer: null }),
    createAnnotation({ type: 'arrow', page: 2, startX: 100, startY: 450, endX: 260, endY: 380,
      strokeColor: '#6a1b9a', color: '#6a1b9a', lineWidth: 2, layer: null }),
    createAnnotation({ type: 'box', page: 3, x: 60, y: 60, width: 50, height: 50,
      strokeColor: '#000000', color: '#000000', lineWidth: 1, layer: null }),
    createAnnotation({ type: 'box', page: 4, x: 650, y: 420, width: 120, height: 70,
      strokeColor: '#ef6c00', color: '#ef6c00', lineWidth: 3, layer: null }),
  ];
}

async function fixture() {
  const crop = [20, 15, 800, 570];
  const oldBlank = await buildPdf([
    { label: 'A-101', crop }, { label: 'A-102' }, { label: 'A-103' }, { label: 'A-104' },
  ]);
  const oldBytes = await save(oldBlank, oldMarkups(), 4, OLD);
  const newBytes = await buildPdf([
    { label: 'A-101', crop }, { label: 'A-102', rotate: 90 }, { label: 'A-104' }, { label: 'A-105' },
  ]);
  let set = createSheetRegister('Tower');
  set = addPdfPages(set, OLD, 4, ['A-101', 'A-102', 'A-103', 'A-104'], FP).register;
  for (const sheet of set.sheets) set = updateSheet(set, sheet.id, { revision: 'A' });
  return { oldBytes, newBytes, set };
}

test('page labels match sheets; a renumbered sheet follows its label and a new sheet is appended', async () => {
  const { set } = await fixture();
  const { rows, conflicts } = planSlipSheet(set, [{ filePath: NEW, pageCount: 4, pageLabels: ['A-101', 'A-102', 'A-104', 'A-105'] }]);
  assert.deepEqual(conflicts, []);
  const byLabel = Object.fromEntries(set.sheets.map(sheet => [sheet.id, sheet.label]));
  assert.deepEqual(rows.map(row => [row.page, row.sheetId && byLabel[row.sheetId], row.reason]), [
    [1, 'A-101', 'label'], [2, 'A-102', 'label'], [3, 'A-104', 'label'], [4, null, null],
  ]);
  assert.equal(set.sheets.find(sheet => sheet.label === 'A-104').page, 4, 'A-104 was page 4 and is now matched on page 3');
});

test('fallbacks: single-page file name, then title-block text; ambiguity stays unmatched', async () => {
  const { set } = await fixture();
  const plan = planSlipSheet(set, [
    { filePath: 'C:/in/A-103 Rev B.pdf', pageCount: 1, pageLabels: null },
    { filePath: 'C:/in/batch.pdf', pageCount: 3, pageLabels: ['1', '2', '3'],
      titleBlockTexts: ['Project Tower  SHEET A-102  Rev B', 'see A-101 and A-104', 'no id here'] },
  ]);
  const labels = Object.fromEntries(set.sheets.map(sheet => [sheet.id, sheet.label]));
  assert.deepEqual(plan.rows.map(row => [row.page, row.sheetId && labels[row.sheetId], row.reason]), [
    [1, 'A-103', 'fileName'], [1, 'A-102', 'titleBlock'], [2, null, null], [3, null, null],
  ]);
  assert.equal(containsSheetId('A-1010', 'A-101'), false);
  assert.equal(containsSheetId('Sheet a-101.', 'A-101'), true);
  // Two revised pages with the same label: neither replaces the sheet.
  const twice = planSlipSheet(set, [{ filePath: NEW, pageCount: 2, pageLabels: ['A-101', 'A-101'] }]);
  assert.equal(twice.rows.every(row => !row.sheetId), true);
  assert.equal(twice.conflicts.length, 1);
  // Title-block region: right 35 % or bottom 25 % of the visible sheet.
  const viewport = { width: 1000, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y] };
  const items = [{ str: 'LEFT', transform: [1, 0, 0, 1, 100, 700] }, { str: 'A-104', transform: [1, 0, 0, 1, 900, 700] },
    { str: 'BOTTOM', transform: [1, 0, 0, 1, 100, 50] }];
  assert.equal(titleBlockText(items, viewport), 'A-104 BOTTOM');
});

test('alignment: page, two-point and compare offsets are similarities', () => {
  const two = twoPointTransform({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 20 }, { x: 10, y: 220 });
  assert.deepEqual(similarityParts(two.matrix), { scale: 2, rotation: 90 });
  const p = applyPoint(two.matrix, 50, 0);
  assert.ok(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 120) < 1e-9);
  const offset = compareOffsetTransform({ dx: 15, dy: -30, rotation: 0 }, { width: 400, height: 300 }, 1.5);
  assert.deepEqual(offset.matrix.map(v => v + 0), [1, 0, 0, 1, 10, -20]);
  const box = { type: 'box', x: 0, y: 0, width: 100, height: 50, rotation: 0 };
  transformMarkupGeometry(box, two.matrix);
  assert.equal(box.rotation, 90);
  assert.equal(box.width, 200);
  assert.throws(() => similarityParts([1, 0, 0, -1, 0, 0]), /moving, rotating and uniform scaling/);
});

test('carry-forward: markups land within 1 pt, get new durable IDs with carriedFrom, and history keeps the old revision', async () => {
  const { oldBytes, newBytes, set } = await fixture();
  const { rows } = planSlipSheet(set, [{ filePath: NEW, pageCount: 4, pageLabels: ['A-101', 'A-102', 'A-104', 'A-105'] }]);

  const newTask = pdfjs.getDocument({ data: newBytes.slice(), isEvalSupported: false, verbosity: 0 });
  const newDoc = await newTask.promise;
  const carried = [];
  const usedIds = new Set();
  const sources = new Map();
  try {
    for (const row of rows.filter(r => r.sheetId)) {
      const sheet = set.sheets.find(s => s.id === row.sheetId);
      const old = await readPage(oldBytes, sheet.page);
      sources.set(row.page, old);
      const newViewport = (await newDoc.getPage(row.page)).getViewport({ scale: 1 });
      const { matrix, sameSize } = pageAlignTransform(old.viewport, newViewport);
      assert.equal(sameSize, true);
      assert.equal(isIdentity(matrix), row.page !== 2, 'only the rotated reissue moves markups in view space');
      carried.push(...carryMarkups(carryableMarkups(old.models, sheet.page), { matrix, targetPage: row.page,
        source: { sheetId: sheet.id, label: sheet.label, revision: sheet.revision, filePath: sheet.filePath, page: sheet.page },
        usedIds }));
    }
  } finally {
    await newTask.destroy();
  }
  assert.equal(carried.length, 5, 'A-101 (2), A-102 (2) and A-104 (1) markups are carried; A-103 is not reissued');
  const outBytes = await save(newBytes, carried, 4, NEW);

  for (const [page, old] of sources) {
    const after = await readPage(outBytes, page);
    const before = pdfRects(old.raw);
    const now = pdfRects(after.raw);
    assert.equal(now.length, before.length, `page ${page} carries every markup`);
    for (let i = 0; i < before.length; i++) {
      assert.equal(now[i].subtype, before[i].subtype);
      before[i].rect.forEach((value, k) => assert.ok(Math.abs(value - now[i].rect[k]) <= 1,
        `page ${page} ${before[i].subtype} rect ${k}: ${value} vs ${now[i].rect[k]}`));
      if (before[i].line) before[i].line.forEach((value, k) => assert.ok(Math.abs(value - now[i].line[k]) <= 1));
    }
    const oldIds = new Set(old.models.map(m => m.id));
    for (const model of after.models) {
      assert.ok(!oldIds.has(model.id), 'a carried markup has a new durable ID');
      assert.equal(model.carriedFrom.file, OLD);
      assert.equal(model.carriedFrom.revision, 'A');
      assert.ok(oldIds.has(model.carriedFrom.markupId), 'carriedFrom names the source markup ID');
      assert.equal(model.replies.at(-1).text, 'Carried from Rev A');
    }
  }
  // The rotated reissue keeps the markups on the same drawing content (PDF user space).
  const rotated = await readPage(outBytes, 2);
  assert.equal(rotated.viewport.rotation, 90);

  const outputs = new Map([[NEW, { path: OUT, fingerprint: 'b'.repeat(64) }]]);
  const result = applySlipSheet(set, rows, { revision: 'B', changedAt: '2026-10-14T10:00:00.000Z', outputs, pageCounts: { [NEW]: 4 } });
  const next = parseSheetRegister(JSON.parse(JSON.stringify(result.register)));
  const sheet = label => next.sheets.find(s => s.label === label);
  assert.deepEqual([sheet('A-101').filePath, sheet('A-101').page, sheet('A-101').revision], [OUT, 1, 'B']);
  assert.deepEqual([sheet('A-104').filePath, sheet('A-104').page], [OUT, 3]);
  assert.deepEqual([sheet('A-103').filePath, sheet('A-103').revision], [OLD, 'A'], 'a sheet not in the revision stays current');
  assert.deepEqual([sheet('A-105').filePath, sheet('A-105').page, sheet('A-105').revision], [OUT, 4, 'B']);
  assert.deepEqual(sheet('A-104').history, [{ filePath: OLD, page: 4, revision: 'A', replacedAt: '2026-10-14T10:00:00.000Z', sourceSha256: FP }]);

  // A row read with its own revision keeps it; the others take the common one.
  const own = rows.map(row => (row.page === 1 ? { ...row, revision: 'C' } : row));
  const mixed = applySlipSheet(set, own, { revision: 'B', changedAt: '2026-10-14T10:00:00.000Z', outputs, pageCounts: { [NEW]: 4 } }).register;
  assert.deepEqual(mixed.sheets.filter(s => ['A-101', 'A-104'].includes(s.label)).map(s => [s.label, s.revision]).sort(), [['A-101', 'C'], ['A-104', 'B']]);
  assert.throws(() => applySlipSheet(set, own, { revision: '', outputs }), /Enter the new revision/);
  const allOwn = rows.map(row => ({ ...row, revision: `R${row.page}` }));
  assert.equal(applySlipSheet(set, allOwn, { revision: '', outputs, pageCounts: { [NEW]: 4 } }).register.sheets
    .find(s => s.label === 'A-101').revision, 'R1', 'no common revision is needed when every row has its own');

  // Set history opens the old revision with its original markups.
  const prior = sheet('A-101').history[0];
  const reopened = await readPage(oldBytes, prior.page);
  const original = await readPage(oldBytes, 1);
  assert.deepEqual(reopened.models.map(m => m.id).sort(), original.models.map(m => m.id).sort());
  assert.equal(reopened.models.length, 2);
  assert.ok(reopened.models.every(m => !m.carriedFrom), 'the old revision is not modified');
});

test('sheet IDs that differ only in spacing or Unicode form are reported, not silently merged', () => {
  const sheet = (id, label, page) => ({ id, label, filePath: OLD, page });
  const set = { sheets: [sheet('s1', 'A 101', 1), sheet('s2', 'A  101', 2), sheet('s3', 'A-102', 3),
    sheet('s4', 'É-1', 4), sheet('s5', 'É-1', 5)] };
  const plan = planSlipSheet(set, [{ filePath: NEW, pageCount: 3, pageLabels: ['A 101', 'A-102', 'É-1'],
    titleBlockTexts: ['Sheet A 101', '', 'Sheet É-1'] }]);
  assert.deepEqual(plan.collisions.map(c => c.sheetIds), [['s1', 's2'], ['s4', 's5']]);
  assert.deepEqual(plan.rows.map(row => row.sheetId), [null, 's3', null], 'neither colliding sheet is guessed');
  assert.match(slipSheetCollisionText(plan.collisions), /"A 101" \/ "A {2}101"/);
  assert.equal(slipSheetCollisionText([]), '');
  assert.deepEqual(planSlipSheet({ sheets: [sheet('s3', 'A-102', 3)] }, [{ filePath: NEW, pageCount: 1 }]).collisions, []);
});

test('carried markups keep their links: a Replace stays paired and a reply to a markup left behind is dropped', () => {
  const caret = { id: 'c1', type: 'caret', intent: 'Replace', page: 1, x: 10, y: 10, width: 6, height: 6, groupId: 'c1' };
  const strike = { id: 's1', type: 'textStrikethrough', page: 1, inReplyTo: 'c1', replyType: 'group', groupId: 'c1',
    rects: [{ x: 20, y: 10, width: 40, height: 8 }] };
  const reply = { id: 'n1', type: 'comment', page: 1, x: 70, y: 10, width: 10, height: 10, inReplyTo: 'gone', replyType: 'reply' };
  const carried = carryMarkups([caret, strike, reply], { matrix: [1, 0, 0, 1, 5, 5], targetPage: 3,
    source: { filePath: OLD, page: 1, revision: 'A' } });
  const [newCaret, newStrike, newReply] = carried;
  assert.notEqual(newCaret.id, 'c1');
  assert.equal(newStrike.inReplyTo, newCaret.id, 'the strikeout follows its carried caret');
  assert.equal(newStrike.groupId, newCaret.id);
  assert.equal(newCaret.groupId, newCaret.id);
  assert.equal(newCaret.intent, 'Replace');
  assert.equal(newReply.inReplyTo, undefined, 'no /IRT to a markup that was not carried');
  assert.equal(newReply.replyType, undefined);
  assert.equal(strike.inReplyTo, 'c1', 'the old revision is not modified');

  const [lone] = carryMarkups([caret], { matrix: [1, 0, 0, 1, 0, 0], targetPage: 1,
    source: { filePath: OLD, page: 1, revision: 'A' } });
  assert.equal(lone.intent, undefined, 'a caret carried without its strikeout is a plain insert');
});

test('carriedFrom text is bounded and validated; appended labels stay unique', () => {
  const text = carriedFromText({ file: 'C:/a.pdf', page: 2, revision: 'A', markupId: 'abc', extra: 'x' });
  assert.deepEqual(parseCarriedFrom(text), { file: 'C:/a.pdf', page: 2, revision: 'A', markupId: 'abc' });
  assert.equal(parseCarriedFrom('{"file":"x"}'), null, 'a reference needs its page');
  assert.equal(parseCarriedFrom('not json'), null);
  assert.equal(parseCarriedFrom('x'.repeat(5000)), null);
  assert.equal(parseCarriedFrom(JSON.stringify({ file: 'a', page: 1, markupId: 'bad id!' })).markupId, undefined);
  const set = { sheets: [{ label: 'A-105' }, { label: 'rev-b-4' }] };
  assert.equal(appendedSheetLabel(set, NEW, 4, 4, 'A-105'), 'A-105-2');
  assert.equal(appendedSheetLabel(set, NEW, 4, 4, '4'), 'rev-b-4-2');
});

test('carried markups bring the column, status-set and layer definitions they need', async () => {
  const { mergeCarriedSettings } = await import('./slip-sheet-carry.js');
  const source = { markupTextColumnName: 'Trade', markupChoiceColumn: { name: 'Phase', options: ['1', '2'] },
    markupStatusSet: { name: 'Review' },
    annotationLayers: [{ id: 'default', name: 'Default' }, { id: 'mep', name: 'MEP' }, { id: 'arch', name: 'Arch' }] };
  const fresh = {};
  assert.deepEqual(mergeCarriedSettings(fresh, source, [{ layer: 'mep' }]),
    ['markupTextColumnName', 'markupChoiceColumn', 'markupStatusSet', 'annotationLayers']);
  assert.deepEqual(fresh.annotationLayers.map(layer => layer.id), ['default', 'mep', 'arch']);
  assert.notEqual(fresh.markupChoiceColumn, source.markupChoiceColumn, 'definitions are copied, not shared');
  const layered = { markupTextColumnName: 'Own', markupStatusSet: false, annotationLayers: [{ id: 'default', name: 'Default' }] };
  assert.deepEqual(mergeCarriedSettings(layered, source, [{ layer: 'mep' }, {}]), ['markupChoiceColumn', 'annotationLayers']);
  assert.equal(layered.markupTextColumnName, 'Own', 'the target keeps its own settings');
  assert.equal(layered.markupStatusSet, false, 'a document that turned statuses off keeps them off');
  assert.deepEqual(layered.annotationLayers.map(layer => layer.id), ['default', 'mep']);
});

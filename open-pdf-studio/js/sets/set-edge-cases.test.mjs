import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { addPdfPages, fingerprintPdfBytes, inspectPdfPages } from './pdf-page-import.js';
import { buildCurrentSetPdf } from './publish-current-pdf.js';
import {
  addSheet, createSheetRegister, drawingLogCsv, parseSheetRegister, replaceSheet, relinkHistoricalSource,
  sortSheetsByLabel,
} from './sheet-register.js';
import { applySlipSheet } from './slip-sheet-carry.js';
import { planSlipSheet, slipSheetRowErrors } from './slip-sheet-match.js';

async function pdfBytes(draw) {
  const pdf = await PDFDocument.create();
  draw(pdf);
  return new Uint8Array(await pdf.save());
}

async function fingerprinted(bytes) {
  const loaded = await PDFDocument.load(bytes);
  return { bytes, fingerprint: await fingerprintPdfBytes(bytes), pageCount: loaded.getPageCount() };
}

function pageLabel(pdf, label) {
  pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({
    Nums: [0, { P: PDFHexString.fromText(label) }],
  }));
}

async function mustReject(promise, pattern) {
  const result = await promise.then(
    (bytes) => ({ bytes }),
    (error) => ({ error }),
  );
  assert.equal(result.bytes, undefined);
  assert.match(result.error.message, pattern);
}

function snapshot(sheet) {
  return {
    id: sheet.id, label: sheet.label, title: sheet.title, revision: sheet.revision,
    filePath: sheet.filePath, page: sheet.page, sourceSha256: sheet.sourceSha256,
    history: sheet.history, sourceAliases: sheet.sourceAliases,
  };
}

test('historical relink of sheet B leaves sheet A path, fingerprint, and history unchanged', async () => {
  const aOld = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 earlier')));
  const aCurrent = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 current')));
  const bOld = await fingerprinted(await pdfBytes(pdf => {
    pdf.addPage([612, 792]).drawText('B-201 unused page');
    pdf.addPage([612, 792]).drawText('B-201 recorded page');
  }));
  const bMoved = await fingerprinted(Uint8Array.from(bOld.bytes));
  const bCurrent = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('B-201 current')));
  assert.equal(bOld.pageCount, 2);
  assert.equal(bMoved.fingerprint, bOld.fingerprint);
  assert.equal(bMoved.pageCount, bOld.pageCount);

  const addedA = addSheet(createSheetRegister('Site set'), {
    filePath: '/plans/a-old.pdf', label: 'A-101', title: 'Lobby', revision: 'A', page: 1, sourceSha256: aOld.fingerprint,
  });
  let register = replaceSheet(addedA.register, addedA.sheet.id, '/plans/a-current.pdf', 'B', '2026-10-01T00:00:00.000Z', 1, aCurrent.fingerprint);
  const addedB = addSheet(register, {
    filePath: '/plans/b-old.pdf', label: 'B-201', title: 'Roof', revision: 'A', page: 2, sourceSha256: bOld.fingerprint,
  });
  register = replaceSheet(addedB.register, addedB.sheet.id, '/plans/b-current.pdf', 'B', '2026-10-12T00:00:00.000Z', 1, bCurrent.fingerprint);
  const beforeA = snapshot(register.sheets.find(sheet => sheet.label === 'A-101'));
  const beforeB = snapshot(register.sheets.find(sheet => sheet.label === 'B-201'));
  assert.equal(beforeB.history[0].page <= bMoved.pageCount, true);

  const moved = relinkHistoricalSource(register, addedB.sheet.id, 0, '/plans/b-archive.pdf', bMoved.fingerprint, bMoved.pageCount);
  const afterA = snapshot(moved.sheets.find(sheet => sheet.id === beforeA.id));
  const afterB = snapshot(moved.sheets.find(sheet => sheet.id === beforeB.id));
  assert.deepEqual(afterA, beforeA);
  assert.equal(afterA.filePath, '/plans/a-current.pdf');
  assert.equal(afterA.sourceSha256, aCurrent.fingerprint);
  assert.deepEqual(afterA.history, beforeA.history);
  assert.equal(afterB.filePath, beforeB.filePath);
  assert.equal(afterB.sourceSha256, beforeB.sourceSha256);
  assert.equal(afterB.page, beforeB.page);
  assert.equal(afterB.revision, beforeB.revision);
  assert.equal(afterB.history[0].filePath, '/plans/b-archive.pdf');
  assert.equal(afterB.history[0].page, 2);
  assert.equal(afterB.history[0].sourceSha256, bOld.fingerprint);
  assert.equal(afterB.history[0].revision, beforeB.history[0].revision);
  assert.equal(afterB.history[0].replacedAt, beforeB.history[0].replacedAt);
  assert.deepEqual(snapshot(register.sheets.find(sheet => sheet.id === beforeA.id)), beforeA);
  assert.deepEqual(moved.sheets.map(sheet => sheet.label), ['A-101', 'B-201']);
  assert.deepEqual(parseSheetRegister(JSON.stringify(moved)), moved);
});

test('historical relink without a recorded fingerprint is rejected and leaves both sheets unchanged', async () => {
  const aOld = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 earlier')));
  const aCurrent = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 current')));
  const bCurrent = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('B-201 current')));
  const archive = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('B-201 unrecorded earlier')));
  const addedA = addSheet(createSheetRegister('Site set'), {
    filePath: '/plans/a-old.pdf', label: 'A-101', title: 'Lobby', revision: 'A', page: 1, sourceSha256: aOld.fingerprint,
  });
  let register = replaceSheet(addedA.register, addedA.sheet.id, '/plans/a-current.pdf', 'B', '2026-10-01T00:00:00.000Z', 1, aCurrent.fingerprint);
  const addedB = addSheet(register, {
    filePath: '/plans/b-old.pdf', label: 'B-201', title: 'Roof', revision: 'A', page: 1,
  });
  register = replaceSheet(addedB.register, addedB.sheet.id, '/plans/b-current.pdf', 'C', '2026-10-12T00:00:00.000Z', 1, bCurrent.fingerprint);
  const sheetB = register.sheets.find(sheet => sheet.label === 'B-201');
  assert.equal(sheetB.history[0].sourceSha256, undefined);
  const before = structuredClone(register);
  const beforeA = snapshot(register.sheets.find(sheet => sheet.label === 'A-101'));

  assert.throws(
    () => relinkHistoricalSource(register, sheetB.id, 0, '/plans/b-archive.pdf', archive.fingerprint, archive.pageCount),
    /This earlier revision has no recorded PDF fingerprint\. Reimport it at its recorded path before relinking\./,
  );

  assert.deepEqual(register, before);
  const afterA = snapshot(register.sheets.find(sheet => sheet.label === 'A-101'));
  const afterB = snapshot(register.sheets.find(sheet => sheet.label === 'B-201'));
  assert.deepEqual(afterA, beforeA);
  assert.equal(afterA.filePath, '/plans/a-current.pdf');
  assert.equal(afterA.sourceSha256, aCurrent.fingerprint);
  assert.deepEqual(afterA.history, beforeA.history);
  assert.equal(afterB.filePath, '/plans/b-current.pdf');
  assert.equal(afterB.history[0].filePath, '/plans/b-old.pdf');
  assert.equal(afterB.history[0].sourceSha256, undefined);
});

test('slip sheet planning keeps an unmatched sheet and applies only the matched row', async () => {
  const sheetAPdf = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 current')));
  const sheetBPdf = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('B-201 current')));
  const revisedBytes = await pdfBytes(pdf => {
    pdf.addPage([612, 792]).drawText('A-101 revision B');
    pageLabel(pdf, 'A-101');
  });
  const revised = await fingerprinted(revisedBytes);
  const inspected = await inspectPdfPages(revisedBytes);
  assert.equal(inspected.pageCount, 1);
  assert.deepEqual(inspected.pageLabels, ['A-101']);
  const revisedPath = '/revised/lobby.pdf';
  const addedA = addSheet(createSheetRegister('Site set'), {
    filePath: '/plans/a-current.pdf', label: 'A-101', title: 'Lobby', revision: 'A', page: 1, sourceSha256: sheetAPdf.fingerprint,
  });
  const addedB = addSheet(addedA.register, {
    filePath: '/plans/b-current.pdf', label: 'B-201', title: 'Roof', revision: 'A', page: 1, sourceSha256: sheetBPdf.fingerprint,
  });
  const register = addedB.register;
  const before = structuredClone(register);
  const plan = planSlipSheet(register, [{
    filePath: revisedPath, pageCount: inspected.pageCount, pageLabels: inspected.pageLabels,
  }]);
  const errors = slipSheetRowErrors(register, plan.rows);
  assert.deepEqual(register, before);
  assert.deepEqual(errors, []);
  assert.deepEqual(plan, {
    conflicts: [],
    collisions: [],
    rows: [{
      key: `${revisedPath}#1`, filePath: revisedPath, page: 1, pageLabel: 'A-101',
      sheetId: addedA.sheet.id, reason: 'label', include: true,
    }],
  });

  const applied = applySlipSheet(register, plan.rows, {
    revision: 'B', changedAt: '2026-10-18T00:00:00.000Z',
    outputs: new Map([[revisedPath, { path: revisedPath, fingerprint: revised.fingerprint }]]),
    pageCounts: { [revisedPath]: inspected.pageCount },
  });
  assert.deepEqual(register, before);
  assert.deepEqual(applied.replaced, [addedA.sheet.id]);
  assert.deepEqual(applied.appended, []);
  assert.deepEqual(applied.register.sheets.map(sheet => sheet.label), ['A-101', 'B-201']);
  const nextA = applied.register.sheets.find(sheet => sheet.id === addedA.sheet.id);
  const nextB = applied.register.sheets.find(sheet => sheet.id === addedB.sheet.id);
  assert.equal(nextA.filePath, revisedPath);
  assert.equal(nextA.page, 1);
  assert.equal(nextA.revision, 'B');
  assert.equal(nextA.sourceSha256, revised.fingerprint);
  assert.deepEqual(nextA.history, [{
    filePath: '/plans/a-current.pdf', page: 1, revision: 'A', replacedAt: '2026-10-18T00:00:00.000Z',
    sourceSha256: sheetAPdf.fingerprint,
  }]);
  assert.deepEqual(nextB, addedB.sheet);
  assert.equal(nextB.label, 'B-201');
  assert.equal(nextB.filePath, '/plans/b-current.pdf');
  assert.equal(nextB.sourceSha256, sheetBPdf.fingerprint);
  assert.deepEqual(nextB.history, []);
  assert.deepEqual(parseSheetRegister(JSON.stringify(applied.register)), applied.register);
});

test('buildCurrentSetPdf on an empty register throws', async () => {
  let reads = 0;
  await mustReject(
    buildCurrentSetPdf(createSheetRegister('Empty set'), async () => { reads += 1; return new Uint8Array([1]); }),
    /Add sheets before publishing the drawing set\./,
  );
  assert.equal(reads, 0);
});

async function twoSheetSet(aFingerprint, bFingerprint) {
  const addedA = addSheet(createSheetRegister('Site set'), {
    filePath: '/plans/a.pdf', label: 'A-101', title: 'Lobby', revision: 'A', page: 1, sourceSha256: aFingerprint,
  });
  const addedB = addSheet(addedA.register, {
    filePath: '/plans/b.pdf', label: 'B-201', title: 'Roof', revision: 'A', page: 1, sourceSha256: bFingerprint,
  });
  assert.deepEqual(sortSheetsByLabel(addedB.register.sheets).map(sheet => sheet.label), ['A-101', 'B-201']);
  return addedB.register;
}

test('a signed second sheet rejects the set and returns no bytes', async () => {
  const first = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 unsigned')));
  const signed = await pdfBytes(pdf => {
    pdf.addPage([612, 792]);
    const signedField = pdf.context.obj({ FT: 'Sig', T: 'Approval', V: { Type: 'Sig', ByteRange: [0, 1, 2, 3] } });
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [signedField] }));
  });
  const second = await fingerprinted(signed);
  const register = await twoSheetSet(first.fingerprint, second.fingerprint);
  await mustReject(
    buildCurrentSetPdf(register, async (filePath) => filePath.endsWith('/b.pdf') ? second.bytes : first.bytes),
    /B-201: signed or certified PDFs cannot be combined/,
  );
});

test('a source whose bytes do not match sourceSha256 rejects and names that sheet', async () => {
  const first = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 lobby')));
  const second = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('B-201 roof')));
  const decoy = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('different drawing')));
  assert.notEqual(decoy.fingerprint, first.fingerprint);
  assert.notEqual(decoy.fingerprint, second.fingerprint);

  const laterMismatch = await twoSheetSet(first.fingerprint, decoy.fingerprint);
  await mustReject(
    buildCurrentSetPdf(laterMismatch, async (filePath) => filePath.endsWith('/b.pdf') ? second.bytes : first.bytes),
    /B-201: current PDF changed at \/plans\/b\.pdf/,
  );

  const earlierMismatch = await twoSheetSet(decoy.fingerprint, second.fingerprint);
  await mustReject(
    buildCurrentSetPdf(earlierMismatch, async (filePath) => filePath.endsWith('/a.pdf') ? first.bytes : second.bytes),
    /A-101: current PDF changed at \/plans\/a\.pdf/,
  );
});

test('a missing or empty source rejects as unavailable and does not return the other sheet', async () => {
  const first = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('A-101 lobby')));
  const second = await fingerprinted(await pdfBytes(pdf => pdf.addPage([612, 792]).drawText('B-201 roof')));
  const register = await twoSheetSet(first.fingerprint, second.fingerprint);

  await mustReject(
    buildCurrentSetPdf(register, async (filePath) => {
      if (filePath.endsWith('/b.pdf')) throw new Error('ENOENT');
      return first.bytes;
    }),
    /B-201: current PDF is unavailable at \/plans\/b\.pdf/,
  );
  await mustReject(
    buildCurrentSetPdf(register, async (filePath) => filePath.endsWith('/b.pdf') ? new Uint8Array() : first.bytes),
    /B-201: current PDF is unavailable at \/plans\/b\.pdf/,
  );
  await mustReject(
    buildCurrentSetPdf(register, async (filePath) => {
      if (filePath.endsWith('/a.pdf')) throw new Error('ENOENT');
      return second.bytes;
    }),
    /A-101: current PDF is unavailable at \/plans\/a\.pdf/,
  );
  await mustReject(
    buildCurrentSetPdf(register, async () => new Uint8Array()),
    /A-101: current PDF is unavailable at \/plans\/a\.pdf/,
  );
});

test('two pages that share a label get distinct sheet IDs and the drawing log lists both', async () => {
  const bytes = await pdfBytes(pdf => {
    pdf.addPage([612, 792]).drawText('shared label page 1');
    pdf.addPage([612, 792]).drawText('shared label page 2');
    pageLabel(pdf, 'A-101');
  });
  const inspected = await inspectPdfPages(bytes);
  assert.equal(inspected.pageCount, 2);
  assert.deepEqual(inspected.pageLabels, ['A-101', 'A-101']);
  const { fingerprint } = await fingerprinted(bytes);
  const imported = addPdfPages(createSheetRegister('Shared labels'), '/plans/shared.pdf', inspected.pageCount, inspected.pageLabels, fingerprint);
  assert.equal(imported.added.length, 2);
  assert.deepEqual(imported.added.map(sheet => sheet.label), ['A-101', 'A-101-2']);
  assert.deepEqual(imported.added.map(sheet => sheet.page), [1, 2]);
  assert.notEqual(imported.added[0].id, imported.added[1].id);
  const saved = parseSheetRegister(JSON.stringify(imported.register));
  assert.deepEqual(saved.sheets.map(sheet => sheet.id), imported.register.sheets.map(sheet => sheet.id));
  const csv = drawingLogCsv(saved);
  const rows = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n').slice(1);
  const listedIds = rows.map(row => row.split(',')[0].replaceAll('"', ''));
  assert.deepEqual(listedIds, saved.sheets.map(sheet => sheet.id));
  assert.equal(new Set(listedIds).size, 2);
  assert.match(csv, /"A-101"/);
  assert.match(csv, /"A-101-2"/);
});

// Unsaved markups are kept for after a crash and put back into the reopened
// drawing (crash-recovery.js).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECOVERY_VERSION, applyRecoveredMarkups, parseRecovery, recoveryEntry, recoverySignature, recoverySnapshot,
} from './crash-recovery.js';

const markup = (id, page, extra = {}) => ({ id, type: 'rectangle', page, x: 10, y: 20, width: 30, height: 40, ...extra });

function openDoc(extra = {}) {
  return {
    filePath: '/drawings/set.pdf',
    fileName: 'set.pdf',
    modified: true,
    currentPage: 3,
    pdfDoc: { numPages: 5 },
    annotations: [markup('a', 1), markup('b', 3, { color: '#f00' }), markup('c', 3)],
    _annotationPagesReady: new Set([1, 2, 3]),
    savedUndoStackLength: 4,
    ...extra,
  };
}

test('a document without unsaved changes is not kept', () => {
  assert.equal(recoveryEntry(openDoc({ modified: false })), null);
  assert.equal(recoveryEntry(openDoc({ filePath: null })), null);
  assert.deepEqual(recoverySnapshot([openDoc({ modified: false })], 7), { version: RECOVERY_VERSION, savedAt: 7, documents: [] });
});

test('the markups of every read page are kept, as copies', () => {
  const doc = openDoc();
  const entry = recoveryEntry(doc);
  assert.deepEqual(entry.pages, [1, 2, 3]);
  assert.deepEqual(entry.annotations.map((a) => a.id), ['a', 'b', 'c']);
  assert.equal(entry.numPages, 5);
  assert.equal(entry.currentPage, 3);
  assert.notEqual(entry.annotations[1], doc.annotations[1]);
  doc.annotations[1].color = '#00f';
  assert.equal(entry.annotations[1].color, '#f00');
});

test('a page with markups counts as read even when its read flag is missing', () => {
  const entry = recoveryEntry(openDoc({ _annotationPagesReady: new Set([1]) }));
  assert.deepEqual(entry.pages, [1, 3]);
});

test('the snapshot round-trips through the file text', () => {
  const snapshot = recoverySnapshot([openDoc(), openDoc({ filePath: '/drawings/other.pdf', modified: false })], 1234);
  const parsed = parseRecovery(JSON.stringify(snapshot));
  assert.equal(parsed.savedAt, 1234);
  assert.equal(parsed.documents.length, 1);
  assert.equal(parsed.documents[0].filePath, '/drawings/set.pdf');
});

test('a damaged or foreign file gives nothing to recover', () => {
  assert.equal(parseRecovery(''), null);
  assert.equal(parseRecovery('{'), null);
  assert.equal(parseRecovery(JSON.stringify({ version: 99, documents: [] })), null);
  assert.equal(parseRecovery(JSON.stringify({ version: RECOVERY_VERSION, documents: [] })), null);
  // An entry whose markup sits on a page it does not list is dropped.
  const bad = { version: RECOVERY_VERSION, documents: [{ filePath: '/x.pdf', pages: [1], annotations: [markup('z', 2)] }] };
  assert.equal(parseRecovery(JSON.stringify(bad)), null);
});

test('the signature changes with the history, the markups and the read pages', () => {
  const doc = openDoc();
  const history = new Map([[doc, 2]]);
  const sig = () => recoverySignature([doc], (d) => history.get(d) || 0);
  const first = sig();
  history.set(doc, 3);
  assert.notEqual(sig(), first);
  const second = sig();
  doc.annotations.push(markup('d', 2));
  assert.notEqual(sig(), second);
  const third = sig();
  doc._annotationPagesReady.add(4);
  assert.notEqual(sig(), third);
  assert.equal(sig(), sig());
});

test('recovered markups replace the read markups of their pages', async () => {
  const entry = recoveryEntry(openDoc());
  // The reopened drawing: page 1 read from the file (its old markup and one
  // the user had deleted), page 3 not read yet.
  const doc = {
    filePath: '/drawings/set.pdf', pdfDoc: { numPages: 5 }, modified: false, savedUndoStackLength: 0,
    annotations: [markup('a', 1), markup('deleted-before-crash', 1), markup('p5', 5)],
  };
  const read = [];
  const ensurePage = async (page, d) => {
    read.push(page);
    if (page === 3) d.annotations.push(markup('b', 3));
  };
  const result = await applyRecoveredMarkups(doc, entry, { ensurePage });
  assert.deepEqual(read, [1, 2, 3]);
  assert.equal(result.restored, 3);
  assert.deepEqual(doc.annotations.map((a) => a.id).sort(), ['a', 'b', 'c', 'p5']);
  assert.equal(doc.annotations.find((a) => a.id === 'b').color, '#f00');
  assert.equal(doc.modified, true);
  assert.equal(doc.savedUndoStackLength, -1);
});

test('markups are not put on a drawing whose page count changed', async () => {
  const entry = recoveryEntry(openDoc());
  const doc = { filePath: '/drawings/set.pdf', pdfDoc: { numPages: 4 }, annotations: [], modified: false };
  const result = await applyRecoveredMarkups(doc, entry, { ensurePage: async () => { throw new Error('not read'); } });
  assert.deepEqual(result, { restored: 0, skipped: 'page-count' });
  assert.equal(doc.modified, false);
});

test('a working copy keeps saving to the original', async () => {
  const entry = recoveryEntry(openDoc({ filePath: '/tmp-dir/edit-1.pdf', saveTargetPath: '/drawings/set.pdf', _renderTemp: true }));
  assert.equal(entry.saveTargetPath, '/drawings/set.pdf');
  const doc = { filePath: '/tmp-dir/edit-1.pdf', pdfDoc: { numPages: 5 }, annotations: [] };
  await applyRecoveredMarkups(doc, entry, { ensurePage: async () => {} });
  assert.equal(doc.saveTargetPath, '/drawings/set.pdf');
  assert.equal(doc._renderTemp, true);
});

test('the app offers the kept markups before it starts writing the file again', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const start = main.slice(main.indexOf('async function restoreAfterStart'));
  const offer = start.indexOf('await offerCrashRecovery(');
  const autosave = start.indexOf('startCrashRecoveryAutosave(');
  assert.ok(offer > 0 && autosave > offer, 'offer first, then autosave');
  assert.match(start, /restoreLastSession\(\{ afterCrash: !!notice \}\)/);
  // A clean close removes the file once every drawing is closed.
  assert.match(main, /await saveSessionData\(\);\s*\/\/[^\n]*\n\s*await clearCrashRecovery\(\);/);
});

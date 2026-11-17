import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSheetRegister, addSheet, updateSheet, replaceSheet, relinkSheet, relinkHistoricalSource, removeSheet,
  parseSheetRegister, filterSheets, sortSheetsByLabel, adjacentSheet, drawingLogCsv,
} from './sheet-register.js';

test('repeat import is idempotent and duplicate IDs are rejected', () => {
  const first = addSheet(createSheetRegister(), { filePath: '/plans/A-101.pdf', label: 'A-101', page: 1 });
  assert.equal(first.added, true);
  assert.equal(addSheet(first.register, { filePath: '/plans/A-101.pdf', label: 'unused', page: 1 }).added, false);
  assert.throws(() => addSheet(first.register, { filePath: '/plans/A-102.pdf', label: 'a-101' }), /already/);
  assert.throws(() => updateSheet(first.register, first.sheet.id, { page: 0 }), /Page/);
});

test('editing a page cannot assign the same PDF page to two sheets', () => {
  const first = addSheet(createSheetRegister(), { filePath: '/plans/A.pdf', label: 'A-101', page: 1 });
  const second = addSheet(first.register, { filePath: '/plans/A.pdf', label: 'A-102', page: 2 });
  assert.throws(() => updateSheet(second.register, second.sheet.id, { page: 1 }), /already registered/);
  assert.equal(second.register.sheets[1].page, 2);
  assert.equal(updateSheet(second.register, second.sheet.id, { page: 3 }).sheets[1].page, 3);
});

test('replacement keeps sheet identity and prior revision; relink does not create a revision', () => {
  const first = addSheet(createSheetRegister(), { filePath: '/plans/old.pdf', label: 'A-101', revision: 'A' });
  const next = replaceSheet(first.register, first.sheet.id, '/plans/new.pdf', 'B', '2026-10-13T00:00:00.000Z', 3);
  assert.equal(next.sheets[0].id, first.sheet.id);
  assert.deepEqual(next.sheets[0].history, [{ filePath: '/plans/old.pdf', page: 1, revision: 'A', replacedAt: '2026-10-13T00:00:00.000Z' }]);
  assert.equal(next.sheets[0].page, 3);
  assert.equal(replaceSheet(next, first.sheet.id, '/plans/new.pdf', 'B', 'ignored', 3), next);
  const relinked = relinkSheet(next, first.sheet.id, '/moved/new.pdf', 2);
  assert.equal(relinked.sheets[0].history.length, 1);
  assert.equal(relinked.sheets[0].page, 2);
  assert.deepEqual(relinked.sheets[0].sourceAliases, [{ filePath: '/plans/new.pdf', page: 3 }]);
  assert.equal(relinkSheet(relinked, first.sheet.id, '/moved/new.pdf', 2), relinked);
  assert.deepEqual(relinkSheet(relinked, first.sheet.id, '/plans/new.pdf', 3).sheets[0].sourceAliases,
    [{ filePath: '/moved/new.pdf', page: 2 }]);
  assert.equal(parseSheetRegister(JSON.stringify(relinked)).sheets[0].filePath, '/moved/new.pdf');
  assert.equal(removeSheet(relinked, first.sheet.id).sheets.length, 0);
});

test('current relink keeps a recorded PDF fingerprint; changed contents need a new revision', () => {
  const oldHash = 'a'.repeat(64);
  const newHash = 'b'.repeat(64);
  const first = addSheet(createSheetRegister(), {
    filePath: '/plans/issued.pdf', label: 'A-101', page: 1, revision: 'A', sourceSha256: oldHash,
  });
  assert.throws(() => relinkSheet(first.register, first.sheet.id, '/plans/unrelated.pdf', 1, newHash), /does not match/);
  assert.throws(() => relinkSheet(first.register, first.sheet.id, '/plans/issued.pdf', 1, newHash), /does not match/);
  assert.throws(() => relinkSheet(first.register, first.sheet.id, '/plans/unknown.pdf', 1), /does not match/);
  assert.equal(first.register.sheets[0].filePath, '/plans/issued.pdf');

  const moved = relinkSheet(first.register, first.sheet.id, '/plans/moved.pdf', 1, oldHash);
  assert.equal(moved.sheets[0].id, first.sheet.id);
  assert.equal(moved.sheets[0].sourceSha256, oldHash);
  assert.equal(moved.sheets[0].history.length, 0);
  assert.throws(() => replaceSheet(first.register, first.sheet.id, '/plans/issued.pdf', 'A', 'now', 1, newHash), /new revision/);
  const revised = replaceSheet(first.register, first.sheet.id, '/plans/issued.pdf', 'B', 'now', 1, newHash);
  assert.equal(revised.sheets[0].sourceSha256, newHash);
  assert.equal(revised.sheets[0].history[0].sourceSha256, oldHash);
});

test('revision and relink reject pages already used by another sheet', () => {
  const initial = addSheet(createSheetRegister(), { filePath: '/plans/old.pdf', label: 'A-101', page: 1 });
  const second = addSheet(initial.register, { filePath: '/plans/new.pdf', label: 'A-102', page: 2 });
  assert.throws(() => replaceSheet(second.register, initial.sheet.id, '/plans/new.pdf', 'B', 'now', 2), /already registered/);
  assert.throws(() => relinkSheet(second.register, initial.sheet.id, '/plans/new.pdf', 2), /already registered/);
  assert.throws(() => replaceSheet(second.register, initial.sheet.id, '/plans/new.pdf', 'B', 'now', 0), /Page/);
  assert.deepEqual(second.register.sheets[0].history, []);
});

test('historical relink changes only the recorded path after exact PDF and page checks', () => {
  const oldHash = 'a'.repeat(64);
  const currentHash = 'b'.repeat(64);
  const first = addSheet(createSheetRegister(), { filePath: '/old.pdf', label: 'A-101', page: 2, revision: 'A', sourceSha256: oldHash });
  const revised = replaceSheet(first.register, first.sheet.id, '/current.pdf', 'B', '2026-10-13T00:00:00Z', 1, currentHash);
  const moved = relinkHistoricalSource(revised, first.sheet.id, 0, '/moved/old.pdf', oldHash, 2);
  assert.equal(moved.sheets[0].id, first.sheet.id);
  assert.equal(moved.sheets[0].filePath, '/current.pdf');
  assert.equal(moved.sheets[0].sourceSha256, currentHash);
  assert.equal(moved.sheets[0].revision, 'B');
  assert.deepEqual(moved.sheets[0].history, [{
    filePath: '/moved/old.pdf', page: 2, revision: 'A', replacedAt: '2026-10-13T00:00:00Z', sourceSha256: oldHash,
  }]);
  assert.equal(relinkHistoricalSource(moved, first.sheet.id, 0, '/moved/old.pdf', oldHash, 2), moved);
  assert.deepEqual(parseSheetRegister(JSON.stringify(moved)), moved);
  assert.deepEqual(revised.sheets[0].history[0].filePath, '/old.pdf');
});

test('historical relink rejects changed bytes, missing recorded page, unknown identity and owned sources', () => {
  const oldHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const first = addSheet(createSheetRegister(), { filePath: '/old.pdf', label: 'A-101', page: 2, revision: 'A', sourceSha256: oldHash });
  const revised = replaceSheet(first.register, first.sheet.id, '/current.pdf', 'B', 'now', 1, otherHash);
  const another = addSheet(revised, { filePath: '/used.pdf', label: 'A-102', page: 2, sourceSha256: oldHash }).register;
  assert.throws(() => relinkHistoricalSource(another, first.sheet.id, 0, '/wrong.pdf', otherHash, 2), /does not match/);
  assert.throws(() => relinkHistoricalSource(another, first.sheet.id, 0, '/short.pdf', oldHash, 1), /recorded page 2/);
  assert.throws(() => relinkHistoricalSource(another, first.sheet.id, 0, '/used.pdf', oldHash, 2), /another sheet/);
  assert.throws(() => relinkHistoricalSource(another, first.sheet.id, 0, '/current.pdf', oldHash, 2), /different contents/);
  assert.throws(() => relinkHistoricalSource(another, first.sheet.id, 8, '/moved.pdf', oldHash, 2), /no longer/);
  const legacyInitial = addSheet(createSheetRegister(), { filePath: '/legacy.pdf', label: 'A-101' });
  const legacy = replaceSheet(legacyInitial.register, legacyInitial.sheet.id, '/next.pdf', 'B', 'now');
  // Use the actual legacy sheet ID; old manifests cannot prove that an arbitrary replacement PDF is identical.
  const legacySheet = legacy.sheets[0];
  assert.throws(() => relinkHistoricalSource(legacy, legacySheet.id, 0, '/maybe.pdf', oldHash, 1), /no recorded PDF fingerprint/);
});

test('one PDF source page belongs to one stable sheet across history and relinks', () => {
  const original = addSheet(createSheetRegister(), { filePath: '/plans/issued.pdf', label: 'A-101' });
  const revised = replaceSheet(original.register, original.sheet.id, '/plans/revised.pdf', 'B', 'now', 2);
  const moved = relinkSheet(revised, original.sheet.id, '/plans/moved.pdf', 3);
  const other = addSheet(moved, { filePath: '/plans/issued.pdf', page: 2, label: 'A-102' });

  for (const [path, page] of [
    ['/plans/issued.pdf', 1], ['/plans/revised.pdf', 2], ['/plans/moved.pdf', 3],
  ]) {
    const repeated = addSheet(other.register, { filePath: path, page, label: 'Duplicate' });
    assert.equal(repeated.added, false);
    assert.equal(repeated.sheet.id, original.sheet.id);
    assert.throws(() => replaceSheet(other.register, other.sheet.id, path, 'C', 'later', page), /already registered/);
    assert.throws(() => relinkSheet(other.register, other.sheet.id, path, page), /already registered/);
  }
  assert.throws(() => updateSheet(other.register, other.sheet.id, { page: 1 }), /already registered/);

  for (const duplicate of [
    { ...other.sheet, id: 'duplicate-current', label: 'A-103', filePath: '/plans/issued.pdf', page: 1 },
    { ...other.sheet, id: 'duplicate-history', label: 'A-103', history: [{ filePath: '/plans/issued.pdf', page: 1, revision: 'A', replacedAt: 'now' }] },
    { ...other.sheet, id: 'duplicate-alias', label: 'A-103', sourceAliases: [{ filePath: '/plans/revised.pdf', page: 2 }] },
  ]) {
    assert.throws(() => parseSheetRegister({ ...moved, sheets: [...moved.sheets, duplicate] }), /multiple sheet IDs/);
  }
  assert.deepEqual(parseSheetRegister(JSON.stringify(moved)), moved);
});

test('bad manifests cannot silently replace the current set', () => {
  const first = addSheet(createSheetRegister(), { filePath: '/a.pdf', label: 'A1' });
  const bad = { ...first.register, sheets: [first.sheet, { ...first.sheet, id: 'another', filePath: '/b.pdf' }] };
  assert.throws(() => parseSheetRegister(bad), /duplicate/);
  assert.throws(() => parseSheetRegister({ ...first.register,
    sheets: [{ ...first.sheet, sourceAliases: 'bad' }] }), /invalid source links/);
  assert.throws(() => parseSheetRegister({ ...first.register,
    sheets: [{ ...first.sheet, sourceSha256: 'not-a-sha256' }] }), /invalid PDF fingerprint/);
  assert.throws(() => parseSheetRegister('{'), /SyntaxError/);
  assert.throws(() => parseSheetRegister({ version: 9, sheets: [], name: 'Future' }), /supported/);
});

test('sheet search matches ID, title, revisions, and current or earlier PDF names while current revision filter is exact', () => {
  const first = addSheet(createSheetRegister(), { filePath: '/plans/first.pdf', label: 'A-101', title: 'Lobby', revision: 'P0' });
  const second = addSheet(first.register, { filePath: 'C:\\Drawings\\second.pdf', label: 'M-201', title: 'Mechanical room', revision: 'C' });
  const revised = replaceSheet(second.register, first.sheet.id, '/plans/revised.pdf', 'B', 'now', 3);
  assert.deepEqual(filterSheets(revised, 'a-101').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'MECHANICAL').map(sheet => sheet.id), [second.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'b').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'p0', 'B').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'REVISED.PDF').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'first.pdf', 'B').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'SECOND.PDF').map(sheet => sheet.id), [second.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'drawings'), []);
  assert.deepEqual(filterSheets(revised, 'second.pdf', 'B'), []);
  assert.deepEqual(filterSheets(revised, 'lobby', 'C'), []);
  assert.deepEqual(filterSheets(revised, '', 'p0'), []);
  assert.deepEqual(filterSheets(revised, '  '), revised.sheets);
});

test('sheet search matches every word across fields and remembered PDF names', () => {
  const first = addSheet(createSheetRegister(), {
    filePath: '/plans/issued.pdf', label: 'A-101', title: 'Main lobby', revision: 'P0',
  });
  const second = addSheet(first.register, {
    filePath: '/plans/issued.pdf', page: 2, label: 'A-102', title: 'Rear lobby', revision: 'P0',
  });
  const moved = relinkSheet(second.register, first.sheet.id, '/new-location/current.pdf');
  const revised = replaceSheet(moved, first.sheet.id, '/plans/revised.pdf', 'B', 'now');

  assert.deepEqual(filterSheets(revised, 'A-101 lobby').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'LOBBY   REVISED').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'issued main').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'current main').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'issued main', 'B').map(sheet => sheet.id), [first.sheet.id]);
  assert.deepEqual(filterSheets(revised, 'issued main', 'P0'), []);
  assert.deepEqual(filterSheets(revised, 'lobby missing'), []);
  assert.deepEqual(filterSheets(revised, 'new-location'), []);
});

test('set navigation uses natural sheet ID order without changing manifest order', () => {
  const ten = addSheet(createSheetRegister(), { filePath: '/plans/ten.pdf', label: 'A-10' });
  const two = addSheet(ten.register, { filePath: '/plans/two.pdf', label: 'A-2', revision: 'B' });
  const one = addSheet(two.register, { filePath: '/plans/one.pdf', label: 'A-1', revision: 'B' });
  const register = one.register;
  const sorted = sortSheetsByLabel(register.sheets);
  assert.deepEqual(register.sheets.map(sheet => sheet.label), ['A-10', 'A-2', 'A-1']);
  assert.deepEqual(sorted.map(sheet => sheet.label), ['A-1', 'A-2', 'A-10']);
  assert.notEqual(sorted, register.sheets);
  assert.equal(adjacentSheet(sorted, null, 'next').id, one.sheet.id);
  assert.equal(adjacentSheet(sorted, one.sheet.id, 'previous'), null);
  assert.equal(adjacentSheet(sorted, one.sheet.id, 'next').id, two.sheet.id);
  assert.equal(adjacentSheet(sorted, ten.sheet.id, 'next'), null);
  const filtered = sortSheetsByLabel(filterSheets(register, '', 'B'));
  assert.deepEqual(filtered.map(sheet => sheet.label), ['A-1', 'A-2']);
  assert.equal(adjacentSheet(filtered, one.sheet.id, 'next').id, two.sheet.id);
  assert.deepEqual(parseSheetRegister(JSON.stringify(register)).sheets.map(sheet => sheet.label), ['A-10', 'A-2', 'A-1']);
});

test('drawing log lists current and prior source records with the same stable sheet ID', () => {
  const oldHash = 'a'.repeat(64);
  const recentHash = 'b'.repeat(64);
  const currentHash = 'c'.repeat(64);
  const initial = addSheet(createSheetRegister(), { filePath: '/plans/old.pdf', label: 'A-101', title: 'Lobby', revision: 'A', page: 1, sourceSha256: oldHash });
  const revised = replaceSheet(initial.register, initial.sheet.id, '/plans/revised.pdf', 'B', '2026-10-13T10:00:00Z', 3, recentHash);
  const moved = relinkSheet(revised, initial.sheet.id, '/plans/moved.pdf', 2, recentHash);
  const latest = replaceSheet(moved, initial.sheet.id, '/plans/final.pdf', 'C', '2026-10-14T10:00:00Z', 4, currentHash);
  const csv = drawingLogCsv(latest, { [initial.sheet.id]: 'Present' });
  const [header, current, recentPrior, oldestPrior] = csv.slice(1).trimEnd().split('\r\n');
  assert.match(header, /"Stable sheet ID","Sheet ID","Title","Source"/);
  assert.match(header, /"Recorded PDF SHA-256"/);
  assert.equal(current, `"${initial.sheet.id}","A-101","Lobby","Current","C","4","/plans/final.pdf","Present","","${currentHash}",""`);
  assert.equal(recentPrior, `"${initial.sheet.id}","A-101","Lobby","Prior","B","2","/plans/moved.pdf","","2026-10-14T10:00:00Z","${recentHash}",""`);
  assert.equal(oldestPrior, `"${initial.sheet.id}","A-101","Lobby","Prior","A","1","/plans/old.pdf","","2026-10-13T10:00:00Z","${oldHash}",""`);
  assert.equal(csv.includes('/plans/revised.pdf'), false);
  assert.deepEqual(parseSheetRegister(JSON.stringify(latest)), latest);
});

test('drawing log quotes paths and neutralizes spreadsheet formulas', () => {
  const first = addSheet(createSheetRegister(), { filePath: '/plans/a,"b.pdf', label: '=A1', title: 'Title, one', revision: 'B' });
  const revised = replaceSheet(first.register, first.sheet.id, '=HYPERLINK("url")', '-C', '2026-10-13T00:00:00Z', 2);
  const csv = drawingLogCsv(revised, { [first.sheet.id]: 'Missing' });
  assert.match(csv, /"'=A1","Title, one"/);
  assert.match(csv, /"'-C","2","'=HYPERLINK\(""url""\)"/);
  assert.match(csv, /"\/plans\/a,""b.pdf"/);
  assert.match(csv, /"Missing"/);
});

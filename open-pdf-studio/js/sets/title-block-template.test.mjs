import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTitleBlockPlan, chooseTitleBlockTemplate, combinedTemplates, createTitleBlockTemplate,
  matchTitleBlockTemplate, parseTitleBlockTemplates, planTitleBlockApply, readTitleBlockFields,
  sameSheetSize, templateAnchors, withTemplate,
} from './title-block-template.js';
import { addSheet, createSheetRegister, drawingLogCsv, parseSheetRegister, replaceSheet, setTitleBlockTemplates, updateSheet } from './sheet-register.js';

// A 24 x 36 in landscape sheet (2592 x 1728 pt) with a title block in the right strip.
const W = 2592;
const H = 1728;
const run = (str, x, y, width = str.length * 8, height = 12) => ({ str, box: { x, y, width, height } });
const BOXES = {
  label: { x: 2400, y: 1600, width: 160, height: 60 },
  title: { x: 2400, y: 1450, width: 180, height: 80 },
  revision: { x: 2400, y: 1380, width: 80, height: 30 },
  date: { x: 2490, y: 1380, width: 90, height: 30 },
};

function sheetRuns({ number = 'E-101', title = ['FIRST FLOOR', 'LIGHTING PLAN'], revision = '2', date = '2026-11-01', firm = 'ACME ENGINEERS', shift = 0 } = {}) {
  return [
    run('ACME', 400, 400), run('3 GENERAL NOTES', 100, 200), // drawing area
    run(firm, 2410 + shift, 1300), run('PROJECT', 2410 + shift, 1330), run('SHEET TITLE', 2410 + shift, 1435),
    run('SHEET NO.', 2410 + shift, 1585), run('REV', 2410 + shift, 1365), run('DATE', 2500 + shift, 1365),
    run('SHEET NO.', 900, 1000), // the same words elsewhere on the page are no anchor
    run(number, 2420 + shift, 1620, 80, 24),
    ...title.map((line, i) => run(line, 2410 + shift, 1470 + i * 16)),
    run(revision, 2420 + shift, 1390), run(date, 2500 + shift, 1390),
  ];
}

const template = () => createTitleBlockTemplate({ id: 't1', name: 'ACME D-size', width: W, height: H, fields: BOXES, runs: sheetRuns() });

test('anchors are the fixed words around the boxes, without numbers or text inside a box', () => {
  const anchors = templateAnchors(sheetRuns(), W, H, Object.values(BOXES));
  const texts = anchors.map(a => a.text);
  assert.ok(texts.includes('SHEET TITLE'));
  assert.ok(texts.includes('ACME ENGINEERS'));
  assert.ok(!texts.includes('E-101'));
  assert.ok(!texts.includes('FIRST FLOOR'), 'a value inside a box is no anchor');
  assert.ok(!texts.includes('3 GENERAL NOTES'));
  assert.ok(!texts.includes('ACME'), 'text far from the title block is no anchor');
  for (const a of anchors) assert.ok(a.x > 0.9 && a.y > 0.7);
});

test('a template keeps its boxes as page fractions and needs the number or title', () => {
  const t = template();
  assert.deepEqual(t.size, { width: W, height: H });
  assert.ok(Math.abs(t.fields.label.x - 2400 / W) < 1e-9);
  assert.throws(() => createTitleBlockTemplate({ name: 'x', width: W, height: H, fields: { date: BOXES.date }, runs: [] }), /sheet number or the sheet title/);
  assert.throws(() => createTitleBlockTemplate({ name: ' ', width: W, height: H, fields: BOXES, runs: [] }), /name is required/);
});

test('reads the fields of another sheet of the layout, stripping a caught field label', () => {
  const page = { width: W, height: H, runs: sheetRuns({ number: 'E - 201', title: ['SECOND FLOOR', 'POWER PLAN'], revision: '3', date: '2026-11-12' }) };
  assert.equal(matchTitleBlockTemplate(template(), page).matches, true);
  assert.deepEqual(readTitleBlockFields(template(), page), { label: 'E-201', title: 'SECOND FLOOR POWER PLAN', revision: '3', date: '2026-11-12' });
  const labelled = { ...page, runs: [...page.runs.filter(r => r.str !== '3'), run('REV: 3', 2410, 1390)] };
  assert.equal(readTitleBlockFields(template(), labelled).revision, '3');
});

test('another page size or another title block layout does not match', () => {
  const size = matchTitleBlockTemplate(template(), { width: 1728, height: W, runs: sheetRuns() });
  assert.equal(size.matches, false);
  assert.match(size.reason, /Page size/);
  const other = matchTitleBlockTemplate(template(), { width: W, height: H, runs: [run('E-301', 2420, 1620), run('OTHER FIRM', 100, 100)] });
  assert.equal(other.matches, false);
  assert.match(other.reason, /fixed words/);
  // A few points of difference in size, and anchors moved a little, still match.
  assert.equal(matchTitleBlockTemplate(template(), { width: W + 1.5, height: H - 1, runs: sheetRuns({ shift: 20 }) }).matches, true);
  assert.equal(sameSheetSize({ width: 612, height: 792 }, { width: 792, height: 612 }), false);
});

test('one changed word of many still matches; most words gone does not', () => {
  const t = template();
  const page = { width: W, height: H, runs: sheetRuns({ firm: 'OTHER ENGINEERS' }) };
  const result = matchTitleBlockTemplate(t, page);
  assert.equal(result.found, result.total - 1);
  assert.equal(result.matches, true);
  const bare = { width: W, height: H, runs: [run('SHEET NO.', 2410, 1585), run('E-101', 2420, 1620)] };
  assert.equal(matchTitleBlockTemplate(t, bare).matches, false);
});

test('the best matching template is chosen; the reasons are given when none matches', () => {
  const generic = { ...template(), id: 'g', name: 'Size only', anchors: [] };
  const page = { width: W, height: H, runs: sheetRuns() };
  assert.equal(chooseTitleBlockTemplate([generic, template()], page).template.id, 't1');
  const none = chooseTitleBlockTemplate([template()], { width: 612, height: 792, runs: [] });
  assert.equal(none.template, null);
  assert.match(none.reasons[0], /^ACME D-size: Page size/);
});

function register3() {
  let reg = createSheetRegister('Set');
  const ids = [];
  for (const [label, page] of [['P1', 1], ['P2', 2], ['P3', 3]]) {
    const added = addSheet(reg, { filePath: '/set.pdf', page, label, sourceSha256: 'a'.repeat(64) });
    reg = added.register;
    ids.push(added.sheet.id);
  }
  return { reg, ids };
}

test('apply fills matching sheets and lists the others unchanged', () => {
  const { reg, ids } = register3();
  const pages = new Map([
    [ids[0], { width: W, height: H, runs: sheetRuns({ number: 'E-101', title: ['LIGHTING PLAN'], revision: '2' }) }],
    [ids[1], { width: 612, height: 792, runs: [] }],
    [ids[2], { error: 'The registered PDF changed.' }],
  ]);
  const plan = planTitleBlockApply(reg, pages, [template()]);
  assert.equal(plan.rows.length, 1);
  assert.deepEqual(plan.rows[0].changes, { label: 'E-101', title: 'LIGHTING PLAN', revision: '2', date: '2026-11-01' });
  assert.deepEqual(plan.unmatched.map(u => u.label), ['P2', 'P3']);
  assert.match(plan.unmatched[1].reason, /changed/);
  const next = applyTitleBlockPlan(reg, plan);
  assert.deepEqual(next.sheets.map(s => s.label), ['E-101', 'P2', 'P3']);
  assert.equal(next.sheets[0].date, '2026-11-01');
  assert.equal(next.sheets[1], reg.sheets[1]);
  assert.deepEqual(parseSheetRegister(JSON.stringify(next)).sheets[0].date, '2026-11-01');
  assert.equal(next.sheets[0].titleBlockTemplate, 't1');
  assert.equal('titleBlockTemplate' in next.sheets[1], false);
  assert.equal(parseSheetRegister(JSON.stringify(next)).sheets[0].titleBlockTemplate, 't1');
  // Applied again with nothing new to read: the register is the same object.
  assert.equal(applyTitleBlockPlan(next, planTitleBlockApply(next, pages, [template()])), next);
  // A new revision is not read by the template yet.
  const revised = replaceSheet(next, ids[0], '/new.pdf', 'B', '2026-11-02T00:00:00Z', 1);
  assert.equal('titleBlockTemplate' in revised.sheets[0], false);
});

test('a sheet number another sheet has or gets is not taken; the other fields still apply', () => {
  const { reg, ids } = register3();
  const page = (number, title) => ({ width: W, height: H, runs: sheetRuns({ number, title: [title] }) });
  const pages = new Map([[ids[0], page('E-1', 'ONE')], [ids[1], page('E-1', 'TWO')], [ids[2], page('P1', 'THREE')]]);
  const plan = planTitleBlockApply(reg, pages, [template()]);
  assert.deepEqual(plan.conflicts.map(c => c.label).sort(), ['P1', 'P2', 'P3']);
  const next = applyTitleBlockPlan(reg, plan);
  assert.deepEqual(next.sheets.map(s => [s.label, s.title]), [['P1', 'ONE'], ['P2', 'TWO'], ['P3', 'THREE']]);
});

test('templates persist in the set manifest and as checked user defaults', () => {
  const t = template();
  const { reg } = register3();
  const withT = setTitleBlockTemplates(reg, withTemplate(reg.titleBlockTemplates, t));
  const saved = parseSheetRegister(JSON.stringify(withT));
  assert.deepEqual(saved.titleBlockTemplates, [t]);
  assert.equal('titleBlockTemplates' in setTitleBlockTemplates(saved, []), false);
  assert.equal('titleBlockTemplates' in parseSheetRegister(JSON.stringify(reg)), false);
  assert.deepEqual(parseTitleBlockTemplates(JSON.parse(JSON.stringify([t]))), [t]);
  assert.throws(() => parseTitleBlockTemplates([{ ...t, fields: { label: { x: 0.5, y: 0.5, width: 2, height: 0.1 } } }]), /invalid title block template/);
  assert.throws(() => parseTitleBlockTemplates([t, t]), /invalid title block template/);
  assert.throws(() => parseSheetRegister({ ...withT, titleBlockTemplates: 'x' }), /invalid/);
  const renamed = { ...t, name: 'Renamed' };
  assert.deepEqual(withTemplate([t], renamed), [renamed]);
  assert.deepEqual(combinedTemplates([t], [renamed, { ...t, id: 'u2' }]).map(x => x.id), ['t1', 'u2']);
});

test('the sheet date is edited, exported and cleared by a new revision', () => {
  const { reg, ids } = register3();
  const dated = updateSheet(reg, ids[0], { date: ' 2026-11-01 ' });
  assert.equal(dated.sheets[0].date, '2026-11-01');
  assert.match(drawingLogCsv(dated).split('\r\n')[0], /"Sheet date"$/);
  assert.match(drawingLogCsv(dated).split('\r\n')[1], /"2026-11-01"$/);
  assert.equal('date' in updateSheet(dated, ids[0], { date: '' }).sheets[0], false);
  assert.equal(updateSheet(dated, ids[0], { title: 'X' }).sheets[0].date, '2026-11-01');
  const revised = replaceSheet(dated, ids[0], '/new.pdf', 'B', '2026-11-02T00:00:00Z', 1);
  assert.equal('date' in revised.sheets[0], false);
});

test('a field label is stripped only as a label, not from a value that starts with its word', () => {
  const t = template();
  const read = (field, str) => {
    const box = BOXES[field];
    return readTitleBlockFields(t, { width: W, height: H, runs: [run(str, box.x + 2, box.y + 5, 40)] })[field];
  };
  assert.equal(read('title', 'TITLE SHEET'), 'TITLE SHEET');
  assert.equal(read('title', 'SHEET TITLE: LIGHTING PLAN'), 'LIGHTING PLAN');
  assert.equal(read('title', 'TITLE: COVER'), 'COVER');
  assert.equal(read('revision', 'REVISED 2'), 'REVISED 2');
  assert.equal(read('revision', 'REV. 4'), '4');
  assert.equal(read('revision', 'REVISION NO. B'), 'B');
  assert.equal(read('label', 'SHEET NO. E-101'), 'E-101');
  assert.equal(read('label', 'E-101'), 'E-101');
  assert.equal(read('date', 'DATE: 11/12/26'), '11/12/26');
  assert.equal(read('date', 'DATED'), 'DATED');
});

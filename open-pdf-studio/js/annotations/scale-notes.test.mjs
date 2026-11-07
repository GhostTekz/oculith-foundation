// Scale notes on drawing sheets: the parser for real-world scale strings,
// sheet-size conversion, tying a note to its view title, graphic scale bars
// as a cross-check, and the proposals a sheet gives. Pure: no app state.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  parseScaleNote, parseScaleNotes, normalizeScaleText, scaleForPage, matchingSheet,
  textLines, findScaleNotes, findScaleBars, proposeScales, viewRegions, noteKey,
} from './scale-notes.js';
import { pageScaleStatus } from './scale-entry.js';
import { scaleChip } from '../ui/chrome/scale-chip.js';

const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg ?? ''} ${a} != ${b}`);

test('architectural scales', () => {
  const cases = [
    [`SCALE: 1/8" = 1'-0"`, 96], [`1/4"=1'-0"`, 48], [`3/32" = 1'-0"`, 128], [`3/16" = 1'-0"`, 64],
    [`1/2" = 1'-0"`, 24], [`3/4" = 1'-0"`, 16], [`1" = 1'-0"`, 12], [`1 1/2" = 1'-0"`, 8], [`1-1/2"=1'-0"`, 8],
    [`3" = 1'-0"`, 4], [`12" = 1'-0"`, 1], [`1/16" = 1'-0"`, 192], [`1/8" = 1'`, 96],
    [`SCALE: 1/4″ = 1′-0″`, 48], [`SCALE: ¼" = 1'-0"`, 48], [`SCALE: 1½" = 1'-0"`, 8],
    [`1/8''=1'-0''`, 96], [`SCALE: 1/8 IN = 1 FT`, 96], [`1/4 inch = 1 foot`, 48], [`SCALE:1/8"=1'-0"`, 96],
    [`1/4” = 1’-0”`, 48], [`3/8" = 1'-0"`, 32],
  ];
  for (const [text, ratio] of cases) {
    const n = parseScaleNote(text);
    assert.equal(n?.kind, 'scale', text);
    near(n.ratio, ratio, text);
    assert.equal(n.imperial, true, text);
    assert.equal(n.unit, 'ft', text);
    assert.equal(n.equation.paperUnit, 'in');
    assert.equal(n.equation.realUnit, 'ft');
  }
  const eq = parseScaleNote(`1/4" = 1'-0"`).equation;
  assert.deepEqual(eq, { paperValue: 0.25, paperUnit: 'in', realValue: 1, realUnit: 'ft' });
});

test('engineering scales', () => {
  for (const [text, ratio] of [[`1" = 20'`, 240], [`1"=40'-0"`, 480], [`1" = 100'`, 1200], [`1 IN = 30 FT`, 360],
    [`SCALE: 1" = 10'`, 120], [`1" = 50'-0"`, 600], [`1 inch = 200 feet`, 2400]]) {
    const n = parseScaleNote(text);
    assert.equal(n?.kind, 'scale', text);
    near(n.ratio, ratio, text);
    assert.equal(n.unit, 'ft');
  }
});

test('metric scales, labelled in several languages and bare', () => {
  for (const [text, ratio, labelled] of [['1:100', 100, false], ['1 : 50', 50, false], ['SCALE 1:200', 200, true],
    ['SCHAAL 1:50', 50, true], ['Schaal: 1:20', 20, true], ['M 1:500', 500, true], ['Maßstab 1/50', 50, true],
    ['Échelle 1:25', 25, true], ['ESCALA 1:75', 75, true], ['1:1250', 1250, false], ['SCALE: 1:2,5', 2.5, true],
    ['SCALE: 1:1', 1, true], ['scale 1/100', 100, true]]) {
    const n = parseScaleNote(text);
    assert.equal(n?.kind, 'scale', text);
    near(n.ratio, ratio, text);
    assert.equal(n.imperial, false, text);
    assert.equal(n.unit, 'mm');
    assert.equal(n.labelled, labelled, text);
  }
  assert.deepEqual(parseScaleNote('1:100').equation, { paperValue: 1, paperUnit: 'mm', realValue: 100, realUnit: 'mm' });
});

test('sheet sizes in the note', () => {
  assert.equal(parseScaleNote('1:50 @ A1').sheet.name, 'A1');
  assert.equal(parseScaleNote('SCALE 1:100 (A3)').sheet.name, 'A3');
  assert.equal(parseScaleNote('1:200 at A0').sheet.name, 'A0');
  assert.equal(parseScaleNote(`SCALE: 1/4" = 1'-0" (24x36)`).sheet.name, '24x36');
  assert.equal(parseScaleNote(`1/2" = 1'-0" @ ARCH D`).sheet.name, 'ARCH D');
  const both = parseScaleNotes('1:100 @ A1 / 1:200 @ A3');
  assert.deepEqual(both.map(n => [n.ratio, n.sheet.name]), [[100, 'A1'], [200, 'A3']]);
});

test('not to scale and as noted', () => {
  for (const text of ['NTS', 'N.T.S.', 'N.T.S', 'NOT TO SCALE', 'SCALE: NTS', 'Geen schaal', 'No scale']) {
    assert.equal(parseScaleNote(text)?.kind, 'nts', text);
  }
  for (const text of ['SCALE: AS NOTED', 'SCALE: AS SHOWN', 'Scale: as indicated', 'SCHAAL: AANGEGEVEN']) {
    assert.equal(parseScaleNote(text)?.kind, 'asNoted', text);
  }
  assert.equal(parseScaleNote('AS NOTED'), null, 'without a scale label it is ordinary text');
  assert.equal(parseScaleNote('PLANTS AND SHRUBS'), null);
  assert.equal(parseScaleNote('SCALE: FULL SIZE').ratio, 1);
  assert.equal(parseScaleNote('SCALE: HALF SIZE').ratio, 2);
});

test('things that are not a drawing scale', () => {
  for (const text of ['SLOPE 1:12', '1:12 MAX SLOPE', 'MIX 1:3', '10:30 AM', '2:3', '1:2', `1/4"`, `12'-0"`,
    `6'-8" x 3'-0" DOOR`, 'GRID 1/A', 'A3', 'HELLING 1:20', '11:00', 'SHEET 1 OF 12', '1/2 BATH', 'RATIO 1:40']) {
    assert.deepEqual(parseScaleNotes(text).filter(n => n.kind === 'scale'), [], text);
  }
  // A sheet number in front of a scale is not part of its paper length.
  near(parseScaleNote(`A3 1/8" = 1'-0"`).ratio, 96);
  near(parseScaleNote(`DETAIL 3 1/8" = 1'-0"`).ratio, 96);
});

test('the label is kept in the source text', () => {
  assert.equal(parseScaleNote(`SCALE: 1/8" = 1'-0"`).sourceText, `SCALE: 1/8" = 1'-0"`);
  assert.equal(parseScaleNote(`SCALE:1/8"=1'-0"`).sourceText, `SCALE: 1/8"=1'-0"`);
  assert.equal(parseScaleNote('1:100').sourceText, '1:100');
  assert.equal(normalizeScaleText('1½″ – 1′'), `1 1/2" - 1'`);
});

test('a note for another sheet size scales with the paper', () => {
  const a3 = [420 * 72 / 25.4, 297 * 72 / 25.4];
  assert.equal(matchingSheet(...a3), 'A3');
  const onA3 = scaleForPage(parseScaleNote('1:50 @ A1'), ...a3);
  assert.equal(onA3.sheetCheck, 'scaled');
  near(onA3.ratio, 50 * 841 / 420, 'A1 note on an A3 print', 1e-3);
  near(onA3.equation.realValue / onA3.equation.paperValue, onA3.ratio, 'equation follows', 1e-3);
  const onA1 = scaleForPage(parseScaleNote('1:50 @ A1'), 841 * 72 / 25.4, 594 * 72 / 25.4);
  assert.equal(onA1.sheetCheck, 'match');
  assert.equal(onA1.ratio, 50);
  const odd = scaleForPage(parseScaleNote('1:50 @ A1'), 700, 500);
  assert.equal(odd.sheetCheck, 'unknown');
  assert.equal(odd.ratio, 50);
});

// ── Placed text ───────────────────────────────────────────────────────────

/** Items as a sheet shows them: one item per word, 10 pt text. */
function words(text, x, y, size = 10) {
  const out = [];
  let at = x;
  for (const w of text.split(' ')) {
    const width = w.length * size * 0.55;
    out.push({ str: w, x: at, y, width, height: size });
    at += width + size * 0.3;
  }
  return out;
}

const PAGE = { width: 2592, height: 1728 };

function titleBlock(scaleText) {
  return [
    ...words('PROJECT NO 2026-14', 2350, 1400), ...words('DRAWN BY JN', 2350, 1430),
    ...words(scaleText, 2350, 1460), ...words('SHEET NO A-501', 2350, 1500),
  ];
}

test('lines join words on one baseline and keep separate columns apart', () => {
  const lines = textLines([...words('SCALE: 1/4" = 1\'-0"', 100, 100), ...words('DETAIL', 900, 100)]);
  assert.deepEqual(lines.map(l => l.text).sort(), ['DETAIL', 'SCALE: 1/4" = 1\'-0"']);
});

test('a note is tied to the view title above it, and the title block is recognised', () => {
  const items = [
    ...titleBlock('SCALE: 1/8" = 1\'-0"'),
    ...words('1 FLOOR PLAN', 80, 1500, 14), ...words('SCALE: 1/8" = 1\'-0"', 80, 1520),
    ...words('2 ENLARGED TOILET PLAN', 900, 1500, 14), ...words('SCALE: 1/4" = 1\'-0"', 900, 1520),
    ...words('3 WALL SECTION', 1600, 1500, 14), ...words('SCALE: 1 1/2" = 1\'-0"', 1600, 1520),
  ];
  const notes = findScaleNotes(items, PAGE);
  const tb = notes.filter(n => n.inTitleBlock);
  assert.equal(tb.length, 1);
  near(tb[0].ratio, 96);
  const views = notes.filter(n => !n.inTitleBlock);
  assert.deepEqual(views.map(n => n.title), ['1 FLOOR PLAN', '2 ENLARGED TOILET PLAN', '3 WALL SECTION']);
});

test('a title on the same line as its scale', () => {
  const notes = findScaleNotes(words('ROOF PLAN SCALE: 1:100', 200, 400), PAGE);
  assert.equal(notes[0].title, 'ROOF PLAN');
});

test('a scale value under a SCALE cell label in a title block', () => {
  const items = [...words('PROJECT NO 77', 2350, 1500), ...words('SCALE', 2350, 1560), ...words('1:50', 2350, 1575)];
  const [note] = findScaleNotes(items, PAGE);
  assert.equal(note.labelled, true);
  assert.equal(note.inTitleBlock, true);
});

test('graphic scale bars from their labels', () => {
  // 1/8" = 1'-0": 9 pt per foot. Labels 0 8 16 32 FEET.
  const items = [0, 8, 16, 32].map(v => ({ str: String(v), x: 300 + v * 9 - 3, y: 200, width: 6, height: 8 }));
  items.push({ str: 'FEET', x: 300 + 32 * 9 + 20, y: 200, width: 24, height: 8 });
  const [bar] = findScaleBars(items);
  near(bar.ratio, 96, 'bar ratio', 1e-3);
  assert.equal(bar.unit, 'ft');
  // Labels that do not fit one scale are no bar.
  const bad = [0, 8, 16, 32].map((v, i) => ({ str: String(v), x: 300 + i * 50, y: 200, width: 6, height: 8 }));
  bad.push({ str: 'FEET', x: 600, y: 200, width: 24, height: 8 });
  assert.deepEqual(findScaleBars(bad), []);
  // Metric: 1:100 is 72/25.4/100*1000 pt per metre.
  const ppm = 72 / 25.4 / 100 * 1000;
  const metric = [0, 1, 2, 5].map(v => ({ str: String(v), x: 100 + v * ppm - 2, y: 50, width: 4, height: 8 }));
  metric.push({ str: 'm', x: 100 + 5 * ppm + 10, y: 50, width: 6, height: 8 });
  near(findScaleBars(metric)[0].ratio, 100, 'metric bar', 1e-3);
});

test('proposals: title block page scale plus named viewports for the details at other scales', () => {
  const items = [
    ...titleBlock('SCALE: 1/8" = 1\'-0"'),
    ...words('1 FLOOR PLAN', 80, 1500, 14), ...words('SCALE: 1/8" = 1\'-0"', 80, 1520),
    ...words('2 ENLARGED TOILET PLAN', 900, 1500, 14), ...words('SCALE: 1/4" = 1\'-0"', 900, 1520),
    ...words('3 WALL SECTION', 1600, 1500, 14), ...words('SCALE: 1 1/2" = 1\'-0"', 1600, 1520),
  ];
  const r = proposeScales(items, PAGE);
  near(r.pageScale.ratio, 96);
  assert.equal(r.pageScale.source, 'titleBlock');
  assert.ok(r.pageScale.confidence >= 0.8, String(r.pageScale.confidence));
  assert.deepEqual(r.views.map(v => [v.title, v.ratio]), [['2 ENLARGED TOILET PLAN', 48], ['3 WALL SECTION', 8]]);
  const [toilet, section] = r.views;
  // The regions split the drawing area at the titles' left edges.
  assert.ok(toilet.rect.x <= 900 && toilet.rect.x > 850, `toilet x ${toilet.rect.x}`);
  near(toilet.rect.x + toilet.rect.width, 1596, 'toilet right edge stops at the next title');
  assert.ok(section.rect.x + section.rect.width < 2350, 'not into the title block');
  assert.ok(toilet.rect.y < 50 && toilet.rect.y + toilet.rect.height >= 1530, 'from the top down to the scale line');
});

test('proposals: AS NOTED title block with every view at one scale gives a page scale', () => {
  const items = [
    ...titleBlock('SCALE: AS NOTED'),
    ...words('A PLAN', 80, 800, 14), ...words('SCALE 1:50', 80, 818),
    ...words('B PLAN', 1200, 800, 14), ...words('SCALE 1:50', 1200, 818),
  ];
  const r = proposeScales(items, PAGE);
  assert.equal(r.pageScale.ratio, 50);
  assert.equal(r.pageScale.source, 'sheet');
  assert.deepEqual(r.views, []);
  assert.equal(r.info.find(i => i.kind === 'asNoted').inTitleBlock, true);
});

test('proposals: AS NOTED with views at different scales gives viewports only, never a guessed page scale', () => {
  const items = [
    ...titleBlock('SCALE: AS NOTED'),
    ...words('DETAIL A', 80, 800, 14), ...words('SCALE 1:5', 80, 818),
    ...words('DETAIL B', 1200, 800, 14), ...words('SCALE 1:10', 1200, 818),
    ...words('DETAIL C', 80, 1500, 14), ...words('N.T.S.', 80, 1518),
  ];
  const r = proposeScales(items, PAGE);
  assert.equal(r.pageScale, null);
  assert.deepEqual(r.views.map(v => [v.title, v.ratio]), [['DETAIL A', 5], ['DETAIL B', 10]]);
  const nts = r.info.find(i => i.kind === 'nts');
  assert.equal(nts.title, 'DETAIL C');
  // Rows: B and A share a row, C has its own below.
  assert.ok(r.views[0].rect.y + r.views[0].rect.height < 1500);
});

test('proposals: a scale bar that agrees raises confidence, one that conflicts lowers it', () => {
  const base = [...titleBlock('SCALE: 1/8" = 1\'-0"')];
  const bar = (perFoot) => [0, 8, 16, 32].map(v => ({ str: String(v), x: 2350 + v * perFoot, y: 1475, width: 5, height: 6 }))
    .concat([{ str: 'FEET', x: 2350 + 32 * perFoot + 15, y: 1475, width: 20, height: 6 }]);
  const plain = proposeScales(base, PAGE).pageScale;
  const agrees = proposeScales([...base, ...bar(9)], PAGE).pageScale;
  const conflicts = proposeScales([...base, ...bar(4.5)], PAGE).pageScale;
  assert.equal(agrees.bar, 'agrees');
  assert.ok(agrees.confidence > plain.confidence);
  assert.equal(conflicts.bar, 'conflicts');
  assert.ok(conflicts.confidence < plain.confidence);
});

test('proposals: a sheet without notes but with one scale bar', () => {
  const items = [0, 10, 20, 40].map(v => ({ str: String(v), x: 400 + v * 3.6, y: 300, width: 6, height: 8 }));
  items.push({ str: 'FT', x: 400 + 40 * 3.6 + 12, y: 300, width: 10, height: 8 });
  const r = proposeScales(items, PAGE);
  assert.equal(r.pageScale.source, 'scaleBar');
  near(r.pageScale.ratio, 240, 'scale bar 1" = 20\'', 1e-3);
  assert.equal(r.pageScale.confidence, 0.5);
});

test('proposals: a single view on a sheet sets the page scale', () => {
  const r = proposeScales([...words('SITE PLAN', 300, 1500, 14), ...words('SCALE: 1" = 20\'', 300, 1518)], PAGE);
  assert.equal(r.pageScale.ratio, 240);
  assert.equal(r.pageScale.source, 'view');
  assert.deepEqual(r.views, []);
});

test('several scales for different sheets: the one for this page wins', () => {
  const a3 = { width: 420 * 72 / 25.4, height: 297 * 72 / 25.4 };
  const items = [...words('PROJECT NO 9', a3.width - 200, a3.height - 80), ...words('SCHAAL 1:100 @ A1 / 1:200 @ A3', a3.width - 200, a3.height - 60)];
  const r = proposeScales(items, a3);
  assert.equal(r.pageScale.ratio, 200);
  assert.equal(r.pageScale.sheetCheck, 'match');
});

test('known rectangles (CAD viewports) win over the split along the titles', () => {
  const views = [{ anchor: { x: 500, y: 700, width: 100, height: 20 } }];
  const [rect] = viewRegions(views, { x: 0, y: 0, width: 2000, height: 1500 },
    [{ x: 400, y: 100, width: 600, height: 590 }, { x: 0, y: 0, width: 2000, height: 1500 }]);
  assert.deepEqual(rect, { x: 400, y: 100, width: 600, height: 590 });
});

test('the same note on other sheets is found by its text and ratio', () => {
  const a = parseScaleNote(`SCALE: 1/8" = 1'-0"`);
  const b = parseScaleNote(`SCALE: 1/8"=1'-0"`);
  assert.equal(noteKey(a), noteKey(b));
  assert.notEqual(noteKey(a), noteKey(parseScaleNote(`SCALE: 1/4" = 1'-0"`)));
});

// ── Status chip ───────────────────────────────────────────────────────────

const t = (key, o = {}) => `${key}${Object.keys(o).length ? JSON.stringify(o) : ''}`;

test('detected-but-unconfirmed keeps Scale not set semantics, the chip is amber', () => {
  const doc = { annotations: [], scaleProposals: { 1: { page: 1, scanned: true,
    pageScale: { id: '1:page', status: 'pending', ratio: 96, text: `1/8" = 1'-0"`, sourceText: `SCALE: 1/8" = 1'-0"`, source: 'titleBlock', confidence: 0.85 },
    views: [{ id: '1:view:0', status: 'pending', ratio: 48, title: 'ENLARGED', sourceText: 'x', source: 'view' }], info: [] } } };
  const s = pageScaleStatus(doc, 1);
  assert.equal(s.kind, 'detected');
  assert.equal(s.ratio, '1:96');
  assert.equal(s.views, 1);
  const chip = scaleChip(s, t);
  assert.equal(chip.tone, 'detected');
  assert.equal(chip.review, true);
  assert.match(chip.title, /SCALE: 1\/8/u);
  // Page 2 was read and has nothing: red, Set Scale.
  doc.scaleProposals[2] = { page: 2, scanned: true, pageScale: null, views: [], info: [] };
  const two = scaleChip(pageScaleStatus(doc, 2), t);
  assert.equal(two.tone, 'unset');
  assert.equal(two.review, false);
  // Rejected: nothing pending, not set.
  doc.scaleProposals[1].pageScale.status = 'rejected';
  doc.scaleProposals[1].views[0].status = 'rejected';
  assert.equal(pageScaleStatus(doc, 1).kind, 'none');
});

test('a confirmed scale is green and its tooltip names the source', () => {
  const doc = { annotations: [], pageScales: { 1: { pixelsPerUnit: 0.75, unit: 'ft', method: 'ratio',
    source: `Title block: SCALE: 1/8" = 1'-0"` } } };
  const s = pageScaleStatus(doc, 1);
  assert.equal(s.kind, 'set');
  assert.equal(s.source, `Title block: SCALE: 1/8" = 1'-0"`);
  const chip = scaleChip(s, t, `1/8" = 1'-0"`);
  assert.equal(chip.tone, 'ok');
  assert.match(chip.title, /scaleSetSourceTitle.*Title block/u);
  // With views still to review the chip stays amber.
  doc.scaleProposals = { 1: { pageScale: null, views: [{ status: 'pending' }], info: [] } };
  assert.equal(scaleChip(pageScaleStatus(doc, 1), t).tone, 'detected');
});

test('the chip and review strings exist in English and Dutch and the code only uses existing keys', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const flat = (obj, p = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = JSON.parse(read('../i18n/locales/en/dialogs.json')).scaleReview;
  const nl = JSON.parse(read('../i18n/locales/nl/dialogs.json')).scaleReview;
  assert.deepEqual(flat(nl).sort(), flat(en).sort());
  const dialog = read('../solid/components/dialogs/ScaleReviewDialog.jsx');
  for (const m of dialog.matchAll(/'scaleReview\.([\w.]+)'/gu)) assert.ok(flat(en).includes(m[1]), `scaleReview.${m[1]}`);
  for (const lang of ['en', 'nl']) {
    const sb = JSON.parse(read(`../i18n/locales/${lang}/statusbar.json`));
    for (const m of read('../ui/chrome/scale-chip.js').matchAll(/t\('(\w+)'/gu)) {
      if (m[1] === 'navbar') continue;
      assert.ok(sb[m[1]], `${lang} statusbar.${m[1]}`);
    }
  }
});

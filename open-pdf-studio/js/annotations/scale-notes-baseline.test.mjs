// Scale notes read by text baseline: a large view identifier ("1") whose box
// centre lines up with a smaller scale note must not merge into "1 1/8"".
import assert from 'node:assert/strict';
import test from 'node:test';

import { placeTextItems, textLines, findScaleNotes } from './scale-notes.js';

const PAGE = { width: 2592, height: 1728 };
// PDF.js viewport at scale 1, no rotation: user space y-up → page space y-down.
const viewport = { convertToViewportPoint: (x, y) => [x, PAGE.height - y] };

/** PDF.js text items for words on one baseline (page-space baseline y). */
function pdfWords(text, x, baselineY, size) {
  const out = [];
  let at = x;
  for (const str of text.split(' ')) {
    const width = str.length * size * 0.55;
    out.push({ str, transform: [size, 0, 0, size, at, PAGE.height - baselineY], width, height: size });
    at += width + size * 0.3;
  }
  return out;
}

// View bubble "1" at 24 pt (box 90..114) beside a 10 pt scale note (box
// 97..107): both box centres sit at y = 102, but the baselines are 114 and 107.
const sheet = () => placeTextItems([
  ...pdfWords('FLOOR PLAN', 130, 92, 14),
  ...pdfWords('1', 100, 114, 24),
  ...pdfWords(`1/8" = 1'-0"`, 117, 107, 10),
], viewport);

test('placed PDF text items carry their baseline in page space', () => {
  const items = sheet();
  const one = items.find(i => i.str === '1');
  assert.equal(one.baseline, 114);
  assert.equal(one.y, 90);
  assert.equal(one.height, 24);
  assert.equal(items.find(i => i.str === '1/8"').baseline, 107);
});

test('a "1" view identifier and a split 1/8" note on another baseline read as 1/8" = 1\'-0"', () => {
  const items = sheet();
  const texts = textLines(items).map(l => l.text);
  assert.ok(texts.includes(`1/8" = 1'-0"`), texts.join(' / '));
  assert.ok(!texts.some(t => t.startsWith('1 1/8')), texts.join(' / '));
  const notes = findScaleNotes(items, PAGE);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].ratio, 96);
  assert.equal(notes[0].title, 'FLOOR PLAN');
});

test('without baselines (OCR / older callers) the box-centre fallback still joins one row', () => {
  // Same layout minus baseline: documents the fallback that the baseline fixes.
  const items = sheet().map(({ baseline, ...rest }) => rest);
  const texts = textLines(items).map(l => l.text);
  assert.ok(texts.includes(`1 1/8" = 1'-0"`), texts.join(' / '));
});

test('words of different font sizes on one baseline still form one line', () => {
  const items = placeTextItems([
    ...pdfWords('SCALE:', 100, 200, 8),
    ...pdfWords(`1/4" = 1'-0"`, 133, 200, 12),
  ], viewport);
  assert.deepEqual(textLines(items).map(l => l.text), [`SCALE: 1/4" = 1'-0"`]);
  assert.equal(findScaleNotes(items, PAGE)[0].ratio, 48);
});

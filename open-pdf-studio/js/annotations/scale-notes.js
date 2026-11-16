// Scale notes on a drawing sheet: read the scale text that a drafter put in
// the title block or under a view title ("SCALE: 1/8" = 1'-0"", "1:50 @ A1",
// "NTS"), tie each note to the view it labels, and turn the result into
// proposals: one page scale and named viewports (scale regions) for views
// at another scale.
//
// Everything here is pure (no app state, no PDF.js): text items come in
// already placed in page space (top-left origin, y down, /Rotate applied),
// so node tests the whole chain. A proposal is never a calibration; the app
// applies one only after the user confirms it (scale-proposals.js).

import { INCHES_PER_UNIT, formatRatio } from './scale-entry.js';

// ── Text normalisation ───────────────────────────────────────────────────────

const UNICODE_FRACTIONS = {
  '¼': '1/4', '½': '1/2', '¾': '3/4', '⅛': '1/8', '⅜': '3/8',
  '⅝': '5/8', '⅞': '7/8', '⅓': '1/3', '⅔': '2/3', '⅕': '1/5',
  '⅙': '1/6', '⅐': '1/7', '⅑': '1/9', '⅒': '1/10',
};

/**
 * One spelling for the marks drafters and fonts use: straight inch and foot
 * marks, an ASCII hyphen, "1/4" for "¼" (a digit before it gets a space:
 * "1½" is "1 1/2").
 * @param {string} text
 * @returns {string}
 */
export function normalizeScaleText(text) {
  let s = String(text ?? '');
  s = s.replace(/[  -​  　]/gu, ' ');
  s = s.replace(/''/gu, '"');
  s = s.replace(/[“”„″ʺ〃]/gu, '"');
  s = s.replace(/[‘’‚′´`ʹ]/gu, "'");
  s = s.replace(/[‐-―−]/gu, '-');
  s = s.replace(/[⁄∕]/gu, '/');
  s = s.replace(/[：]/gu, ':');
  s = s.replace(/(\d?)([¼-¾⅐-⅞])/gu,
    (_, digit, frac) => `${digit}${digit ? ' ' : ''}${UNICODE_FRACTIONS[frac] || frac}`);
  return s;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const LABEL = String.raw`(?:drawing\s+scale|scale|schaal|ma(?:ss|ß)stab|échelle|echelle|escala|scala|skala)`;
const LABEL_BEFORE = new RegExp(String.raw`(?:${LABEL}|(?<![a-z])m\.?)\s*[:=.\-]?\s*$`, 'iu');
const INCH = String.raw`(?:"|in\b\.?|inch(?:es)?\b)`;
const FOOT = String.raw`(?:'|ft\b\.?|feet\b|foot\b)`;
// Paper side: 1/8, 3/32, 1-1/2, 1 1/2, 1, 3, 0.25.
const PAPER = String.raw`(?<![\w./])(?:(1)\s*[- ]\s*(\d{1,2})\s*\/\s*(\d{1,3})|(\d{1,2})\s*\/\s*(\d{1,3})|(\d{1,3}(?:\.\d+)?))`;
// Real side: 1'-0", 1', 20'-0", 20 ft, 1 foot, 1'-6".
const REAL = String.raw`(\d{1,4}(?:\.\d+)?)\s*${FOOT}(?:\s*-?\s*(\d{1,2})\s*${INCH})?`;
const SHEET_IMPERIAL = String.raw`(?:\s*[(\[]?\s*(?:@|at|on|for)?\s*(?:(\d{1,2})\s*[x×]\s*(\d{1,2})|(arch|ansi)\s*([a-e])\b)\s*(?:sheets?)?\s*[)\]]?)?`;
const IMPERIAL = new RegExp(String.raw`${PAPER}\s*${INCH}\s*=\s*${REAL}${SHEET_IMPERIAL}`, 'giu');
const SHEET_ISO = String.raw`(?:\s*[(\[]?\s*(?:@|at|on|op|bij|auf|sur|in)?\s*\b([ab][0-4])\b\s*[)\]]?)?`;
const METRIC = new RegExp(String.raw`(?<![\w.,:/])1\s*:\s*(\d{1,6}(?:[.,]\d+)?)(?![\d:])${SHEET_ISO}`, 'giu');
const METRIC_SLASH = new RegExp(String.raw`(${LABEL}|(?<![a-z])m\.?)\s*[:=]?\s*1\s*\/\s*(\d{1,6})(?![\d/"'])${SHEET_ISO}`, 'giu');
const NTS = /(?<![a-z])(?:n\.?\s?t\.?\s?s\.?(?![a-z])|not\s+to\s+scale|no\s+scale|geen\s+schaal|niet\s+op\s+schaal|zonder\s+schaal|sans\s+[eé]chelle)/giu;
const AS_NOTED = /(?<![a-z])(?:as\s+noted|as\s+shown|as\s+indicated|as\s+marked|varies|zie\s+tekening|divers|aangegeven)(?![a-z])/giu;
const SIZE = /(?<![a-z])(full|half)\s+(?:size|scale)(?![a-z])/giu;
// A bare ratio near these words is a slope or a mix, not a drawing scale.
const NOT_A_SCALE = /(?:slope|helling|ramp|grade|gradient|mix|taper|ratio|verhouding|pitch|afschot|batter|fall)/iu;

/** ISO and US sheet sizes in millimetres (short side, long side). */
export const SHEET_SIZES = {
  A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297],
  B0: [1000, 1414], B1: [707, 1000], B2: [500, 707], B3: [353, 500], B4: [250, 353],
  'ARCH A': [228.6, 304.8], 'ARCH B': [304.8, 457.2], 'ARCH C': [457.2, 609.6],
  'ARCH D': [609.6, 914.4], 'ARCH E': [914.4, 1219.2],
  'ANSI A': [215.9, 279.4], 'ANSI B': [279.4, 431.8], 'ANSI C': [431.8, 558.8],
  'ANSI D': [558.8, 863.6], 'ANSI E': [863.6, 1117.6],
};

function labelledAt(text, start) {
  return LABEL_BEFORE.test(text.slice(Math.max(0, start - 16), start));
}

function round(n, digits = 6) {
  return Number(n.toPrecision(digits));
}

function imperialNote(m) {
  const [all, mixedWhole, mixedNum, mixedDen, num, den, plain, feet, inches, sheetW, sheetH, sheetFamily, sheetLetter] = m;
  let paperIn;
  if (mixedWhole != null) paperIn = Number(mixedWhole) + Number(mixedNum) / Number(mixedDen);
  else if (num != null) paperIn = Number(num) / Number(den);
  else paperIn = Number(plain);
  const realIn = Number(feet) * 12 + Number(inches || 0);
  if (!(paperIn > 0) || !(realIn > 0) || (num != null && !(Number(den) > 0))) return null;
  const ratio = realIn / paperIn;
  if (!(ratio >= 1) || ratio > 100000) return null;
  const note = {
    kind: 'scale', ratio: round(ratio), imperial: true, unit: 'ft',
    equation: { paperValue: round(paperIn), paperUnit: 'in', realValue: round(realIn / 12), realUnit: 'ft' },
    text: all.trim(), start: m.index, end: m.index + all.length,
  };
  if (sheetW && sheetH) {
    const a = Number(sheetW) * 25.4;
    const b = Number(sheetH) * 25.4;
    note.sheet = { name: `${sheetW}x${sheetH}`, size: [Math.min(a, b), Math.max(a, b)] };
  } else if (sheetFamily && sheetLetter) {
    const name = `${sheetFamily.toUpperCase()} ${sheetLetter.toUpperCase()}`;
    if (SHEET_SIZES[name]) note.sheet = { name, size: SHEET_SIZES[name] };
  }
  return note;
}

function metricNote(all, index, denominator, sheet) {
  const ratio = parseFloat(String(denominator).replace(',', '.'));
  if (!(ratio >= 1) || ratio > 100000) return null;
  const note = {
    kind: 'scale', ratio: round(ratio), imperial: false, unit: 'mm',
    equation: { paperValue: 1, paperUnit: 'mm', realValue: round(ratio), realUnit: 'mm' },
    text: all.trim(), start: index, end: index + all.length,
  };
  if (sheet && SHEET_SIZES[sheet.toUpperCase()]) note.sheet = { name: sheet.toUpperCase(), size: SHEET_SIZES[sheet.toUpperCase()] };
  return note;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Every scale statement in one line of text, in reading order.
 *
 * kinds: 'scale' (ratio N of 1:N, imperial, the equation, `unit` the real
 * unit to measure in, optional `sheet` the paper size it is drawn for),
 * 'nts' (not to scale), 'asNoted' (the views carry their own scale).
 * `labelled` is true when "SCALE" (or a translation) precedes it.
 * @param {string} rawText
 * @returns {Array<object>}
 */
export function parseScaleNotes(rawText) {
  const text = normalizeScaleText(rawText);
  const found = [];
  const add = (note) => {
    if (!note || found.some(f => overlaps(f, note))) return;
    note.labelled = note.labelled ?? labelledAt(text, note.start);
    found.push(note);
  };
  for (const m of text.matchAll(IMPERIAL)) add(imperialNote(m));
  for (const m of text.matchAll(METRIC_SLASH)) {
    const start = m.index + m[0].indexOf(m[0].match(/1\s*\//u)[0]);
    const note = metricNote(m[0].slice(start - m.index), start, m[2], m[3]);
    if (note) { note.labelled = true; add(note); }
  }
  for (const m of text.matchAll(METRIC)) {
    const note = metricNote(m[0], m.index, m[1], m[2]);
    if (!note) continue;
    const labelled = labelledAt(text, m.index);
    if (!labelled) {
      // Unlabelled: no slopes or mixes, and nothing as coarse as 1:4.
      const around = text.slice(Math.max(0, m.index - 24), Math.min(text.length, note.end + 24));
      if (NOT_A_SCALE.test(around) || note.ratio < 5) continue;
    }
    note.labelled = labelled;
    add(note);
  }
  for (const m of text.matchAll(SIZE)) {
    if (!labelledAt(text, m.index)) continue;
    const ratio = m[1].toLowerCase() === 'full' ? 1 : 2;
    add({ kind: 'scale', ratio, imperial: false, unit: 'mm',
      equation: { paperValue: 1, paperUnit: 'mm', realValue: ratio, realUnit: 'mm' },
      text: m[0].trim(), start: m.index, end: m.index + m[0].length, labelled: true });
  }
  for (const m of text.matchAll(NTS)) add({ kind: 'nts', text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(AS_NOTED)) {
    if (labelledAt(text, m.index)) add({ kind: 'asNoted', text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  }
  // With the label in front: "SCALE: 1/8" = 1'-0"" is the source text.
  for (const note of found) {
    const before = text.slice(Math.max(0, note.start - 16), note.start).match(LABEL_BEFORE);
    note.sourceText = before ? `${before[0].trim()} ${note.text}`.replace(/\s+/gu, ' ') : note.text;
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The first scale statement of a text, or null. A shortcut for one note.
 * @param {string} text
 */
export function parseScaleNote(text) {
  return parseScaleNotes(text)[0] || null;
}

/** "1:48" or "1/4" = 1'-0"" style label of a parsed scale. */
export function noteRatioText(note) {
  return note?.kind === 'scale' ? formatRatio(note.ratio) : '';
}

// ── Sheet size ───────────────────────────────────────────────────────────────

const MM_PER_PT = 25.4 / 72;

/** The named sheet size a page matches (2% either way), or null. */
export function matchingSheet(pageWidthPt, pageHeightPt) {
  const a = Math.min(pageWidthPt, pageHeightPt) * MM_PER_PT;
  const b = Math.max(pageWidthPt, pageHeightPt) * MM_PER_PT;
  for (const [name, [s, l]] of Object.entries(SHEET_SIZES)) {
    if (Math.abs(a - s) <= 0.02 * s && Math.abs(b - l) <= 0.02 * l) return name;
  }
  return null;
}

/**
 * The scale a note gives on THIS page. A note drawn for another sheet size
 * ("1:50 @ A1" on an A3 print) scales with the paper: on A3 that is 1:100.
 * When the page is no named size the note's ratio stays, flagged.
 * @param {object} note  from parseScaleNotes
 * @param {number} pageWidthPt
 * @param {number} pageHeightPt
 * @returns {object} the note, with ratio/equation adjusted and `sheetCheck`:
 *   'match' | 'scaled' | 'unknown' (no named page size) | undefined (no sheet in the note)
 */
export function scaleForPage(note, pageWidthPt, pageHeightPt) {
  if (note?.kind !== 'scale' || !note.sheet) return note;
  const pageLong = Math.max(pageWidthPt, pageHeightPt) * MM_PER_PT;
  const noteLong = note.sheet.size[1];
  if (!(pageLong > 0)) return { ...note, sheetCheck: 'unknown' };
  if (Math.abs(pageLong - noteLong) <= 0.02 * noteLong) return { ...note, sheetCheck: 'match' };
  if (!matchingSheet(pageWidthPt, pageHeightPt)) return { ...note, sheetCheck: 'unknown' };
  const factor = noteLong / pageLong;
  const ratio = round(note.ratio * factor);
  const equation = { ...note.equation, paperValue: round(note.equation.paperValue / factor) };
  return { ...note, ratio, equation, sheetCheck: 'scaled', sheetFactor: round(factor, 4) };
}

/**
 * Of several scales for different sheets ("1:100 @ A1 / 1:200 @ A3") the one
 * drawn for this page's size; otherwise all of them.
 */
function pickForSheet(notes, pageWidthPt, pageHeightPt) {
  const withSheet = notes.filter(n => n.kind === 'scale' && n.sheet);
  if (withSheet.length < 2) return notes;
  const pageLong = Math.max(pageWidthPt, pageHeightPt) * MM_PER_PT;
  const exact = withSheet.find(n => Math.abs(n.sheet.size[1] - pageLong) <= 0.02 * n.sheet.size[1]);
  if (!exact) return notes.filter(n => n !== withSheet[1] && !withSheet.slice(2).includes(n));
  return notes.filter(n => !withSheet.includes(n) || n === exact);
}

// ── Text placement ───────────────────────────────────────────────────────────

/**
 * PDF.js text items in page space: {str, x, y, width, height, baseline, vertical}.
 * `viewport` is a PDF.js PageViewport at scale 1 (with the page rotation the
 * app uses); its convertToViewportPoint maps user space to page space.
 * @param {Array<{str:string, transform:number[], width:number, height:number}>} items
 * @param {{convertToViewportPoint:(x:number,y:number)=>number[]}} viewport
 */
export function placeTextItems(items, viewport) {
  const out = [];
  for (const item of items || []) {
    const str = String(item?.str ?? '');
    if (!str.trim() || !Array.isArray(item.transform)) continue;
    const [a, b, c, d, e, f] = item.transform;
    const lenX = Math.hypot(a, b) || 1;
    const lenY = Math.hypot(c, d) || 1;
    const w = Number(item.width) || 0;
    const h = Number(item.height) || lenY;
    const ux = a / lenX; const uy = b / lenX;
    const vx = c / lenY; const vy = d / lenY;
    const corners = [[e, f], [e + ux * w, f + uy * w], [e + vx * h, f + vy * h], [e + ux * w + vx * h, f + uy * w + vy * h]]
      .map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = corners.map(p => p[0]);
    const ys = corners.map(p => p[1]);
    const [p0, p1] = corners;
    const dir = [p1[0] - p0[0], p1[1] - p0[1]];
    out.push({
      str, x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      baseline: (p0[1] + p1[1]) / 2,
      vertical: w > 0 && Math.abs(dir[1]) > Math.abs(dir[0]),
    });
  }
  return out;
}

/**
 * OCR words (top-left origin of the unrotated visible box, in points) in
 * page space, through the same viewport.
 * @param {Array<{text:string,left:number,top:number,width:number,height:number}>} words
 * @param {{convertToViewportPoint:Function}} viewport
 * @param {number[]} view  the visible box [x0, y0, x1, y1] in user space
 */
export function placeOcrWords(words, viewport, view) {
  const out = [];
  const [vx0, , , vy1] = view;
  for (const w of words || []) {
    const str = String(w?.text ?? '').trim();
    if (!str || ![w.left, w.top, w.width, w.height].every(Number.isFinite)) continue;
    const pts = [[w.left, w.top], [w.left + w.width, w.top + w.height]]
      .map(([x, y]) => viewport.convertToViewportPoint(vx0 + x, vy1 - y));
    out.push({ str, x: Math.min(pts[0][0], pts[1][0]), y: Math.min(pts[0][1], pts[1][1]),
      width: Math.abs(pts[1][0] - pts[0][0]), height: Math.abs(pts[1][1] - pts[0][1]), ocr: true, vertical: false });
  }
  return out;
}

const bottom = (r) => r.y + r.height;
const right = (r) => r.x + r.width;

function union(rects) {
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y };
}

/**
 * Text items joined into lines: items on one baseline with a gap smaller
 * than a few character heights. Vertical text stays one item per line.
 * @returns {Array<{text:string, items:object[], spans:Array<[number,number]>, x:number, y:number, width:number, height:number, ocr:boolean}>}
 */
export function textLines(items) {
  const horizontal = items.filter(i => !i.vertical).sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x);
  const rows = [];
  for (const item of horizontal) {
    const cy = item.y + item.height / 2;
    // A larger view identifier can sit between a title and its scale note.
    // Matching box centers joins "1" to "1/8\"", creating a false 1 1/8 scale.
    // PDF text has a real baseline; use it even when adjacent fonts differ.
    // OCR and older placed-item callers retain the box-based fallback.
    const row = rows.find(r => Number.isFinite(r.baseline) && Number.isFinite(item.baseline)
      ? Math.abs(r.baseline - item.baseline) <= 0.2 * Math.min(r.h, item.height)
      : Math.abs(r.cy - cy) <= 0.45 * Math.max(r.h, item.height));
    if (row) row.items.push(item);
    else rows.push({ cy, baseline: item.baseline, h: item.height, items: [item] });
  }
  const lines = [];
  const build = (list) => {
    let text = '';
    const spans = [];
    list.forEach((item, i) => {
      if (i > 0) {
        const gap = item.x - right(list[i - 1]);
        if (gap > 0.12 * Math.max(item.height, list[i - 1].height)) text += ' ';
      }
      const s = normalizeScaleText(item.str);
      spans.push([text.length, text.length + s.length]);
      text += s;
    });
    lines.push({ text, items: list, spans, ...union(list), ocr: list.every(i => i.ocr) });
  };
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let current = [];
    for (const item of row.items) {
      const prev = current[current.length - 1];
      const h = Math.max(item.height, prev?.height || 0);
      if (prev && item.x - right(prev) > 3 * h) { build(current); current = []; }
      current.push(item);
    }
    if (current.length) build(current);
  }
  for (const item of items.filter(i => i.vertical)) build([item]);
  return lines;
}

function rectOfSpan(line, start, end) {
  const hit = line.items.filter((_, i) => line.spans[i][0] < end && line.spans[i][1] > start);
  return hit.length ? union(hit) : { x: line.x, y: line.y, width: line.width, height: line.height };
}

const TITLE_BLOCK_WORDS = /(?:sheet\s*(?:no|number|title)|drawn\s*by|checked\s*by|approved|project\s*(?:no|number)|drawing\s*(?:no|number)|revision|date|tekening(?:nummer|nr)?|blad|getekend|datum|opdrachtgever|client|job\s*no)/iu;

/**
 * Lines that are a heading: some letters, not only a scale, not a long note.
 */
function isTitleLike(text) {
  const t = text.trim();
  if (t.length < 3 || t.length > 80) return false;
  const letters = (t.match(/[a-z]/giu) || []).length;
  if (letters < 3 || (t.match(/\d/gu) || []).length > letters) return false;
  return !/^(?:scale|schaal)\b/iu.test(t);
}

function cleanTitle(text) {
  return normalizeScaleText(text).replace(new RegExp(String.raw`\s*${LABEL}\s*[:=.]?\s*$`, 'iu'), '')
    .replace(/\s+/gu, ' ').replace(/^[\s\-:|]+|[\s\-:|]+$/gu, '').slice(0, 60).trim();
}

/**
 * Every scale note on a page with its place, the label that names it and
 * whether it sits in the title block.
 * @param {object[]} items  placed items (placeTextItems / placeOcrWords)
 * @param {{width:number, height:number}} page  page size in page space
 * @returns {Array<object>} notes: the parse fields plus rect, title, titleRect, inTitleBlock, ocr
 */
export function findScaleNotes(items, page) {
  const lines = textLines(items);
  const notes = [];
  for (const line of lines) {
    for (const parsed of parseScaleNotes(line.text)) {
      const rect = rectOfSpan(line, parsed.start, parsed.end);
      const note = { ...parsed, rect, line, ocr: line.ocr };
      // "SCALE" in the cell above or to the left (title block cells).
      if (!note.labelled) {
        const h = rect.height || 8;
        note.labelled = lines.some(l => l !== line && /^(?:drawing\s+)?(?:scale|schaal|ma(?:ss|ß)stab)\s*[:.]?$/iu.test(l.text.trim())
          && ((bottom(l) <= rect.y + 0.2 * h && rect.y - bottom(l) < 2.5 * h && l.x < right(rect) && right(l) > rect.x - 2 * h)
            || (Math.abs((l.y + l.height / 2) - (rect.y + h / 2)) < 0.6 * h && right(l) <= rect.x && rect.x - right(l) < 8 * h)));
        if (note.labelled && note.sourceText === note.text) note.sourceText = `SCALE ${note.text}`;
      }
      notes.push(note);
    }
  }
  for (const note of notes) {
    note.inTitleBlock = inTitleBlock(note, lines, page);
    if (!note.inTitleBlock) Object.assign(note, viewTitle(note, lines, notes));
  }
  return notes.map(({ line, ...rest }) => rest);
}

function inTitleBlock(note, lines, page) {
  const cx = note.rect.x + note.rect.width / 2;
  const cy = note.rect.y + note.rect.height / 2;
  const inStrip = cx > 0.72 * page.width || cy > 0.86 * page.height;
  if (!inStrip) return false;
  // Title block words nearby: the cell grid of a title block.
  const reach = Math.max(0.12 * Math.min(page.width, page.height), 60);
  const near = lines.filter(l => TITLE_BLOCK_WORDS.test(l.text)
    && Math.abs((l.x + l.width / 2) - cx) < reach * 1.5 && Math.abs((l.y + l.height / 2) - cy) < reach);
  if (near.length) return true;
  // A labelled note at the far edge with no view title above it.
  return note.labelled && (cx > 0.82 * page.width || cy > 0.92 * page.height);
}

/**
 * The view title a note belongs to: text before "SCALE" on the same line,
 * else the nearest heading just above it (a drawing title sits above its
 * scale line, aligned on the left or centred over it).
 */
function viewTitle(note, lines, notes) {
  const h = note.rect.height || 8;
  const before = note.line.text.slice(0, note.start);
  const sameLine = cleanTitle(before);
  if (isTitleLike(sameLine) && parseScaleNotes(sameLine).length === 0) {
    const end = note.start - (before.length - before.trimEnd().length);
    const titleRect = rectOfSpan(note.line, 0, Math.max(1, end));
    return { title: sameLine, titleRect };
  }
  let best = null;
  for (const l of lines) {
    if (l === note.line || bottom(l) > note.rect.y + 0.3 * h) continue;
    const gap = note.rect.y - bottom(l);
    if (gap > 3.5 * Math.max(h, l.height * 0.6)) continue;
    const overlapX = Math.min(right(l), right(note.rect)) - Math.max(l.x, note.rect.x);
    const centred = Math.abs((l.x + l.width / 2) - (note.rect.x + note.rect.width / 2)) < Math.max(l.width, note.rect.width) / 2;
    if (overlapX < -2 * h && !centred) continue;
    if (notes.some(n => n.line === l)) continue;
    const title = cleanTitle(l.text);
    if (!isTitleLike(title)) continue;
    const score = gap + (overlapX > 0 ? 0 : 2 * h);
    if (!best || score < best.score) best = { score, title, titleRect: { x: l.x, y: l.y, width: l.width, height: l.height } };
  }
  return best ? { title: best.title, titleRect: best.titleRect } : {};
}

// ── Graphic scale bars (text based) ─────────────────────────────────────────

const BAR_UNITS = [
  [/^(?:feet|foot|ft\.?|')$/iu, 'ft'], [/^(?:inch(?:es)?|in\.?|")$/iu, 'in'],
  [/^(?:meters?|metres?|m)$/iu, 'm'], [/^(?:mm|millimet(?:er|re)s?)$/iu, 'mm'], [/^(?:cm)$/iu, 'cm'],
];

function barUnit(text) {
  for (const [re, unit] of BAR_UNITS) if (re.test(text.trim())) return unit;
  return null;
}

/**
 * Graphic scale bars found from their labels: "0  4  8  16 FEET" (or
 * "0 1 2 5 m") on one line, numbers increasing from 0 at positions that fit
 * one straight scale. Returns the scale the bar shows.
 * @param {object[]} items placed items
 * @returns {Array<{ratio:number, unit:string, rect:object, text:string}>}
 */
export function findScaleBars(items) {
  const bars = [];
  const horizontal = items.filter(i => !i.vertical);
  const rows = [];
  for (const item of horizontal) {
    const cy = item.y + item.height / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) <= 0.5 * Math.max(r.h, item.height));
    if (row) row.items.push(item); else rows.push({ cy, h: item.height, items: [item] });
  }
  for (const row of rows) {
    const tokens = row.items.flatMap(i => {
      const parts = normalizeScaleText(i.str).trim().split(/\s+/u);
      if (parts.length === 1) return [{ s: parts[0], x: i.x + i.width / 2, item: i }];
      // A run "0 10 20" in one item: spread by character position.
      const per = i.width / Math.max(1, normalizeScaleText(i.str).length);
      let at = 0;
      const text = normalizeScaleText(i.str);
      return parts.map(p => { const k = text.indexOf(p, at); at = k + p.length; return { s: p, x: i.x + (k + p.length / 2) * per, item: i }; });
    }).sort((a, b) => a.x - b.x);
    const zero = tokens.findIndex(t => t.s === '0');
    if (zero < 0) continue;
    const nums = [];
    let unit = null;
    for (const t of tokens.slice(zero)) {
      const m = t.s.match(/^(\d+(?:\.\d+)?)(?:\s*(ft|m|mm|cm|in|'|"))?$/iu);
      if (m) { nums.push({ v: Number(m[1]), x: t.x, item: t.item }); if (m[2]) unit = barUnit(m[2]); continue; }
      unit = unit || barUnit(t.s);
      break;
    }
    if (nums.length < 3 || !unit) continue;
    if (!nums.every((n, i) => i === 0 || n.v > nums[i - 1].v)) continue;
    const span = nums[nums.length - 1];
    const ppu = (span.x - nums[0].x) / (span.v - nums[0].v);
    if (!(ppu > 0)) continue;
    // Every label sits where the scale puts it (within 4% of the bar).
    const length = span.x - nums[0].x;
    if (!nums.every(n => Math.abs(nums[0].x + (n.v - nums[0].v) * ppu - n.x) <= 0.04 * length)) continue;
    const ratio = (72 * INCHES_PER_UNIT[unit]) / ppu;
    if (!(ratio >= 1)) continue;
    bars.push({ ratio: round(ratio, 4), unit, rect: union(nums.map(n => n.item)),
      text: nums.map(n => n.v).join(' ') + ` ${unit}` });
  }
  return bars;
}

// ── View regions ─────────────────────────────────────────────────────────────

/**
 * The rectangle a labelled view occupies. A rectangle from the drawing
 * itself (a CAD viewport) that holds the title or sits just above it wins;
 * otherwise the sheet is split along the titles: rows of titles split it
 * vertically, titles in a row split it horizontally (at the next title's
 * left edge when the titles are left aligned, half way when centred).
 * @param {Array<{anchor:object}>} views  anchor: union of title and note
 * @param {{x:number,y:number,width:number,height:number}} area  drawing area
 * @param {Array<object>} [knownRects]  rectangles from the drawing
 * @returns {Array<object>} one rectangle per view
 */
export function viewRegions(views, area, knownRects = []) {
  const pad = 4;
  const result = new Array(views.length).fill(null);
  views.forEach((v, i) => {
    const a = v.anchor;
    const cx = a.x + a.width / 2;
    const hit = knownRects
      .filter(r => cx >= r.x && cx <= right(r) && a.y >= r.y - 2 * a.height && a.y <= bottom(r) + 3 * a.height)
      .sort((p, q) => p.width * p.height - q.width * q.height)[0];
    if (hit) result[i] = { x: hit.x, y: hit.y, width: hit.width, height: hit.height };
  });
  const open = views.map((v, i) => ({ v, i })).filter(({ i }) => !result[i]);
  const rows = [];
  for (const entry of open.sort((p, q) => bottom(p.v.anchor) - bottom(q.v.anchor))) {
    const b = bottom(entry.v.anchor);
    const row = rows.find(r => Math.abs(r.bottom - b) <= Math.max(3 * entry.v.anchor.height, 0.04 * area.height));
    if (row) { row.entries.push(entry); row.bottom = Math.max(row.bottom, b); } else rows.push({ bottom: b, entries: [entry] });
  }
  rows.sort((p, q) => p.bottom - q.bottom);
  let top = area.y;
  for (const row of rows) {
    const rowBottom = Math.min(bottom(area), row.bottom + pad);
    row.entries.sort((p, q) => p.v.anchor.x - q.v.anchor.x);
    const first = row.entries[0].v.anchor;
    const leftAligned = row.entries.length === 1 || (first.x - area.x) < 0.12 * area.width;
    row.entries.forEach((entry, k) => {
      const a = entry.v.anchor;
      const prev = row.entries[k - 1]?.v.anchor;
      const next = row.entries[k + 1]?.v.anchor;
      let left;
      let rightEdge;
      if (leftAligned) {
        left = prev ? a.x - pad : area.x;
        rightEdge = next ? next.x - pad : right(area);
      } else {
        left = prev ? (right(prev) + a.x) / 2 : area.x;
        rightEdge = next ? (right(a) + next.x) / 2 : right(area);
      }
      result[entry.i] = { x: left, y: top, width: Math.max(1, rightEdge - left), height: Math.max(1, rowBottom - top) };
    });
    top = rowBottom;
  }
  return result;
}

/**
 * The area where the views are: the page inside a small margin, without
 * the title block strip when the title block note shows where it is.
 */
function drawingArea(page, titleNotes, items) {
  const margin = Math.min(page.width, page.height) * 0.02;
  const area = { x: margin, y: margin, width: page.width - 2 * margin, height: page.height - 2 * margin };
  const side = titleNotes.find(n => n.rect.x + n.rect.width / 2 > 0.72 * page.width);
  if (side) {
    // The title block column: text in the strip near the note's column.
    const column = items.filter(i => i.x + i.width / 2 > 0.7 * page.width && Math.abs(i.x - side.rect.x) < 0.12 * page.width);
    const left = Math.min(side.rect.x, ...column.map(i => i.x)) - margin / 2;
    area.width = Math.max(1, left - area.x);
  } else if (titleNotes.length) {
    const strip = items.filter(i => i.y + i.height / 2 > 0.84 * page.height);
    const topEdge = Math.min(...titleNotes.map(n => n.rect.y), ...strip.map(i => i.y)) - margin / 2;
    area.height = Math.max(1, topEdge - area.y);
  }
  return area;
}

// ── Proposals ────────────────────────────────────────────────────────────────

function confidenceOf(note, extra) {
  let c = note.labelled ? 0.7 : (note.imperial ? 0.6 : 0.35);
  if (extra.titleBlock || extra.titled) c += 0.15;
  if (extra.bar === 'agrees') c += 0.15;
  if (extra.bar === 'conflicts') c -= 0.35;
  if (note.ocr) c -= 0.1;
  if (note.sheetCheck === 'unknown') c -= 0.15;
  return Math.round(Math.max(0.05, Math.min(0.99, c)) * 100) / 100;
}

function barCheck(note, bars, region) {
  const center = (r) => [r.x + r.width / 2, r.y + r.height / 2];
  const [nx, ny] = center(note.rect);
  const near = bars.filter(b => {
    const [bx, by] = center(b.rect);
    if (region) return bx >= region.x && bx <= region.x + region.width && by >= region.y && by <= region.y + region.height;
    return Math.hypot(bx - nx, by - ny) < 200;
  });
  if (!near.length) return { bar: undefined };
  const agrees = near.find(b => Math.abs(b.ratio - note.ratio) <= 0.04 * note.ratio);
  return agrees ? { bar: 'agrees', barText: agrees.text } : { bar: 'conflicts', barText: near[0].text, barRatio: near[0].ratio };
}

const sameRatio = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(a, b);

/**
 * Scale proposals for one page.
 * @param {object[]} items  placed text items (page space)
 * @param {{width:number, height:number, widthPt?:number, heightPt?:number}} page
 *   page size in page space; widthPt/heightPt the paper size (default the same)
 * @param {{knownRects?:object[]}} [options]  rectangles from the drawing (CAD viewports)
 * @returns {{pageScale:object|null, views:object[], notes:object[], info:object[], bars:object[]}}
 *   pageScale / views: {target:'page'|'view', ratio, equation, unit, imperial, text,
 *   sourceText, source:'titleBlock'|'view'|'sheet'|'scaleBar', title?, rect?, confidence, bar?}
 *   info: notes that set nothing ('nts', 'asNoted'), with their title
 */
export function proposeScales(items, page, options = {}) {
  const paperW = page.widthPt || page.width;
  const paperH = page.heightPt || page.height;
  const all = findScaleNotes(items, page).map(n => scaleForPage(n, paperW, paperH));
  const notes = pickForSheet(all, paperW, paperH);
  const bars = findScaleBars(items);
  const scales = notes.filter(n => n.kind === 'scale');
  const info = notes.filter(n => n.kind !== 'scale').map(n => ({ kind: n.kind, text: n.text, sourceText: n.sourceText,
    title: n.title || '', inTitleBlock: n.inTitleBlock, rect: n.rect }));

  const titleBlock = scales.filter(n => n.inTitleBlock).sort((a, b) => Number(b.labelled) - Number(a.labelled))[0] || null;
  const titleBlockNotes = notes.filter(n => n.inTitleBlock);
  const viewNotes = scales.filter(n => !n.inTitleBlock && n.title);
  const loose = scales.filter(n => !n.inTitleBlock && !n.title);

  const proposal = (note, target, source, extra = {}) => ({
    target, source, ratio: note.ratio, equation: { ...note.equation }, unit: note.unit, imperial: note.imperial,
    text: note.text, sourceText: note.sourceText, ocr: !!note.ocr,
    ...(note.sheetCheck ? { sheetCheck: note.sheetCheck } : {}),
    ...extra,
    confidence: confidenceOf(note, { ...extra, titleBlock: source === 'titleBlock', titled: !!extra.title }),
  });

  let pageScale = null;
  if (titleBlock) {
    pageScale = proposal(titleBlock, 'page', 'titleBlock', barCheck(titleBlock, bars, null));
  }

  // The views: their regions over the drawing area.
  const area = drawingArea(page, titleBlockNotes, items);
  const titledInfo = info.filter(n => !n.inTitleBlock && n.title);
  const viewsAll = [
    ...viewNotes.map(n => ({ note: n, anchor: union([n.rect, n.titleRect || n.rect]) })),
    ...titledInfo.map(n => ({ info: n, anchor: union([n.rect]) })),
  ];
  const regions = viewRegions(viewsAll, area, options.knownRects || []);
  let views = viewsAll.map((v, i) => {
    if (v.info) { v.info.rect = regions[i]; return null; }
    const extra = { title: v.note.title, rect: regions[i], ...barCheck(v.note, bars, regions[i]) };
    return proposal(v.note, 'view', 'view', extra);
  }).filter(Boolean);

  if (!pageScale) {
    const distinct = [...new Set(views.map(v => v.ratio))];
    if (views.length && distinct.length === 1 && !titledInfo.length) {
      // Every view at one scale: that is the page scale.
      const v = views.sort((a, b) => b.confidence - a.confidence)[0];
      pageScale = { ...v, target: 'page', source: views.length > 1 ? 'sheet' : 'view', rect: undefined };
      views = [];
    } else if (!views.length && loose.length) {
      const best = loose.sort((a, b) => Number(b.labelled) - Number(a.labelled) || Number(b.imperial) - Number(a.imperial))[0];
      pageScale = proposal(best, 'page', 'sheet', barCheck(best, bars, null));
    } else if (!views.length && !loose.length && bars.length === 1) {
      const bar = bars[0];
      const equation = ['ft', 'in'].includes(bar.unit)
        ? { paperValue: 1, paperUnit: 'in', realValue: round(bar.ratio / 12), realUnit: 'ft' }
        : { paperValue: 1, paperUnit: 'mm', realValue: bar.ratio, realUnit: 'mm' };
      pageScale = { target: 'page', source: 'scaleBar', ratio: bar.ratio, equation, unit: equation.realUnit,
        imperial: equation.realUnit === 'ft', text: bar.text, sourceText: bar.text, confidence: 0.5 };
    }
  }
  // A view at the page scale needs no region of its own.
  if (pageScale) views = views.filter(v => !sameRatio(v.ratio, pageScale.ratio));
  return { pageScale, views, notes, info, bars };
}

/** The key under which "the same note" on other sheets is found. */
export function noteKey(p) {
  return p ? `${p.imperial ? 'imp' : 'met'}:${round(p.ratio, 5)}:${normalizeScaleText(p.text).replace(/\s+/gu, '').toLowerCase()}` : '';
}

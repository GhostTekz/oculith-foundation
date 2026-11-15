// Custom line styles (the external editor Line Style editor parity, docs/reference/editor/markup-tools.md).
//
// A line style is a list of parallel LINES (offset, dash pattern, width
// factor) plus repeating MARKS along the line: text ("GAS", "W", "FO") or a
// small vector symbol (x, circle, tick ...). Lengths are in page points; with
// `scaleWithWidth` every length is multiplied by the markup's line width.
//
// The module is PURE (no state, canvas or DOM): `layoutLineStyle` turns a
// style and a polyline (app space, y down) into primitives that the canvas
// (rendering/line-style-draw.js) and the saved appearance
// (pdf/saver/line-style-ap.js) draw identically: stroke pieces, dots, text
// placements and symbol outlines. Dashes are laid out here as explicit
// pieces, never through setLineDash or the PDF `d` operator, so the screen
// and every other viewer break the line at exactly the same places.
//
// Styles come from three places: the read-only built-in set, the user's
// styles (preferences) and the copy embedded in a PDF (`/OPS_LineStyle`).
// Everything read from preferences, a style-set file or a PDF goes through
// `cleanLineStyle`, which rejects or clamps every field.

import { helveticaBreedte, HOOFDLETTER_HOOGTE } from './maatlijn-inline.js';
import { leesbareHoek } from './maat-label.js';

export const LINE_STYLE_SET_FORMAT = 'ocudraw.line-styles';
export const LINE_STYLE_SET_VERSION = 1;
export const MAX_LINE_STYLE_SET_BYTES = 256 * 1024;
export const MAX_USER_LINE_STYLES = 200;
export const MAX_STYLE_LINES = 6;
export const MAX_STYLE_MARKS = 4;
export const MAX_DASH_ENTRIES = 16;
export const MAX_MARK_TEXT = 12;

/** Markup types that can carry a line style. */
export const LINE_STYLE_TYPES = new Set(['line', 'polyline', 'arc', 'spline', 'measurePerimeter']);

export const SYMBOL_SHAPES = ['x', 'cross', 'circle', 'dot', 'square', 'diamond', 'triangle', 'tick', 'chevron', 'slash'];

// Upper bounds on the primitives one markup may produce: an absurd interval
// or a dash of 0.1 pt over a long line must not stall the canvas or the save.
const MAX_MARKS_PER_LINE = 2000;
const MAX_PIECES_PER_LINE = 20000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const textLine = (dash) => [{ offset: 0, dash, width: 1 }];
const textMark = (text, size = 7, interval = 72) =>
  ({ kind: 'text', text, size, interval, start: null, gap: 2, offset: 0 });

/**
 * The built-in, read-only set: common utility and drafting line types. Names
 * are English fallbacks; the UI shows `lineStyles.builtin.<id>`.
 */
export const BUILTIN_LINE_STYLES = Object.freeze([
  { id: 'gas', name: 'Gas', scaleWithWidth: false, lines: textLine([]), marks: [textMark('GAS', 7, 80)] },
  { id: 'water', name: 'Water', scaleWithWidth: false, lines: textLine([]), marks: [textMark('W', 8, 60)] },
  { id: 'sewer', name: 'Sanitary sewer', scaleWithWidth: false, lines: textLine([]), marks: [textMark('SS', 7, 72)] },
  { id: 'storm', name: 'Storm drain', scaleWithWidth: false, lines: textLine([]), marks: [textMark('SD', 7, 72)] },
  { id: 'electric', name: 'Electric', scaleWithWidth: false, lines: textLine([]), marks: [textMark('E', 8, 60)] },
  { id: 'telecom', name: 'Telecom / fibre', scaleWithWidth: false, lines: textLine([]), marks: [textMark('FO', 7, 72)] },
  { id: 'fence', name: 'Fence', scaleWithWidth: false, lines: textLine([]),
    marks: [{ kind: 'symbol', shape: 'x', size: 5, interval: 24, start: null, gap: null, offset: 0, filled: false }] },
  { id: 'centerline', name: 'Centerline', scaleWithWidth: false, lines: textLine([18, -4, 4, -4]), marks: [] },
  { id: 'hidden', name: 'Hidden', scaleWithWidth: false, lines: textLine([6, -3]), marks: [] },
  { id: 'phantom', name: 'Phantom', scaleWithWidth: false, lines: textLine([18, -3, 3, -3, 3, -3]), marks: [] },
].map(s => Object.freeze({ ...s, builtin: true })));

const BUILTIN_BY_ID = new Map(BUILTIN_LINE_STYLES.map(s => [s.id, s]));

export function isBuiltinLineStyleId(id) { return BUILTIN_BY_ID.has(id); }
export function getBuiltinLineStyle(id) { return BUILTIN_BY_ID.get(id) || null; }

/** Only printable ASCII: the canvas and the WinAnsi Helvetica appearance then measure the same text. */
export function cleanMarkText(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7e]/gu, '').trim().slice(0, MAX_MARK_TEXT);
}

function cleanDash(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value.slice(0, MAX_DASH_ENTRIES)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out.push(Math.round(clamp(n, -500, 500, 0) * 1000) / 1000);
  }
  // A pattern shorter than half a point reads as a solid line (and would
  // otherwise cost thousands of pieces per inch): treat it as solid.
  const period = out.reduce((sum, v) => sum + Math.abs(v), 0);
  if (period < 0.5) return [];
  // A pattern without a visible element (only spaces) would hide the line.
  if (!out.some(v => v >= 0)) return [];
  return out;
}

function cleanLine(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    offset: Math.round(clamp(value.offset, -50, 50, 0) * 1000) / 1000,
    dash: cleanDash(value.dash),
    width: Math.round(clamp(value.width, 0.1, 10, 1) * 1000) / 1000,
  };
}

function cleanMark(value) {
  if (!value || typeof value !== 'object') return null;
  const base = {
    interval: clamp(value.interval, 4, 5000, 72),
    start: value.start === null || value.start === undefined ? null : clamp(value.start, 0, 5000, 0),
    gap: value.gap === null || value.gap === undefined ? null : clamp(value.gap, 0, 100, 2),
    offset: clamp(value.offset, -50, 50, 0),
  };
  if (value.kind === 'text') {
    const text = cleanMarkText(value.text);
    if (!text) return null;
    return { kind: 'text', text, size: clamp(value.size, 2, 72, 7), ...base };
  }
  if (value.kind === 'symbol') {
    if (!SYMBOL_SHAPES.includes(value.shape)) return null;
    return { kind: 'symbol', shape: value.shape, size: clamp(value.size, 1, 72, 5), ...base,
      filled: value.filled === true };
  }
  return null;
}

/**
 * A safe copy of a style definition, or null. Unknown fields are dropped;
 * numbers are clamped; a style needs at least one line or mark.
 */
export function cleanLineStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return null;
  const name = typeof value.name === 'string'
    // eslint-disable-next-line no-control-regex
    ? value.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, 64) : '';
  const lines = (Array.isArray(value.lines) ? value.lines : []).slice(0, MAX_STYLE_LINES)
    .map(cleanLine).filter(Boolean);
  const marks = (Array.isArray(value.marks) ? value.marks : []).slice(0, MAX_STYLE_MARKS)
    .map(cleanMark).filter(Boolean);
  if (!lines.length && !marks.length) return null;
  return { id: value.id, name: name || value.id, scaleWithWidth: value.scaleWithWidth === true, lines, marks };
}

/** A new, unused id for a user style. */
export function newLineStyleId(existing = []) {
  const taken = new Set(existing.map(s => s.id));
  for (let i = 0; i < 1000; i++) {
    const id = `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id) && !BUILTIN_BY_ID.has(id)) return id;
  }
  return `user-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The style an annotation draws with: a built-in by id, then the user's
 * style by id, then the copy the PDF carried (`lineStyleDef`). Null = the
 * markup's plain border style.
 */
export function resolveLineStyle(annotation, userStyles = []) {
  const id = annotation?.lineStyleId;
  if (!id || typeof id !== 'string' || !LINE_STYLE_TYPES.has(annotation.type)) return null;
  const builtin = BUILTIN_BY_ID.get(id);
  if (builtin) return builtin;
  const user = (userStyles || []).find(s => s && s.id === id);
  if (user) return user;
  const embedded = annotation.lineStyleDef;
  return embedded && embedded.id === id ? cleanLineStyle(embedded) : null;
}

// ── style-set files (shared sets) ───────────────────────────────────────────

/** JSON bytes of a style set: `{ format, version, name, styles }`. */
export function buildLineStyleSetBytes(name, styles) {
  const clean = (styles || []).map(cleanLineStyle).filter(Boolean)
    .map(({ id, name: n, scaleWithWidth, lines, marks }) => ({ id, name: n, scaleWithWidth, lines, marks }));
  const doc = { format: LINE_STYLE_SET_FORMAT, version: LINE_STYLE_SET_VERSION,
    name: String(name || 'Line styles').slice(0, 64), styles: clean };
  const bytes = new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
  if (bytes.byteLength > MAX_LINE_STYLE_SET_BYTES) throw new Error('The line style set is too large to export.');
  return bytes;
}

/**
 * Parse a style-set file (untrusted). Returns `{ name, styles, skipped }`;
 * styles that fail cleaning are counted in `skipped`, not imported.
 */
export function parseLineStyleSetBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_LINE_STYLE_SET_BYTES) {
    throw new Error(`A line style set must be at most ${MAX_LINE_STYLE_SET_BYTES} bytes.`);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('The line style set is not valid UTF-8 JSON.'); }
  if (!parsed || parsed.format !== LINE_STYLE_SET_FORMAT || parsed.version !== LINE_STYLE_SET_VERSION ||
      !Array.isArray(parsed.styles)) {
    throw new Error('Unsupported line style set format or version.');
  }
  const styles = [];
  let skipped = 0;
  for (const raw of parsed.styles.slice(0, MAX_USER_LINE_STYLES)) {
    const clean = cleanLineStyle(raw);
    if (clean) styles.push(clean); else skipped++;
  }
  skipped += Math.max(0, parsed.styles.length - MAX_USER_LINE_STYLES);
  return { name: typeof parsed.name === 'string' ? parsed.name.slice(0, 64) : '', styles, skipped };
}

/**
 * Merge imported styles into the user's list. A built-in id or an id that
 * already exists with a different definition gets a fresh id, so an import
 * never silently changes markups that use an existing style.
 */
export function mergeImportedLineStyles(existing, imported) {
  const out = [...(existing || [])];
  const added = [];
  for (const style of imported || []) {
    if (out.length >= MAX_USER_LINE_STYLES) break;
    const same = out.find(s => s.id === style.id);
    if (same && JSON.stringify(cleanLineStyle(same)) === JSON.stringify(style)) continue;
    const id = (same || BUILTIN_BY_ID.has(style.id)) ? newLineStyleId(out) : style.id;
    const copy = { ...style, id };
    out.push(copy);
    added.push(copy);
  }
  return { styles: out, added };
}

// ── geometry ────────────────────────────────────────────────────────────────

/** Points of an arc markup, as the saver samples it (36 steps). */
export function arcPolylinePoints(ann, steps = 36) {
  let a0 = ann.startAngle, a1 = ann.endAngle;
  if (a1 < a0) a1 += 2 * Math.PI;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    out.push({ x: ann.centerX + ann.radius * Math.cos(a), y: ann.centerY + ann.radius * Math.sin(a) });
  }
  return out;
}

function cleanPoints(points) {
  const out = [];
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function mergeIntervals(list) {
  const sorted = list.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// [from, to] minus the cut intervals.
function visibleIntervals(total, cuts) {
  const out = [];
  let s = 0;
  for (const [a, b] of mergeIntervals(cuts)) {
    if (a > s) out.push([s, Math.min(a, total)]);
    s = Math.max(s, b);
    if (s >= total) break;
  }
  if (s < total) out.push([s, total]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

function intersect(on, visible) {
  const out = [];
  let j = 0;
  for (const [a, b] of on) {
    while (j < visible.length && visible[j][1] <= a) j++;
    for (let k = j; k < visible.length && visible[k][0] < b; k++) {
      const lo = Math.max(a, visible[k][0]), hi = Math.min(b, visible[k][1]);
      if (hi - lo > 1e-6) out.push([lo, hi]);
    }
  }
  return out;
}

// Symbol outlines in a local frame: x along the line, y across (y down), unit size.
function symbolPaths(shape) {
  const circle = (r, n = 16) => Array.from({ length: n }, (_, i) =>
    ({ x: r * Math.cos(2 * Math.PI * i / n), y: r * Math.sin(2 * Math.PI * i / n) }));
  switch (shape) {
    case 'x': return [{ points: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: 0.5 }] }, { points: [{ x: -0.5, y: 0.5 }, { x: 0.5, y: -0.5 }] }];
    case 'cross': return [{ points: [{ x: -0.5, y: 0 }, { x: 0.5, y: 0 }] }, { points: [{ x: 0, y: -0.5 }, { x: 0, y: 0.5 }] }];
    case 'circle': return [{ points: circle(0.5), closed: true }];
    case 'dot': return [{ points: circle(0.5), closed: true, fill: true }];
    case 'square': return [{ points: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }], closed: true }];
    case 'diamond': return [{ points: [{ x: -0.5, y: 0 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }], closed: true }];
    case 'triangle': return [{ points: [{ x: 0.5, y: 0 }, { x: -0.5, y: -0.5 }, { x: -0.5, y: 0.5 }], closed: true }];
    case 'tick': return [{ points: [{ x: 0, y: -0.5 }, { x: 0, y: 0.5 }] }];
    case 'chevron': return [{ points: [{ x: -0.25, y: -0.5 }, { x: 0.25, y: 0 }, { x: -0.25, y: 0.5 }] }];
    case 'slash': return [{ points: [{ x: -0.25, y: 0.5 }, { x: 0.25, y: -0.5 }] }];
    default: return [];
  }
}

/**
 * Lay a style out along an open polyline.
 *
 * @param {object} style  a clean style (see cleanLineStyle)
 * @param {{x:number,y:number}[]} points  app space, y down
 * @param {{ lineWidth?: number, draaiing?: number }} opts  `draaiing` (radians):
 *   how the displayed page is rotated relative to these coordinates, so text
 *   reads upright on the displayed page (0 on screen; the page /Rotate in the
 *   saver, which lays out in unrotated page space).
 * @returns {{ strokes: {width:number, points:{x,y}[]}[], dots: {x,y,r}[],
 *   texts: {x,y,angle,text,size,width,baseX,baseY}[],
 *   shapes: {points:{x,y}[], closed:boolean, fill:boolean, width:number}[],
 *   length: number }}
 */
export function layoutLineStyle(style, points, opts = {}) {
  const out = { strokes: [], dots: [], texts: [], shapes: [], length: 0 };
  const pts = cleanPoints(points);
  if (!style || pts.length < 2) return out;
  const lineWidth = Number.isFinite(opts.lineWidth) && opts.lineWidth > 0 ? opts.lineWidth : 1;
  const draaiing = Number(opts.draaiing) || 0;
  const k = style.scaleWithWidth ? Math.max(lineWidth, 0.1) : 1;

  const n = pts.length;
  const segs = [];
  const cum = [0];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    segs.push({ len, ux: dx / len, uy: dy / len });
    cum.push(cum[i] + len);
  }
  const total = cum[n - 1];
  out.length = total;
  if (!(total > 0)) return out;

  const segAt = (s) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid; else hi = mid - 1;
    }
    const t = segs[lo].len > 0 ? Math.min(1, Math.max(0, (s - cum[lo]) / segs[lo].len)) : 0;
    return { i: lo, t };
  };

  // A mark (with its gap) that would straddle a corner moves the least
  // distance that puts it on one segment (the previous one on a tie), so text never bends round a
  // vertex. When no neighbouring segment is long enough it stays put.
  const fitInSegment = (s, half) => {
    const { i } = segAt(s);
    const a = cum[i], b = cum[i + 1];
    if (s - half >= a - 1e-9 && s + half <= b + 1e-9) return s;
    const options = [];
    if (b - a >= 2 * half) options.push(Math.min(Math.max(s, a + half), b - half));
    if (i > 0 && s - half < a && cum[i] - cum[i - 1] >= 2 * half) options.push(a - half);
    if (i < segs.length - 1 && s + half > b && cum[i + 2] - cum[i + 1] >= 2 * half) options.push(b + half);
    if (!options.length) return s;
    options.sort((p, q) => Math.abs(p - s) - Math.abs(q - s) || p - q);
    return options[0];
  };

  // ── marks ────────────────────────────────────────────────────────────────
  const cuts = [];
  for (const mark of style.marks || []) {
    const size = mark.size * k;
    const len = mark.kind === 'text' ? helveticaBreedte(mark.text, size) : size;
    const half = len / 2;
    const interval = Math.max(mark.interval * k, 1);
    const start = (mark.start == null ? mark.interval / 2 : mark.start) * k;
    const gap = mark.gap == null ? null : mark.gap * k;
    const positions = [];
    for (let s = start; s <= total + 1e-9 && positions.length < MAX_MARKS_PER_LINE; s += interval) {
      // Keep the mark and its gap inside the line: no text hanging off an end.
      const room = half + (gap || 0);
      if (s - room >= -1e-9 && s + room <= total + 1e-9) positions.push(s);
    }
    // A line shorter than one interval still shows its mark once, centred.
    if (!positions.length && total >= len + 2 * (gap || 0)) positions.push(total / 2);
    for (const s0 of positions) {
      const s = fitInSegment(s0, half + (gap || 0));
      const { i, t } = segAt(s);
      const { ux, uy } = segs[i];
      const px = pts[i].x + (pts[i + 1].x - pts[i].x) * t;
      const py = pts[i].y + (pts[i + 1].y - pts[i].y) * t;
      const off = mark.offset * k;
      const cx = px - uy * off, cy = py + ux * off;
      const a = Math.atan2(uy, ux);
      if (mark.kind === 'text') {
        const ar = leesbareHoek(a + draaiing) - draaiing;
        const dir = { x: Math.cos(ar), y: Math.sin(ar) };
        const up = { x: Math.sin(ar), y: -Math.cos(ar) };
        const h = size * HOOFDLETTER_HOOGTE / 2;
        out.texts.push({ x: cx, y: cy, angle: ar, text: mark.text, size, width: len,
          baseX: cx - dir.x * half - up.x * h, baseY: cy - dir.y * half - up.y * h });
      } else {
        const ca = Math.cos(a), sa = Math.sin(a);
        const w = Math.max(lineWidth * 0.75, 0.25);
        for (const path of symbolPaths(mark.shape)) {
          out.shapes.push({
            points: path.points.map(p => ({ x: cx + (p.x * ca - p.y * sa) * size, y: cy + (p.x * sa + p.y * ca) * size })),
            closed: !!path.closed, fill: !!path.fill || (!!path.closed && mark.filled), width: w,
          });
        }
      }
      if (gap != null) cuts.push([s - half - gap, s + half + gap]);
    }
  }
  const visible = visibleIntervals(total, cuts);

  // ── parallel lines ───────────────────────────────────────────────────────
  for (const line of style.lines || []) {
    const o = line.offset * k;
    const width = Math.max(lineWidth * line.width, 0.1);
    // Offset vertices with mitred corners (miter clamped to 4x the offset).
    const q = pts.map((p, j) => {
      if (o === 0) return p;
      const a = segs[Math.max(0, j - 1)], b = segs[Math.min(segs.length - 1, j)];
      const n1 = { x: -a.uy, y: a.ux }, n2 = { x: -b.uy, y: b.ux };
      let mx = n1.x + n2.x, my = n1.y + n2.y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = n1.x; my = n1.y; } else { mx /= ml; my /= ml; }
      const cos = mx * n1.x + my * n1.y;
      const dist = Math.min(Math.abs(o / (cos || 1)), Math.abs(o) * 4) * Math.sign(o);
      return { x: p.x + mx * dist, y: p.y + my * dist };
    });
    const at = (s) => {
      const { i, t } = segAt(s);
      return { x: q[i].x + (q[i + 1].x - q[i].x) * t, y: q[i].y + (q[i + 1].y - q[i].y) * t };
    };
    const dash = (line.dash || []).map(v => v * k);
    const period = dash.reduce((sum, v) => sum + Math.abs(v), 0);
    let on = [[0, total]];
    const dotsAt = [];
    if (dash.length && period > 0) {
      on = [];
      let s = 0;
      let count = 0;
      while (s < total && count < MAX_PIECES_PER_LINE) {
        for (const v of dash) {
          if (s > total) break;
          if (v > 0) on.push([s, Math.min(total, s + v)]);
          else if (v === 0) dotsAt.push(s);
          s += Math.abs(v);
          count++;
        }
      }
    }
    for (const [a, b] of intersect(on, visible)) {
      const piece = [at(a)];
      for (let j = 1; j < n - 1; j++) if (cum[j] > a && cum[j] < b) piece.push(q[j]);
      piece.push(at(b));
      out.strokes.push({ width, points: piece });
    }
    const r = Math.max(width * 0.75, 0.5);
    for (const s of dotsAt) {
      if (!visible.some(([a, b]) => s >= a && s <= b)) continue;
      const p = at(s);
      out.dots.push({ x: p.x, y: p.y, r });
    }
  }
  return out;
}

/** Bounding box of a layout (app space), with stroke widths and text boxes included. */
export function lineStyleLayoutBounds(layout) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const take = (x, y, m = 0) => {
    x1 = Math.min(x1, x - m); y1 = Math.min(y1, y - m); x2 = Math.max(x2, x + m); y2 = Math.max(y2, y + m);
  };
  for (const s of layout.strokes) for (const p of s.points) take(p.x, p.y, s.width);
  for (const d of layout.dots) take(d.x, d.y, d.r);
  for (const sh of layout.shapes) for (const p of sh.points) take(p.x, p.y, sh.width);
  for (const t of layout.texts) take(t.x, t.y, Math.hypot(t.width / 2, t.size / 2) + 1);
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
}

/**
 * The line width a styled markup is laid out with, the same on screen and
 * in the saved appearance: its own width (0 draws as 0.5, like a plain line),
 * else 1 pt.
 */
export function lineStyleWidth(annotation) {
  const lw = Number(annotation?.lineWidth);
  if (!Number.isFinite(lw)) return 1;
  return lw <= 0 ? 0.5 : lw;
}

/** How far (page points) a style can reach beside its centre line. */
export function lineStyleMargin(style, lineWidth = 1) {
  if (!style) return 0;
  const k = style.scaleWithWidth ? Math.max(lineWidth, 0.1) : 1;
  let m = 0;
  for (const l of style.lines || []) m = Math.max(m, Math.abs(l.offset) * k * 4 + lineWidth * l.width);
  for (const mk of style.marks || []) m = Math.max(m, (Math.abs(mk.offset) + mk.size) * k + lineWidth);
  return m + 1;
}

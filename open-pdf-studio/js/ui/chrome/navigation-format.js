// Pure rules behind the Navigation bar and the status bar readouts: the page
// field ("A-101 (1 of 3)"), the page size ("17.00 x 11.00 in"), the page
// scale text ("1/4" = 1'-0""), the cursor coordinates and the content
// dimmer / dark-mode filter. No app state, so node tests every rule
// (navigation-format.test.mjs).

import { SCALE_UNITS, formatRatio, ratioFromPixelsPerUnit } from '../../annotations/scale-entry.js';
import { equationFromScale, matchingPreset, isImperialUnit } from '../../annotations/scale-presets.js';
import { paginaSchaal, schaalOpPunt, geldigeDocumentSchaal } from '../../annotations/schaal-op-punt.js';

const PT_PER_IN = 72;
const MM_PER_IN = 25.4;

// ── Page field ──────────────────────────────────────────────────────────────

/** The label a PDF gives a page (/PageLabels), or null when it is just the number. */
export function pageLabel(labels, page) {
  const label = Array.isArray(labels) ? labels[page - 1] : null;
  if (typeof label !== 'string' || !label.trim()) return null;
  return label.trim() === String(page) ? null : label.trim();
}

// The mark a shortened page label ends with in the page field.
export const LABEL_CUT = '\u2026';

/**
 * The page field text: "A-101 (1 of 3)" with a page label, else "2 of 3".
 * `of` builds the "n of N" part (translated), default English.
 * `maxChars` (optional) is how many characters the field shows: a longer
 * label is cut with "…" so the "(n of N)" part stays visible; the full text
 * is the field's tooltip. With no room for any label, the counter alone.
 */
export function formatPageField(page, numPages, labels = null, of = (p, n) => `${p} of ${n}`, maxChars = 0) {
  if (!numPages) return '';
  const counter = of(page, numPages);
  const label = pageLabel(labels, page);
  if (!label) return counter;
  const full = `${label} (${counter})`;
  if (!(maxChars > 0) || full.length <= maxChars) return full;
  const room = maxChars - counter.length - 3 - LABEL_CUT.length;
  return room >= 3 ? `${label.slice(0, room).trimEnd()}${LABEL_CUT} (${counter})` : counter;
}

/**
 * The page a typed page-field value points to, or null.
 * Accepts a page label ("A-101", case-insensitive), a page number ("2"), or
 * the field's own text left unchanged ("A-101 (1 of 3)", "2 of 3"). A label
 * wins over a number, so a PDF labelled "1", "2"… keeps its own numbering.
 * Out-of-range numbers and unknown labels give null.
 */
export function parsePageInput(text, numPages, labels = null) {
  const n = Number(numPages) || 0;
  if (n < 1) return null;
  let value = String(text ?? '').trim();
  if (!value) return null;
  const counter = value.match(/^(.*?)\s*\(\s*(\d+)\s+\S+\s+\d+\s*\)$/u);
  if (counter) {
    // A label the field shortened ("E-501 LIGHTING PL… (12 of 40)"): the counter.
    value = counter[1].trim().endsWith(LABEL_CUT) ? counter[2] : (counter[1].trim() || counter[2]);
  } else {
    const ofN = value.match(/^(\d+)\s+\S+\s+\d+$/u);
    if (ofN) value = ofN[1];
  }
  const lower = value.toLocaleLowerCase();
  if (Array.isArray(labels)) {
    const at = labels.findIndex((l) => typeof l === 'string' && l.trim().toLocaleLowerCase() === lower);
    if (at >= 0 && at < n) return at + 1;
  }
  if (!/^\d+$/.test(value)) return null;
  const page = parseInt(value, 10);
  return page >= 1 && page <= n ? page : null;
}

// ── Page size ───────────────────────────────────────────────────────────────

/**
 * The unit for paper sizes and uncalibrated coordinates: the system of the
 * page scale when there is one (imperial → in, metric → mm), else English →
 * in, any other language → mm.
 */
export function paperUnitFor(scaleUnit, language = 'en') {
  if (SCALE_UNITS.includes(scaleUnit)) return isImperialUnit(scaleUnit) ? 'in' : 'mm';
  return String(language || 'en').toLowerCase().startsWith('en') ? 'in' : 'mm';
}

const paperValue = (pt, unit) => (unit === 'mm' ? (pt / PT_PER_IN) * MM_PER_IN : pt / PT_PER_IN);

/**
 * "17.00 x 11.00 in" or "432 x 279 mm" for a page of widthPt x heightPt
 * points, as it lies (rotation 90/270 swaps the sides).
 */
export function formatPageSize(widthPt, heightPt, unit = 'in', rotation = 0) {
  if (!(widthPt > 0 && heightPt > 0)) return '';
  const quarter = ((Math.round(rotation / 90) % 4) + 4) % 2 === 1;
  const [w, h] = quarter ? [heightPt, widthPt] : [widthPt, heightPt];
  if (unit === 'mm') return `${Math.round(paperValue(w, 'mm'))} x ${Math.round(paperValue(h, 'mm'))} mm`;
  return `${paperValue(w, 'in').toFixed(2)} x ${paperValue(h, 'in').toFixed(2)} in`;
}

// ── Page scale ──────────────────────────────────────────────────────────────

/**
 * The page-wide scale of `pageNum` (the order pageScaleStatus uses), with the
 * equation it was set with when it has one; null when uncalibrated.
 */
export function pageScaleOf(doc, pageNum, legacyScale = null) {
  if (!doc) return null;
  return paginaSchaal(doc, pageNum) || schaalOpPunt(doc, pageNum, NaN, NaN) || geldigeDocumentSchaal(legacyScale) || null;
}

/**
 * plan-review scale text: the preset label when the scale equals one
 * (1/4" = 1'-0", 1" = 20', 1:100), else 1:N for metric and the equation
 * ("1 in = 5.5 ft", 4 digits) for imperial. '' for no valid scale.
 */
export function scaleLabel(scale) {
  if (!scale || !(scale.pixelsPerUnit > 0) || !SCALE_UNITS.includes(scale.unit)) return '';
  const eq = equationFromScale(scale);
  const preset = eq ? matchingPreset(eq) : null;
  if (preset) return preset.label;
  if (isImperialUnit(scale.unit) && eq) {
    const short = (v) => String(Number(v.toPrecision(4)));
    return `${short(eq.paperValue)} ${eq.paperUnit} = ${short(eq.realValue)} ${eq.realUnit}`;
  }
  return formatRatio(ratioFromPixelsPerUnit(scale.pixelsPerUnit, scale.unit));
}

// ── Cursor coordinates ──────────────────────────────────────────────────────

/**
 * Cursor position text. `point` is in page space (PDF points from the top
 * left of the page). With a calibrated `scale` ({pixelsPerUnit, unit,
 * calibrated}) the values are real lengths in the scale unit; without one
 * they are paper lengths in `paperUnit` (in or mm) and `calibrated` is false,
 * so the caller can say so. Returns { text, calibrated } or null.
 */
export function formatCursorCoords(point, scale, paperUnit = 'in') {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const calibrated = !!scale && scale.calibrated !== false && scale.pixelsPerUnit > 0
    && SCALE_UNITS.includes(scale.unit);
  let x;
  let y;
  let unit;
  if (calibrated) {
    x = point.x / scale.pixelsPerUnit;
    y = point.y / scale.pixelsPerUnit;
    unit = scale.unit;
  } else {
    unit = paperUnit === 'mm' ? 'mm' : 'in';
    x = paperValue(point.x, unit);
    y = paperValue(point.y, unit);
  }
  const digits = unit === 'mm' ? 1 : 2;
  const fmt = (v) => {
    const s = v.toFixed(digits);
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  };
  return { text: `(${fmt(x)}, ${fmt(y)}) ${unit}`, calibrated, unit };
}

// ── Dimmer and dark content ─────────────────────────────────────────────────

export const DIMMER_MAX = 0.9;
export const DIMMER_DEFAULT = 0.5;

export function clampDimmer(level) {
  const v = Number(level);
  if (!Number.isFinite(v)) return DIMMER_DEFAULT;
  return Math.min(DIMMER_MAX, Math.max(0, v));
}

/**
 * CSS filter for the PDF raster: the dimmer fades every colour linearly
 * toward white by `level` (contrast(k) then brightness(1+d) maps [0,1] onto
 * [d,1] exactly); dark mode then inverts the page and turns the hues back,
 * so a dimmed dark page fades toward black. 'none' when neither is on.
 */
export function contentFilterCss({ dimmer = false, level = DIMMER_DEFAULT, dark = false } = {}) {
  const parts = [];
  const d = dimmer ? clampDimmer(level) : 0;
  if (d > 0) {
    const k = (1 - d) / (1 + d);
    parts.push(`contrast(${Number(k.toFixed(4))})`, `brightness(${Number((1 + d).toFixed(4))})`);
  }
  if (dark) parts.push('invert(1)', 'hue-rotate(180deg)');
  return parts.length ? parts.join(' ') : 'none';
}

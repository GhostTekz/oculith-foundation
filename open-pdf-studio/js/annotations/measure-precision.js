// Display precision of a page scale (scaleData.precision) and the length
// formatting it selects. Pure, so node tests every rounding rule.
//
// precision is one of
//   0..6       decimals, any unit                       "12.38 ft"
//   'fN'       inch fractions to 1/N (in only)          "10 1/2""
//   'fiN'      feet-inches to 1/N inch (in and ft)      "23'-10 1/2""
// with N in 2, 4, 8, 16, 32, 64 (and 1 for whole inches in 'fiN').
// A scale without a precision shows imperial lengths (in, ft) as plan-review
// feet-inches to 1/16" (implicitPrecision) and keeps the default formatting
// of formatMeasurement otherwise. Precision applies to lengths; areas keep
// their default.

export const FRACTION_DENOMINATORS = [2, 4, 8, 16, 32, 64];
const FEET_INCH_DENOMINATORS = [1, ...FRACTION_DENOMINATORS];
const LINEAR_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);

// Imperial lengths default to feet-inches at 1/16", the external editor default: a
// takeoff in ft reads 23'-10 1/2", not 23.88 ft. 1/16" (not 1/8") so that
// inch-unit scales and large-scale details keep the resolution the external editor users
// expect; a coarser or decimal display is one pick in Set Scale.
export const IMPERIAL_DEFAULT_PRECISION = 'fi16';
const DEFAULTS = { mm: 0, cm: 1, m: 2, in: IMPERIAL_DEFAULT_PRECISION, ft: IMPERIAL_DEFAULT_PRECISION };
export const defaultPrecision = (unit) => DEFAULTS[unit] ?? 2;

/**
 * The precision a length shows at: the scale's own precision when it has
 * one, feet-inches for an imperial length without one, else undefined (the
 * default formatting of formatMeasurement).
 */
export function implicitPrecision(precision, unit) {
  if (precision != null) return precision;
  return unit === 'ft' || unit === 'in' ? IMPERIAL_DEFAULT_PRECISION : undefined;
}

/**
 * Parsed precision, or null when it is not valid for the unit.
 * @returns {{kind:'decimal', decimals:number} | {kind:'fraction'|'feetInches', denominator:number} | null}
 */
export function parsePrecision(precision, unit) {
  if (!LINEAR_UNITS.has(unit)) return null;
  if (Number.isInteger(precision) && precision >= 0 && precision <= 6) return { kind: 'decimal', decimals: precision };
  const m = typeof precision === 'string' ? precision.match(/^(fi|f)(\d+)$/u) : null;
  if (!m) return null;
  const denominator = Number(m[2]);
  if (m[1] === 'f') {
    return unit === 'in' && FRACTION_DENOMINATORS.includes(denominator) ? { kind: 'fraction', denominator } : null;
  }
  return (unit === 'in' || unit === 'ft') && FEET_INCH_DENOMINATORS.includes(denominator)
    ? { kind: 'feetInches', denominator } : null;
}

export const validPrecision = (precision, unit) => parsePrecision(precision, unit) != null;

/**
 * Options for the precision dropdown of a unit, as {value, precision, label}
 * where value is the select key (String(precision)).
 */
export function precisionOptions(unit) {
  const options = [];
  for (let d = 0; d <= 6; d++) {
    options.push({ value: String(d), precision: d, label: d === 0 ? '1' : (0).toFixed(d).slice(0, -1) + '1' });
  }
  if (unit === 'in') {
    for (const n of FRACTION_DENOMINATORS) options.push({ value: `f${n}`, precision: `f${n}`, label: `1/${n}"` });
  }
  if (unit === 'in' || unit === 'ft') {
    for (const n of FEET_INCH_DENOMINATORS) {
      options.push({ value: `fi${n}`, precision: `fi${n}`, label: n === 1 ? `0'-0"` : `0'-0 1/${n}"` });
    }
  }
  return options;
}

/** The precision behind a dropdown key. */
export function precisionFromKey(key) {
  return /^\d$/u.test(String(key)) ? Number(key) : String(key);
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function fractionPart(numerator, denominator) {
  if (!numerator) return '';
  const g = gcd(numerator, denominator);
  return `${numerator / g}/${denominator / g}`;
}

/**
 * A value rounded to 1/denominator, as "10 1/2", "3/8" or "12".
 * @param {number} value
 * @param {number} denominator
 */
export function formatFraction(value, denominator) {
  const sign = value < 0 ? '-' : '';
  const n = Math.round(Math.abs(value) * denominator);
  const whole = Math.floor(n / denominator);
  const frac = fractionPart(n % denominator, denominator);
  if (!frac) return `${sign}${whole}`;
  return whole ? `${sign}${whole} ${frac}` : `${sign}${frac}`;
}

/**
 * Feet-inches rounded to 1/denominator inch, carrying into the next inch and
 * foot: 148.5 in at 1/2" is 12'-4 1/2"; 143.97 in at 1/16" is 12'-0".
 * @param {number} inches total length in inches
 * @param {number} denominator 1 for whole inches
 */
export function formatFeetInches(inches, denominator) {
  const sign = inches < 0 ? '-' : '';
  const n = Math.round(Math.abs(inches) * denominator);
  const perFoot = 12 * denominator;
  const feet = Math.floor(n / perFoot);
  const rest = n - feet * perFoot;
  const whole = Math.floor(rest / denominator);
  const frac = fractionPart(rest % denominator, denominator);
  return `${sign}${feet}'-${whole}${frac ? ` ${frac}` : ''}"`;
}

/**
 * A length in its unit at a scale precision, or null when the precision does
 * not apply (no precision, an area or angle unit, or not valid for the unit).
 * @param {number} value
 * @param {string} unit
 * @param {number|string|undefined} precision
 * @returns {string|null}
 */
export function formatLengthWithPrecision(value, unit, precision) {
  if (precision == null || !Number.isFinite(value)) return null;
  const p = parsePrecision(precision, unit);
  if (!p) return null;
  if (p.kind === 'decimal') return `${value.toFixed(p.decimals)} ${unit}`;
  if (p.kind === 'fraction') return `${formatFraction(value, p.denominator)}"`;
  return formatFeetInches(unit === 'ft' ? value * 12 : value, p.denominator);
}

// ---- Display units ---------------------------------------------------------
//
// The scale has its own unit; a reader can show measurements in another one
// ('ft-in', 'in' with fractions, decimal 'ft', 'mm', 'cm', 'm') and add the
// other system in brackets, e.g. 9'-5 15/16" (2894 mm). Areas follow: square
// feet, square inches or square metres.

export const DISPLAY_UNITS = Object.freeze(['auto', 'ft-in', 'in', 'ft', 'mm', 'cm', 'm']);
const MM_PER = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const IMPERIAL = new Set(['ft-in', 'in', 'ft']);
const SQ = '²';

/** The inch fraction a scale precision asks for ('fi8', 'f32'), else 16. */
export function displayDenominator(precision) {
  const m = typeof precision === 'string' ? precision.match(/^fi?(\d+)$/u) : null;
  const d = m ? Number(m[1]) : 0;
  return d >= 1 && d <= 64 ? d : 16;
}

function lengthText(mm, target, denominator) {
  switch (target) {
    case 'ft-in': return formatFeetInches(mm / 25.4, denominator);
    case 'in': return `${formatFraction(mm / 25.4, denominator)}"`;
    case 'ft': return `${(mm / 304.8).toFixed(2)} ft`;
    case 'mm': return `${Math.round(mm)} mm`;
    case 'cm': return `${(mm / 10).toFixed(1)} cm`;
    case 'm': return `${(mm / 1000).toFixed(3)} m`;
    default: return null;
  }
}

function areaText(mm2, target) {
  if (target === 'in') return `${(mm2 / 645.16).toFixed(2)} in${SQ}`;
  if (IMPERIAL.has(target)) return `${(mm2 / 92903.04).toFixed(2)} ft${SQ}`;
  return `${(mm2 / 1e6).toFixed(2)} m${SQ}`;
}

/**
 * A length or area measured in `unit`, shown in `target`; null when the unit
 * is not a physical length or area (points, angles) or the target is unknown.
 */
export function displayText(value, unit, target, denominator = 16) {
  if (!Number.isFinite(value) || !DISPLAY_UNITS.includes(target) || target === 'auto') return null;
  const area = typeof unit === 'string' && unit.endsWith(SQ);
  const base = area ? unit.slice(0, -1) : unit;
  if (!MM_PER[base]) return null;
  return area ? areaText(value * MM_PER[base] ** 2, target) : lengthText(value * MM_PER[base], target, denominator);
}

/**
 * The same measurement in the other system: metric (mm below 10 m, as
 * drawings dimension them, else m) for an imperial reading, feet-inches for a
 * metric one.
 */
export function otherSystemText(value, unit, shownIn = 'auto', denominator = 16) {
  const area = typeof unit === 'string' && unit.endsWith(SQ);
  const base = area ? unit.slice(0, -1) : unit;
  if (!MM_PER[base] || !Number.isFinite(value)) return null;
  const shown = shownIn === 'auto' ? (base === 'ft' ? 'ft-in' : base) : shownIn;
  if (IMPERIAL.has(shown)) {
    if (area) return displayText(value, unit, 'm', denominator);
    return displayText(value, unit, value * MM_PER[base] < 10000 ? 'mm' : 'm', denominator);
  }
  return displayText(value, unit, 'ft-in', denominator);
}

/**
 * The measurement-rounding preference ('1', '5', '10': a step in
 * millimetres) as a step in a length unit, with the decimals that step
 * needs; null when the reading is not a physical length (areas, volumes,
 * angles, page points) or the preference is off.
 * @returns {{step:number, decimals:number} | null}
 */
export function roundingStepIn(rounding, unit) {
  if (!rounding || rounding === 'none') return null;
  const stepMm = parseFloat(rounding);
  if (!(stepMm > 0) || !MM_PER[unit]) return null;
  const step = stepMm / MM_PER[unit];
  let decimals = 0;
  while (decimals < 6 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-9) decimals++;
  return { step, decimals };
}

/** A length rounded to the preference step (see roundingStepIn); other readings unchanged. */
export function roundToPreferenceStep(value, unit, rounding) {
  const r = roundingStepIn(rounding, unit);
  if (!r || !Number.isFinite(value)) return value;
  return Number((Math.round(value / r.step) * r.step).toFixed(r.decimals + 6));
}

// Conduit fill: conductors in a conduit run, NEC Chapter 9 (docs/reference/editor/raceways.md,
// "Conduit fill").
//
//   Table 1  the fill limit: 1 conductor 53 %, 2 conductors 31 %, over 2 40 %
//            of the conduit's internal area. (Nipples of 24" or less may be
//            filled to 60 %, Note 4; not used here: a run is not a nipple.)
//   Table 4  the internal area (100 %) per conduit type and trade size.
//   Table 5  the approximate area of an insulated conductor.
//
// conductors = [{ count, size: '12' | '1/0' | '250', insulation: 'THHN' }];
// the equipment grounding conductor is an ordinary entry. Bare conductors,
// compact conductors (Table 5A), multiconductor cables (Note 9) and the
// Note 7 round-up are out of scope.
//
// Pure, and on purpose without imports: raceway.js imports the normaliser from
// here, so this module must not import raceway.js back.

/** Conductor sizes, smallest first (AWG, then kcmil). */
export const CONDUCTOR_SIZES = Object.freeze(['14', '12', '10', '8', '6', '4', '3', '2', '1',
  '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500']);

const row = (values) => Object.freeze(Object.fromEntries(CONDUCTOR_SIZES.map((s, i) => [s, values[i]])));

// Table 5 approximate areas (in²). THHN/THWN-2 and XHHW-2 match the
// PDHonline course E276 tables (source [8] in docs/reference/editor/raceways.md) for every
// size. RHH/RHW/RHW-2 without an outer covering: 6 AWG–500 kcmil match the
// THHW rows of the same source (Table 5 lists them in one row group); the
// 14–8 AWG values are nominal (from the NEC table, not checked against a
// second source).
export const INSULATIONS = Object.freeze({
  THHN: Object.freeze({ label: 'THHN/THWN-2', area: row([0.0097, 0.0133, 0.0211, 0.0366, 0.0507, 0.0824, 0.0973,
    0.1158, 0.1562, 0.1855, 0.2223, 0.2679, 0.3237, 0.3970, 0.4608, 0.5242, 0.5863, 0.7073]) }),
  XHHW: Object.freeze({ label: 'XHHW-2', area: row([0.0139, 0.0181, 0.0243, 0.0437, 0.0590, 0.0814, 0.0962,
    0.1146, 0.1534, 0.1825, 0.2190, 0.2642, 0.3197, 0.3904, 0.4536, 0.5166, 0.5782, 0.6984]) }),
  RHW: Object.freeze({ label: 'RHH/RHW-2', area: row([0.0209, 0.0260, 0.0333, 0.0556, 0.0726, 0.0973, 0.1134,
    0.1333, 0.1901, 0.2223, 0.2624, 0.3117, 0.3718, 0.4596, 0.5281, 0.5958, 0.6619, 0.7901]) }),
});
export const INSULATION_IDS = Object.freeze(Object.keys(INSULATIONS));

// Other spellings of the same Table 5 rows.
const INSULATION_ALIASES = Object.freeze({
  THHN: 'THHN', THWN: 'THHN', 'THWN-2': 'THHN', 'THHN/THWN': 'THHN', 'THHN/THWN-2': 'THHN',
  XHHW: 'XHHW', 'XHHW-2': 'XHHW', XHH: 'XHHW', XHWN: 'XHHW', 'XHWN-2': 'XHHW',
  RHW: 'RHW', RHH: 'RHW', 'RHW-2': 'RHW', 'RHH/RHW-2': 'RHW', 'RHH/RHW': 'RHW',
});
const SIZE_ALIASES = Object.freeze({ '0': '1/0', '00': '2/0', '000': '3/0', '0000': '4/0' });

const TRADE = ['1/2', '3/4', '1', '1-1/4', '1-1/2', '2', '2-1/2', '3', '3-1/2', '4', '5', '6'];
const areas = (values) => Object.freeze(Object.fromEntries(
  values.map((v, i) => [TRADE[i], v]).filter(([, v]) => v != null)));

// Table 4 internal areas, 100 % (in²). EMT, IMC, RMC and PVC Sch 40 / 80 match
// the PDHonline E276 tables [8] for every size; FMC and LFMC are nominal.
export const CONDUIT_AREAS = Object.freeze({
  EMT: areas([0.304, 0.533, 0.864, 1.496, 2.036, 3.356, 5.858, 8.846, 11.545, 14.753]),
  IMC: areas([0.342, 0.586, 0.959, 1.647, 2.225, 3.630, 5.135, 7.922, 10.584, 13.631]),
  RMC: areas([0.314, 0.549, 0.887, 1.526, 2.071, 3.408, 4.866, 7.499, 10.010, 12.882, 20.212, 29.158]),
  PVC40: areas([0.285, 0.508, 0.832, 1.453, 1.986, 3.291, 4.695, 7.268, 9.737, 12.554, 19.761, 28.567]),
  PVC80: areas([0.217, 0.409, 0.688, 1.237, 1.711, 2.874, 4.119, 6.442, 8.688, 11.258, 17.855, 25.598]),
  FMC: areas([0.317, 0.533, 0.817, 1.277, 1.858, 3.269, 4.909, 7.069, 9.621, 12.566]),
  LFMC: areas([0.314, 0.541, 0.873, 1.528, 1.981, 3.246, 4.881, 7.475, 9.731, 12.692]),
});

/** Table 1: percent of the internal area for 1, 2 and over 2 conductors. */
export const FILL_LIMITS = Object.freeze({ one: 53, two: 31, more: 40 });
/** Note 4 (nipples ≤ 24"); exported for reference, not applied to runs. */
export const NIPPLE_FILL_LIMIT = 60;

export const MAX_CONDUCTOR_ROWS = 30;
export const MAX_CONDUCTOR_COUNT = 999;

/** The Table 1 limit (%) for a number of conductors. */
export function fillLimit(count) {
  if (count === 1) return FILL_LIMITS.one;
  if (count === 2) return FILL_LIMITS.two;
  return FILL_LIMITS.more;
}

/** Catalogue id of an insulation ('THWN-2' → 'THHN'), or null. */
export function insulationId(v) {
  return INSULATION_ALIASES[String(v ?? '').trim().toUpperCase()] || null;
}

/** Catalogue size ('12', '1/0', '250'; '250 kcmil', 'AWG 12', '00' too), or null. */
export function conductorSize(v) {
  let s = String(v ?? '').trim().toLowerCase().replace(/\s*(kcmil|mcm|awg)\s*/g, '').replace(/^#/, '');
  s = SIZE_ALIASES[s] || s;
  return CONDUCTOR_SIZES.includes(s) ? s : null;
}

/** Table 5 area (in²) of one conductor, or null when it is not in the catalogue. */
export function conductorArea(size, insulation) {
  const ins = INSULATIONS[insulationId(insulation)];
  const s = conductorSize(size);
  return ins && s ? ins.area[s] : null;
}

/** Table 4 internal area (in²) of a conduit type and trade size, or null. */
export function conduitArea(type, tradeSize) {
  return CONDUIT_AREAS[type]?.[String(tradeSize)] ?? null;
}

const countOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CONDUCTOR_COUNT) : null;
};

/**
 * Clean conductor rows for raceway.conductors: a whole count ≥ 1, a known
 * size and insulation (THHN when none is given). Rows that are not
 * understood are dropped; at most MAX_CONDUCTOR_ROWS.
 */
export function normalizeConductors(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const count = countOf(r.count ?? 1);
    const size = conductorSize(r.size);
    const insulation = r.insulation == null || r.insulation === '' ? 'THHN' : insulationId(r.insulation);
    if (count && size && insulation) out.push({ count, size, insulation });
    if (out.length >= MAX_CONDUCTOR_ROWS) break;
  }
  return out;
}

/**
 * The fill of a conduit raceway ({ conduitType, tradeSize }) with `conductors`.
 * Returns { areaIn2, conductorAreaIn2, count, fillPercent, limitPercent, over,
 * unknown } — `unknown` lists the rows whose size or insulation is not in
 * Table 5 (they are counted for the limit but add no area, so the fill is a
 * lower bound). areaIn2 / fillPercent are null for a size without a Table 4
 * area. Null for a tray or when there are no conductors.
 */
export function conduitFill(raceway, conductors = raceway?.conductors) {
  if (!raceway || (raceway.kind && raceway.kind !== 'conduit')) return null;
  if (!Array.isArray(conductors)) return null;
  let count = 0, conductorAreaIn2 = 0;
  const unknown = [];
  for (const c of conductors) {
    const n = countOf(c?.count ?? 1);
    if (!n) { unknown.push(c); continue; }
    count += n;
    const a = conductorArea(c.size, c.insulation == null || c.insulation === '' ? 'THHN' : c.insulation);
    if (a == null) unknown.push(c);
    else conductorAreaIn2 += n * a;
  }
  if (count === 0) return null;
  const areaIn2 = conduitArea(raceway.conduitType, raceway.tradeSize);
  const limitPercent = fillLimit(count);
  const fillPercent = areaIn2 ? (conductorAreaIn2 / areaIn2) * 100 : null;
  // Compare areas (not rounded percentages); 1e-9 absorbs float noise.
  const over = areaIn2 != null && conductorAreaIn2 > areaIn2 * limitPercent / 100 + 1e-9;
  return { areaIn2, conductorAreaIn2, count, fillPercent, limitPercent, over, unknown };
}

/**
 * The smallest trade size of conduit `type` the conductors fit in (Table 1
 * limit), the "what size conduit" answer; null when none fits, the type is
 * unknown or there are no conductors.
 */
export function smallestConduitFor(type, conductors) {
  const sizes = CONDUIT_AREAS[type];
  if (!sizes) return null;
  for (const tradeSize of TRADE) {
    if (sizes[tradeSize] == null) continue;
    const f = conduitFill({ kind: 'conduit', conduitType: type, tradeSize }, conductors);
    if (!f) return null;
    if (!f.over) return tradeSize;
  }
  return null;
}

/** A percentage for the label: whole, but never rounded down onto the limit. */
export function fillPercentText(fill) {
  const p = fill.fillPercent;
  const whole = Math.round(p);
  return fill.over && whole <= fill.limitPercent ? (Math.ceil(p * 10 - 1e-9) / 10).toFixed(1) : String(whole);
}

/**
 * Label part: 'Fill 13% (≤40%)', or '⚠ fill 44% > 40%' over the limit; a
 * fill with unknown conductors reads 'Fill ≥13% (≤40%)'. Empty without fill.
 */
export function fillText(fill) {
  if (!fill || fill.fillPercent == null) return '';
  const p = fillPercentText(fill);
  if (fill.over) return `⚠ fill ${p}% > ${fill.limitPercent}%`;
  return `Fill ${fill.unknown.length ? '≥' : ''}${p}% (≤${fill.limitPercent}%)`;
}

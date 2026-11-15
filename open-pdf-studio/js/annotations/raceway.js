// Raceways: conduit and cable tray runs (docs/reference/editor/raceways.md).
//
// A run is a measurePerimeter annotation with measureKind 'raceway'. Its
// `points` are the corners the user clicked; its `raceway` object says what
// runs there:
//
//   { kind: 'conduit', conduitType: 'EMT', tradeSize: '3/4', trueSize: false,
//     radiusIn?: number }
//   { kind: 'tray', trayStyle: 'ladder' | 'basket', widthIn, railIn, rungIn,
//     radiusIn?: number }
//
// Marks on points (phase 3): `marks` { [pointIndex]: 'pull' | 'up' | 'down' }
// — a pull box / conduit body (no elbow there; NEC bends are counted per
// section between pull points), or the run turning up / down out of the
// plan (a 90° vertical bend, drawn with the riser / drop symbol). `tag` is a
// run ID such as a circuit number, shown in the label.
//
// Branches: `branchOf` { id, at: { x, y } } — the run starts on the centre
// line of another run of the same kind (annotation `id`, page point `at`).
// The fitting there is derived, never stored (branchJunction): a tee off the
// side, a cross with an opposite branch at the same point, a straight
// connection on the parent's end point, plus a reducer when the sizes differ.
//
// Every corner is an elbow: a circular arc tangent to both segments at the
// fitting's standard radius (conduit: centre-line radius from NEC Chapter 9
// Table 2 for one-shot/full-shoe bends; tray: inside radius of the fitting).
// Physical sizes are in inches here, but nothing below assumes imperial: the
// caller passes `pxPerIn` (page points per inch at the run, from the page
// scale), and a metric catalog can be added the same way. Without a
// calibration (`pxPerIn` null) the takeoff is symbolic (sharp corners, lengths
// in page units); a conduit is drawn as a centre line and a cable tray as a
// schematic tray at SCHEMATIC_PX_PER_IN, so it still reads as cable tray.
//
// Everything here is pure (no app state), so the node tests drive it.

import { normalizeConductors } from './conduit-fill.js';

export const RACEWAY_KINDS = Object.freeze(['conduit', 'tray']);
export const TRAY_STYLES = Object.freeze(['ladder', 'basket']);
export const TRADE_SIZES = Object.freeze(['1/2', '3/4', '1', '1-1/4', '1-1/2', '2', '2-1/2', '3', '3-1/2', '4', '5', '6']);

/** Inches of a trade size string ('1-1/4' → 1.25). */
export function tradeSizeInches(size) {
  const m = String(size).match(/^(\d+)(?:-(\d+)\/(\d+))?$|^(\d+)\/(\d+)$/);
  if (!m) return null;
  if (m[4]) return Number(m[4]) / Number(m[5]);
  return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}

// Outside diameters (in) by trade size. EMT ½"–1" are verified against
// published ANSI C80.3 tables; the other values are the nominal NEC Chapter 9
// Table 4 / ANSI C80.1, C80.6 and NEMA TC-2 figures and are marked nominal in
// docs/reference/editor/raceways.md. Rigid PVC uses iron-pipe-size outside diameters (same as
// RMC). FMC/LFMC outside diameters vary by maker; these are typical values.
const OD_IPS = { '1/2': 0.840, '3/4': 1.050, '1': 1.315, '1-1/4': 1.660, '1-1/2': 1.900, '2': 2.375,
  '2-1/2': 2.875, '3': 3.500, '3-1/2': 4.000, '4': 4.500, '5': 5.563, '6': 6.625 };
const OD_EMT = { '1/2': 0.706, '3/4': 0.922, '1': 1.163, '1-1/4': 1.510, '1-1/2': 1.740, '2': 2.197,
  '2-1/2': 2.875, '3': 3.500, '3-1/2': 4.000, '4': 4.500 };
const OD_IMC = { '1/2': 0.815, '3/4': 1.029, '1': 1.290, '1-1/4': 1.638, '1-1/2': 1.883, '2': 2.360,
  '2-1/2': 2.857, '3': 3.476, '3-1/2': 3.971, '4': 4.466 };
const OD_FMC = { '1/2': 0.865, '3/4': 1.090, '1': 1.345, '1-1/4': 1.710, '1-1/2': 1.980, '2': 2.470,
  '2-1/2': 2.990, '3': 3.560, '3-1/2': 4.070, '4': 4.580 };
const OD_LFMC = { '1/2': 0.840, '3/4': 1.050, '1': 1.315, '1-1/4': 1.660, '1-1/2': 1.900, '2': 2.375,
  '2-1/2': 2.875, '3': 3.500, '3-1/2': 4.000, '4': 4.500 };

// Minimum bend radius to the conduit centre line (in), NEC Chapter 9 Table 2,
// one-shot and full-shoe benders (1" = 5¾" and 2" = 9½" checked against
// published references; the rest nominal). Used as the default elbow radius.
const BEND_RADIUS_IN = { '1/2': 4, '3/4': 4.5, '1': 5.75, '1-1/4': 7.25, '1-1/2': 8.25, '2': 9.5,
  '2-1/2': 10.5, '3': 13, '3-1/2': 15, '4': 16, '5': 24, '6': 30 };

/** Conduit types: label, outside diameters and whether the NEC 360° rule applies. */
export const CONDUIT_TYPES = Object.freeze({
  EMT: { label: 'EMT', od: OD_EMT },
  RMC: { label: 'RMC', od: OD_IPS },
  IMC: { label: 'IMC', od: OD_IMC },
  PVC40: { label: 'PVC Sch 40', od: OD_IPS },
  PVC80: { label: 'PVC Sch 80', od: OD_IPS },
  FMC: { label: 'FMC', od: OD_FMC },
  LFMC: { label: 'LFMC', od: OD_LFMC },
});
export const CONDUIT_TYPE_IDS = Object.freeze(Object.keys(CONDUIT_TYPES));

/** Trade sizes a conduit type comes in. */
export function conduitSizes(type) {
  const t = CONDUIT_TYPES[type];
  return t ? TRADE_SIZES.filter((s) => t.od[s] != null) : [];
}

/** Tray widths (in) per style; basket comes narrower. */
export const TRAY_WIDTHS = Object.freeze({
  ladder: Object.freeze([6, 9, 12, 18, 24, 30, 36]),
  basket: Object.freeze([2, 4, 6, 8, 12, 16, 18, 20, 24]),
});
/** Side rail heights (in): ladder 3–8" (manufacturer data), basket 2–6". */
export const RAIL_HEIGHTS = Object.freeze({
  ladder: Object.freeze([3, 4, 5, 6, 8]),
  basket: Object.freeze([2, 4, 6]),
});
export const DEFAULT_RUNG_IN = 9;
/** Basket mesh (in): 2" across the tray, 4" along it. */
export const BASKET_MESH_IN = Object.freeze({ across: 2, along: 4 });
/** Inside radius of a tray elbow (in); 12/24/36 are the common catalogue radii. */
export const TRAY_RADII_IN = Object.freeze([12, 24, 36]);
export const DEFAULT_TRAY_RADIUS_IN = 12;

/**
 * Drawing scale (page points per inch) of a cable tray on a sheet without a
 * scale: 1/8" = 1'-0" (1:96), so a 12" tray is drawn 9 pt wide and a 24" one
 * 18 pt. Only the drawing uses it; the takeoff stays in page points with
 * 'Scale not set', and the run is redrawn at its true width once the sheet
 * gets a scale.
 */
export const SCHEMATIC_PX_PER_IN = 0.75;

/**
 * Page points per inch a run is drawn at: the scale at the run, else (tray
 * only) SCHEMATIC_PX_PER_IN; null = a single centre line.
 */
export function drawPxPerIn(raceway, pxPerIn) {
  const p = pos(pxPerIn);
  if (p) return p;
  return raceway?.kind === 'tray' ? SCHEMATIC_PX_PER_IN : null;
}

/** Standard elbow angles (deflection at a corner, degrees). */
export const BEND_ANGLES = Object.freeze([30, 45, 60, 90]);
/** NEC 344.26, 358.26 etc.: at most 360° of bends between pull points. */
export const NEC_MAX_BENDS = 360;

export const MARK_KINDS = Object.freeze(['pull', 'up', 'down']);
export const MAX_TAG_LENGTH = 40;

/** Clean marks: integer point indices → a known kind. */
export function normalizeMarks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && MARK_KINDS.includes(v)) out[i] = v;
  }
  return out;
}

const cleanTag = (t) => (typeof t === 'string' ? t.trim().slice(0, MAX_TAG_LENGTH) : '');

export const DEFAULT_CONDUIT = Object.freeze({ kind: 'conduit', conduitType: 'EMT', tradeSize: '3/4', trueSize: false });
export const DEFAULT_TRAY = Object.freeze({ kind: 'tray', trayStyle: 'ladder', widthIn: 12, railIn: 4, rungIn: DEFAULT_RUNG_IN });

const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** A clean raceway object (defaults for anything missing or invalid). */
export function normalizeRaceway(raw = {}) {
  const kind = RACEWAY_KINDS.includes(raw?.kind) ? raw.kind : 'conduit';
  if (kind === 'conduit') {
    const conduitType = CONDUIT_TYPES[raw.conduitType] ? raw.conduitType : DEFAULT_CONDUIT.conduitType;
    const sizes = conduitSizes(conduitType);
    const tradeSize = sizes.includes(String(raw.tradeSize)) ? String(raw.tradeSize)
      : (sizes.includes(DEFAULT_CONDUIT.tradeSize) ? DEFAULT_CONDUIT.tradeSize : sizes[0]);
    const out = { kind, conduitType, tradeSize, trueSize: raw.trueSize === true };
    if (pos(raw.radiusIn)) out.radiusIn = pos(raw.radiusIn);
    return withBranch(withExtras(out, raw), raw);
  }
  const trayStyle = TRAY_STYLES.includes(raw.trayStyle) ? raw.trayStyle : DEFAULT_TRAY.trayStyle;
  const out = {
    kind, trayStyle,
    widthIn: pos(raw.widthIn) ?? (trayStyle === 'basket' ? 12 : DEFAULT_TRAY.widthIn),
    railIn: pos(raw.railIn) ?? (trayStyle === 'basket' ? 2 : DEFAULT_TRAY.railIn),
    rungIn: pos(raw.rungIn) ?? DEFAULT_RUNG_IN,
  };
  if (pos(raw.radiusIn)) out.radiusIn = pos(raw.radiusIn);
  return withBranch(withExtras(out, raw), raw);
}

// Marks and tag only when set, so a plain run stays as small as before.
function withExtras(out, raw) {
  const marks = normalizeMarks(raw?.marks);
  if (Object.keys(marks).length) out.marks = marks;
  const tag = cleanTag(raw?.tag);
  if (tag) out.tag = tag;
  // Conductors in a conduit (conduit-fill.js), only when there are any.
  const conductors = out.kind === 'conduit' ? normalizeConductors(raw?.conductors) : [];
  if (conductors.length) out.conductors = conductors;
  return out;
}

// A branch's connection only when it is valid: { id, at: { x, y } }.
function withBranch(out, raw) {
  const branchOf = normalizeBranchOf(raw?.branchOf);
  if (branchOf) out.branchOf = branchOf;
  return out;
}

/** Outside diameter (in) of a conduit raceway, or null. */
export function conduitOD(rw) {
  return CONDUIT_TYPES[rw?.conduitType]?.od[rw?.tradeSize] ?? null;
}

/**
 * Centre-line radius (in) of the elbows of a run: conduit = its own radius
 * or the Table 2 bend radius; tray = inside radius (own or 12") + half the
 * width, since a tray fitting's radius is measured to the inside rail.
 */
export function centreRadiusIn(rw) {
  if (rw.kind === 'conduit') return pos(rw.radiusIn) ?? BEND_RADIUS_IN[rw.tradeSize] ?? 6;
  return (pos(rw.radiusIn) ?? DEFAULT_TRAY_RADIUS_IN) + rw.widthIn / 2;
}

/** Overall width (in) drawn for a run at true size, or 0 for a single line. */
export function bandWidthIn(rw) {
  if (rw.kind === 'tray') return rw.widthIn;
  return rw.trueSize ? (conduitOD(rw) || 0) : 0;
}

/** Short label: '3/4" EMT', '24" Ladder tray, 4" rail'. */
export function racewayLabel(rw) {
  if (rw.kind === 'conduit') return `${rw.tradeSize}" ${CONDUIT_TYPES[rw.conduitType]?.label || rw.conduitType}`;
  return `${fmtIn(rw.widthIn)}" ${rw.trayStyle === 'basket' ? 'Basket' : 'Ladder'} tray, ${fmtIn(rw.railIn)}" rail`;
}
const fmtIn = (v) => String(Number(Number(v).toFixed(3)));

// ── Geometry ──

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const unit = (v) => { const l = len(v); return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 }; };

/** Deflection (degrees, 0–180) and turn sign at corner b of a → b → c. */
export function deflectionAt(a, b, c) {
  const u1 = unit(sub(b, a)), u2 = unit(sub(c, b));
  const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const cross = u1.x * u2.y - u1.y * u2.x;
  return { deg: Math.acos(dot) * 180 / Math.PI, sign: cross >= 0 ? 1 : -1, u1, u2 };
}

/** The standard elbow angle a deflection is (within 0.5°), or null for a custom bend. */
export function standardAngle(deg) {
  for (const a of BEND_ANGLES) if (Math.abs(deg - a) <= 0.5) return a;
  return null;
}

/**
 * Snap the next segment's direction to a standard deflection from the
 * previous one: `prevDir` and `wanted` are vectors; returns the snapped unit
 * direction (straight on, or turned by 30/45/60/90° either way).
 */
export function snapBend(prevDir, wanted, angles = BEND_ANGLES) {
  const a0 = Math.atan2(prevDir.y, prevDir.x);
  const aw = Math.atan2(wanted.y, wanted.x);
  let d = (aw - a0) * 180 / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  let best = 0, bestErr = Math.abs(d);
  for (const a of angles) {
    for (const s of [a, -a]) {
      const err = Math.abs(d - s);
      if (err < bestErr) { bestErr = err; best = s; }
    }
  }
  const r = a0 + best * Math.PI / 180;
  return { x: Math.cos(r), y: Math.sin(r), deflection: best };
}

const ARC_STEPS_PER_90 = 12;

/**
 * The run's geometry. `pxPerIn`: page points per inch (null = uncalibrated:
 * sharp corners, symbolic). Returns
 *   centre      the centre line with every elbow as an arc (densified)
 *   corners     per corner: { at, deg, standard, radiusPx, clamped }
 *   straightPx  length of the straight parts, arcPx the elbows' arc length,
 *   developedPx their sum (the centre-line length you pull wire through)
 *   bendTotal   sum of the deflections (degrees)
 *   fittings    [{ angle: 90 | 45 | ... | 'custom', count }]
 */
export function racewayGeometry(points, raceway, pxPerIn, junction = null) {
  const rw = normalizeRaceway(raceway);
  // Repeated points dropped; marks follow their original index.
  const pts = [], markAt = [];
  (points || []).forEach((p, i) => {
    if (pts.length && len(sub(p, pts[pts.length - 1])) <= 1e-9) {
      if (rw.marks?.[i]) markAt[pts.length - 1] = rw.marks[i];
      return;
    }
    pts.push(p);
    markAt.push(rw.marks?.[i] || null);
  });
  const out = { centre: pts.slice(), corners: [], arcs: [], straightPx: 0, arcPx: 0, developedPx: 0, bendTotal: 0, fittings: [],
    bendSections: [0], bendMax: 0, marks: [] };
  if (pts.length < 2) return out;
  const radiusPx = pxPerIn ? centreRadiusIn(rw) * pxPerIn : 0;
  const segLen = pts.slice(1).map((p, i) => len(sub(p, pts[i])));
  // Tangent length at each corner, clamped so neighbouring elbows fit on
  // their shared segment (half each).
  const corners = [];
  for (let i = 1; i < pts.length - 1; i++) {
    // A pull box takes the corner: no elbow, no bend.
    if (markAt[i] === 'pull') continue;
    const d = deflectionAt(pts[i - 1], pts[i], pts[i + 1]);
    if (d.deg < 0.01) continue;
    const th = d.deg * Math.PI / 180;
    let r = radiusPx;
    let t = r * Math.tan(th / 2);
    const room = Math.min(segLen[i - 1], segLen[i]) / 2;
    let clamped = false;
    if (t > room) { t = room; r = t / Math.tan(th / 2); clamped = radiusPx > 0; }
    corners.push({ at: i, deg: d.deg, sign: d.sign, u1: d.u1, u2: d.u2, th, r, t, clamped });
  }
  const centre = [pts[0]];
  let arcPx = 0;
  // Pull-box corners stay sharp corners of the centre line (no elbow there).
  const sharp = [];
  for (let i = 1; i < pts.length - 1; i++) if (markAt[i] === 'pull') sharp.push({ at: i, pull: true });
  const steps = [...corners, ...sharp].sort((a, b) => a.at - b.at);
  for (const c of steps) {
    const P = pts[c.at];
    if (c.pull) { centre.push({ x: P.x, y: P.y }); continue; }
    const T1 = { x: P.x - c.u1.x * c.t, y: P.y - c.u1.y * c.t };
    centre.push(T1);
    if (c.r > 0) {
      // Centre of the arc: from T1 along the inward normal of the incoming leg.
      const n = { x: -c.u1.y * c.sign, y: c.u1.x * c.sign };
      const C = { x: T1.x + n.x * c.r, y: T1.y + n.y * c.r };
      const a0 = Math.atan2(T1.y - C.y, T1.x - C.x);
      const sweep = c.sign * c.th;
      const steps = Math.max(2, Math.ceil(ARC_STEPS_PER_90 * c.th / (Math.PI / 2)));
      for (let k = 1; k <= steps; k++) {
        const a = a0 + sweep * k / steps;
        centre.push({ x: C.x + c.r * Math.cos(a), y: C.y + c.r * Math.sin(a) });
      }
      arcPx += c.r * c.th;
      out.arcs.push({ cx: C.x, cy: C.y, r: c.r, a0, sweep });
    } else {
      centre.push({ x: P.x, y: P.y });
    }
  }
  centre.push(pts[pts.length - 1]);
  const tangentTotal = corners.reduce((s, c) => s + 2 * c.t, 0);
  out.centre = centre.filter((p, i, a) => i === 0 || len(sub(p, a[i - 1])) > 1e-9);
  out.straightPx = segLen.reduce((s, v) => s + v, 0) - tangentTotal;
  out.arcPx = arcPx;
  out.developedPx = out.straightPx + arcPx;
  out.corners = corners.map((c) => ({
    at: c.at, deg: c.deg, standard: standardAngle(c.deg), radiusPx: c.r, clamped: c.clamped,
  }));
  const counts = new Map();
  for (const c of out.corners) {
    const key = c.standard ?? 'custom';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // Marks: pull boxes split the bend count into sections; up / down are 90°
  // vertical bends (a riser or drop elbow).
  const bendAt = new Map(out.corners.map((c) => [c.at, c.deg]));
  const sections = [0];
  for (let i = 0; i < pts.length; i++) {
    const m = markAt[i];
    if (bendAt.has(i)) sections[sections.length - 1] += bendAt.get(i);
    if (m === 'up' || m === 'down') sections[sections.length - 1] += 90;
    if (m) {
      out.marks.push({ at: i, kind: m, x: pts[i].x, y: pts[i].y });
      counts.set(m, (counts.get(m) || 0) + 1);
    }
    if (m === 'pull' && i > 0 && i < pts.length - 1) sections.push(0);
  }
  // A branch's fitting where it starts on its parent (branchJunction).
  for (const k of junctionFittings(junction)) counts.set(k, (counts.get(k) || 0) + 1);
  out.bendSections = sections;
  out.bendTotal = sections.reduce((s, v) => s + v, 0);
  out.bendMax = Math.max(...sections);
  const order = (k) => (typeof k === 'number' ? -k : { custom: 1, up: 2, down: 3, pull: 4, tee: 5, cross: 6, reducer: 7 }[k]);
  out.fittings = [...counts.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([angle, count]) => ({ angle, count }));
  return out;
}

function circle(cx, cy, r, n = 16) {
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push({ x: cx + r * Math.cos(2 * Math.PI * k / n), y: cy + r * Math.sin(2 * Math.PI * k / n) });
  return pts;
}

/** Polylines of a mark symbol at m (see racewayDrawing). */
export function markSymbol(m, r) {
  const { x, y } = m;
  if (m.kind === 'pull') {
    return [[{ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x + r, y: y + r }, { x: x - r, y: y + r }, { x: x - r, y: y - r }]];
  }
  if (m.kind === 'up') return [circle(x, y, r), circle(x, y, r * 0.18, 8)];
  const d = r * Math.SQRT1_2;
  return [circle(x, y, r), [{ x: x - d, y: y - d }, { x: x + d, y: y + d }], [{ x: x - d, y: y + d }, { x: x + d, y: y - d }]];
}

/**
 * Offset a densified path sideways by `d` (positive = left of travel on
 * screen, y down: the side of (−dy, dx)). Mitred at the joints.
 */
export function offsetPath(path, d) {
  const out = [];
  const n = path.length;
  if (n < 2) return out;
  const normal = (a, b) => { const u = unit(sub(b, a)); return { x: u.y, y: -u.x }; };
  for (let i = 0; i < n; i++) {
    let nx, ny;
    if (i === 0) ({ x: nx, y: ny } = normal(path[0], path[1]));
    else if (i === n - 1) ({ x: nx, y: ny } = normal(path[n - 2], path[n - 1]));
    else {
      const a = normal(path[i - 1], path[i]), b = normal(path[i], path[i + 1]);
      const m = unit({ x: a.x + b.x, y: a.y + b.y });
      const cos = m.x * a.x + m.y * a.y;
      const k = cos > 0.2 ? 1 / cos : 5; // limit very sharp mitres
      nx = m.x * k; ny = m.y * k;
    }
    out.push({ x: path[i].x + nx * d, y: path[i].y + ny * d });
  }
  return out;
}

/** Points every `step` along a path, with the path's unit normal there. */
export function stationsAlong(path, step, start = step / 2) {
  const out = [];
  if (!(step > 0) || path.length < 2) return out;
  let s = start, acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const l = len(sub(b, a));
    if (l <= 0) continue;
    const u = unit(sub(b, a));
    while (s <= acc + l + 1e-9) {
      const t = (s - acc) / l;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: u.y, ny: -u.x });
      s += step;
      if (out.length > 20000) return out;
    }
    acc += l;
  }
  return out;
}

/**
 * An offset of `centre` (offsetPath) without the loop an elbow tighter than
 * the offset makes on its inside: a run of segments that point backwards
 * against the centre line is replaced by the point where the straight parts
 * before and after it meet (a mitred inside corner). A tray elbow whose
 * radius was reduced to fit (short legs) therefore gets a sharp inside rail
 * instead of a rail that crosses itself.
 */
export function cleanOffset(centre, off) {
  if (off.length !== centre.length || off.length < 3) return off;
  const bad = [];
  for (let i = 0; i < off.length - 1; i++) {
    const c = sub(centre[i + 1], centre[i]), o = sub(off[i + 1], off[i]);
    bad.push(c.x * o.x + c.y * o.y <= 1e-12 * Math.max(1, len(c) * len(c)));
  }
  if (!bad.includes(true)) return off;
  const out = [];
  let i = 0;
  while (i < off.length) {
    if (i >= bad.length || !bad[i]) { out.push(off[i]); i++; continue; }
    let j = i;
    while (j + 1 < bad.length && bad[j + 1]) j++;
    // Segments i..j point backwards: points i..j+1 go.
    if (i === 0 || j + 2 >= off.length) {
      // At an end of the path: keep the end point itself.
      out.push(i === 0 ? off[0] : off[off.length - 1]);
      i = j + 2;
      continue;
    }
    // Near a U-turn the straight parts are almost parallel and meet far away
    // (thousands of px for a tray a few px wide). The mitred corner may lie no
    // farther from the centre line than a sharp outer mitre does
    // (offsetPath: 5 × the offset); otherwise take the middle of the cut.
    const m = lineMeet(off[i - 1], off[i], off[j + 1], off[j + 2]);
    const dOff = len(sub(off[0], centre[0]));
    const nabij = m && Math.min(len(sub(m, centre[i])), len(sub(m, centre[j + 1]))) <= 5 * dOff + 1e-9;
    out.push(nabij ? m : { x: (off[i].x + off[j + 1].x) / 2, y: (off[i].y + off[j + 1].y) / 2 });
    i = j + 2;
  }
  return out;
}

// Where line a1-a2 meets line b1-b2 (null when parallel).
function lineMeet(a1, a2, b1, b2) {
  const d1 = sub(a2, a1), d2 = sub(b2, b1);
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t };
}

// Parameter (0..1] along p→q where it first crosses one of `paths`, or 1.
function firstCrossing(p, q, paths) {
  const d = sub(q, p);
  let best = 1;
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], e = sub(path[i + 1], a);
      const den = d.x * e.y - d.y * e.x;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - p.x) * e.y - (a.y - p.y) * e.x) / den;
      const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
      if (t > 1e-6 && t < best && u >= -1e-9 && u <= 1 + 1e-9) best = t;
    }
  }
  return best;
}

/**
 * A rung (or basket cross wire) across the band at station `s`: from rail to
 * rail, cut where it would cross a rail first. That only happens near an
 * elbow tighter than half the width (`tight`: the centres of those arcs),
 * so only rungs near one are checked.
 */
function rungAt(s, h, rails, tight) {
  const a = { x: s.x + s.nx * h, y: s.y + s.ny * h };
  const b = { x: s.x - s.nx * h, y: s.y - s.ny * h };
  if (!tight.some((t) => Math.hypot(s.x - t.cx, s.y - t.cy) <= t.r + 3 * h)) return [a, b];
  const ta = firstCrossing(s, a, rails), tb = firstCrossing(s, b, rails);
  return [{ x: s.x + (a.x - s.x) * ta, y: s.y + (a.y - s.y) * ta }, { x: s.x + (b.x - s.x) * tb, y: s.y + (b.y - s.y) * tb }];
}

/**
 * What to draw for a run: `lines` (polylines to stroke) and `band` info.
 * Tray: two rails at ±width/2 plus rungs (ladder, every rungIn) or the
 * 2" × 4" mesh (basket), at the scale at the run or, on a sheet without a
 * scale, schematically at SCHEMATIC_PX_PER_IN (`schematic: true`).
 * Calibrated true-size conduit: two lines at ±OD/2. Otherwise one centre
 * line. Elbows are radiused; an elbow tighter than half the band gets a
 * mitred inside rail (cleanOffset). `junction` (branchJunction) adds the
 * fitting where a branch starts on its parent (junctionSymbols).
 */
export function racewayDrawing(points, raceway, pxPerIn, junction = null) {
  const rw = normalizeRaceway(raceway);
  const px = drawPxPerIn(rw, pxPerIn);
  const schematic = !pos(pxPerIn) && !!px;
  const geom = racewayGeometry(points, rw, px, junction);
  const lines = [];
  const thin = [];
  const widthPx = px ? bandWidthIn(rw) * px : 0;
  // Mark symbols, sized to the band (at least a few points): pull box = a
  // square, up = a circle with a dot (riser), down = a circle with a cross.
  const r = Math.max(widthPx * 0.7, 4);
  for (const m of geom.marks) lines.push(...markSymbol(m, r));
  const fit = junctionSymbols(junction, geom.centre, rw, widthPx, px);
  lines.push(...fit.lines);
  if (!(widthPx > 0)) {
    lines.unshift(geom.centre);
    return { geom, lines, thin, widthPx: 0, rw, schematic: false };
  }
  const h = widthPx / 2;
  const left = trimStart(cleanOffset(geom.centre, offsetPath(geom.centre, h)), fit.railCut[0]);
  const right = trimStart(cleanOffset(geom.centre, offsetPath(geom.centre, -h)), fit.railCut[1]);
  lines.push(left, right);
  if (rw.kind === 'tray') {
    // A branch's start opens into its parent: no end plate there.
    const ends = [[left[left.length - 1], right[right.length - 1]]];
    if (!fit.open) ends.unshift([left[0], right[0]]);
    for (const [a, b] of ends) thin.push([a, b]);
    const centre = trimStart(geom.centre, fit.centreCut);
    const rails = [left, right];
    const tight = geom.arcs.filter((a) => a.r < h - 1e-9);
    if (rw.trayStyle === 'ladder') {
      for (const s of stationsAlong(centre, rw.rungIn * px)) thin.push(rungAt(s, h, rails, tight));
    } else {
      const across = BASKET_MESH_IN.across * px;
      for (let d = -h + across; d < h - 1e-6; d += across) thin.push(cleanOffset(centre, offsetPath(centre, d)));
      for (const s of stationsAlong(centre, BASKET_MESH_IN.along * px, BASKET_MESH_IN.along * px)) {
        thin.push(rungAt(s, h, rails, tight));
      }
    }
  }
  return { geom, lines, thin, widthPx, rw, schematic };
}

/** A path without its first `d` (length along it); unchanged for d <= 0. */
export function trimStart(path, d) {
  if (!(d > 0) || path.length < 2) return path;
  let acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const l = len(sub(b, a));
    if (acc + l > d + 1e-9) {
      const t = (d - acc) / l;
      return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ...path.slice(i + 1)];
    }
    acc += l;
  }
  return path.slice(-2);
}

// ── Branches: tees, crosses, reducers ──
//
// A branch run stores `raceway.branchOf` { id, at }; everything else is
// derived from the runs as they are now, so moving or deleting the parent
// never breaks the branch: it is then a plain run (no junction).

/** Page points within which a branch start counts as on its parent's centre line. */
export const BRANCH_TOL = 3;
const BRANCH_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** True for an annotation id a branch can refer to (and a save keeps). */
export function validRunId(id) {
  return typeof id === 'string' && BRANCH_ID.test(id);
}

/** A clean branch connection { id, at: { x, y } }, or null. */
export function normalizeBranchOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : (finite(raw.id) ? String(raw.id) : '');
  if (!BRANCH_ID.test(id) || !finite(raw.at?.x) || !finite(raw.at?.y)) return null;
  return { id, at: { x: raw.at.x, y: raw.at.y } };
}

/** True for a raceway run annotation with a drawable path. */
export function isRacewayRun(a) {
  return !!a && a.type === 'measurePerimeter' && a.measureKind === 'raceway'
    && Array.isArray(a.points) && a.points.length >= 2;
}

/** Nearest point of a polyline to p: { x, y, dist, seg, dir (unit), along }. */
export function nearestOnPath(path, p) {
  let best = null, acc = 0;
  for (let i = 0; i < (path?.length || 0) - 1; i++) {
    const a = path[i], v = sub(path[i + 1], a);
    const l = len(v);
    if (!(l > 0)) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * v.x + (p.y - a.y) * v.y) / (l * l)));
    const q = { x: a.x + v.x * t, y: a.y + v.y * t };
    const dist = len(sub(p, q));
    if (!best || dist < best.dist) best = { x: q.x, y: q.y, dist, seg: i, dir: { x: v.x / l, y: v.y / l }, along: acc + l * t };
    acc += l;
  }
  return best;
}

/** The centre line of a run as drawn (elbows included), in page points. */
export function racewayCentre(ann) {
  return racewayGeometry(ann.points, ann.raceway, drawPxPerIn(normalizeRaceway(ann.raceway), ann.measurePxPerIn)).centre;
}

/** Nominal size (in) used to compare runs: tray width, conduit trade size. */
export function racewaySizeIn(rw) {
  return rw.kind === 'tray' ? rw.widthIn : (tradeSizeInches(rw.tradeSize) || 0);
}

/** Short name of a run for the bar: its tag, else its size label. */
export function racewayName(ann) {
  const rw = normalizeRaceway(ann?.raceway);
  return rw.tag ? `${rw.tag} (${racewayLabel(rw)})` : racewayLabel(rw);
}

function firstDir(pts) {
  for (let i = 1; i < pts.length; i++) {
    const v = sub(pts[i], pts[0]);
    if (len(v) > 1e-9) return unit(v);
  }
  return null;
}

// Where `ann` starts on `parent` (no look at other branches), or null.
function startOn(ann, parent, centre) {
  const start = ann.points[0];
  const u = firstDir(ann.points);
  const near = u && nearestOnPath(centre, start);
  if (!near || near.dist > BRANCH_TOL) return null;
  const ends = [parent.points[0], parent.points[parent.points.length - 1]];
  const end = ends.some((e) => len(sub(e, near)) <= BRANCH_TOL);
  const sin = near.dir.x * u.y - near.dir.y * u.x;
  // A run lying along the middle of its parent is not a branch.
  if (!end && Math.abs(sin) < 0.17) return null;
  return { x: near.x, y: near.y, along: near.along, dir: near.dir, u, sin, side: sin >= 0 ? 1 : -1, end };
}

/**
 * The fitting where branch run `ann` starts, from the runs in `annotations`
 * (same page): null when it has no valid parent (deleted, other kind, or
 * moved so the start is no longer on its centre line). Otherwise
 *   fitting   'tee' (off the side), 'cross' (an opposite branch at the same
 *             point; counted on the first of the two in document order) or
 *             'end' (on the parent's end point: a straight connection)
 *   counted   false for the second branch of a cross
 *   reducer   the branch size differs from the parent's
 *   x, y, dir the junction on the parent's centre line and its direction
 *   u, sin, side  the branch direction, sine of the angle, side (+1/-1)
 *   parentHalfPx  half the parent's drawn width (0 = symbolic)
 */
export function branchJunction(ann, annotations) {
  const bo = normalizeBranchOf(ann?.raceway?.branchOf);
  if (!bo || !isRacewayRun(ann) || !Array.isArray(annotations)) return null;
  const parent = annotations.find((a) => a !== ann && a?.id === bo.id && isRacewayRun(a) && a.page === ann.page);
  if (!parent) return null;
  const rw = normalizeRaceway(ann.raceway), prw = normalizeRaceway(parent.raceway);
  if (rw.kind !== prw.kind) return null;
  const centre = racewayCentre(parent);
  const s = startOn(ann, parent, centre);
  if (!s) return null;
  let fitting = s.end ? 'end' : 'tee', counted = true;
  if (!s.end) {
    for (const o of annotations) {
      if (o === ann || !isRacewayRun(o) || o.page !== ann.page) continue;
      if (normalizeBranchOf(o.raceway?.branchOf)?.id !== parent.id) continue;
      if (normalizeRaceway(o.raceway).kind !== rw.kind) continue;
      const t = startOn(o, parent, centre);
      if (!t || t.end || t.side === s.side || Math.abs(t.along - s.along) > BRANCH_TOL) continue;
      fitting = 'cross';
      counted = annotations.indexOf(ann) < annotations.indexOf(o);
      break;
    }
  }
  const parentPxPerIn = drawPxPerIn(prw, parent.measurePxPerIn);
  return {
    parentId: parent.id, parentName: racewayName(parent),
    x: s.x, y: s.y, dir: s.dir, u: s.u, sin: s.sin, side: s.side,
    fitting, counted, reducer: Math.abs(racewaySizeIn(rw) - racewaySizeIn(prw)) > 1e-9,
    parentHalfPx: parentPxPerIn ? bandWidthIn(prw) * parentPxPerIn / 2 : 0,
    parentSizeIn: racewaySizeIn(prw),
  };
}

/** The fittings a junction adds to the branch's takeoff: 'tee' | 'cross' | 'reducer'. */
export function junctionFittings(j) {
  const out = [];
  if (!j) return out;
  if (j.fitting === 'tee' || (j.fitting === 'cross' && j.counted)) out.push(j.fitting);
  if (j.reducer) out.push('reducer');
  return out;
}

/** Compact identity of a junction's takeoff, to notice when it changed. */
export function junctionKey(j) {
  return j ? `${j.parentId}|${j.fitting}|${j.counted ? 1 : 0}|${j.reducer ? 1 : 0}` : '';
}

/**
 * Drawing of a branch's start: `lines` (symbols), the distance the rails
 * (`railCut` [left, right]) and the rungs (`centreCut`) start from the
 * junction, and `open` (no end plate).
 *   - Tray at true width off a tray at true width (tee / cross): the rails
 *     stop at the parent's near rail and meet it with chamfered corners, the
 *     shape of a catalogue tee; a cross is the same on both sides.
 *   - On the parent's end point with another size: a reducer, a taper from
 *     the parent's width to the branch's.
 *   - Conduit or a symbolic run: a circle (tee), a diamond (cross) or a small
 *     taper (reducer on an end point) at the junction.
 */
export function junctionSymbols(j, centre, rw, widthPx, pxPerIn) {
  const none = { lines: [], railCut: [0, 0], centreCut: 0, open: false };
  if (!j || !centre || centre.length < 2) return none;
  const first = len(sub(centre[1], centre[0]));
  const n = { x: j.u.y, y: -j.u.x }; // offsetPath's left normal
  const at = (p, du, dn) => ({ x: p.x + j.u.x * du + n.x * dn, y: p.y + j.u.y * du + n.y * dn });
  const J = { x: j.x, y: j.y };
  const h = widthPx / 2;
  const trueTray = rw.kind === 'tray' && h > 0 && j.parentHalfPx > 0;
  if (j.fitting === 'end') {
    if (!j.reducer) return none;
    if (trueTray) {
      const L = Math.min(Math.max(Math.abs(j.parentHalfPx - h) * 2, 6 * pxPerIn), first * 0.5);
      return {
        lines: [[at(J, 0, j.parentHalfPx), at(J, L, h)], [at(J, 0, -j.parentHalfPx), at(J, L, -h)],
          [at(J, 0, j.parentHalfPx), at(J, 0, -j.parentHalfPx)]],
        railCut: [L, L], centreCut: L, open: true,
      };
    }
    const big = Math.max(h * 1.4, 4), small = Math.max(h * 0.7, 2);
    const [a, b] = racewaySizeIn(rw) < j.parentSizeIn ? [big, small] : [small, big];
    const L = Math.min(Math.max(h * 2, 6), first * 0.5);
    return { ...none, lines: [[at(J, 0, a), at(J, L, b), at(J, L, -b), at(J, 0, -a), at(J, 0, a)]] };
  }
  if (trueTray) {
    // Rails cut where they meet the parent's near rail (signed distance from
    // the parent centre line = side × parent half width), then chamfered.
    const f = Math.min(h, 12 * pxPerIn);
    const cuts = [h, -h].map((off) => {
      const d0 = j.dir.x * (n.y * off) - j.dir.y * (n.x * off);
      return Math.max(0, (j.side * j.parentHalfPx - d0) / j.sin);
    });
    if (Math.max(...cuts) + f >= first) return none;
    const lines = [h, -h].map((off, i) => {
      const p = at(J, cuts[i], off);
      const o = Math.sign((n.x * off) * j.dir.x + (n.y * off) * j.dir.y) || (off > 0 ? 1 : -1);
      return [at(J, cuts[i] + f, off), { x: p.x + j.dir.x * o * f, y: p.y + j.dir.y * o * f }];
    });
    return { lines, railCut: [cuts[0] + f, cuts[1] + f], centreCut: j.parentHalfPx / Math.abs(j.sin), open: true };
  }
  const r = Math.max(h * 1.6, 3);
  if (j.fitting === 'cross') {
    return { ...none, lines: [[{ x: J.x, y: J.y - r }, { x: J.x + r, y: J.y }, { x: J.x, y: J.y + r }, { x: J.x - r, y: J.y }, { x: J.x, y: J.y - r }]] };
  }
  return { ...none, lines: [circle(J.x, J.y, r, 12)] };
}

const FITTING_NAMES = { custom: 'custom', up: '90° up', down: '90° down', pull: 'pull box',
  tee: 'tee', cross: 'cross', reducer: 'reducer' };

/** Fittings as text: '2 × 90°, 1 × 45°, 1 × 90° up, 2 × pull box, 1 × tee'. */
export function fittingsText(fittings) {
  return (fittings || []).map((f) => `${f.count} × ${FITTING_NAMES[f.angle] || `${f.angle}°`}`).join(', ');
}

/** Bend text: 'Bends 180°', or per pull section 'Bends 180° | 270°'. */
export function bendsText(sections) {
  const s = (sections || []).map((v) => `${Math.round(v)}°`);
  return s.length ? `Bends ${s.join(' | ')}` : '';
}

/** Where the run label goes: beside the middle of the longest straight leg. */
export function racewayLabelPlace(points, offset) {
  let best = 0, at = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const l = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (l > best) { best = l; at = i; }
  }
  const a = points[at], b = points[at + 1] || a;
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  // Readable: never upside down.
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  const nx = Math.sin(angle), ny = -Math.cos(angle);
  return { x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset, angle };
}

/**
 * The leg under the cursor, as straight lines in page points.
 * One centre line, or two rails `halfWidth` apart. Nothing is offset along
 * the whole run: a cursor that doubles back used to send a tray rail (and a
 * true-size conduit wall) across the sheet, and rebuilding every rung on
 * that moving leg is what made drawing lag. The elbow and the rungs appear
 * when the corner is placed.
 */
export function liveLegLines(a, b, halfWidth) {
  if (!a || !b || !finite(a.x) || !finite(a.y) || !finite(b.x) || !finite(b.y)) return [];
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-6)) return [];
  const half = Number(halfWidth);
  if (!(half > 0)) return [[{ x: a.x, y: a.y }, { x: b.x, y: b.y }]];
  const nx = (-dy / L) * half, ny = (dx / L) * half;
  return [
    [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }],
    [{ x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny }],
  ];
}

/**
 * The next corner for a cursor at (x, y): snapped to a standard elbow from
 * the previous leg (unless `free`), at the cursor's distance along it. An
 * object-snap point that lies on that ray is used exactly.
 */
export function nextCorner(points, x, y, { free = false, angles, snap = null, tol = 4 } = {}) {
  const n = points.length;
  if (n === 0) return snap || { x, y };
  const last = points[n - 1];
  if (free || n < 2) return snap || { x, y };
  const prev = points[n - 2];
  const dir = snapBend({ x: last.x - prev.x, y: last.y - prev.y }, { x: x - last.x, y: y - last.y }, angles);
  const target = snap || { x, y };
  const along = Math.max(0, (target.x - last.x) * dir.x + (target.y - last.y) * dir.y);
  const p = { x: last.x + dir.x * along, y: last.y + dir.y * along, deflection: dir.deflection };
  if (snap && Math.hypot(snap.x - p.x, snap.y - p.y) <= tol) return { ...p, x: snap.x, y: snap.y };
  return p;
}

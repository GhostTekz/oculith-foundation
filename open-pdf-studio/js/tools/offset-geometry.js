// Offset geometry (the external editor O, docs/reference/editor/markup-tools.md): a parallel copy of a line,
// polyline or polygon at a distance, with mitred joins. Pure: no app imports.
// Coordinates and distances are PDF page coordinates (points); the tool turns
// a distance in calibrated units into points with the page scale
// (offsetDistanceToPoints).
//
// Side: +1 is the left of the direction of travel in a y-down page frame
// (the normal (dy, -dx) of a segment going (dx, dy)), -1 the right.

// A join whose mitre is longer than this many offset distances is bevelled
// (two points) instead: near a reversal a pure mitre shoots off the sheet.
export const MITRE_LIMIT = 10;

const EPS = 1e-9;

function unitNormal(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  return { x: dy / len, y: -dx / len };
}

function lineIntersection(p1, d1, p2, d2) {
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < EPS) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/** Points without consecutive duplicates (and, closed, without first == last). */
export function cleanPoints(points, closed) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > EPS) out.push({ x: p.x, y: p.y });
  }
  if (closed && out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= EPS) out.pop();
  }
  return out;
}

/**
 * Offset a polyline (open) or polygon (closed) by `distance` (> 0) to `side`.
 * Returns the new point list (closed: without a repeated first point), or
 * null for degenerate input.
 */
export function offsetPolyline(points, distance, side = 1, closed = false) {
  const pts = cleanPoints(points || [], closed);
  const n = pts.length;
  if (n < 2 || !(distance > 0)) return null;
  const d = distance * (side < 0 ? -1 : 1);
  const segCount = closed ? n : n - 1;
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const nrm = unitNormal(a, b);
    if (!nrm) return null;
    segs.push({ p: { x: a.x + nrm.x * d, y: a.y + nrm.y * d }, q: { x: b.x + nrm.x * d, y: b.y + nrm.y * d },
      b, dir: { x: b.x - a.x, y: b.y - a.y } });
  }
  const join = (s1, s2, out) => {
    const hit = lineIntersection(s1.p, s1.dir, s2.p, s2.dir);
    if (!hit) { out.push(s2.p); return; } // collinear: the offset points coincide
    if (Math.hypot(hit.x - s1.b.x, hit.y - s1.b.y) > MITRE_LIMIT * Math.abs(d)) out.push(s1.q, s2.p);
    else out.push(hit);
  };
  const out = [];
  if (closed) {
    for (let i = 0; i < segs.length; i++) join(segs[(i - 1 + segs.length) % segs.length], segs[i], out);
  } else {
    out.push(segs[0].p);
    for (let i = 1; i < segs.length; i++) join(segs[i - 1], segs[i], out);
    out.push(segs[segs.length - 1].q);
  }
  return out;
}

function closestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

/**
 * Which side of the path the point p is on (+1 / -1, see the header), from
 * the nearest segment. A closed polygon uses inside/outside instead, so the
 * whole copy lands inside or outside: +1/-1 such that the copy grows toward p.
 */
export function offsetSide(points, p, closed = false) {
  const pts = cleanPoints(points || [], closed);
  if (pts.length < 2) return 1;
  if (closed && pts.length >= 3) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    // Shoelace sign: > 0 means clockwise on a y-down page, where the left
    // normal (side +1) points outward.
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += a.x * b.y - b.x * a.y;
    }
    const outward = area > 0 ? 1 : -1;
    return inside ? -outward : outward;
  }
  let best = null;
  const segCount = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const c = closestOnSegment(p, a, b);
    const dist = Math.hypot(p.x - c.x, p.y - c.y);
    if (!best || dist < best.dist) best = { dist, a, b };
  }
  const nrm = unitNormal(best.a, best.b);
  if (!nrm) return 1;
  return (p.x - best.a.x) * nrm.x + (p.y - best.a.y) * nrm.y >= 0 ? 1 : -1;
}

/** Distance from p to the path (nearest segment). */
export function distanceToPath(points, p, closed = false) {
  const pts = cleanPoints(points || [], closed);
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  const segCount = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const c = closestOnSegment(p, pts[i], pts[(i + 1) % pts.length]);
    best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
  }
  return best;
}

// Markup types the Offset tool takes, and how their geometry reads.
const LINE_TYPES = new Set(['line', 'arrow', 'measureDistance']);
const OPEN_POINT_TYPES = new Set(['polyline', 'measurePerimeter']);
const CLOSED_POINT_TYPES = new Set(['polygon', 'cloudPolyline', 'measureArea', 'filledArea']);

/**
 * Offset path of a markup: { points, closed, kind: 'line' | 'points' }, or
 * null for a markup the Offset tool does not take (a regular polygon without
 * points, arc vertices, holes, a rotated shape, other types).
 */
export function offsetPathOf(ann) {
  if (!ann || (Number(ann.rotation) || 0) !== 0) return null;
  if (LINE_TYPES.has(ann.type)) {
    if (![ann.startX, ann.startY, ann.endX, ann.endY].every(Number.isFinite)) return null;
    return { kind: 'line', closed: false, points: [{ x: ann.startX, y: ann.startY }, { x: ann.endX, y: ann.endY }] };
  }
  const pts = ann.points;
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))) return null;
  if (pts.some((p) => p.arc || p.bulge)) return null;
  if (Array.isArray(ann.holes) && ann.holes.length > 0) return null;
  if (CLOSED_POINT_TYPES.has(ann.type)) {
    return cleanPoints(pts, true).length >= 3 ? { kind: 'points', closed: true, points: pts } : null;
  }
  if (OPEN_POINT_TYPES.has(ann.type)) {
    // A polyline whose last point repeats the first (L-shape, closed
    // perimeter) is a polygon: offset every corner, then close it again.
    const first = pts[0], last = pts[pts.length - 1];
    const closedLoop = pts.length >= 4 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6;
    return { kind: 'points', closed: closedLoop, repeatFirst: closedLoop, points: pts };
  }
  return null;
}

/** Is this a markup the Offset tool takes? */
export const canOffset = (ann) => offsetPathOf(ann) !== null;

/**
 * The geometry fields of the offset copy: { startX, startY, endX, endY } for
 * a line, { points, x, y, width, height } for a point markup, or null.
 */
export function offsetGeometry(ann, distance, side) {
  const path = offsetPathOf(ann);
  if (!path) return null;
  const out = offsetPolyline(path.points, distance, side, path.closed);
  if (!out) return null;
  if (path.kind === 'line') return { startX: out[0].x, startY: out[0].y, endX: out[1].x, endY: out[1].y };
  const points = path.repeatFirst ? [...out, { ...out[0] }] : out;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { points, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * A distance typed in the page's unit to page points. `scale` is
 * getMeasureScale(): { pixelsPerUnit, unit, calibrated }. Uncalibrated pages
 * take the value as page points (pixelsPerUnit 1, unit 'pt').
 */
export function offsetDistanceToPoints(value, scale) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const ppu = scale?.calibrated && scale.pixelsPerUnit > 0 ? scale.pixelsPerUnit : 1;
  return v * ppu;
}

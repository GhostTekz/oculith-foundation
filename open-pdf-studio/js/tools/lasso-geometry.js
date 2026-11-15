// Lasso selection geometry (the external editor Shift+O, docs/reference/editor/markup-tools.md). Pure: no app
// imports, so the node tests load it. All coordinates are PDF page
// coordinates (the same space the annotations are stored in).
//
// A markup is reduced to an outline: its real vertices where it has them
// (line end points, polyline/polygon points, a freehand path) and otherwise
// the four corners of its bounding box. Then:
//   enclosed  (default)  every outline vertex lies inside the lasso and no
//                        lasso edge crosses the outline (a concave lasso can
//                        hold all vertices yet cut through an edge).
//   touching  (Ctrl)     the outline and the lasso overlap at all: a vertex of
//                        one inside the other, or crossing edges.

/** Ray-casting point-in-polygon test (polygon as [{x, y}], implicitly closed). */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
        && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Do the segments a-b and c-d cross or touch? */
export function segmentsIntersect(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x)
    && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  if (d1 === 0 && onSeg(c, d, a)) return true;
  if (d2 === 0 && onSeg(c, d, b)) return true;
  if (d3 === 0 && onSeg(a, b, c)) return true;
  if (d4 === 0 && onSeg(a, b, d)) return true;
  return false;
}

const CLOSED_POINT_TYPES = new Set(['polygon', 'cloud', 'cloudPolyline', 'measureArea', 'filledArea', 'systeemraster', 'systeemplafond']);
const finite = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Outline of a markup for the lasso test: { points, closed }, or null when
 * neither its geometry nor `bounds` (getAnnotationBounds) gives one.
 */
export function annotationOutline(ann, bounds) {
  if (!ann) return null;
  if ([ann.startX, ann.startY, ann.endX, ann.endY].every(Number.isFinite)) {
    return { points: [{ x: ann.startX, y: ann.startY }, { x: ann.endX, y: ann.endY }], closed: false };
  }
  const pts = Array.isArray(ann.points) ? ann.points
    : Array.isArray(ann.path) ? ann.path
      : Array.isArray(ann.controlPoints) ? ann.controlPoints : null;
  if (pts && pts.length >= 1 && pts.every(finite)) {
    return { points: pts.map((p) => ({ x: p.x, y: p.y })), closed: CLOSED_POINT_TYPES.has(ann.type) && pts.length >= 3 };
  }
  if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    const { x, y, width: w, height: h } = bounds;
    return { points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true };
  }
  return null;
}

function edges(points, closed) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) out.push([points[i], points[i + 1]]);
  if (closed && points.length > 2) out.push([points[points.length - 1], points[0]]);
  return out;
}

function edgesCross(outline, lasso) {
  const lassoEdges = edges(lasso, true);
  for (const [a, b] of edges(outline.points, outline.closed)) {
    for (const [c, d] of lassoEdges) if (segmentsIntersect(a, b, c, d)) return true;
  }
  return false;
}

/**
 * Does the lasso (closed polygon, >= 3 points) select this outline?
 * mode: 'enclosed' (default) or 'touching'.
 */
export function lassoSelects(outline, lasso, mode = 'enclosed') {
  if (!outline || !outline.points.length || !Array.isArray(lasso) || lasso.length < 3) return false;
  if (mode === 'touching') {
    if (outline.points.some((p) => pointInPolygon(p, lasso))) return true;
    if (edgesCross(outline, lasso)) return true;
    // The lasso drawn entirely inside a closed shape touches it too.
    return outline.closed && pointInPolygon(lasso[0], outline.points);
  }
  if (!outline.points.every((p) => pointInPolygon(p, lasso))) return false;
  return !edgesCross(outline, lasso);
}

/**
 * Drop lasso points closer than `minDist` to the previous kept point (the
 * pointer fires many events per pixel). The first point is always kept.
 */
export function addLassoPoint(points, p, minDist) {
  const last = points[points.length - 1];
  if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDist) points.push({ x: p.x, y: p.y });
  return points;
}

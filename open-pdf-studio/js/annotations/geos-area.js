// Ask the desktop geometry engine for a stored area, a polygonal takeoff,
// or a committed offset copy. The engine unions parts and subtracts holes,
// so an overlap is counted once. A missing command, a thrown error, or a
// split offset leaves the JavaScript figure already stored on the annotation.

import { expandArcPoints, hasArcPoints } from './arc-points.js';
import { writeEngineArea } from './measurement.js';
import { $RAW } from 'solid-js/store';
import { state } from '../core/state.js';
import { ringenIndelen, vlakRingen } from './vlak-ringen.js';
import { veelhoekGrondvorm } from '../pdf/saver/veelhoek-grondvorm.js';

const TAKEOFF_TYPES = new Set(['filledArea', 'polygon', 'cloudPolyline']);

const raw = (value) => (value && value[$RAW]) || value;

function openDocuments() {
  return Array.isArray(state.documents) ? state.documents : [];
}

/** The open document that holds `annotation` when the request is made. */
function documentHolding(annotation) {
  const target = raw(annotation);
  return openDocuments().find((d) => raw(d?.annotations)?.includes?.(target)) || null;
}

function straight(ring) {
  return hasArcPoints(ring) ? expandArcPoints(ring) : ring;
}

function pairs(ring) {
  return straight(ring).map((point) => [point.x, point.y]);
}

/** Split a measurement into additive parts and subtractive holes. */
export function classifiedRings(points, holes) {
  const rings = vlakRingen(points, holes);
  const additive = ringenIndelen(rings);
  const parts = [];
  const cuts = [];
  rings.forEach((ring, index) => {
    (additive[index] ? parts : cuts).push(pairs(ring));
  });
  return { parts, holes: cuts };
}

function isTakeoffShape(annotation) {
  if (!annotation || annotation.extMeasure || !TAKEOFF_TYPES.has(annotation.type)) return false;
  if (Array.isArray(annotation.points) && annotation.points.length >= 3) return true;
  return annotation.type === 'polygon'
    && Number.isFinite(annotation.x) && Number.isFinite(annotation.y)
    && annotation.width > 0 && annotation.height > 0;
}

export function shapeRings(annotation) {
  if (Array.isArray(annotation.points) && annotation.points.length >= 3) {
    return classifiedRings(annotation.points, annotation.holes);
  }
  if (annotation.type !== 'polygon') return null;
  const ring = veelhoekGrondvorm(annotation);
  return ring.length >= 3 ? classifiedRings(ring, undefined) : null;
}

/**
 * Replace the stored area when the engine returns a different page-point
 * total. `invoke` is the desktop command caller. Returns false when the
 * stored shoelace figure should stay.
 */
export async function refineMeasureArea(annotation, invoke, doc = documentHolding(annotation)) {
  if (!annotation || annotation.type !== 'measureArea' || annotation.extMeasure || typeof invoke !== 'function') return false;
  const rings = classifiedRings(annotation.points, annotation.holes);
  if (rings.parts.length === 0) return false;
  const asked = JSON.stringify(rings);
  let pixels;
  try {
    pixels = await invoke('geos_net_area', rings);
  } catch {
    return false;
  }
  if (typeof pixels !== 'number' || !Number.isFinite(pixels)) return false;
  // The area was edited (or its document closed) while the engine worked:
  // this total belongs to the old outline. The edit schedules its own.
  if (JSON.stringify(classifiedRings(annotation.points, annotation.holes)) !== asked) return false;
  if (doc && !openDocuments().some((d) => raw(d) === raw(doc))) return false;
  // The scale of the area's own document, not of the tab in front by now.
  return writeEngineArea(annotation, pixels, doc);
}

/** Store the engine page-point area on a polygonal takeoff shape. */
export function writeEnginePixels(annotation, pixels) {
  if (!annotation || typeof pixels !== 'number' || !Number.isFinite(pixels)) return false;
  if (typeof annotation.enginePixels === 'number' && Math.abs(annotation.enginePixels - pixels) <= 1e-6) return false;
  annotation.enginePixels = pixels;
  annotation.modifiedAt = new Date().toISOString();
  return true;
}

/** Ask for the net area of a drawn polygon. Rectangles, circles, and ellipses stay formulas. */
export async function refineShapeArea(annotation, invoke) {
  if (!isTakeoffShape(annotation) || typeof invoke !== 'function') return false;
  const rings = shapeRings(annotation);
  if (!rings || rings.parts.length === 0) return false;
  let pixels;
  try {
    pixels = await invoke('geos_net_area', rings);
  } catch {
    return false;
  }
  return writeEnginePixels(annotation, pixels);
}

function geometrySignature(annotation) {
  if (annotation.offsetKind === 'line') {
    return [annotation.startX, annotation.startY, annotation.endX, annotation.endY].join(',');
  }
  return (annotation.points || []).map((point) => `${point.x},${point.y}`).join(';');
}

function clearOffsetRequest(annotation) {
  if (!annotation) return;
  annotation.offsetPending = false;
  delete annotation.offsetSourcePoints;
  delete annotation.offsetDistance;
  delete annotation.offsetSide;
  delete annotation.offsetClosed;
  delete annotation.offsetRepeatFirst;
  delete annotation.offsetKind;
}

function curvePoints(curve) {
  if (!Array.isArray(curve) || curve.length < 2) return null;
  const points = curve.map((point) => {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point?.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point?.y);
    return { x, y };
  });
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-6) points.pop();
  return points.length >= 2 ? points : null;
}

function moved(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) > 1e-6;
}

function applyOffsetCurve(annotation, points, kind, repeatFirst) {
  if (kind === 'line') {
    if (points.length !== 2) return false;
    const same = !moved({ x: annotation.startX, y: annotation.startY }, points[0])
      && !moved({ x: annotation.endX, y: annotation.endY }, points[1]);
    if (same) return false;
    annotation.startX = points[0].x;
    annotation.startY = points[0].y;
    annotation.endX = points[1].x;
    annotation.endY = points[1].y;
    annotation.modifiedAt = new Date().toISOString();
    return true;
  }
  const next = repeatFirst ? [...points, { ...points[0] }] : points;
  const same = Array.isArray(annotation.points)
    && annotation.points.length === next.length
    && next.every((point, index) => !moved(annotation.points[index], point));
  if (same) return false;
  annotation.points = next;
  const xs = next.map((point) => point.x);
  const ys = next.map((point) => point.y);
  annotation.x = Math.min(...xs);
  annotation.y = Math.min(...ys);
  annotation.width = Math.max(...xs) - annotation.x;
  annotation.height = Math.max(...ys) - annotation.y;
  annotation.modifiedAt = new Date().toISOString();
  return true;
}

/**
 * Replace a committed offset copy when the engine returns one line.
 * The request is cleared either way, so a later edit is not offset again.
 */
export async function refineOffset(annotation, invoke) {
  if (!annotation?.offsetPending) return false;
  const source = annotation.offsetSourcePoints;
  const distance = annotation.offsetDistance;
  const side = annotation.offsetSide;
  const closed = !!annotation.offsetClosed;
  const kind = annotation.offsetKind;
  const repeatFirst = !!annotation.offsetRepeatFirst;
  const signature = geometrySignature(annotation);
  try {
    if (typeof invoke !== 'function' || !Array.isArray(source) || source.length < 2 || !(distance > 0)) return false;
    const curve = await invoke('geos_offset_curve', {
      points: source.map((point) => [point.x, point.y]),
      distance,
      side,
      closed,
    });
    if (geometrySignature(annotation) !== signature) return false;
    const points = curvePoints(curve);
    if (!points) return false;
    return applyOffsetCurve(annotation, points, kind, repeatFirst);
  } catch {
    return false;
  } finally {
    clearOffsetRequest(annotation);
  }
}

function publish(changed) {
  if (!changed.some(Boolean)) return undefined;
  void import('./geometry-revision.js').then((mod) => mod.noteGeometry()).catch(() => {});
  return import('./rendering.js').then((mod) => mod.redrawAnnotations());
}

/** Ask the desktop engine for each finished area, takeoff shape, or pending offset. */
export function scheduleAreaRefine(annotations) {
  const invoke = globalThis.window?.__TAURI__?.core?.invoke;
  const list = (Array.isArray(annotations) ? annotations : [annotations]).filter(Boolean);
  if (typeof invoke !== 'function') {
    list.forEach((annotation) => {
      if (annotation.offsetPending) clearOffsetRequest(annotation);
    });
    return;
  }
  const offsets = list.filter((annotation) => annotation.offsetPending);
  void Promise.all(offsets.map((annotation) => refineOffset(annotation, invoke)))
    .then((offsetChanged) => Promise.all([
      ...offsetChanged,
      ...list
        .filter((annotation) => annotation.type === 'measureArea' && !annotation.extMeasure)
        .map((annotation) => refineMeasureArea(annotation, invoke)),
      ...list
        .filter(isTakeoffShape)
        .map((annotation) => refineShapeArea(annotation, invoke)),
    ]))
    .then(publish)
    .catch(() => {});
}

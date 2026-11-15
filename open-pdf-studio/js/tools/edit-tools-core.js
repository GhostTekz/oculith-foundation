// Lasso and Offset (WP13, docs/reference/editor/markup-tools.md): the document side of the
// tools, without the pointer flow and without UI imports, so the node tests
// run it on the real state store, measure scale and undo manager. The
// pointer flow is tools/edit-tools.js.

import { getActiveDocument } from '../core/state.js';
import { execute } from '../core/undo-manager.js';
import { cloneAnnotation } from '../annotations/factory.js';
import { isAnnotationPickableInView } from '../annotations/view-filters.js';
import { getMeasureScale, calculateArea, calculatePerimeter, formatMeasurement } from '../annotations/measurement.js';
import { annotationOutline, lassoSelects } from './lasso-geometry.js';
import { herrekenExtMaat } from '../annotations/ext-measure.js';
import { offsetPathOf, offsetGeometry } from './offset-geometry.js';

// Same id convention as newAnnotationId() in edit-ops.js (that module pulls
// in the UI, which the node tests cannot load).
const newAnnotationId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 11);

/**
 * The markups a lasso selects on `page`: fully enclosed ones, or with
 * `touching` every markup the lasso touches. Hidden markups and markups on a
 * locked layer are skipped, as for the rubber band.
 */
export function lassoSelection(doc, page, lasso, { touching = false, boundsOf } = {}) {
  const out = [];
  for (const ann of doc?.annotations || []) {
    if (ann.page !== page || !isAnnotationPickableInView(ann)) continue;
    const outline = annotationOutline(ann, boundsOf ? boundsOf(ann) : null);
    if (lassoSelects(outline, lasso, touching ? 'touching' : 'enclosed')) out.push(ann);
  }
  return out;
}

/** The page scale at the middle of a markup: { pixelsPerUnit, unit, calibrated }. */
export function offsetScaleOf(ann) {
  const path = offsetPathOf(ann);
  const p = path ? path.points[Math.floor(path.points.length / 2)] : null;
  const s = p ? getMeasureScale(ann.page, p.x, p.y) : getMeasureScale(ann?.page);
  return { pixelsPerUnit: s.pixelsPerUnit || 1, unit: s.calibrated ? (s.unit || 'pt') : 'pt', calibrated: !!s.calibrated };
}

/**
 * Make the offset copy of `source` at `distancePt` page points to `side`;
 * one undo step ("Offset"). Returns the copy, or null.
 */
export function createOffsetCopy(source, distancePt, side, doc = getActiveDocument()) {
  const path = doc && source ? offsetPathOf(source) : null;
  const geom = path ? offsetGeometry(source, distancePt, side) : null;
  if (!geom) return null;
  const copy = cloneAnnotation(source);
  copy.id = newAnnotationId();
  copy.createdAt = new Date().toISOString();
  copy.modifiedAt = copy.createdAt;
  delete copy.groupId;
  delete copy.groupPath;
  delete copy.holes;
  delete copy.selectedSub;
  Object.assign(copy, geom);
  // The undo snapshot keeps this request. Redo runs it again. The live copy
  // drops it once the desktop engine has answered, or immediately when the
  // command is missing, so a later edit is not offset a second time.
  copy.offsetPending = true;
  copy.offsetDistance = distancePt;
  copy.offsetSide = side < 0 ? -1 : 1;
  copy.offsetClosed = !!path.closed;
  copy.offsetRepeatFirst = !!path.repeatFirst;
  copy.offsetKind = path.kind;
  copy.offsetSourcePoints = path.points.map((point) => ({ x: point.x, y: point.y }));
  if (copy.type === 'measureArea' && copy.points.length >= 3) {
    const area = calculateArea(copy.points, undefined, copy.page);
    copy.measureText = formatMeasurement(area);
    copy.measureValue = area.value;
    copy.measureUnit = area.unit;
  } else if (copy.type === 'measurePerimeter') {
    const per = calculatePerimeter(copy.points, copy.page);
    copy.measureText = formatMeasurement(per);
    copy.measureValue = per.value;
    copy.measureUnit = per.unit;
  }
  herrekenExtMaat(copy); // a copy of an external editor measurement keeps the file's scale
  doc.annotations.push(copy);
  execute({ type: 'addAnnotation', annotation: cloneAnnotation(copy), label: 'offset' });
  void import('../annotations/geos-area.js').then((mod) => mod.scheduleAreaRefine(copy));
  return copy;
}

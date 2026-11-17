// Measurements follow their scale source.
//
// A measurement stores its value and label (measureValue, measureText). When
// a scale source changes (a viewport, scale bar or scale region is moved,
// resized or deleted) or a measurement lands somewhere else (a paste onto a
// page with another scale), those stored values must be recomputed, and the
// recomputation belongs to the same undo step as the change that caused it.

import { getActiveDocument } from '../core/state.js';
import { cloneAnnotation } from './factory.js';
import { recalculateAllMeasurements } from './measurement.js';
import { invalidateScaleRegionCache } from './scale-region.js';
import { recordBulkModify, beginUndoTransaction, endUndoTransaction } from '../core/undo-manager.js';

export const SCALE_SOURCE_TYPES = Object.freeze(['viewport', 'scaleBar', 'scaleRegion']);
export const MEASUREMENT_TYPES = Object.freeze(['measureDistance', 'measureArea', 'measurePerimeter', 'measureAngle']);

export const isScaleSource = (annotation) => SCALE_SOURCE_TYPES.includes(annotation?.type);
export const isMeasurement = (annotation) => MEASUREMENT_TYPES.includes(annotation?.type);

/** The measurements of a document with a copy of each, taken before a change. */
export function snapshotMeasurements(doc) {
  const measurements = (doc?.annotations || []).filter(isMeasurement);
  return { measurements, originals: measurements.map((annotation) => cloneAnnotation(annotation)) };
}

const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function recalculate(doc) {
  if (!doc || doc !== getActiveDocument()) return false;
  invalidateScaleRegionCache();
  recalculateAllMeasurements();
  return true;
}

function recordChangedSince(doc, snapshot) {
  const present = new Set(doc.annotations);
  const changed = [];
  const before = [];
  snapshot.measurements.forEach((annotation, i) => {
    if (!present.has(annotation)) return;
    if (sameState(cloneAnnotation(annotation), snapshot.originals[i])) return;
    changed.push(annotation);
    before.push(snapshot.originals[i]);
  });
  if (changed.length) recordBulkModify(changed, before);
  return changed.length;
}

/**
 * Recompute the measurements of the active document and record the ones whose
 * stored values changed against `snapshot` as one bulk modify. Call it inside
 * the undo transaction of the change that moved the scale. Only the active
 * document: scale lookups read the active document.
 * @returns {number} the number of measurements that changed
 */
export function recordMeasurementRefresh(doc, snapshot) {
  if (!snapshot || !recalculate(doc)) return 0;
  return recordChangedSince(doc, snapshot);
}

/**
 * Add annotations (a paste) to the active document. A pasted measurement is
 * recomputed for the scale where it lands before its add is recorded; a
 * pasted scale source recomputes the measurements it now covers, in the
 * same undo step.
 * @param {object} doc
 * @param {object[]} added
 * @param {() => void} recordAdded records the add (recordAdd / recordBulkAdd)
 */
export function addWithMeasurementRefresh(doc, added, recordAdded) {
  if (!doc) return;
  if (!added.some((a) => isMeasurement(a) || isScaleSource(a)) || doc !== getActiveDocument()) {
    doc.annotations.push(...added);
    recordAdded();
    return;
  }
  const snapshot = snapshotMeasurements(doc);
  beginUndoTransaction();
  try {
    doc.annotations.push(...added);
    recalculate(doc);
    recordAdded();
    recordChangedSince(doc, snapshot);
  } finally {
    endUndoTransaction();
  }
}

/**
 * Run `mutate` (which records its own undo step) and, when `affected` says
 * the scale may have moved, recompute the measurements in the same undo
 * transaction.
 * @template T
 * @param {object} doc
 * @param {() => T} mutate
 * @param {(result: T) => boolean} affected
 * @returns {T}
 */
export function withMeasurementRefresh(doc, mutate, affected) {
  if (!doc) return mutate();
  const snapshot = snapshotMeasurements(doc);
  beginUndoTransaction();
  try {
    const result = mutate();
    if (affected(result)) recordMeasurementRefresh(doc, snapshot);
    return result;
  } finally {
    endUndoTransaction();
  }
}

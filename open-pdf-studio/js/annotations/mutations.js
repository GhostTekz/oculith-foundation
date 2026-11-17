import { cloneAnnotation } from './factory.js';
import { recordModify, recordDelete, recordBulkDelete } from '../core/undo-manager.js';
import { expandCorrectionGroups } from './corrections/model.js';
import { isLayerLocked } from './annotatie-lagen.js';
import { isScaleSource, withMeasurementRefresh } from './measurement-refresh.js';

export function commitAnnotationMutation(annotation, mutate) {
  if (!annotation?.id || typeof mutate !== 'function') return false;
  const before = cloneAnnotation(annotation);
  mutate(annotation);
  annotation.modifiedAt = new Date().toISOString();
  recordModify(annotation.id, before, annotation);
  return true;
}

/**
 * Verwijdert annotaties uit het document met één ongedaan-stap. Een
 * vervanging (#508) gaat in haar geheel: de andere helft komt mee, zodat er
 * geen los invoegteken of losse doorhaling achterblijft. Eén annotatie blijft
 * een gewone verwijderstap, meer een bulkstap. Is een helft die niet gekozen
 * is vergrendeld, dan telt de hele vervanging als vergrendeld en gaat er niets.
 * Markeringen op een vergrendelde markeringslaag (#468) blijven staan, zoals in
 * the external editor; raakt een vervanging zo'n laag, dan gaat er niets.
 * @returns {object[]} de verwijderde annotaties
 */
export function deleteAnnotationsWithUndo(doc, selection) {
  if (!doc) return [];
  const vrij = (selection || []).filter(a => a && !isLayerLocked(doc, a));
  const weg = expandCorrectionGroups(doc.annotations, vrij);
  if (weg.some(a => isLayerLocked(doc, a))) return [];
  const gekozen = new Set(vrij);
  if (weg.some(a => a.locked && !gekozen.has(a))) return [];
  if (weg.length === 0) return [];
  const remove = () => {
    if (weg.length === 1) recordDelete(weg[0], doc.annotations.indexOf(weg[0]));
    else recordBulkDelete(weg);
    const set = new Set(weg);
    doc.annotations = doc.annotations.filter(a => !set.has(a));
    return weg;
  };
  // A deleted viewport, scale bar or scale region changes the scale of the
  // measurements it covered: recompute them in the same undo step.
  if (!weg.some(isScaleSource)) return remove();
  return withMeasurementRefresh(doc, remove, () => true);
}

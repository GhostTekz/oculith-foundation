// Raceway branches in the open document (docs/reference/editor/raceways.md, Branches): the
// junction of a branch run is derived from the runs as they are now, so a
// moved or deleted parent, or a new opposite branch (tee → cross), shows at
// the next redraw. When the junction no longer matches the run's takeoff
// (measureJunction), the run's values and label are recomputed.

import { branchJunction, junctionKey } from './raceway.js';
import { refreshMeasureExtras, documentAnnotationsOf } from './measurement.js';

/** The junction to draw for a raceway run (null for a plain run). */
export function liveJunction(ann, annotations) {
  if (!ann?.raceway?.branchOf) return null;
  const j = branchJunction(ann, annotations || documentAnnotationsOf(ann));
  if ((junctionKey(j) || undefined) !== ann.measureJunction) refreshMeasureExtras(ann);
  return j;
}

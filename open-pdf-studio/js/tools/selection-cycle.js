// Markup Selection Cycle (current plan-review releases, docs/reference/editor/markup-tools.md): clicking again at
// the same spot selects the next markup under the pointer, through the whole
// stack of overlapping markups, and wraps. Pure: no app imports.

// "The same spot": within this many SCREEN pixels of the previous click.
export const CYCLE_SPOT_PX = 4;

/** Is the click p at the remembered spot (same page, within tol page units)? */
export function sameSpot(prev, p, tol) {
  if (!prev || !p || prev.page !== p.page) return false;
  return Math.hypot(prev.x - p.x, prev.y - p.y) <= tol;
}

/**
 * The next markup id to select. `hitIds`: the ids under the pointer, top
 * first (findAnnotationsAt); `currentId`: the selected markup. Null when
 * there is nothing to cycle (fewer than two hits, or the selection is not
 * one of them).
 */
export function nextCycleId(hitIds, currentId) {
  if (!Array.isArray(hitIds) || hitIds.length < 2) return null;
  const i = hitIds.indexOf(currentId);
  if (i < 0) return null;
  return hitIds[(i + 1) % hitIds.length];
}

/**
 * The whole stack under (x, y), top first: `find(x, y, page, { skip })` is
 * findAnnotationAt (geometry.js), asked again with the hits so far skipped.
 */
export function collectStack(find, x, y, page, limit = 50) {
  const skip = new Set();
  const hits = [];
  while (hits.length < limit) {
    const ann = find(x, y, page, { skip });
    if (!ann || skip.has(ann)) break;
    hits.push(ann);
    skip.add(ann);
  }
  return hits;
}

/** 1-based position of id in the stack, for the status bar ("2 of 3"). */
export function cyclePosition(hitIds, id) {
  const i = Array.isArray(hitIds) ? hitIds.indexOf(id) : -1;
  return i < 0 ? null : { index: i + 1, count: hitIds.length };
}

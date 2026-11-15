// Region selection of the select tool.
//
// A marquee drag that captures no markups leaves a box on the page: the part
// of the drawing Cut or Copy takes (annotations/region-clipboard.js). It is
// kept in page points of one page of one document and drawn dashed in the
// marquee's blue until Esc, a click elsewhere, a tool change, another page or
// tab, or a new selection.
//
// Light on purpose: rendering.js draws it, so this module imports nothing
// but the state.

import { state, getActiveDocument } from '../core/state.js';

/**
 * @param {{docId:string, page:number, x:number, y:number, width:number, height:number}} region
 */
export function setRegionSelection(region) {
  state.regionSelection = region ? {
    docId: region.docId, page: region.page,
    x: region.x, y: region.y, width: region.width, height: region.height,
  } : null;
}

/** Clears the region selection. @returns {boolean} whether there was one */
export function clearRegionSelection() {
  if (!state.regionSelection) return false;
  state.regionSelection = null;
  return true;
}

/**
 * The region selection of the active document, or null. A region left on
 * another tab, or (single page view) on a page the view has moved away from,
 * is cleared here.
 */
export function getRegionSelection(doc = getActiveDocument()) {
  const r = state.regionSelection;
  if (!r) return null;
  const valid = !!doc && doc.id === r.docId
    && (doc.viewMode === 'continuous' || (doc.currentPage || 1) === r.page);
  if (!valid) {
    state.regionSelection = null;
    return null;
  }
  return r;
}

export const hasRegionSelection = () => !!getRegionSelection();

/**
 * Draws the region selection of `pageNum`. `ctx` is already in page space
 * (the annotation transform, including a rotated view), so the line width
 * and dashes are divided by the scale to stay the same on screen.
 */
export function drawRegionSelection(ctx, pageNum, effectiveScale) {
  const r = getRegionSelection();
  if (!r || r.page !== pageNum) return;
  const s = effectiveScale > 0 ? effectiveScale : 1;
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
  ctx.lineWidth = 1.5 / s;
  ctx.setLineDash([6 / s, 4 / s]);
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.strokeRect(r.x, r.y, r.width, r.height);
  ctx.setLineDash([]);
  ctx.restore();
}

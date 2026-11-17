// Content changes on the OLD pane of a side-by-side compare.
//
// Change detection compares the NEW page with the OLD page moved by the
// alignment offset ({dx, dy, rotation}), so a change box is measured on the
// NEW page. The side-by-side OLD pane shows the old page unmoved: its boxes go
// back through the inverse of the alignment (compareOffsetTransform), as the
// bounding box of the mapped corners when the alignment rotates. Pure, no app
// imports.

import { applyPoint, compareOffsetTransform, invert } from '../sets/slip-sheet-transform.js';

const hasOffset = (offset) => !!(offset && (offset.dx || offset.dy || offset.rotation));

/**
 * @param {Array<{x:number,y:number,width:number,height:number,detectScale?:number}>} changes
 *   boxes in detection pixels (detectScale pixels per point; `fallbackScale`
 *   when a record has none)
 * @param {{dx?:number,dy?:number,rotation?:number}} offset the compare alignment
 * @param {{width:number,height:number}} newSizePt the NEW page size in points
 * @param {number} fallbackScale
 * @returns {Array} the same records, mapped onto the old page (unchanged without an offset)
 */
export function changesOnOldPane(changes, offset, newSizePt, fallbackScale = 1.5) {
  if (!Array.isArray(changes) || !hasOffset(offset)) return changes || [];
  if (!(newSizePt?.width > 0 && newSizePt?.height > 0)) return changes;
  let inverse;
  try {
    inverse = invert(compareOffsetTransform(offset, newSizePt).matrix);
  } catch {
    return changes;
  }
  return changes.map((c) => {
    const s = c.detectScale > 0 ? c.detectScale : fallbackScale;
    const corners = [[c.x, c.y], [c.x + c.width, c.y], [c.x, c.y + c.height], [c.x + c.width, c.y + c.height]]
      .map(([x, y]) => applyPoint(inverse, x / s, y / s));
    const xs = corners.map((p) => p.x * s);
    const ys = corners.map((p) => p.y * s);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { ...c, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  });
}

// Pure rules for cutting a region of a drawing and pasting it (node-testable).
//
// A region is a box on a page, drawn with the select tool where no markups
// are. Cut or Copy puts that part of the page on the snippet clipboard; Paste
// places it on the current page of the active drawing, where it was taken.
// Next to it live two other clipboards (markups, and the snapshot image): the
// most recent copy is the one that pastes.

/**
 * Which copy is the most recent? Each argument is the time (ms) of the last
 * copy of that kind, or a falsy value when there is none. On a tie the
 * markups win, then the snapshot: that was the behaviour before regions.
 * @param {{region?: number|null, markups?: number|null, snapshot?: number|null}} times
 * @returns {'region'|'markups'|'snapshot'|null}
 */
export function latestCopy({ region, markups, snapshot } = {}) {
  let best = null;
  let bestAt = -Infinity;
  for (const [kind, at] of [['markups', markups], ['snapshot', snapshot], ['region', region]]) {
    const t = Number(at);
    if (!at || !Number.isFinite(t)) continue;
    if (t > bestAt) { best = kind; bestAt = t; }
  }
  return best;
}

/**
 * The box spanned by a drag, or null when it is too small to be a region
 * (a click, or a line). Coordinates are page points.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number} [minSize]
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function regionFromDrag(a, b, minSize = 1) {
  if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) return null;
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  const min = Math.max(Number(minSize) || 0, 1);
  if (width < min || height < min) return null;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height };
}

/**
 * Keeps a box on the page: the part outside the page is cut off.
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{width:number,height:number}|null} page
 * @returns {{x:number,y:number,width:number,height:number}|null}  null when nothing is left
 */
export function intersectWithPage(rect, page) {
  if (!rect || !(page?.width > 0) || !(page?.height > 0)) return rect || null;
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(page.width, rect.x + rect.width);
  const bottom = Math.min(page.height, rect.y + rect.height);
  if (right - x <= 0 || bottom - y <= 0) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Where a pasted region goes on the target page: at the position it was
 * taken from, at its own size, moved (not scaled) so it stays on the page.
 * On a page smaller than the region it starts at the page's top-left corner.
 * Without a page size the position is kept.
 * @param {{x:number,y:number}} from   position on the source page
 * @param {{width:number,height:number}} size  size of the pasted region
 * @param {{width:number,height:number}|null} page  target page size
 * @returns {{x:number,y:number}}
 */
export function pastePosition(from, size, page) {
  let x = Number.isFinite(from?.x) ? from.x : 0;
  let y = Number.isFinite(from?.y) ? from.y : 0;
  if (page?.width > 0 && page?.height > 0) {
    const w = Math.max(0, Number(size?.width) || 0);
    const h = Math.max(0, Number(size?.height) || 0);
    x = Math.max(0, Math.min(x, page.width - w));
    y = Math.max(0, Math.min(y, page.height - h));
  }
  return { x, y };
}

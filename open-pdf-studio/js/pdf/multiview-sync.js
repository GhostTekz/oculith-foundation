// MultiView Sync math (docs/reference/editor/workspace.md). Pure: no DOM, no app state.
//
// the external editor: Synchronize Document matches views by page index; Synchronize Page
// ignores the page index (it keeps the page offset the panes had when Sync
// was turned on). Both make zoom and pan follow.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Page offset to keep for Sync Page: page shown in pane 1 minus page in pane
 * 0. Pass the pages in pane order.
 */
export function pageOffsetFor(pagePane0, pagePane1) {
  const a = Number.isInteger(pagePane0) ? pagePane0 : 1;
  const b = Number.isInteger(pagePane1) ? pagePane1 : 1;
  return b - a;
}

/**
 * The page the other pane shows when the source pane shows `sourcePage`.
 * `sourcePane` is the index (0 or 1) of the pane that moved; pageOffset is
 * pane 1 minus pane 0. Clamped to the target's page count.
 */
export function syncedPage({ mode = 'document', sourcePage, sourcePane = 0, pageOffset = 0, targetPageCount }) {
  const count = Number.isInteger(targetPageCount) && targetPageCount > 0 ? targetPageCount : 1;
  const page = Number.isInteger(sourcePage) ? sourcePage : 1;
  if (mode !== 'page') return clamp(page, 1, count);
  const offset = sourcePane === 0 ? pageOffset : -pageOffset;
  return clamp(page + offset, 1, count);
}

/**
 * Scroll position for the target box so the centre of its viewport sits at
 * the same fraction of the content as the source's centre. Boxes:
 * { scrollLeft, scrollTop, clientWidth, clientHeight, scrollWidth,
 *   scrollHeight }. The result is clamped to the target's scroll range.
 */
export function mapScroll(source, target) {
  const axis = (pos, view, content, tView, tContent) => {
    const max = Math.max(0, tContent - tView);
    if (!(content > 0) || !(tContent > 0)) return 0;
    const centre = (pos + view / 2) / content;
    return Math.round(clamp(centre * tContent - tView / 2, 0, max));
  };
  return {
    scrollLeft: axis(source.scrollLeft, source.clientWidth, source.scrollWidth, target.clientWidth, target.scrollWidth),
    scrollTop: axis(source.scrollTop, source.clientHeight, source.scrollHeight, target.clientHeight, target.scrollHeight),
  };
}

/**
 * Scroll content size of a page at a scale in a box that pads it by `pad`
 * on every side (the passive pane's layout). Lets the caller predict the
 * target's scroll range before it has rendered.
 */
export function contentSize(pageWidthPt, pageHeightPt, scale, pad = 0) {
  return { width: pageWidthPt * scale + 2 * pad, height: pageHeightPt * scale + 2 * pad };
}

/**
 * The view the other pane should take. source = { page, scale, box } (box as
 * for mapScroll, or null when pan must not follow, e.g. continuous mode);
 * target = { pageCount, box } where box is the target's predicted box after
 * the page and zoom change (or null).
 * Returns { page, scale, scrollLeft?, scrollTop? }.
 */
export function syncView({ mode = 'document', sourcePane = 0, pageOffset = 0, source, target }) {
  const page = syncedPage({ mode, sourcePage: source.page, sourcePane, pageOffset, targetPageCount: target.pageCount });
  const out = { page, scale: source.scale };
  if (source.box && target.box) Object.assign(out, mapScroll(source.box, target.box));
  return out;
}

// Affine helpers ([a, b, c, d, e, f] as in canvas setTransform).
function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
function multiply([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) {
  // m1 after m2.
  return [
    a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * The passive split's annotation transform: page space (annotation
 * coordinates = the PDF.js viewport at scale 1 with the page's own and the
 * document's page rotation) → the split's CSS pixels, via PDF user space.
 * A CropBox origin and a view rotation are both honoured.
 * @param {{transform: number[]}} baseViewport   page.getViewport({ scale: 1, rotation })
 * @param {{transform: number[]}} screenViewport page.getViewport({ scale, rotation: rotation + viewRotation })
 */
export function annotationToScreen(baseViewport, screenViewport) {
  return multiply(screenViewport.transform, invert(baseViewport.transform));
}

/** Apply an affine matrix to a point. */
export function applyMatrix([a, b, c, d, e, f], x, y) {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

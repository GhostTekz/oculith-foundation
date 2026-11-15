// Does a plain mouse-wheel event turn the page in the single-page view?
//
// Preference `wheelChangesPage`:
//  - 'never' (default): the wheel scrolls inside the current page and stops
//    at its edges. Pages change only through explicit commands: the Previous
//    / Next buttons, the page field, PageUp / PageDown, thumbnails, the
//    drawing set, links and Go to Sheet. A drawing that fits the window has
//    nothing to scroll, so the wheel does nothing there.
//  - 'edge': at the top or bottom edge of the page the wheel turns one page,
//    but only with a wheel gesture that STARTS at that edge. Scrolling down
//    through a zoomed page stops at its bottom; the next gesture turns the
//    page. Touchpad momentum and a fast spin of the wheel belong to the
//    gesture that started them, so they turn at most one page.
// The continuous, book and facing views always scroll; this only decides
// for the single-page view.
//
// Pure: no DOM. The clock is passed in (wheel-page-turn.test.mjs).

export const WHEEL_PAGE_NEVER = 'never';
export const WHEEL_PAGE_AT_EDGE = 'edge';
export const WHEEL_PAGE_MODES = Object.freeze([WHEEL_PAGE_NEVER, WHEEL_PAGE_AT_EDGE]);

// A pause in the wheel events longer than this starts a new gesture. Touchpad
// momentum arrives every frame; a deliberate new wheel turn after a page
// change comes later than this.
export const WHEEL_GESTURE_GAP_MS = 250;

/** The wheel page mode of a preferences object ('never' unless set to 'edge'). */
export function wheelPageMode(preferences) {
  return preferences?.wheelChangesPage === WHEEL_PAGE_AT_EDGE ? WHEEL_PAGE_AT_EDGE : WHEEL_PAGE_NEVER;
}

/**
 * Tracks wheel gestures and decides page turns.
 * @param {{ gap?: number }} [options]
 */
export function makeWheelPageTurn({ gap = WHEEL_GESTURE_GAP_MS } = {}) {
  let last = -Infinity;
  let startedAtTop = false;
  let startedAtBottom = false;
  let turned = false;
  return {
    /**
     * Call for every plain wheel event on the page (also when the answer
     * cannot be a turn, so the gesture boundaries stay right).
     * @param {object} o
     * @param {string} o.mode       'never' | 'edge'
     * @param {boolean} o.single    single-page view
     * @param {number} o.dx         wheel delta in px
     * @param {number} o.dy
     * @param {boolean} o.atTop     the top of the page is in view
     * @param {boolean} o.atBottom  the bottom of the page is in view
     * @param {number} o.page
     * @param {number} o.numPages
     * @param {number} o.now        clock in ms
     * @returns {-1 | 0 | 1}  the page step to take
     */
    decide({ mode, single, dx, dy, atTop, atBottom, page, numPages, now }) {
      const fresh = now - last > gap;
      last = now;
      if (fresh) {
        startedAtTop = !!atTop;
        startedAtBottom = !!atBottom;
        turned = false;
      }
      if (mode !== WHEEL_PAGE_AT_EDGE || !single || turned) return 0;
      if (!dy || Math.abs(dy) <= Math.abs(dx || 0)) return 0;
      if (dy > 0 && startedAtBottom && atBottom && page < numPages) { turned = true; return 1; }
      if (dy < 0 && startedAtTop && atTop && page > 1) { turned = true; return -1; }
      return 0;
    },
    /**
     * The page turn finished at `now` (the new page is drawn). Wheel events
     * that waited behind the render still belong to the gesture that
     * turned, so the gap counts from here.
     */
    turnDone(now) {
      if (now > last) last = now;
    },
    /** Forget the gesture (e.g. after a page change by another route). */
    reset() {
      last = -Infinity;
      startedAtTop = startedAtBottom = turned = false;
    },
  };
}

/**
 * How far the wheel may pan the page from where it is: on an axis where the
 * page is larger than the window, until the page edge meets the window edge
 * and no further. A page that already lies past an edge (after a zoom at the
 * cursor, or a drag) is never pulled back; the wheel only refuses to move it
 * further out. On an axis where the page fits, the wheel does not move it.
 *
 * Offsets are where the page edge lies in the window (CSS px); a positive
 * delta moves the content up / left, like deltaY / deltaX. The result is the
 * range of deltas, in the shape wiel-scroll.js takes as `ruimte`.
 * @returns {{loX: number, hiX: number, loY: number, hiY: number}}
 */
export function wheelPanRange({ pageLeft, pageTop, pageWidth, pageHeight, viewWidth, viewHeight }) {
  const axis = (start, size, view) => (size > view + 0.5
    ? [Math.min(0, start), Math.max(0, start + size - view)]
    : [0, 0]);
  const [loX, hiX] = axis(pageLeft, pageWidth, viewWidth);
  const [loY, hiY] = axis(pageTop, pageHeight, viewHeight);
  return { loX, hiX, loY, hiY };
}

/**
 * A wheel delta limited to wheelPanRange(): the page stops at its edges.
 * @returns {{dx: number, dy: number}}
 */
export function clampWheelPan({ dx, dy, ...page }) {
  const r = wheelPanRange(page);
  const clamp = (v, lo, hi) => (v ? Math.min(hi, Math.max(lo, v)) : 0);
  return { dx: clamp(dx, r.loX, r.hiX), dy: clamp(dy, r.loY, r.hiY) };
}

/**
 * dynamicFillTool — plan-review Dynamic Fill (J). A paint-bucket click inside
 * a region bounded by the page's vector linework fills and previews it; the
 * options bar (DynamicFillBar.jsx) turns the fills into an Area measurement
 * (default), Perimeter, Polylength or a Polygon markup.
 *
 * Fill mode:
 *   - click: fill the region under the cursor (replaces the current fills)
 *   - Shift/Ctrl+click: add a region; on an existing fill it removes it
 *   - hold the button and drag: every region the cursor passes is added
 *     (the external editor: moving while holding spreads the fill faster)
 *   - drag a closed loop (end near the start): every region wholly inside
 *     the loop is added too (the external editor: encircling)
 *   - Enter or right-click: Apply; Backspace: undo the last fill
 * Boundary mode (temporary lines that close gaps, cleared after Apply):
 *   - click points; double-click, Enter or right-click finishes the line
 * Esc cancels everything and returns to Select.
 *
 * Geometry: js/tools/dynamic-fill/fill-region.js; session state, Apply and
 * Clear: js/tools/dynamic-fill/session.js; docs/reference/editor/measuring.md.
 */

import { encirclingLoop } from '../dynamic-fill/fill-region.js';
import {
  fillInside, options, fillAt, addBoundaryPoint, setBoundaryHover, finishBoundary, undoLast, apply, cancel, hasFills,
} from '../dynamic-fill/session.js';
import { DYNAMIC_FILL_CURSOR } from '../dynamic-fill/cursor.js';

// Drag-to-paint: the stroke's page, its last point, the points still to fill
// (the path is sampled every few screen pixels so a narrow region between
// two pointer events is not skipped) and whether a fill is running (one at a
// time, in path order).
const PAINT_STEP_PX = 3;
const PAINT_QUEUE_MAX = 4000;
const paint = { active: false, page: null, last: null, queue: [], running: false, path: [], zoom: 1 };
// End of a drag within this many screen pixels of its start closes a loop.
const ENCIRCLE_CLOSE_PX = 16;

const paintIdle = () => new Promise((resolve) => {
  const check = () => (paint.running ? setTimeout(check, 20) : resolve());
  check();
});

function queuePaint(x, y, zoom) {
  const last = paint.last;
  paint.last = { x, y };
  if (!last) { paint.queue.push({ x, y }); return; }
  const step = PAINT_STEP_PX / (zoom || 1);
  const n = Math.max(1, Math.ceil(Math.hypot(x - last.x, y - last.y) / step));
  for (let k = 1; k <= n && paint.queue.length < PAINT_QUEUE_MAX; k++) {
    paint.queue.push({ x: last.x + (x - last.x) * k / n, y: last.y + (y - last.y) * k / n });
  }
}

function runPaint() {
  if (paint.running || !paint.queue.length) return;
  const { x, y } = paint.queue.shift();
  paint.running = true;
  fillAt(paint.page, x, y, 'paint').finally(() => {
    paint.running = false;
    // Next point in a new task, so the browser paints and takes pointer
    // input between fills (chaining promises here froze the page).
    setTimeout(runPaint, 0);
  });
}

// First pointer move after the tool became active: repaint once so the
// "hide markups" setting applies (the tool switch itself does not repaint).
let seenSinceActivate = false;

let barRequested = false;
/** Mount the options bar once (lazily, so the tool module stays light). */
export function ensureDynamicFillBar() {
  if (barRequested || typeof document === 'undefined') return;
  barRequested = true;
  import('../../solid/components/DynamicFillBar.jsx')
    .then((m) => m.mountDynamicFillBar())
    .catch((err) => { barRequested = false; console.error('[dynamicFill] options bar', err); });
}

export const dynamicFillTool = {
  name: 'dynamicFill',
  cursor: DYNAMIC_FILL_CURSOR,

  onPointerDown(ctx, e) {
    ensureDynamicFillBar();
    const boundary = options().mode === 'boundary';
    if (e.button === 2) {
      if (boundary) finishBoundary();
      else if (hasFills()) apply().then(() => ctx.redraw());
      return;
    }
    if (e.button !== 0 && e.button !== undefined) return;
    if (boundary) {
      if (e.detail === 2) { finishBoundary(); return; }
      const snap = ctx.snap(ctx.x, ctx.y);
      addBoundaryPoint(ctx.pageNum, snap.snapped ? snap.x : ctx.x, snap.snapped ? snap.y : ctx.y);
      return;
    }
    if (e.detail === 2) return; // the two clicks of a double-click already filled
    const additive = !!(e.shiftKey || e.ctrlKey || e.metaKey);
    paint.active = true;
    paint.page = ctx.pageNum;
    paint.last = { x: ctx.x, y: ctx.y };
    paint.queue = [];
    paint.path = [{ x: ctx.x, y: ctx.y }];
    paint.zoom = ctx.scale || 1;
    paint.running = true;
    fillAt(ctx.pageNum, ctx.x, ctx.y, additive).finally(() => {
      paint.running = false;
      setTimeout(runPaint, 0);
    });
  },

  onPointerMove(ctx, e) {
    ensureDynamicFillBar();
    if (!seenSinceActivate) {
      seenSinceActivate = true;
      if (options().hideMarkups) ctx.redraw();
    }
    if (options().mode !== 'boundary') {
      if (paint.active && (e.buttons & 1) && ctx.pageNum === paint.page) {
        queuePaint(ctx.x, ctx.y, ctx.scale);
        paint.path.push({ x: ctx.x, y: ctx.y });
        runPaint();
      } else if (paint.active && !(e.buttons & 1)) {
        paint.active = false;
      }
      return;
    }
    const snap = ctx.snap(ctx.x, ctx.y);
    const x = snap.snapped ? snap.x : ctx.x, y = snap.snapped ? snap.y : ctx.y;
    if (setBoundaryHover(ctx.pageNum, x, y)) ctx.redraw();
    if (snap.snapped) ctx.drawSnapIndicator(snap);
  },

  onPointerUp() {
    // A queued last point still fills; no new ones are taken.
    const wasPainting = paint.active;
    paint.active = false;
    const loop = wasPainting ? encirclingLoop(paint.path, ENCIRCLE_CLOSE_PX / paint.zoom) : null;
    paint.path = [];
    if (loop) {
      // The inside covers what the remaining path points would add.
      paint.queue = [];
      const page = paint.page;
      paintIdle().then(() => fillInside(page, loop));
    }
    return true;
  },

  onKeyDown(ctx, e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (options().mode === 'boundary') finishBoundary();
      else apply();
    } else if (e.key === 'Backspace') {
      if (undoLast()) e.preventDefault();
    }
  },

  onEscape() {
    cancel();
    return true;
  },

  onDeactivate() {
    seenSinceActivate = false;
    paint.active = false;
    paint.queue = [];
    cancel();
  },
};

/**
 * racewayTool — draw a conduit or cable tray run (docs/reference/editor/raceways.md).
 *
 *   - Click to start, click each corner; the run continues until
 *     double-click, Enter or right-click finishes it (2+ points).
 *   - After the first leg every corner snaps to a standard elbow relative to
 *     the previous leg: straight on, or 30/45/60/90° either way (the angles
 *     are a setting). Hold Alt for a free angle. The first leg follows Shift
 *     (angle snap) and object snap like the other drawing tools.
 *   - Each placed corner is an elbow at the fitting's standard radius on a
 *     calibrated sheet. The leg under the cursor is only a straight centre
 *     line (two rails for a tray or a true-size conduit). Building the whole
 *     tray, rungs included, on that moving leg left a rail across the sheet
 *     and redrew the page on every move. The live label shows the developed
 *     length, the fittings and (conduit) the bend total with the 360° warning.
 *   - Backspace removes the last corner; Esc finishes a run of 2+ points
 *     (like the polyline tool) or cancels it.
 *   - Branches: starting on a run of the same kind (its band or centre
 *     line) snaps the first point onto that run's centre line and makes the
 *     new run a branch of it (raceway.branchOf: tee, cross, reducer). Ending
 *     on a run's end point connects to it the same way (the new run is
 *     stored reversed, so it starts there).
 */

import { state, getActiveDocument } from '../../core/state.js';
import { applyToolTransform } from '../tool-context.js';
import {
  nextCorner, isRacewayRun, racewayCentre, nearestOnPath, normalizeRaceway, bandWidthIn, validRunId,
  racewayName, branchJunction, BRANCH_TOL, drawPxPerIn,
} from '../../annotations/raceway.js';
import { computeMeasureExtras, pxPerInchOf } from '../../annotations/measure-extras.js';
import { getMeasureScale, formatMeasurement, formatDimensionText } from '../../annotations/measurement.js';
import { activeRaceway, settings, drawing, setDrawing } from '../raceway/session.js';
import { createRacewayAnnotation, racewayColor } from '../raceway/raceway-creator.js';
import {
  annotationFrame, clearRacewayGesture, setRacewayGesture, setRacewaySkipLive, strokeRacewayLiveLeg,
} from '../raceway/live-preview.js';

// The run being drawn; marks: { [pointIndex]: 'pull' | 'up' | 'down' };
// branch: { id, at, name } when it starts on another run; noScale: the
// sheet under the cursor has no scale (the bar then offers Set Scale).
const run = { page: null, points: [], preview: null, marks: {}, lastCtx: null, branch: null, noScale: false };

/** The settings plus this run's marks, the tag (session) and the branch. */
function runRaceway(marks = run.marks, branch = run.branch) {
  const tag = settings().tag;
  return {
    ...activeRaceway(), marks, ...(tag ? { tag } : {}),
    ...(branch ? { branchOf: { id: branch.id, at: { x: branch.at.x, y: branch.at.y } } } : {}),
  };
}

function sameMarks(a, b) {
  const ak = Object.keys(a || {});
  const bk = Object.keys(b || {});
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** Bar state: point count, live label, marks and the parent being branched from. */
function show(text = '', branchName = run.branch?.name) {
  const prev = drawing();
  const marks = { ...run.marks };
  if (prev.points === run.points.length && prev.text === text && prev.noScale === run.noScale
    && prev.page === run.page && (prev.branch || undefined) === (branchName || undefined) && sameMarks(prev.marks, marks)) return;
  setDrawing({ points: run.points.length, text, marks, noScale: run.noScale, page: run.page,
    ...(branchName ? { branch: branchName } : {}) });
}

const docRuns = (page) => (getActiveDocument()?.annotations || []).filter((a) => isRacewayRun(a) && a.page === page);

/**
 * A run of the kind being drawn under the cursor (its band, or a few screen
 * pixels around its centre line): the snap point on its centre line, an
 * existing branch start there (so a second branch makes a cross) or its end
 * point. Null when there is none.
 */
export function branchStartAt(runs, x, y, kind, scale = 1) {
  const pick = 6 / (scale || 1);
  let best = null;
  for (const a of runs) {
    if (!validRunId(a.id) || normalizeRaceway(a.raceway).kind !== kind) continue;
    const near = nearestOnPath(racewayCentre(a), { x, y });
    if (!near) continue;
    const rw = normalizeRaceway(a.raceway);
    const px = drawPxPerIn(rw, a.measurePxPerIn);
    const half = px ? bandWidthIn(rw) * px / 2 : 0;
    if (near.dist > half + pick || (best && near.dist >= best.dist)) continue;
    let p = { x: near.x, y: near.y };
    const reach = Math.max(half, pick);
    const ends = [a.points[0], a.points[a.points.length - 1]];
    const others = runs.filter((o) => o.raceway?.branchOf?.id === a.id).map((o) => o.points[0]);
    for (const q of [...ends, ...others]) {
      if (Math.hypot(q.x - near.x, q.y - near.y) <= reach) { p = { x: q.x, y: q.y }; break; }
    }
    best = { ...p, dist: near.dist, parent: a, centre: racewayCentre(a) };
  }
  return best;
}

// Highlight the parent's centre line and the snap point (before the first click).
function drawBranchHover(ctx, hit) {
  const c = ctx.canvasCtx;
  if (!c) return;
  c.save();
  applyToolTransform(c);
  c.strokeStyle = '#FF00FF';
  c.lineWidth = 1.5 / (ctx.scale || 1);
  c.setLineDash([4 / (ctx.scale || 1), 3 / (ctx.scale || 1)]);
  c.beginPath();
  hit.centre.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.stroke();
  c.restore();
  ctx.drawSnapIndicator({ snapped: true, type: 'edge', x: hit.x, y: hit.y });
}

/**
 * Bar buttons: mark the last placed point as a pull box, riser (up) or drop
 * (down); the same kind again clears it. Returns the mark now on the point.
 */
export function markLastPoint(kind) {
  const i = run.points.length - 1;
  if (i < 0) return null;
  if (run.marks[i] === kind) delete run.marks[i]; else run.marks[i] = kind;
  show(labelText());
  if (run.lastCtx) paintSheet(run.lastCtx);
  return run.marks[i] || null;
}

let barRequested = false;
/** Mount the options bar once (lazily). */
export function ensureRacewayBar() {
  if (barRequested || typeof document === 'undefined') return;
  barRequested = true;
  import('../../solid/components/RacewayBar.jsx')
    .then((m) => m.mountRacewayBar())
    .catch((err) => { barRequested = false; console.error('[raceway] options bar', err); });
}

function previewAnnotation(points) {
  const rw = runRaceway();
  const ann = { type: 'measurePerimeter', measureKind: 'raceway', raceway: rw, points, page: run.page };
  const mid = points[Math.floor(points.length / 2)];
  const scale = getMeasureScale(run.page, mid.x, mid.y);
  const annotations = getActiveDocument()?.annotations || [];
  Object.assign(ann, computeMeasureExtras(ann, scale, { formatMeasurement, formatDimensionText, annotations }) || {});
  ann.junction = branchJunction(ann, annotations);
  return ann;
}

function cursorPoint(ctx, e) {
  const n = run.points.length;
  const s = ctx.snap(ctx.x, ctx.y, null, run.points);
  const snap = s.snapped ? { x: s.x, y: s.y } : null;
  state.lastSnapResult = s.snapped ? s : null;
  if (n === 1 && !snap && e.shiftKey && state.preferences?.enableAngleSnap) {
    const a = run.points[0];
    const ang = Math.atan2(ctx.y - a.y, ctx.x - a.x) * 180 / Math.PI;
    const r = ctx.snapAngle(ang, state.preferences.angleSnapDegrees) * Math.PI / 180;
    const d = Math.hypot(ctx.x - a.x, ctx.y - a.y);
    return { x: a.x + d * Math.cos(r), y: a.y + d * Math.sin(r) };
  }
  const st = settings();
  return nextCorner(run.points, ctx.x, ctx.y, {
    free: e.altKey || !st.snapBends, angles: st.angles, snap, tol: 6 / (ctx.scale || 1),
  });
}

function reset() {
  run.points = [];
  run.preview = null;
  run.page = null;
  run.marks = {};
  run.branch = null;
  committed = null;
  sheet = null;
  clearRacewayGesture();
  setDrawing({ points: 0, text: '', marks: {}, noScale: run.noScale });
}

// Placed corners, cached so a cursor move does not rebuild them. The moving
// leg is not part of this: it never goes through racewayDrawing.
let committed = null;
let sheet = null;

function geomStamp() {
  const mid = run.points[0];
  const scale = mid && run.page != null ? getMeasureScale(run.page, mid.x, mid.y) : null;
  return JSON.stringify({
    pts: run.points, marks: run.marks, branch: run.branch?.id || '',
    rw: runRaceway(), px: pxPerInchOf(scale), ppu: scale?.pixelsPerUnit, unit: scale?.unit,
    cal: scale?.calibrated === true,
  });
}

function ensureCommitted() {
  const stamp = geomStamp();
  if (committed && committed.stamp === stamp) return committed;
  const mid = run.points[0];
  const scale = mid && run.page != null ? getMeasureScale(run.page, mid.x, mid.y) : null;
  const px = drawPxPerIn(normalizeRaceway(runRaceway()), pxPerInchOf(scale));
  const half = px ? bandWidthIn(normalizeRaceway(runRaceway())) * px / 2 : 0;
  let ann = null, text = '', developedPx = 0;
  if (run.points.length >= 2) {
    ann = previewAnnotation(run.points);
    text = ann.measureText || '';
    developedPx = Number(ann.measurePixels) || 0;
  }
  committed = { stamp, ann, text, developedPx, half, scale };
  return committed;
}

function labelText() {
  const info = ensureCommitted();
  if (run.points.length === 1 && run.preview) {
    const ann = previewAnnotation([run.points[0], { x: run.preview.x, y: run.preview.y }]);
    return ann.measureText || '';
  }
  if (!info.text || !run.preview || run.points.length < 2) return info.text || '';
  const last = run.points[run.points.length - 1];
  const extraPx = Math.hypot(run.preview.x - last.x, run.preview.y - last.y);
  const scale = info.scale;
  if (!scale || !(extraPx > 0.5)) return info.text;
  const ppu = Number(scale.pixelsPerUnit) > 0 ? Number(scale.pixelsPerUnit) : 1;
  const value = (info.developedPx + extraPx) / ppu;
  const lengthText = scale.calibrated
    ? formatMeasurement({ value, unit: scale.unit, calibrated: true, ...(scale.precision != null ? { precision: scale.precision } : {}) })
    : `${Number(value.toFixed(2))} ${scale.unit || 'pt'}`;
  const uncal = scale.calibrated ? '' : 'Scale not set · ';
  const rest = info.text.startsWith(uncal) ? info.text.slice(uncal.length) : info.text;
  const cut = rest.indexOf(' · ');
  return uncal + lengthText + (cut >= 0 ? rest.slice(cut) : '');
}

function publishGesture(ctx) {
  if (!run.points.length || run.page == null) {
    clearRacewayGesture();
    return;
  }
  const info = ensureCommitted();
  const last = run.points[run.points.length - 1];
  const live = run.preview && last
    ? { a: { x: last.x, y: last.y }, b: { x: run.preview.x, y: run.preview.y }, half: info.half }
    : null;
  setRacewayGesture({
    page: run.page,
    ann: info.ann,
    color: racewayColor(activeRaceway().kind),
    screenScale: ctx.scale || 1,
    live,
  });
}

function viewStamp() {
  const vp = typeof window !== 'undefined' ? window.__pdfViewport : null;
  const doc = getActiveDocument();
  return [
    vp?.active ? vp.zoom : doc?.scale,
    vp?.active ? vp.offsetX : 0,
    vp?.active ? vp.offsetY : 0,
    vp?.active ? vp.pageNum : doc?.currentPage,
    doc?.annotations?.length || 0,
    doc?.selectedAnnotations?.length || 0,
  ].join(',');
}

function sheetKey(canvas) {
  return [canvas?.width, canvas?.height, viewStamp(), run.page, run.points.length, geomStamp()].join('|');
}

function captureSheet(canvas, key) {
  if (typeof document === 'undefined' || !canvas?.width) return;
  if (!sheet || sheet.canvas.width !== canvas.width || sheet.canvas.height !== canvas.height) {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    sheet = { canvas: copy, key: '', frame: -1 };
  }
  const o = sheet.canvas.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalCompositeOperation = 'source-over';
  o.globalAlpha = 1;
  o.clearRect(0, 0, sheet.canvas.width, sheet.canvas.height);
  o.drawImage(canvas, 0, 0);
  sheet.key = key;
  sheet.frame = annotationFrame();
}

function blitSheet(ctx) {
  const c = ctx.canvasCtx;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  c.drawImage(sheet.canvas, 0, 0);
  c.restore();
}

function strokeLive(ctx) {
  const c = ctx.canvasCtx;
  if (!c || !run.preview) return;
  c.save();
  applyToolTransform(c);
  strokeRacewayLiveLeg(c, ctx.scale || 1);
  c.restore();
}

/**
 * Repaint the sheet under the gesture. A cursor move reuses the last clean
 * copy (annotations plus placed corners) and strokes only the straight leg.
 * A click, a view change, or another repaint builds that copy once.
 */
function paintSheet(ctx) {
  const c = ctx.canvasCtx;
  const canvas = c?.canvas;
  if (!c || !canvas) return;
  publishGesture(ctx);
  const key = sheetKey(canvas);
  if (sheet && sheet.key === key && sheet.frame === annotationFrame()) {
    blitSheet(ctx);
    strokeLive(ctx);
    return;
  }
  setRacewaySkipLive(true);
  try { ctx.redraw(); }
  finally { setRacewaySkipLive(false); }
  captureSheet(canvas, key);
  strokeLive(ctx);
}

/**
 * A run that ends on another run's end point (same kind) connects there: it
 * is stored reversed, as a branch starting on that end (a straight
 * connection, or a reducer when the sizes differ). Returns the points and
 * marks to store and the branch, unchanged when there is no such end.
 */
function endConnection(pts, marks, tol) {
  if (run.branch || pts.length < 2) return { pts, marks, branch: run.branch };
  const last = pts[pts.length - 1];
  const kind = activeRaceway().kind;
  for (const a of docRuns(run.page)) {
    if (!validRunId(a.id) || normalizeRaceway(a.raceway).kind !== kind) continue;
    const end = [a.points[0], a.points[a.points.length - 1]]
      .find((q) => Math.hypot(q.x - last.x, q.y - last.y) <= Math.max(tol, BRANCH_TOL));
    if (!end) continue;
    const rev = pts.map((p) => ({ x: p.x, y: p.y })).reverse();
    rev[0] = { x: end.x, y: end.y };
    const revMarks = {};
    for (const [i, m] of Object.entries(marks)) revMarks[pts.length - 1 - Number(i)] = m;
    return { pts: rev, marks: revMarks, branch: { id: a.id, at: { x: end.x, y: end.y }, name: racewayName(a) } };
  }
  return { pts, marks, branch: run.branch };
}

function finish(ctx) {
  // Drop repeated points; their marks move to the point they repeat.
  const pts = [], marks = {};
  run.points.forEach((p, i) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
    if (run.marks[i]) marks[pts.length - 1] = run.marks[i];
  });
  if (pts.length >= 2) {
    const c = endConnection(pts, marks, 6 / (ctx.scale || 1));
    const ann = createRacewayAnnotation(c.pts, runRaceway(c.marks, c.branch), run.page);
    const doc = getActiveDocument();
    if (ann && doc) {
      doc.annotations.push(ann);
      ctx.recordAdd?.(ann);
    }
  }
  reset();
  ctx.redraw();
  import('../manager.js').then((m) => m.maybeRevertToSelect && m.maybeRevertToSelect());
}



export const racewayTool = {
  name: 'raceway',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    ensureRacewayBar();
    if (e.button === 2) {
      if (run.points.length >= 2) finish(ctx); else { reset(); ctx.redraw(); }
      return;
    }
    if (e.button !== 0 && e.button !== undefined) return;
    if (e.detail === 2) {
      if (run.points.length >= 2) finish(ctx);
      return;
    }
    if (run.points.length && run.page !== ctx.pageNum) return; // a run stays on its page
    if (!run.points.length) {
      run.page = ctx.pageNum;
      // Starting on a run of the same kind: a branch off it.
      const hit = branchStartAt(docRuns(ctx.pageNum), ctx.x, ctx.y, activeRaceway().kind, ctx.scale);
      if (hit) {
        run.branch = { id: hit.parent.id, at: { x: hit.x, y: hit.y }, name: racewayName(hit.parent) };
        run.points.push({ x: hit.x, y: hit.y });
        run.preview = null;
        show(labelText());
        paintSheet(ctx);
        return;
      }
    }
    const p = cursorPoint(ctx, e);
    const last = run.points[run.points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) return;
    run.points.push({ x: p.x, y: p.y });
    run.preview = null;
    show(labelText());
    paintSheet(ctx);
  },

  onPointerMove(ctx, e) {
    ensureRacewayBar();
    // Without a scale at the cursor a tray is drawn schematically and the
    // takeoff stays in page points: the bar says so and offers Set Scale.
    run.noScale = getMeasureScale(run.points.length ? run.page : ctx.pageNum, ctx.x, ctx.y)?.calibrated !== true;
    if (!run.points.length || run.page !== ctx.pageNum) {
      // Hovering a run of the same kind: show the branch snap on its centre line.
      // A run already started stays on its page; don't reuse that page's sheet here.
      if (run.points.length) {
        ctx.redraw();
        return;
      }
      const hit = branchStartAt(docRuns(ctx.pageNum), ctx.x, ctx.y, activeRaceway().kind, ctx.scale);
      clearRacewayGesture();
      const canvas = ctx.canvasCtx?.canvas;
      const key = canvas ? sheetKey(canvas) : '';
      const fresh = sheet && canvas && sheet.key === key && sheet.frame === annotationFrame();
      if (fresh) blitSheet(ctx);
      else if (canvas) {
        setRacewaySkipLive(true);
        try { ctx.redraw(); }
        finally { setRacewaySkipLive(false); }
        captureSheet(canvas, key);
      } else ctx.redraw();
      if (hit) {
        state.lastSnapResult = null;
        drawBranchHover(ctx, hit);
        show('', racewayName(hit.parent));
        return;
      }
      show('', null);
      const s = ctx.snap(ctx.x, ctx.y);
      if (s.snapped) ctx.drawSnapIndicator(s);
      return;
    }
    run.preview = cursorPoint(ctx, e);
    run.lastCtx = ctx;
    show(labelText());
    paintSheet(ctx);
    if (state.lastSnapResult) ctx.drawSnapIndicator(state.lastSnapResult);
  },

  onPointerUp() {
    return true;
  },

  onKeyDown(ctx, e) {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' && run.points.length >= 2) {
      e.preventDefault();
      finish({ ...ctx, recordAdd: (a) => import('../../core/undo-manager.js').then((m) => m.recordAdd(a)) });
    } else if (e.key === 'Backspace' && run.points.length) {
      e.preventDefault();
      run.points.pop();
      delete run.marks[run.points.length];
      if (!run.points.length) reset();
      show(labelText());
      paintSheet(ctx);
    }
  },

  onEscape(ctx) {
    if (run.points.length >= 2) {
      finish({ ...ctx, recordAdd: (a) => import('../../core/undo-manager.js').then((m) => m.recordAdd(a)) });
      return true;
    }
    const had = run.points.length > 0;
    reset();
    ctx.redraw?.();
    return had;
  },

  onDeactivate(ctx) {
    reset();
    ctx.redraw?.();
  },
};

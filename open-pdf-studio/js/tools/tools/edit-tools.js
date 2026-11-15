// Lasso (Shift+O) and Offset (O): the external editor Edit-menu tools of WP13
// (docs/reference/editor/markup-tools.md). The geometry is pure and tested in
// lasso-geometry.js / offset-geometry.js, the document side in
// edit-tools-core.js; this file is the pointer flow.

import { getActiveDocument } from '../../core/state.js';
import { findAnnotationsAt } from '../../annotations/geometry.js';
import { isLayerEditable } from '../../annotations/annotatie-lagen.js';
import { updateStatusMessage } from '../../ui/chrome/status-bar.js';
import i18next from '../../i18n/config.js';
import { addLassoPoint } from '../lasso-geometry.js';
import { offsetPathOf, offsetGeometry, offsetSide, offsetDistanceToPoints } from '../offset-geometry.js';
import { setEditToolOverlay, clearEditToolOverlay } from '../edit-tool-overlay.js';
import { lassoSelection, offsetScaleOf, createOffsetCopy } from '../edit-tools-core.js';

const tr = (key, opts) => i18next.t(`common:editTools.${key}`, opts);
const status = (key, opts) => { try { updateStatusMessage(tr(key, opts), 6000); } catch (_) { /* no status bar */ } };

function showSelection(ctx, doc) {
  const sel = doc.selectedAnnotations;
  doc.selectedAnnotation = sel.length > 0 ? sel[sel.length - 1] : null;
  if (sel.length === 1) ctx.showProperties?.(sel[0]);
  else if (sel.length > 1) ctx.showMultiSelectionProperties?.();
  else ctx.hideProperties?.();
}

// ── Lasso ──────────────────────────────────────────────────────────────────

let _lasso = null; // { page, points, touching, add }
let _lassoHinted = false;

function lassoOverlay() {
  if (!_lasso) { clearEditToolOverlay(); return; }
  setEditToolOverlay({ kind: 'lasso', page: _lasso.page, points: _lasso.points, closed: true, touching: _lasso.touching });
}

function finishLasso(ctx, e) {
  const lasso = _lasso;
  _lasso = null;
  clearEditToolOverlay();
  const doc = getActiveDocument();
  if (!lasso || !doc) { ctx.redraw?.(); return; }
  if (e) lasso.touching = !!(e.ctrlKey || e.metaKey) || lasso.touching;
  const picked = lasso.points.length >= 3
    ? lassoSelection(doc, lasso.page, lasso.points, { touching: lasso.touching, boundsOf: ctx.getAnnotationBounds })
    : [];
  if (lasso.add) {
    for (const a of picked) if (!doc.selectedAnnotations.includes(a)) doc.selectedAnnotations.push(a);
  } else {
    doc.selectedAnnotations = picked;
  }
  showSelection(ctx, doc);
  status('lasso.selected', { count: picked.length });
  ctx.redraw?.();
}

export const lassoTool = {
  name: 'lasso',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    _lasso = {
      page: ctx.pageNum,
      points: [{ x: ctx.x, y: ctx.y }],
      touching: !!(e.ctrlKey || e.metaKey),
      add: !!e.shiftKey,
    };
    lassoOverlay();
    ctx.redraw?.();
  },

  onPointerMove(ctx, e) {
    if (!_lasso) {
      if (!_lassoHinted) { _lassoHinted = true; status('lasso.hint'); }
      return;
    }
    if (e.buttons === 0) { finishLasso(ctx, e); return; }
    if (ctx.pageNum !== _lasso.page) return;
    _lasso.touching = !!(e.ctrlKey || e.metaKey);
    // Keep about one point per 2 screen pixels.
    addLassoPoint(_lasso.points, { x: ctx.x, y: ctx.y }, 2 / (ctx.scale || 1));
    lassoOverlay();
    ctx.redraw?.();
  },

  onPointerUp(ctx, e) {
    if (!_lasso) return false;
    if (ctx.pageNum === _lasso.page) addLassoPoint(_lasso.points, { x: ctx.x, y: ctx.y }, 1e-6);
    finishLasso(ctx, e);
    return true;
  },

  onEscape(ctx) {
    if (!_lasso) return false;
    _lasso = null;
    clearEditToolOverlay();
    ctx.redraw?.();
    return true;
  },

  onDeactivate(ctx) {
    _lasso = null;
    _lassoHinted = false;
    clearEditToolOverlay();
    ctx?.redraw?.();
  },
};

// ── Offset ─────────────────────────────────────────────────────────────────
//
// 1. Click a line, polyline, polygon, area or perimeter markup.
// 2. The Offset dialog asks the distance in the page's calibrated unit (or in
//    page points, labelled uncalibrated, on a page without a scale).
// 3. Move to the side the copy should go (preview), click: the copy lands.
// The tool then waits for the next markup and keeps the last distance.

const _offset = { phase: 'pick', source: null, distancePt: null, preview: null, hinted: false };
let _lastOffsetValue = null;

function resetOffset() {
  _offset.phase = 'pick';
  _offset.source = null;
  _offset.distancePt = null;
  _offset.preview = null;
  clearEditToolOverlay();
}

/** Offset dialog OK: `value` in the unit the dialog showed. */
export function confirmOffsetDistance(value) {
  const src = _offset.source;
  const pt = src ? offsetDistanceToPoints(value, offsetScaleOf(src)) : null;
  if (!pt) { resetOffset(); return false; }
  _lastOffsetValue = Number(value);
  _offset.distancePt = pt;
  _offset.phase = 'side';
  status('offset.side');
  return true;
}

export function cancelOffsetDistance() {
  resetOffset();
  status('offset.pick');
}

/** Last distance typed (for the dialog default), or null. */
export const lastOffsetValue = () => _lastOffsetValue;

function offsetPreview(ctx) {
  const src = _offset.source;
  const path = offsetPathOf(src);
  if (!path || ctx.pageNum !== src.page) return null;
  const side = offsetSide(path.points, { x: ctx.x, y: ctx.y }, path.closed);
  const geom = offsetGeometry(src, _offset.distancePt, side);
  if (!geom) return null;
  const points = geom.points || [{ x: geom.startX, y: geom.startY }, { x: geom.endX, y: geom.endY }];
  return { side, points, closed: path.closed && !path.repeatFirst };
}

export const offsetTool = {
  name: 'offset',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const doc = getActiveDocument();
    if (!doc) return;
    if (_offset.phase === 'side') {
      const preview = offsetPreview(ctx);
      if (!preview) return;
      const copy = createOffsetCopy(_offset.source, _offset.distancePt, preview.side, doc);
      resetOffset();
      if (copy) {
        doc.selectedAnnotations = [copy];
        showSelection(ctx, doc);
        status('offset.done');
      }
      ctx.redraw?.();
      return;
    }
    if (_offset.phase !== 'pick') return;
    const hits = findAnnotationsAt(ctx.x, ctx.y, ctx.pageNum);
    const src = hits.find((a) => offsetPathOf(a) && !a.locked && isLayerEditable(doc, a));
    if (!src) {
      status(hits.length ? 'offset.unsupported' : 'offset.pick');
      return;
    }
    _offset.source = src;
    _offset.phase = 'distance';
    doc.selectedAnnotations = [src];
    showSelection(ctx, doc);
    ctx.redraw?.();
    const scale = offsetScaleOf(src);
    import('../../solid/stores/dialogStore.js').then((m) => m.openDialog('offset', {
      unit: scale.unit, calibrated: scale.calibrated, value: _lastOffsetValue,
    }));
  },

  onPointerMove(ctx) {
    if (_offset.phase === 'pick' && !_offset.hinted) { _offset.hinted = true; status('offset.pick'); }
    if (_offset.phase !== 'side') return;
    const preview = offsetPreview(ctx);
    _offset.preview = preview;
    if (preview) setEditToolOverlay({ kind: 'offset', page: _offset.source.page, points: preview.points, closed: preview.closed });
    else clearEditToolOverlay();
    ctx.redraw?.();
  },

  onEscape(ctx) {
    if (_offset.phase === 'pick') return false;
    resetOffset();
    ctx.redraw?.();
    return true;
  },

  onDeactivate(ctx) {
    resetOffset();
    _offset.hinted = false;
    ctx?.redraw?.();
  },
};

import { state, getActiveDocument, clearSelection } from '../../core/state.js';
import { cloneAnnotation, createAnnotation } from '../../annotations/factory.js';
import { recordModify, recordAdd } from '../../core/undo-manager.js';
import { calculateArea, calculateDistance, formatMeasurement, formatDimensionText, arcControlPoint, expandArcPoints, refreshMeasureExtras } from '../../annotations/measurement.js';
import { applyToolTransform } from '../tool-context.js';
import { randkleurenUitVoorkeur } from '../../annotations/fill-utils.js';
import { zetRechtopRond } from '../../pdf/weergave-ruimte.js';
import { createMeasureAreaAnnotation, createMeasurePerimeterAnnotation } from '../annotation-creators.js';
import { dimensionOffset, orthoFromLast, shouldCommitMeasurementOnLeave } from '../measure-axis.js';
import {
  enterTypeLengthMode,
  exitTypeLengthMode,
  setTypeLengthStart,
  applyToEndpoint,
  typeLengthHasBuffer,
} from '../type-length-input.js';
import { setMeasureReadout, clearMeasureReadout } from '../measure-readout.js';
import { hergebruikKlikSnap, paintHoverSnap } from '../pointer-snap.js';
import { subtractAreaCutout, applyAreaCutout } from '../../annotations/area-cutout.js';
import { deleteAnnotationsWithUndo } from '../../annotations/mutations.js';
import { updateStatusMessage } from '../../ui/chrome/status-bar.js';

// Last cursor position for measurement tools — used when Enter commits at
// typed length so we know the direction.
const _measureCursor = { x: 0, y: 0 };

// Direction anchors frozen at the moment the user starts TYPING a length —
// keeps a Shift-straightened segment straight while typing digits (Shift
// can't stay held for numbers). Cleared when the buffer empties or the
// segment commits. One for the dimension click-2 flow, one for the
// area/perimeter multi-click flow.
const _dimDirLock = { x: null, y: null };
const _macDirLock = { x: null, y: null };
// Previous-frame preview point for the multi-click flow (the lock anchor —
// captured BEFORE the first typed character arrived).
const _macPrev = { x: 0, y: 0 };
// The same for the dimension click-2 flow: the snapped (Shift-straightened)
// preview point of the previous frame. The frame of the first typed key
// already runs without Shift, so its own cursor would lose the ortho
// direction.
const _dimPrev = { x: 0, y: 0 };

// Default hatch options for area measurement preview (red diagonal lines at 45°)
const DEFAULT_AREA_HATCH = { pattern: 'diagonal-left', color: '#ff0000', scale: 100, angle: 0 };

// Arc mode state for area measurement (press 'A' to toggle)
const arcState = { active: false, bulge: 0.3 };

// Shift locks the new vertex to the nearer axis through the last placed
// point. Object snap may keep a point that is already on that axis.
function _puntMetShift(last, x, y, snap, shiftKey) {
  if (!shiftKey || !last) return null;
  const punt = orthoFromLast(last, { x, y }, snap);
  const hieldSnap = !!(snap && snap.snapped
    && Math.abs(snap.x - punt.x) <= 1e-6
    && Math.abs(snap.y - punt.y) <= 1e-6);
  return { x: punt.x, y: punt.y, hieldSnap };
}

function _aanroep(ctx, naam, fallback) {
  const fn = ctx && ctx[naam];
  return typeof fn === 'function' ? fn : fallback;
}

function _recordAdd(ctx, ann) {
  _aanroep(ctx, 'recordAdd', recordAdd)(ann);
}

function _terugNaarSelect() {
  import('../../tools/manager.js').then(m => m.maybeRevertToSelect && m.maybeRevertToSelect());
}

// Last preview point picks the dimension side. A point still on the segment
// yields the positive perpendicular inside dimensionOffset.
function _dimensieCursor() {
  return { x: _dimPrev.x, y: _dimPrev.y };
}

/**
 * Measurement tools — measureDistance (3-click dimension), measureArea, measurePerimeter
 */
export const measureDistanceTool = {
  name: 'measureDistance',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    const { x, y, state, scale } = ctx;

    // Right-click cancels. Escape commits once two points are placed.
    if (e.button === 2) {
      _cancelDimensionDrawing(ctx);
      return;
    }

    const snap = hergebruikKlikSnap(ctx, x, y, state.dimPoints);
    const dimX = snap.snapped ? snap.x : x;
    const dimY = snap.snapped ? snap.y : y;

    if (state.dimPoints.length === 0) {
      // Click 1: first measurement point
      state.dimPoints.push({ x: dimX, y: dimY });
      state.isDrawingDimension = true;
      _dimPrev.x = dimX; _dimPrev.y = dimY;
      enterTypeLengthMode(dimX, dimY);
      state._typeLengthCommit = (length) => _commitMeasureDistanceClick2(ctx, e);
    } else if (state.dimPoints.length === 1) {
      // Click 2: second measurement point
      let pt2X = dimX, pt2Y = dimY;
      // Honor typed length if buffer active — along the LOCKED direction
      // (the preview already applied it into _measureCursor).
      if (typeLengthHasBuffer()) {
        const last = state.dimPoints[0];
        const dirX = _dimDirLock.x ?? _measureCursor.x;
        const dirY = _dimDirLock.y ?? _measureCursor.y;
        const ep = applyToEndpoint(last.x, last.y, dirX, dirY);
        pt2X = ep.x; pt2Y = ep.y;
        _dimDirLock.x = null; _dimDirLock.y = null;
        // Skip further snap-modifications
        state.dimPoints.push({ x: pt2X, y: pt2Y });
        exitTypeLengthMode();
        state._typeLengthCommit = null;
        return;
      }
      // Shift locks this leg horizontal or vertical, even when an object
      // snap is off that axis and angle snap is off.
      const as = _puntMetShift(state.dimPoints[0], x, y, snap, e.shiftKey);
      if (as) {
        pt2X = as.x;
        pt2Y = as.y;
        if (!as.hieldSnap) state.lastSnapResult = null;
      }
      const dx = pt2X - state.dimPoints[0].x;
      const dy = pt2Y - state.dimPoints[0].y;
      if (Math.sqrt(dx * dx + dy * dy) < 3 / scale) return;
      let finalPt = { x: pt2X, y: pt2Y };
      if (e.ctrlKey) finalPt = ctx.snapDistanceTo10(state.dimPoints[0].x, state.dimPoints[0].y, pt2X, pt2Y);
      state.dimPoints.push(finalPt);
    } else if (state.dimPoints.length === 2) {
      // Click 3: the cursor only picks the side. The offset distance is fixed.
      _commitMeasureDistance(ctx, { x: dimX, y: dimY }, { revert: true });
    }
  },

  onPointerMove(ctx, e) {
    const { x, y, state, canvasCtx, scale } = ctx;
    _measureCursor.x = x; _measureCursor.y = y;
    if (!state.isDrawingDimension || state.dimPoints.length === 0) {
      _drawHoverSnap(ctx, x, y);
      return;
    }

    const prefs = state.preferences;
    const dimColor = prefs.measureDistStrokeColor || '#FF0000';
    const snap = ctx.snap(x, y, null, state.dimPoints);
    let dimSnapX = snap.snapped ? snap.x : x;
    let dimSnapY = snap.snapped ? snap.y : y;
    state.lastSnapResult = snap.snapped ? snap : null;
    // Shift locks the rubber band to horizontal or vertical. An off-axis
    // object snap is ignored so the preview stays on the axis.
    const as = _puntMetShift(state.dimPoints[state.dimPoints.length - 1], x, y, snap, e.shiftKey);
    if (as) {
      dimSnapX = as.x;
      dimSnapY = as.y;
      if (!as.hieldSnap) state.lastSnapResult = null;
    }

    // Type-length for the click-2 preview, with DIRECTION LOCK: the first
    // buffered character freezes the current (possibly Shift-straightened)
    // direction; mouse movement no longer changes it while typing.
    if (typeLengthHasBuffer() && state.dimPoints.length === 1) {
      if (_dimDirLock.x == null) {
        _dimDirLock.x = _dimPrev.x;
        _dimDirLock.y = _dimPrev.y;
      }
      const last = state.dimPoints[0];
      const ep = applyToEndpoint(last.x, last.y, _dimDirLock.x, _dimDirLock.y);
      dimSnapX = ep.x; dimSnapY = ep.y;
      state.lastSnapResult = null;
    } else if (!typeLengthHasBuffer()) {
      _dimDirLock.x = null;
      _dimDirLock.y = null;
    }

    // Track the SNAPPED cursor (object/shift-angle/lock applied) as the
    // direction anchor for Enter-committed typed lengths.
    _measureCursor.x = dimSnapX;
    _measureCursor.y = dimSnapY;
    _dimPrev.x = dimSnapX;
    _dimPrev.y = dimSnapY;

    ctx.redraw();
    canvasCtx.save();
    applyToolTransform(canvasCtx);
    canvasCtx.strokeStyle = dimColor;
    canvasCtx.lineWidth = prefs.measureDistLineWidth || 1;
    canvasCtx.globalAlpha = (prefs.measureDistOpacity || 100) / 100;
    canvasCtx.setLineDash([]);

    const p1 = state.dimPoints[0];
    const sHead = prefs.measureDistStartHead || 'openCircle';
    const eHead = prefs.measureDistEndHead || 'openCircle';
    const hSize = prefs.measureDistHeadSize || 12;
    const fSize = prefs.measureDistFontSize || undefined;
    const dimExt = prefs.measureDistDimExtension !== false; // default ON
    function dimMeasureText(sx, sy, ex, ey) {
      const d = ctx.calculateDistance(sx, sy, ex, ey, getActiveDocument()?.currentPage);
      setMeasureReadout('length', d);
      return formatDimensionText(d);
    }

    if (state.dimPoints.length === 1) {
      if (e.ctrlKey) {
        const s = ctx.snapDistanceTo10(p1.x, p1.y, dimSnapX, dimSnapY);
        dimSnapX = s.x; dimSnapY = s.y;
      }
      ctx.drawDimension(canvasCtx, {
        startX: p1.x, startY: p1.y, endX: dimSnapX, endY: dimSnapY,
        startHead: sHead, endHead: eHead, headSize: hSize, fontSize: fSize,
        color: dimColor, measureText: dimMeasureText(p1.x, p1.y, dimSnapX, dimSnapY)
      });
    } else if (state.dimPoints.length === 2) {
      const p2 = state.dimPoints[1];
      // Same fixed-offset rule as the click-3 commit: cursor picks the side.
      const fixedOff = prefs.measureDistFixedOffset ?? 18;
      const line = dimensionOffset(p1, p2, { x: dimSnapX, y: dimSnapY }, fixedOff);
      ctx.drawDimension(canvasCtx, {
        startX: line.startX, startY: line.startY, endX: line.endX, endY: line.endY,
        leaderStartX: p1.x, leaderStartY: p1.y, leaderEndX: p2.x, leaderEndY: p2.y,
        startHead: sHead, endHead: eHead, headSize: hSize, fontSize: fSize,
        extension: dimExt,
        color: dimColor, measureText: dimMeasureText(line.startX, line.startY, line.endX, line.endY)
      });
    }

    canvasCtx.globalAlpha = 1;
    canvasCtx.restore();
    if (state.lastSnapResult) {
      ctx.drawSnapIndicator(state.lastSnapResult);
    }
  },

  // Escape: two placed points become the dimension (same fixed offset as
  // click 3). One point is still only a preview and is dropped. The
  // keyboard handler then switches to the select tool.
  onEscape(ctx) {
    if (shouldCommitMeasurementOnLeave('measureDistance', state.dimPoints?.length || 0)) {
      return _commitMeasureDistance(ctx, _dimensieCursor(), { revert: true });
    }
    return _cancelDimensionDrawing(ctx);
  },

  onDeactivate(ctx) {
    if (shouldCommitMeasurementOnLeave('measureDistance', state.dimPoints?.length || 0)) {
      _commitMeasureDistance(ctx, _dimensieCursor(), { revert: false });
    } else if (state.isDrawingDimension || (state.dimPoints && state.dimPoints.length > 0)) {
      _cancelDimensionDrawing(ctx);
    }
    exitTypeLengthMode();
    state._typeLengthCommit = null;
  },
};

// Right-click still drops the in-progress dimension. Escape only reaches
// this when fewer than two points are placed. Returns true if a preview
// was actually cleared.
function _cancelDimensionDrawing(ctx) {
  const { state } = ctx;
  const hadDrawing = state.isDrawingDimension || (state.dimPoints && state.dimPoints.length > 0);
  state.dimPoints = [];
  state.isDrawingDimension = false;
  _dimDirLock.x = null; _dimDirLock.y = null;
  clearMeasureReadout();
  ctx.redraw();
  return !!hadDrawing;
}

// Store the two-point dimension. `cursor` picks the side; the offset is the
// fixed drafting distance. Points are cleared first so a later deactivate
// cannot add the same dimension again.
function _commitMeasureDistance(ctx, cursor, opts) {
  const pts = state.dimPoints;
  if (!shouldCommitMeasurementOnLeave('measureDistance', pts ? pts.length : 0)) return false;
  const p1 = pts[0];
  const p2 = pts[1];
  const fixedOff = state.preferences?.measureDistFixedOffset ?? 18;
  const line = dimensionOffset(p1, p2, cursor, fixedOff);
  state.dimPoints = [];
  state.isDrawingDimension = false;
  _dimDirLock.x = null;
  _dimDirLock.y = null;
  exitTypeLengthMode();
  state._typeLengthCommit = null;

  const prefs = state.preferences || {};
  const currentPage = getActiveDocument()?.currentPage || 1;
  const dist = _aanroep(ctx, 'calculateDistance', calculateDistance)(
    line.startX, line.startY, line.endX, line.endY, currentPage);
  const dimUnit = dist.unit;
  const dimPrecision = (dimUnit === 'mm') ? 0
    : (prefs.measureDistDimPrecision != null ? prefs.measureDistDimPrecision : 2);
  const ann = _aanroep(ctx, 'createAnnotation', createAnnotation)({
    type: 'measureDistance',
    page: currentPage,
    startX: line.startX, startY: line.startY, endX: line.endX, endY: line.endY,
    leaderStartX: p1.x, leaderStartY: p1.y,
    leaderEndX: p2.x, leaderEndY: p2.y,
    startHead: prefs.measureDistStartHead || 'openCircle',
    endHead: prefs.measureDistEndHead || 'openCircle',
    headSize: prefs.measureDistHeadSize || 12,
    color: prefs.measureDistStrokeColor,
    strokeColor: prefs.measureDistStrokeColor,
    lineWidth: prefs.measureDistLineWidth,
    fontSize: prefs.measureDistFontSize || undefined,
    dimType: prefs.measureDistDimType || undefined,
    dimExtension: prefs.measureDistDimExtension !== false,
    opacity: (prefs.measureDistOpacity || 100) / 100,
    measureText: formatDimensionText(dist),
    measureValue: dist.value,
    measureUnit: dimUnit,
    measurePixels: dist.pixels,
    measurePrecision: dimPrecision,
  });
  const doc = state.documents[state.activeDocumentIndex];
  if (doc) doc.annotations.push(ann);
  _recordAdd(ctx, ann);
  clearMeasureReadout();
  if (typeof ctx.redraw === 'function') ctx.redraw();
  if (opts?.revert !== false) _terugNaarSelect();
  return true;
}

// Helper: Enter pressed in measureDistance with one point + buffered length.
function _commitMeasureDistanceClick2(ctx, e) {
  const { state } = ctx;
  if (!state.dimPoints || state.dimPoints.length !== 1) return;
  const last = state.dimPoints[0];
  const ep = applyToEndpoint(last.x, last.y, _measureCursor.x, _measureCursor.y);
  state.dimPoints.push({ x: ep.x, y: ep.y });
  _dimDirLock.x = null; _dimDirLock.y = null;
  exitTypeLengthMode();
  state._typeLengthCommit = null;
  ctx.redraw();
}

export const measureAreaTool = {
  name: 'measureArea',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    _measureMultiClickDown(ctx, e, 'measureArea');
  },

  onPointerMove(ctx, e) {
    _measureMultiClickMove(ctx, e, 'measureArea');
  },

  onKeyDown(ctx, e) {
    // Toggle arc mode with 'A' key during area drawing
    if ((e.key === 'a' || e.key === 'A') && state.measurePoints && state.measurePoints.length > 0) {
      e.preventDefault();
      arcState.active = !arcState.active;
      ctx.redraw();
    }
  },

  onWheel(ctx, e) {
    // Adjust arc bulge with mouse wheel while in arc mode
    if (arcState.active && state.measurePoints && state.measurePoints.length > 0) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      arcState.bulge = Math.max(-1, Math.min(1, arcState.bulge + delta));
      ctx.redraw();
    }
  },

  // Escape (GitHub #273): punten-tot-nu-toe committen met dezelfde
  // afrondroutines als rechtermuisklik (_finishMeasureWithHoles /
  // _finishMeasure); <3 punten → annuleren (dat doet _finishMeasure zelf).
  // De keyboard-handler schakelt daarna naar de selectietool.
  onEscape(ctx) {
    const { state } = ctx;
    arcState.active = false;
    if (state.measurePhase === 'holes' && state.measureOuterPoints) {
      _finishMeasureWithHoles(ctx);
      return true;
    }
    if (state.measurePoints && state.measurePoints.length > 0) {
      _finishMeasure(ctx, 'measureArea');
      return true;
    }
    return false;
  },

  onDeactivate(ctx) {
    arcState.active = false;
    arcState.bulge = 0.3;
    _leaveMeasure(ctx, 'measureArea');
  },
};

export const measurePerimeterTool = {
  name: 'measurePerimeter',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    _measureMultiClickDown(ctx, e, 'measurePerimeter');
  },

  onPointerMove(ctx, e) {
    _measureMultiClickMove(ctx, e, 'measurePerimeter');
  },

  // Escape (GitHub #273): zelfde afronding als rechtermuisklik — punten
  // committen (≥2) via _finishMeasure, anders annuleren. De keyboard-
  // handler schakelt daarna naar de selectietool.
  onEscape(ctx) {
    const { state } = ctx;
    if (state.measurePoints && state.measurePoints.length > 0) {
      _finishMeasure(ctx, 'measurePerimeter');
      return true;
    }
    return false;
  },

  onDeactivate(ctx) {
    _leaveMeasure(ctx, 'measurePerimeter');
  },
};

// Shared helpers for area/perimeter
function _measureMultiClickDown(ctx, e, toolType) {
  const { x, y, state } = ctx;
  const isArea = toolType === 'measureArea';

  // Right-click finishes
  if (e.button === 2) {
    if (state.measurePoints?.length || (isArea && state.measurePhase === 'holes' && state.measureOuterPoints)) {
      state._suppressNextContextmenu = true;
    }
    if (isArea && state.measurePhase === 'holes') {
      // In holes phase: right-click finalizes the entire annotation
      _finishMeasureWithHoles(ctx);
    } else if (isArea && state.measurePoints && state.measurePoints.length >= 3) {
      // In outer phase with enough points: close outer and enter holes phase
      _closeOuterAndEnterHolesPhase(ctx, state);
    } else {
      _finishMeasure(ctx, toolType);
    }
    return;
  }

  if (!state.measurePoints) state.measurePoints = [];

  // Object snap. The vertex just placed is not a target (pointer-snap.js).
  const allInProgressPoints = _getAllInProgressPoints(state, isArea);
  const snap = hergebruikKlikSnap(ctx, x, y, allInProgressPoints);
  let ptX = snap.snapped ? snap.x : x;
  let ptY = snap.snapped ? snap.y : y;

  // Shift locks the leg to the nearer axis FIRST, so a typed length below
  // follows that axis instead of the raw diagonal. An off-axis snap is dropped.
  if (e.shiftKey && state.measurePoints.length > 0) {
    const last = state.measurePoints[state.measurePoints.length - 1];
    const as = _puntMetShift(last, x, y, snap, true);
    if (as) {
      ptX = as.x;
      ptY = as.y;
      if (!as.hieldSnap) state.lastSnapResult = null;
    }
  }

  // Type-length lock: when buffer is non-empty and we have a previous point,
  // constrain this click to the typed length along the LOCKED direction
  // (frozen at first keystroke) or, without a lock, the direction above.
  if (typeLengthHasBuffer() && state.measurePoints.length > 0) {
    const last = state.measurePoints[state.measurePoints.length - 1];
    const dirX = _macDirLock.x ?? ptX;
    const dirY = _macDirLock.y ?? ptY;
    const ep = applyToEndpoint(last.x, last.y, dirX, dirY);
    ptX = ep.x; ptY = ep.y;
    _macDirLock.x = null; _macDirLock.y = null;
  }

  // Ctrl: snap distance to nearest N units
  if (e.ctrlKey && state.measurePoints.length > 0) {
    const last = state.measurePoints[state.measurePoints.length - 1];
    const s = ctx.snapDistanceTo10(last.x, last.y, ptX, ptY);
    ptX = s.x; ptY = s.y;
  }

  // Close polygon when clicking near the first point
  if (isArea && state.measurePoints.length >= 3) {
    const first = state.measurePoints[0];
    const dx = ptX - first.x, dy = ptY - first.y;
    if (Math.sqrt(dx * dx + dy * dy) < 10 / ctx.scale) {
      if (state.measurePhase === 'holes') {
        // Close the current hole
        _closeCurrentHole(ctx, state);
      } else {
        // Close outer boundary and enter holes phase
        _closeOuterAndEnterHolesPhase(ctx, state);
      }
      return;
    }
  }

  // Store arc data if arc mode is active (only for measureArea)
  if (isArea && arcState.active) {
    state.measurePoints.push({ x: ptX, y: ptY, arc: true, bulge: arcState.bulge });
    arcState.active = false; // reset arc mode after placing point
  } else {
    state.measurePoints.push({ x: ptX, y: ptY });
  }
  // Arm/refresh type-length anchor for next segment
  _macPrev.x = ptX; _macPrev.y = ptY;
  if (state.measurePoints.length === 1) {
    enterTypeLengthMode(ptX, ptY);
    state._typeLengthCommit = (length) => _commitMeasureSegmentByLength(ctx, toolType);
  } else {
    setTypeLengthStart(ptX, ptY);
  }
  ctx.redraw();

  // Draw in-progress measurement
  _drawMeasureInProgress(ctx, toolType);
}

function _closeOuterAndEnterHolesPhase(ctx, state) {
  state.measureOuterPoints = [...state.measurePoints];
  state.measurePhase = 'holes';
  state.measureHoles = [];
  state.measurePoints = [];
  ctx.redraw();
  _drawMeasureInProgress(ctx, 'measureArea');
}

function _closeCurrentHole(ctx, state) {
  if (state.measurePoints && state.measurePoints.length >= 3) {
    state.measureHoles = [...state.measureHoles, [...state.measurePoints]];
  }
  state.measurePoints = [];
  ctx.redraw();
  _drawMeasureInProgress(ctx, 'measureArea');
}

function _finishMeasureWithHoles(ctx, opts) {
  const { state } = ctx;
  const doc = state.documents[state.activeDocumentIndex];

  // If there's an incomplete hole with enough points, include it
  if (state.measurePoints && state.measurePoints.length >= 3) {
    state.measureHoles = [...state.measureHoles, [...state.measurePoints]];
  }

  const outerPoints = state.measureOuterPoints;
  const holes = state.measureHoles && state.measureHoles.length > 0 ? state.measureHoles : undefined;

  if (outerPoints && shouldCommitMeasurementOnLeave('measureArea', outerPoints.length)) {
    const ann = _aanroep(ctx, 'createMeasureAreaAnnotation', createMeasureAreaAnnotation)(outerPoints, holes);
    if (ann) { if (doc) doc.annotations.push(ann); _recordAdd(ctx, ann); }
  }

  // Reset all state
  state.measurePoints = null;
  state.measurePhase = 'outer';
  state.measureOuterPoints = null;
  state.measureHoles = [];
  exitTypeLengthMode();
  state._typeLengthCommit = null;
  clearMeasureReadout();
  ctx.redraw();

  if (opts?.revert !== false) _terugNaarSelect();
}

// Snap targets while an area or perimeter is open. The vertex just placed is
// last: the snap engine does not use that one as a point magnet, and
// perpendicular snap still starts there. Earlier vertices, the outer ring
// and finished holes stay, so the shape can still close on its first point.
function _getAllInProgressPoints(state, isArea) {
  const active = Array.isArray(state.measurePoints) ? state.measurePoints : [];
  const points = [];
  if (active.length > 1) points.push(...active.slice(0, -1));
  if (isArea && state.measurePhase === 'holes') {
    if (state.measureOuterPoints) points.push(...state.measureOuterPoints);
    for (const hole of (state.measureHoles || [])) points.push(...hole);
  }
  if (active.length) points.push(active[active.length - 1]);
  else if (points.length) points.push(points[points.length - 1]);
  return points;
}

function _measureMultiClickMove(ctx, e, toolType) {
  const { x, y, state, canvasCtx, scale } = ctx;
  _measureCursor.x = x; _measureCursor.y = y;
  const isArea = toolType === 'measureArea';
  const inHolesPhase = isArea && state.measurePhase === 'holes';

  // When in holes phase with no active hole points, still show the outer preview
  if (inHolesPhase && (!state.measurePoints || state.measurePoints.length === 0)) {
    ctx.redraw();
    _drawHolesPhasePreview(ctx, x, y);
    _drawHoverSnap(ctx, x, y);
    return;
  }

  if (!state.measurePoints || state.measurePoints.length === 0) {
    _drawHoverSnap(ctx, x, y);
    return;
  }

  const prefs = state.preferences;
  const mColor = isArea
    ? randkleurenUitVoorkeur(prefs, 'measureArea', 'measureArea', '#FF0000').color
    : (prefs.measurePerimStrokeColor || '#FF0000');
  const mBorderStyle = (isArea ? prefs.measureAreaBorderStyle : prefs.measurePerimBorderStyle) || 'solid';
  const mFillColor = isArea ? (prefs.measureAreaFillNone ? 'none' : (prefs.measureAreaFillColor || null)) : null;

  const allInProgressPoints = _getAllInProgressPoints(state, isArea);
  const snap = ctx.snap(x, y, null, allInProgressPoints);
  state.lastSnapResult = snap.snapped ? snap : null;

  let snapX = snap.snapped ? snap.x : x;
  let snapY = snap.snapped ? snap.y : y;
  let nearFirst = false;

  // Snap to first point when near (close shape hint) for measureArea
  if (isArea && state.measurePoints.length >= 3) {
    const first = state.measurePoints[0];
    const dx = snapX - first.x, dy = snapY - first.y;
    if (Math.sqrt(dx * dx + dy * dy) < 10 / scale) {
      snapX = first.x; snapY = first.y;
      nearFirst = true;
    }
  }

  // Shift locks the rubber band to the nearer axis, even when object snap
  // hit something off that axis. Closing on the first point still wins.
  if (!nearFirst && e.shiftKey) {
    const last = state.measurePoints[state.measurePoints.length - 1];
    const as = _puntMetShift(last, x, y, snap, true);
    if (as) {
      snapX = as.x;
      snapY = as.y;
      if (!as.hieldSnap) state.lastSnapResult = null;
    }
  }

  // Type-length lock for preview — DIRECTION LOCKED: the first buffered
  // character freezes the previous-frame (possibly ortho'd) direction so the
  // segment stays straight while typing, wherever the mouse goes.
  if (!nearFirst && typeLengthHasBuffer() && state.measurePoints.length > 0) {
    if (_macDirLock.x == null) {
      _macDirLock.x = _macPrev.x;
      _macDirLock.y = _macPrev.y;
    }
    const last = state.measurePoints[state.measurePoints.length - 1];
    const ep = applyToEndpoint(last.x, last.y, _macDirLock.x, _macDirLock.y);
    snapX = ep.x; snapY = ep.y;
    state.lastSnapResult = null;
  } else if (!typeLengthHasBuffer()) {
    _macDirLock.x = null;
    _macDirLock.y = null;
  }

  if (!nearFirst && e.ctrlKey) {
    const last = state.measurePoints[state.measurePoints.length - 1];
    const s = ctx.snapDistanceTo10(last.x, last.y, snapX, snapY);
    snapX = s.x; snapY = s.y;
  }

  // The Enter-commit helper places the next vertex along this preview point —
  // keep it in sync with everything applied above (snap, ortho, ctrl, lock).
  _measureCursor.x = snapX;
  _measureCursor.y = snapY;
  _macPrev.x = snapX;
  _macPrev.y = snapY;

  ctx.redraw();
  canvasCtx.save();
  applyToolTransform(canvasCtx);
  canvasCtx.strokeStyle = mColor;
  canvasCtx.lineWidth = (isArea ? prefs.measureAreaLineWidth : prefs.measurePerimLineWidth) || 1;
  canvasCtx.globalAlpha = ((isArea ? prefs.measureAreaOpacity : prefs.measurePerimOpacity) || 100) / 100;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  if (inHolesPhase) {
    // Draw outer polygon + completed holes + in-progress hole
    const outerPoints = state.measureOuterPoints || [];
    const completedHoles = state.measureHoles || [];
    const activeHolePreview = [...state.measurePoints, { x: snapX, y: snapY }];
    const allHoles = activeHolePreview.length >= 3
      ? [...completedHoles, activeHolePreview]
      : completedHoles;

    if (outerPoints.length > 2) {
      ctx.drawMeasureAreaShape(canvasCtx, outerPoints, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, allHoles, DEFAULT_AREA_HATCH);
    }

    // Draw active hole polyline when < 3 points
    if (activeHolePreview.length < 3 && activeHolePreview.length >= 2) {
      canvasCtx.setLineDash([2, 4]);
      canvasCtx.beginPath();
      canvasCtx.moveTo(activeHolePreview[0].x, activeHolePreview[0].y);
      for (let i = 1; i < activeHolePreview.length; i++) {
        canvasCtx.lineTo(activeHolePreview[i].x, activeHolePreview[i].y);
      }
      canvasCtx.stroke();
      canvasCtx.setLineDash([]);
    }

    // Live area text (outer - holes)
    if (outerPoints.length >= 3) {
      const currentPage = getActiveDocument()?.currentPage || 1;
      const area = ctx.calculateArea(outerPoints, allHoles.length > 0 ? allHoles : undefined, currentPage);
      setMeasureReadout('area', area);
      ctx.drawCentroidLabel(canvasCtx, outerPoints, ctx.formatMeasurement(area), mColor);
    }
  } else {
    // Normal outer drawing
    // If arc mode is active, tag the preview point with arc data
    const previewPt = arcState.active && isArea
      ? { x: snapX, y: snapY, arc: true, bulge: arcState.bulge }
      : { x: snapX, y: snapY };
    const previewPoints = [...state.measurePoints, previewPt];

    if (isArea && previewPoints.length > 2) {
      ctx.drawMeasureAreaShape(canvasCtx, previewPoints, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, undefined, DEFAULT_AREA_HATCH);
    } else {
      ctx.drawMeasurePerimeterShape(canvasCtx, previewPoints, mColor, mBorderStyle);
    }

    // Arc mode indicator near cursor
    if (arcState.active && isArea) {
      canvasCtx.save();
      // Rechtop op het scherm, ook in een gedraaide weergave (#200).
      zetRechtopRond(canvasCtx, snapX, snapY);
      canvasCtx.font = '10px Arial';
      canvasCtx.fillStyle = mColor;
      canvasCtx.globalAlpha = 0.7;
      canvasCtx.fillText(`Arc (bulge: ${arcState.bulge.toFixed(2)})`, snapX + 12, snapY - 8);
      canvasCtx.restore();
      canvasCtx.globalAlpha = ((isArea ? prefs.measureAreaOpacity : prefs.measurePerimOpacity) || 100) / 100;
    }

    // Live measurement text
    const currentPage = getActiveDocument()?.currentPage || 1;
    if (isArea && previewPoints.length >= 3) {
      const expandedPoints = expandArcPoints(previewPoints);
      const area = ctx.calculateArea(expandedPoints, undefined, currentPage);
      setMeasureReadout('area', area);
      ctx.drawCentroidLabel(canvasCtx, previewPoints, ctx.formatMeasurement(area), mColor);
    } else if (isArea) {
      // Two points of an area so far: the status bar shows the edge length.
      setMeasureReadout('length', ctx.calculatePerimeter(previewPoints, currentPage));
    } else if (!isArea && previewPoints.length >= 2) {
      const perim = ctx.calculatePerimeter(previewPoints, currentPage);
      setMeasureReadout('length', perim);
      canvasCtx.save();
      // Rechtop op het scherm, ook in een gedraaide weergave (#200).
      zetRechtopRond(canvasCtx, snapX, snapY);
      canvasCtx.font = '11px Arial';
      canvasCtx.fillStyle = mColor;
      canvasCtx.fillText(ctx.formatMeasurement(perim), snapX + 8, snapY - 4);
      canvasCtx.restore();
    }
  }

  // Close indicator at first point
  if (nearFirst) {
    const first = state.measurePoints[0];
    canvasCtx.beginPath();
    canvasCtx.arc(first.x, first.y, 5 / scale, 0, Math.PI * 2);
    canvasCtx.fillStyle = mColor;
    canvasCtx.globalAlpha = 0.3;
    canvasCtx.fill();
    canvasCtx.globalAlpha = 1;
  }

  canvasCtx.globalAlpha = 1;
  canvasCtx.restore();
  if (state.lastSnapResult && !nearFirst) {
    ctx.drawSnapIndicator(state.lastSnapResult);
  }
}

// Draw preview of outer polygon with completed holes while idle in holes phase
function _drawHolesPhasePreview(ctx, cursorX, cursorY) {
  const { state, canvasCtx, scale } = ctx;
  const prefs = state.preferences;
  const mColor = randkleurenUitVoorkeur(prefs, 'measureArea', 'measureArea', '#FF0000').color;
  const mBorderStyle = prefs.measureAreaBorderStyle || 'solid';
  const mFillColor = prefs.measureAreaFillNone ? 'none' : (prefs.measureAreaFillColor || null);
  const outerPoints = state.measureOuterPoints || [];
  const completedHoles = state.measureHoles || [];

  if (outerPoints.length < 3) return;

  canvasCtx.save();
  applyToolTransform(canvasCtx);
  canvasCtx.strokeStyle = mColor;
  canvasCtx.lineWidth = prefs.measureAreaLineWidth || 1;
  canvasCtx.globalAlpha = (prefs.measureAreaOpacity || 100) / 100;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  ctx.drawMeasureAreaShape(canvasCtx, outerPoints, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, completedHoles.length > 0 ? completedHoles : undefined, DEFAULT_AREA_HATCH);

  // Show area text
  const currentPage = getActiveDocument()?.currentPage || 1;
  const area = ctx.calculateArea(outerPoints, completedHoles.length > 0 ? completedHoles : undefined, currentPage);
  ctx.drawCentroidLabel(canvasCtx, outerPoints, ctx.formatMeasurement(area), mColor);

  // Draw hint text near cursor (rechtop op het scherm, ook gedraaid, #200)
  canvasCtx.save();
  zetRechtopRond(canvasCtx, cursorX / scale, cursorY / scale);
  canvasCtx.font = '10px Arial';
  canvasCtx.fillStyle = mColor;
  canvasCtx.globalAlpha = 0.7;
  canvasCtx.fillText('Click to add hole, right-click to finish', cursorX / scale + 12, cursorY / scale - 4);
  canvasCtx.restore();

  canvasCtx.globalAlpha = 1;
  canvasCtx.restore();
}

function _finishMeasure(ctx, toolType, opts) {
  const { state } = ctx;
  if (!state.measurePoints) return;
  const points = [...state.measurePoints];
  const doc = state.documents[state.activeDocumentIndex];

  if (toolType === 'measureArea' && shouldCommitMeasurementOnLeave('measureArea', points.length)) {
    const ann = _aanroep(ctx, 'createMeasureAreaAnnotation', createMeasureAreaAnnotation)(points);
    if (ann) { if (doc) doc.annotations.push(ann); _recordAdd(ctx, ann); }
  } else if (toolType === 'measurePerimeter' && shouldCommitMeasurementOnLeave('measurePerimeter', points.length)) {
    const ann = _aanroep(ctx, 'createMeasurePerimeterAnnotation', createMeasurePerimeterAnnotation)(points);
    if (ann) { if (doc) doc.annotations.push(ann); _recordAdd(ctx, ann); }
  }
  state.measurePoints = null;
  state.measurePhase = 'outer';
  state.measureOuterPoints = null;
  state.measureHoles = [];
  exitTypeLengthMode();
  state._typeLengthCommit = null;
  clearMeasureReadout();
  ctx.redraw();

  if (opts?.revert !== false) _terugNaarSelect();
}

// Switching tools finishes a shape the same way Escape does. An incomplete
// shape still cancels. revert stays off: the user already picked the next tool.
function _leaveMeasure(ctx, toolType) {
  const holes = toolType === 'measureArea'
    && state.measurePhase === 'holes'
    && state.measureOuterPoints
    && shouldCommitMeasurementOnLeave('measureArea', state.measureOuterPoints.length);
  if (holes) _finishMeasureWithHoles(ctx, { revert: false });
  else if (state.measurePoints && state.measurePoints.length > 0) _finishMeasure(ctx, toolType, { revert: false });
  else _measureDeactivate(ctx);
  _macDirLock.x = null;
  _macDirLock.y = null;
  _dimDirLock.x = null;
  _dimDirLock.y = null;
  exitTypeLengthMode();
  state._typeLengthCommit = null;
}

function _measureDeactivate(ctx) {
  const { state } = ctx;
  if (state.measurePoints || state.measureOuterPoints) {
    state.measurePoints = null;
    state.measurePhase = 'outer';
    state.measureOuterPoints = null;
    state.measureHoles = [];
    ctx.redraw();
  }
  _macDirLock.x = null; _macDirLock.y = null;
  _dimDirLock.x = null; _dimDirLock.y = null;
  exitTypeLengthMode();
  state._typeLengthCommit = null;
}

// Helper: Enter pressed during measureArea/measurePerimeter — append the
// next vertex at the typed length in the current cursor direction.
function _commitMeasureSegmentByLength(ctx, toolType) {
  const { state } = ctx;
  if (!state.measurePoints || state.measurePoints.length === 0) return;
  const last = state.measurePoints[state.measurePoints.length - 1];
  const ep = applyToEndpoint(last.x, last.y, _measureCursor.x, _measureCursor.y);
  state.measurePoints.push({ x: ep.x, y: ep.y });
  _macDirLock.x = null; _macDirLock.y = null;
  setTypeLengthStart(ep.x, ep.y);
  ctx.redraw();
}

function _drawMeasureInProgress(ctx, toolType) {
  const { state, canvasCtx, scale } = ctx;
  const prefs = state.preferences;
  const isArea = toolType === 'measureArea';
  const mColor = isArea
    ? randkleurenUitVoorkeur(prefs, 'measureArea', 'measureArea', '#FF0000').color
    : (prefs.measurePerimStrokeColor || '#FF0000');
  const mBorderStyle = (isArea ? prefs.measureAreaBorderStyle : prefs.measurePerimBorderStyle) || 'solid';
  const mFillColor = isArea ? (prefs.measureAreaFillNone ? 'none' : (prefs.measureAreaFillColor || null)) : null;

  canvasCtx.save();
  applyToolTransform(canvasCtx);
  canvasCtx.strokeStyle = mColor;
  canvasCtx.lineWidth = (isArea ? prefs.measureAreaLineWidth : prefs.measurePerimLineWidth) || 1;
  canvasCtx.globalAlpha = ((isArea ? prefs.measureAreaOpacity : prefs.measurePerimOpacity) || 100) / 100;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  if (isArea && state.measurePhase === 'holes') {
    // In holes phase: draw outer + completed holes
    const outerPoints = state.measureOuterPoints || [];
    const completedHoles = state.measureHoles || [];
    if (outerPoints.length > 2) {
      ctx.drawMeasureAreaShape(canvasCtx, outerPoints, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, completedHoles.length > 0 ? completedHoles : undefined, DEFAULT_AREA_HATCH);
    }
  } else if (isArea && state.measurePoints && state.measurePoints.length > 2) {
    ctx.drawMeasureAreaShape(canvasCtx, state.measurePoints, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, undefined, DEFAULT_AREA_HATCH);
  } else if (state.measurePoints && state.measurePoints.length > 0) {
    ctx.drawMeasurePerimeterShape(canvasCtx, state.measurePoints, mColor, mBorderStyle);
  }

  canvasCtx.globalAlpha = 1;
  canvasCtx.restore();
}

function _drawHoverSnap(ctx, x, y) {
  // Not placing points: no live value in the status bar.
  clearMeasureReadout();
  paintHoverSnap(ctx, x, y);
}

// Export arc state for keyboard/wheel handler access from tool-dispatcher
export { arcState };

// ─── Add Hole to existing measureArea annotation ───

/**
 * addHoleTool — activated from the context menu on a measureArea annotation.
 * Draws a polygon that gets added as a hole to the target annotation.
 * Right-click or clicking near the first point closes the hole.
 */
// Arc-mode toggle for the addHole flow ('A' toggles, mouse wheel adjusts bulge).
const addHoleArcState = { active: false, bulge: 0.3 };

export const addHoleTool = {
  name: 'addHole',
  cursor: 'crosshair',

  onKeyDown(ctx, e) {
    if ((e.key === 'a' || e.key === 'A')) {
      const pts = state.addHolePoints || [];
      if (pts.length > 0) {
        e.preventDefault();
        addHoleArcState.active = !addHoleArcState.active;
        ctx.redraw();
      }
    }
    // Escape loopt via onEscape (keyboard-handlers) — zelfde afronding als
    // rechtermuisklik (GitHub #273).
  },

  // Escape (GitHub #273): zelfde afronding als rechtermuisklik — het gat
  // committen (≥3 punten) via _finishAddHole, anders alleen de modus
  // verlaten. De keyboard-handler schakelt daarna naar de selectietool.
  onEscape(ctx) {
    if (!state.addHoleTargetId) return false;
    addHoleArcState.active = false;
    addHoleArcState.bulge = 0.3;
    _finishAddHole(ctx);
    return true;
  },

  onWheel(ctx, e) {
    if (addHoleArcState.active) {
      const pts = state.addHolePoints || [];
      if (pts.length > 0) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        addHoleArcState.bulge = Math.max(-1, Math.min(1, addHoleArcState.bulge + delta));
        ctx.redraw();
      }
    }
  },

  onPointerDown(ctx, e) {
    const { x, y, scale } = ctx;
    const targetId = state.addHoleTargetId;
    if (!targetId) return;

    // Right-click finishes
    if (e.button === 2) {
      _finishAddHole(ctx);
      return;
    }

    const pts = state.addHolePoints || [];

    // Snap
    const snap = ctx.snap(x, y, targetId, pts);
    let ptX = snap.snapped ? snap.x : x;
    let ptY = snap.snapped ? snap.y : y;

    // Shift locks the hole edge to the nearer axis, even if snap is off-axis.
    if (e.shiftKey && pts.length > 0) {
      const as = _puntMetShift(pts[pts.length - 1], x, y, snap, true);
      if (as) {
        ptX = as.x;
        ptY = as.y;
        if (!as.hieldSnap) state.lastSnapResult = null;
      }
    }

    // Close polygon when clicking near first point
    if (pts.length >= 3) {
      const first = pts[0];
      const dx = ptX - first.x, dy = ptY - first.y;
      if (Math.sqrt(dx * dx + dy * dy) < 10 / scale) {
        _finishAddHole(ctx);
        return;
      }
    }

    const newPt = addHoleArcState.active
      ? { x: ptX, y: ptY, arc: true, bulge: addHoleArcState.bulge }
      : { x: ptX, y: ptY };
    if (addHoleArcState.active) addHoleArcState.active = false; // reset after placing
    state.addHolePoints = [...pts, newPt];
    ctx.redraw();
    _drawAddHoleInProgress(ctx);
  },

  onPointerMove(ctx, e) {
    const { x, y, canvasCtx, scale } = ctx;
    const targetId = state.addHoleTargetId;
    if (!targetId) return;

    const pts = state.addHolePoints || [];
    if (pts.length === 0) {
      _drawAddHolePreview(ctx, x, y);
      _drawHoverSnap(ctx, x, y);
      return;
    }

    const snap = ctx.snap(x, y, targetId, pts);
    let snapX = snap.snapped ? snap.x : x;
    let snapY = snap.snapped ? snap.y : y;
    state.lastSnapResult = snap.snapped ? snap : null;

    let nearFirst = false;
    if (pts.length >= 3) {
      const first = pts[0];
      const dx = snapX - first.x, dy = snapY - first.y;
      if (Math.sqrt(dx * dx + dy * dy) < 10 / scale) {
        snapX = first.x; snapY = first.y;
        nearFirst = true;
      }
    }

    if (!nearFirst && e.shiftKey) {
      const as = _puntMetShift(pts[pts.length - 1], x, y, snap, true);
      if (as) {
        snapX = as.x;
        snapY = as.y;
        if (!as.hieldSnap) state.lastSnapResult = null;
      }
    }

    ctx.redraw();

    // Find target annotation for rendering context
    const doc = getActiveDocument();
    const ann = doc?.annotations.find(a => a.id === targetId);
    if (!ann) return;

    const mColor = ann.strokeColor || ann.color || '#FF0000';
    const mFillColor = ann.fillColor || null;
    const mBorderStyle = ann.borderStyle || 'dashed';

    canvasCtx.save();
    applyToolTransform(canvasCtx);
    canvasCtx.strokeStyle = mColor;
    canvasCtx.lineWidth = ann.lineWidth || 1;
    canvasCtx.globalAlpha = ann.opacity != null ? ann.opacity : 1;
    canvasCtx.lineCap = 'round';
    canvasCtx.lineJoin = 'round';

    // Build preview holes: existing holes + in-progress hole (arc-aware)
    const existingHoles = ann.holes || [];
    const previewPt = addHoleArcState.active
      ? { x: snapX, y: snapY, arc: true, bulge: addHoleArcState.bulge }
      : { x: snapX, y: snapY };
    const previewHole = [...pts, previewPt];
    const allHoles = previewHole.length >= 3
      ? [...existingHoles, previewHole]
      : existingHoles;

    // Draw the full annotation with preview hole
    if (ann.points && ann.points.length > 2) {
      ctx.drawMeasureAreaShape(canvasCtx, ann.points, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, allHoles.length > 0 ? allHoles : undefined, DEFAULT_AREA_HATCH);
    }

    // Draw in-progress hole polyline when < 3 points
    if (previewHole.length < 3 && previewHole.length >= 2) {
      canvasCtx.setLineDash([2, 4]);
      canvasCtx.beginPath();
      canvasCtx.moveTo(previewHole[0].x, previewHole[0].y);
      for (let i = 1; i < previewHole.length; i++) {
        canvasCtx.lineTo(previewHole[i].x, previewHole[i].y);
      }
      canvasCtx.stroke();
      canvasCtx.setLineDash([]);
    }

    // Live area text (measureArea only)
    if (ann.type === 'measureArea' && ann.points && ann.points.length >= 3) {
      const area = ctx.calculateArea(ann.points, allHoles.length > 0 ? allHoles : undefined, ann.page || 1);
      ctx.drawCentroidLabel(canvasCtx, ann.points, ctx.formatMeasurement(area), mColor);
    }

    // Arc-mode hint near cursor
    if (addHoleArcState.active) {
      canvasCtx.save();
      // Rechtop op het scherm, ook in een gedraaide weergave (#200).
      zetRechtopRond(canvasCtx, snapX, snapY);
      canvasCtx.font = '10px Arial';
      canvasCtx.fillStyle = mColor;
      canvasCtx.globalAlpha = 0.7;
      canvasCtx.fillText(`Arc (bulge: ${addHoleArcState.bulge.toFixed(2)})`, snapX + 12 / scale, snapY - 8 / scale);
      canvasCtx.restore();
      canvasCtx.globalAlpha = 1;
    }

    // Close indicator at first point
    if (nearFirst) {
      const first = pts[0];
      canvasCtx.beginPath();
      canvasCtx.arc(first.x, first.y, 5 / scale, 0, Math.PI * 2);
      canvasCtx.fillStyle = mColor;
      canvasCtx.globalAlpha = 0.3;
      canvasCtx.fill();
      canvasCtx.globalAlpha = 1;
    }

    canvasCtx.globalAlpha = 1;
    canvasCtx.restore();

    if (state.lastSnapResult && !nearFirst) {
      ctx.drawSnapIndicator(state.lastSnapResult);
    }
  },

  onDeactivate(ctx) {
    addHoleArcState.active = false;
    addHoleArcState.bulge = 0.3;
    state.addHoleTargetId = null;
    state.addHolePoints = [];
    ctx.redraw();
  },
};

function _finishAddHole(ctx) {
  const pts = state.addHolePoints || [];
  const targetId = state.addHoleTargetId;
  const doc = getActiveDocument();

  if (pts.length >= 3 && targetId && doc) {
    const ann = doc.annotations.find(a => a.id === targetId);
    if (ann) {
      try {
        const result = subtractAreaCutout(ann.points, ann.holes, pts);
        if (result?.empty) {
          deleteAnnotationsWithUndo(doc, [ann]);
          clearSelection();
          ctx.hideProperties();
        } else if (result) {
          const oldAnn = cloneAnnotation(ann);
          applyAreaCutout(ann, result);
          if (ann.type === 'measureArea') _recalcMeasureAreaText(ann, ctx);
          ann.modifiedAt = new Date().toISOString();
          recordModify(ann.id, oldAnn, ann);
          void import('../../annotations/geos-area.js').then((mod) => mod.scheduleAreaRefine(ann));
        }
      } catch (error) {
        console.error('Area cutout failed:', error);
        updateStatusMessage('Could not subtract this hole. The area was kept unchanged.');
      }
    }
  }

  // Reset state and switch back to select tool
  state.addHoleTargetId = null;
  state.addHolePoints = [];
  ctx.redraw();

  // Switch back to select tool
  import("../../tools/manager.js").then(m => m.maybeRevertToSelect && m.maybeRevertToSelect());
}

function _recalcMeasureAreaText(ann, ctx) {
  if (!ann.points || ann.points.length < 3) return;

  // Always use calculateArea (resolves scale from scaleBar / document / prefs)
  // + formatMeasurement (auto-converts mm² → m²)
  const area = calculateArea(ann.points, ann.holes, ann.page || 1);
  ann.measureText = formatMeasurement(area);
  ann.measureValue = area.value;
  ann.measureUnit = area.unit;
  refreshMeasureExtras(ann);
}

function _drawAddHolePreview(ctx, cursorX, cursorY) {
  const { canvasCtx, scale } = ctx;
  const targetId = state.addHoleTargetId;
  const doc = getActiveDocument();
  const ann = doc?.annotations.find(a => a.id === targetId);
  if (!ann || !ann.points || ann.points.length < 3) return;

  const mColor = ann.strokeColor || ann.color || '#FF0000';
  const mFillColor = ann.fillColor || null;
  const mBorderStyle = ann.borderStyle || 'dashed';

  canvasCtx.save();
  applyToolTransform(canvasCtx);
  canvasCtx.strokeStyle = mColor;
  canvasCtx.lineWidth = ann.lineWidth || 1;
  canvasCtx.globalAlpha = ann.opacity != null ? ann.opacity : 1;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  ctx.drawMeasureAreaShape(canvasCtx, ann.points, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, ann.holes && ann.holes.length > 0 ? ann.holes : undefined, DEFAULT_AREA_HATCH);

  // Show area text (measureArea only)
  if (ann.type === 'measureArea') {
    const area = ctx.calculateArea(ann.points, ann.holes, ann.page || 1);
    ctx.drawCentroidLabel(canvasCtx, ann.points, ctx.formatMeasurement(area), mColor);
  }

  // Draw hint text near cursor (rechtop op het scherm, ook gedraaid, #200)
  canvasCtx.save();
  zetRechtopRond(canvasCtx, cursorX, cursorY);
  canvasCtx.font = '10px Arial';
  canvasCtx.fillStyle = mColor;
  canvasCtx.globalAlpha = 0.7;
  canvasCtx.fillText('Click to draw hole, right-click to cancel', cursorX + 12 / scale, cursorY - 4 / scale);
  canvasCtx.restore();

  canvasCtx.globalAlpha = 1;
  canvasCtx.restore();
}

function _drawAddHoleInProgress(ctx) {
  const { canvasCtx, scale } = ctx;
  const targetId = state.addHoleTargetId;
  const doc = getActiveDocument();
  const ann = doc?.annotations.find(a => a.id === targetId);
  if (!ann || !ann.points || ann.points.length < 3) return;

  const mColor = ann.strokeColor || ann.color || '#FF0000';
  const mFillColor = ann.fillColor || null;
  const mBorderStyle = ann.borderStyle || 'dashed';
  const pts = state.addHolePoints || [];
  const existingHoles = ann.holes || [];
  const allHoles = pts.length >= 3 ? [...existingHoles, pts] : existingHoles;

  canvasCtx.save();
  applyToolTransform(canvasCtx);
  canvasCtx.strokeStyle = mColor;
  canvasCtx.lineWidth = ann.lineWidth || 1;
  canvasCtx.globalAlpha = ann.opacity != null ? ann.opacity : 1;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  ctx.drawMeasureAreaShape(canvasCtx, ann.points, mColor, canvasCtx.lineWidth, mFillColor, mBorderStyle, allHoles.length > 0 ? allHoles : undefined, DEFAULT_AREA_HATCH);

  canvasCtx.globalAlpha = 1;
  canvasCtx.restore();
}

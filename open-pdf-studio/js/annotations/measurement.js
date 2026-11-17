import { batch } from 'solid-js';
import { $RAW } from 'solid-js/store';
import { state, getActiveDocument } from '../core/state.js';
import { openDialog } from '../solid/stores/dialogStore.js';
import { redrawAnnotations, redrawContinuous } from './rendering.js';
import { getScaleForPoint } from './scale-bar.js';
import { getScaleFromRegion, getScaleFromRegionIn } from './scale-region.js';
import { schaalBronnen, metSchaalBronnen } from './schaal-bronnen.js';
import { geldigeDocumentSchaal, geldigeSchaal, paginaSchaal, paginaOfDocumentSchaal, paginaGewist, schaalOpPunt } from './schaal-op-punt.js';
import { paginasVoorSchaal, metPaginaSchaal, migreerLegacySchaal, leesLegacySchaal, legacySchaalSleutel } from './pagina-schaal.js';
import { cloneAnnotation } from './factory.js';
import { displayDenominator, displayText, formatLengthWithPrecision, implicitPrecision, otherSystemText, roundingStepIn, roundToPreferenceStep } from './measure-precision.js';
import { nettoVlakOppervlak } from './vlak-ringen.js';
import { computeMeasureExtras, hasMeasureExtras, MEASURE_EXTRA_OUTPUTS } from './measure-extras.js';
import { herrekenExtMaat } from './ext-measure.js';
import {
  recordBulkModify,
  recordPageScales,
  beginUndoTransaction,
  endUndoTransaction,
} from '../core/undo-manager.js';

// Scale calibration: pixels per unit
// Priority: scaleRegion (innermost containing point) → viewport annotation →
//          scaleBar on the page → PDF viewport (/VP + /Measure in the file
//          itself, #400) → page scale (doc.pageScales, else a full-page /VP)
//          → per-document scale (legacy localStorage / MCP) → scaleBar
//          elsewhere → legacy global → uncalibrated PDF page points
// The point-bound part of that order lives in schaal-op-punt.js (via
// getScaleForPoint), shared with the light scale bridges.
export function getMeasureScale(pageNum, x, y) {
  // 1. Check scaleRegion (innermost) — highest priority when a point is given
  if (pageNum != null && x != null && y != null) {
    const regionScale = getScaleFromRegion(pageNum, x, y);
    if (regionScale) return { ...regionScale, calibrated: true };
    const sbScale = getScaleForPoint(pageNum, x, y);
    if (sbScale) return { ...sbScale, calibrated: true };
  } else {
    // No point specified — check if any scaleBar exists (global fallback)
    const doc = getActiveDocument();
    if (doc?.annotations) {
      const scaleBars = schaalBronnen(doc).schaalbalken.filter(geldigeSchaal);
      if (scaleBars.length === 1) {
        return { pixelsPerUnit: scaleBars[0].pixelsPerUnit, unit: scaleBars[0].unit || 'mm', calibrated: true };
      }
    }
  }
  // 2. Page scale of the current page (no point given), then the
  //    per-document scale
  const doc = getActiveDocument();
  if (pageNum == null || x == null || y == null) {
    const pageScale = paginaSchaal(doc, pageNum ?? doc?.currentPage ?? 1);
    if (pageScale) {
      return { pixelsPerUnit: pageScale.pixelsPerUnit, unit: pageScale.unit, calibrated: true,
        ...(pageScale.precision != null ? { precision: pageScale.precision } : {}) };
    }
  }
  // A page whose scale the user cleared stays uncalibrated: no document or
  // preference fallback (K-004).
  if (!paginaGewist(doc, pageNum ?? doc?.currentPage ?? 1)) {
    const docScale = geldigeDocumentSchaal(doc?.measureScale);
    if (docScale) {
      return { ...docScale, calibrated: true };
    }
  } else {
    return { pixelsPerUnit: 1, unit: 'pt', calibrated: false };
  }
  // 3. Legacy global preference
  const ms = geldigeDocumentSchaal(state.preferences.measureScale);
  if (ms) {
    return { ...ms, calibrated: true };
  }
  // One page-view unit is one PDF point at the displayed page scale. This is
  // useful geometry, but it is not an architectural drawing calibration.
  return { pixelsPerUnit: 1, unit: 'pt', calibrated: false };
}

// getMeasureScale at a point of a given document: the active one goes through
// getMeasureScale; another tab (an engine result that arrives after the user
// switched tabs, a background load) is looked up in its own sources, in the
// same order, instead of in the active tab's.
export function getMeasureScaleIn(doc, pageNum, x, y) {
  if (!doc || doc === getActiveDocument()) return getMeasureScale(pageNum, x, y);
  const regionScale = getScaleFromRegionIn(doc, pageNum, x, y);
  if (regionScale) return { ...regionScale, calibrated: true };
  const pointScale = schaalOpPunt(doc, pageNum, x, y);
  if (pointScale) return { ...pointScale, calibrated: true };
  if (paginaGewist(doc, pageNum)) return { pixelsPerUnit: 1, unit: 'pt', calibrated: false };
  const ms = geldigeDocumentSchaal(state.preferences.measureScale);
  if (ms) return { ...ms, calibrated: true };
  return { pixelsPerUnit: 1, unit: 'pt', calibrated: false };
}

// Snap an endpoint so that the distance from (fromX,fromY) to the result
// is rounded to the nearest N measured units (N from preferences).  Returns { x, y }.
// The scale is the one at the midpoint of the segment on `pageNum` (default:
// the current page) — the same source calculateDistance uses for the label,
// so a segment inside a PDF viewport or scale region snaps to round measured
// values instead of round paper points (#400).
export function snapDistanceTo10(fromX, fromY, toX, toY, pageNum) {
  const dx = toX - fromX, dy = toY - fromY;
  const pixelDist = Math.sqrt(dx * dx + dy * dy);
  if (pixelDist === 0) return { x: toX, y: toY };
  const step = state.preferences.measureCtrlSnap || 10;
  const page = pageNum ?? getActiveDocument()?.currentPage ?? 1;
  const ms = getMeasureScale(page, (fromX + toX) / 2, (fromY + toY) / 2);
  const measuredValue = pixelDist / ms.pixelsPerUnit;
  const snappedValue = Math.max(Math.round(measuredValue / step) * step, step);
  const ratio = (snappedValue * ms.pixelsPerUnit) / pixelDist;
  return { x: fromX + dx * ratio, y: fromY + dy * ratio };
}

// The display precision of the scale a measurement used (Set Scale), as a
// spread: absent when the scale has none, so default formatting stays.
function precisionOf(scale) {
  return scale?.precision != null ? { precision: scale.precision } : {};
}

// Calculate distance between two points
// Optionally pass pageNum to resolve scale from scaleBar annotations at the midpoint
export function calculateDistance(x1, y1, x2, y2, pageNum) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const pixelDist = Math.sqrt(dx * dx + dy * dy);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const scale = (pageNum != null)
    ? getMeasureScale(pageNum, midX, midY)
    : getMeasureScale();
  return {
    value: pixelDist / scale.pixelsPerUnit,
    unit: scale.unit,
    pixels: pixelDist,
    calibrated: scale.calibrated,
    ...precisionOf(scale),
  };
}

// Boogsegmenten: de zuivere rekenkant staat in arc-points.js, zodat ook
// headless modules (vlak-ringen.js) hem kunnen gebruiken. Hier opnieuw
// geexporteerd omdat de tekenlaag ze al via measurement.js haalt.
export { arcControlPoint, expandArcPoints } from './arc-points.js';

// Calculate area of a polygon, with the extra rings subtracted (holes) or
// added (separate parts). Welke ring wat is bepaalt vlak-ringen.js \u2014 dezelfde
// regel die het scherm, de hoeveelheden en de opgeslagen appearance volgen
// (GitHub #457). Boogsegmenten worden daarbij uitgeklapt tot rechte stukjes.
// Optionally pass pageNum to resolve scale from scaleBar annotations at the centroid
export function calculateArea(points, holes, pageNum) {
  if (!points || points.length < 3) return { value: 0, unit: 'px\u00B2', pixels: 0 };

  const area = nettoVlakOppervlak(points, holes);

  // Resolve scale using centroid of the polygon when page is provided
  let scale;
  if (pageNum != null && points.length > 0) {
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    scale = getMeasureScale(pageNum, cx, cy);
  } else {
    scale = getMeasureScale();
  }
  const scaledArea = area / (scale.pixelsPerUnit * scale.pixelsPerUnit);
  return {
    value: scaledArea,
    unit: scale.unit + '\u00B2',
    pixels: area,
    calibrated: scale.calibrated,
  };
}

// Calculate perimeter of a polyline
// Optionally pass pageNum to resolve scale from scaleBar annotations at the midpoint
export function calculatePerimeter(points, pageNum) {
  if (!points || points.length < 2) return { value: 0, unit: 'px', pixels: 0 };

  let totalPixels = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    totalPixels += Math.sqrt(dx * dx + dy * dy);
  }

  // Resolve scale using centroid of the polyline when page is provided
  let scale;
  if (pageNum != null && points.length > 0) {
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    scale = getMeasureScale(pageNum, cx, cy);
  } else {
    scale = getMeasureScale();
  }
  return {
    value: totalPixels / scale.pixelsPerUnit,
    unit: scale.unit,
    pixels: totalPixels,
    calibrated: scale.calibrated,
    ...precisionOf(scale),
  };
}

// Apply the measurement rounding preference: a step in millimetres,
// converted to the measurement's own unit (10 mm is 0.01 m or 0.0328 ft).
// Areas, volumes, angles and page points are not rounded by it.
function applyRounding(value, unit) {
  return roundToPreferenceStep(value, unit, state.preferences.measureRounding);
}

// Dimension-label formatter (maatlijnen): same as formatMeasurement, but in
// mm the unit suffix is OMITTED — NL drafting convention writes "436", not
// "436 mm" (mm is the implied drawing unit). Other units keep their suffix.
export function formatDimensionText(measurement) {
  const s = formatMeasurement(measurement);
  return (measurement?.unit || 'mm') === 'mm' ? s.replace(/\s*mm$/, '') : s;
}

// Format measurement for display
// Default: mm → no decimals; m/cm → 1 decimal; ft/in → 2 decimals
// Distances in mm >= 1000 are automatically shown as meters
// Area measurements in mm² are automatically converted to m² for readability
export function formatMeasurement(measurement) {
  const base = formatMeasurementIn(measurement);
  if (measurement?.calibrated === false || !state.preferences?.measureDualUnits) return base;
  const other = otherSystemText(measurement.value, measurement.unit,
    state.preferences.measureDisplayUnit || 'auto', displayDenominator(measurement.precision));
  return other ? `${base} (${other})` : base;
}

// The reading in the chosen display unit, else the scale's own unit.
function formatMeasurementIn(measurement) {
  const display = state.preferences?.measureDisplayUnit;
  if (measurement?.calibrated !== false && display && display !== 'auto') {
    const shown = displayText(measurement.value, measurement.unit, display, displayDenominator(measurement.precision));
    if (shown) return shown;
  }
  if (measurement?.calibrated === false) {
    const value = Number.isFinite(measurement.value) ? measurement.value : 0;
    return `Scale not set · ${Number(value.toFixed(2))} ${measurement.unit || 'pt'}`;
  }
  let val = applyRounding(measurement.value, measurement.unit);
  let unit = measurement.unit || 'mm';

  // Precision chosen in Set Scale (decimals, inch fractions, feet-inches)
  // for lengths, feet-inches for an imperial length without one; areas and
  // angles keep the defaults below.
  const withPrecision = formatLengthWithPrecision(val, unit, implicitPrecision(measurement.precision, unit));
  if (withPrecision != null) return withPrecision;

  // Keep mm as mm — common architectural/CAD convention. Whole numbers only
  // (no decimals) — millimeters are already the smallest practical unit.
  if (unit === 'mm') {
    return `${Math.round(val)} ${unit}`;
  }

  // Always convert mm² areas to m²
  if (unit === 'mm\u00B2') {
    val = val / 1000000;
    unit = 'm\u00B2';
  }
  // ... and mm³ volumes to m³
  if (unit === 'mm\u00B3') {
    val = val / 1e9;
    unit = 'm\u00B3';
  }

  // Recalculate suffix after unit conversion
  const suffix = unit === 'px' ? '' : ` ${unit}`;
  // A rounded length shows the decimals its step needs (10 mm in m: 2).
  const rounded = roundingStepIn(state.preferences.measureRounding, unit);
  if (rounded) return `${val.toFixed(rounded.decimals)}${suffix}`;
  // Default formatting per unit
  if (unit === 'm\u00B2') return `${val.toFixed(2)}${suffix}`;
  if (unit === 'm') return `${val.toFixed(2)}${suffix}`;
  if (unit === 'cm\u00B2') return `${val.toFixed(2)}${suffix}`;
  if (unit === 'cm') return `${val.toFixed(1)}${suffix}`;
  if (unit === 'ft\u00B2' || unit === 'in\u00B2') return `${val.toFixed(2)}${suffix}`;
  // Volumes in cubic feet with cubic yards beside them (concrete, fill).
  if (unit === 'ft\u00B3') return `${val.toFixed(2)}${suffix} (${(val / 27).toFixed(2)} yd\u00B3)`;
  if (unit === 'ft' || unit === 'in') return `${val.toFixed(2)}${suffix}`;
  if (unit === '°') return `${val.toFixed(1)}${suffix}`;
  if (val < 0.01) return `0${suffix}`;
  if (val < 1) return `${val.toFixed(2)}${suffix}`;
  return `${val.toFixed(2)}${suffix}`;
}

// One scale dialog (Set Scale, SetScaleDialog.jsx) serves every entry point:
// the ribbon and status bar, the Calibrate pick, a measurement line's
// context menu and the scale bar tool.
//
// Its Calibrate button closes it while the two-point pick runs; the draft
// (pages, units, precision) waits here and comes back when the pick
// completes. A cancelled pick drops it (the pick tool's onDeactivate).
let setScaleDraft = null;

export function rememberSetScaleDraft(draft) {
  setScaleDraft = draft ? { ...draft } : null;
}

export function forgetSetScaleDraft() {
  setScaleDraft = null;
}

// Set Scale with a reference length (PDF points) from the Calibrate pick or
// a measurement line: the dialog fills it in as the paper length.
export function showCalibrationDialog(referencePixelLength, options = {}) {
  const draft = setScaleDraft;
  setScaleDraft = null;
  openDialog('setScale', { ...(draft ? { draft } : {}), ...options,
    referencePixelLength: referencePixelLength || null });
}

// "Set Scale", prefilled with a scale found in the drawing text (only a
// suggestion until Apply).
export function showSetScaleDialog(pageNum) {
  const doc = getActiveDocument();
  const page = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : (doc?.currentPage || 1);
  // The page's own proposal first (scale-proposals.js), else the scale read from page 1.
  const proposal = doc?.scaleProposals?.[page]?.pageScale;
  const detected = proposal?.status === 'pending' ? proposal : (doc?.scaleProposals?.[page] ? null : doc?.detectedScale);
  const detectedRatio = paginaOfDocumentSchaal(doc, page) ? null : (detected?.ratio || null);
  setScaleDraft = null;
  const detectedImperial = detectedRatio ? detected?.imperial === true : false;
  openDialog('setScale', { detectedRatio, detectedImperial, pageNum: page });
}

const MEASUREMENT_TYPES = ['measureDistance', 'measureArea', 'measurePerimeter', 'measureAngle'];

// Set the scale of some pages (or clear it with null), recalculate every
// measurement and record both as one undo step. `pages` is 'all', 'current'
// (the default) or a list of page numbers. Every scale entry point
// (Calibrate, Set Scale, the line context menu) goes through here so the
// existing measurements never keep a stale value. The scale is stored per
// page in doc.pageScales and written to the PDF as /VP + /Measure on save
// (pdf/pagina-schaal-vp.js), not to localStorage.
export function applyPageScale(scaleData, pages = 'current') {
  const doc = getActiveDocument();
  if (!doc) return;
  const targets = paginasVoorSchaal(pages, doc);
  if (!targets.length) return;
  const oldPageScales = doc.pageScales == null ? null : JSON.parse(JSON.stringify(doc.pageScales));
  // A target page without its own entry follows the PDF. Remember what that
  // was, so Undo can keep the earlier calibration if a save has since
  // replaced the PDF's scale (see undo-manager modifyPageScales).
  const followed = {};
  for (const page of targets) {
    if (oldPageScales && Object.prototype.hasOwnProperty.call(oldPageScales, page)) continue;
    followed[page] = paginaOfDocumentSchaal(doc, page);
  }
  const measurements = doc.annotations.filter(annotation => MEASUREMENT_TYPES.includes(annotation.type));
  const originals = measurements.map(annotation => cloneAnnotation(annotation));
  doc.pageScales = metPaginaSchaal(doc.pageScales, scaleData || null, targets);
  recalculateAllMeasurements();
  beginUndoTransaction();
  recordBulkModify(measurements, originals);
  recordPageScales(oldPageScales, doc.pageScales, followed);
  endUndoTransaction();
}

// Set scale from a known line: given its pixel length and the real-world value + unit,
// set the scale of the line's page (or `options.pages`) and recalculate the
// existing measurements.
export function setScaleFromLine(pixelLength, realValue, unit, sourceAnnotation, options = {}) {
  if (!pixelLength || pixelLength <= 0 || !realValue || realValue <= 0) return;
  if (!geldigeSchaal({ pixelsPerUnit: pixelLength / realValue, unit })) return;
  const doc = getActiveDocument();
  if (!doc) return;
  const pages = options.pages ?? [sourceAnnotation?.page || doc.currentPage || 1];
  applyPageScale({ pixelsPerUnit: pixelLength / realValue, unit, method: 'quick-scale', scaleRatio: 0 }, pages);

  // Refresh properties panel if the source line is selected
  if (sourceAnnotation && doc.selectedAnnotation === sourceAnnotation) {
    import('../bridge.js').then(m => m.storeShowProperties(sourceAnnotation));
  }
}

// Get the representative point of a measurement annotation (for scale lookup)
function getAnnotationPoint(ann) {
  if (ann.type === 'measureDistance') {
    return { page: ann.page || 1, x: (ann.startX + ann.endX) / 2, y: (ann.startY + ann.endY) / 2 };
  }
  if ((ann.type === 'measureArea' || ann.type === 'measurePerimeter') && ann.points?.length > 0) {
    // Centroid
    const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
    const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
    return { page: ann.page || 1, x: cx, y: cy };
  }
  if (ann.type === 'measureAngle' && ann.vertex) {
    return { page: ann.page || 1, x: ann.vertex.x, y: ann.vertex.y };
  }
  return { page: ann.page || 1, x: 0, y: 0 };
}

// Recalculate all measurement annotations after scale change
// Each annotation gets its scale from its position (scaleBar region awareness)
export function recalculateAllMeasurements() {
  const doc = getActiveDocument();
  if (!doc) return;

  // One pass: the scale sources are collected once instead of once per
  // annotation, and the measurement updates reach the reactive views as one
  // change instead of four per annotation (#491).
  batch(() => metSchaalBronnen(() => recalculateMeasurementsIn(doc)));
  // The batch above stores the shoelace total. The desktop engine replaces
  // it when it is linked; the import stays dynamic so this module does not
  // load the command wrapper while the wrapper is still loading us.
  void import('./geos-area.js').then((mod) => mod.scheduleAreaRefine(doc.annotations));

  // Redraw canvas
  if (getActiveDocument()?.viewMode === 'continuous') {
    redrawContinuous();
  } else {
    redrawAnnotations();
  }
}

function recalculateMeasurementsIn(doc) {
  for (const ann of doc.annotations) {
    // A the external editor measurement keeps the scale the external editor stored on it.
    if (herrekenExtMaat(ann)) continue;
    const pt = getAnnotationPoint(ann);
    const scale = getMeasureScale(pt.page, pt.x, pt.y);

    if (ann.type === 'measureDistance') {
      const pixels = ann.measurePixels || Math.sqrt(
        (ann.endX - ann.startX) ** 2 + (ann.endY - ann.startY) ** 2
      );
      const value = pixels / scale.pixelsPerUnit;
      ann.measureValue = value;
      ann.measureUnit = scale.unit;
      ann.measureScale = undefined; // Clear legacy per-annotation scale so formatMeasurement uses the scaleBar
      ann.measureText = formatDimensionText({ value, unit: scale.unit, calibrated: scale.calibrated, ...precisionOf(scale) });
    } else if (ann.type === 'measureArea') {
      if (ann.points && ann.points.length >= 3) {
        // Use position-aware scale directly instead of calculateArea's global fallback;
        // de ringindeling (gat of extra deel) is dezelfde als in calculateArea.
        const netPixelArea = nettoVlakOppervlak(ann.points, ann.holes);
        const scaledArea = netPixelArea / (scale.pixelsPerUnit * scale.pixelsPerUnit);
        const areaUnit = scale.unit + '\u00B2';
        ann.measureValue = scaledArea;
        ann.measureUnit = areaUnit;
        ann.measureScale = undefined;
        ann.measureText = formatMeasurement({ value: scaledArea, unit: areaUnit, calibrated: scale.calibrated });
      }
    } else if (ann.type === 'measurePerimeter') {
      if (ann.points && ann.points.length >= 2) {
        // Use position-aware scale directly
        let totalPixels = 0;
        for (let i = 0; i < ann.points.length - 1; i++) {
          const dx = ann.points[i + 1].x - ann.points[i].x;
          const dy = ann.points[i + 1].y - ann.points[i].y;
          totalPixels += Math.sqrt(dx * dx + dy * dy);
        }
        const value = totalPixels / scale.pixelsPerUnit;
        ann.measureValue = value;
        ann.measureUnit = scale.unit;
        ann.measureScale = undefined;
        ann.measureText = formatMeasurement({ value, unit: scale.unit, calibrated: scale.calibrated, ...precisionOf(scale) });
      }
    }
    applyMeasureExtras(ann, scale, doc.annotations);
  }
}

// Depth, slope, polylength/arc/volume values and the caption (measure-extras.js).
// Only annotations that use one of them are touched.
// A raceway branch also gets the document's runs (its tee / cross / reducer).
function applyMeasureExtras(ann, scale, annotations = ann?.raceway?.branchOf ? documentAnnotationsOf(ann) : undefined, pixelArea) {
  const patch = computeMeasureExtras(ann, scale, {
    formatMeasurement,
    formatDimensionText,
    annotations,
    ...(Number.isFinite(pixelArea) ? { pixelArea } : {}),
  });
  if (patch) Object.assign(ann, patch);
  // Extras switched off: no stale wall area, volume or segment values.
  else for (const key of MEASURE_EXTRA_OUTPUTS) if (ann[key] !== undefined) delete ann[key];
}

/** The annotations of the document holding `ann` (the active one for a new annotation). */
export function documentAnnotationsOf(ann) {
  const doc = (state.documents || []).find((d) => d?.annotations?.includes?.(ann));
  return (doc || getActiveDocument())?.annotations || [];
}

// A reactive read wraps the annotation. Later writes on the raw object
// leave that reader on the first value it saw (the shoelace total).
function storeProxy(object) {
  if (!object || typeof object !== 'object') return object;
  for (const key of Object.getOwnPropertySymbols(object)) {
    const proxy = object[key];
    if (proxy && typeof proxy === 'object' && proxy[$RAW] === object) return proxy;
  }
  return object;
}

/** The open document that holds `ann`, or null. */
function documentOf(ann) {
  return (state.documents || []).find((d) => d?.annotations?.includes?.(ann)) || null;
}

/**
 * Replace a stored area with the engine's page-point total. Slope, depth and
 * volume captions are rebuilt from that total. Returns false when the
 * shoelace figure should stay, including an external-file measurement.
 * The scale is the one at the area in its OWN document (`doc`, else the
 * document that holds it), not the tab in front when the result arrives.
 */
export function writeEngineArea(ann, pixels, doc = null) {
  if (!ann || ann.type !== 'measureArea' || typeof pixels !== 'number' || !Number.isFinite(pixels)) return false;
  const owner = doc || documentOf(ann) || documentOf(storeProxy(ann)) || getActiveDocument();
  ann = storeProxy(ann);
  if (herrekenExtMaat(ann)) return false;
  if (!Array.isArray(ann.points) || ann.points.length < 3) return false;
  const shoelace = nettoVlakOppervlak(ann.points, ann.holes);
  if (Math.abs(shoelace - pixels) <= 1e-6) return false;
  const pt = getAnnotationPoint(ann);
  const scale = getMeasureScaleIn(owner, pt.page, pt.x, pt.y);
  if (hasMeasureExtras(ann)) {
    applyMeasureExtras(ann, scale, owner?.annotations || documentAnnotationsOf(ann), pixels);
  } else {
    const perUnit = scale.pixelsPerUnit > 0 ? scale.pixelsPerUnit : 1;
    const area = { value: pixels / (perUnit * perUnit), unit: scale.unit + '\u00B2', pixels, calibrated: scale.calibrated };
    ann.measureValue = area.value;
    ann.measureUnit = area.unit;
    ann.measureText = formatMeasurement(area);
  }
  ann.modifiedAt = new Date().toISOString();
  return true;
}

// Recompute the extras of one measurement after an edit (geometry, depth,
// slope, caption) with the scale at its own location.
export function refreshMeasureExtras(ann) {
  if (!ann) return;
  const pt = getAnnotationPoint(ann);
  applyMeasureExtras(ann, getMeasureScale(pt.page, pt.x, pt.y));
}

// LocalStorage key for the old per-document scale. Page scales now live in
// the PDF (/VP); this store is only read to migrate old files, and still
// written for the document-level fallback (scale bars, MCP).
function scaleStorageKey(filePath) {
  return legacySchaalSleutel(filePath);
}

// Migrate the old localStorage document scale of THIS document to page
// scales once its PDF viewports are read: every page without a page scale
// (in memory or a full-page /VP in the file) gets it, marked 'legacy', and
// the next save writes it into the PDF. Without a page count (the PDF could
// not be read) it stays the document-wide fallback, as before.
export function migrateDocumentScale(doc, pageCount) {
  if (!doc || !doc.filePath) return;
  const legacy = leesLegacySchaal(doc.filePath);
  if (!legacy) return;
  if (pageCount > 0) {
    migreerLegacySchaal(doc, legacy, pageCount);
    if (JSON.stringify(doc.measureScale) === JSON.stringify(legacy)) doc.measureScale = null;
  } else if (!doc.measureScale) {
    doc.measureScale = legacy;
  }
}

// Save the measure scale of the given (or active) document to localStorage.
// A caller that works on a specific document (loadPDF, also for background
// tabs) must pass it, or the scale of the tab in front is what gets stored.
export function saveDocumentScale(doc) {
  if (!doc) doc = getActiveDocument();
  if (!doc || !doc.filePath) return;
  const ms = doc.measureScale;
  if (ms) {
    try {
      localStorage.setItem(scaleStorageKey(doc.filePath), JSON.stringify(ms));
    } catch { /* quota exceeded or private mode */ }
  } else {
    localStorage.removeItem(scaleStorageKey(doc.filePath));
  }
}

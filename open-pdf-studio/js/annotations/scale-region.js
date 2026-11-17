/**
 * Scale Region — the model of a named viewport: a rectangle with its own
 * scale that overrides the page scale for any annotation whose centroid
 * falls inside. Saved as a PDF /VP entry (pdf/viewports-vp.js), shown only
 * while a measure tool is active (viewport-zichtbaarheid.js).
 *
 * A scaleRegion stores:
 *   - scaleString: human-readable "1:100"
 *   - units: 'mm' | 'cm' | 'm' | 'in' | 'ft'
 *   - label: the viewport name
 *   - precision: optional display precision (measure-precision.js: 0-6
 *     decimals, 'fN' inch fractions, 'fiN' feet-inches), also written to
 *     the PDF /Measure number formats
 *
 * Resolution priority (handled inside getMeasureScale):
 *   1. innermost (smallest area) scaleRegion containing the point
 *   2. existing scaleBar / viewport / doc.measureScale fallbacks
 */
import { getActiveDocument } from '../core/state.js';
import { createAnnotation } from './factory.js';
import { schaalgebiedenOpPagina } from './schaal-op-punt.js';
import { schaalBronnenInDoorloop, vergeetSchaalBronnen } from './schaal-bronnen.js';
import { weergaveMaat } from '../pdf/weergave-rotatie.js';
import { validPrecision } from './measure-precision.js';
import { pixelsPerUnitFor } from './scale-string.js';

// The scale string arithmetic is in scale-string.js (no app state: the
// pdf-lib worker reads scale viewports with it).
export { parseScaleString, pixelsPerUnitFor } from './scale-string.js';

// Per-redraw cache keyed by document instance.
// Map<doc, Map<pageNum, scaleRegion[] sorted by area asc>>
let _cache = new WeakMap();
let _cacheGen = 0;

// Bump on every annotation change (call from rendering before pass).
// Also drops the scale sources of a running pass (schaal-bronnen.js), so a
// change made in the middle of a pass is seen by the next lookup.
export function invalidateScaleRegionCache() {
  _cacheGen++;
  _cache = new WeakMap();
  vergeetSchaalBronnen();
}

function _getRegionsForPage(doc, pageNum) {
  // Inside a pass (metSchaalBronnen) the regions come from the sources that
  // pass collected once: fresh for that pass, so never stale.
  const bronnen = schaalBronnenInDoorloop(doc);
  if (bronnen) return schaalgebiedenOpPagina(bronnen, pageNum);
  let docCache = _cache.get(doc);
  if (!docCache) {
    docCache = new Map();
    _cache.set(doc, docCache);
  }
  let arr = docCache.get(pageNum);
  if (!arr) {
    arr = (doc.annotations || []).filter(
      a => a.type === 'scaleRegion' && a.page === pageNum
    );
    // Smallest area first → innermost wins
    arr.sort((a, b) => (a.width * a.height) - (b.width * b.height));
    docCache.set(pageNum, arr);
  }
  return arr;
}

/**
 * Find the innermost scaleRegion containing point (x, y) on a given page.
 * Returns null if none found.
 */
export function getScaleRegionAt(pageNum, x, y) {
  const doc = getActiveDocument();
  if (!doc || pageNum == null || x == null || y == null) return null;
  const regions = _getRegionsForPage(doc, pageNum);
  for (const r of regions) {
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
      return r;
    }
  }
  return null;
}

/**
 * Resolve the effective scale at (pageNum, x, y) from scale regions.
 * Returns { pixelsPerUnit, unit, source: 'scaleRegion', regionId } or null.
 */
export function getScaleFromRegion(pageNum, x, y) {
  return getScaleFromRegionIn(getActiveDocument(), pageNum, x, y);
}

/** getScaleFromRegion for a given document (an annotation's own tab). */
export function getScaleFromRegionIn(doc, pageNum, x, y) {
  if (!doc || pageNum == null || x == null || y == null) return null;
  // An imported/edited region with missing scale metadata is still a drawn
  // rectangle, but it is not a calibration. Continue to a valid outer region
  // rather than treating a visual 1:100 default as a physical scale.
  for (const r of _getRegionsForPage(doc, pageNum)) {
    if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
    const ppu = pixelsPerUnitFor(r.scaleString, r.units);
    if (!ppu) continue;
    return { pixelsPerUnit: ppu, unit: r.units,
      source: 'scaleRegion', regionId: r.id, method: 'scaleRegion',
      ...(validPrecision(r.precision, r.units) ? { precision: r.precision } : {}) };
  }
  return null;
}

// Visual-density factor for pattern-like rendering (hatch spacing) at a
// point. Inside a scale region the hatch must scale WITH the region so the
// same material pattern keeps the same real-world density across regions of
// different scales. Baseline = 1:100 (the common drawing scale): a 1:50
// region returns 2.0, a 1:200 region 0.5, outside any region 1.0.
const _PPU_1_100 = 72 / (25.4 * 100);
export function getRegionScaleFactor(pageNum, x, y) {
  if (pageNum == null || x == null || y == null) return 1;
  const region = getScaleFromRegion(pageNum, x, y);
  if (!region || !region.pixelsPerUnit) return 1;
  return region.pixelsPerUnit / _PPU_1_100;
}

/**
 * Create a full-page scaleRegion on the active document's current page,
 * push it, invalidate cache and return it. Caller is responsible for
 * triggering recordAdd, redraw and (optionally) opening the calibration dialog.
 * Returns null if no active document or page dimensions cannot be resolved.
 */
export function createFullPageScaleRegion(opts = {}) {
  const doc = getActiveDocument();
  if (!doc) return null;
  const pageNum = opts.page || doc.currentPage || 1;
  const dims = doc.pageDims && doc.pageDims[pageNum];
  if (!dims || !dims.widthPt || !dims.heightPt) return null;
  // pageDims records the unrotated CropBox extent. Annotations live in the
  // page space after the PDF's own /Rotate, so a quarter-turn swaps its axes.
  const pageSize = weergaveMaat(dims.widthPt, dims.heightPt, dims.rotation);
  const ann = createScaleRegion({
    page: pageNum,
    x: 0,
    y: 0,
    width: pageSize.breedte,
    height: pageSize.hoogte,
    scaleString: opts.scaleString || '1:100',
    units: opts.units || 'mm',
    label: opts.label || '',
  });
  doc.annotations.push(ann);
  return ann;
}

/**
 * Factory for scaleRegion annotations (named viewports, see
 * named-viewports.js). `precision` (valid for the unit, measure-precision.js)
 * and `tekeningtypeId` are kept when given.
 */
export function createScaleRegion(props) {
  const scaleString = props.scaleString ?? '1:100';
  const units = props.units ?? 'mm';
  const extra = {};
  if (validPrecision(props.precision, units)) extra.precision = props.precision;
  if (props.tekeningtypeId) extra.tekeningtypeId = props.tekeningtypeId;
  // The text the scale was read from ("View: DETAIL 2 · 1/2\" = 1'-0\""), for the status bar.
  if (typeof props.source === 'string' && props.source.trim()) extra.source = props.source.trim().slice(0, 200);
  return createAnnotation({
    ...extra,
    type: 'scaleRegion',
    page: props.page,
    x: props.x,
    y: props.y,
    width: props.width,
    height: props.height,
    scaleString,
    units,
    label: props.label || '',
    color: props.color || '#ff9800',
    lineWidth: 1.5,
    borderStyle: 'dashed',
    opacity: 1,
  });
}

import { $RAW } from 'solid-js/store';
import { perfRecord } from '../core/perf.js';
import { apInBitmap } from '../pdf/ap-render-state.js';
import { state, getActiveDocument, getPageRotation, imageCache } from '../core/state.js';
import { drawSpaceOverlay } from '../spaces/overlay.js';
import { annotationCanvas, annotationCtx, textHighlightCanvas, textHighlightCtx } from '../ui/dom-elements.js';
import { updateStatusAnnotations } from '../ui/chrome/status-bar.js';
import { updateAnnotationsListIfChanged } from '../ui/panels/annotations-list.js';
import { renderWatermarksBehind, renderWatermarksInFront } from '../watermark/watermark-renderer.js';

// Import from sub-modules
import { drawPolygonShape, drawCloudShape, buildPolygonPath, buildPolygonPointsPath, buildCloudPath, buildCloudPolylinePath, drawTextboxContent, isRTLText } from './rendering/shapes.js';
import { tekstvakKnipvlak } from './rendering/textbox-layout.js';
import { drawArrowheadOnCanvas, applyBorderStyle, drawDimensionLineEnding } from './rendering/decorations.js';
import { catmullRomSpline } from '../tools/tools/spline-tool.js';
import { catmullRomToBezier, splineArrowEndTangent } from './spline-arrow-geometry.js';
import { drawDimension, drawMeasureAreaShape, drawCentroidLabel, drawMeasurePerimeterShape } from './rendering/measurements.js';
import { drawSegmentLabels, drawCentroidMarker } from './rendering/measure-extras-draw.js';
import { drawCustomCaption } from './rendering/custom-caption-draw.js';
import { drawRaceway } from './rendering/raceway-draw.js';
import { liveJunction } from './raceway-links.js';
import { bumpAnnotationFrame, annotationFrame, drawRacewayGesture } from '../tools/raceway/live-preview.js';
import { maatlijnTekst } from './maat-label.js';
import { maatlijnVelden } from './maatlijn-geometrie.js';
import { tagWeergaveParams } from '../plattegrond/ruimte-koppeling.js';
import { applyHatchFill, applyHatchFillPolygon } from './rendering/hatch-patterns.js';
import { tekenLijnstijl } from './rendering/line-style-draw.js';
import { arcPolylinePoints } from './line-styles.js';
import { drawWall } from './rendering/walls.js';
import { edition } from '../editions/active.js';
import { buildStavenreeks } from './stavenreeks.js';
import { stavenreeksPxPerMm } from './stavenreeks-scale.js';
import { buildBetonbalk } from './betonbalk.js';
import { betonbalkBuildOpts } from './betonbalk-scale.js';
import { drawBetonbalkGeom } from './rendering/betonbalk-draw.js';
import { effectiveDraftingLineWidth } from './drafting-rules.js';
import { buildSysteemraster } from './systeemraster.js';
import { systeemrasterBuildOpts } from './systeemraster-scale.js';
import { drawSysteemrasterGeom } from './rendering/systeemraster-draw.js';
import { getSysteemSymbolImage, registerSysteemSymbolRedraw } from './rendering/systeem-symbol-cache.js';
import { getAnnotationType } from '../plugins/annotation-type-registry.js';
import { drawSelectionHandles } from './rendering/selection.js';
import { weergaveLagen } from './rendering/uitvoer-lagen.js';
import { weergaveLijndikte, symboolOpdrachtLijndikte } from './rendering/lijndikte.js';
import { drawImageCropOverlay, activeCropAnnotation } from './image-crop-overlay.js';
import { fracties as cropFracties, volledigVak as cropVolledigVak } from './crop-geometrie.js';
import { drawEmbeddedImageOverlay } from '../tools/tools/remove-image-tool.js';
import { drawVisualSearchOverlay } from '../tools/visual-search/overlay.js';
import { drawExtensionOverlays, drawExtensionUnderlays } from './extension-overlay.js';
import { drawDynamicFillOverlay } from '../tools/dynamic-fill/overlay.js';
import { updateQuickAccessButtons, updateContextualTabs, drawGrid, snapToGrid } from './rendering/ui-state.js';
import { drawCommentIcon } from './rendering/comment-icons.js';
import { drawCaret, strikeLine, replaceStrikeColor } from './rendering/caret.js';
import { spatialIndex, annotationBounds } from './spatial-index.js';
import { buildDrawLookup, visibleDrawItems } from './draw-lookup.js';
import { documentGeometryToken } from './markup-rtree.js';
import { pageSlots } from './page-buckets.js';
import { bitmapVoor, bijNieuweTegel } from './vector-snippet-preview.js';
import { invalidateScaleRegionCache, pixelsPerUnitFor, getRegionScaleFactor } from './scale-region.js';
import { metSchaalBronnen } from './schaal-bronnen.js';
import { geldigeSchaal, paginaOfDocumentSchaal } from './schaal-op-punt.js';
import { drawSnapIndicator } from '../tools/snap-engine.js';
import { drawImageAlignGuides } from '../tools/image-align-snap.js';
import { getTemplate } from '../symbols/registry.js';
import { countUsesSymbol, drawCountSymbolMarker } from './count-marker.js';
import { hasFill, hasStroke } from './fill-utils.js';
import { EDITABLE_NUMBER_COLOR, shouldHighlightNumbers } from './editable-numbers.js';
// Side-effect: meldt de providers voor bewerkbare getallen aan
// (stavenreeks, betonbalk, parametricSymbol).
import { labelHasNumericField } from './editable-numbers-providers.js';
import { halftoneTypes as evHalftoneTypes } from '../solid/stores/elementVisibilityStore.js';
import { isAnnotationHiddenInView, isAnnotationHiddenInOutput, metWeergaveDoorloop } from './view-filters.js';
import { kruisEindpuntenEllips } from './kruis-geometrie.js';
import { klemMaat, symboolRasterPxPerPt } from './minimummaat.js';
import {
  getPageRotationMatrix,
  resolveTextEditLineStyle,
  textEditLineAnchor,
} from '../text/text-edit-appearance.js';
import { viewportGeometrie, rectNaarPagina, vermenigvuldig as vermenigvuldigMatrix } from '../pdf/weergave-rotatie.js';
import { paginaMaat, paginaNaarWeergave, weergaveTransform, weergaveRectNaarPagina, zetRechtopRond } from '../pdf/weergave-ruimte.js';
import { drawEditToolOverlay } from '../tools/edit-tool-overlay.js';
import { drawRegionSelection } from '../tools/region-selection.js';
import { drawStampDesign } from './stamp-draw.js';

// Re-export everything that external code needs
export { drawPolygonShape, drawCloudShape, buildPolygonPath, buildCloudPath } from './rendering/shapes.js';

// The Oculith mark (monolith with the eye cut out), from branding/oculith-logo.svg.
const OCULITH_MARK = 'M168,90 H344 Q362,90 362,108 V404 Q362,422 344,422 H168 Q150,422 150,404 V108 Q150,90 168,90 Z '
  + 'M256,146 Q348,256 256,366 Q164,256 256,146 Z M236,256 a20,20 0 1,0 40,0 a20,20 0 1,0 -40,0 Z';
let oculithMarkPath = null;
function drawOculithMark(ctx, x, y, size) {
  if (typeof Path2D === 'undefined') return;
  oculithMarkPath ||= new Path2D(OCULITH_MARK);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 392, size / 392);
  ctx.translate(-60, -60);
  ctx.fillStyle = '#F26B1F';
  ctx.fill(oculithMarkPath, 'evenodd');
  ctx.restore();
}

// A placed schedule (columns, rows of { cells, group?, total?, grand? }):
// a title bar (with the Oculith mark on branded tables), a header row,
// columns sized to their content, numbers right-aligned, zebra rows, group
// rows with an accent edge, and totals set off by a rule. Nothing is cut
// off: numbers and single words keep their full width, longer text wraps
// onto more lines (the row grows), and the table widens when even that
// does not fit.
function drawScheduleTable(ctx, annotation) {
  const columns = annotation.columns;
  const rows = annotation.rows;
  const ncols = Math.max(1, columns.length);
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image');
  const hasImages = rows.some(row => !row.group && !row.total && Array.isArray(row.cells) && row.cells.some(isImg));
  const minRowH = hasImages ? 40 : 17, minHeaderH = 20, pad = 6, lineH = 11.5;
  const title = String(annotation.title || '');
  const titleH = title ? 24 : 0;
  const numeric = (v) => /^[-+]?\d[\d,]*(\.\d+)?$/.test(String(v ?? '').trim());
  const font = (weight, size) => `${weight} ${size}px "Geist", system-ui, sans-serif`;
  const HEAD = font(650, 9.5), BODY = font(400, 9.5), TOTAL = font(650, 9.5), GROUP = font(650, 10);
  const textW = (f, t) => { ctx.font = f; return ctx.measureText(t).width; };
  const bodyFont = (row) => (row.total ? TOTAL : BODY);

  ctx.save();
  ctx.textBaseline = 'middle';
  // Per column: its natural width (longest header or cell on one line) and
  // the least it can take (its longest word; a number never breaks).
  const natural = [], least = [];
  for (let i = 0; i < ncols; i++) {
    const head = String(columns[i] ?? '');
    let w = textW(HEAD, head);
    let m = Math.max(0, ...head.split(/\s+/).map((word) => textW(HEAD, word)));
    for (const row of rows) {
      const cell = row.cells?.[i];
      if (row.group || isImg(cell)) continue;
      const t = String(cell ?? '');
      const f = bodyFont(row);
      const full = textW(f, t);
      w = Math.max(w, full);
      m = Math.max(m, numeric(t) ? full : Math.max(0, ...t.split(/\s+/).map((word) => textW(f, word))));
    }
    natural.push(Math.max(36, w + pad * 2));
    least.push(Math.max(36, Math.min(w, m) + pad * 2));
  }
  const sum = natural.reduce((a, b) => a + b, 0);
  const leastSum = least.reduce((a, b) => a + b, 0);
  const tw = Math.max(annotation.width || Math.max(300, sum), leastSum);
  let colW;
  if (sum <= tw) {
    colW = natural.map((w) => (w / sum) * tw);
  } else {
    // Too narrow for every column on one line: the columns with room to wrap
    // give it up, in proportion to that room.
    const slack = natural.map((w, i) => w - least[i]);
    const slackSum = slack.reduce((a, b) => a + b, 0) || 1;
    const over = sum - tw;
    colW = natural.map((w, i) => w - (slack[i] / slackSum) * over);
  }
  const colX = colW.map((_, i) => annotation.x + colW.slice(0, i).reduce((a, b) => a + b, 0));

  // Text broken onto lines of at most maxW (a word longer than that, which
  // the widths above rule out, is clipped as a last resort).
  const wrap = (f, text, maxW) => {
    ctx.font = f;
    const lines = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (!line || ctx.measureText(next).width <= maxW) line = next;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines.map((t) => {
      if (ctx.measureText(t).width <= maxW) return t;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    });
  };
  const cellLines = (f, text, i) => (numeric(text) ? [String(text).trim()] : wrap(f, text, colW[i] - pad * 2));
  const heightFor = (n, min) => Math.max(min, n * lineH + 5.5);

  // Lay out every row first: its lines per cell and its height.
  const headLines = columns.map((c, i) => cellLines(HEAD, c ?? '', i));
  const headerH = heightFor(Math.max(1, ...headLines.map((l) => l.length)), minHeaderH);
  const layout = rows.map((row) => {
    const cells = row?.cells || [];
    if (row?.group) {
      const lines = wrap(GROUP, cells[0] || '', tw - pad * 2 - 2);
      return { lines: [lines], h: heightFor(lines.length, minRowH) };
    }
    const f = bodyFont(row || {});
    const lines = Array.from({ length: ncols }, (_, i) => (isImg(cells[i]) ? [] : cellLines(f, cells[i] != null ? String(cells[i]) : '', i)));
    return { lines, h: heightFor(Math.max(1, ...lines.map((l) => l.length)), minRowH) };
  });
  const top = annotation.y;
  const bodyTop = top + titleH;
  const totalH = titleH + headerH + layout.reduce((a, r) => a + r.h, 0);

  const drawLines = (lines, i, y, h, raw) => {
    const y0 = y + h / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((t, k) => {
      if (numeric(raw)) {
        ctx.textAlign = 'right';
        ctx.fillText(t, colX[i] + colW[i] - pad, y0 + k * lineH);
        ctx.textAlign = 'left';
      } else {
        ctx.fillText(t, colX[i] + pad, y0 + k * lineH);
      }
    });
  };

  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(annotation.x, top, tw, totalH);

  // Title bar
  if (title) {
    ctx.fillStyle = '#1b2230';
    ctx.fillRect(annotation.x, top, tw, titleH);
    let tx = annotation.x + pad + 2;
    if (annotation.brand === 'oculith') {
      drawOculithMark(ctx, tx - 2, top + 3, titleH - 6);
      tx += titleH - 2;
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = font(650, 11.5);
    let t = title;
    const maxW = tw - (tx - annotation.x) - pad;
    if (ctx.measureText(t).width > maxW) {
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      t += '…';
    }
    ctx.fillText(t, tx, top + titleH / 2);
  }

  // Header row
  ctx.fillStyle = '#eef1f5';
  ctx.fillRect(annotation.x, bodyTop, tw, headerH);
  ctx.fillStyle = '#3a4352';
  ctx.font = HEAD;
  for (let i = 0; i < ncols; i++) drawLines(headLines[i], i, bodyTop, headerH, columns[i]);
  ctx.strokeStyle = '#b8c0cc'; ctx.lineWidth = 0.75;
  ctx.beginPath(); ctx.moveTo(annotation.x, bodyTop + headerH); ctx.lineTo(annotation.x + tw, bodyTop + headerH); ctx.stroke();

  // Rows
  let stripe = 0;
  let ry = bodyTop + headerH;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || {};
    const cells = row.cells || [];
    const { lines, h: rowH } = layout[r];
    if (row.group) {
      stripe = 0;
      ctx.fillStyle = '#f3f4f6'; ctx.fillRect(annotation.x, ry, tw, rowH);
      ctx.fillStyle = '#F26B1F'; ctx.fillRect(annotation.x, ry, 2.5, rowH);
      ctx.fillStyle = '#1b2230'; ctx.font = GROUP;
      const y0 = ry + rowH / 2 - ((lines[0].length - 1) * lineH) / 2;
      lines[0].forEach((t, k) => ctx.fillText(t, annotation.x + pad + 2, y0 + k * lineH));
      ry += rowH;
      continue;
    }
    if (row.total) {
      ctx.fillStyle = row.grand ? '#e7eaef' : '#f5f6f8'; ctx.fillRect(annotation.x, ry, tw, rowH);
      ctx.strokeStyle = '#9aa3ae'; ctx.lineWidth = row.grand ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(annotation.x, ry); ctx.lineTo(annotation.x + tw, ry); ctx.stroke();
    } else if (stripe++ % 2 === 1) {
      ctx.fillStyle = '#f8f9fb'; ctx.fillRect(annotation.x, ry, tw, rowH);
    }
    ctx.font = bodyFont(row);
    ctx.fillStyle = '#1b2230';
    for (let i = 0; i < ncols; i++) {
      const raw = cells[i];
      if (isImg(raw)) {
        const thumb = getScheduleThumb(raw);
        const maxW = colW[i] - pad * 2, maxH = rowH - 6;
        if (thumb && thumb.width && thumb.height) {
          const sc = Math.min(maxW / thumb.width, maxH / thumb.height, 1);
          const dw = thumb.width * sc, dh = thumb.height * sc;
          ctx.drawImage(thumb, colX[i] + (colW[i] - dw) / 2, ry + (rowH - dh) / 2, dw, dh);
        }
        continue;
      }
      drawLines(lines[i], i, ry, rowH, raw);
    }
    ctx.strokeStyle = '#e4e7ec'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(annotation.x, ry + rowH); ctx.lineTo(annotation.x + tw, ry + rowH); ctx.stroke();
    ry += rowH;
  }

  // Outer border
  ctx.strokeStyle = '#8a94a3'; ctx.lineWidth = 1;
  ctx.strokeRect(annotation.x, top, tw, totalH);

  annotation.width = tw;
  annotation.height = totalH;
  ctx.restore();
}

// Thumbnail-cache voor scheduleTable-beeldcellen: data-URL → HTMLImageElement.
// Klein en gedeeld; bij eerste laden triggeren we één redraw zodat de reeds
// gedecodeerde thumbnail meteen verschijnt (performant: geen her-decode).
const _scheduleThumbCache = new Map();
function getScheduleThumb(url) {
  if (!url) return null;
  const hit = _scheduleThumbCache.get(url);
  if (hit) return hit.complete ? hit : null;
  const img = new Image();
  _scheduleThumbCache.set(url, img);
  img.onload = () => { try { redrawAnnotations(); } catch (_) {} };
  img.src = url;
  return null;
}

// Puff-maat (koorde in pt) voor wolkranden op basis van de /BE-intensiteit:
// I<=1 = "kleine wolk", anders "grote wolk" (kalibratie op externe editors).
function cloudPuffSize(annotation) {
  return (annotation.cloudIntensity !== undefined && annotation.cloudIntensity <= 1) ? 9 : 15;
}
export { updateQuickAccessButtons, snapToGrid } from './rendering/ui-state.js';

// Blender-style 2D cursor marker — red/white dashed circle + crosshair,
// drawn at constant SCREEN size (sizes divided by the current scale).
// ctx is in app-coord space.
function _draw2DCursor(ctx, x, y, screenScale) {
  const s = 1 / Math.max(screenScale || 1, 0.0001);
  const r = 7 * s;
  const armIn = 4 * s;
  const armOut = 14 * s;
  ctx.save();
  // White base circle with red dashes on top (the classic look)
  ctx.lineWidth = 1.8 * s;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#d62b2b';
  ctx.setLineDash([3.2 * s, 3.2 * s]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  // Crosshair: dark lines on a white halo for contrast on any background
  const cross = (lw, color) => {
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - armOut, y); ctx.lineTo(x - armIn, y);
    ctx.moveTo(x + armIn, y); ctx.lineTo(x + armOut, y);
    ctx.moveTo(x, y - armOut); ctx.lineTo(x, y - armIn);
    ctx.moveTo(x, y + armIn); ctx.lineTo(x, y + armOut);
    ctx.stroke();
  };
  cross(2.6 * s, '#ffffff');
  cross(1.2 * s, '#1a1a1a');
  ctx.restore();
}

// Inline polar-ray + tooltip drawer (kept here to avoid an import cycle
// with snap-engine.js).  ctx is in app-coord space.
function _drawPolarOverlay(ctx, snapResult, scale) {
  if (!snapResult || snapResult.type !== 'polar' || !snapResult.anchor) return;
  const ax = snapResult.anchor.x;
  const ay = snapResult.anchor.y;
  const angle = snapResult.angle;
  const length = snapResult.length;
  const lw = 0.75 / scale;
  const dash = 6 / scale;
  const extent = 50000;

  ctx.save();
  ctx.strokeStyle = '#cc66cc';
  ctx.lineWidth = lw;
  ctx.setLineDash([dash, dash]);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(ax - cosA * extent, ay - sinA * extent);
  ctx.lineTo(ax + cosA * extent, ay + sinA * extent);
  ctx.stroke();
  ctx.setLineDash([]);

  // Tooltip with angle + length
  let unit = 'px';
  let lenInUnits = length;
  try {
    // Lazy resolve to avoid hard cycle
    const ms = state._lastMeasureScale || null;
    if (ms && ms.pixelsPerUnit > 0) {
      lenInUnits = length / ms.pixelsPerUnit;
      unit = ms.unit || 'mm';
    }
  } catch (_) { /* ignore */ }
  const angleDeg = (angle * 180 / Math.PI + 360) % 360;
  const text = `Polar: ${angleDeg.toFixed(2)}° < ${lenInUnits.toFixed(2)} ${unit}`;
  // Rechtop op het scherm, ook in een gedraaide weergave (#200).
  zetRechtopRond(ctx, snapResult.x, snapResult.y);
  const fontSize = 11 / scale;
  ctx.font = `${fontSize}px Arial`;
  const padX = 4 / scale;
  const padY = 3 / scale;
  const tw = ctx.measureText(text).width;
  const tx = snapResult.x + 12 / scale;
  const ty = snapResult.y + 12 / scale;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = '#cc66cc';
  ctx.lineWidth = 0.5 / scale;
  ctx.fillRect(tx - padX, ty - fontSize, tw + padX * 2, fontSize + padY * 2);
  ctx.strokeRect(tx - padX, ty - fontSize, tw + padX * 2, fontSize + padY * 2);
  ctx.fillStyle = '#552255';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

// Resolve line width:
// - width === 0 means "no border" (PDF spec) — return 0 untouched
// - Thin-lines view: clamp to max 1px
// - Normal view: respect the PDF-defined width with a tiny floor (0.5) so
//   a non-zero stroke stays visible.
// Additionally enforce a 1-screen-pixel minimum when zoomed below 100 %:
// a 1 pt app-space stroke at 35 % zoom resolves to ~0.35 screen-pixels,
// which the canvas anti-aliases into a near-invisible ghost. This is the
// user-visible cause of the "Line doesn't appear" report — the Line tool
// has no fill to fall back on, unlike Rectangle/Circle/Cloud whose fill
// keeps the shape visible even when the outline goes sub-pixel.
// On-screen (device-pixel) cap for stroke weight DURING an interactive
// drag/resize/G-transform. Chosen generously so ordinary line weights are
// untouched (they resolve below the cap) and only pathologically thick
// strokes — the ones that made dragging lag — are bounded while the gesture
// is in flight. Full weight is restored on the post-gesture repaint.
// (SLEEP_MAX_SCHERM_PX in rendering/lijndikte.js.)

// Lagen van de rendering die nu loopt: null = het scherm, anders de lagen van
// een afdruk, export of voorbeeld (zie rendering/uitvoer-lagen.js). Wordt
// alleen tijdens renderAnnotationsForPage gezet — die tekent synchroon — zodat
// drawAnnotation weet dat er geen bewerkingstoestand in de uitvoer hoort.
let _lagen = null;

/** Tekent deze rendering laag `naam`? Zonder uitvoermodus altijd. */
function laag(naam) {
  return !_lagen || _lagen[naam];
}

// Blauwe klik-affordance voor bewerkbare getallen: alleen wanneer de
// annotatie de ENIGE selectie is (zie annotations/editable-numbers.js) —
// precies dan opent een klik op zo'n getal de inline invoer.
function inlineNumberHighlight(annotation) {
  // Een afdruk of export kent geen selectie: geen blauwe affordance.
  if (!laag('selectie')) return false;
  const doc = state.documents[state.activeDocumentIndex];
  return shouldHighlightNumbers(annotation, doc ? doc.selectedAnnotations : null);
}

// A second view (the passive MultiView split, docs/reference/editor/workspace.md) draws at its
// own zoom; metWeergaveZoom() lets the line-weight rules use that zoom.
let _weergaveZoom = null;
export function metWeergaveZoom(zoom, fn) {
  const vorige = _weergaveZoom;
  _weergaveZoom = zoom > 0 ? zoom : null;
  try { return fn(); } finally { _weergaveZoom = vorige; }
}

// The rule itself lives in rendering/lijndikte.js (pure, unit-tested); this
// wrapper only supplies the app state it depends on.
function thinLw(width) {
  // Uitvoer (afdruk, export, voorbeeld, opgeslagen appearance): de echte
  // lijndikte. De schermregels rekenen naar SCHERMpixels en maakten een lijn
  // van 0,5 pt bij 17 % zoom 6 pt dik op papier.
  const scherm = laag('schermlijndikte');
  if (width === 0 || !scherm) return weergaveLijndikte(width, { scherm: false });
  const vp = window.__pdfViewport;
  const st = lijndikteStaat();
  // Blank docs (no filePath) bypass the viewport singleton and use doc.scale.
  const scale = _weergaveZoom ?? ((vp && vp.active && st.filePath)
    ? vp.zoom
    : (st.docScale || 1));
  // Lineweight display OFF ('TL'): EVERYTHING renders as a true hairline —
  // exactly 1 screen pixel at any zoom (CAD LWDISPLAY off). Below 100 % zoom
  // a stroke gets at least one screen pixel.
  // Interaction LOD (level-of-detail): while an annotation is being dragged,
  // resized or G-transformed, redrawAnnotations() re-strokes the whole overlay
  // on EVERY pointermove. The ONLY per-frame cost that grows with line weight
  // is the ctx.stroke() rasterisation itself — the filled area is
  // (length × width × scale²) device pixels, so a thick stroke at high zoom
  // makes each frame progressively more expensive (thin lines stay smooth,
  // thick ones visibly lag). During the interaction we therefore cap the
  // ON-SCREEN stroke to SLEEP_MAX_SCHERM_PX device pixels: the geometry and
  // hit-testing are unchanged, only the drawn width is bounded so the fill
  // stays cheap. The very last repaint of the gesture runs with the drag flags
  // already cleared (see _finishDragResize in tool-dispatcher.js), so the final
  // on-screen result is the full, un-capped weight — the end view never changes.
  return weergaveLijndikte(width, {
    scherm: true,
    zoom: scale,
    dunneLijnen: st.dunneLijnen,
    slepen: st.slepen,
  });
}

// What thinLw reads from the store, once per drawn frame: it runs for every
// stroke, and through the store each call cost several proxy reads (a
// noticeable part of drawing 20,000 markups). The viewport zoom stays live.
let _lijndikteStaat = null;
let _lijndikteFrame = -1;
function lijndikteStaat() {
  const frame = annotationFrame();
  if (_lijndikteStaat && _lijndikteFrame === frame) return _lijndikteStaat;
  const doc = state.documents[state.activeDocumentIndex];
  _lijndikteFrame = frame;
  _lijndikteStaat = {
    filePath: doc?.filePath || null,
    docScale: doc?.scale,
    dunneLijnen: !!state.preferences?.thinLines,
    slepen: !!(state.isDragging || state.isResizing || state.gMoveMode || state.gRotateMode),
  };
  return _lijndikteStaat;
}

// Pick the textbox edge whose midpoint is closest to (kx, ky).
// Returns { x, y, side } where side is 'top'|'right'|'bottom'|'left'.
export function pickAnchorSide(box, kx, ky) {
  const bx = box.x, by = box.y;
  const bw = box.width || 150, bh = box.height || 50;
  const candidates = [
    { side: 'top',    x: bx + bw / 2, y: by },
    { side: 'right',  x: bx + bw,     y: by + bh / 2 },
    { side: 'bottom', x: bx + bw / 2, y: by + bh },
    { side: 'left',   x: bx,          y: by + bh / 2 },
  ];
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const d = (c.x - kx) * (c.x - kx) + (c.y - ky) * (c.y - ky);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Draw a single leader on a textbox: anchor (auto-picked) -> knee -> tip,
// with arrow or circle endpoint.
function drawTextboxLeader(ctx, annotation, leader, strokeColor, lineWidth) {
  const tipX = leader.tipX;
  const tipY = leader.tipY;
  const kneeX = leader.kneeX;
  const kneeY = leader.kneeY;
  const anchor = pickAnchorSide(annotation, kneeX, kneeY);

  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.fillStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(kneeX, kneeY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  const endStyle = leader.endStyle || 'arrow';
  if (endStyle === 'circle') {
    const r = 4;
    ctx.beginPath();
    ctx.arc(tipX, tipY, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // arrow — filled (closed) by default for textbox leaders
    const angle = Math.atan2(tipY - kneeY, tipX - kneeX);
    drawArrowheadOnCanvas(ctx, tipX, tipY, angle, 7, 'closed');
  }
  ctx.restore();
}

// Draw single annotation
// Render a single parametric symbol to a standalone PNG data URL, reusing the
// EXACT live drawAnnotation() path (same templates, command-walker, hatch, text
// and rotation) so the raster matches the on-screen rendering. Used by the PDF
// saver to embed an appearance stream (/AP) for the NL/IFC symbols, so they look
// the same in other PDF viewers instead of showing an empty box. The canvas
// covers the rotation-expanded bbox (the same box the saver writes as the
// annotation Rect), so a rotated symbol never clips.
export function renderParametricSymbolToPng(annotation, pxPerUnit = 4) {
  try {
    // Alleen de technische ondergrens: een symbool kleiner dan 1 pt (een
    // wapeningsstaaf van 12 mm op 1:100 is 0,34 pt) kreeg een appearance van
    // 1 pt, groter dan zijn geometrie.
    const w = klemMaat(annotation.width);
    const h = klemMaat(annotation.height);
    const rot = ((annotation.rotation || 0) * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(rot)), sinA = Math.abs(Math.sin(rot));
    const aabbW = w * cosA + h * sinA;   // rotation-expanded bbox = saver Rect
    const aabbH = w * sinA + h * cosA;
    // Klein symbool: genoeg pixels op de langste zijde (was 1-4 pixels);
    // groot symbool: cap zodat het canvas niet enorm wordt.
    const px = symboolRasterPxPerPt(Math.max(aabbW, aabbH), pxPerUnit);
    const cw = Math.max(1, Math.round(aabbW * px));
    const ch = Math.max(1, Math.round(aabbH * px));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    // Map the expanded-bbox app-region onto the canvas (app-units → pixels).
    const cx = annotation.x + w / 2, cy = annotation.y + h / 2;
    ctx.scale(cw / aabbW, ch / aabbH);
    ctx.translate(-(cx - aabbW / 2), -(cy - aabbH / 2));
    // Full opacity here; the saver applies annotation opacity via the AP's
    // ExtGState (same as image stamps) so it isn't applied twice.
    // `_ignoreViewFilters`: dit is de SAVER-route (AP schrijven) — weergave-
    // filters zoals het statusfilter of "Zichtbaarheid Elementen" mogen hier
    // nooit een lege appearance opleveren.
    // Uitvoerlagen: een opgeslagen appearance is geen scherm. Echte
    // lijndiktes (niet de minimum-schermpixel van de huidige zoomstand) en
    // geen selectie- of bewerkingstoestand.
    const vorigeLagen = _lagen;
    _lagen = weergaveLagen({ uitvoer: true });
    try {
      drawAnnotation(ctx, { ...annotation, opacity: 1, hidden: false, _ignoreViewFilters: true });
    } finally {
      _lagen = vorigeLagen;
    }
    return { dataUrl: canvas.toDataURL('image/png') };
  } catch (e) {
    console.warn('[render] renderParametricSymbolToPng failed:', e);
    return null;
  }
}

// ─── Image tint cache ────────────────────────────────────────────────────
// Image annotations used as compare-overlays can carry a `tintColor`. The
// tint is a multiply of the tint colour over the bitmap (alpha preserved),
// baked once per Image element into an offscreen canvas so redraws stay a
// single drawImage. WeakMap keyed on the Image: refreshes of linked images
// swap the Image object, which automatically invalidates the cache entry.
const _tintedImageCache = new WeakMap(); // Image → { tint, canvas }

function getTintedImage(img, tint) {
  const hit = _tintedImageCache.get(img);
  if (hit && hit.tint === tint) return hit.canvas;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || 1;
  c.height = img.naturalHeight || 1;
  const tctx = c.getContext('2d');
  tctx.drawImage(img, 0, 0);
  tctx.globalCompositeOperation = 'multiply';
  tctx.fillStyle = tint;
  tctx.fillRect(0, 0, c.width, c.height);
  // Multiply paints the full rect — clip it back to the source alpha so
  // transparent bitmap areas stay transparent.
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(img, 0, 0);
  tctx.globalCompositeOperation = 'source-over';
  _tintedImageCache.set(img, { tint, canvas: c });
  return c;
}

// Build a CSS/canvas `filter` string for an image annotation's non-destructive
// Word-style adjustments, or '' when all are neutral. brightness/contrast are
// stored as multipliers (1 = neutral); grayscale is a boolean. Reused by the
// PDF saver so the flattened bitmap carries the same look.
export function imageFilterString(annotation) {
  const parts = [];
  if (annotation.grayscale) parts.push('grayscale(1)');
  const b = annotation.brightness;
  if (b !== undefined && b !== null && b !== 1) parts.push(`brightness(${b})`);
  const c = annotation.contrast;
  if (c !== undefined && c !== null && c !== 1) parts.push(`contrast(${c})`);
  return parts.join(' ');
}

/**
 * Geef een vulkleur terug waarin een afwijkende vul-doorzichtigheid verrekend
 * is ten opzichte van de globalAlpha die straks actief is.
 *
 * De canvas kent één globalAlpha voor lijn én vlak; PDF kent er twee (/CA voor
 * de lijn, /ca voor de vulling). Door de verhouding in de alfa van een
 * rgba()-kleur te zetten, komt globalAlpha × kleur-alfa precies uit op de
 * gevraagde vul-alfa, zonder dat elke vorm apart de globalAlpha moet omzetten.
 *
 * Zonder `fillOpacity` (verreweg de meeste annotaties) komt de kleur
 * ongewijzigd terug — dit pad is dan een enkele vergelijking.
 */
function withFillAlpha(color, fillOpacity, baseOpacity) {
  if (fillOpacity === undefined || fillOpacity === null) return color;
  if (!color || color === 'none' || color === 'transparent') return color;
  if (!(baseOpacity > 0)) return color;
  const ratio = Math.max(0, Math.min(1, fillOpacity / baseOpacity));
  if (ratio >= 1) return color;
  // Alleen hex-kleuren omzetten; andere notaties laten we met rust.
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${ratio})`;
}

// Add-ons may paint a background annotation before ordinary markups.
function eachUnderlayFirst(list, page, draw) {
  for (const annotation of list) {
    if (annotation && annotation.page === page && edition.rendering?.isUnderlay?.(annotation)) draw(annotation);
  }
}
export function drawAnnotation(ctx, annotation, snippetBitmaps = null) {
  // ── Weergavefilters ────────────────────────────────────────────────────
  // Eén centraal predicaat (annotations/view-filters.js) bundelt de
  // per-annotatie `hidden`-vlag, het "Zichtbaarheid Elementen"-paneel
  // (hele soort verborgen) én het statusfilter van de annotatielijst
  // (Tonen > Status, #333). Dezelfde check slaat de hit-test over, zodat
  // wat niet getekend wordt ook niet aanklikbaar is.
  // `_ignoreViewFilters` is voor de saver/AP-raster-route: opslaan is geen
  // weergave, een verborgen annotatie moet zijn appearance gewoon krijgen.
  // In een afdruk, export of printvoorbeeld (`_lagen` gezet door
  // renderAnnotationsForPage) blijft ook een niet-afdrukbare laag weg (#468).
  if (!annotation._ignoreViewFilters
      && (_lagen ? isAnnotationHiddenInOutput(annotation) : isAnnotationHiddenInView(annotation))) return;
  const _evHalftone = evHalftoneTypes().get(annotation.type) || null;

  // Use annotation's opacity property
  let baseOpacity = annotation.opacity !== undefined ? annotation.opacity :
                     (annotation.type === 'highlight' ? 0.3 : 1);

  // Use strokeColor/fillColor if available, otherwise fallback to color
  let strokeColor = annotation.strokeColor || annotation.color;
  let fillColor = annotation.fillColor || annotation.color;
  // Explicit "No Border" (Stroke Color picker's None option) — checked
  // against the raw field, since strokeColor above already fell back to
  // .color when unset (see hasStroke()'s doc comment).
  const annHasStroke = hasStroke(annotation.strokeColor);
  // 'none'/'transparent' isn't a paintable canvas color — keep strokeColor a
  // real color so anything that still uses ctx.strokeStyle unconditionally
  // (e.g. a box/circle's cross-diagonals) doesn't silently inherit a stale
  // strokeStyle from whatever was drawn before it. The outline itself is
  // still skipped via annHasStroke at each draw site below.
  if (!annHasStroke) strokeColor = annotation.color || '#000000';
  // Sanitized stand-in for `annotation.strokeColor` wherever code falls back
  // to it directly (leader lines, arrowheads) instead of the local
  // `strokeColor` — never 'none'/'transparent', so those parts (which aren't
  // "the border" and stay visible when the border is switched off) don't
  // inherit the sentinel.
  const rawStrokeColor = annHasStroke ? annotation.strokeColor : null;

  // Halftone-override: dim de soort en tint optioneel de kleuren. De tint
  // vervangt stroke/fill zodat de hele soort visueel als één laag oplicht
  // (Revit-achtige "halftone"). De opacity-factor wordt op de basisopacity
  // toegepast (multiplicatief) zodat een reeds-transparante annotatie niet
  // plots donkerder wordt.
  if (_evHalftone) {
    baseOpacity = baseOpacity * (_evHalftone.opacity ?? 0.35);
    if (_evHalftone.color) {
      strokeColor = _evHalftone.color;
      fillColor = _evHalftone.color;
    }
  }

  // Vulling met een eigen doorzichtigheid (PDF /ca in de graphics-state van de
  // appearance-stream, los van de lijn-alfa /CA). Komt veel voor bij kaart- en
  // GIS-exports: een gebied op 20% met een volledig dekkende rand. De canvas
  // heeft maar één globalAlpha, dus verrekenen we het verschil in de vulkleur
  // zelf: globalAlpha (= baseOpacity) maal de alfa in de rgba-kleur levert
  // precies de gevraagde vul-alfa op. Zonder eigen fillOpacity verandert er
  // niets — dan blijft de kleur de kale hex.
  const annFill = withFillAlpha(annotation.fillColor, annotation.fillOpacity, baseOpacity);
  fillColor = withFillAlpha(fillColor, annotation.fillOpacity, baseOpacity);

  ctx.strokeStyle = strokeColor;
  ctx.fillStyle = fillColor;
  let lw = annotation.lineWidth ?? 3;
  // Ensure a minimum visible stroke when there's no fill, so the annotation stays visible
  const annHasFill = hasFill(annotation.fillColor);
  if (lw === 0 && !annHasFill) lw = 0.5;
  lw = thinLw(lw);
  ctx.lineWidth = lw;
  ctx.globalAlpha = baseOpacity;
  ctx.globalCompositeOperation = annotation.blendMode === 'multiply' ? 'multiply' : 'source-over';

  switch (annotation.type) {
    case 'draw':
      ctx.strokeStyle = strokeColor;
      applyBorderStyle(ctx, annotation.borderStyle);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      annotation.path.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();
      ctx.setLineDash([]);
      break;

    case 'highlight':
      ctx.fillStyle = fillColor;
      ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
      break;

    case 'line':
      // Eigen lijnstijl (line-styles.js): vervangt de kale lijn.
      if (tekenLijnstijl(ctx, annotation, [{ x: annotation.startX, y: annotation.startY },
        { x: annotation.endX, y: annotation.endY }], strokeColor, thinLw)) break;
      ctx.strokeStyle = strokeColor;
      ctx.lineCap = 'butt';
      applyBorderStyle(ctx, annotation.borderStyle);
      ctx.beginPath();
      ctx.moveTo(annotation.startX, annotation.startY);
      ctx.lineTo(annotation.endX, annotation.endY);
      ctx.stroke();
      ctx.setLineDash([]);
      break;

    case 'arrow': {
      // Draw arrow onto offscreen canvas at full opacity to avoid overlap artifacts,
      // then composite onto main canvas with the desired opacity
      const arrowFillColor = annotation.fillColor || strokeColor;
      const endHead = annotation.endHead || 'open';
      const startHead = annotation.startHead || 'none';
      const headSize = annotation.headSize || 8;
      let lw = annotation.lineWidth ?? 3;
      if (lw === 0) lw = 0.5;
      lw = thinLw(lw);

      // Calculate bounding box with padding for arrowheads
      const pad = headSize + lw + 2;
      const minAX = Math.min(annotation.startX, annotation.endX) - pad;
      const minAY = Math.min(annotation.startY, annotation.endY) - pad;
      const maxAX = Math.max(annotation.startX, annotation.endX) + pad;
      const maxAY = Math.max(annotation.startY, annotation.endY) + pad;
      const offW = maxAX - minAX;
      const offH = maxAY - minAY;

      // The offscreen copy only matters when overlap shows: a translucent or
      // multiply arrow would darken where line and head meet. An opaque,
      // normal arrow draws straight onto the canvas: sharp at every dpr, and
      // no canvas allocated per arrow on every pan and drag frame.
      const direct = ctx.globalAlpha >= 1 && ctx.globalCompositeOperation === 'source-over'
        && !(ctx.shadowBlur > 0) && (!ctx.filter || ctx.filter === 'none');
      let offCanvas = null;
      let offCtx = ctx;
      if (direct) {
        ctx.save();
      } else {
        // Scaled resolution to avoid pixelation when zoomed, capped so a long
        // arrow at a deep zoom stays within canvas limits.
        const arrowDoc = state.documents[state.activeDocumentIndex];
        const arrowScaleWens = (arrowDoc ? arrowDoc.scale : 1) || 1;
        const arrowScale = Math.min(arrowScaleWens, 4096 / Math.max(offW, offH, 1));
        offCanvas = pijlKladblok();
        offCanvas.width = Math.max(1, Math.ceil(offW * arrowScale));
        offCanvas.height = Math.max(1, Math.ceil(offH * arrowScale));
        offCtx = offCanvas.getContext('2d');
        // Scale and translate so coordinates match document space
        offCtx.scale(arrowScale, arrowScale);
        offCtx.translate(-minAX, -minAY);
      }
      offCtx.strokeStyle = strokeColor;
      offCtx.fillStyle = arrowFillColor;
      offCtx.lineWidth = lw;
      offCtx.lineCap = 'butt';
      offCtx.lineJoin = 'miter';

      applyBorderStyle(offCtx, annotation.borderStyle);

      // Shorten line so it stops at the arrowhead. The amount depends on
      // whether the head is FILLED (closed, diamond, square, circle) or
      // OPEN/STROKED (open, stealth, openReversed, butt, slash, openCircle):
      //   • Filled head: shorten by full headSize so the line ends at the
      //     base of the triangle (no overlap → no double-thickness halo).
      //   • Open head: the V is hollow — if we shorten by full headSize the
      //     line ends BELOW the V base and you see a visible gap inside the
      //     V. Use a tiny shortening (just enough to keep the line tip from
      //     poking past the V tip with thick strokes).
      const FILLED_HEADS = new Set(['closed', 'closedReversed', 'diamond', 'square', 'circle']);
      // A closed head without /IC from another program is hollow: the line
      // runs into it like into an open head.
      const isHeadFilled = (s) => FILLED_HEADS.has(s) && annotation.headFill !== false;
      const aDx = annotation.endX - annotation.startX;
      const aDy = annotation.endY - annotation.startY;
      const aLen = Math.sqrt(aDx * aDx + aDy * aDy);
      let lineStartX = annotation.startX, lineStartY = annotation.startY;
      let lineEndX = annotation.endX, lineEndY = annotation.endY;
      if (aLen > 0) {
        const ux = aDx / aLen, uy = aDy / aLen;
        if (endHead !== 'none') {
          const off = isHeadFilled(endHead) ? headSize : Math.min(lw * 0.5, 1);
          lineEndX -= ux * off;
          lineEndY -= uy * off;
        }
        if (startHead !== 'none') {
          const off = isHeadFilled(startHead) ? headSize : Math.min(lw * 0.5, 1);
          lineStartX += ux * off;
          lineStartY += uy * off;
        }
      }

      offCtx.beginPath();
      offCtx.moveTo(lineStartX, lineStartY);
      offCtx.lineTo(lineEndX, lineEndY);
      offCtx.stroke();

      offCtx.setLineDash([]);

      if (endHead !== 'none') {
        const endAngle = Math.atan2(aDy, aDx);
        drawArrowheadOnCanvas(offCtx, annotation.endX, annotation.endY, endAngle, headSize, endHead, { hol: annotation.headFill === false });
      }

      if (startHead !== 'none') {
        const startAngle = Math.atan2(-aDy, -aDx);
        drawArrowheadOnCanvas(offCtx, annotation.startX, annotation.startY, startAngle, headSize, startHead, { hol: annotation.headFill === false });
      }

      if (direct) {
        ctx.restore();
      } else {
        // Composite the offscreen arrow onto the main canvas with opacity
        ctx.drawImage(offCanvas, 0, 0, offCanvas.width, offCanvas.height, minAX, minAY, offW, offH);
      }
      break;
    }

    case 'arc': {
      if (tekenLijnstijl(ctx, annotation, arcPolylinePoints(annotation), strokeColor, thinLw)) break;
      ctx.beginPath();
      ctx.arc(annotation.centerX, annotation.centerY, annotation.radius, annotation.startAngle, annotation.endAngle);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lw;
      applyBorderStyle(ctx, annotation.borderStyle);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }

    case 'spline': {
      if (annotation.controlPoints && annotation.controlPoints.length >= 3) {
        const samples = catmullRomSpline(annotation.controlPoints, 16);
        if (tekenLijnstijl(ctx, annotation, samples, strokeColor, thinLw)) break;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lw;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        applyBorderStyle(ctx, annotation.borderStyle);
        ctx.beginPath();
        ctx.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) {
          ctx.lineTo(samples[i].x, samples[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      break;
    }

    case 'polyline':
      if (annotation.points && annotation.points.length >= 2) {
        if (tekenLijnstijl(ctx, annotation, annotation.points, strokeColor, thinLw)) break;
        ctx.strokeStyle = strokeColor;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        applyBorderStyle(ctx, annotation.borderStyle);
        ctx.beginPath();
        annotation.points.forEach((point, index) => {
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
      break;

    case 'splineArrow': {
      // Curved (spline) arrow — smooth Catmull-Rom curve through the clicked
      // points with an arrowhead at the last point along the end tangent.
      const saPts = annotation.points;
      if (saPts && saPts.length >= 2) {
        const segs = catmullRomToBezier(saPts);
        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = annFill || strokeColor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        applyBorderStyle(ctx, annotation.borderStyle);
        if (segs.length) {
          ctx.beginPath();
          ctx.moveTo(segs[0].x0, segs[0].y0);
          for (const s of segs) ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x1, s.y1);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        // Arrowheads at end (and optionally start) of the curve.
        const saHeadSize = annotation.headSize || 8;
        const saEndHead = annotation.endHead || 'open';
        const saStartHead = annotation.startHead || 'none';
        if (saEndHead !== 'none') {
          const tip = saPts[saPts.length - 1];
          drawArrowheadOnCanvas(ctx, tip.x, tip.y, splineArrowEndTangent(saPts), saHeadSize, saEndHead);
        }
        if (saStartHead !== 'none') {
          const startTip = saPts[0];
          const revAngle = splineArrowEndTangent([...saPts].reverse());
          drawArrowheadOnCanvas(ctx, startTip.x, startTip.y, revAngle, saHeadSize, saStartHead);
        }
      }
      break;
    }

    case 'circle':
      // Draw ellipse that fits in bounding box
      const ellipseX = annotation.x;
      const ellipseY = annotation.y;
      const ellipseW = annotation.width || annotation.radius * 2;
      const ellipseH = annotation.height || annotation.radius * 2;
      const ellipseCX = ellipseX + ellipseW / 2;
      const ellipseCY = ellipseY + ellipseH / 2;

      ctx.save();
      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        ctx.translate(ellipseCX, ellipseCY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-ellipseCX, -ellipseCY);
      }

      ctx.beginPath();
      ctx.ellipse(ellipseCX, ellipseCY, Math.abs(ellipseW / 2), Math.abs(ellipseH / 2), 0, 0, 2 * Math.PI);

      // Fill if fillColor is set and not 'none'
      if (annotation.fillColor && annotation.fillColor !== 'none' && annotation.fillColor !== null) {
        ctx.fillStyle = annFill;
        ctx.fill();
      }

      // Hatch pattern fill
      if (annotation.hatchPattern && annotation.hatchPattern !== 'none') {
        ctx.beginPath();
        ctx.ellipse(ellipseCX, ellipseCY, Math.abs(ellipseW / 2), Math.abs(ellipseH / 2), 0, 0, 2 * Math.PI);
        applyHatchFill(ctx, annotation);
      }

      ctx.strokeStyle = strokeColor;
      applyBorderStyle(ctx, annotation.borderStyle);
      if (annHasStroke) {
        ctx.beginPath();
        ctx.ellipse(ellipseCX, ellipseCY, Math.abs(ellipseW / 2), Math.abs(ellipseH / 2), 0, 0, 2 * Math.PI);
        ctx.stroke();
      }
      // Kruis (rond gat / sparing): lijnen onder ±45° door het middelpunt tot
      // de omtrek, in dezelfde lijnstijl als de omtrek.
      if (annotation.cross) {
        ctx.beginPath();
        for (const l of kruisEindpuntenEllips(ellipseCX, ellipseCY, ellipseW / 2, ellipseH / 2)) {
          ctx.moveTo(l.x1, l.y1);
          ctx.lineTo(l.x2, l.y2);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      edition.rendering?.drawCaption?.(ctx, annotation);
      ctx.restore();
      break;

    case 'mask': {
      // Maskeer (wipeout): ALWAYS fully opaque white — its whole purpose is
      // hiding what's underneath, so the opacity property must not leak in.
      ctx.save();
      ctx.globalAlpha = 1;
      if (annotation.rotation) {
        const mCX = annotation.x + annotation.width / 2;
        const mCY = annotation.y + annotation.height / 2;
        ctx.translate(mCX, mCY);
        ctx.rotate(annotation.rotation * Math.PI / 180);
        ctx.translate(-mCX, -mCY);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
      // Only ONE edge carries the dash-dot hint line; the other three sides are
      // borderless, so the mask reads as a clean cover with a single marked side.
      // Which side is configurable via `maskDashSide` (top/right/bottom/left).
      ctx.strokeStyle = annotation.strokeColor || '#9a9a9a';
      ctx.lineWidth = thinLw(annotation.lineWidth || 0.75);
      applyBorderStyle(ctx, annotation.borderStyle || 'dash-dot');
      const _mx0 = annotation.x, _my0 = annotation.y;
      const _mx1 = annotation.x + annotation.width, _my1 = annotation.y + annotation.height;
      ctx.beginPath();
      switch (annotation.maskDashSide || 'left') {
        case 'top':    ctx.moveTo(_mx0, _my0); ctx.lineTo(_mx1, _my0); break;
        case 'right':  ctx.moveTo(_mx1, _my0); ctx.lineTo(_mx1, _my1); break;
        case 'bottom': ctx.moveTo(_mx0, _my1); ctx.lineTo(_mx1, _my1); break;
        default:       ctx.moveTo(_mx0, _my0); ctx.lineTo(_mx0, _my1); break; // left
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      break;
    }

    case 'box':
      ctx.save();
      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        const boxCenterX = annotation.x + annotation.width / 2;
        const boxCenterY = annotation.y + annotation.height / 2;
        ctx.translate(boxCenterX, boxCenterY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-boxCenterX, -boxCenterY);
      }

      const boxShape = edition.rendering?.boxShape?.(annotation) || null;
      const boxPath = () => {
        ctx.beginPath();
        if (!boxShape) { ctx.rect(annotation.x, annotation.y, annotation.width, annotation.height); return; }
        boxShape.forEach(([u, v], i) => {
          const px = annotation.x + u * annotation.width, py = annotation.y + v * annotation.height;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        });
        ctx.closePath();
      };

      // Fill if fillColor is set and not 'none'
      if (annotation.fillColor && annotation.fillColor !== 'none' && annotation.fillColor !== null) {
        ctx.fillStyle = annFill;
        boxPath();
        ctx.fill();
      }

      // Hatch pattern fill
      if (annotation.hatchPattern && annotation.hatchPattern !== 'none') {
        boxPath();
        applyHatchFill(ctx, annotation);
      }

      ctx.strokeStyle = strokeColor;
      applyBorderStyle(ctx, annotation.borderStyle);
      if (annHasStroke) { boxPath(); ctx.stroke(); }
      // Kruis: beide diagonalen, in dezelfde lijnstijl als de rand.
      if (annotation.cross) {
        ctx.beginPath();
        ctx.moveTo(annotation.x, annotation.y);
        ctx.lineTo(annotation.x + annotation.width, annotation.y + annotation.height);
        ctx.moveTo(annotation.x + annotation.width, annotation.y);
        ctx.lineTo(annotation.x, annotation.y + annotation.height);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      edition.rendering?.drawCaption?.(ctx, annotation);
      ctx.restore();
      break;

    case 'polygon':
      ctx.save();
      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        const polyCX = annotation.x + annotation.width / 2;
        const polyCY = annotation.y + annotation.height / 2;
        ctx.translate(polyCX, polyCY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-polyCX, -polyCY);
      }
      // Imported /Polygon annotations carry their real vertices; the
      // regular-N-gon fallback is only for polygons drawn with the shape tool.
      const polyHasPoints = Array.isArray(annotation.points) && annotation.points.length >= 3;
      const buildPolyPath = () => {
        if (polyHasPoints) {
          buildPolygonPointsPath(ctx, annotation.points, annotation.x, annotation.y, annotation.width, annotation.height);
        } else {
          buildPolygonPath(ctx, annotation.x, annotation.y, annotation.width, annotation.height, annotation.sides || 6);
        }
      };

      if (edition.rendering?.drawPolygon?.(ctx, annotation, buildPolyPath)) { ctx.restore(); break; }
      // Fill if fillColor is set
      if (annotation.fillColor && annotation.fillColor !== 'none' && annotation.fillColor !== null) {
        buildPolyPath();
        ctx.fillStyle = annFill;
        ctx.fill();
      }

      // Hatch pattern fill
      if (annotation.hatchPattern && annotation.hatchPattern !== 'none') {
        buildPolyPath();
        applyHatchFill(ctx, annotation);
      }

      ctx.strokeStyle = strokeColor;
      applyBorderStyle(ctx, annotation.borderStyle);
      if (annHasStroke) {
        buildPolyPath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
      break;

    case 'cloud': {
      ctx.save();
      const cloudPoints = Array.isArray(annotation.points) && annotation.points.length >= 3
        ? annotation.points : null;
      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        const cloudCX = annotation.x + annotation.width / 2;
        const cloudCY = annotation.y + annotation.height / 2;
        ctx.translate(cloudCX, cloudCY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-cloudCX, -cloudCY);
      }
      // Fill if fillColor is set
      if (annotation.fillColor && annotation.fillColor !== 'none' && annotation.fillColor !== null) {
        if (cloudPoints) buildCloudPolylinePath(ctx, cloudPoints, true);
        else buildCloudPath(ctx, annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.fillStyle = annFill;
        ctx.fill();
      }

      // Hatch pattern fill
      if (annotation.hatchPattern && annotation.hatchPattern !== 'none') {
        if (cloudPoints) buildCloudPolylinePath(ctx, cloudPoints, true);
        else buildCloudPath(ctx, annotation.x, annotation.y, annotation.width, annotation.height);
        applyHatchFill(ctx, annotation);
      }

      ctx.strokeStyle = strokeColor;
      if (annHasStroke) {
        if (cloudPoints) { buildCloudPolylinePath(ctx, cloudPoints, true); ctx.stroke(); }
        else drawCloudShape(ctx, annotation.x, annotation.y, annotation.width, annotation.height);
      }
      ctx.restore();
      break;
    }

    case 'cloudPolyline':
      if (annotation.points && annotation.points.length >= 2) {
        // Fill if fillColor is set
        if (annotation.fillColor && annotation.fillColor !== 'none' && annotation.fillColor !== null) {
          buildCloudPolylinePath(ctx, annotation.points, true);
          ctx.fillStyle = annFill;
          ctx.fill();
        }
        // Hatch pattern fill
        if (annotation.hatchPattern && annotation.hatchPattern !== 'none') {
          buildCloudPolylinePath(ctx, annotation.points, true);
          applyHatchFill(ctx, annotation);
        }
        ctx.strokeStyle = strokeColor;
        buildCloudPolylinePath(ctx, annotation.points, true);
        ctx.stroke();
      }
      break;

    case 'comment': {
      // Draw comment icon using proper vector icon rendering
      const cSize = annotation.width || 24;
      const iconCX = annotation.x + cSize / 2;
      const iconCY = annotation.y + cSize / 2;

      // Draw leader triangle from icon to popup
      if (annotation.popupOpen && annotation._popupFocused) {
        const popX = annotation.popupX !== undefined ? annotation.popupX : annotation.x + 30;
        const popY = annotation.popupY !== undefined ? annotation.popupY : annotation.y;

        const doc = state.documents[state.activeDocumentIndex];
        const scl = (doc ? doc.scale : 1) || 1;
        // De popup is een rechtop staand schermvenster met zijn linkerbovenhoek
        // op (popupX, popupY). Bij een gedraaide weergave (#200) ligt dat vak in
        // de paginaruimte anders: via de weergave terugrekenen.
        let popBox = { x: popX, y: popY, width: 230 / scl, height: 150 / scl };
        if (doc?.viewRotation) {
          const hoek = paginaNaarWeergave(annotation.page, popX, popY, doc);
          popBox = weergaveRectNaarPagina(annotation.page, { x: hoek.x, y: hoek.y, width: popBox.width, height: popBox.height }, doc);
        }
        const popW = popBox.width;
        const popH = popBox.height;

        // Popup center
        const cx = popBox.x + popW / 2;
        const cy = popBox.y + popH / 2;

        // Direction from popup center to icon
        const dx = iconCX - cx;
        const dy = iconCY - cy;

        // Line-rect intersection: find where line from center to icon hits popup edge
        const sx = dx !== 0 ? (popW / 2) / Math.abs(dx) : Infinity;
        const sy = dy !== 0 ? (popH / 2) / Math.abs(dy) : Infinity;
        const s = Math.min(sx, sy);
        if (s >= 1) break; // icon is inside popup, skip leader

        const edgeX = cx + dx * s;
        const edgeY = cy + dy * s;

        // Distance from icon to edge
        const eDx = edgeX - iconCX;
        const eDy = edgeY - iconCY;
        const edgeDist = Math.sqrt(eDx * eDx + eDy * eDy);
        if (edgeDist < cSize * 0.5) break; // too close

        // Unit direction from icon toward popup center
        const udx = eDx / edgeDist;
        const udy = eDy / edgeDist;

        // Target point: 15px past the edge into the popup interior
        const inset = 15 / scl;
        const tgtX = edgeX + udx * inset;
        const tgtY = edgeY + udy * inset;

        // Perpendicular spread (always same visual width)
        const perpX = -udy;
        const perpY = udx;
        const spread = 7 / scl;

        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.moveTo(iconCX, iconCY);
        ctx.lineTo(tgtX + perpX * spread, tgtY + perpY * spread);
        ctx.lineTo(tgtX - perpX * spread, tgtY - perpY * spread);
        ctx.closePath();
        ctx.fillStyle = fillColor || '#FFFF00';
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = baseOpacity;

      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        const cCenterX = iconCX;
        const cCenterY = iconCY;
        ctx.translate(cCenterX, cCenterY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-cCenterX, -cCenterY);
      }

      drawCommentIcon(ctx, annotation.icon, annotation.x, annotation.y, cSize, fillColor || '#FFFF00');

      ctx.restore();
      break;
    }

    case 'count': {
      const cx = annotation.x, cy = annotation.y;
      const col = annotation.color || annotation.strokeColor || '#e11d48';
      ctx.save();
      ctx.globalAlpha = annotation.opacity ?? 1;
      // A count symbol (symbols/count-symbols.js) with its number; the saver
      // records the same drawing as a vector appearance. An unknown symbol
      // id draws (and saves) the numbered dot.
      if (countUsesSymbol(annotation)) {
        drawCountSymbolMarker(ctx, annotation);
      } else {
        const r = 9;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(annotation.number ?? ''), cx, cy);
      }
      ctx.restore();
      break;
    }

    case 'text': {
      const txtRawFamily = annotation.fontFamily || 'Arial';
      // camelCase-expanded fallback chain — see comment in shapes.js drawTextboxContent.
      const _txtCssQuote = s => `"${s.replace(/"/g, '\\"')}"`;
      const _txtExpanded = txtRawFamily.replace(/([a-z])([A-Z])/g, '$1 $2');
      const _txtChain = [];
      if (_txtExpanded !== txtRawFamily) _txtChain.push(_txtCssQuote(_txtExpanded));
      _txtChain.push(/[\s"',]/.test(txtRawFamily) ? _txtCssQuote(txtRawFamily) : txtRawFamily);
      _txtChain.push('sans-serif');
      const txtFontFamily = _txtChain.join(', ');
      const txtFontStyle = (annotation.fontItalic ? 'italic ' : '') + (annotation.fontBold ? 'bold ' : '');
      const txtFontSize = annotation.fontSize || 16;
      ctx.fillStyle = annotation.color || '#000000';
      ctx.font = `${txtFontStyle}${txtFontSize}px ${txtFontFamily}`;
      // Base direction follows the first strong-directional character (dir="auto",
      // issue #61/#255) so Arabic/Hebrew keeps correct bidi ordering of mixed and
      // neutral characters. Alignment/anchor is left unchanged for this point-text.
      ctx.direction = isRTLText(annotation.text) ? 'rtl' : 'ltr';
      ctx.textAlign = annotation.textAlign || 'left';

      const lines = (annotation.text || '').split('\n');
      let txtY = annotation.y;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], annotation.x, txtY);
        if (annotation.fontUnderline) {
          const lineWidth = ctx.measureText(lines[i]).width;
          let underlineX = annotation.x;
          if (annotation.textAlign === 'center') underlineX -= lineWidth / 2;
          else if (annotation.textAlign === 'right') underlineX -= lineWidth;
          ctx.beginPath();
          ctx.moveTo(underlineX, txtY + 2);
          ctx.lineTo(underlineX + lineWidth, txtY + 2);
          ctx.strokeStyle = annotation.color || '#000000';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        txtY += txtFontSize * 1.3;
      }
      ctx.textAlign = 'left';
      ctx.direction = 'ltr'; // Reset base direction for subsequent draws
      break;
    }

    case 'textbox':
      // Draw text box with border and optional fill
      const tbWidth = annotation.width || 150;
      const tbHeight = annotation.height || 50;
      const tbLineWidth = thinLw(annotation.lineWidth !== undefined ? annotation.lineWidth : 1);
      const tbBorderStyle = annotation.borderStyle || 'solid';

      ctx.save();
      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        const tbCenterX = annotation.x + tbWidth / 2;
        const tbCenterY = annotation.y + tbHeight / 2;
        ctx.translate(tbCenterX, tbCenterY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-tbCenterX, -tbCenterY);
      }

      // Draw fill (wolkrand-annotaties vullen het scallop-pad i.p.v. de rect)
      const tbPuff = cloudPuffSize(annotation);
      if (hasFill(annotation.fillColor)) {
        ctx.fillStyle = annFill;
        if (annotation.borderEffect === 'cloudy') {
          buildCloudPath(ctx, annotation.x, annotation.y, tbWidth, tbHeight, tbPuff);
          ctx.fill();
        } else {
          ctx.fillRect(annotation.x, annotation.y, tbWidth, tbHeight);
        }
      }

      // Draw border with style
      if (tbLineWidth > 0 && annHasStroke) {
        ctx.strokeStyle = rawStrokeColor || strokeColor;
        ctx.lineWidth = tbLineWidth;
        applyBorderStyle(ctx, tbBorderStyle);
        if (annotation.borderEffect === 'cloudy') {
          buildCloudPath(ctx, annotation.x, annotation.y, tbWidth, tbHeight, tbPuff);
          ctx.stroke();
        } else {
          ctx.strokeRect(annotation.x, annotation.y, tbWidth, tbHeight);
        }
        ctx.setLineDash([]);
      }

      // Allow text to overflow slightly beyond textbox bounds
      // (other PDF viewers show overflow text; hard clipping hides words at edges).
      // Een typemachine-tekst knipt niet: zie tekstvakKnipvlak.
      const tbKnip = tekstvakKnipvlak(annotation, tbWidth, tbHeight);
      if (tbKnip) {
        ctx.beginPath();
        ctx.rect(tbKnip.x, tbKnip.y, tbKnip.width, tbKnip.height);
        ctx.clip();
      }

      // Draw text content
      drawTextboxContent(ctx, annotation);
      ctx.restore();

      // Draw leaders (multi-leader generalisation of callout)
      if (Array.isArray(annotation.leaders) && annotation.leaders.length > 0) {
        const _ldrStroke = rawStrokeColor || strokeColor || '#000000';
        const _ldrLw = thinLw(annotation.lineWidth !== undefined ? annotation.lineWidth : 1) || 1;
        for (const leader of annotation.leaders) {
          drawTextboxLeader(ctx, annotation, leader, _ldrStroke, _ldrLw);
        }
      }
      break;

    case 'callout':
      // Draw callout annotation (text box with two-segment leader line)
      const coWidth = annotation.width || 150;
      const coHeight = annotation.height || 50;
      const coLineWidth = thinLw(annotation.lineWidth !== undefined ? annotation.lineWidth : 1);
      const coBorderStyle = annotation.borderStyle || 'solid';

      // Set stroke style for leader line and border
      ctx.strokeStyle = rawStrokeColor || strokeColor;
      ctx.lineWidth = coLineWidth > 0 ? coLineWidth : 1;
      applyBorderStyle(ctx, coBorderStyle);

      // Arrow tip position
      const arrowX = annotation.arrowX !== undefined ? annotation.arrowX : annotation.x - 60;
      const arrowY = annotation.arrowY !== undefined ? annotation.arrowY : annotation.y + coHeight;

      // Knee point
      const kneeX = annotation.kneeX !== undefined ? annotation.kneeX : annotation.x - 30;
      const kneeY = annotation.kneeY !== undefined ? annotation.kneeY : annotation.y + coHeight / 2;

      // Arm origin (connection point on text box edge)
      let armOriginX, armOriginY;
      if (annotation.armOriginX !== undefined && annotation.armOriginY !== undefined) {
        armOriginX = annotation.armOriginX;
        armOriginY = annotation.armOriginY;
      } else {
        if (arrowX < annotation.x + coWidth / 2) {
          armOriginX = annotation.x;
        } else {
          armOriginX = annotation.x + coWidth;
        }
        armOriginY = kneeY;
      }

      // Draw the leader line (not rotated - arrow stays in place).
      // 'curved' leader = vloeiende Catmull-Rom-spline door
      // [armOrigin, knee, arrowTip] i.p.v. twee rechte segmenten (ronde aanhaallijn).
      const coCurved = annotation.leaderStyle === 'curved';
      let angle;
      ctx.beginPath();
      if (coCurved) {
        const coLeaderPts = [
          { x: armOriginX, y: armOriginY },
          { x: kneeX, y: kneeY },
          { x: arrowX, y: arrowY },
        ];
        const coSegs = catmullRomToBezier(coLeaderPts);
        ctx.moveTo(armOriginX, armOriginY);
        for (const s of coSegs) {
          ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x1, s.y1);
        }
        ctx.stroke();
        angle = splineArrowEndTangent(coLeaderPts);
      } else {
        ctx.moveTo(armOriginX, armOriginY);
        ctx.lineTo(kneeX, kneeY);
        ctx.lineTo(arrowX, arrowY);
        ctx.stroke();
        angle = Math.atan2(arrowY - kneeY, arrowX - kneeX);
      }

      // Draw arrowhead — filled (closed) by default, but honor explicit per-annotation style if set
      ctx.fillStyle = rawStrokeColor || strokeColor;
      drawArrowheadOnCanvas(ctx, arrowX, arrowY, angle, annotation.headSize || 7, annotation.arrowStyle || 'closed');

      ctx.save();
      if (annotation.rotation || annotation.flipX || annotation.flipY) {
        const coCenterX = annotation.x + coWidth / 2;
        const coCenterY = annotation.y + coHeight / 2;
        ctx.translate(coCenterX, coCenterY);
        if (annotation.rotation) ctx.rotate(annotation.rotation * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-coCenterX, -coCenterY);
      }

      // Draw fill (wolkrand-callouts vullen het scallop-pad i.p.v. de rect)
      const coPuff = cloudPuffSize(annotation);
      if (hasFill(annotation.fillColor)) {
        ctx.fillStyle = annFill;
        if (annotation.borderEffect === 'cloudy') {
          buildCloudPath(ctx, annotation.x, annotation.y, coWidth, coHeight, coPuff);
          ctx.fill();
        } else {
          ctx.fillRect(annotation.x, annotation.y, coWidth, coHeight);
        }
      }

      // Draw border with style
      if (coLineWidth > 0 && annHasStroke) {
        ctx.strokeStyle = rawStrokeColor || strokeColor;
        ctx.lineWidth = coLineWidth;
        applyBorderStyle(ctx, coBorderStyle);
        if (annotation.borderEffect === 'cloudy') {
          buildCloudPath(ctx, annotation.x, annotation.y, coWidth, coHeight, coPuff);
          ctx.stroke();
        } else {
          ctx.strokeRect(annotation.x, annotation.y, coWidth, coHeight);
        }
        ctx.setLineDash([]);
      }

      // Draw text content
      drawTextboxContent(ctx, annotation);
      ctx.restore();
      break;

    // Vectorknipsel: in het bestand vector, op het scherm raster — net als de
    // paginaweergave zelf. bitmapVoor levert het scherpste niveau dat er nu is
    // en vraagt op de achtergrond een scherper niveau aan.
    case 'vectorSnippet': {
      const vpz = window.__pdfViewport;
      const zoom = (vpz && vpz.active)
        ? vpz.zoom
        : (state.documents[state.activeDocumentIndex]?.scale || 1);
      const bmp = snippetBitmaps ? snippetBitmaps.get(annotation) : bitmapVoor(annotation, zoom);
      if (snippetBitmaps && !bmp) throw new Error('Vectorknipsel ontbreekt in uitvoer');
      ctx.save();
      const kcx = annotation.x + annotation.width / 2;
      const kcy = annotation.y + annotation.height / 2;
      ctx.translate(kcx, kcy);
      if (annotation.rotation) ctx.rotate((annotation.rotation || 0) * Math.PI / 180);
      ctx.translate(-kcx, -kcy);
      if (annotation.opacity !== undefined) ctx.globalAlpha = annotation.opacity;
      if (bmp) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, annotation.x, annotation.y, annotation.width, annotation.height);
      } else {
        // Nog geen tegel: een kader met de herkomst, zodat je ziet dat er iets
        // staat en waar het vandaan komt.
        const eenheid = 1 / (zoom || 1);
        ctx.strokeStyle = '#1565c0';
        ctx.fillStyle = 'rgba(21, 101, 192, 0.06)';
        ctx.lineWidth = 1 * eenheid;
        ctx.setLineDash([5 * eenheid, 3 * eenheid]);
        ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.setLineDash([]);
        if (annotation.srcLabel) {
          ctx.fillStyle = '#1565c0';
          ctx.font = `${11 * eenheid}px sans-serif`;
          ctx.fillText(annotation.srcLabel, annotation.x + 4 * eenheid, annotation.y + 14 * eenheid);
        }
      }
      ctx.restore();
      break;
    }

    case 'image':
      // Draw image with rotation and flip
      const img = imageCache.get(annotation.imageId);
      if (img && img.complete) {
        ctx.save();

        // Move to center of image for rotation and flip
        const centerX = annotation.x + annotation.width / 2;
        const centerY = annotation.y + annotation.height / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate((annotation.rotation || 0) * Math.PI / 180);

        // Apply flip transformations
        const scaleX = annotation.flipX ? -1 : 1;
        const scaleY = annotation.flipY ? -1 : 1;
        ctx.scale(scaleX, scaleY);

        // High-quality image scaling. Canvas defaults to
        // imageSmoothingQuality='low' (cheap bilinear) which produces a
        // visibly grainy/blurry result when source ≠ destination — and
        // for image annotations the destination is almost ALWAYS scaled
        // (zoom + DPR + initial 1500px cap). 'high' uses a much better
        // resampler (Lanczos-ish on Chromium) at negligible cost for
        // single-shot drawImage in the annotation layer.
        const prevSmooth = ctx.imageSmoothingEnabled;
        const prevQuality = ctx.imageSmoothingQuality;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Non-destructive Word-style adjustments (grayscale / brightness /
        // contrast). Stored on the annotation, applied here via the canvas
        // `filter` property. brightness/contrast are 0-2 (1 = neutral);
        // grayscale is a boolean. Composed into a single filter string.
        const _imgFilters = imageFilterString(annotation);
        const _prevFilter = ctx.filter;
        if (_imgFilters) ctx.filter = _imgFilters;

        // Draw the image centered at origin, combining two independent
        // features: a compare-overlay colour tint (multiply, alpha-preserving —
        // see getTintedImage) AND non-destructive crop (#212). cropLeft/Top/
        // Right/Bottom are fractions 0-1 of the SOURCE trimmed per side; the
        // remaining source window maps onto the full annotation rect.
        const imgTint = annotation.tintColor;
        const imgSrc = (imgTint && imgTint !== 'none') ? getTintedImage(img, imgTint) : img;
        const cropL = Math.max(0, Math.min(0.95, annotation.cropLeft || 0));
        const cropT = Math.max(0, Math.min(0.95, annotation.cropTop || 0));
        const cropR = Math.max(0, Math.min(0.95, annotation.cropRight || 0));
        const cropB = Math.max(0, Math.min(0.95, annotation.cropBottom || 0));
        const cropW = 1 - cropL - cropR;
        const cropH = 1 - cropT - cropB;
        // getTintedImage returns a canvas (uses .width); a raw image uses
        // .naturalWidth — support both so crop works with and without tint.
        const srcW = imgSrc.naturalWidth || imgSrc.width || 0;
        const srcH = imgSrc.naturalHeight || imgSrc.height || 0;
        if (laag('bewerkhulp') && activeCropAnnotation()?.id === annotation.id && srcW > 0 && srcH > 0) {
          // Bijsnij-modus: de VOLLEDIGE bron tekenen op het vak waar hij
          // hoort, zodat de weggesneden rand (gedimd door de overlay)
          // zichtbaar blijft en een greep weer naar buiten kan. De
          // rechthoek is het venster op dat vak (zie crop-geometrie.js).
          const vak = cropVolledigVak(
            { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height },
            cropFracties(annotation),
          );
          const cxA = annotation.x + annotation.width / 2;
          const cyA = annotation.y + annotation.height / 2;
          ctx.drawImage(imgSrc, vak.x - cxA, vak.y - cyA, vak.w, vak.h);
        } else if ((cropL || cropT || cropR || cropB) && cropW > 0 && cropH > 0 && srcW > 0 && srcH > 0) {
          ctx.drawImage(imgSrc,
            srcW * cropL, srcH * cropT, srcW * cropW, srcH * cropH,
            -annotation.width / 2, -annotation.height / 2, annotation.width, annotation.height);
        } else {
          ctx.drawImage(imgSrc, -annotation.width / 2, -annotation.height / 2, annotation.width, annotation.height);
        }

        ctx.imageSmoothingEnabled = prevSmooth;
        ctx.imageSmoothingQuality = prevQuality;
        if (_imgFilters) ctx.filter = _prevFilter;

        ctx.restore();
      } else {
        // Draw placeholder while loading
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.strokeStyle = '#ccc';
        ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.fillStyle = '#999';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Loading...', annotation.x + annotation.width/2, annotation.y + annotation.height/2);
        ctx.textAlign = 'left';
      }
      break;

    case 'textHighlight':
      // Draw text highlight as a solid fill. The actual blending with the
      // underlying text happens via CSS `mix-blend-mode: multiply` on the
      // dedicated #text-highlight-canvas this is drawn onto. Drawing at full
      // alpha gives the cleanest multiply result.
      ctx.fillStyle = fillColor;
      ctx.globalAlpha = 1;
      if (annotation.rects && annotation.rects.length > 0) {
        annotation.rects.forEach(rect => {
          ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        });
      } else {
        ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
      }
      break;

    case 'textStrikethrough': {
      // Doorhaallijn door het midden van elk tekstvak; bij verticale tekst
      // (textDir 90/270) langs de tekst. De doorhaling van een vervanging
      // (#508) krijgt de kleur van haar invoegteken, zoals ze ook opgeslagen
      // wordt; een weergavetint gaat voor.
      const ouderKleur = _evHalftone?.color ? null
        : replaceStrikeColor(annotation, state.documents[state.activeDocumentIndex]?.annotations);
      ctx.strokeStyle = ouderKleur || strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);
      ctx.lineCap = 'round';
      if (annotation.rects && annotation.rects.length > 0) {
        annotation.rects.forEach(rect => {
          const [van, tot] = strikeLine(rect, annotation.textDir);
          ctx.beginPath();
          ctx.moveTo(van.x, van.y);
          ctx.lineTo(tot.x, tot.y);
          ctx.stroke();
        });
      } else {
        const [van, tot] = strikeLine(annotation, annotation.textDir);
        ctx.beginPath();
        ctx.moveTo(van.x, van.y);
        ctx.lineTo(tot.x, tot.y);
        ctx.stroke();
      }
      break;
    }

    case 'caret':
      // Invoegteken (#508): dezelfde vorm als zijn appearance in de PDF.
      drawCaret(ctx, annotation, fillColor);
      break;

    case 'textUnderline':
      // Draw underline at the bottom of each text rect
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);
      ctx.lineCap = 'round';
      if (annotation.rects && annotation.rects.length > 0) {
        annotation.rects.forEach(rect => {
          const bottomY = rect.y + rect.height - 1;
          ctx.beginPath();
          ctx.moveTo(rect.x, bottomY);
          ctx.lineTo(rect.x + rect.width, bottomY);
          ctx.stroke();
        });
      } else {
        const bottomY = annotation.y + annotation.height - 1;
        ctx.beginPath();
        ctx.moveTo(annotation.x, bottomY);
        ctx.lineTo(annotation.x + annotation.width, bottomY);
        ctx.stroke();
      }
      break;

    case 'stamp': {
      // Dynamic stamp (docs/reference/editor/markup-tools.md): drawn from its design, as the PDF
      // appearance draws it.
      if (annotation.stampDesign) {
        ctx.save();
        ctx.translate(annotation.x + annotation.width / 2, annotation.y + annotation.height / 2);
        ctx.rotate((annotation.rotation || 0) * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.translate(-annotation.width / 2, -annotation.height / 2);
        drawStampDesign(ctx, annotation.stampDesign, annotation.width, annotation.height,
          { onImageLoad: () => redrawAnnotations() });
        ctx.restore();
        break;
      }
      // Render stamp - image or text-based
      // Always prefer global imageCache (plain Map, no Proxy) for reliable .complete checks.
      // SolidJS createMutable can wrap _cachedImg in a Proxy, breaking HTMLImageElement checks.
      let stampImg = annotation.imageId ? imageCache.get(annotation.imageId) : null;
      if (!stampImg && annotation._cachedImg) {
        // Unwrap potential SolidJS proxy by reading src and re-fetching from cache
        const raw = annotation._cachedImg;
        if (raw instanceof HTMLImageElement) stampImg = raw;
      }
      if (stampImg && stampImg.complete) {
        ctx.save();
        const cx = annotation.x + annotation.width / 2;
        const cy = annotation.y + annotation.height / 2;
        ctx.translate(cx, cy);
        ctx.rotate((annotation.rotation || 0) * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.drawImage(stampImg, -annotation.width / 2, -annotation.height / 2, annotation.width, annotation.height);
        ctx.restore();
      } else if (annotation.stampText) {
        // Text-based stamp
        ctx.save();
        const cx = annotation.x + annotation.width / 2;
        const cy = annotation.y + annotation.height / 2;
        ctx.translate(cx, cy);
        ctx.rotate((annotation.rotation || 0) * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);

        const color = annotation.stampColor || annotation.color || '#ef4444';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(-annotation.width / 2, -annotation.height / 2, annotation.width, annotation.height);

        ctx.fillStyle = color;
        ctx.font = `bold ${Math.min(annotation.height * 0.5, 24)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(annotation.stampText, 0, 0);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
      } else if (annotation.stampSvg) {
        // SVG fallback: rasterize on-the-fly when imageId is not yet in cache.
        // External <image href=URL> references must be inlined first so the
        // SVG-as-img security context doesn't show a broken-image placeholder
        // (e.g. NEN 1414 symbols).
        (async () => {
          let svgStr = annotation.stampSvg;
          if (/<image\b[^>]*\bhref=/i.test(svgStr)) {
            const hrefRegex = /(<image\b[^>]*\b(?:xlink:href|href)=)(["'])([^"']+)\2/gi;
            const matches = [...svgStr.matchAll(hrefRegex)];
            for (const m of matches) {
              const u = m[3];
              if (u.startsWith('data:')) continue;
              try {
                const res = await fetch(u);
                const b = await res.blob();
                const dataUrl = await new Promise((res2, rej) => {
                  const r = new FileReader();
                  r.onload = () => res2(r.result);
                  r.onerror = rej;
                  r.readAsDataURL(b);
                });
                svgStr = svgStr.replace(m[0], m[1] + m[2] + dataUrl + m[2]);
              } catch (_) {}
            }
          }
          const blob = new Blob([svgStr], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          const fallbackImg = new Image();
          fallbackImg.onload = () => {
            URL.revokeObjectURL(url);
            const cacheId = annotation.imageId || ('stamp_svg_' + annotation.id);
            imageCache.set(cacheId, fallbackImg);
            if (!annotation.imageId) annotation.imageId = cacheId;
            annotation._cachedImg = fallbackImg;
            redrawAnnotations();
          };
          fallbackImg.onerror = () => URL.revokeObjectURL(url);
          fallbackImg.src = url;
        })();
      }
      break;
    }

    case 'signature': {
      // Render signature image
      const sigImg = annotation.imageId ? imageCache.get(annotation.imageId) : null;
      if (sigImg && sigImg.complete) {
        ctx.save();
        const cx = annotation.x + annotation.width / 2;
        const cy = annotation.y + annotation.height / 2;
        ctx.translate(cx, cy);
        ctx.rotate((annotation.rotation || 0) * Math.PI / 180);
        if (annotation.flipX || annotation.flipY) ctx.scale(annotation.flipX ? -1 : 1, annotation.flipY ? -1 : 1);
        ctx.drawImage(sigImg, -annotation.width / 2, -annotation.height / 2, annotation.width, annotation.height);
        ctx.restore();
      } else {
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.strokeStyle = '#999';
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.setLineDash([]);
        ctx.fillStyle = '#999';
        ctx.font = '11px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Signature', annotation.x + annotation.width / 2, annotation.y + annotation.height / 2 + 4);
        ctx.textAlign = 'left';
      }
      break;
    }

    case 'wall': {
      // Plan-view wall segment with material hatch + mitred corner joins
      // (see rendering/walls.js). Needs sibling walls for the joins.
      const _wallDoc = state.documents[state.activeDocumentIndex];
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 0.7);
      drawWall(ctx, annotation, _wallDoc ? _wallDoc.annotations : []);
      break;
    }

    case 'parametricSymbol': {
      // Parametric symbol — driven by a template + params
      const template = getTemplate(annotation.symbolId);
      if (!template) {
        // Unknown symbol: draw a placeholder bbox
        ctx.save();
        ctx.strokeStyle = strokeColor;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.setLineDash([]);
        ctx.fillStyle = strokeColor;
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('? ' + (annotation.symbolId || ''), annotation.x + annotation.width / 2, annotation.y + annotation.height / 2);
        ctx.textAlign = 'left';
        ctx.restore();
        break;
      }
      // Een ruimtetag toont naam, nummer en oppervlakte van zijn ruimte
      // (ruimte-koppeling.js); andere symbolen hun eigen params.
      const cmds = template.render(tagWeergaveParams(annotation, getActiveDocument()?.annotations) || {}, {
        x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height
      }) || [];
      ctx.save();
      // Apply rotation around centre (consistent with stamp/signature)
      const cx = annotation.x + annotation.width / 2;
      const cy = annotation.y + annotation.height / 2;
      const rot = (annotation.rotation || 0) * Math.PI / 180;
      if (rot) {
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.translate(-cx, -cy);
      }
      // Lijndikte: eigen waarde of geërfd uit het tekeningtype (regelset).
      const basisLw = effectiveDraftingLineWidth(annotation);
      const lw = thinLw(basisLw);
      // Per opdracht: een vaste `lineWidth`, of `lineWidthFactor` als fractie
      // van de symbooldikte (kozijn: doorsnede vol, glas en draaicirkel dun).
      const cmdLw = (c) => {
        if (c.lineWidth != null) return c.lineWidth;          // vaste dikte, zoals altijd
        if (!(c.lineWidthFactor > 0)) return lw;
        return thinLw(symboolOpdrachtLijndikte(c, basisLw));
      };
      ctx.lineWidth = lw;
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      // Bij selectie kleuren de bewerkbare GETAL-labels blauw (klik opent de
      // inline invoer). De rects komen uit template.editableLabels in
      // ONgeroteerde coördinaten — hetzelfde frame als de cmds hier (de
      // rotatie zit al op de ctx), dus een simpele bevat-test volstaat.
      let hotLabelRects = null;
      if (inlineNumberHighlight(annotation)
          && typeof template.editableLabels === 'function') {
        try {
          hotLabelRects = (template.editableLabels(annotation.params || {}, annotation) || [])
            .filter(l => l?.rect && labelHasNumericField(template, l))
            .map(l => l.rect);
        } catch (_) { hotLabelRects = null; }
      }
      const inHotLabel = (x, y) => !!hotLabelRects && hotLabelRects.some(r =>
        x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
      for (const c of cmds) {
        if (!c) continue;
        switch (c.kind) {
          case 'line': {
            ctx.save();
            ctx.lineWidth = cmdLw(c);
            if (Array.isArray(c.dash)) ctx.setLineDash(c.dash);
            ctx.beginPath();
            ctx.moveTo(c.x1, c.y1);
            ctx.lineTo(c.x2, c.y2);
            ctx.stroke();
            ctx.restore();
            break;
          }
          case 'arc': {
            ctx.save();
            ctx.lineWidth = cmdLw(c);
            if (Array.isArray(c.dash)) ctx.setLineDash(c.dash);
            ctx.beginPath();
            ctx.arc(c.cx, c.cy, c.r, c.a0, c.a1, !!c.ccw);
            ctx.stroke();
            ctx.restore();
            break;
          }
          case 'circle': {
            ctx.save();
            // Per-cmd dikte (fijnwerk zoals het diameterteken van de
            // wapeningskorf); zonder eigen waarde geldt de annotatie-dikte.
            ctx.lineWidth = cmdLw(c);
            ctx.beginPath();
            ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
            break;
          }
          case 'polyline': {
            if (!Array.isArray(c.points) || c.points.length < 2) break;
            ctx.save();
            ctx.lineWidth = cmdLw(c);
            if (Array.isArray(c.dash)) ctx.setLineDash(c.dash);
            ctx.beginPath();
            ctx.moveTo(c.points[0].x, c.points[0].y);
            for (let i = 1; i < c.points.length; i++) ctx.lineTo(c.points[i].x, c.points[i].y);
            if (c.close) ctx.closePath();
            if (c.fill) {
              // fill may be `true` (symbol colour) or a CSS colour string.
              if (typeof c.fill === 'string') ctx.fillStyle = c.fill;
              ctx.fill();
            }
            ctx.stroke();
            ctx.restore();
            break;
          }
          case 'hatch': {
            // Pattern-hatched region: loops[0] = outer contour, loops 1..n =
            // holes (evenodd). Pattern ids come from the hatch catalog.
            // MATERIAL hatches are PAPER-FIXED: constant pitch on paper
            // (NEN drafting practice), independent of the region scale —
            // `scale` 100 = the standard pattern pitch, lower = denser.
            if (!Array.isArray(c.loops) || c.loops.length === 0) break;
            applyHatchFillPolygon(
              ctx, c.loops[0], c.loops.slice(1),
              c.pattern, c.color || strokeColor, c.scale ?? 100, c.angle ?? 0
            );
            break;
          }
          case 'zigzag': {
            // Insulation fill for an arbitrary closed loop: solid bg +
            // 60° triangle-wave spanning the loop's height (same look as
            // insulation walls). Clipped to the loop.
            if (!Array.isArray(c.loop) || c.loop.length < 3) break;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(c.loop[0].x, c.loop[0].y);
            for (let i = 1; i < c.loop.length; i++) ctx.lineTo(c.loop[i].x, c.loop[i].y);
            ctx.closePath();
            ctx.clip();
            let zx0 = Infinity, zy0 = Infinity, zx1 = -Infinity, zy1 = -Infinity;
            for (const p of c.loop) {
              if (p.x < zx0) zx0 = p.x; if (p.x > zx1) zx1 = p.x;
              if (p.y < zy0) zy0 = p.y; if (p.y > zy1) zy1 = p.y;
            }
            const zh = zy1 - zy0;
            if (c.bg) {
              ctx.fillStyle = c.bg;
              ctx.fill();
            }
            const amp = (zh / 2) * 0.92;
            const midY = (zy0 + zy1) / 2;
            const step = Math.max(zh / Math.tan(Math.PI / 3), 0.5);
            ctx.strokeStyle = c.color || strokeColor;
            ctx.lineWidth = Math.max(0.3, Math.min(0.6, zh * 0.012));
            ctx.beginPath();
            let zx = zx0 - step;
            let side = -1;
            ctx.moveTo(zx, midY + side * amp);
            while (zx < zx1 + step) {
              zx += step;
              side = -side;
              ctx.lineTo(zx, midY + side * amp);
            }
            ctx.stroke();
            ctx.restore();
            break;
          }
          case 'rings': {
            // Multiple closed loops as ONE path with an evenodd fill —
            // loops 2..n cut holes out of loop 1 (e.g. hollow-section walls
            // filled solid while the inside stays open).
            if (!Array.isArray(c.loops) || c.loops.length === 0) break;
            ctx.beginPath();
            for (const loop of c.loops) {
              if (!Array.isArray(loop) || loop.length < 3) continue;
              ctx.moveTo(loop[0].x, loop[0].y);
              for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
              ctx.closePath();
            }
            if (c.fill) ctx.fill('evenodd');
            if (c.stroke !== false) ctx.stroke();
            break;
          }
          case 'text': {
            ctx.save();
            ctx.font = `${c.bold ? 'bold ' : ''}${c.size || 12}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (inHotLabel(c.x, c.y)) ctx.fillStyle = EDITABLE_NUMBER_COLOR;
            ctx.fillText(c.text || '', c.x, c.y);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.restore();
            break;
          }
        }
      }
      ctx.restore();
      break;
    }

    case 'stavenreeks': {
      // Wapeningsstaven-reeks: reekslijn + N schuine poten die elk in een
      // gevulde punt eindigen + label "N ⌀ D".
      //
      // ROTATIE-VEILIG: de volledige geometrie komt uit buildStavenreeks(),
      // dat alles afleidt uit startX/startY/endX/endY. Er wordt hier GEEN
      // ctx.rotate()/translate() toegepast en er is geen `rotation`-veld — een
      // schuine reeks ontstaat doordat de coördinaten schuin liggen. Dezelfde
      // functie voedt straks de PDF-appearance, zodat scherm en PDF niet uit
      // elkaar kunnen lopen.
      // Lijndikte + label-teksthoogte: eigen waarde of geërfd uit het
      // tekeningtype van het schaalgebied (drafting-rules.js).
      const lw = thinLw(effectiveDraftingLineWidth(annotation));
      const geom = buildStavenreeks(annotation, {
        // Alleen de puntstraal volgt de plaatselijke tekeningschaal.
        pxPerMm: stavenreeksPxPerMm(annotation),
        measureText: (text, size) => {
          ctx.save();
          ctx.font = `${size}px Arial`;
          const w = ctx.measureText(text).width;
          ctx.restore();
          return w;
        },
      });

      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      ctx.lineWidth = lw;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.setLineDash([]);

      // Reekslijn + poten in één pad.
      ctx.beginPath();
      ctx.moveTo(geom.line.x1, geom.line.y1);
      ctx.lineTo(geom.line.x2, geom.line.y2);
      for (const leg of geom.legs) {
        ctx.moveTo(leg.x1, leg.y1);
        ctx.lineTo(leg.x2, leg.y2);
      }
      ctx.stroke();

      // Gevulde punten (staafposities); straal schaalt met de diameter.
      for (const dot of geom.dots) {
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label "N ⌀ D", uitgelijnd langs de lijnrichting. Het diameterteken
      // wordt als VECTOR getekend (cirkel + schuine streep) — exact zoals in
      // de PDF-appearance, zodat scherm en PDF identiek zijn en er geen
      // font-afhankelijkheid voor U+2300 bestaat.
      const lbl = geom.label;
      ctx.save();
      ctx.translate(lbl.x, lbl.y);
      ctx.rotate(lbl.angle);
      ctx.font = `${lbl.fontSize}px Arial`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const x0 = lbl.align === 'right' ? -lbl.width : 0;
      // Bij selectie kleuren het AANTAL en de DIAMETER blauw: de klik-
      // affordance van de inline getalbewerking (klik opent het invoerveld).
      const srNumbersHot = inlineNumberHighlight(annotation);
      for (const part of lbl.parts) {
        if (part.kind === 'text') {
          if (srNumbersHot) {
            ctx.save();
            ctx.fillStyle = EDITABLE_NUMBER_COLOR;
            ctx.fillText(part.text, x0 + part.dx, 0);
            ctx.restore();
          } else {
            ctx.fillText(part.text, x0 + part.dx, 0);
          }
        } else {
          // Wapenings-diameterteken: cirkel + schuine streep + twee
          // vlaggetjes. De lijnstukken komen uit de GEDEELDE module
          // (diameterSignSegments via labelLayout), zodat het canvas en de
          // PDF-appearance exact hetzelfde symbool tekenen. Die segmenten
          // staan in een y-OMHOOG frame; het canvas heeft y omlaag, dus de
          // y-waarden worden gespiegeld.
          const r = lbl.signRadius;
          const cx = x0 + part.dx + part.w / 2;
          ctx.save();
          ctx.lineWidth = Math.max(0.4, lbl.fontSize * 0.07);
          ctx.strokeStyle = strokeColor;
          ctx.beginPath();
          ctx.arc(cx, 0, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          for (const seg of (lbl.signSegments || [])) {
            ctx.moveTo(cx + seg.x1, -seg.y1);
            ctx.lineTo(cx + seg.x2, -seg.y2);
          }
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();

      ctx.restore();
      break;
    }

    case 'betonbalk': {
      // Betonbalk in plattegrond: één lijnstuk-band met twee randlijnen,
      // eindkappen op vrije uiteinden, dunne hartlijn en optionele tag. De
      // volledige geometrie komt uit buildBetonbalk() — dezelfde bron als de
      // PDF-appearance. Aansluitingen op ANDERE balken (hoek-verstek / T)
      // worden per render opnieuw berekend uit de sibling-annotaties; de
      // doelbalk zelf wordt nooit gemuteerd.
      const _bbDoc = state.documents[state.activeDocumentIndex];
      // Tijdens het tekenen doet het voorbeeld-lijnstuk (shape-preview) mee
      // als sibling, zodat een BESTAANDE balk zijn verstek/open-T al toont
      // vóór de tweede klik — anders ziet de gebruiker een rauwe overlap met
      // eindkap op het aansluitpunt die na het vastleggen ineens verspringt.
      const _bbAnns = _bbDoc ? (_bbDoc.annotations || []) : [];
      const _bbSibs = (state._previewJoinAnn && state._previewJoinAnn !== annotation)
        ? [..._bbAnns, state._previewJoinAnn]
        : _bbAnns;
      const bbGeom = buildBetonbalk(annotation, {
        ...betonbalkBuildOpts(annotation, _bbSibs),
        measureText: (text, size) => {
          ctx.save();
          ctx.font = `${size}px Arial`;
          const w = ctx.measureText(text).width;
          ctx.restore();
          return w;
        },
      });
      if (!bbGeom) break;
      drawBetonbalkGeom(ctx, bbGeom, {
        strokeColor,
        lineWidth: thinLw(effectiveDraftingLineWidth(annotation)),
        // Blauwe tag bij selectie: klik-affordance van de inline bewerking.
        tagColor: inlineNumberHighlight(annotation) ? EDITABLE_NUMBER_COLOR : null,
      });
      break;
    }

    case 'systeemraster': {
      // Systeemraster: contour gevuld met een geclipt platenraster. De
      // volledige geometrie komt uit buildSysteemraster() — dezelfde bron
      // als de PDF-appearance (schaalgebied-bewuste plaatmaat in mm).
      const srGeomG = buildSysteemraster(annotation, {
        ...systeemrasterBuildOpts(annotation),
        measureText: (text, size) => {
          ctx.save();
          ctx.font = `${size}px Arial`;
          const w = ctx.measureText(text).width;
          ctx.restore();
          return w;
        },
      });
      if (!srGeomG) break;
      // Sub-element-selectie en -hover (tweede klik binnen het component)
      // alléén tonen als dit de enige geselecteerde annotatie is — zelfde
      // regel als de blauwe inline-getallen.
      const srSubShow = inlineNumberHighlight(annotation);
      drawSysteemrasterGeom(ctx, srGeomG, {
        strokeColor,
        lineWidth: thinLw(annotation.lineWidth ?? 1),
        // Blauwe tag bij selectie: klik-affordance van de inline bewerking.
        tagColor: srSubShow ? EDITABLE_NUMBER_COLOR : null,
        selectedSub: srSubShow && annotation.selectedSub ? annotation.selectedSub : null,
        hoverSub: srSubShow && annotation._hoverSub ? annotation._hoverSub : null,
        // Component-in-cel: symboolbeeld uit de bibliotheek-cache (laadt
        // async; na het laden volgt automatisch een redraw).
        getSymbolImage: getSysteemSymbolImage,
      });
      break;
    }

    case 'measureDistance': {
      // Distance measurement line with label
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);
      ctx.setLineDash([]);

      drawDimension(ctx, {
        startX: annotation.startX, startY: annotation.startY,
        endX: annotation.endX, endY: annotation.endY,
        leaderStartX: annotation.leaderStartX, leaderStartY: annotation.leaderStartY,
        leaderEndX: annotation.leaderEndX, leaderEndY: annotation.leaderEndY,
        startHead: annotation.startHead || 'openCircle',
        endHead: annotation.endHead || 'openCircle',
        headSize: annotation.headSize || 12,
        color: strokeColor,
        // dimShowUnit === false: alleen het getal (maat-label.js).
        measureText: annotation.measureShowLabel === false ? '' : maatlijnTekst(annotation.measureText, annotation.dimShowUnit),
        fontSize: annotation.fontSize,
        // User-dragged text position (offset from dimension-line midpoint)
        textOffsetX: annotation.textOffsetX || 0,
        textOffsetY: annotation.textOffsetY || 0,
        // Extension is the DEFAULT (NL drafting style): only explicitly
        // disabling it (dimExtension === false) turns it off.
        extension: annotation.dimExtension !== false,
        // Uitloop en hulplijnen in papiermillimeters (maatlijn-geometrie.js).
        dimLineOvershootMm: maatlijnVelden(annotation).dimLineOvershootMm,
        dimOvershootEnds: annotation.dimOvershootEnds,
        dimExtGapMm: annotation.dimExtGapMm,
        dimExtOvershootMm: annotation.dimExtOvershootMm,
        // Opmaak van een maat uit een ander programma (loader/maatlijn-uit-
        // bestand.js): holle punten, bijschrift in de lijn, eigen tekstkleur.
        headFill: annotation.headFill,
        textPosition: annotation.dimTextPosition,
        labelColor: _evHalftone?.color ? strokeColor : annotation.labelColor,
        lineWidth: annotation.lineWidth ?? 1,
      });
      break;
    }

    case 'measureArea': {
      // Area measurement polygon
      if (!annotation.points || annotation.points.length < 3) break;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);

      const maRegionFactor = getRegionScaleFactor(
        annotation.page, annotation.points[0]?.x, annotation.points[0]?.y
      );
      const maHatch = annotation.hatchPattern === 'none'
        ? null  // User explicitly disabled hatch
        : annotation.hatchPattern
          ? { pattern: annotation.hatchPattern, color: annotation.hatchColor || '#ff0000', scale: (annotation.hatchScale ?? 100) * maRegionFactor, angle: annotation.hatchAngle }
          : { pattern: 'diagonal-left', color: annotation.hatchColor || '#ff0000', scale: 100, angle: 0 };  // Default: red 45° hatch
      // annFill, niet de kale fillColor: daarin zit een eigen vul-alfa
      // (fillOpacity, bv. /ca 0.3 van een extern meetvlak) al verrekend, net als
      // bij de andere vormen. Met de kale hex kwam zo'n vlak dekkend over de
      // tekening en over het eigen maatlabel heen.
      drawMeasureAreaShape(ctx, annotation.points, annotation.color || '#ff0000', annotation.lineWidth, annFill, annotation.borderStyle, annotation.holes, maHatch, undefined, annHasStroke);
      // measureShowLabel === false: de oppervlakte staat elders (bijvoorbeeld
      // in de ruimtetag van een plattegrond) en het vlak toont geen eigen label.
      if (annotation.measureText && annotation.measureShowLabel !== false) {
        drawCentroidLabel(ctx, annotation.points, annotation.measureText, strokeColor, annotation);
      }
      drawCentroidMarker(ctx, annotation, strokeColor);
      break;
    }

    case 'filledArea': {
      // User-drawn polygon contour (with optional arc segments and holes),
      // filled with a solid color and/or hatch pattern.
      if (!annotation.points || annotation.points.length < 3) break;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);
      // Hatch density follows the scale region the area sits in (sampled at
      // the first vertex): same material pattern → same real-world spacing
      // across regions of different scales.
      const faRegionFactor = getRegionScaleFactor(
        annotation.page, annotation.points[0]?.x, annotation.points[0]?.y
      );
      const faHatch = (annotation.hatchPattern && annotation.hatchPattern !== 'none')
        ? {
            pattern: annotation.hatchPattern,
            color: annotation.hatchColor || strokeColor,
            scale: (annotation.hatchScale ?? 100) * faRegionFactor,
            angle: annotation.hatchAngle ?? 0,
          }
        : null;
      // Treat unset / null fillColor as no fill (we don't want measureArea's
      // semi-transparent default for an explicit user-drawn fill annotation).
      const faFill = annotation.fillColor && annotation.fillColor !== 'none' && annotation.fillColor !== 'transparent'
        ? annotation.fillColor
        : 'none';
      drawMeasureAreaShape(
        ctx,
        annotation.points,
        annotation.strokeColor || annotation.color || '#000000',
        annotation.lineWidth,
        faFill,
        annotation.borderStyle || 'solid',
        annotation.holes,
        faHatch,
        undefined,
        annHasStroke
      );
      break;
    }

    case 'redaction': {
      // Redaction mark - red hatched overlay
      const rw = annotation.width || 0;
      const rh = annotation.height || 0;
      // Semi-transparent red fill
      ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
      ctx.fillRect(annotation.x, annotation.y, rw, rh);
      // Animated marching-ants border (signals an active/pending redaction area)
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -(state.redactAntsOffset || 0);
      ctx.strokeRect(annotation.x, annotation.y, rw, rh);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      // Diagonal hatch lines
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = 10;
      for (let d = -rh; d < rw; d += step) {
        const x1 = Math.max(0, d) + annotation.x;
        const y1 = Math.max(0, -d) + annotation.y;
        const x2 = Math.min(rw, d + rh) + annotation.x;
        const y2 = Math.min(rh, -d + rw) + annotation.y;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      // Label
      ctx.font = '10px Arial';
      ctx.fillStyle = '#ff0000';
      ctx.fillText('REDACT', annotation.x + 4, annotation.y + 14);
      break;
    }

    case 'measurePerimeter': {
      // Perimeter measurement polyline
      if (!annotation.points || annotation.points.length < 2) break;
      // Conduit / cable tray run (annotations/raceway.js).
      if (annotation.measureKind === 'raceway') {
        drawRaceway(ctx, annotation, strokeColor, thinLw(annotation.lineWidth ?? 1), liveJunction(annotation));
        break;
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);

      if (!tekenLijnstijl(ctx, annotation, annotation.points, strokeColor, thinLw)) {
        drawMeasurePerimeterShape(ctx, annotation.points, strokeColor, annotation.borderStyle);
      }

      // Line endings at first and last points
      const mpPts = annotation.points;
      const mpHeadSize = annotation.headSize || 12;
      const mpStartHead = annotation.startHead || 'none';
      const mpEndHead = annotation.endHead || 'none';
      if (mpStartHead !== 'none' && mpPts.length >= 2) {
        const startAngle = Math.atan2(mpPts[0].y - mpPts[1].y, mpPts[0].x - mpPts[1].x);
        ctx.fillStyle = strokeColor;
        drawDimensionLineEnding(ctx, mpPts[0].x, mpPts[0].y, startAngle, mpHeadSize, mpStartHead, { hol: annotation.headFill === false });
      }
      if (mpEndHead !== 'none' && mpPts.length >= 2) {
        const last = mpPts[mpPts.length - 1];
        const prev = mpPts[mpPts.length - 2];
        const endAngle = Math.atan2(last.y - prev.y, last.x - prev.x);
        ctx.fillStyle = strokeColor;
        drawDimensionLineEnding(ctx, last.x, last.y, endAngle, mpHeadSize, mpEndHead, { hol: annotation.headFill === false });
      }

      // measureShowLabel === false: no value on the drawing (an external editor
      // polylength without a caption, or switched off in Properties).
      if (annotation.measureText && annotation.measureShowLabel !== false && mpPts.length > 0) {
        const lastPt = mpPts[mpPts.length - 1];
        const mpFs = Number(annotation.fontSize) > 0 ? Number(annotation.fontSize) : 11;
        ctx.font = `${mpFs}px Arial`;
        ctx.fillStyle = strokeColor;
        ctx.fillText(annotation.measureText, lastPt.x + 8, lastPt.y - 4);
      }
      drawSegmentLabels(ctx, annotation, strokeColor);
      break;
    }

    case 'scaleRegion': {
      // Benoemde viewport: alleen getekend terwijl een meetgereedschap actief
      // is (view-filter-rules.js), als lichtblauwe markering met naam en
      // schaal, zodat zichtbaar is welke schaal waar geldt.
      const srX = annotation.x, srY = annotation.y;
      const srW = annotation.width, srH = annotation.height;
      const srVp = window.__pdfViewport;
      const srZoom = ((srVp && srVp.active) ? srVp.zoom
        : (state.documents[state.activeDocumentIndex]?.scale || 1)) || 1;

      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(64, 156, 255, 0.10)';
      ctx.fillRect(srX, srY, srW, srH);
      ctx.strokeStyle = 'rgba(30, 120, 230, 0.85)';
      ctx.lineWidth = 1.5 / srZoom;
      ctx.setLineDash([]);
      ctx.strokeRect(srX, srY, srW, srH);

      // A viewport without valid scale metadata is not a calibration: say
      // so instead of showing an invented 1:100.
      const scaleStr = annotation.scaleString || '';
      const unitStr = annotation.units || '';
      const ppu = pixelsPerUnitFor(scaleStr, unitStr);
      const labelStr = annotation.label || '';
      const badgeText = (labelStr ? `${labelStr} · ` : '') +
        (ppu ? `${scaleStr} [${unitStr}]` : 'Scale not set');
      const fontPx = 11 / srZoom;
      ctx.font = `${fontPx}px sans-serif`;
      const pad = 4 / srZoom;
      const badgeW = ctx.measureText(badgeText).width + 2 * pad;
      const badgeH = 16 / srZoom;
      ctx.fillStyle = 'rgba(30, 120, 230, 0.85)';
      ctx.fillRect(srX, srY, badgeW, badgeH);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, srX + pad, srY + badgeH / 2);
      ctx.restore();
      break;
    }

    case 'hyperlink': {
      // Hyperlink markup: a light dashed frame in the app only. The saved
      // /Link has no border, so other readers show nothing (hyperlink-dict.js).
      // Batch Link's outline (linkBorder > 0) is a solid frame that other
      // readers draw as well.
      if (annotation.linkBorder > 0) {
        ctx.save();
        ctx.strokeStyle = annotation.color || '#2563eb';
        ctx.lineWidth = annotation.linkBorder;
        ctx.setLineDash([]);
        ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
        ctx.restore();
        break;
      }
      ctx.save();
      ctx.strokeStyle = annotation.color || '#2563eb';
      ctx.fillStyle = annotation.color || '#2563eb';
      ctx.lineWidth = annotation.lineWidth || 1;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
      ctx.restore();
      break;
    }

    case 'viewport': {
      // Viewport: dashed boundary rectangle with name label
      const vpX = annotation.x, vpY = annotation.y;
      const vpW = annotation.width, vpH = annotation.height;
      const vpColor = annotation.color || '#0066cc';

      ctx.save();
      ctx.setLineDash([6, 3]);
      ctx.strokeStyle = vpColor;
      ctx.lineWidth = annotation.lineWidth || 1.5;
      ctx.globalAlpha = annotation.opacity || 0.6;
      ctx.strokeRect(vpX, vpY, vpW, vpH);
      ctx.setLineDash([]);

      // Name label (top-left corner)
      const vpLabel = annotation.name || annotation.scaleRatio || '';
      if (vpLabel) {
        ctx.globalAlpha = 0.85;
        ctx.font = 'bold 9px sans-serif';
        const labelWidth = ctx.measureText(vpLabel).width + 8;
        ctx.fillStyle = vpColor;
        ctx.fillRect(vpX, vpY - 14, labelWidth, 14);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(vpLabel, vpX + 4, vpY - 7);
      }

      ctx.globalAlpha = 1;
      ctx.restore();
      break;
    }

    case 'scaleBar': {
      const sbX = annotation.x;
      const sbY = annotation.y;
      const sbW = annotation.width;
      const sbH = annotation.height || 12;
      const divisions = annotation.divisions || 5;
      const sourceCalibrated = geldigeSchaal(annotation);
      const totalUnits = Number.isFinite(annotation.totalUnits) && annotation.totalUnits > 0
        ? annotation.totalUnits
        : sourceCalibrated && Number.isFinite(sbW) && sbW > 0
          ? sbW / annotation.pixelsPerUnit : null;
      const unit = annotation.unit || 'mm';
      const divWidth = sbW / divisions;
      const barColor = annotation.color || '#000000';
      const barLW = annotation.lineWidth || 1;
      const calibratedBar = sourceCalibrated && Number.isFinite(totalUnits) && totalUnits > 0;

      ctx.save();

      if (annotation.rotation) {
        const cx = sbX + sbW / 2;
        const cy = sbY + sbH / 2;
        ctx.translate(cx, cy);
        ctx.rotate(annotation.rotation * Math.PI / 180);
        ctx.translate(-cx, -cy);
      }

      // Scale ratio label above the bar (e.g., "1:100")
      const _sbDoc = getActiveDocument();
      const _sbMs = paginaOfDocumentSchaal(_sbDoc, annotation.page);
      if (calibratedBar && _sbMs?.scaleRatio) {
        ctx.fillStyle = barColor;
        ctx.font = `bold ${Math.max(8, sbH * 0.65)}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(_sbMs.scaleRatio), sbX, sbY - 2);
      }

      // Alternating blocks
      for (let i = 0; i < divisions; i++) {
        const bx = sbX + i * divWidth;
        if (i % 2 === 0) {
          ctx.fillStyle = barColor;
          ctx.fillRect(bx, sbY, divWidth, sbH);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(bx, sbY, divWidth, sbH);
          ctx.strokeStyle = barColor;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(bx, sbY, divWidth, sbH);
        }
      }

      // Outer border
      ctx.strokeStyle = barColor;
      ctx.lineWidth = barLW;
      ctx.strokeRect(sbX, sbY, sbW, sbH);

      if (!calibratedBar) {
        ctx.fillStyle = barColor;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(sourceCalibrated ? 'Scale length not set' : 'Scale not set', sbX, sbY + sbH + 5);
        ctx.restore();
        break;
      }

      // Tick marks and labels below
      ctx.fillStyle = barColor;
      ctx.strokeStyle = barColor;
      const sbFontSize = Math.max(7, Math.min(10, sbH * 0.7));
      ctx.font = `${sbFontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const unitsPerDiv = totalUnits / divisions;

      for (let i = 0; i <= divisions; i++) {
        const tx = sbX + i * divWidth;
        ctx.beginPath();
        ctx.moveTo(tx, sbY + sbH);
        ctx.lineTo(tx, sbY + sbH + 4);
        ctx.lineWidth = barLW;
        ctx.stroke();

        const rawVal = Math.round(i * unitsPerDiv * 100) / 100;
        let labelStr;
        if (unit === 'mm' && totalUnits >= 1000) labelStr = String(rawVal / 1000);
        else if (unit === 'cm' && totalUnits >= 100) labelStr = String(rawVal / 100);
        else labelStr = String(rawVal);
        ctx.fillText(labelStr, tx, sbY + sbH + 5);
      }

      // Unit label (right of bar)
      let _sbDisplayUnit = unit;
      if (unit === 'mm' && totalUnits >= 1000) _sbDisplayUnit = 'm';
      else if (unit === 'cm' && totalUnits >= 100) _sbDisplayUnit = 'm';
      ctx.textAlign = 'left';
      ctx.fillText(_sbDisplayUnit, sbX + sbW + 4, sbY + sbH + 5);


      ctx.restore();
      break;
    }

    case 'scheduleTable': {
      // Generic columns/rows format (schedules panel + Hoeveelheden placement).
      // rows: [{ cells: string[], group?, total?, grand? }]
      if (Array.isArray(annotation.columns) && Array.isArray(annotation.rows)) {
        drawScheduleTable(ctx, annotation);
        break;
      }

      // Legacy scheduleData format (fixed columns).
      const data = annotation.scheduleData || [];
      if (data.length === 0) break;
      const tx = annotation.x;
      const ty = annotation.y;
      const tw = annotation.width || 400;
      const rowH = 18;
      const headerH = 22;
      const pad = 8;
      const cols = [0, 0.22, 0.42, 0.65, 0.82]; // fractional column positions

      ctx.save();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';

      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(tx, ty, tw, headerH + data.length * rowH);

      // Header background
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(tx, ty, tw, headerH);
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(tx, ty, tw, headerH);

      // Header text
      ctx.fillStyle = '#333';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 10px sans-serif';
      const headers = ['Label', 'Subject', 'Value', 'Unit', 'Pg'];
      for (let i = 0; i < headers.length; i++) {
        ctx.fillText(headers[i], tx + cols[i] * tw + pad, ty + headerH / 2);
      }

      // Data rows
      ctx.font = '10px sans-serif';
      for (let r = 0; r < data.length; r++) {
        const ry = ty + headerH + r * rowH;
        // Alternating row background
        if (r % 2 === 1) {
          ctx.fillStyle = '#f8f8f8';
          ctx.fillRect(tx, ry, tw, rowH);
        }
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(tx, ry + rowH);
        ctx.lineTo(tx + tw, ry + rowH);
        ctx.stroke();
        ctx.fillStyle = '#000';
        const d = data[r];
        ctx.fillText(d.label || d.type || '', tx + cols[0] * tw + pad, ry + rowH / 2);
        ctx.fillText(d.subject || '', tx + cols[1] * tw + pad, ry + rowH / 2);
        ctx.fillText(d.text || String(d.value || ''), tx + cols[2] * tw + pad, ry + rowH / 2);
        ctx.fillText(d.unit || '', tx + cols[3] * tw + pad, ry + rowH / 2);
        ctx.fillText(String(d.page || ''), tx + cols[4] * tw + pad, ry + rowH / 2);
      }

      // Outer border
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, tw, headerH + data.length * rowH);

      // Update annotation dimensions for accurate selection
      annotation.height = headerH + data.length * rowH;

      ctx.restore();
      break;
    }

    case 'measureAngle': {
      if (!annotation.point1 || !annotation.vertex || !annotation.point2) break;
      const p1 = annotation.point1;
      const v = annotation.vertex;
      const p2 = annotation.point2;
      const r = annotation.arcRadius || 30;

      // Draw two rays from vertex
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = thinLw(annotation.lineWidth ?? 1);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(v.x, v.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Draw arc between the two rays (shortest arc)
      const a1 = Math.atan2(p1.y - v.y, p1.x - v.x);
      const a2 = Math.atan2(p2.y - v.y, p2.x - v.x);
      let diff = a2 - a1;
      if (diff < 0) diff += 2 * Math.PI;
      const counterclockwise = diff > Math.PI;
      ctx.beginPath();
      ctx.arc(v.x, v.y, r, a1, a2, counterclockwise);
      ctx.stroke();

      // Draw angle label near the arc midpoint
      if (annotation.measureText) {
        const midAngle = counterclockwise
          ? a1 - (2 * Math.PI - diff) / 2
          : a1 + diff / 2;
        const labelR = r + 12;
        const lx = v.x + labelR * Math.cos(midAngle);
        const ly = v.y + labelR * Math.sin(midAngle);
        ctx.font = '11px sans-serif';
        ctx.fillStyle = strokeColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(annotation.measureText, lx, ly);
      }
      break;
    }

    default: {
      const typeHandler = getAnnotationType(annotation.type);
      if (typeHandler && typeHandler.render) {
        typeHandler.render(ctx, annotation);
      }
      break;
    }
  }
  // Custom Caption from the Markups List columns (formula-captions.js).
  if (annotation.captionTemplate || getActiveDocument()?.formulaCaptions?.captions) {
    drawCustomCaption(ctx, annotation, rawStrokeColor || annotation.color || strokeColor);
  }
}

// Draw text edits (cover-and-replace) for a specific page
// ctx is already scaled by state.scale, so coordinates are in unscaled page space
function drawTextEdits(ctx, pageNum) {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.textEdits || doc.textEdits.length === 0) return;

  const pageEdits = doc.textEdits.filter(e => e.page === pageNum);
  if (pageEdits.length === 0) return;

  const canvasEl = ctx.canvas;
  const dims = doc.pageDims?.[pageNum];
  // Text-edit records stay in the page's unrotated PDF frame. Apply the page
  // matrix only while painting so save coordinates remain stable across turns.
  const fallbackScale = doc.scale || 1;
  // Oorsprong van de pagina-box (meestal 0,0; CAD-plots hebben vaak een
  // MediaBox rond de oorsprong). PDF-tekstcoördinaten staan in ECHTE
  // user-space, de tekenlaag werkt in app-ruimte 0..breedte/hoogte.
  const offXPt = Number.isFinite(Number(dims?.offsetXPt)) ? Number(dims.offsetXPt) : 0;
  const offYPt = Number.isFinite(Number(dims?.offsetYPt)) ? Number(dims.offsetYPt) : 0;
  const pageWidth = dims?.widthPt || canvasEl.width / fallbackScale;
  const pageHeight = dims?.heightPt || canvasEl.height / fallbackScale;
  const totalRotation = (Number(dims?.rotation) || 0) + getPageRotation(pageNum);

  ctx.save();
  ctx.transform(...getPageRotationMatrix(pageWidth, pageHeight, totalRotation));

  for (const edit of pageEdits) {
    const fontSize = edit.fontSize;
    const ls = edit.lineSpacing || fontSize * 1.2;
    const numOrig = edit.numOriginalLines || 1;
    // Richting van de originele run (graden CCW in PDF-ruimte). Canvas heeft
    // y-omlaag, dus een CCW-PDF-hoek is -angle op de context.
    const angle = Number(edit.textAngle) || 0;
    const angleRad = angle * Math.PI / 180;

    // First line baseline in canvas coordinates
    const firstBaseY = (offYPt + pageHeight) - edit.pdfY;

    // Cover rectangle: extends from above first baseline to below last baseline
    // Skip cover rect for newly added text (no original text to cover)
    ctx.save();
    if (edit.originalText) {
      const coverHeight = (numOrig - 1) * ls + fontSize * 1.3;
      const origLines = edit.originalText.split('\n');
      const maxOrigLen = Math.max(...origLines.map(l => l.length));
      // Kolom-segmenten meenemen in de dekbreedte (zelfde regel als de
      // saver): de tekenaantal-schatting telt kolom-gaten niet mee.
      const segExtent = Math.max(0, ...((Array.isArray(edit.lineSegments) ? edit.lineSegments : [])
        .flatMap(segs => (Array.isArray(segs) ? segs : []).map(sg =>
          (Number(sg.dx) || 0) + String(sg.text ?? '').length * fontSize * 0.6))));
      const coverWidth = Math.max(edit.pdfWidth, fontSize * 0.6 * maxOrigLen, segExtent) + fontSize * 0.5;

      // Anker van het afdekvlak = de ORIGINELE tekstpositie (bij een
      // verplaatst blok wijkt die af van het tekst-anker pdfX/pdfY).
      const orig0 = (Array.isArray(edit.inplaceBaked?.lines) && edit.inplaceBaked.lines[0])
        || (Array.isArray(edit.originalLineInfo) && edit.originalLineInfo[0]) || null;
      const coverX = orig0 && Number.isFinite(Number(orig0.x)) ? Number(orig0.x) : edit.pdfX;
      const coverY = orig0 && Number.isFinite(Number(orig0.y)) ? Number(orig0.y) : edit.pdfY;
      ctx.save();
      ctx.translate(coverX - offXPt, (offYPt + pageHeight) - coverY);
      if (angle) ctx.rotate(-angleRad);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, -fontSize, coverWidth, coverHeight);
      ctx.restore();
    }

    ctx.textBaseline = 'alphabetic';

    const newLines = edit.newText.split('\n');
    for (let i = 0; i < newLines.length; i++) {
      const line = newLines[i];
      if (!line) continue;

      // Stijl per regel (kop blijft kop, broodtekst blijft broodtekst); valt
      // terug op de record-brede stijl voor oudere records/panel-overrides.
      const lineStyle = resolveTextEditLineStyle(edit, i);
      const lineFontSize = lineStyle.fontSize || fontSize;
      const ff = (lineStyle.fontFamily || 'Helvetica').toLowerCase();
      const cssFallback = ff.includes('courier') ? '"Courier New", Courier, monospace'
        : ff.includes('times') ? '"Times New Roman", Times, serif'
        : 'Helvetica, Arial, sans-serif';
      // Use PDF.js loaded font for exact visual match on canvas, with standard font fallback
      const fontFamily = lineStyle.loadedFontName
        ? `"${lineStyle.loadedFontName}", ${cssFallback}`
        : cssFallback;
      ctx.fillStyle = lineStyle.color || '#000000';

      // Canvas-fontstring voor een bold/italic-variant binnen de familie-
      // klasse van de regelstijl (embedded loadedFontName blijft de basis;
      // de browser synthetiseert weight/style erbovenop).
      const fontStringFor = (runBold, runItalic) => {
        const w = runBold ? 'bold ' : '';
        const st = runItalic ? 'italic ' : '';
        return `${st}${w}${lineFontSize}px ${fontFamily}`;
      };
      const baseBold = ff.includes('bold');
      const baseItalic = ff.includes('italic') || ff.includes('oblique');

      // Regel-anker in user-space (regels verschuiven loodrecht op de
      // baseline-richting), dan naar canvas-frame via de y-flip.
      const anchor = textEditLineAnchor(edit.pdfX, edit.pdfY, i, ls, angle);
      ctx.save();
      ctx.translate(anchor.x - offXPt, (offYPt + pageHeight) - anchor.y);
      if (angle) ctx.rotate(-angleRad);

      // Uitgevulde regel: dezelfde woordspatie-verdeling als de saver (Tw),
      // zodat het canvas toont wat er bij opslaan in het bestand komt.
      const jtw = Array.isArray(edit.lineJustifyTw) ? edit.lineJustifyTw[i] : null;
      if (jtw != null && 'wordSpacing' in ctx) ctx.wordSpacing = `${jtw}px`;

      const decorate = (fromX, toX) => {
        if (!(edit.fontUnderline || edit.fontStrikethrough) || toX <= fromX) return;
        ctx.strokeStyle = lineStyle.color || '#000000';
        ctx.lineWidth = Math.max(0.5, lineFontSize * 0.06);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        if (edit.fontUnderline) {
          const underlineY = lineFontSize * 0.1;
          ctx.moveTo(fromX, underlineY);
          ctx.lineTo(toX, underlineY);
        }
        if (edit.fontStrikethrough) {
          const strikeY = -lineFontSize * 0.3;
          ctx.moveTo(fromX, strikeY);
          ctx.lineTo(toX, strikeY);
        }
        ctx.stroke();
      };

      const segs = Array.isArray(edit.lineSegments) ? edit.lineSegments[i] : null;
      if (segs && segs.length) {
        // Kolom-segmenten: elk segment op zijn eigen x langs de baseline;
        // binnen een segment optioneel runs met eigen vet/cursief.
        for (const sg of segs) {
          let penX = Number(sg.dx) || 0;
          const segStart = penX;
          const chunks = (Array.isArray(sg.runs) && sg.runs.length)
            ? sg.runs
            : [{ text: sg.text, bold: baseBold, italic: baseItalic }];
          for (const run of chunks) {
            const t = String(run.text ?? '').replace(/\t/g, ' ');
            if (!t) continue;
            ctx.font = fontStringFor(!!run.bold, !!run.italic);
            ctx.fillStyle = run.color || lineStyle.color || '#000000';
            ctx.fillText(t, penX, 0);
            penX += ctx.measureText(t).width;
          }
          decorate(segStart, penX);
        }
      } else {
        ctx.font = fontStringFor(baseBold, baseItalic);
        const t = line.replace(/\t/g, ' ');
        ctx.fillText(t, 0, 0);
        decorate(0, ctx.measureText(t).width);
      }
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}

// Redraw all annotations (single page mode)
// One reusable canvas for translucent arrows (drawAnnotation 'arrow'): a new
// canvas per arrow per frame was garbage on every pan and drag.
let _pijlKladblok = null;
function pijlKladblok() {
  if (!_pijlKladblok) _pijlKladblok = document.createElement('canvas');
  return _pijlKladblok;
}

// Pass lightweight=true during drag/resize to skip expensive DOM updates
// Track annotation count to know when spatial index needs rebuild
let _lastIndexedCount = -1;
let _drawLookupDoc = null;
let _drawLookup = { byId: new Map(), always: [] };

let _drawLookupToken = null;

function rebuildDrawLookup(doc, annotations, token = documentGeometryToken(annotations)) {
  const perfT0 = performance.now();
  try { return rebuildDrawLookupNow(doc, annotations, token); } finally { perfRecord('index.rebuild', performance.now() - perfT0); }
}

function rebuildDrawLookupNow(doc, annotations, token = documentGeometryToken(annotations)) {
  _drawLookup = buildDrawLookup(annotations, spatialIndex);
  _drawLookupDoc = doc;
  _lastIndexedCount = annotations.length;
  _drawLookupToken = token;
}

// A full redraw (a click, a selection, a page render) rebuilt the spatial
// index and draw lookup every time: O(all markups) through the store's
// proxies, 100 ms and more on a drawing with tens of thousands. Now only
// when the markups' geometry fingerprint (raw reads, a few ms) changed.
function drawLookupCurrent(doc, annotations) {
  if (doc !== _drawLookupDoc || annotations.length !== _lastIndexedCount || spatialIndex.isVerouderd) return null;
  const token = documentGeometryToken(annotations);
  return token.a === _drawLookupToken?.a && token.b === _drawLookupToken?.b ? true : token;
}

// Valt deze annotatie volledig buiten het (ruim genomen) zichtbare gebied?
// De omhullende komt uit annotationBounds — dezelfde definitie die de spatial
// index hanteert — zodat lijnen, polylijnen, vrije hand, wolken en metingen
// óók wegvallen. Voorheen keek de tekenlus alleen naar x/width, waardoor elk
// lijn-achtig object op de pagina altijd volledig getekend werd, hoe ver het
// ook buiten beeld lag. Typen zonder goedkope omhullende (parametrische
// figuren) leveren null en worden dus gewoon getekend.
function _buitenBeeld(annotation, vpX, vpY, vpW, vpH) {
  const b = annotationBounds(annotation, { goedkoop: true });
  if (!b) return false;
  return b.x + b.width < vpX || b.x > vpX + vpW
      || b.y + b.height < vpY || b.y > vpY + vpH;
}

export function rebuildSpatialIndex() {
  const doc = state.documents[state.activeDocumentIndex];
  const annotations = doc ? doc.annotations : [];
  rebuildDrawLookup(doc, annotations);
}

// Ná het async laden van een component-in-cel-symboolbeeld: hertekenen
// zodat de placeholder door het echte symbool vervangen wordt.
// Een net gerasterd vectorknipsel moet meteen zichtbaar worden.
bijNieuweTegel(() => {
  const doc = state.documents[state.activeDocumentIndex];
  if (doc?.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
});

registerSysteemSymbolRedraw(() => {
  const doc = state.documents[state.activeDocumentIndex];
  if (doc?.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
});

// MultiView (docs/reference/editor/workspace.md): the passive split pane repaints its markups
// after the live view redraws. One null check while unsplit.
let _naHertekenen = null;
export function setAnnotationsRedrawnHook(fn) { _naHertekenen = typeof fn === 'function' ? fn : null; }
// Panels that show something derived from the markups (lists, totals) listen
// here to stay live. Called on full redraws only, not pan/zoom frames.
const _redrawListeners = new Set();
export function onAnnotationsRedrawn(fn) {
  _redrawListeners.add(fn);
  return () => _redrawListeners.delete(fn);
}
function notifyRedrawn(lightweight) {
  if (lightweight) return;
  for (const fn of _redrawListeners) { try { fn(); } catch { /* a listener never breaks drawing */ } }
}

export function redrawAnnotations(lightweight = false) {
  const perfT0 = performance.now();
  try { return redrawAnnotationsNow(lightweight); } finally { perfRecord(lightweight ? 'redraw.frame' : 'redraw.full', performance.now() - perfT0); }
}

// ── Markup-layer cache (zie redrawAnnotationsNow) ──
let _laag = { canvas: null };
let _laagVers = false; // de volgende frame tekent vers (na een gebaar)
let _laagTimer = 0;
let _laagCanvas = null;
function laagCanvas(w, h) {
  if (!_laagCanvas) _laagCanvas = document.createElement('canvas');
  if (_laagCanvas.width !== w || _laagCanvas.height !== h) { _laagCanvas.width = w; _laagCanvas.height = h; }
  return _laagCanvas.getContext('2d');
}
const selectieSleutel = (ids) => [...ids].sort().join('|');
function inverteerMatrix([a, b, c, d, e, f]) {
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
// 150 ms na het laatste frame uit de laag: één verse, scherpe tekening (die
// de laag ook vernieuwt).
function planLaagVernieuwing() {
  if (_laagTimer) clearTimeout(_laagTimer);
  _laagTimer = setTimeout(() => {
    _laagTimer = 0;
    _laagVers = true;
    redrawAnnotations(true);
  }, 150);
}
/**
 * Forget a closed document's draw state: the draw lookup and the markup
 * layer held it (and its markups) until the next redraw of another one.
 */
export function forgetDocumentDrawState(doc) {
  if (_drawLookupDoc === doc) {
    _drawLookup = { byId: new Map(), always: [] };
    _drawLookupDoc = null;
    _drawLookupToken = null;
    _lastIndexedCount = -1;
    spatialIndex.clear();
  }
  if (_laag.doc === doc) {
    _laag = { canvas: null };
    if (_laagCanvas) { _laagCanvas.width = 0; _laagCanvas.height = 0; }
  }
}

/** Laat de volgende teken-frame de markeringenlaag vers opbouwen. */
export function invalidateMarkupLayer() { _laagVers = true; }

function redrawAnnotationsNow(lightweight = false) {
  bumpAnnotationFrame();
  notifyRedrawn(lightweight);
  if (!annotationCtx || !annotationCanvas) return;
  if (_naHertekenen) _naHertekenen();

  // Read scale and annotations from the active document directly
  // (bypass createMutable proxy getter caching). The markups are drawn from
  // the raw objects: through the store every field a draw reads went through
  // a proxy trap, over a second of an open at 20,000 markups. A redraw is
  // asked for explicitly, never tracked, so it loses nothing; the selection
  // is matched by id.
  const doc = state.documents[state.activeDocumentIndex];
  const scale = doc ? doc.scale : 1;
  const annotations = doc ? (doc.annotations?.[$RAW] || doc.annotations) : [];

  // Pan and zoom call the lightweight path each frame. Reuse the spatial
  // lookup then; rebuild after edits, document changes, or count changes.
  if (doc !== _drawLookupDoc || annotations.length !== _lastIndexedCount || spatialIndex.isVerouderd) {
    rebuildDrawLookup(doc, annotations);
  } else if (!lightweight) {
    const current = drawLookupCurrent(doc, annotations);
    if (current !== true) rebuildDrawLookup(doc, annotations, current || undefined);
  }

  // Scale-region lookup cache: invalidate per redraw so moves/resizes
  // are reflected lazily on next draw. O(1) cost.
  invalidateScaleRegionCache();

  annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);

  // Sync the dedicated text-highlight canvas with the annotation canvas.
  // It uses CSS mix-blend-mode: multiply so it blends with #pdf-canvas below.
  if (textHighlightCanvas && textHighlightCtx) {
    if (textHighlightCanvas.width !== annotationCanvas.width ||
        textHighlightCanvas.height !== annotationCanvas.height) {
      textHighlightCanvas.width = annotationCanvas.width;
      textHighlightCanvas.height = annotationCanvas.height;
    }
    textHighlightCanvas.style.width = annotationCanvas.style.width;
    textHighlightCanvas.style.height = annotationCanvas.style.height;
    textHighlightCanvas.style.left = annotationCanvas.style.left;
    textHighlightCanvas.style.top = annotationCanvas.style.top;
    textHighlightCtx.setTransform(1, 0, 0, 1, 0, 0);
    textHighlightCtx.clearRect(0, 0, textHighlightCanvas.width, textHighlightCanvas.height);
  }

  // Apply scale transformation for zooming.
  // Blank docs (no filePath) bypass the viewport singleton — their pixels are
  // painted directly to #pdf-canvas via PDF.js, and the annotation overlay
  // must match doc.scale, NOT the viewport zoom that belongs to a previously-
  // open real PDF.
  const vp = window.__pdfViewport;
  const _activeDoc = state.documents[state.activeDocumentIndex];
  const useViewport = vp && vp.active && _activeDoc?.filePath;
  // Backing pixels per CSS px of the overlay: normally the dpr, but capped on
  // a deep zoom (overlay-canvas-size.js OVERLAY_MAX_AXIS_PX), so read it off
  // the canvas itself.
  const _cssW = parseFloat(annotationCanvas.style?.width || '');
  const dpr = _cssW > 0 && annotationCanvas.width > 0 ? annotationCanvas.width / _cssW : (window.devicePixelRatio || 1);
  const effectiveScale = useViewport ? vp.zoom : scale * dpr;
  const _legacyClipX = useViewport ? 0 : (parseFloat(annotationCanvas.dataset?.clipX) || 0);
  const _legacyClipY = useViewport ? 0 : (parseFloat(annotationCanvas.dataset?.clipY) || 0);
  const _legacyGeknipt = !!(_legacyClipX || _legacyClipY || annotationCanvas.dataset?.paginaCssW);
  // Viewport mode: the overlay backing is device-resolution (dataset
  // backingScale = dpr, overlay-canvas-size.js), the viewport math is in CSS
  // px. Sizes meant to stay screen-constant keep using effectiveScale (CSS px).
  const _vpBacking = useViewport ? (parseFloat(annotationCanvas.dataset?.backingScale) || 1) : 1;

  // CRITICAL: in vector viewport mode, key the annotation page off
  // viewport.pageNum (what's currently drawn on #pdf-canvas) NOT
  // doc.currentPage (what the user *asked* for). When the user wheels to a
  // new uncached page, doc.currentPage updates immediately but the PDF takes
  // hundreds of ms to extract draw commands; if we used doc.currentPage we'd
  // draw the new page's annotations on top of the old page's PDF for that
  // entire window. viewport.pageNum only updates after setPage() runs, so it
  // always matches the visible PDF.
  const curPage = useViewport
    ? (vp.pageNum || (doc ? doc.currentPage : 1))
    : (doc ? doc.currentPage : 1);

  // Weergave draaien (#200): annotaties staan in de paginaruimte; de
  // transform legt ze gedraaid op het scherm, net als de pagina zelf.
  const vpGeo = useViewport ? viewportGeometrie(vp) : null;
  const _vpMatrix = vpGeo ? vermenigvuldigMatrix([_vpBacking, 0, 0, _vpBacking, 0, 0], vpGeo.matrix) : null;
  const legacyWeergave = useViewport ? null : weergaveTransform(curPage, doc);
  annotationCtx.save();
  if (textHighlightCtx) textHighlightCtx.save();
  if (useViewport) {
    // Viewport mode: annotations are in app-space (top-left origin, Y-down, scale=1).
    // Page top-left on screen = (offsetX, offsetY) without view rotation.
    // App coord → screen = offset + zoom · (view rotation of the app coord).
    // No Y-flip needed for annotations.
    annotationCtx.setTransform(..._vpMatrix);
    if (textHighlightCtx) textHighlightCtx.setTransform(..._vpMatrix);
  } else {
    // Legacy mode: simple scale from origin
    annotationCtx.scale(effectiveScale, effectiveScale);
    if (textHighlightCtx) textHighlightCtx.scale(effectiveScale, effectiveScale);
    // Diepe zoom: de overlay is een uitsnede van de pagina vanaf (clipX,
    // clipY) CSS-px (overlay-canvas-size.js); de tekening schuift mee.
    if (_legacyClipX || _legacyClipY) {
      annotationCtx.translate(-_legacyClipX / scale, -_legacyClipY / scale);
      if (textHighlightCtx) textHighlightCtx.translate(-_legacyClipX / scale, -_legacyClipY / scale);
    }
    if (legacyWeergave) {
      annotationCtx.transform(...legacyWeergave);
      if (textHighlightCtx) textHighlightCtx.transform(...legacyWeergave);
    }
  }

  // Het canvas in paginaruimte: bij een gedraaide weergave liggen breedte en
  // hoogte anders dan op het scherm (raster en watermerken rekenen erin).
  let canvasInPagina = { x: _legacyClipX / scale, y: _legacyClipY / scale, width: annotationCanvas.width / (effectiveScale * _vpBacking), height: annotationCanvas.height / (effectiveScale * _vpBacking) };
  if (vpGeo && vpGeo.rotatie) {
    canvasInPagina = rectNaarPagina(
      { x: -vp.offsetX / vp.zoom, y: -vp.offsetY / vp.zoom, width: annotationCanvas.width / (vp.zoom * _vpBacking), height: annotationCanvas.height / (vp.zoom * _vpBacking) },
      vpGeo.paginaBreedte, vpGeo.paginaHoogte, vpGeo.rotatie,
    );
  } else if (legacyWeergave) {
    canvasInPagina = weergaveRectNaarPagina(curPage, canvasInPagina, doc);
  }

  // Draw grid overlay if enabled (BEFORE annotations, as a background pass).
  // Pass effectiveScale so the dot grid hides when too zoomed-out.
  if (state.preferences.showGrid) {
    drawGrid(annotationCtx, canvasInPagina.x + canvasInPagina.width, canvasInPagina.y + canvasInPagina.height, effectiveScale);
  }

  // Watermerken rekenen hun plek op de pagina uit de paginamaat. De viewport
  // kent die maat; zonder viewport is het canvas de pagina.
  const wmMaat = vpGeo
    ? { w: vpGeo.paginaBreedte, h: vpGeo.paginaHoogte }
    : _legacyGeknipt
      ? { w: (parseFloat(annotationCanvas.dataset.paginaCssW) || 0) / scale, h: (parseFloat(annotationCanvas.dataset.paginaCssH) || 0) / scale }
      : { w: canvasInPagina.width, h: canvasInPagina.height };

  // Draw watermarks behind content
  renderWatermarksBehind(annotationCtx, curPage, wmMaat.w, wmMaat.h);

  // Draw text edits (cover-and-replace) before annotations
  drawTextEdits(annotationCtx, curPage);

  // Space outlines (Spaces panel) under the markups.
  drawSpaceOverlay(annotationCtx, doc, curPage, effectiveScale);

  // Viewport culling: skip annotations outside the visible area for performance
  let vpX = 0, vpY = 0, vpW, vpH;
  if (useViewport) {
    // Vector mode: visible area in app-coords = screen area mapped through inverse transform
    // Screen (0,0) → app (-offsetX/zoom, -offsetY/zoom)
    // Screen (canvasW, canvasH) → app ((canvasW-offsetX)/zoom, (canvasH-offsetY)/zoom)
    // (in de weergaveruimte; bij een weergaverotatie daarna terug naar de pagina).
    vpX = -vp.offsetX / vp.zoom;
    vpY = -vp.offsetY / vp.zoom;
    vpW = annotationCanvas.width / (vp.zoom * _vpBacking);
    vpH = annotationCanvas.height / (vp.zoom * _vpBacking);
    // Generous margin
    const margin = 200 / vp.zoom;
    vpX -= margin; vpY -= margin; vpW += margin * 2; vpH += margin * 2;
    if (vpGeo.rotatie) {
      const r = rectNaarPagina({ x: vpX, y: vpY, width: vpW, height: vpH }, vpGeo.paginaBreedte, vpGeo.paginaHoogte, vpGeo.rotatie);
      vpX = r.x; vpY = r.y; vpW = r.width; vpH = r.height;
    }
  } else {
    const canvasW = annotationCanvas.width / effectiveScale;
    const canvasH = annotationCanvas.height / effectiveScale;
    vpW = canvasW; vpH = canvasH;
    const scrollContainer = document.getElementById('pdf-container');
    if (_legacyGeknipt) {
      // Uitsnede: precies wat dit canvas dekt (de rand zit er al in).
      vpX = _legacyClipX / scale; vpY = _legacyClipY / scale;
    } else if (scrollContainer) {
      const scale = doc ? doc.scale : 1;
      vpX = scrollContainer.scrollLeft / scale;
      vpY = scrollContainer.scrollTop / scale;
      vpW = scrollContainer.clientWidth / scale;
      vpH = scrollContainer.clientHeight / scale;
      const margin = 200 / scale;
      vpX -= margin; vpY -= margin; vpW += margin * 2; vpH += margin * 2;
    }
    if (legacyWeergave) {
      const r = weergaveRectNaarPagina(curPage, { x: vpX, y: vpY, width: vpW, height: vpH }, doc);
      vpX = r.x; vpY = r.y; vpW = r.width; vpH = r.height;
    }
  }

  // Draw all annotations for current page (with viewport culling).
  // Text highlights go to the dedicated #text-highlight-canvas (CSS multiply
  // blend with #pdf-canvas below); everything else goes to #annotation-canvas.
  // One scale pass: annotations that look up their scale while drawing (walls,
  // bar series, hatches) share the scale sources collected once (#491).
  // Een markering met mengmodus Vermenigvuldigen (the external editor /BM /Multiply) gaat
  // naar het vermenigvuldig-canvas, zodat ze met de tekening mengt — tenzij
  // een eerder getekende gewone markering eronder ligt: dat canvas ligt onder
  // het annotatiecanvas, dus de volgorde zou dan omkeren.
  // Eerder getekende vakken in een grof raster (256 pt-cellen): de
  // overlaptest vergeleek elke vermenigvuldig-markering met álle eerdere
  // vakken, kwadratisch per frame op een zware tekening.
  const VAK_CEL = 256;
  const eerdereRaster = new Map();
  const eerdereVakken = {
    push(v) {
      const c0 = Math.floor(v.x / VAK_CEL), c1 = Math.floor((v.x + v.width) / VAK_CEL);
      const r0 = Math.floor(v.y / VAK_CEL), r1 = Math.floor((v.y + v.height) / VAK_CEL);
      if (!Number.isFinite(c0 + c1 + r0 + r1) || (c1 - c0 + 1) * (r1 - r0 + 1) > 4096) { (eerdereRaster.get('groot') || eerdereRaster.set('groot', []).get('groot')).push(v); return; }
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
        const k = `${c},${r}`;
        (eerdereRaster.get(k) || eerdereRaster.set(k, []).get(k)).push(v);
      }
    },
  };
  const raakt = (b, v) => b.x < v.x + v.width && v.x < b.x + b.width && b.y < v.y + v.height && v.y < b.y + b.height;
  const overlaptEerdere = (annotation) => {
    const b = annotationBounds(annotation, { goedkoop: true });
    if (!b) return true;
    if ((eerdereRaster.get('groot') || []).some(v => raakt(b, v))) return true;
    const c0 = Math.floor(b.x / VAK_CEL), c1 = Math.floor((b.x + b.width) / VAK_CEL);
    const r0 = Math.floor(b.y / VAK_CEL), r1 = Math.floor((b.y + b.height) / VAK_CEL);
    if (!Number.isFinite(c0 + c1 + r0 + r1) || (c1 - c0 + 1) * (r1 - r0 + 1) > 4096) {
      for (const lijst of eerdereRaster.values()) if (lijst.some(v => raakt(b, v))) return true;
      return false;
    }
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
      if ((eerdereRaster.get(`${c},${r}`) || []).some(v => raakt(b, v))) return true;
    }
    return false;
  };
  // Ingelezen markeringen die de pagina-bitmap al uit hun eigen /AP tekent
  // (pdf/ap-render-state.js): niet nog eens natekenen.
  const apAlGetekend = apInBitmap(doc, curPage);
  // Weergavefilters één keer per doorloop gelezen (view-filters.js).
  // De markeringenlaag (layer-cache.js): bij een pan- of zoomframe het
  // laatst volledig getekende beeld, verplaatst en geschaald naar de nieuwe
  // weergave, in plaats van elke markering opnieuw te tekenen (op een blad
  // met tienduizenden markeringen honderden ms per frame). Geselecteerde
  // markeringen en die op de vermenigvuldig-laag worden altijd live getekend;
  // 150 ms na het laatste zulke frame volgt een scherpe, volledige tekening.
  const laagMag = useViewport && !!_vpMatrix && annotations.length > 200;
  const geselecteerd = new Set((doc?.selectedAnnotations || []).map(a => a?.id).filter(Boolean));
  const laagGeldig = laagMag && lightweight && !_laagVers && _laag.doc === doc && _laag.page === curPage
    && _laag.count === annotations.length && _laag.selectie === selectieSleutel(geselecteerd) && !!_laag.canvas;
  drawExtensionUnderlays(annotationCtx, curPage, doc);
  const tekenOp = (targetCtx, annotation) => {
    // Wrap each annotation in save/restore to prevent clip leaks between annotations
    targetCtx.save();
    drawAnnotation(targetCtx, annotation);
    targetCtx.restore();
  };
  const laagT0 = performance.now();
  if (laagGeldig) {
    annotationCtx.save();
    annotationCtx.setTransform(...vermenigvuldigMatrix(_vpMatrix, vermenigvuldigMatrix(inverteerMatrix(_laag.matrix), [1, 0, 0, 1, -_laag.pad, -_laag.pad])));
    annotationCtx.drawImage(_laag.canvas, 0, 0);
    annotationCtx.restore();
    metWeergaveDoorloop(() => metSchaalBronnen(() => {
      for (const annotation of _laag.live) {
        const doelCtx = annotation.__laagOpMarkeer && textHighlightCtx ? textHighlightCtx : annotationCtx;
        tekenOp(doelCtx, annotation.ann);
      }
    }));
    planLaagVernieuwing();
    perfRecord('redraw.layerReuse', performance.now() - laagT0);
  } else {
    const pad = laagMag ? Math.round(Math.min(800, 0.2 * Math.max(annotationCanvas.width, annotationCanvas.height))) : 0;
    const padPagina = laagMag ? pad / ((vp?.zoom || 1) * _vpBacking) : 0;
    const drawAnnotations = useViewport && annotations.length > 200
      ? visibleDrawItems(spatialIndex, _drawLookup, curPage, vpX - padPagina, vpY - padPagina, vpW + 2 * padPagina, vpH + 2 * padPagina, doc?.selectedAnnotations, annotations)
      : annotations;
    let laagCtx = null;
    if (laagMag) {
      laagCtx = laagCanvas(annotationCanvas.width + 2 * pad, annotationCanvas.height + 2 * pad);
      laagCtx.setTransform(1, 0, 0, 1, 0, 0);
      laagCtx.clearRect(0, 0, laagCtx.canvas.width, laagCtx.canvas.height);
      laagCtx.setTransform(...vermenigvuldigMatrix([1, 0, 0, 1, pad, pad], _vpMatrix));
    }
    const live = [];
    metWeergaveDoorloop(() => metSchaalBronnen(() => eachUnderlayFirst(drawAnnotations, curPage, (a) => { if (!apAlGetekend.has(a.id) && !_buitenBeeld(a, vpX - padPagina, vpY - padPagina, vpW + 2 * padPagina, vpH + 2 * padPagina)) tekenOp(laagCtx || annotationCtx, a); })));
    metWeergaveDoorloop(() => metSchaalBronnen(() => drawAnnotations.forEach(annotation => {
      if (annotation.page !== curPage) return;
      if (edition.rendering?.isUnderlay?.(annotation)) return;
      if (apAlGetekend.has(annotation.id)) return;
      if (_buitenBeeld(annotation, vpX - padPagina, vpY - padPagina, vpW + 2 * padPagina, vpH + 2 * padPagina)) return;
      const vermenigvuldig = annotation.blendMode === 'multiply' && !!textHighlightCtx && !overlaptEerdere(annotation);
      if (annotation.blendMode !== 'multiply' && annotation.type !== 'textHighlight') {
        const b = annotationBounds(annotation, { goedkoop: true });
        if (b) eerdereVakken.push(b);
      }
      const opMarkeer = (annotation.type === 'textHighlight' || vermenigvuldig) && !!textHighlightCtx;
      if (laagCtx && (opMarkeer || geselecteerd.has(annotation.id))) {
        // Live: bovenop de laag, ook in de frames die de laag hergebruiken.
        live.push({ ann: annotation, __laagOpMarkeer: opMarkeer });
        return;
      }
      tekenOp(opMarkeer ? textHighlightCtx : (laagCtx || annotationCtx), annotation);
    })));
    if (laagCtx) {
      annotationCtx.save();
      annotationCtx.setTransform(1, 0, 0, 1, 0, 0);
      annotationCtx.drawImage(laagCtx.canvas, -pad, -pad);
      annotationCtx.restore();
      metWeergaveDoorloop(() => metSchaalBronnen(() => {
        for (const item of live) tekenOp(item.__laagOpMarkeer ? textHighlightCtx : annotationCtx, item.ann);
      }));
      _laag = { canvas: laagCtx.canvas, matrix: _vpMatrix.slice(), pad, doc, page: curPage, count: annotations.length, selectie: selectieSleutel(geselecteerd), live };
      _laagVers = false;
      perfRecord('redraw.layerBuild', performance.now() - laagT0);
    } else if (!laagMag) {
      _laag.canvas = null;
    }
  }

  annotationCtx.globalAlpha = 1;
  annotationCtx.globalCompositeOperation = 'source-over';
  if (textHighlightCtx) {
    textHighlightCtx.globalAlpha = 1;
    textHighlightCtx.globalCompositeOperation = 'source-over';
  }

  // Draw watermarks in front of content
  renderWatermarksInFront(annotationCtx, curPage, wmMaat.w, wmMaat.h);

  // Draw polar ray + tooltip when an active polar snap is engaged
  if (state.lastSnapResult && state.lastSnapResult.type === 'polar') {
    _drawPolarOverlay(annotationCtx, state.lastSnapResult, effectiveScale);
  }
  // Snap indicator during interactive G-move/G-rotate sessions. Drawing
  // tools render theirs via the shape-preview pass, which never runs for
  // the select-tool — without this the session snaps invisibly.
  if ((state.gMoveMode || state.gRotateMode) &&
      state.lastSnapResult && state.lastSnapResult.snapped &&
      state.lastSnapResult.type !== 'polar') {
    drawSnapIndicator(annotationCtx, state.lastSnapResult, effectiveScale);
  }

  // Image alignment guides (edge/centre snap while moving, equal-width/height
  // while resizing). State-driven — same principle as the rubber-band and the
  // snap indicator above: drawn INSIDE the redraw so a viewport re-render can't
  // wipe them. The one-shot overlay in tool-dispatcher gives instant feedback
  // within a single mousemove; this pass keeps them visible across the
  // viewport's RAF re-renders. Guides are in app-space, matching the transform
  // already applied to annotationCtx.
  if (state._imageAlignGuides && state._imageAlignGuides.length > 0) {
    drawImageAlignGuides(annotationCtx, state._imageAlignGuides, effectiveScale);
  }

  // Draw selection highlight and handles (use selectedAnnotations array as source of truth)
  const _renderDoc = getActiveDocument();
  const selected = _renderDoc ? _renderDoc.selectedAnnotations : [];
  if (selected.length > 0) {
    for (const ann of selected) {
      if (ann.page !== curPage) continue;
      // A hidden markup can be selected in the Markups List, but the canvas
      // shows nothing of it: no frame, no grips (docs/reference/editor/layers.md).
      if (isAnnotationHiddenInView(ann)) continue;
      drawSelectionHandles(annotationCtx, ann);
    }
  }

  // Interactive image-crop overlay (contextual "Afbeelding" tab → Croppen).
  // Drawn after selection handles so the crop rectangle sits on top.
  drawImageCropOverlay(annotationCtx, curPage);

  // Visual Search results (Search panel), framed until they become markups.
  drawVisualSearchOverlay(annotationCtx, curPage);
  drawExtensionOverlays(annotationCtx, curPage);

  // Embedded image-removal tool highlights (issue #184).
  drawEmbeddedImageOverlay(annotationCtx, curPage);

  // Dynamic Fill preview: fills and temporary boundary lines.
  drawDynamicFillOverlay(annotationCtx, curPage);

  // Blender-style 2D cursor (Shift+right-click places it; hidden until set).
  if (_renderDoc?.cursor2D && _renderDoc.cursor2D.page === curPage) {
    _draw2DCursor(annotationCtx, _renderDoc.cursor2D.x, _renderDoc.cursor2D.y, effectiveScale);
  }

  // Rubber-band selection marquee (state-driven so it can't be cleared by the
  // next redraw frame; gated to the page the drag started on).
  if (state.isRubberBanding && (state.rubberBandPage == null || state.rubberBandPage === curPage)) {
    drawRubberBand(annotationCtx, effectiveScale);
  }
  // Region selection (a marquee without markups), kept until it is cleared.
  drawRegionSelection(annotationCtx, curPage, effectiveScale);
  // Lasso path / Offset preview (edit-tool-overlay.js).
  drawEditToolOverlay(annotationCtx, curPage, effectiveScale);
  // Conduit / cable tray: placed run plus the straight leg under the cursor.
  drawRacewayGesture(annotationCtx, curPage, effectiveScale);

  // Restore context
  annotationCtx.restore();
  if (textHighlightCtx) textHighlightCtx.restore();

  if (!lightweight) werkPanelenBij();
}

// Statusbalk, Markups List, snelknoppen en contextuele tabbladen volgen de
// markeringen. Tijdens een gebaar (tekenen, slepen, schalen, pannen) verandert
// daar per pointerbeweging niets aan wat ze tonen, maar de lijst opbouwen kost
// op een zware tekening ~15 ms per keer. Dan één keer bijwerken, kort na de
// laatste beweging; buiten een gebaar meteen, zoals altijd.
const PANELEN_NA_GEBAAR_MS = 120;
let _panelenTimer = 0;
// Binnen de afhandeling van een pointerbeweging (tool-dispatcher.js): ook
// tools die zelf hun punten bijhouden (polylijn, metingen, kabelgoot) zetten
// geen gebaarvlag, maar een beweging alleen verandert de lijst niet.
let _inPointerBeweging = 0;

/** Voer `fn` uit als afhandeling van een pointerbeweging (panelen later). */
export function alsPointerBeweging(fn) {
  _inPointerBeweging++;
  try { return fn(); } finally { _inPointerBeweging--; }
}

function panelenNu() {
  if (_panelenTimer) { clearTimeout(_panelenTimer); _panelenTimer = 0; }
  updateStatusAnnotations();
  updateQuickAccessButtons();
  updateContextualTabs();
  lijstNaTekenen();
}

// De Markups List (op een zware tekening ~20-25 ms opbouwen) direct na de
// volgende schermverversing: de nieuwe of losgelaten markering staat dan
// meteen op het scherm, de lijst volgt één beeld later. Meerdere
// hertekeningen vóór die tijd geven één opbouw.
let _lijstGepland = false;
function lijstNaTekenen() {
  if (_lijstGepland) return;
  _lijstGepland = true;
  // Alleen opbouwen als er iets veranderd is dat de lijst toont.
  const bouw = () => { _lijstGepland = false; updateAnnotationsListIfChanged(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(bouw, 0));
  else setTimeout(bouw, 0);
}

function werkPanelenBij() {
  const gebaar = _inPointerBeweging > 0 || state.isDrawing || state.isDragging || state.isResizing
    || state.isPanning || state.isRubberBanding;
  if (!gebaar) { panelenNu(); return; }
  if (_panelenTimer) clearTimeout(_panelenTimer);
  _panelenTimer = setTimeout(panelenNu, PANELEN_NA_GEBAAR_MS);
}

// Render annotations for a specific page (continuous mode)
// Rubber-band selection marquee. Drawn as part of the render/overlay pass —
// driven purely by state — so it survives every redraw frame. (It used to be
// hand-painted in select-tool AFTER calling redraw(), which raced the redraw
// and left the marquee visible on some gestures but not others.) The render
// context is already scaled to app/PDF space, so coords are app-space and
// stroke widths/dashes are divided by effectiveScale to stay screen-constant.
function drawRubberBand(ctx, effectiveScale) {
  if (!state.isRubberBanding) return;
  const sx = state.rubberBandStartX, sy = state.rubberBandStartY;
  const ex = state.rubberBandEndX, ey = state.rubberBandEndY;
  if (sx == null || sy == null || ex == null || ey == null) return;
  const x = Math.min(sx, ex), y = Math.min(sy, ey);
  const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
  // Tekendrempel in schermpixels (was 0,5 paginapunt = 32 px bij 6400 %).
  const rbTekenMin = 0.5 / (effectiveScale > 0 ? effectiveScale : 1);
  if (w < rbTekenMin && h < rbTekenMin) return;
  const isCrossing = state.rubberBandMode === 'crossing';
  ctx.save();
  ctx.lineWidth = 1 / effectiveScale;
  if (isCrossing) {
    // drag-left → crossing (green, dashed)
    ctx.strokeStyle = '#10b981';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
    ctx.setLineDash([4 / effectiveScale, 4 / effectiveScale]);
  } else {
    // drag-right → window (blue, solid)
    ctx.strokeStyle = '#3b82f6';
    ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
    ctx.setLineDash([]);
  }
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

// `renderOffset` (optioneel, in schaal-1-paginacoördinaten) verschuift de
// oorsprong: daarmee tekent een viewport-gebonden canvas alleen zijn eigen
// uitsnede van de pagina (zie de scherpe overlay hieronder).
// `pageDims` (optioneel, {w,h} in schaal-1-paginacoördinaten): volledige
// paginamaat voor de watermerken; zonder deze parameter wordt de canvasmaat
// gebruikt, wat bij een viewport-uitsnede te klein is.
// `opties` (optioneel): `{ uitvoer: true }` voor een afdruk, export of
// voorbeeld — dan geen selectiekader, grepen of andere bewerkingstoestand, en
// echte lijndiktes; `{ markeringen: false }` laat de annotatielaag weg
// ("Afdrukken: Document"). Zie rendering/uitvoer-lagen.js.
// `weergave` (optioneel, alleen op het scherm): matrix paginaruimte →
// weergaveruimte van een gedraaide weergave (#200, weergaveTransform()).
// Dan zijn `renderOffset`, `pageDims` en de canvasmaat weergavematen; de
// annotaties zelf blijven in de paginaruimte en draaien via deze matrix mee.
export function renderAnnotationsForPage(ctx, pageNum, width, height, overrideDpr, renderOffset, pageDims, opties, weergave, pageAnnotations = null) {
  const lagen = weergaveLagen(opties);
  // Alleen tijdens deze (synchrone) rendering, zodat drawAnnotation weet dat
  // er geen bewerkingstoestand in de uitvoer hoort.
  _lagen = opties ? lagen : null;
  try {
    tekenPaginaLagen(ctx, pageNum, width, height, overrideDpr, renderOffset, pageDims, lagen, weergave, opties?.snippetBitmaps,
      opties?.opPagina === true, pageAnnotations);
  } finally {
    _lagen = null;
  }
}

function tekenPaginaLagen(ctx, pageNum, width, height, overrideDpr, renderOffset, pageDims, lagen, weergave, snippetBitmaps, opPagina = false, pageAnnotations = null) {
  bumpAnnotationFrame();
  // opPagina: de markeringen komen direct op een canvas waar de pagina al op
  // staat (exporter.js), zodat Vermenigvuldigen met de tekening mengt.
  if (!opPagina) ctx.clearRect(0, 0, width, height);

  // Read scale and annotations from the active document directly
  const doc = state.documents[state.activeDocumentIndex];
  const scale = doc ? doc.scale : 1;
  const annotations = lagen.markeringen && doc ? (pageAnnotations ?? doc.annotations) : [];

  // Apply scale transformation for zooming (includes hi-DPI factor)
  const dpr = overrideDpr !== undefined ? overrideDpr : (window.devicePixelRatio || 1);
  const effectiveScale = scale * dpr;
  ctx.save();
  ctx.scale(effectiveScale, effectiveScale);
  if (renderOffset) ctx.translate(-renderOffset.x, -renderOffset.y);
  if (weergave) ctx.transform(...weergave);

  // Draw watermarks behind content. Gedraaide weergave: de watermerken
  // staan in de paginaruimte en rekenen dus met de paginamaat.
  let wmW = pageDims ? pageDims.w : width / effectiveScale;
  let wmH = pageDims ? pageDims.h : height / effectiveScale;
  if (weergave) {
    const m = paginaMaat(pageNum, doc);
    if (m) { wmW = m.breedte; wmH = m.hoogte; }
  }
  renderWatermarksBehind(ctx, pageNum, wmW, wmH);

  // Draw text edits (cover-and-replace)
  drawTextEdits(ctx, pageNum);

  // Space outlines (Spaces panel): an editing aid, not in print or export.
  if (lagen.bewerkhulp) drawSpaceOverlay(ctx, doc, pageNum, effectiveScale);

  // Viewport-culling. Dit canvas dekt alleen de zichtbare uitsnede van de
  // pagina (zie setupContinuousAnnotationCanvas); alles daarbuiten kostte tot
  // nu toe wél een volledige drawAnnotation.
  const cullMarge = 200 / (effectiveScale || 1);
  let cvX = (renderOffset ? renderOffset.x : 0) - cullMarge;
  let cvY = (renderOffset ? renderOffset.y : 0) - cullMarge;
  let cvW = width / effectiveScale + cullMarge * 2;
  let cvH = height / effectiveScale + cullMarge * 2;
  if (weergave) {
    // De uitsnede is een stuk van de gedraaide pagina: terug naar de pagina.
    const r = weergaveRectNaarPagina(pageNum, { x: cvX, y: cvY, width: cvW, height: cvH }, doc);
    cvX = r.x; cvY = r.y; cvW = r.width; cvH = r.height;
  }

  // In de weergave (geen afdruk/export: _lagen leeg) tekent de pagina-bitmap
  // onbewerkte ingelezen markeringen al uit hun /AP (pdf/ap-render-state.js).
  const apAlGetekend = _lagen ? null : apInBitmap(doc, pageNum);
  // Alleen de markeringen van deze pagina (page-buckets.js), niet per
  // zichtbare pagina de hele lijst.
  const dezePagina = pageAnnotations && annotations === pageAnnotations
    ? annotations
    : pageSlots(annotations, pageNum).map(slot => annotations[slot]);
  if (lagen.bewerkhulp) drawExtensionUnderlays(ctx, pageNum, doc);
  metWeergaveDoorloop(() => metSchaalBronnen(() => eachUnderlayFirst(dezePagina, pageNum, (a) => { if (!apAlGetekend?.has(a.id) && !_buitenBeeld(a, cvX, cvY, cvW, cvH)) { ctx.save(); drawAnnotation(ctx, a, snippetBitmaps); ctx.restore(); } })));
  metWeergaveDoorloop(() => metSchaalBronnen(() => dezePagina.forEach(annotation => {
    if (!annotation || annotation.page !== pageNum) return;
    if (edition.rendering?.isUnderlay?.(annotation)) return;
    if (apAlGetekend?.has(annotation.id)) return;
    if (_buitenBeeld(annotation, cvX, cvY, cvW, cvH)) return;
    // Mengmodus en clip lekken niet naar de volgende markering.
    ctx.save();
    drawAnnotation(ctx, annotation, snippetBitmaps);
    ctx.restore();
  })));

  // Draw watermarks in front of content
  renderWatermarksInFront(ctx, pageNum, wmW, wmH);

  // Vanaf hier alleen bewerkingstoestand: die hoort niet in een afdruk,
  // export of voorbeeld (lagen.selectie en lagen.bewerkhulp).
  // Blender-achtige 2D-cursor (Shift+rechtsklik). Werd alleen in het
  // enkelpagina-pad getekend; in de doorlopende weergave plaatste de klik hem
  // dus onzichtbaar. Zelfde gate op de pagina als de enkelpagina-render.
  if (lagen.bewerkhulp && doc?.cursor2D && doc.cursor2D.page === pageNum) {
    _draw2DCursor(ctx, doc.cursor2D.x, doc.cursor2D.y, effectiveScale);
  }

  // Selectie-omranding en grippunten. Dit pad tekende ze niet, waardoor een
  // selectie in de doorlopende weergave onzichtbaar bleef: geen grippunten op
  // tekstblokken en geen visuele bevestiging na knippen/plakken. Zelfde bron
  // (selectedAnnotations) en zelfde volgorde als de enkelpagina-render.
  const selected = lagen.selectie && doc ? doc.selectedAnnotations : [];
  if (selected && selected.length > 0) {
    for (const ann of selected) {
      if (ann.page !== pageNum) continue;
      if (isAnnotationHiddenInView(ann)) continue;
      drawSelectionHandles(ctx, ann);
    }
  }

  // Rubber-band selection marquee on the page the drag started on (continuous).
  if (lagen.bewerkhulp && state.isRubberBanding && state.rubberBandPage === pageNum) {
    drawRubberBand(ctx, effectiveScale);
  }
  if (lagen.bewerkhulp) drawRegionSelection(ctx, pageNum, effectiveScale);
  if (lagen.bewerkhulp) drawEditToolOverlay(ctx, pageNum, effectiveScale);
  if (lagen.bewerkhulp) drawRacewayGesture(ctx, pageNum, effectiveScale);

  // Image alignment guides on the page being edited (continuous). Same
  // state-driven principle as single-page mode: drawn here so the viewport's
  // RAF re-render can't wipe them.
  if (lagen.bewerkhulp && state._imageAlignGuides && state._imageAlignGuides.length > 0 &&
      state._imageAlignGuidesPage === pageNum) {
    drawImageAlignGuides(ctx, state._imageAlignGuides, effectiveScale);
  }

  if (lagen.bewerkhulp) {
    // Interactive image-crop overlay for the page being cropped (continuous).
    drawImageCropOverlay(ctx, pageNum);

    // Visual Search results (Search panel).
    drawVisualSearchOverlay(ctx, pageNum);
    drawExtensionOverlays(ctx, pageNum);

    // Embedded image-removal tool highlights (issue #184).
    drawEmbeddedImageOverlay(ctx, pageNum);

    // Dynamic Fill preview: fills and temporary boundary lines.
    drawDynamicFillOverlay(ctx, pageNum);
  }

  // Restore context
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ── Scherpe annotatie-overlay (doorlopende weergave, hoge zoom) ─────────────
// Het basis-annotatiecanvas per pagina is gecapt op een vaste as-limiet (zie
// setupContinuousAnnotationCanvas in renderer.js): boven ~700% zoom wordt het
// CSS-opgerekt en dus korrelig. Annotaties zijn vectorwerk, dus we leggen er
// bij hoge zoom een tweede canvas overheen dat ALLEEN de zichtbare uitsnede
// van de pagina op volle resolutie tekent (viewport-groot, dus altijd binnen
// de canvaslimieten). pointer-events: none — hit-testing blijft op het
// basiscanvas. Het basiscanvas wordt dan leeggemaakt zodat halftransparante
// annotaties niet dubbel composieten.
// UITGESCHAKELD (2026-09-01) — zie SCHERPE_OVERLAYS_ACTIEF in renderer.js:
// extra overlay-lagen lieten de paginacanvas zelf wit rasteren op zware
// bladen. Basiscanvas tekent weer gewoon zelf (korrelig boven ~700%, maar
// altijd correct) tot het herontwerp zonder extra lagen.
const SCHERPE_ANN_OVERLAY_ACTIEF = false;

export function updateContinuousSharpOverlay(wrapper, pageNum) {
  if (!SCHERPE_ANN_OVERLAY_ACTIEF) {
    wrapper?.querySelectorAll('.annotation-canvas-sharp').forEach((c) => c.remove());
    return;
  }
  const container = document.getElementById('pdf-container');
  const baseCanvas = wrapper?.querySelector('.annotation-canvas');
  const cc = wrapper?.querySelector('.canvas-container-cont');
  if (!container || !baseCanvas || !cc) return;
  const dpr = window.devicePixelRatio || 1;
  const backingScale = parseFloat(baseCanvas.dataset.backingScale);
  let sharp = cc.querySelector('.annotation-canvas-sharp');
  // Basiscanvas op volle resolutie? Dan is er niets te verscherpen.
  if (!Number.isFinite(backingScale) || backingScale >= dpr - 0.01) {
    if (sharp) sharp.style.display = 'none';
    return;
  }
  const contRect = container.getBoundingClientRect();
  const ccRect = cc.getBoundingClientRect();
  // Zichtbare uitsnede van de pagina in CSS-px (relatief aan de pagina).
  const visLinks = Math.max(0, contRect.left - ccRect.left);
  const visBoven = Math.max(0, contRect.top - ccRect.top);
  const visRechts = Math.min(ccRect.width, contRect.right - ccRect.left);
  const visOnder = Math.min(ccRect.height, contRect.bottom - ccRect.top);
  const visB = visRechts - visLinks;
  const visH = visOnder - visBoven;
  if (visB <= 0 || visH <= 0) {
    if (sharp) sharp.style.display = 'none';
    return;
  }
  if (!sharp) {
    sharp = document.createElement('canvas');
    sharp.className = 'annotation-canvas-sharp';
    sharp.style.position = 'absolute';
    sharp.style.pointerEvents = 'none';
    baseCanvas.insertAdjacentElement('afterend', sharp);
  }
  sharp.width = Math.max(1, Math.floor(visB * dpr));
  sharp.height = Math.max(1, Math.floor(visH * dpr));
  sharp.style.width = `${visB}px`;
  sharp.style.height = `${visH}px`;
  sharp.style.left = `${visLinks}px`;
  sharp.style.top = `${visBoven}px`;
  sharp.style.display = '';
  // z-orde meebewegen met het basiscanvas (editText verlaagt die tijdelijk).
  sharp.style.zIndex = baseCanvas.style.zIndex || '';
  const doc = state.documents[state.activeDocumentIndex];
  const scale = doc ? doc.scale : 1;
  renderAnnotationsForPage(
    sharp.getContext('2d'), pageNum, sharp.width, sharp.height, dpr,
    { x: visLinks / scale, y: visBoven / scale },
    undefined, undefined, weergaveTransform(pageNum, doc),
  );
  // Basis leegmaken: de overlay dekt het zichtbare deel al scherp af.
  const bctx = baseCanvas.getContext('2d');
  bctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
}

// Verberg alle scherpe overlays (tijdens een zoomgebaar kloppen positie en
// uitsnede niet meer; de eerstvolgende settle-hertekening zet ze terug).
export function hideContinuousSharpOverlays() {
  document.querySelectorAll('.annotation-canvas-sharp').forEach((c) => { c.style.display = 'none'; });
}

// Ververs de overlays van alle zichtbare pagina's (na zoom-/scroll-settle en
// na annotatiewijzigingen).
export function updateAllContinuousSharpOverlays() {
  // De scherpe-overlaylaag staat uit; zonder deze poort deed elke aanroep
  // alsnog een getBoundingClientRect per pagina (geforceerde layout-reflow)
  // voor werk dat direct weer terugkeert.
  if (!SCHERPE_ANN_OVERLAY_ACTIEF) return;
  const container = document.getElementById('pdf-container');
  if (!container) return;
  const contRect = container.getBoundingClientRect();
  document.querySelectorAll('#continuous-container .page-wrapper').forEach((wrapper) => {
    const pageNum = parseInt(wrapper.dataset.page, 10);
    if (!pageNum) return;
    const r = wrapper.getBoundingClientRect();
    if (r.top < contRect.bottom && r.bottom > contRect.top) {
      updateContinuousSharpOverlay(wrapper, pageNum);
    } else {
      const sharp = wrapper.querySelector('.annotation-canvas-sharp');
      if (sharp) sharp.style.display = 'none';
    }
  });
}

// Redraw all pages in continuous mode.
// lightweight=true tijdens slepen/resizen: alleen de zichtbare pagina's
// hertekenen en de ribbon-/knoppen-verversing overslaan. Zonder die vlag
// draaide elke muisbeweging een volledige annotatie-scan per pagina — op een
// document van 200 bladen is dat 200x de hele array per frame.
export function redrawContinuous(lightweight = false) {
  const perfT0 = performance.now();
  try { return redrawContinuousNow(lightweight); } finally { perfRecord(lightweight ? 'redraw.continuous.frame' : 'redraw.continuous.full', performance.now() - perfT0); }
}

function redrawContinuousNow(lightweight = false) {
  if (_naHertekenen) _naHertekenen();
  notifyRedrawn(lightweight);
  // A tool preview (rubber band, polyline, measurement, raceway, hover snap)
  // redraws from inside a pointer move without the lightweight flag; it only
  // changes what is near the pointer, and pointer-up redraws everything.
  const _cull = lightweight || _inPointerBeweging > 0;
  const _cullContainer = _cull ? document.getElementById('pdf-container') : null;
  const _cullRect = _cullContainer ? _cullContainer.getBoundingClientRect() : null;
  const CULL_MARGE_PX = 200;
  // Only resident pages own an annotation canvas. Distant placeholders are
  // rebuilt from current document state when they enter the viewport again.
  const pageCanvases = document.querySelectorAll('#continuous-container .page-wrapper .annotation-canvas');
  const resident = [];
  pageCanvases.forEach(canvas => {
    const wrapper = canvas.closest('.page-wrapper');
    if (!wrapper) return;
    if (_cullRect) {
      const r = wrapper.getBoundingClientRect();
      if (r.bottom < _cullRect.top - CULL_MARGE_PX || r.top > _cullRect.bottom + CULL_MARGE_PX) return;
    }
    const pageNum = parseInt(wrapper.dataset.page, 10);
    if (Number.isFinite(pageNum)) resident.push({ canvas, pageNum });
  });
  // A full redraw can touch several resident pages. Walk the document once
  // and preserve paint order within each page rather than scanning all
  // markups once for every canvas.
  const doc = state.documents[state.activeDocumentIndex];
  const annotationsByPage = new Map(resident.map(({ pageNum }) => [pageNum, []]));
  if (doc && annotationsByPage.size) {
    // Per page from its slots (page-buckets.js): only that page's markups
    // are read through the store.
    const all = doc.annotations;
    for (const pageNum of annotationsByPage.keys()) {
      annotationsByPage.set(pageNum, pageSlots(all, pageNum).map((slot) => all[slot]));
    }
  }
  resident.forEach(({ canvas, pageNum }) => {
    if (canvas) {
      const ctx = canvas.getContext('2d');
      // Viewport-gebonden uitsnede (zie setupContinuousAnnotationCanvas):
      // backing-schaal en clip-offset meegeven zodat de tekening exact op de
      // uitsnede past.
      const backingScale = parseFloat(canvas.dataset.backingScale);
      const schaal = (doc && doc.scale) || 1;
      const cc = canvas.parentElement;
      const ccW = cc ? parseFloat(cc.style.width) || cc.getBoundingClientRect().width : 0;
      const ccH = cc ? parseFloat(cc.style.height) || cc.getBoundingClientRect().height : 0;
      renderAnnotationsForPage(ctx, pageNum, canvas.width, canvas.height,
        Number.isFinite(backingScale) ? backingScale : undefined,
        { x: (parseFloat(canvas.dataset.clipX) || 0) / schaal, y: (parseFloat(canvas.dataset.clipY) || 0) / schaal },
        ccW > 0 && ccH > 0 ? { w: ccW / schaal, h: ccH / schaal } : undefined,
        undefined, weergaveTransform(pageNum, doc), annotationsByPage.get(pageNum));
    }
  });
  updateAllContinuousSharpOverlays();

  // Single-page redraws refresh the Markups List here. Continuous view used
  // to update the ribbon only, so a click in that view never selected the row.
  if (!lightweight) werkPanelenBij();
}

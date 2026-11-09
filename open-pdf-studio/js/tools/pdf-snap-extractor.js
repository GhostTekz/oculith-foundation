import { state, getActiveDocument } from '../core/state.js';
import { OPS } from 'pdfjs-dist';
import { getPageRotation } from '../core/state.js';
import { slaSnapExtractieOver } from './snap-extractie-beleid.js';
import RBush from '../vendor/rbush.js';
import { nativeOcgPdfJsConfig, nativeOcgSelectionForDocument } from '../pdf/native-ocg-selection.js';

/**
 * PDF Vector Geometry Snap Extractor
 *
 * Parses pdf.js page.getOperatorList() to extract vector geometry
 * (lines, rectangles, curves) and produces snap points + edge segments
 * in the annotation coordinate system (CSS pixels at scale=1).
 *
 * In pdf.js v5.x, constructPath (OPS 91) bundles both path drawing AND
 * the paint operation. Args format:
 *   a[0] = paint OPS code (stroke=20, fill=22, endPath=28, etc.)
 *   a[1] = [interleavedData] — flat array of [op, coords..., op, coords...]
 *   a[2] = minMax bounding box
 *
 * DrawOPS sub-opcodes in the interleaved data:
 *   0=moveTo(x,y), 1=lineTo(x,y), 2=curveTo(6 args),
 *   3=quadraticCurveTo(4 args), 4=closePath(0 args)
 *
 * Results are cached per page and cleared on document switch.
 */

// DrawOPS constants (used inside constructPath interleaved data)
const DRAW_MOVETO = 0;
const DRAW_LINETO = 1;
const DRAW_CURVETO = 2;
const DRAW_QUADRATIC = 3;
const DRAW_CLOSEPATH = 4;

// Cache: pageNum → { points, edges, index: { pointTree, edgeTree } }
const pageCache = new Map();

// Currently running extraction promises (to avoid duplicate work)
const pendingExtractions = new Map();

/**
 * Prefetch PDF vector geometry for a single page (fire-and-forget).
 */
export function prefetchPdfVectorGeometry(pageNum) {
  if (pageCache.has(pageNum)) return;
  if (pendingExtractions.has(pageNum)) return;

  // Geometry of the layers shown now; a layer change clears the cache, and a
  // result read under the previous layer view is not kept.
  const doc = getActiveDocument();
  const layerRevision = nativeOcgSelectionForDocument(doc).revision;
  const promise = extractPageGeometry(pageNum)
    .then(result => {
      if (pendingExtractions.get(pageNum) !== promise) return;
      if (getActiveDocument() !== doc || nativeOcgSelectionForDocument(doc).revision !== layerRevision) return;
      pageCache.set(pageNum, result);
    })
    .catch(() => {
      // Silently ignore extraction errors
    })
    .finally(() => {
      pendingExtractions.delete(pageNum);
    });

  pendingExtractions.set(pageNum, promise);
}

/**
 * The cached geometry of one page, extracting it first when needed (Dynamic
 * Fill). Resolves to { points, edges } (empty for a raster sheet) or null
 * when extraction failed.
 */
export async function ensurePdfVectorGeometry(pageNum) {
  if (!pageCache.has(pageNum)) {
    prefetchPdfVectorGeometry(pageNum);
    await pendingExtractions.get(pageNum);
  }
  return pageCache.get(pageNum) || null;
}

/**
 * Load PDF vector snap data for all pages. Returns a promise.
 * Called on-demand when user activates snap-to-drawing.
 */
export async function loadAllPdfSnapData() {
  const pdfDoc = getActiveDocument()?.pdfDoc;
  if (!pdfDoc) return;

  const total = pdfDoc.numPages;
  const promises = [];
  for (let p = 1; p <= total; p++) {
    if (!pageCache.has(p) && !pendingExtractions.has(p)) {
      prefetchPdfVectorGeometry(p);
    }
    if (pendingExtractions.has(p)) {
      promises.push(pendingExtractions.get(p));
    }
  }
  await Promise.all(promises);
}

/**
 * Check if snap data is loaded for the current page.
 */
export function isPdfSnapLoaded(pageNum) {
  return pageCache.has(pageNum);
}

/**
 * Get ALL cached snap points for a page (synchronous).
 * Returns empty array if not yet extracted.
 * Prefer getPdfSnapPointsNear() on the hot mousemove path — this full-set
 * accessor is for one-shot consumers (e.g. move-session candidate caching).
 */
export function getCachedPdfSnapPoints(pageNum) {
  const cached = pageCache.get(pageNum);
  return cached ? cached.points : [];
}

/**
 * Get ALL cached edge segments for a page (synchronous).
 * Returns empty array if not yet extracted.
 */
export function getCachedPdfEdgeSegments(pageNum) {
  const cached = pageCache.get(pageNum);
  return cached ? cached.edges : [];
}

function pointWrap(p) {
  return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y, pt: p };
}

function edgeWrap(e) {
  const minX = Math.min(e.x1, e.x2);
  const minY = Math.min(e.y1, e.y2);
  const maxX = Math.max(e.x1, e.x2);
  const maxY = Math.max(e.y1, e.y2);
  return { minX, minY, maxX, maxY, edge: e };
}

function treesFrom(pointItems, edgeItems) {
  const pointTree = new RBush();
  const edgeTree = new RBush();
  if (pointItems.length) pointTree.load(pointItems);
  if (edgeItems.length) edgeTree.load(edgeItems);
  return { pointTree, edgeTree };
}

// One RBush.load of the conduit sheet's 544,736 points and 174,237 edges
// held the main thread for 476 ms. Slices of 8000 on that sheet stayed at
// 19 ms, and a search of the sliced tree matches one load. A later load()
// merges into the tree already built.
const INDEX_LOAD_CHUNK = 8000;

async function loadTree(tree, items, pause) {
  const total = items.length;
  if (!total) return;
  if (total <= INDEX_LOAD_CHUNK) {
    tree.load(items);
    return;
  }
  for (let start = 0; start < total; start += INDEX_LOAD_CHUNK) {
    tree.load(items.slice(start, start + INDEX_LOAD_CHUNK));
    if (start + INDEX_LOAD_CHUNK < total) await pause();
  }
}

async function treesFromYielding(pointItems, edgeItems, pause) {
  const pointTree = new RBush();
  const edgeTree = new RBush();
  await loadTree(pointTree, pointItems, pause);
  await loadTree(edgeTree, edgeItems, pause);
  return { pointTree, edgeTree };
}

/**
 * R-tree over one point and one edge wrapper each. The point and edge
 * objects are not given minX/minY; long edges are ordinary items.
 */
function wrappedSnapItems(points, edges) {
  const pointItems = new Array(points.length);
  for (let i = 0; i < points.length; i++) pointItems[i] = pointWrap(points[i]);
  const edgeItems = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) edgeItems[i] = edgeWrap(edges[i]);
  return { pointItems, edgeItems };
}

export function pdfSnapIndex(points, edges) {
  const { pointItems, edgeItems } = wrappedSnapItems(points, edges);
  return treesFrom(pointItems, edgeItems);
}

/** Same index as pdfSnapIndex, built in slices so a dense page can yield. */
export async function pdfSnapIndexInSlices(points, edges) {
  const { pointItems, edgeItems } = wrappedSnapItems(points, edges);
  return treesFromYielding(pointItems, edgeItems, pacer());
}

/** Points and edges whose boxes meet the square of `radius` around (x, y). */
export function searchPdfSnapIndex(index, x, y, radius) {
  const r = Number.isFinite(radius) ? radius : 0;
  const box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
  const pointHits = index.pointTree.search(box);
  const edgeHits = index.edgeTree.search(box);
  const points = new Array(pointHits.length);
  const edges = new Array(edgeHits.length);
  for (let i = 0; i < pointHits.length; i++) points[i] = pointHits[i].pt;
  for (let i = 0; i < edgeHits.length; i++) edges[i] = edgeHits[i].edge;
  return { points, edges };
}

function hasSnapIndex(idx) {
  return !!(idx && idx.pointTree && idx.edgeTree);
}

/**
 * Get snap points within `radius` (annotation px) of (x,y) on a page.
 * Uses the spatial index so cost scales with local density, not page total.
 */
export function getPdfSnapPointsNear(pageNum, x, y, radius) {
  const cached = pageCache.get(pageNum);
  if (!cached) return [];
  if (!hasSnapIndex(cached.index)) return cached.points;
  return searchPdfSnapIndex(cached.index, x, y, radius).points;
}

/**
 * Get edge segments near (x,y) within `radius`. Each edge is one tree item,
 * so a segment is returned once.
 */
export function getPdfEdgeSegmentsNear(pageNum, x, y, radius) {
  const cached = pageCache.get(pageNum);
  if (!cached) return [];
  if (!hasSnapIndex(cached.index)) return cached.edges;
  return searchPdfSnapIndex(cached.index, x, y, radius).edges;
}

/**
 * Build an R-tree over the extracted points and edges. Yields every 2000
 * items so a dense page does not freeze the UI while the wrappers are made.
 */
/**
 * Gives the event loop a turn once the work has held the thread for about
 * a frame (checked at the callers' usual points), then runs `checkActive`.
 * A turn at every check point made a dense sheet wait on hundreds of timer
 * ticks for no gain in responsiveness.
 */
function pacer(checkActive = () => {}, budgetMs = 12) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < budgetMs) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    checkActive();
    last = performance.now();
  };
}

async function buildSpatialIndex(points, edges, pause = pacer()) {
  const pointItems = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && i % 2000 === 0) await pause();
    pointItems[i] = pointWrap(points[i]);
  }

  const edgeItems = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    if (i > 0 && i % 2000 === 0) await pause();
    edgeItems[i] = edgeWrap(edges[i]);
  }

  return treesFromYielding(pointItems, edgeItems, pause);
}

/**
 * Clear the entire cache (call on document switch).
 */
export function clearPdfVectorCache() {
  pageCache.clear();
  pendingExtractions.clear();
}

/**
 * Extract vector geometry from a PDF page's operator list.
 * Transforms all coordinates to annotation-space (CSS pixels at scale=1).
 * `options.edgesOnly` returns the edges alone (no snap points, no index).
 */
export async function extractPageGeometry(pageNum, options = {}) {
  const doc = options.document || getActiveDocument();
  const pdfDoc = doc?.pdfDoc;
  if (!pdfDoc) return { points: [], edges: [] };
  const checkActive = () => {
    if (options.signal?.aborted || (options.document && getActiveDocument() !== doc)) {
      throw new DOMException('Vector extraction aborted', 'AbortError');
    }
  };
  checkActive();

  // Rasterblad zonder vectorinhoud (gescande tekening: één grote JPEG)?
  // Dan niets uitlezen: getOperatorList() zou de hele afbeelding in
  // JavaScript decoderen (seconden per pagina) voor een lege snap-set.
  // Zie snap-extractie-beleid.js voor de smalle regel.
  if (doc.filePath) {
    const [{ getCachedPageType, cachePageType }, { pageContentBytes }, { isTauri, invoke }] = await Promise.all([
      import('../pdf/page-type-cache.js'),
      import('../pdf/progressive-render.js'),
      import('../core/platform.js'),
    ]);
    let pageType = getCachedPageType(doc.filePath, pageNum - 1);
    if (!pageType && isTauri()) {
      try {
        pageType = await invoke('analyze_page_type', { path: doc.filePath, pageIndex: pageNum - 1 });
        cachePageType(doc.filePath, pageNum - 1, pageType);
      } catch { /* PDF.js remains the fallback when native classification fails. */ }
      checkActive();
    }
    const contentBytes = pageType === 'tile' ? await pageContentBytes(doc.filePath, pageNum) : 0;
    if (slaSnapExtractieOver({ pageType, contentBytes })) {
      console.log(`[snap] p${pageNum}: rasterblad zonder vectorinhoud (${contentBytes} B) → geometrie-extractie overgeslagen`);
      return { points: [], edges: [] };
    }
  }

  const page = await pdfDoc.getPage(pageNum);
  checkActive();

  // Get viewport at scale 1 (annotation coordinate system)
  const extraRotation = getPageRotation(pageNum);
  const vpOpts = { scale: 1 };
  if (extraRotation) {
    vpOpts.rotation = (page.rotate + extraRotation) % 360;
  }
  const viewport = page.getViewport(vpOpts);
  const viewportTransform = viewport.transform;

  const opList = await page.getOperatorList();
  checkActive();
  // Hidden PDF layers give no snap points or edges (docs/foundation/PDF-LAYERS.md).
  // `options.allLayers` reads every layer regardless of the view.
  const ocConfig = options.allLayers ? null : await nativeOcgPdfJsConfig(doc).catch(() => null);
  checkActive();
  const layers = optionalContentTracker(ocConfig);

  // PDF transform matrix stack (with the line width, which save/restore
  // also scope)
  const matrixStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;

  // Final results
  const points = [];
  const edges = [];
  const pointSet = new Set(); // dedup

  const pause = pacer(checkActive);
  // Only the edges (a reader of the line work, not snapping): no snap
  // points and no index.
  const edgesOnly = !!options.edgesOnly;

  const ops = opList.fnArray;
  const argsArray = opList.argsArray;

  for (let i = 0; i < ops.length; i++) {
    if (i % 2000 === 1999) await pause();
    const op = ops[i];
    const a = argsArray[i];

    if (op === OPS.beginMarkedContentProps) { layers.begin(a); continue; }
    if (op === OPS.beginMarkedContent) { layers.begin(null); continue; }
    if (op === OPS.endMarkedContent) { layers.end(); continue; }
    if (layers.hidden() && (op === OPS.constructPath || op === OPS.rectangle)) continue;

    switch (op) {
      case OPS.save:
        matrixStack.push([ctm.slice(), lineWidth]);
        break;

      case OPS.restore:
        if (matrixStack.length > 0) {
          [ctm, lineWidth] = matrixStack.pop();
        }
        break;

      case OPS.setLineWidth:
        if (Number.isFinite(a?.[0])) lineWidth = a[0];
        break;

      case OPS.setGState:
        for (const [k, v] of a?.[0] || []) if (k === 'LW' && Number.isFinite(v)) lineWidth = v;
        break;

      case OPS.transform: {
        const [ta, tb, tc, td, te, tf] = a;
        ctm = multiplyMatrices(ctm, [ta, tb, tc, td, te, tf]);
        break;
      }

      case OPS.constructPath: {
        // pdf.js v5.x format:
        //   a[0] = paint OPS code (endPath=28, fill=22, stroke=20, etc.)
        //   a[1] = [interleavedPathData] — array containing one typed-array-like object
        //   a[2] = minMax bounding box
        const pathData = a[1]?.[0];
        if (!pathData || !pathData.length) break;

        // Parse interleaved path data and collect segments
        const segments = await parseInterleavedPathData(pathData, pause);

        // Commit all segments (even endPath — for snap purposes all geometry is useful).
        // Each edge carries how it was painted and its stroke width in page
        // points, so Dynamic Fill can ignore thin lines and unpainted clip paths.
        if (segments.length > 0) {
          const meta = { paint: paintKind(a[0]), w: strokeWidthOnPage(lineWidth, ctm, viewportTransform) };
          await commitSegments(segments, ctm, viewportTransform, edgesOnly ? null : points, edges, pointSet, pause, meta);
        }
        break;
      }

      case OPS.rectangle: {
        const [rx, ry, rw, rh] = a;
        const rectPath = [
          { x: rx, y: ry },
          { x: rx + rw, y: ry },
          { x: rx + rw, y: ry + rh },
          { x: rx, y: ry + rh },
          { x: rx, y: ry }
        ];
        await commitSegments([rectPath], ctm, viewportTransform, edgesOnly ? null : points, edges, pointSet, pause);
        break;
      }
    }
  }

  if (edgesOnly) return { points, edges };
  return { points, edges, index: await buildSpatialIndex(points, edges, pause) };
}

/**
 * Tracks whether the current content is in a hidden optional-content group,
 * the same way PDF.js decides it while painting: a marked-content section
 * with an /OC property is hidden when its group (or membership dictionary)
 * is not visible, and everything nested inside a hidden section is hidden.
 * @param {{isVisible: (group: any) => boolean}|null} config
 */
export function optionalContentTracker(config) {
  const stack = [];
  let hiddenDepth = 0;
  return {
    begin(args) {
      const isOc = Array.isArray(args) && args[0] === 'OC';
      let hidden = false;
      if (isOc && config && args[1]) {
        try { hidden = !config.isVisible(args[1]); } catch { hidden = false; }
      }
      stack.push(hidden);
      if (hidden) hiddenDepth++;
    },
    end() {
      if (stack.pop()) hiddenDepth--;
    },
    hidden: () => hiddenDepth > 0,
  };
}

/**
 * Parse interleaved path data [op, args..., op, args...] into path segments.
 * Returns array of subpaths, where each subpath is an array of {x,y} points.
 */
async function parseInterleavedPathData(data, pause = pacer()) {
  const segments = [];
  let currentPath = [];
  let currentX = 0, currentY = 0;
  let i = 0;
  let nextYield = 10000;

  while (i < data.length) {
    if (i >= nextYield) {
      nextYield = i + 10000;
      await pause();
    }
    const drawOp = data[i++];

    switch (drawOp) {
      case DRAW_MOVETO: {
        // Flush previous subpath
        if (currentPath.length >= 2) {
          segments.push(currentPath);
        }
        currentX = data[i++];
        currentY = data[i++];
        currentPath = [{ x: currentX, y: currentY }];
        break;
      }

      case DRAW_LINETO: {
        currentX = data[i++];
        currentY = data[i++];
        currentPath.push({ x: currentX, y: currentY });
        break;
      }

      case DRAW_CURVETO: {
        const cp1x = data[i++], cp1y = data[i++];
        const cp2x = data[i++], cp2y = data[i++];
        const ex = data[i++], ey = data[i++];
        const startPt = { x: currentX, y: currentY };
        for (let s = 1; s <= 4; s++) {
          currentPath.push(cubicBezierPoint(
            startPt, { x: cp1x, y: cp1y }, { x: cp2x, y: cp2y }, { x: ex, y: ey }, s / 4
          ));
        }
        currentX = ex;
        currentY = ey;
        break;
      }

      case DRAW_QUADRATIC: {
        const qcpx = data[i++], qcpy = data[i++];
        const qex = data[i++], qey = data[i++];
        // Convert quadratic to cubic control points
        const qcp1x = currentX + 2 / 3 * (qcpx - currentX);
        const qcp1y = currentY + 2 / 3 * (qcpy - currentY);
        const qcp2x = qex + 2 / 3 * (qcpx - qex);
        const qcp2y = qey + 2 / 3 * (qcpy - qey);
        const startPt = { x: currentX, y: currentY };
        for (let s = 1; s <= 4; s++) {
          currentPath.push(cubicBezierPoint(
            startPt, { x: qcp1x, y: qcp1y }, { x: qcp2x, y: qcp2y }, { x: qex, y: qey }, s / 4
          ));
        }
        currentX = qex;
        currentY = qey;
        break;
      }

      case DRAW_CLOSEPATH:
        if (currentPath.length > 1) {
          currentPath.push({ x: currentPath[0].x, y: currentPath[0].y });
        }
        break;

      default:
        // Unknown op — skip (shouldn't happen)
        break;
    }
  }

  // Flush last subpath
  if (currentPath.length >= 2) {
    segments.push(currentPath);
  }

  return segments;
}

/**
 * Transform segments via CTM + viewport and produce snap points/edges.
 */
async function commitSegments(segments, ctm, viewportTransform, points, edges, pointSet, pause = pacer(), meta = null) {
  for (let index = 0; index < segments.length; index++) {
    if (index > 0 && index % 100 === 0) await pause();
    const path = segments[index];
    const transformed = path.map(pt => {
      // Apply CTM (PDF user space → PDF device space)
      const cx = ctm[0] * pt.x + ctm[2] * pt.y + ctm[4];
      const cy = ctm[1] * pt.x + ctm[3] * pt.y + ctm[5];
      // Apply viewport transform (PDF space → CSS pixel space)
      const vx = viewportTransform[0] * cx + viewportTransform[2] * cy + viewportTransform[4];
      const vy = viewportTransform[1] * cx + viewportTransform[3] * cy + viewportTransform[5];
      return { x: vx, y: vy };
    });

    for (let j = 0; j < transformed.length; j++) {
      const p = transformed[j];

      // Endpoint snap point
      const key = points && `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
      if (points && !pointSet.has(key)) {
        pointSet.add(key);
        points.push({ x: p.x, y: p.y, type: 'endpoint', annotation: null });
      }

      // Edge segments + midpoint snap
      if (j < transformed.length - 1) {
        const q = transformed[j + 1];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0.5) {
          edges.push(meta ? { x1: p.x, y1: p.y, x2: q.x, y2: q.y, paint: meta.paint, w: meta.w }
            : { x1: p.x, y1: p.y, x2: q.x, y2: q.y });

          if (!points) continue;
          const mx = (p.x + q.x) / 2;
          const my = (p.y + q.y) / 2;
          const mkey = `${Math.round(mx * 10)},${Math.round(my * 10)}`;
          if (!pointSet.has(mkey)) {
            pointSet.add(mkey);
            points.push({ x: mx, y: my, type: 'midpoint', annotation: null });
          }
        }
      }
    }
  }
}

/**
 * How a constructPath was painted: 's' stroke, 'f' fill, 'fs' fill and
 * stroke, 'n' not painted (endPath: a clip path or an invisible path).
 */
export function paintKind(op) {
  switch (op) {
    case OPS.stroke: case OPS.closeStroke: return 's';
    case OPS.fill: case OPS.eoFill: return 'f';
    case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke: return 'fs';
    case OPS.endPath: return 'n';
    default: return undefined;
  }
}

/**
 * A line width in user space as a width in page points: scaled by the CTM
 * and the viewport (their area scale). Width 0 (the thinnest line a device
 * can draw) stays 0.
 */
export function strokeWidthOnPage(lw, ctm, vt) {
  if (!(lw > 0)) return 0;
  const det = Math.abs((ctm[0] * ctm[3] - ctm[1] * ctm[2]) * (vt[0] * vt[3] - vt[1] * vt[2]));
  return lw * Math.sqrt(det);
}

/**
 * Multiply two 2D affine transform matrices [a,b,c,d,e,f].
 * Result = A * B (B applied first, then A).
 */
function multiplyMatrices(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5]
  ];
}

/**
 * Evaluate a point on a cubic bezier curve at parameter t.
 */
function cubicBezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y
  };
}

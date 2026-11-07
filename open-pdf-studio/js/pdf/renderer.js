import { perfRecord } from '../core/perf.js';
import { state, getActiveDocument, getPageRotation, setPageRotation } from '../core/state.js';
import { nativeOcgPdfJsConfig, nativeOcgSelectionForDocument, nativeOcgSelectionForPath } from './native-ocg-selection.js';
import { sourceRenderRevision, sourceRenderCurrent, sourceWriteActive } from './source-render-revision.js';
import { isTauri, invoke } from '../core/platform.js';
import { doorlopendeRenderSchaal } from './device-pixel.js';
import { pdfjsFallbackNodig, rasterViewportNeeded } from './render-route.js';
import { bepaalOverlayMaat, pasOverlayMaatToe } from './overlay-canvas-size.js';
import { paginaGetekend } from './pagina-getekend.js';
import { PdfJsDetailLayer, PDFJS_DETAIL_BASE_MAX_AXIS_PX, zichtbaarDeel } from './pdfjs-detail-layer.js';
import { OPS as PDFJS_OPS } from 'pdfjs-dist';
import { hideLoading } from '../ui/chrome/dialogs.js';
import { noteViewBefore, noteViewAfter } from '../core/view-history.js';
// Always-fresh DOM refs (never stale regardless of init timing or bundler behavior)
function getPdfCanvas() { return document.getElementById('pdf-canvas'); }
function getAnnotationCanvas() { return document.getElementById('annotation-canvas'); }
import { redrawAnnotations, renderAnnotationsForPage, updateContinuousSharpOverlay, updateAllContinuousSharpOverlays } from '../annotations/rendering.js';
import { ensureAnnotationsForPage, annotationsRead, hidePdfABar, getCachedPdfBytes, notePagePainted } from './loader.js';
import { afterNextFrame } from '../core/yield-to-main.js';
import { updateAllStatus } from '../ui/chrome/status-bar.js';
import { hideProperties } from '../ui/panels/properties-panel.js';
import { updateActiveThumbnail, pauseThumbnails, resumeThumbnails, isThumbnailPipelineIdle } from '../ui/panels/left-panel.js';
import { noteActivity } from './pdfjs-idle-cleanup.js';
import { createSinglePageTextLayer, clearSinglePageTextLayer, createTextLayer, clearTextLayers, releaseTextLayerForPage, createTextLayerFromRust } from '../text/text-layer.js';
import { createSinglePageLinkLayer, clearSinglePageLinkLayer, createLinkLayer, clearLinkLayers, releaseLinkLayerForPage, applyOverlayPointerEvents } from './link-layer.js';
import { createSinglePageFormLayer, clearSinglePageFormLayer, createFormLayer, clearFormLayers, releaseFormLayerForPage, hideFormFieldsBar } from './form-layer.js';
import { clearPdfVectorCache, prefetchPdfVectorGeometry } from '../tools/pdf-snap-extractor.js';
import { clearDetectionCache } from '../tools/pdf-element-detector.js';
import { onPageRendered, clearHighlights } from '../search/find-bar.js';
import { showPagePlaceholder, hidePagePlaceholderWhenReady } from './page-transition.js';
import { anchorScrollCorrection, pickAnchorPageIndex } from './continuous-zoom-anchor.js';
import { createRerenderGate } from './continuous-rerender-gate.js';
import { ContinuousNativeDetailLayer } from './continuous-native-detail-layer.js';
import { weergaveRotatie, weergaveTransform } from './weergave-ruimte.js';
import { normaliseerRotatie, isKwartslag } from './weergave-rotatie.js';
import { rotateTextDir } from '../annotations/corrections/geometry.js';
import { isTextAnchored } from '../annotations/corrections/model.js';
import { stopAlleWielScrollers } from './wiel-scroll.js';
import { pageCanvasContext } from './page-canvas-context.js';
import { clipDektZicht, clipUitDataset, zichtbaarPaginaDeel } from './continuous-clip.js';
import { continuousPagesToRelease } from './continuous-residency.js';
import { registerBitmapCache, enforceBitmapBudget } from './bitmap-budget.js';
// Hi-DPI support: render canvases at device pixel ratio for sharp text
export function getCanvasDPR() { return window.devicePixelRatio || 1; }

// ─── JS-side bitmap CACHE (per-document, LRU-bounded) ───────────────────────
// Caches the fully-decoded ImageBitmap for each (file, page, scale, rotation)
// so revisits of an exact zoom level skip the entire Rust IPC + tempfile +
// ImageData rebuild pipeline (~300-500ms saved per hit). On a hit, render is
// just `drawImage(cachedBitmap)` which the GPU compositor handles in <10ms.
// Both entry count and bitmap bytes are bounded; a large sheet can occupy
// much more memory than several small pages. Bytes count toward the shared
// bitmap budget (bitmap-budget.js).
const _BITMAP_JS_CACHE = new Map();
const _bitmapJsEpochs = new Map();
const _BITMAP_JS_CACHE_MAX = 16;
function _bitmapJsCacheBytes() {
  let bytes = 0;
  for (const entry of _BITMAP_JS_CACHE.values()) bytes += entry.w * entry.h * 4;
  return bytes;
}
// Drop the least recently used entry; the newest one always stays.
function _bitmapJsEvictOldest() {
  if (_BITMAP_JS_CACHE.size <= 1) return 0;
  const oldest = _BITMAP_JS_CACHE.keys().next().value;
  const old = _BITMAP_JS_CACHE.get(oldest);
  _BITMAP_JS_CACHE.delete(oldest);
  try { old.bitmap?.close?.(); } catch {}
  return old.w * old.h * 4;
}
registerBitmapCache('continuous-bitmaps', { bytes: _bitmapJsCacheBytes, evictOldest: _bitmapJsEvictOldest });
const _bitmapJsPending = new Map();
let _bitmapJsGlobalEpoch = 0;
export function _bitmapJSCacheGet(key) {
  const entry = _BITMAP_JS_CACHE.get(key);
  if (entry) {
    // LRU touch: re-insert so the eviction order moves this entry to the end.
    _BITMAP_JS_CACHE.delete(key);
    _BITMAP_JS_CACHE.set(key, entry);
  }
  return entry || null;
}
export async function _bitmapJSCacheSet(key, imageData, filePath = key.split('|')[0]) {
  const epoch = _bitmapJsEpochs.get(filePath) || 0;
  const globalEpoch = _bitmapJsGlobalEpoch;
  const token = Symbol(key);
  _bitmapJsPending.set(key, token);
  try {
    const bitmap = await createImageBitmap(imageData);
    if ((_bitmapJsEpochs.get(filePath) || 0) !== epoch
        || _bitmapJsGlobalEpoch !== globalEpoch || _bitmapJsPending.get(key) !== token) {
      try { bitmap.close?.(); } catch {}
      return;
    }
    const replaced = _BITMAP_JS_CACHE.get(key);
    try { replaced?.bitmap?.close?.(); } catch {}
    _BITMAP_JS_CACHE.delete(key);
    _BITMAP_JS_CACHE.set(key, { bitmap, w: imageData.width, h: imageData.height });
    while (_BITMAP_JS_CACHE.size > _BITMAP_JS_CACHE_MAX && _bitmapJsEvictOldest() > 0) { /* drop the oldest */ }
    enforceBitmapBudget();
  } catch (e) {
    console.warn('[bitmap-cache] createImageBitmap failed:', e);
  } finally {
    if (_bitmapJsPending.get(key) === token) _bitmapJsPending.delete(key);
  }
}
export function clearBitmapJSCacheForFile(filePath) {
  if (getActiveDocument()?.filePath === filePath) _nativeContDetail.reset();
  _bitmapJsEpochs.set(filePath, (_bitmapJsEpochs.get(filePath) || 0) + 1);
  for (const key of _bitmapJsPending.keys()) {
    if (key.startsWith(filePath + '|')) _bitmapJsPending.delete(key);
  }
  // Wipe all entries for this filePath (used on close / save / annotation
  // changes that invalidate the rendered pixels).
  for (const k of Array.from(_BITMAP_JS_CACHE.keys())) {
    if (k.startsWith(filePath + '|')) {
      const e = _BITMAP_JS_CACHE.get(k);
      try { e?.bitmap?.close?.(); } catch {}
      _BITMAP_JS_CACHE.delete(k);
    }
  }
}
/** Wipe every entry in the JS-side ImageBitmap cache. Exposed for the MCP
 *  `app_clear_caches` test tool so an AI-driven debug loop can rule out
 *  stale cache as a contributor to anomalies. */
export function _clearJSBitmapCache() {
  _bitmapJsGlobalEpoch++;
  _bitmapJsPending.clear();
  _bitmapJsEpochs.clear();
  for (const k of Array.from(_BITMAP_JS_CACHE.keys())) {
    const e = _BITMAP_JS_CACHE.get(k);
    try { e?.bitmap?.close?.(); } catch {}
    _BITMAP_JS_CACHE.delete(k);
  }
}

// The page bitmap is PDFium (desktop worker, or @embedpdf/pdfium in the
// browser). PDF.js is the fallback when that path cannot run.

function setupCanvasHiDPI(canvas, width, height) {
  // Backing store hooguit CONT_MAX_AXIS_PX op de langste zijde: een nieuwe
  // pagina op diepe zoom (48 000 px breed op 800 % x dpr 2) kon niet eens
  // gealloceerd worden. De render daarna zet de echte maat.
  const longest = Math.max(width, height);
  const dpr = Math.min(getCanvasDPR(), longest > 0 ? CONT_MAX_AXIS_PX / longest : Infinity);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = Math.floor(width) + 'px';
  canvas.style.height = Math.floor(height) + 'px';
}

// Bitmap-axis cap voor de doorlopende weergave (zie renderContinuousPage):
// render op de grootste schaal die binnen de cap past en laat CSS rekken.
const CONT_MAX_AXIS_PX = 4096;

// Annotatiecanvas van één doorlopende pagina, met gecapte backing store.
// Ongecapt groeit hij mee met paginamaat × dpr en sterft hij boven de
// browserlimieten (as > 32767 of oppervlak > ~268M pixels — op een groot vel
// al rond 700% zoom): het canvas tekent dan stilletjes niets meer en alle
// annotaties verdwijnen. Zelfde as-cap als de paginabitmap; CSS rekt de rest.
// De werkelijke backing-schaal gaat als overrideDpr naar
// renderAnnotationsForPage zodat de tekening exact op de store past.
// Het annotatiecanvas dekt in de doorlopende weergave alleen de ZICHTBARE
// uitsnede van de pagina (plus een marge), op volle resolutie — zoals het
// enkelpagina-pad. Daarmee is het altijd scherp op elk zoomniveau, blijft de
// backing store klein (viewport-orde) en komen er geen extra lagen bij.
// De uitsnede (clipX/clipY, CSS-px pagina-relatief) reist mee via dataset;
// alle tekenroutes geven hem als renderOffset door en alle
// coordinaatberekeningen meten tegen de paginacontainer
// (.canvas-container-cont), niet tegen dit canvas.
const CONT_ANN_MARGE_PX = 256;

// `rects` ({cr, ccr}): client rects already read by the caller, so a loop
// over pages reads every rect before it resizes any canvas.
function setupContinuousAnnotationCanvas(canvas, width, height, rects = null) {
  const dpr = getCanvasDPR();
  const container = document.getElementById('pdf-container');
  const cc = canvas.parentElement;
  let clipX = 0, clipY = 0, clipW = width, clipH = height;
  if (container && cc) {
    const cr = rects?.cr || container.getBoundingClientRect();
    const ccr = rects?.ccr || cc.getBoundingClientRect();
    if (ccr.width > 1 && ccr.height > 1) {
      // Verhouding huidige rect <-> doelmaat (de cc kan net geresized zijn).
      const fx = width / ccr.width;
      const fy = height / ccr.height;
      const zichtL = Math.max(0, (cr.left - ccr.left) * fx - CONT_ANN_MARGE_PX);
      const zichtT = Math.max(0, (cr.top - ccr.top) * fy - CONT_ANN_MARGE_PX);
      const zichtR = Math.min(width, (cr.right - ccr.left) * fx + CONT_ANN_MARGE_PX);
      const zichtB = Math.min(height, (cr.bottom - ccr.top) * fy + CONT_ANN_MARGE_PX);
      if (zichtR > zichtL && zichtB > zichtT) {
        clipX = zichtL; clipY = zichtT; clipW = zichtR - zichtL; clipH = zichtB - zichtT;
      } else {
        // Pagina (nog) niet in beeld: minimaal canvas linksboven.
        clipW = Math.min(width, 2); clipH = Math.min(height, 2);
      }
    }
  }
  canvas.width = Math.max(1, Math.floor(clipW * dpr));
  canvas.height = Math.max(1, Math.floor(clipH * dpr));
  canvas.style.width = clipW + 'px';
  canvas.style.height = clipH + 'px';
  canvas.style.left = clipX + 'px';
  canvas.style.top = clipY + 'px';
  canvas.dataset.backingScale = dpr;
  canvas.dataset.clipX = clipX;
  canvas.dataset.clipY = clipY;
  // What clipDektZicht() compares against on the next scroll.
  canvas.dataset.clipW = clipW;
  canvas.dataset.clipH = clipH;
  canvas.dataset.clipPaginaW = width;
  canvas.dataset.clipPaginaH = height;
  return dpr;
}

// Herpositioneer + herteken het annotatiecanvas van een zichtbare pagina
// (na zoom-/scroll-settle). Goedkoop: vector-hertekening op viewportformaat.
function reclipContinuousAnnotationCanvas(wrapper, pageNum, gelezen = null) {
  const doc = getActiveDocument();
  const cc = gelezen?.cc || (wrapper && wrapper.querySelector('.canvas-container-cont'));
  const canvas = gelezen?.canvas || (cc && cc.querySelector('.annotation-canvas'));
  if (!doc || !cc || !canvas) return;
  const breedte = gelezen?.breedte || parseFloat(cc.style.width) || cc.getBoundingClientRect().width;
  const hoogte = gelezen?.hoogte || parseFloat(cc.style.height) || cc.getBoundingClientRect().height;
  setupContinuousAnnotationCanvas(canvas, breedte, hoogte, gelezen?.rects || null);
  renderAnnotationsForPage(
    canvas.getContext('2d'), pageNum, canvas.width, canvas.height,
    parseFloat(canvas.dataset.backingScale) || undefined,
    { x: (parseFloat(canvas.dataset.clipX) || 0) / doc.scale, y: (parseFloat(canvas.dataset.clipY) || 0) / doc.scale },
    { w: breedte / doc.scale, h: hoogte / doc.scale },
    undefined,
    weergaveTransform(pageNum),
  );
}

// alleenNodig (scrolling): skip a page whose clip still covers its visible
// part at the same size and dpr (continuous-clip.js). Zoom passes false.
// Every rect is read before any canvas is resized: resizing one page's canvas
// invalidated layout, and the next page's read then forced it.
function reclipAllContinuousAnnotationCanvases({ alleenNodig = false } = {}) {
  const container = document.getElementById('pdf-container');
  if (!container) return;
  const cr = container.getBoundingClientRect();
  const dpr = getCanvasDPR();
  const werk = [];
  document.querySelectorAll('#continuous-container .page-wrapper').forEach((wrapper) => {
    const pageNum = parseInt(wrapper.dataset.page, 10);
    if (!pageNum) return;
    const r = wrapper.getBoundingClientRect();
    if (!(r.top < cr.bottom && r.bottom > cr.top)) return;
    const cc = wrapper.querySelector('.canvas-container-cont');
    const canvas = cc && cc.querySelector('.annotation-canvas');
    if (!cc || !canvas) return;
    const ccr = cc.getBoundingClientRect();
    const breedte = parseFloat(cc.style.width) || ccr.width;
    const hoogte = parseFloat(cc.style.height) || ccr.height;
    if (alleenNodig && clipDektZicht(clipUitDataset(canvas.dataset),
      zichtbaarPaginaDeel(cr, ccr, breedte, hoogte), breedte, hoogte, dpr)) return;
    werk.push({ wrapper, pageNum, gelezen: { cc, canvas, breedte, hoogte, rects: { cr, ccr } } });
  });
  for (const { wrapper, pageNum, gelezen } of werk) reclipContinuousAnnotationCanvas(wrapper, pageNum, gelezen);
}

// Rotatie waarin een pagina op het scherm staat, bovenop zijn eigen /Rotate:
// de paginarotatie van het document plus de weergaverotatie (#200). De
// doorlopende weergave rendert de pagina's in deze stand; opslaan, afdrukken,
// exporteren en miniaturen gebruiken alleen getPageRotation().
function beeldRotatie(pageNum) {
  return normaliseerRotatie((getPageRotation(pageNum) || 0) + weergaveRotatie());
}

// Foreground-render generation counter. Bumped on every renderPage() entry;
// each in-flight invocation captures the value at start, then re-checks after
// each await. If the captured gen differs from the current gen, a newer
// renderPage() has been triggered — the older one must NOT write to the
// shared #pdf-canvas (its scale-N bitmap would clobber the newer scale-M
// result that already landed).
//
// User-visible symptom this fixes: rapid mouse-wheel zoom on raster PDFs
// (a large sample sheet) showed the page "springing back and forth" between intermediate
// zoom levels — earlier-started but slower-completing renders were stomping
// over the freshest user-requested zoom level.
let _foregroundRenderGen = 0;
// Bumped each time the single-page text, link and form layers are rebuilt:
// a deferred build of an older render gives way to the newer one.
let _pageLayersToken = 0;
// How long the page layers wait for the sheet's markups and bitmap, and for
// an idle moment after that.
const LAYER_WAIT_MS = 5000;
const LAYER_IDLE_MS = 500;

// All of `promises` settled (nulls count as settled), or `ms` passed.
function _untilOrAfter(promises, ms) {
  let timer;
  return Promise.race([
    Promise.all(promises.map((p) => Promise.resolve(p).catch(() => {}))),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

// The window is idle, or `timeout` ms passed.
function _whenIdle(timeout) {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout });
    else setTimeout(resolve, 0);
  });
}

// Returns true if `doc` is no longer the active document. Use this after every
// `await` in render code to abort late completions whose results would corrupt
// the SHARED #pdf-canvas / pdf-viewport singleton with a different document's
// content. Without this, a slow IPC chain (analyze_page_type +
// extract_draw_commands + prepareImages) for tab A can finish AFTER the user
// switched to tab B, then write A's filePath into the viewport singleton,
// making the RAF render loop draw A's pages on B's tab — the ghost/bleed-through
// the user reports when switching tabs rapidly across multiple PDFs.
// The viewport keeps the redraw callback it is given until the next sheet.
// An arrow made inside renderPageNow kept that render's whole scope with it,
// the document included, so a closed document stayed reachable.
function redrawAllMarkups() {
  redrawAnnotations(true);
}

function _isStaleDoc(doc) {
  return doc !== state.documents[state.activeDocumentIndex];
}


// ─── Main-thread jank detector ───────────────────────────────────────────
// Fires every 500ms. If a tick takes >1s to arrive, the main thread was blocked.
let _jankTimer = null;
let _jankLast = 0;
function _startJankDetector() {
  if (_jankTimer) return;
  _jankLast = performance.now();
  _jankTimer = setInterval(() => {
    const now = performance.now();
    const gap = now - _jankLast;
    if (gap > 1000) {
      console.warn(`[JANK] Main thread was blocked for ${gap.toFixed(0)}ms!`);
    }
    _jankLast = now;
  }, 500);
}
_startJankDetector();

// Render PDF page (single page mode)
export async function renderPage(pageNum) {
  const perfT0 = performance.now();
  try { return await renderPageNow(pageNum); } finally { perfRecord('page.render', performance.now() - perfT0); }
}

async function renderPageNow(pageNum) {
  // In-flight counter exposed for MCP test harness — `waitForRenderIdle()`
  // polls `window.__pdfRenderInFlight === 0` to know when a synthetic zoom
  // event has fully settled (bitmap painted, tile rendered, state updated).
  if (typeof window !== 'undefined') {
    window.__pdfRenderInFlight = (window.__pdfRenderInFlight || 0) + 1;
  }
  try {
    return await _renderPageImpl(pageNum);
  } finally {
    if (typeof window !== 'undefined') {
      window.__pdfRenderInFlight = Math.max(0, (window.__pdfRenderInFlight || 1) - 1);
    }
  }
}

async function _renderPageImpl(pageNum) {
  const _rp0 = performance.now();
  console.log(`[PERF] renderPage(${pageNum}) START`);
  // Clear search highlights immediately to prevent stale highlights
  // from appearing at wrong positions during canvas resize
  clearHighlights();

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const pdfDoc = doc.pdfDoc;
  const scale = doc.scale;

  // Validate page number against THIS document's page count
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) return;

  // Stamp this invocation with a fresh render-generation. Re-checked after
  // each await before any canvas / viewport mutation — see `_isStaleGen`
  // below. Prevents the rapid-zoom out-of-order race.
  const _renderGen = ++_foregroundRenderGen;
  const _isStaleGen = () => _renderGen !== _foregroundRenderGen;
  const sourceRevision = sourceRenderRevision(doc.filePath);
  const _isStaleRender = () => _isStaleDoc(doc) || _isStaleGen()
    || !sourceRenderCurrent(doc.filePath, sourceRevision);
  if (_isStaleRender()) return;

  const page = await pdfDoc.getPage(pageNum);
  // The page's markups load next to the page render, not after it: the
  // Markups List and the markups are there while a heavy drawing is still
  // being drawn. ensureAnnotationsForPage below waits for this same load.
  if (_isStaleRender()) return; // user switched tabs while we awaited PDF.js page
  ensureAnnotationsForPage(pageNum).catch(() => {});
  const extraRotation = getPageRotation(pageNum);
  const viewportOpts = { scale };
  if (extraRotation) {
    viewportOpts.rotation = (page.rotate + extraRotation) % 360;
  }
  const viewport = page.getViewport(viewportOpts);
  // Weergave draaien (#200). De viewport-singleton (PDFium) draait de pagina
  // zelf bij het tekenen; bitmap en lagen blijven in de paginaruimte. Tekent
  // PDF.js de pagina rechtstreeks (webversie, leeg document zonder pad), dan
  // gebeurt het draaien hier: pagina, overlay en lagen in de gedraaide stand.
  const weergaveRot = weergaveRotatie(doc);
  const beeldViewport = weergaveRot
    ? page.getViewport({ scale, rotation: (page.rotate + extraRotation + weergaveRot) % 360 })
    : viewport;

  // High-zoom safety cap. The browser canvas has a max ~16384 px per axis
  // (Chromium); rendering a large sheet (1632×1056 pt page) at scale=10 would produce
  // a 16320×10560 buffer = exceeds limit, allocation fails, canvas turns
  // black, user sees "versringen". Cap the Rust render at a safe max-axis
  // and let CSS-stretch the bitmap to the user-requested CSS viewport size
  // (slightly blurry but stable — same approach as Edge/Chrome on heavy zoom).
  //
  // MAX_BITMAP_AXIS_PX chosen at 4096 = well under canvas limits, easy to
  // allocate even on weak hardware, and CSS-stretching from 4096 to e.g.
  // 8000 px is barely noticeable for tex/vector content (1 source pixel
  // covers 2 dest pixels via bilinear).
  const MAX_BITMAP_AXIS_PX = 4096;
  const _pageMaxAxisPt = Math.max(viewport.width, viewport.height) / scale;
  const _maxAllowedScale = MAX_BITMAP_AXIS_PX / _pageMaxAxisPt;
  const _effectiveScale = Math.min(scale, _maxAllowedScale);
  if (_effectiveScale < scale) {
    console.log(`[render] high-zoom safety cap: requested scale=${scale.toFixed(2)}, rendering at ${_effectiveScale.toFixed(2)} (CSS-stretch to viewport)`);
  }

  // Cache page dimensions in PDF points on the doc so plugin annotation
  // handlers can read them synchronously at click time without depending
  // on the pdf-viewport singleton (which is a noop for blank docs whose
  // vector path is gated off by the filePath check).
  if (!doc.pageDims) doc.pageDims = {};
  const [vx0, vy0, vx1, vy1] = page.view;
  doc.pageDims[pageNum] = {
    widthPt: vx1 - vx0,
    heightPt: vy1 - vy0,
    // Oorsprong van de pagina-box: CAD-plots hebben vaak een MediaBox rond
    // (0,0) (bv. [-846 -595 846 595]). Zonder deze offset landt tekst-
    // bewerking (painter én klik→record) buiten de pagina.
    offsetXPt: vx0,
    offsetYPt: vy0,
    rotation: page.rotate || 0,
  };

  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;

  const dpr = getCanvasDPR();
  const bufferW = Math.floor(viewport.width * dpr);
  const bufferH = Math.floor(viewport.height * dpr);

  // Try Rust open-pdf-render first (pure Rust, fast), fall back to PDF.js
  const _t0 = performance.now();
  const _canUseTauri = isTauri();
  const _hasFilePath = !!doc.filePath;
  let _skipBitmapRender = false;
  let _bitmapKlaar = null;

  // ─── VECTOR VIEWPORT MODE ──────────────────────────────────────────────
  // Extract draw commands once, then hand off to pdf-viewport.js render loop.
  // All zoom/pan is handled by the viewport — no re-rendering needed here.
  // The user-applied page rotation is part of the cache key so a rotated
  // page coexists with its un-rotated version in cache.
  if (_canUseTauri && _hasFilePath) {
    try {
      // Pause thumbnail rendering so Rust backend is free for page rendering
      pauseThumbnails();
      console.log(`[PERF] renderPage(${pageNum}) trying vector path: ${(performance.now() - _rp0).toFixed(0)}ms`);
      const vr = await import('./vector-renderer.js');
      if (_isStaleRender()) { resumeThumbnails(); return; }
      const userRotation = getPageRotation(pageNum);

      // Engine-override gate: vector path only runs in Auto mode (override===null).
      // If user picked 'pdfium' or 'rust-skia' in the status-bar dropdown,
      // skip Vector entirely — even for pages whose draw-commands are already
      // cached from a previous render. Without this gate, the override only
      // affected the raster engine (PDFium vs Rust-Skia at the worker-pool
      // level) but vector-classified pages still went through the Vector
      // engine, making "Engine: PDFium" appear to do nothing for those pages.
      // BELEID (2026-07-06): PDFium is de basis-engine; het vector-pad
      // (AEC-PDF v1) draait alléén nog met de expliciete diagnose-vlag
      // window.__aecVectorPath. Een null-override uit oude persisted
      // voorkeuren (dropdown-tijdperk) mag het pad niet meer aanzetten —
      // dat gaf o.a. een witte pagina op geroteerde vector-bladen.
      const _vectorAllowed = window.__aecVectorPath === true && state.renderEngineOverride == null;
      let vectorExtractionFailed = false;
      if (_vectorAllowed && !vr.hasCachedCommands(doc.filePath, pageNum, userRotation)) {
        console.log(`[PERF] renderPage(${pageNum}) analyze_page_type START: ${(performance.now() - _rp0).toFixed(0)}ms`);
        // JS-side cache check FIRST — populated by analyze_page_type_batch
        // at cold-open. Skips the IPC roundtrip (which can be 1+ second
        // queued behind thumbnail invokes during cold-open) for any page
        // the batch has classified. The Rust cache remains authoritative
        // for the rare cold-miss path below.
        const ptcMod = await import('./page-type-cache.js');
        let pageType = ptcMod.getCachedPageType(doc.filePath, pageNum - 1);
        if (pageType) {
          console.log(`[PERF] renderPage(${pageNum}) analyze_page_type=${pageType} (js-cache): ${(performance.now() - _rp0).toFixed(0)}ms`);
        } else {
          pageType = await invoke('analyze_page_type', { path: doc.filePath, pageIndex: pageNum - 1 });
          if (_isStaleRender()) { resumeThumbnails(); return; }
          ptcMod.cachePageType(doc.filePath, pageNum - 1, pageType);
          console.log(`[PERF] renderPage(${pageNum}) analyze_page_type=${pageType}: ${(performance.now() - _rp0).toFixed(0)}ms`);
        }
        // BELEID (2026-07-06): PDFium is de basis-engine voor álle weergaven.
        // Het eigen vector-replay-pad (AEC-PDF v1) staat uit tot het per
        // bladklasse bewezen is via de corpus-benchmark — het veroorzaakte
        // o.a. een witte pagina en gedraaide weergave op geroteerde bladen
        // (Originele bestanden/Technische tekening.pdf p1, /Rotate-blad).
        // Diagnose/ontwikkeling: window.__aecVectorPath = true heractiveert.
        if (pageType === 'vector' && !window.__aecVectorPath) {
          pageType = 'raster';
        }
        if (pageType === 'vector') {
          try {
            console.log(`[PERF] renderPage(${pageNum}) extract_draw_commands START: ${(performance.now() - _rp0).toFixed(0)}ms`);
            const cmdData = await invoke('extract_draw_commands', {
              path: doc.filePath,
              pageIndex: pageNum - 1,
              rotation: userRotation,
            });
            if (_isStaleRender()) { resumeThumbnails(); return; }
            const cmdBytes = cmdData instanceof Uint8Array ? cmdData : new Uint8Array(cmdData);
            console.log(`[PERF] renderPage(${pageNum}) extract_draw_commands DONE (${cmdBytes.length} bytes): ${(performance.now() - _rp0).toFixed(0)}ms`);
            vr.cacheCommands(doc.filePath, pageNum, cmdBytes, userRotation);
            // Pre-decode any images in the command buffer (async, must complete before render)
            console.log(`[PERF] renderPage(${pageNum}) prepareImages START: ${(performance.now() - _rp0).toFixed(0)}ms`);
            await vr.prepareImages(doc.filePath, pageNum, userRotation);
            if (_isStaleRender()) { resumeThumbnails(); return; }
            console.log(`[PERF] renderPage(${pageNum}) prepareImages DONE: ${(performance.now() - _rp0).toFixed(0)}ms`);
          } catch (error) {
            // A native OCG document is rejected before command extraction;
            // PDFium is the renderer that honors its optional-content state.
            // The same raster fallback keeps other extraction failures from
            // leaving the Tauri canvas blank in diagnostic vector mode.
            vectorExtractionFailed = true;
            vr.invalidatePageCache(doc.filePath, pageNum);
            console.warn('[render] Vector extraction failed; using PDFium:', error);
          }
        }
      }

      if (_vectorAllowed && !vectorExtractionFailed && vr.hasCachedCommands(doc.filePath, pageNum, userRotation)) {
        const dims = vr.getCachedPageDimensions(doc.filePath, pageNum, userRotation);
        if (dims) {
          const { initViewport, setPage, wireEvents, viewport: pdfVP } = await import('./pdf-viewport.js');
          // CRITICAL: don't write a stale doc's filePath into the viewport
          // singleton. If we do, the RAF render loop will then draw the OLD
          // doc's content on the SHARED #pdf-canvas — that's the ghost the
          // user reports when switching tabs rapidly across multiple PDFs.
          if (_isStaleRender()) { resumeThumbnails(); return; }

          // Initialize viewport (idempotent — safe to call multiple times).
          // Call redrawAnnotations SYNCHRONOUSLY inside the viewport's RAF tick
          // (a dynamic import().then() would defer to a microtask, lagging
          // annotations one frame behind the PDF during zoom/pan). Use the
          // lightweight=true path so per-frame zoom skips the heavy SolidJS
          // status-bar / list / ribbon updates that would stall the frame.
          initViewport(pdfCanvas, redrawAllMarkups);
          if (!pdfCanvas._vpEventsWired) {
            wireEvents(pdfCanvas);
            pdfCanvas._vpEventsWired = true;
          }
          const container = document.getElementById('pdf-container');
          if (container) container.style.overflow = 'hidden';

          // Load page into viewport (triggers fitToViewport + first render)
          setPage(doc.filePath, pageNum, dims.w, dims.h, dims.x0 || 0, dims.y0 || 0, userRotation, weergaveRot);

          // Create text layer for text selection + search
          // Try Rust-extracted text spans first (faster, no PDF.js dependency),
          // fall back to PDF.js text layer if Rust extraction returns empty
          try {
            const canvasContainer = document.getElementById('canvas-container');
            const rustTextOk = await createTextLayerFromRust(
              canvasContainer || container, pageNum, dims.w, dims.h, () => !_isStaleRender()
            );
            if (_isStaleRender()) { resumeThumbnails(); return; }
            if (!rustTextOk) {
              const page = await pdfDoc.getPage(pageNum);
              if (_isStaleRender()) { resumeThumbnails(); return; }
              const textViewport = page.getViewport({ scale: 1.0 });
              await createSinglePageTextLayer(page, textViewport, () => !_isStaleRender());
              if (_isStaleRender()) { resumeThumbnails(); return; }
            }
            if (window.__pdfViewport) window.__pdfViewport.dirty = true;
          } catch (e) {
            console.warn('[render] Text layer failed:', e);
          }

          _detailLaag.wis();
          console.log(`[render] ✅ Vector viewport: ${dims.w}x${dims.h} pt, origin=(${dims.x0},${dims.y0})`);
          // Mark page type so the unified render loop knows which branches to run
          if (window.__pdfViewport) window.__pdfViewport.pageType = 'vector';
          _skipBitmapRender = true;
        }
      }

      // ─── RASTER MODE: unified viewport ──────────────────────────────────
      // For raster-classified pages, activate the viewport singleton (same
      // one used by vector mode) and let the unified _render() loop handle
      // paint. The OLD bitmap-mode path further down still runs during this
      // transition; Task 5 will rip it.
      // Raster path runs when:
      //  - vector path didn't already claim the render (_skipBitmapRender),
      //  - AND either there are no cached vector commands, OR the user has
      //    forced a raster engine (override !== null), in which case cached
      //    vector commands must be bypassed.
      const _useRaster = rasterViewportNeeded({
        skipBitmapRender: _skipBitmapRender,
        vectorAllowed: _vectorAllowed,
        vectorExtractionFailed,
        hasCachedCommands: vr.hasCachedCommands(doc.filePath, pageNum, userRotation),
      });
      if (_useRaster) {
        const { initViewport, setPage, wireEvents, viewport: pdfVP } =
          await import('./pdf-viewport.js');
        if (_isStaleRender()) { resumeThumbnails(); return; }

        // Init viewport on the main PDF canvas if not already running.
        initViewport(pdfCanvas, redrawAllMarkups);
        if (!pdfCanvas._vpEventsWired) {
          wireEvents(pdfCanvas);
          pdfCanvas._vpEventsWired = true;
        }

        // Container in fixed-overflow mode — viewport handles pan/zoom now.
        const _rasterContainer = document.getElementById('pdf-container');
        if (_rasterContainer) _rasterContainer.style.overflow = 'hidden';

        // Page dims for the viewport. page.view = [x0, y0, x1, y1] in PRE-
        // rotation user-space coords. The PDFium bitmap is rendered POST-
        // rotation (intrinsic /Rotate is applied by default), so if the PDF
        // has /Rotate=90 or 270 the bitmap's width/height are swapped vs
        // page.view. Match by swapping page.view dims here too — otherwise
        // _render() stretches a portrait bitmap into a landscape rectangle
        // (or vice versa) and the page appears with dims transposed.
        const _x0 = page.view[0], _y0 = page.view[1];
        const _x1 = page.view[2], _y1 = page.view[3];
        const _rawW = _x1 - _x0;
        const _rawH = _y1 - _y0;
        const _intrinsicRot = (page.rotate || 0) % 360;
        const _rotSwap = (_intrinsicRot === 90 || _intrinsicRot === 270);
        const _pageWpt = _rotSwap ? _rawH : _rawW;
        const _pageHpt = _rotSwap ? _rawW : _rawH;
        setPage(
          doc.filePath, pageNum,
          _pageWpt, _pageHpt,
          _x0, _y0,
          getPageRotation(pageNum) || 0,
          weergaveRot,
        );

        // Mark as raster so _render() takes the bitmap branch + skips vector
        pdfVP.pageType = 'raster';

        // Kick async bitmap fill — fires viewport.dirty when arrives.
        const _orch = await import('./bitmap-orchestrator.js');
        if (_isStaleRender()) { resumeThumbnails(); return; }
        // Once the bitmap is drawn, the document's pdf-lib parse may start
        // (loader.js afterFirstPaint): it holds the main thread in one piece.
        _bitmapKlaar = Promise.resolve(_orch.ensureBitmapForCurrentView())
          .catch(() => {})
          .then(afterNextFrame)
          .then(() => {
            // From the start of this render to the sheet's bitmap on screen.
            if (!_isStaleRender()) perfRecord('page.bitmap', performance.now() - _rp0);
            notePagePainted(doc);
          });
        // Tile will be ensured on the first zoom change via the _anchorAt hook
        // (Step 4); for the initial fit we let _render() display whatever
        // getBestAvailableBitmap provides immediately.

        _detailLaag.wis();
        console.log(`[render] Raster viewport activated: ${_pageWpt}x${_pageHpt} pt (intrinsic /Rotate=${_intrinsicRot}°)`);
        // The new viewport path now OWNS the canvas (initViewport's
        // _resizeCanvas sets pdfCanvas.width = container size; _render's
        // setTransform scales content). The OLD bitmap path's
        // pdfCanvas.width = pageW*scale assignment is INCOMPATIBLE with
        // this model — leaving it active would thrash the canvas
        // dimensions every frame. So skip the old path now; Task 5
        // physically deletes its code from the file.
        _skipBitmapRender = true;
      }
      // Heavy IPC for the active page is done — let the thumbnail processor
      // resume immediately instead of waiting out the pause window.
      resumeThumbnails();
    } catch (e) {
      console.warn('[render] Vector mode failed:', e);
      // Failure path: still resume so thumbnails don't stay stuck paused.
      resumeThumbnails();
    }
  }

  // No bitmap of its own on the way (vector path, PDF.js below, a failure):
  // nothing for the pdf-lib parse to wait for.
  if (!_bitmapKlaar) notePagePainted(doc);

  // Bitmap rendering has moved to the unified viewport model (Task 4):
  // activated above in the raster-mode block; pixel-fill happens via
  // bitmap-orchestrator + drawImage in pdf-viewport.js _render() loop.
  // No predictive resize, no canvas-width mutation, no tile DOM canvas.
  //
  // EXCEPTION: blank in-memory docs (Bestand → Nieuw → A4/A3/etc.) have
  // `doc.filePath === null` and are gated out of BOTH vector AND raster
  // paths above. Without a fallback, pdf-canvas keeps its stale content
  // from the previous document (or remains at its previous oversized
  // dimensions) — the user sees "one big white screen" instead of an A4
  // page. Render directly to pdf-canvas via PDF.js for blank docs.
  if (pdfjsFallbackNodig({
    inTauri: _canUseTauri,
    hasFilePath: _hasFilePath,
    viewportNamHetOver: _skipBitmapRender,
  })) {
    try {
      // Also deactivate the viewport singleton if it's leftover-active from
      // a previously-opened real PDF — its RAF loop would otherwise repaint
      // stale content over our PDF.js render every frame.
      const _vpMod = await import('./pdf-viewport.js');
      if (_isStaleRender()) return;
      if (_vpMod.viewport && _vpMod.viewport.active && _vpMod.viewport.filePath !== doc.filePath) {
        _vpMod.viewport.active = false;
        _vpMod.viewport.filePath = null;
        _vpMod.viewport.currentBitmap = null;
      }

      // Basisbitmap tot PDFJS_DETAIL_BASE_MAX_AXIS_PX; daarboven tekent de
      // detaillaag het zichtbare deel scherp (pdfjs-detail-layer.js). Zelfde
      // pagina, draaiing en lagen bij een diepere zoom = zelfde bitmap: dan
      // past alleen de CSS-maat aan.
      // Sleutel ook op de set /AP-markeringen in de bitmap (ap-render-state.js):
      // verandert die, dan is de operatorlijst anders (en de bitmap ook).
      // Pas bepaald nadat de /AP-opties vastliggen (die wachten even op de
      // markeringen van de pagina).
      const { apRenderKeyPart, apToonVoorPagina } = await import('./ap-render-state.js');
      // Webversie: PDFium (WebAssembly) tekent de pixels als dat kan, zodat
      // haarlijnen en vervangende lettertypen eruitzien als op het bureaublad
      // (pdfium-web/). Anders PDF.js.
      const _rasterizer = await _webRasterizer(doc, apToonVoorPagina);
      if (_isStaleRender()) return;
      let _detailSleutel = null;
      let _renderParams = null;
      let _opLijst = null;
      if (!await tekenPaginaMetPdfJs(page, beeldViewport, pdfCanvas, doc, () => !_isStaleRender(),
        { maxAxisPx: PDFJS_DETAIL_BASE_MAX_AXIS_PX, rasterizer: _rasterizer,
          renderKey: () => (_detailSleutel = `${pageNum}|${beeldViewport.rotation || 0}|${nativeOcgSelectionForDocument(doc).revision}|${sourceRevision}|${apRenderKeyPart(doc)}|${_rasterizer ? _rasterizer.naam : 'pdfjs'}`),
          metRenderParams: (rp) => { _renderParams = rp; }, onOperatorList: (l) => { _opLijst = l; } })) return;
      if (_isStaleRender()) return;
      state.renderEngine = _rasterizer ? 'Raster (PDFium · web)' : 'Raster (PDF.js)';
      _bindSinglePageScroll();
      _detailLaag.zetPagina({
        page,
        viewport: beeldViewport,
        viewportVoor: (s) => page.getViewport({ scale: s, rotation: beeldViewport.rotation }),
        dpr: getCanvasDPR(),
        baseRatio: beeldViewport.width > 0 ? pdfCanvas.width / beeldViewport.width : 0,
        sleutel: _detailSleutel,
        optionalContentConfigPromise: nativeOcgPdfJsConfig(doc),
        renderParams: _renderParams,
        operatorList: _opLijst,
        rasterizer: _rasterizer,
      });
      // De pagina staat er. Wat hierna komt (tekst-, link- en formulierlaag,
      // annotaties) kan in de webversie een minuut duren omdat PDF.js daar
      // ook de miniaturen tekent. Het laadscherm en de maat van de
      // overlay-canvassen horen daar niet op te wachten: tot dat moment
      // stonden #annotation-canvas en #text-highlight-canvas op hun
      // 300×150-standaard, en landde alles wat de gebruiker tekende of
      // markeerde naast de pagina (#456). PDF.js tekent hier zelf, dus dit is
      // altijd de paginatak van bepaalOverlayMaat().
      paginaGetekend({
        overlayCanvassen: [annotationCanvas, document.getElementById('text-highlight-canvas')],
        overlayMaat: bepaalOverlayMaat({
          viewportActief: false,
          heeftBestandspad: false,
          paginaCssW: beeldViewport.width,
          paginaCssH: beeldViewport.height,
          dpr: getCanvasDPR(),
          zichtbaar: _zichtbaarOpPagina(pdfCanvas),
        }),
        verbergLaadscherm: hideLoading,
      });
    } catch (e) {
      console.warn('[render] PDF.js-render mislukt:', e);
    }
  }

  // Annotation canvas resize is deferred to just before redrawAnnotations()
  // so the clear+redraw happens in one synchronous block (no blink).

  // Set CSS scale variables for PDF.js text/annotation layers
  const container = document.getElementById('canvas-container');
  if (container) {
    container.style.setProperty('--scale-factor', viewport.scale);
    container.style.setProperty('--total-scale-factor', viewport.scale);
  }

  // Text/link/form layers: skip during vector zoom (expensive PDF.js operations)
  // Only create on first load or page change, not on every zoom.
  // PAGE-AWARE: a text layer left over from a DIFFERENT page must be rebuilt,
  // otherwise text selection and Edit Text keep operating on the spans of the
  // previously visited page after navigation (raster viewport path sets
  // _skipBitmapRender=true on every render, including page changes).
  // SCOPED op #canvas-container: een globale query vond ook de (verborgen)
  // continuous-lagen van dezelfde pagina, waardoor na een weergavewissel de
  // single-modus nooit een eigen tekstlaag bouwde — tekst (incl. nieuw
  // toegevoegde blokken) was dan niet meer selecteerbaar of bewerkbaar.
  // Welke PDF.js-viewport de tekst-, link- en formulierlaag krijgen: in het
  // viewport-pad de paginaruimte (_render() in pdf-viewport.js draait en zoomt
  // ze), in het PDF.js-pad de gedraaide stand van het getekende canvas.
  const lagenViewport = _skipBitmapRender ? viewport : beeldViewport;
  const _existingTextLayer = document.querySelector('#canvas-container .textLayer');
  // De linklaag bevat rechthoeken die bij ÉÉN rotatiestand horen (PDF.js heeft
  // de draaiing al in de pixels verwerkt). Draait de gebruiker de pagina, dan
  // moet de laag opnieuw worden opgebouwd, anders liggen de klikvlakken scheef.
  const _existingLinkLayer = document.querySelector('#canvas-container .linkLayer');
  const _linkLayerRotationStale = !!_existingLinkLayer
    && Number(_existingLinkLayer.dataset.rotation || 0) !== ((lagenViewport.rotation || 0) % 360);
  const _textLayerStale = !_existingTextLayer
    || parseInt(_existingTextLayer.dataset.page) !== pageNum
    || _linkLayerRotationStale;
  if (!_skipBitmapRender || _textLayerStale) {
    // The text, link and form layers come from PDF.js requests that parse
    // the page in its worker (getTextContent: the whole content stream; the
    // annotations: a second or more on a sheet with thousands of markups).
    // That worker answers one request at a time and cannot drop one once
    // sent, so these wait for the sheet itself: the text layer until the
    // markups' annotation list is read and the bitmap is on screen, the
    // link and form layers until the markups are drawn. Each then starts
    // when the window is idle, and only while this page is still shown.
    // The previous page's layers go at once, as before.
    clearSinglePageTextLayer();
    clearSinglePageLinkLayer();
    clearSinglePageFormLayer();
    const layersToken = ++_pageLayersToken;
    const layersCurrent = () => layersToken === _pageLayersToken
      && !_isStaleDoc(doc)
      && doc.pdfDoc === pdfDoc
      && doc.currentPage === pageNum
      && sourceRenderCurrent(doc.filePath, sourceRevision)
      // The PDF.js path draws the layers at this render's scale.
      && (_skipBitmapRender || !_isStaleGen());
    const _tl0 = performance.now();
    const textLayerDone = (async () => {
      await _untilOrAfter([annotationsRead(doc, pageNum), _bitmapKlaar], LAYER_WAIT_MS);
      await _whenIdle(LAYER_IDLE_MS);
      if (!layersCurrent()) return;
      perfRecord('page.textLayerWait', performance.now() - _tl0);
      const _tb0 = performance.now();
      await createSinglePageTextLayer(page, lagenViewport, layersCurrent);
      if (!layersCurrent()) return;
      perfRecord('page.textLayer', performance.now() - _tb0);
      console.log(`[PERF] renderPage(${pageNum}) text layer: ${(performance.now() - _tl0).toFixed(0)}ms`);
      if (window.__pdfViewport) window.__pdfViewport.dirty = true;
    })().catch((e) => console.warn('Failed to create text layer:', e));

    const _lf0 = performance.now();
    const linkFormDone = (async () => {
      await _untilOrAfter([ensureAnnotationsForPage(pageNum, doc)], LAYER_WAIT_MS);
      await _whenIdle(LAYER_IDLE_MS);
      if (!layersCurrent()) return;
      perfRecord('page.linkFormWait', performance.now() - _lf0);
      const _lb0 = performance.now();
      try {
        await createSinglePageLinkLayer(page, lagenViewport, layersCurrent);
      } catch (e) {
        console.warn('Failed to create link layer:', e);
      }
      if (!layersCurrent()) return;
      try {
        await createSinglePageFormLayer(page, lagenViewport, layersCurrent);
      } catch (e) {
        console.warn('Failed to create form layer:', e);
      }
      if (!layersCurrent()) return;
      perfRecord('page.linkFormLayers', performance.now() - _lb0);
      console.log(`[PERF] renderPage(${pageNum}) link + form layers: ${(performance.now() - _lf0).toFixed(0)}ms`);
      // Same rule as below for the layers that just arrived.
      applyOverlayPointerEvents(document.getElementById('canvas-container'));
      if (window.__pdfViewport) window.__pdfViewport.dirty = true;
    })();
    // These layers were PDF.js's last reads of the sheet: it may let go of
    // the pages it parsed once it has been quiet (pdfjs-idle-cleanup.js).
    Promise.allSettled([textLayerDone, linkFormDone]).then(() => noteActivity(doc));
    // The neighbours of a large set wait for these (loader.js).
    doc._visibleLayers = Promise.all([textLayerDone, linkFormDone]).then(() => {});

    // editText tool: annotation-canvas must drop below the textLayer so
    // text-span clicks reach the span listeners (inline text editing).
    // For the 'select' tool we do NOT set pe:none statically — the dynamic
    // fall-through handler in tools/manager.js (_setSelectFallthroughEnabled)
    // toggles annotation-canvas pointer-events on mousemove based on
    // whether the cursor is over an annotation. Setting pe:none here on
    // first render would block the very first click on an annotation
    // (before any mousemove has fired) — symptom: "annotations visible
    // but not selectable" in raster-engine mode.
    if (state.currentTool === 'editText') {
      annotationCanvas.style.zIndex = '2';
      annotationCanvas.style.pointerEvents = 'none';
    }
    // Link-/formulierlagen volgen dezelfde regel als bij een
    // gereedschapswissel: klikbaar bij select/hand, uit bij editText en de
    // tekengereedschappen. Eén bron van waarheid — zie link-layer.js.
    applyOverlayPointerEvents(document.getElementById('canvas-container'));

    // De lagen zijn zojuist (her)opgebouwd; de viewport zet ze in zijn
    // volgende frame weer op de pagina (maat + transform). Zonder deze vlag
    // bleef een verse tekstlaag in het rasterpad op de containermaat staan:
    // na een paginawissel lagen tekstselectie en zoekmarkeringen dan naast
    // de pagina tot iets anders toevallig een frame afdwong.
    if (window.__pdfViewport) window.__pdfViewport.dirty = true;
  }

  // The page's markups: on a sheet with tens of thousands of them, reading
  // and converting takes seconds (loader.js). The overlay is sized and drawn
  // with what is loaded now, and drawn again once the markups are in, so the
  // page and the rest of the view do not wait for them. This function still
  // returns after the markups, as before.
  // Skip heavy operations during vector zoom (only needed on first load / page change).
  // Uses the same page-aware staleness check as the text-layer block above
  // (evaluated BEFORE that block rebuilt the layer, so page changes pass).
  const _markupsNodig = !_skipBitmapRender || _textLayerStale;
  const _markupsAl = !!doc._annotationPagesReady?.has(pageNum);

  // Final stale-doc check before mutating shared canvas — without this, an
  // earlier renderPage() that finished after a tab switch would resize and
  // overwrite the annotation canvas of the now-active document.
  if (_isStaleRender()) return;

  // Overlay-canvassen op de maat van de ruimte waarin redrawAnnotations()
  // tekent: viewportmaat in CSS-px als de viewport de pagina bezit, anders
  // paginamaat × dpr (zelfde beslisregel als _render() in pdf-viewport.js,
  // zie overlay-canvas-size.js). Voorheen altijd de paginamaat; na p2 → p3
  // met gelijke paginamaat kwam er geen _render()-frame meer die dat
  // herstelde en bleef de overlay te klein (NKE2D2 p3/p4: annotaties
  // verkleind en verschoven). Resize en hertekenen in één synchroon blok.
  const vpBezitPagina = !!(window.__pdfViewport && window.__pdfViewport.active);
  const dprOverlay = getCanvasDPR();
  const overlayMaat = bepaalOverlayMaat({
    viewportActief: vpBezitPagina,
    heeftBestandspad: !!doc.filePath,
    // De viewport tekent op #pdf-canvas zelf: backing / dpr = CSS-maat.
    viewportCssW: pdfCanvas.width / dprOverlay,
    viewportCssH: pdfCanvas.height / dprOverlay,
    viewportStijlW: parseFloat(pdfCanvas.style.width) || undefined,
    viewportStijlH: parseFloat(pdfCanvas.style.height) || undefined,
    paginaCssW: beeldViewport.width,
    paginaCssH: beeldViewport.height,
    dpr: dprOverlay,
    zichtbaar: vpBezitPagina ? null : _zichtbaarOpPagina(pdfCanvas),
  });
  if (overlayMaat) {
    pasOverlayMaatToe(annotationCanvas, overlayMaat);
    pasOverlayMaatToe(document.getElementById('text-highlight-canvas'), overlayMaat);
  }
  redrawAnnotations();

  // Re-apply search highlights after re-render
  onPageRendered();

  // Update status bar
  updateAllStatus();
  perfRecord('page.paint', performance.now() - _rp0);

  // Ensure annotations for this page are loaded (on-demand if background hasn't reached it yet)
  if (_markupsNodig) {
    console.log(`[PERF] renderPage(${pageNum}) ensureAnnotations START: ${(performance.now() - _rp0).toFixed(0)}ms`);
    const _wm0 = performance.now();
    await ensureAnnotationsForPage(pageNum);
    if (!_markupsAl) perfRecord('page.waitMarkups', performance.now() - _wm0);
    if (_isStaleRender()) {
      // A newer render of this page (a zoom) went ahead without them.
      if (!_markupsAl && !_isStaleDoc(doc) && doc.currentPage === pageNum) redrawAnnotations();
      return;
    }
    console.log(`[PERF] renderPage(${pageNum}) ensureAnnotations DONE: ${(performance.now() - _rp0).toFixed(0)}ms`);
    if (state.preferences.snapToPdfContent) {
      prefetchPdfVectorGeometry(pageNum);
    }
    // The markups arrived after the first draw: draw them.
    if (!_markupsAl) {
      redrawAnnotations();
      updateAllStatus();
    }
  }

  // NOTE: prefetchAdjacentPages was removed — it causes Rust backend contention
  // with thumbnail rendering, making the app unresponsive on large files.
  // Annotations are loaded on-demand via ensureAnnotationsForPage() when
  // the user actually navigates to a page.
  console.log(`[PERF] renderPage(${pageNum}) TOTAL: ${(performance.now() - _rp0).toFixed(0)}ms`);
}

// Tekent één pagina met PDF.js op een canvas. Gebruikt door élk pad dat
// PDFium niet kan aanroepen: de webversie (geen Tauri) en lege documenten
// zonder bestandspad. Zie render-route.js voor wanneer dit pad geldt.
async function tekenPaginaMetPdfJs(page, viewport, canvas, doc, isCurrent = () => true, opties = {}) {
  const { renderPdfJsPageToCanvas } = await import('./pdfjs-canvas-render.js');
  if (!isCurrent()) return false;
  // Onbewerkte ingelezen markeringen uit hun eigen /AP (ap-render-state.js).
  const { apRenderOpties, apRenderKlaar } = await import('./ap-render-state.js');
  const { metRenderParams, ...rest } = opties;
  const renderParams = await apRenderOpties(page);
  if (!isCurrent()) { apRenderKlaar(page, false); return false; }
  metRenderParams?.(renderParams);
  if (typeof rest.renderKey === 'function') rest.renderKey = rest.renderKey();
  let ok = false;
  try {
    ok = await renderPdfJsPageToCanvas({ page, viewport, canvas, dpr: getCanvasDPR(), renderParams,
      optionalContentConfigPromise: nativeOcgPdfJsConfig(doc), isCurrent, ...rest });
  } finally {
    apRenderKlaar(page, ok);
  }
  return ok;
}

// PDFium als WebAssembly voor de pixels van de webversie (pdfium-web/), of
// null: dan tekent PDF.js. Lazy geladen: alleen de webversie haalt de module
// (en de wasm) op.
async function _webRasterizer(doc, apToon) {
  if (isTauri() || state.preferences?.pdfiumWebRender === false) return null;
  const bytes = doc.filePath ? getCachedPdfBytes(doc.filePath) : null;
  if (!bytes?.length) return null;
  try {
    const { pdfiumWebRasterizer } = await import('./pdfium-web/pdfium-web-rasterizer.js');
    return pdfiumWebRasterizer({
      bytes,
      inTauri: false,
      voorkeur: state.preferences?.pdfiumWebRender,
      ocgAfwijkend: nativeOcgSelectionForDocument(doc).ocgVisibility.length > 0,
      toonNms: (page, renderParams) => (renderParams?.annotationMode === 1 ? apToon(doc, page.pageNumber) : null),
    });
  } catch (e) {
    console.warn('[pdfium-web] niet beschikbaar, PDF.js tekent:', e?.message || e);
    return null;
  }
}

// Scherpe uitsnede boven #pdf-canvas in de enkelpagina-weergave met PDF.js
// (webversie, lege documenten). Zie pdfjs-detail-layer.js.
const _detailLaag = new PdfJsDetailLayer({
  getBaseCanvas: () => getPdfCanvas(),
  getContainer: () => document.getElementById('pdf-container'),
  OPS: PDFJS_OPS,
});
export function getPdfJsDetailLayer() { return _detailLaag; }

// Doorlopende weergave: een scherpe laag per pagina (alleen het PDF.js-pad).
const _contDetailLagen = new Map(); // pageNum -> PdfJsDetailLayer
function _contDetailLaag(pageNum) {
  let laag = _contDetailLagen.get(pageNum);
  if (!laag) {
    laag = new PdfJsDetailLayer({
      getBaseCanvas: () => document.querySelector(`#continuous-container .page-wrapper[data-page="${pageNum}"] .canvas-container-cont > canvas.pdf-canvas`),
      getContainer: () => document.getElementById('pdf-container'),
      OPS: PDFJS_OPS,
      canvasClass: 'pdf-detail-canvas',
    });
    _contDetailLagen.set(pageNum, laag);
  }
  return laag;
}

/** Na scrollen in de doorlopende weergave: zichtbare lagen bijwerken, de rest vrijgeven. */
function _werkContDetailLagenBij() {
  for (const [pageNum, laag] of _contDetailLagen) {
    if (laag.inBeeld()) laag.werkBij();
    else { laag.vrijgeven(); _contDetailLagen.delete(pageNum); }
  }
}

/** Alle lagen van de doorlopende weergave weg (ander document, andere weergave). */
export function wisContDetailLagen() {
  for (const laag of _contDetailLagen.values()) laag.vrijgeven();
  _contDetailLagen.clear();
  document.querySelectorAll('#continuous-container canvas.pdf-detail-canvas').forEach((c) => c.remove());
}

// Scrollen in de enkelpagina-weergave met PDF.js: de scherpe uitsnede volgt,
// en de markeringen worden opnieuw getekend. redrawAnnotations() slaat
// markeringen buiten het zichtbare deel (op het moment van tekenen) over; het
// annotatiecanvas beslaat wel de hele pagina, dus zonder hertekenen bleven
// tekstvakken, afbeeldingen en lijnen buiten het eerste beeld weg na pannen.
let _singleScrollBound = false;
let _singleScrollRedraw = null;
function _bindSinglePageScroll() {
  if (_singleScrollBound) return;
  const container = document.getElementById('pdf-container');
  if (!container) return;
  _singleScrollBound = true;
  container.addEventListener('scroll', () => {
    const doc = getActiveDocument();
    if (!doc || doc.viewMode === 'continuous') return;
    if (window.__pdfViewport?.active && doc.filePath && isTauri()) return;
    _detailLaag.planBijwerken();
    if (_singleScrollRedraw) clearTimeout(_singleScrollRedraw);
    _singleScrollRedraw = setTimeout(() => {
      _singleScrollRedraw = null;
      const d = getActiveDocument();
      if (!d || d.viewMode === 'continuous') return;
      if (window.__pdfViewport?.active && d.filePath && isTauri()) return;
      _herknipOverlay();
      redrawAnnotations();
    }, 90);
  }, { passive: true });
}

// Zichtbaar deel van de getoonde pagina (pagina-CSS-px), of null.
function _zichtbaarOpPagina(pdfCanvas) {
  const container = document.getElementById('pdf-container');
  if (!container || !pdfCanvas) return null;
  return zichtbaarDeel(pdfCanvas.getBoundingClientRect(), container.getBoundingClientRect());
}

// Diepe zoom: de overlay volgt het zichtbare deel (zie overlay-canvas-size.js).
function _herknipOverlay() {
  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;
  const w = parseFloat(pdfCanvas.style.width), h = parseFloat(pdfCanvas.style.height);
  if (!(w > 0 && h > 0)) return;
  const maat = bepaalOverlayMaat({
    viewportActief: false, heeftBestandspad: false,
    paginaCssW: w, paginaCssH: h, dpr: getCanvasDPR(), zichtbaar: _zichtbaarOpPagina(pdfCanvas),
  });
  if (!maat) return;
  pasOverlayMaatToe(annotationCanvas, maat);
  pasOverlayMaatToe(document.getElementById('text-highlight-canvas'), maat);
}

// Render page offscreen and swap canvases atomically to avoid zoom flicker.
// The visible canvas keeps its CSS-scaled content until the new render is done.
export async function renderPageOffscreen(pageNum) {
  clearHighlights();

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const sourceRevision = sourceRenderRevision(doc.filePath);
  const staleSource = () => !sourceRenderCurrent(doc.filePath, sourceRevision);
  if (staleSource()) return;
  const pdfDoc = doc.pdfDoc;
  const scale = doc.scale;

  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) return;

  const page = await pdfDoc.getPage(pageNum);
  if (_isStaleDoc(doc) || staleSource()) return;
  const extraRotation = getPageRotation(pageNum);
  const viewportOpts = { scale };
  if (extraRotation) viewportOpts.rotation = (page.rotate + extraRotation) % 360;
  const viewport = page.getViewport(viewportOpts);
  const dpr = getCanvasDPR();

  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;

  // RUST-ONLY: this offscreen render path used to dual-fallback to PDF.js.
  // Per project policy ("geen fallback"), Rust failure is now a hard error
  // surfaced via state.renderEngine = 'ERROR' so any rasterizer bug is
  // immediately visible.
  // Deactivate the vector viewport singleton — same reason as renderPage().
  if (window.__pdfViewport) window.__pdfViewport.active = false;

  // Zonder Tauri (webversie) of zonder bestandspad kan PDFium niet; dan tekent
  // PDF.js. Dit is GEEN stille terugval voor een Rust-fout — die blijft hard
  // falen hieronder, zodat een rasterbug zichtbaar blijft.
  if (pdfjsFallbackNodig({ inTauri: isTauri(), hasFilePath: !!doc.filePath })) {
    try {
      await tekenPaginaMetPdfJs(page, viewport, pdfCanvas, doc);
      if (_isStaleDoc(doc) || staleSource()) return;
      setupCanvasHiDPI(annotationCanvas, viewport.width, viewport.height);
      redrawAnnotations();
      state.renderEngine = 'Raster (PDF.js)';
    } catch (e) {
      state.renderEngine = 'ERROR';
      console.warn('[render-offscreen] PDF.js-render mislukt:', e);
      return;
    }
  } else {
    try {
      const { renderPdfPage } = await import('./engine-router.js');
      const selectedRevision = nativeOcgSelectionForDocument(doc).revision;
      const rgbaData = await renderPdfPage({
        path: doc.filePath,
        pageIndex: pageNum - 1,
        scale: scale,
        ocgVisibility: nativeOcgSelectionForDocument(doc).ocgVisibility,
      });
      if (_isStaleDoc(doc) || staleSource() || nativeOcgSelectionForDocument(doc).revision !== selectedRevision) return;
      const _offBytes = rgbaData instanceof Uint8Array ? rgbaData : new Uint8Array(rgbaData);
      if (!_offBytes || _offBytes.length <= 8) {
        state.renderEngine = 'ERROR';
        console.error('[render-offscreen] HARD ERROR: Rust returned empty buffer. NO FALLBACK.');
        return;
      }
      const headerView = new DataView(_offBytes.buffer, _offBytes.byteOffset, 8);
      const rustW = headerView.getUint32(0, true);
      const rustH = headerView.getUint32(4, true);
      const rgba = new Uint8ClampedArray(_offBytes.buffer, _offBytes.byteOffset + 8, _offBytes.length - 8);
      pdfCanvas.width = rustW;
      pdfCanvas.height = rustH;
      pdfCanvas.style.width = Math.floor(viewport.width) + 'px';
      pdfCanvas.style.height = Math.floor(viewport.height) + 'px';
      const imageData = new ImageData(rgba, rustW, rustH);
      pdfCanvas.getContext('2d').putImageData(imageData, 0, 0);
      // Resize wist het overlay-canvas: direct synchron hertekenen zodat
      // afdekbeelden van text-edits/annotaties geen frame verdwijnen (zelfde
      // "no blink"-regel als verderop in renderPage).
      setupCanvasHiDPI(annotationCanvas, viewport.width, viewport.height);
      redrawAnnotations();
      state.renderEngine = 'Raster (PDFium)';
    } catch (e) {
      state.renderEngine = 'ERROR';
      console.error('[render-offscreen] HARD ERROR: Rust render threw. NO FALLBACK.', e);
      return;
    }
  }

  // Set CSS scale variables for text/annotation layers
  const container = document.getElementById('canvas-container');
  if (container) {
    container.style.setProperty('--scale-factor', viewport.scale);
    container.style.setProperty('--total-scale-factor', viewport.scale);
  }

  // Create text, link, form layers
  try { await createSinglePageTextLayer(page, viewport); } catch {}
  if (_isStaleDoc(doc)) return;
  try { await createSinglePageLinkLayer(page, viewport); } catch {}
  if (_isStaleDoc(doc)) return;
  try { await createSinglePageFormLayer(page, viewport); } catch {}
  if (_isStaleDoc(doc)) return;

  // Re-apply overlay state — see comment near renderer block ~line 455.
  // Only editText forces pe:none statically; select uses dynamic fallthrough.
  if (state.currentTool === 'editText') {
    annotationCanvas.style.zIndex = '2';
    annotationCanvas.style.pointerEvents = 'none';
  }
  applyOverlayPointerEvents(container);

  await ensureAnnotationsForPage(pageNum);
  if (_isStaleDoc(doc)) return;
  if (state.preferences.snapToPdfContent) prefetchPdfVectorGeometry(pageNum);
  redrawAnnotations();
  onPageRendered();
  updateAllStatus();
}

// Track which pages have been rendered in continuous mode
const _renderedPages = new Set();
const _residentPages = new Set();
const _continuousInRangePages = new Set();
const _contRerenderGate = createRerenderGate();
let _continuousObserver = null;
let _continuousBuildGeneration = 0;
const _continuousPageInfoCache = new WeakMap();
const CONT_MAX_RESIDENT_PAGES = 8;
const CONT_MAX_RESIDENT_BYTES = 256 * 1024 * 1024;

function _releaseContinuousPageSurface(pageNum) {
  const wrapper = document.querySelector(`#continuous-container .page-wrapper[data-page="${pageNum}"]`);
  if (!wrapper) return;
  _renderedPages.delete(pageNum);
  _residentPages.delete(pageNum);
  _contPageRenderGen.set(pageNum, (_contPageRenderGen.get(pageNum) || 0) + 1);
  const task = _continuousRenderTasks.get(pageNum);
  if (task) {
    try { task.cancel(); } catch {}
    _continuousRenderTasks.delete(pageNum);
  }
  const detail = _contDetailLagen.get(pageNum);
  if (detail) {
    detail.vrijgeven();
    _contDetailLagen.delete(pageNum);
  }
  releaseTextLayerForPage(pageNum);
  releaseLinkLayerForPage(pageNum);
  releaseFormLayerForPage(pageNum);
  const container = wrapper.querySelector('.canvas-container-cont');
  container?.querySelectorAll('canvas, .textLayer, .linkLayer, .formLayer').forEach(layer => layer.remove());
}

// Resident continuous pages with their canvas bytes and distance from the
// viewport. Null outside the continuous view.
function _continuousResidentPages() {
  if (typeof document === 'undefined') return null;
  const viewport = document.getElementById('pdf-container');
  if (!viewport || getActiveDocument()?.viewMode !== 'continuous') return null;
  const view = viewport.getBoundingClientRect();
  if (!view.height) return null;
  const pages = [];
  for (const pageNum of _residentPages) {
    const wrapper = document.querySelector(`#continuous-container .page-wrapper[data-page="${pageNum}"]`);
    if (!wrapper) continue;
    const rect = wrapper.getBoundingClientRect();
    const distance = Math.max(0, view.top - rect.bottom, rect.top - view.bottom);
    let bytes = 0;
    wrapper.querySelectorAll('canvas').forEach(canvas => { bytes += canvas.width * canvas.height * 4; });
    pages.push({
      pageNum, distance, bytes,
      inRange: _continuousInRangePages.has(pageNum) || distance === 0,
      focused: wrapper.contains(document.activeElement),
    });
  }
  return { pages, view };
}

function _trimContinuousPageSurfaces() {
  const resident = _continuousResidentPages();
  if (!resident) return;
  const { pages, view } = resident;
  const release = continuousPagesToRelease(pages, {
    maxPages: CONT_MAX_RESIDENT_PAGES,
    maxBytes: CONT_MAX_RESIDENT_BYTES,
    retainDistance: Math.max(600, view.height * 2),
  });
  for (const pageNum of release) _releaseContinuousPageSurface(pageNum);
  enforceBitmapBudget();
}

// The resident page canvases count toward the shared bitmap budget. Only a
// page outside the observer margin and without focus can go, farthest first.
registerBitmapCache('continuous-pages', {
  bytes() {
    const resident = _continuousResidentPages();
    return resident ? resident.pages.reduce((sum, page) => sum + page.bytes, 0) : 0;
  },
  evictOldest() {
    const resident = _continuousResidentPages();
    if (!resident) return 0;
    let far = null;
    for (const page of resident.pages) {
      if (page.inRange || page.focused || page.bytes <= 0) continue;
      if (!far || page.distance > far.distance) far = page;
    }
    if (!far) return 0;
    _releaseContinuousPageSurface(far.pageNum);
    return far.bytes;
  },
});

function continuousPageInfo(pdfDoc, pageNum) {
  let pages = _continuousPageInfoCache.get(pdfDoc);
  if (!pages) {
    pages = new Map();
    _continuousPageInfoCache.set(pdfDoc, pages);
  }
  const cached = pages.get(pageNum);
  if (cached) return Promise.resolve(cached);
  const pending = pdfDoc.getPage(pageNum).then(page => {
    const [x0, y0, x1, y1] = page.view;
    const viewport = page.getViewport({ scale: 1 });
    const info = {
      widthPt: x1 - x0, heightPt: y1 - y0,
      offsetXPt: x0, offsetYPt: y0, rotation: page.rotate || 0,
      baseW: viewport.width, baseH: viewport.height,
    };
    pages.set(pageNum, info);
    return info;
  }).catch(error => {
    pages.delete(pageNum);
    throw error;
  });
  pages.set(pageNum, pending);
  return pending;
}

// A single CPU-backed sharp region follows the visible continuous page.
// The capped full-page bitmap remains underneath for instant scroll feedback.
const _nativeContDetail = new ContinuousNativeDetailLayer({
  getRotation: beeldRotatie, getDpr: getCanvasDPR, isStaleDoc: _isStaleDoc,
});

// Per-pagina render-generatie voor de doorlopende weergave: de Rust-invoke
// is niet te annuleren, dus een verouderde render kan ná de verse landen en
// de bitmap-attrs terugzetten (bv. een fit-schaal-render die de verse
// 4096-render overschrijft bij snel doorzoomen). Alleen de nieuwste
// generatie mag de bitmap schrijven — zelfde principe als
// _foregroundRenderGen in het enkelpagina-pad, maar dan per pagina.
const _contPageRenderGen = new Map();

// Track active continuous page renders for cancellation
const _continuousRenderTasks = new Map(); // pageNum -> RenderTask

// Low-res preview cache for fast initial display
const _lowResCache = new Map(); // `${filePath}|${pageNum}` -> { canvas, scale }
const LOW_RES_SCALE = 0.5; // Render at 50% for fast preview

// Cache-key MUST include the document — a bare pageNum key served page N of
// whichever document happened to fill the cache first (wrong preview after a
// tab switch).
// Rotation is part of the key so a rotated page doesn't reuse the pre-rotation
// (old-orientation) preview canvas — that stale preview flashed in the OLD
// orientation on the continuous-view rebuild after rotating (issue #262).
function _lowResKey(pageNum) {
  const doc = getActiveDocument();
  return `${doc?.filePath || 'blank'}|${pageNum}|${beeldRotatie(pageNum)}|${nativeOcgSelectionForDocument(doc).revision}`;
}

// Render a quick low-res preview of a page (fast, <50ms per page)
export async function renderLowResPreview(pdfDoc, pageNum, targetWidth, targetHeight) {
  const doc = getActiveDocument();
  if (doc?.pdfDoc !== pdfDoc) return null;
  const sourceRevision = sourceRenderRevision(doc.filePath);
  if (!sourceRenderCurrent(doc.filePath, sourceRevision)) return null;
  const selectedRevision = nativeOcgSelectionForDocument(doc).revision;
  const cacheKey = _lowResKey(pageNum);
  if (_lowResCache.has(cacheKey)) return _lowResCache.get(cacheKey).canvas;

  const page = await pdfDoc.getPage(pageNum);
  const extraRotation = beeldRotatie(pageNum);
  const vpOpts = { scale: LOW_RES_SCALE };
  if (extraRotation) vpOpts.rotation = (page.rotate + extraRotation) % 360;
  const viewport = page.getViewport(vpOpts);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');

  try {
    await page.render({
      canvasContext: ctx,
      viewport,
      annotationMode: 0,
      optionalContentConfigPromise: nativeOcgPdfJsConfig(doc),
    }).promise;
  } catch (e) {
    if (e.name === 'RenderingCancelledException') return null;
    return null;
  }

  if (getActiveDocument() !== doc || !sourceRenderCurrent(doc.filePath, sourceRevision)
      || nativeOcgSelectionForDocument(doc).revision !== selectedRevision
      || _lowResKey(pageNum) !== cacheKey) return null;
  _lowResCache.set(cacheKey, { canvas, scale: LOW_RES_SCALE });
  return canvas;
}

// Clear low-res cache (on document close)
export function clearLowResCache() {
  _lowResCache.clear();
}

// Render a single page inside its wrapper (used by lazy rendering)
async function renderContinuousPage(pageNum) {
  const activePath = getActiveDocument()?.filePath;
  if (sourceWriteActive(activePath)) return;
  if (_renderedPages.has(pageNum)) return;

  const pageWrapper = document.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
  if (!pageWrapper) return;

  const canvasContainer = pageWrapper.querySelector('.canvas-container-cont');
  if (!canvasContainer) return;
  _renderedPages.add(pageNum);
  const myRenderGen = (_contPageRenderGen.get(pageNum) || 0) + 1;
  _contPageRenderGen.set(pageNum, myRenderGen);

  // Cancel any in-progress render for this page
  if (_continuousRenderTasks.has(pageNum)) {
    try { _continuousRenderTasks.get(pageNum).cancel(); } catch {}
    _continuousRenderTasks.delete(pageNum);
  }

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const sourceRevision = sourceRenderRevision(doc.filePath);
  const page = await doc.pdfDoc.getPage(pageNum);
  if (_isStaleDoc(doc) || !sourceRenderCurrent(doc.filePath, sourceRevision)
      || _contPageRenderGen.get(pageNum) !== myRenderGen) return;
  // Paginarotatie plus weergaverotatie (#200): de pagina, zijn tekst-, link-
  // en formulierlaag en de container staan in de gedraaide stand; alleen de
  // annotaties blijven in de paginaruimte (weergaveTransform hieronder).
  const extraRotation = beeldRotatie(pageNum);
  const vpOpts = { scale: doc.scale };
  if (extraRotation) {
    vpOpts.rotation = (page.rotate + extraRotation) % 360;
  }
  const viewport = page.getViewport(vpOpts);

  // Canvas-CSS-maat op het SCHRIJFMOMENT bepalen, niet uit de hierboven
  // vastgelegde viewport: doc.scale kan tijdens de async Rust-render
  // gewijzigd zijn (snel wheelzoomen), en viewport.width zou dan de door
  // _applyContinuousZoomInstant gezette maat terugdraaien naar de oude
  // schaal. baseW × doc.scale klopt altijd; de bitmap is hooguit even
  // gestretcht tot de debounced re-render hem vervangt. Bij ongewijzigde
  // schaal identiek aan viewport.width/height.
  const cssSize = () => ({
    w: Math.floor(parseFloat(pageWrapper.dataset.baseW) * doc.scale) || Math.floor(viewport.width),
    h: Math.floor(parseFloat(pageWrapper.dataset.baseH) * doc.scale) || Math.floor(viewport.height),
  });

  canvasContainer.style.setProperty('--scale-factor', viewport.scale);
  canvasContainer.style.setProperty('--total-scale-factor', viewport.scale);

  // Reuse existing canvases if available (zoom re-render), or create new ones
  let pdfCanvasEl = canvasContainer.querySelector('.pdf-canvas');
  let annotationCanvasEl = canvasContainer.querySelector('.annotation-canvas');
  let isNewPage = false;

  if (!pdfCanvasEl) {
    isNewPage = true;
    pdfCanvasEl = document.createElement('canvas');
    // First getContext(): CPU-backed on WebKitGTK (page-canvas-context.js).
    pageCanvasContext(pdfCanvasEl);
    pdfCanvasEl.className = 'pdf-canvas';
    pdfCanvasEl.dataset.page = pageNum;
    pdfCanvasEl.style.display = 'block';
    pdfCanvasEl.style.background = 'white';
    canvasContainer.appendChild(pdfCanvasEl);

    // Show low-res preview immediately while full render runs in background
    setupCanvasHiDPI(pdfCanvasEl, viewport.width, viewport.height);
    const lowRes = _lowResCache.get(_lowResKey(pageNum));
    if (lowRes) {
      const previewCtx = pdfCanvasEl.getContext('2d');
      previewCtx.drawImage(lowRes.canvas, 0, 0, pdfCanvasEl.width, pdfCanvasEl.height);
    }
  }

  if (!annotationCanvasEl) {
    annotationCanvasEl = document.createElement('canvas');
    annotationCanvasEl.className = 'annotation-canvas';
    annotationCanvasEl.dataset.page = pageNum;
    annotationCanvasEl.style.position = 'absolute';
    annotationCanvasEl.style.top = '0';
    annotationCanvasEl.style.left = '0';
    canvasContainer.appendChild(annotationCanvasEl);
  }
  _residentPages.add(pageNum);

  // Update canvas dimensions for new scale. A REUSED pdf-canvas keeps its old
  // bitmap as a CSS-stretched placeholder until the new render lands: resizing
  // a canvas wipes it, and that wipe was exactly the white flash that made
  // zooming in continuous mode unusable.
  //
  // Het annotation-canvas WORDT hier geresized (en dus gewist) — daarom moet
  // het in HETZELFDE synchrone blok direct hertekend worden (zelfde regel als
  // het single-page-pad: "resize and redraw in one synchronous block — no
  // blink"). Zonder die directe hertekening stonden afdek-/vervangbeelden van
  // text-edits en alle annotaties frames-lang niet op het scherm terwijl de
  // paginarender async liep — de oude tekst onder een text-edit flitste dan
  // zichtbaar door bij zoomen/scrollen in doorlopende weergave.
  const annBackingScale = setupContinuousAnnotationCanvas(annotationCanvasEl, viewport.width, viewport.height);
  const annClipOffset = () => ({
    x: (parseFloat(annotationCanvasEl.dataset.clipX) || 0) / doc.scale,
    y: (parseFloat(annotationCanvasEl.dataset.clipY) || 0) / doc.scale,
  });
  renderAnnotationsForPage(
    annotationCanvasEl.getContext('2d'), pageNum,
    annotationCanvasEl.width, annotationCanvasEl.height, annBackingScale,
    annClipOffset(),
    { w: viewport.width / doc.scale, h: viewport.height / doc.scale },
    undefined,
    weergaveTransform(pageNum),
  );
  // A new canvas got this size where it was created, before its low-res
  // preview was drawn. Setting width again, even to the same value, clears
  // the canvas, and the preview never reached the screen.
  if (!isNewPage) {
    const { w: cssW0, h: cssH0 } = cssSize();
    pdfCanvasEl.style.width = cssW0 + 'px';
    pdfCanvasEl.style.height = cssH0 + 'px';
  }
  // Cursor is handled centrally by js/ui/cursor.js — no need to set it here.

  // Only editText forces pe:none statically; select uses dynamic fallthrough.
  // See comment near renderer block ~line 455.
  if (state.currentTool === 'editText') {
    annotationCanvasEl.style.zIndex = '2';
    annotationCanvasEl.style.pointerEvents = 'none';
  }

  // RUST-ONLY: continuous-mode page render. Used to dual-fallback to
  // PDF.js — removed per project policy. Rust failure surfaced via console
  // + state.renderEngine = 'ERROR' (the page stays blank rather than
  // showing a slow-rendered PDF.js fallback that hides the actual Rust bug).
  const pdfCtxEl = pdfCanvasEl.getContext('2d');

  // Webversie/documenten zonder pad: PDF.js tekent. Zie render-route.js.
  const _pdfjsPad = pdfjsFallbackNodig({ inTauri: isTauri(), hasFilePath: !!doc.filePath });

  // ─── PERF FIX #1 + #2 + #3 (large-sheet measurement scaffold) ───────────────
  //  #1: (Superseded) the render scale includes the dpr again, bounded
  //      by CONT_MAX_AXIS_PX, so the Rust pixel work per page has the
  //      same ceiling as before (see doorlopendeRenderSchaal).
  //  #2: Reuse the same JS-side ImageBitmap cache that renderPage uses
  //      (_BITMAP_JS_CACHE) so scrolling a page back into view does a
  //      <10ms drawImage instead of a 1.5-3s cold Rust render. Cache key
  //      mirrors the single-page path so a continuous→single switch at
  //      the same scale also hits warm.
  //  #3: Skip the tempfile roundtrip — Rust now returns RGBA bytes
  //      directly via tauri::ipc::Response (see lib.rs render_pdf_page).
  //      The invoke() now resolves to ArrayBuffer/Uint8Array, not a
  //      "path|w|h" string. No more allow_fs_scope + readBinaryFile +
  //      tempfile unlink chain — pure binary IPC.
  //
  // Instrumentation: every console.time/timeEnd is scoped to one render
  // call so DevTools shows you cache-lookup / invoke-render / canvas
  // putImageData / cache-store sub-timings per page. Compare totals
  // before vs after on the raster-heavy sample PDF.
  // Bitmap-axis cap: a full-page render at high zoom on a large sheet would
  // blow past canvas limits and memory (A0 at 400% ≈ 19k px wide, 1.5 GB of
  // RGBA). Render at the largest scale that fits the cap and let CSS stretch
  // the bitmap to the logical size — same philosophy as MAX_BITMAP_AXIS_PX in
  // the single-page path. Sharp detail work at high zoom belongs to
  // single-page mode (tiles); continuous trades that for full-document flow.
  const _maxViewAxis = Math.max(viewport.width, viewport.height);
  // Device pixels (zoom x dpr) up to the same axis cap: rendering at bare
  // doc.scale left every page CSS-resolution on a 125-200 % display, i.e.
  // stretched by the compositor and visibly soft next to the external editor.
  const renderScale = doorlopendeRenderSchaal(doc.scale, _maxViewAxis, getCanvasDPR(), CONT_MAX_AXIS_PX);

  const label = `[render p${pageNum} scale ${renderScale.toFixed(2)}]`;
  console.time(label);
  const selectedRevision = nativeOcgSelectionForDocument(doc).revision;
  const _jsCacheKey = `${doc.filePath}|${pageNum}|${Math.round(renderScale * 10000)}|${extraRotation || 0}|${selectedRevision}`;
  console.time(label + ' cache-lookup');
  const _cached = _bitmapJSCacheGet(_jsCacheKey);
  console.timeEnd(label + ' cache-lookup');
  if (_pdfjsPad) {
    try {
      // Zoals de enkelpagina-weergave: basisbitmap tot
      // PDFJS_DETAIL_BASE_MAX_AXIS_PX, het zichtbare deel scherp erboven
      // (pdfjs-detail-layer.js, één laag per pagina).
      const { apRenderKeyPart, apToonVoorPagina } = await import('./ap-render-state.js');
      // Zelfde motor als de enkelpagina-weergave: PDFium (WebAssembly) als dat kan.
      const rasterizer = await _webRasterizer(doc, apToonVoorPagina);
      let sleutel = null, renderParams = null, opLijst = null;
      const ok = await tekenPaginaMetPdfJs(page, viewport, pdfCanvasEl, doc,
        () => _contPageRenderGen.get(pageNum) === myRenderGen && !_isStaleDoc(doc),
        {
          maxAxisPx: PDFJS_DETAIL_BASE_MAX_AXIS_PX,
          rasterizer,
          renderKey: () => (sleutel = `${pageNum}|${viewport.rotation || 0}|${nativeOcgSelectionForDocument(doc).revision}|${sourceRevision}|${apRenderKeyPart(doc)}|${rasterizer ? rasterizer.naam : 'pdfjs'}`),
          metRenderParams: (rp) => { renderParams = rp; },
          onOperatorList: (l) => { opLijst = l; },
        });
      if (ok) {
        _contDetailLaag(pageNum).zetPagina({
          page,
          viewport,
          viewportVoor: (s) => page.getViewport({ scale: s, rotation: viewport.rotation }),
          dpr: getCanvasDPR(),
          baseRatio: viewport.width > 0 ? pdfCanvasEl.width / viewport.width : 0,
          sleutel,
          optionalContentConfigPromise: nativeOcgPdfJsConfig(doc),
          renderParams,
          operatorList: opLijst,
          rasterizer,
        });
      }
      state.renderEngine = rasterizer ? 'Raster (PDFium · web)' : 'Raster (PDF.js)';
    } catch (e) {
      console.warn(`[render-continuous] PDF.js-render van pagina ${pageNum} mislukt:`, e);
    }
    console.timeEnd(label);
  } else if (_cached) {
    console.time(label + ' canvas-draw-cached');
    pdfCanvasEl.width = _cached.w;
    pdfCanvasEl.height = _cached.h;
    // CSS size = logical page size; differs from the backing store when the
    // axis cap reduced renderScale (CSS upscales the capped bitmap).
    const { w: cssW1, h: cssH1 } = cssSize();
    pdfCanvasEl.style.width = cssW1 + 'px';
    pdfCanvasEl.style.height = cssH1 + 'px';
    pdfCtxEl.drawImage(_cached.bitmap, 0, 0);
    console.timeEnd(label + ' canvas-draw-cached');
    state.renderEngine = 'Raster (PDFium · cached)';
    console.timeEnd(label);
  } else {
    try {
      // Schaal alweer veranderd vóór de dure render start? Dan zou dit een
      // verouderde render worden die de wachtrij verstopt terwijl de pagina
      // wit blijft. Meteen opnieuw plannen op de actuele schaal.
      if (doc.scale !== vpOpts.scale) {
        console.timeEnd(label);
        _renderedPages.delete(pageNum);
        setTimeout(() => { renderContinuousPage(pageNum); }, 30);
        return;
      }
      console.time(label + ' invoke-render');
      const { renderPdfPage } = await import('./engine-router.js');
      const rgbaData = await renderPdfPage({
        path: doc.filePath,
        pageIndex: pageNum - 1,
        scale: renderScale,
        // Pass the user page rotation so PDFium rasterises in the SAME
        // orientation as the wrapper/canvas box (sized from PDF.js's rotated
        // viewport). Omitting it rendered the page un-rotated into a rotated
        // box — the old-orientation remnant of issue #262 in continuous view.
        rotation: extraRotation || 0,
        ocgVisibility: nativeOcgSelectionForDocument(doc).ocgVisibility,
      });
      console.timeEnd(label + ' invoke-render');
      if (_isStaleDoc(doc) || !sourceRenderCurrent(doc.filePath, sourceRevision)
          || nativeOcgSelectionForDocument(doc).revision !== selectedRevision) { console.timeEnd(label); return; }
      if (_contPageRenderGen.get(pageNum) !== myRenderGen) { console.timeEnd(label); return; }
      const _contBytes = rgbaData instanceof Uint8Array ? rgbaData : new Uint8Array(rgbaData);
      if (!_contBytes || _contBytes.length <= 8) {
        state.renderEngine = 'ERROR';
        console.error(`[render-continuous] HARD ERROR: page ${pageNum} Rust returned empty buffer. NO FALLBACK.`);
        console.timeEnd(label);
        return;
      }
      const headerView = new DataView(_contBytes.buffer, _contBytes.byteOffset, 8);
      const rustW = headerView.getUint32(0, true);
      const rustH = headerView.getUint32(4, true);
      const rgba = new Uint8ClampedArray(_contBytes.buffer, _contBytes.byteOffset + 8, _contBytes.length - 8);
      console.time(label + ' canvas-putImageData');
      pdfCanvasEl.width = rustW;
      pdfCanvasEl.height = rustH;
      // CSS size = logical page size (see the cached branch above).
      const { w: cssW2, h: cssH2 } = cssSize();
      pdfCanvasEl.style.width = cssW2 + 'px';
      pdfCanvasEl.style.height = cssH2 + 'px';
      const imageData = new ImageData(rgba, rustW, rustH);
      pdfCtxEl.putImageData(imageData, 0, 0);
      console.timeEnd(label + ' canvas-putImageData');
      state.renderEngine = 'Raster (PDFium)';
      // Cache the freshly-rendered bitmap. createImageBitmap() snapshots the
      // pixels, and the view keeps _contBytes' buffer alive until it does,
      // so the page needs no second full-size RGBA copy (up to ~47 MB).
      console.time(label + ' cache-store');
      _bitmapJSCacheSet(_jsCacheKey, imageData, doc.filePath);
      console.timeEnd(label + ' cache-store');
      console.timeEnd(label);
    } catch (e) {
      state.renderEngine = 'ERROR';
      console.error(`[render-continuous] HARD ERROR: page ${pageNum} Rust threw. NO FALLBACK.`, e);
      try { console.timeEnd(label); } catch {}
      return;
    }
  }

  if (_contPageRenderGen.get(pageNum) !== myRenderGen) return;
  // Schaal tijdens de async render gewijzigd? De bitmap is getekend (beter
  // gestretcht dan oud beeld), maar de tekst-/link-/formlagen zouden op de
  // verouderde viewport gepositioneerd worden. Overslaan: de aankomende
  // debounced re-render (reRenderVisibleContinuousPages cleart _renderedPages)
  // herbouwt deze pagina op de juiste schaal. De muis-events moeten bij een
  // nieuwe pagina wél nu al gekoppeld worden: bij de herkansing is isNewPage
  // false en zou setupContinuousPageEvents anders nooit draaien.
  if (doc.scale !== vpOpts.scale) {
    if (isNewPage) setupContinuousPageEvents(annotationCanvasEl, pageNum);
    // De laatste debounced re-render kan al gedraaid zijn terwijl deze render
    // nog liep — zonder herplanning blijft de pagina dan permanent op de
    // (gestretchte) oude bitmap staan. Zelf een verse render inplannen.
    _renderedPages.delete(pageNum);
    setTimeout(() => { renderContinuousPage(pageNum); }, 50);
    return;
  }

  // Oude lagen van deze pagina eerst opruimen: createTextLayer/createLinkLayer
  // voegen alleen toe, en zonder deze sweep stapelde elke zoom-herbouw een
  // complete extra tekst-/link-/formlaag op de wrapper (duplicaat-spans,
  // verouderde klikdoelen).
  canvasContainer.querySelectorAll('.textLayer, .linkLayer, .formLayer')
    .forEach(l => l.remove());

  // Create text layer
  try {
    await createTextLayer(page, viewport, canvasContainer, pageNum,
      () => _contPageRenderGen.get(pageNum) === myRenderGen && !_isStaleDoc(doc));
  } catch (e) {
    console.warn(`Failed to create text layer for page ${pageNum}:`, e);
  }
  if (_isStaleDoc(doc) || _contPageRenderGen.get(pageNum) !== myRenderGen) return;

  // Create link layer
  try {
    await createLinkLayer(page, viewport, canvasContainer, pageNum,
      () => _contPageRenderGen.get(pageNum) === myRenderGen && !_isStaleDoc(doc));
  } catch (e) {
    console.warn(`Failed to create link layer for page ${pageNum}:`, e);
  }
  if (_isStaleDoc(doc) || _contPageRenderGen.get(pageNum) !== myRenderGen) return;

  // Create form layer
  try {
    await createFormLayer(page, viewport, canvasContainer, pageNum,
      () => _contPageRenderGen.get(pageNum) === myRenderGen && !_isStaleDoc(doc));
  } catch (e) {
    console.warn(`Failed to create form layer for page ${pageNum}:`, e);
  }
  if (_isStaleDoc(doc) || _contPageRenderGen.get(pageNum) !== myRenderGen) return;

  // Re-apply overlay state for newly created form/link layers
  applyOverlayPointerEvents(canvasContainer);

  // Render annotations
  const annotationCtxEl = annotationCanvasEl.getContext('2d');
  renderAnnotationsForPage(
    annotationCtxEl, pageNum,
    annotationCanvasEl.width, annotationCanvasEl.height, annBackingScale,
    annClipOffset(),
    { w: viewport.width / doc.scale, h: viewport.height / doc.scale },
    undefined,
    weergaveTransform(pageNum),
  );

  // Re-apply search highlights after re-render
  onPageRendered();

  // Scherpe overlays bij hoge zoom (gecapte backing store) direct bijwerken.
  updateContinuousSharpOverlay(pageWrapper, pageNum);
  _nativeContDetail.schedule(0);

  // Setup mouse events only for new pages (not re-renders)
  if (isNewPage) {
    setupContinuousPageEvents(annotationCanvasEl, pageNum);
  }
  _trimContinuousPageSurfaces();
}

// Re-render only visible pages at new scale (keeps existing DOM structure)
export async function reRenderVisibleContinuousPages() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const token = _contRerenderGate.begin(doc.scale);
  const scale = token.scale;

  const continuousContainer = document.getElementById('continuous-container');
  if (!continuousContainer) return;

  // The first layout stored each page's exact scale-1 viewport dimensions.
  // Reuse them for zoom: awaiting getPage for every page here delays the
  // visible render behind the entire document on large drawing sets. A page
  // rotation rebuilds the wrappers, so these dimensions stay authoritative.
  // Keep the gate for the rare wrapper without cached dimensions, where a
  // getPage await can overlap another zoom or document switch.
  const jobs = [];
  for (const wrapper of continuousContainer.querySelectorAll('.page-wrapper')) {
    const pageNum = parseInt(wrapper.dataset.page, 10);
    if (!pageNum) continue;
    let baseW = Number(wrapper.dataset.baseW);
    let baseH = Number(wrapper.dataset.baseH);
    if (!(baseW > 0 && baseH > 0)) {
      const page = await doc.pdfDoc.getPage(pageNum);
      if (!_contRerenderGate.isCurrent(token, doc.scale) || _isStaleDoc(doc)) return;
      const extraRotation = beeldRotatie(pageNum);
      const opts = { scale: 1 };
      if (extraRotation) opts.rotation = (page.rotate + extraRotation) % 360;
      const viewport = page.getViewport(opts);
      baseW = viewport.width;
      baseH = viewport.height;
    }
    jobs.push({ wrapper, baseW, baseH });
  }
  if (!_contRerenderGate.isCurrent(token, doc.scale) || _isStaleDoc(doc)) return;

  // Fase 2 (synchroon, atomair): pas hier invalideren en alle maten in één
  // keer schrijven — dit blok kan niet meer door een wheel-event doorsneden
  // worden.
  _renderedPages.clear();
  for (const { wrapper, baseW, baseH } of jobs) {
    // Keep the scale-1 base dims fresh so instant zoom can resize synchronously.
    wrapper.dataset.baseW = baseW;
    wrapper.dataset.baseH = baseH;

    const cc = wrapper.querySelector('.canvas-container-cont');
    if (cc) {
      cc.style.width = `${baseW * scale}px`;
      cc.style.height = `${baseH * scale}px`;
    }
  }

  // IntersectionObserver will automatically trigger re-render for visible pages
  // Force a re-check by briefly disconnecting and reconnecting
  if (_continuousObserver) {
    _continuousObserver.disconnect();
    _continuousInRangePages.clear();
    continuousContainer.querySelectorAll('.page-wrapper').forEach(wrapper => {
      _continuousObserver.observe(wrapper);
    });
  }

  // Annotatie-uitsnedes op de nieuwe schaal zetten (zichtbare pagina's).
  reclipAllContinuousAnnotationCanvases();
}

// ─── Continuous mode: zoom + scroll/page sync ───────────────────────────────

// Instant zoom: resize every page's container + its rendered canvases straight
// to the new scale and re-anchor the scroll in the SAME synchronous frame, so
// the page tracks the wheel/button immediately. The crisp Rust re-render is
// debounced (see continuousZoomBy) and swaps in once the gesture settles. The
// old approach awaited a full re-render BEFORE moving the scroll, which made
// the page lurch and lag a notch behind the wheel (schokkerig + vertraging).
function _applyContinuousZoomInstant(oldScale, anchorY = null, anchorX = null) {
  const doc = getActiveDocument();
  const container = document.getElementById('pdf-container');
  const cont = document.getElementById('continuous-container');
  if (!doc || !container || !cont || !oldScale) return;
  const newScale = doc.scale;
  const factor = newScale / oldScale;
  // Anker in client-coördinaten; zonder cursor (zoom-knoppen, setZoom) het
  // midden van de zichtbare container.
  const contRect = container.getBoundingClientRect();
  const ax = contRect.left + (anchorX != null ? anchorX : container.clientWidth / 2);
  const ay = contRect.top + (anchorY != null ? anchorY : container.clientHeight / 2);
  // Referentie-element: de pagina onder het anker (of de dichtstbijzijnde).
  // De oude formule `(scrollTop + anker) * factor` nam aan dat de hele
  // scroll-inhoud met `factor` meeschaalt, maar gaps/padding staan in vaste
  // px — en horizontaal werd er helemaal niet geankerd, waardoor het punt
  // onder de cursor bij elke zoomstap opzij dreef (issue: zoom centreert
  // niet rond de muis). De rect van de pagina vóór/ná de resize geeft een
  // exacte correctie voor beide assen.
  const pageEls = [...cont.querySelectorAll('.page-wrapper .canvas-container-cont')];
  // left/right meegeven: in boek-/dubbelepaginaweergave delen twee pagina's
  // dezelfde verticale grenzen en moet de horizontale positie beslissen.
  const refIdx = pickAnchorPageIndex(pageEls.map(el => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }), ay, ax);
  const refEl = refIdx >= 0 ? pageEls[refIdx] : null;
  const rectBefore = refEl ? refEl.getBoundingClientRect() : null;
  cont.querySelectorAll('.page-wrapper').forEach(wrapper => {
    const cc = wrapper.querySelector('.canvas-container-cont');
    if (!cc) return;
    const baseW = parseFloat(wrapper.dataset.baseW);
    const baseH = parseFloat(wrapper.dataset.baseH);
    // Exact size from scale-1 base (no drift); fall back to scaling the current
    // box if base dims are somehow missing.
    const w = (baseW && baseH) ? baseW * newScale : (parseFloat(cc.style.width) || cc.offsetWidth) * factor;
    const h = (baseW && baseH) ? baseH * newScale : (parseFloat(cc.style.height) || cc.offsetHeight) * factor;
    cc.style.width = `${w}px`;
    cc.style.height = `${h}px`;
    // Stretch the already-rendered bitmap(s) to the new box immediately; the
    // debounced re-render replaces them with a crisp render at the new scale.
    cc.querySelectorAll('canvas').forEach(cv => {
      if (cv.classList.contains('annotation-canvas')) {
        // Viewport-gebonden uitsnede: maat en positie schalen mee met het
        // gebaar; de settle-hertekening zet hem daarna exact.
        cv.style.width = ((parseFloat(cv.style.width) || 0) * factor) + 'px';
        cv.style.height = ((parseFloat(cv.style.height) || 0) * factor) + 'px';
        cv.style.left = ((parseFloat(cv.style.left) || 0) * factor) + 'px';
        cv.style.top = ((parseFloat(cv.style.top) || 0) * factor) + 'px';
        cv.dataset.clipX = (parseFloat(cv.dataset.clipX) || 0) * factor;
        cv.dataset.clipY = (parseFloat(cv.dataset.clipY) || 0) * factor;
        return;
      }
      if (cv.classList.contains('annotation-canvas-sharp') || cv.classList.contains('pdf-canvas-sharp') || cv.classList.contains('pdf-detail-canvas')) {
        // De viewport-uitsnede schaalt mee met de pagina (maat én positie);
        // de settle-hertekening vervangt hem daarna door een exacte uitsnede.
        cv.style.width = `${(parseFloat(cv.style.width) || 0) * factor}px`;
        cv.style.height = `${(parseFloat(cv.style.height) || 0) * factor}px`;
        cv.style.left = `${(parseFloat(cv.style.left) || 0) * factor}px`;
        cv.style.top = `${(parseFloat(cv.style.top) || 0) * factor}px`;
        return;
      }
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    });
  });
  // Scroll-correctie ná de synchrone resize (getBoundingClientRect forceert
  // de reflow): zet het content-punt terug onder het anker. De browser
  // clampt zelf op de scrollranden; als de inhoud smaller is dan de viewport
  // is er geen scrollruimte en centreert de layout — dat is inherent.
  if (refEl && rectBefore) {
    const { dx, dy } = anchorScrollCorrection({ x: ax, y: ay }, rectBefore, refEl.getBoundingClientRect());
    container.scrollLeft += dx;
    container.scrollTop += dy;
  }
}

let _contRerenderTimer = null;

// Core continuous zoom: multiply scale by `factor`, apply the instant visual
// zoom, then debounce the crisp re-render. Anchored at anchorY/anchorX (px
// within #pdf-container) so content under the cursor stays put; without
// anchor it zooms around the viewport center.
export function continuousZoomBy(factor, anchorY = null, anchorX = null) {
  const doc = getActiveDocument();
  if (!doc || doc.viewMode !== 'continuous' || !factor) return;
  const old = doc.scale;
  let next = Math.min(24, Math.max(0.05, old * factor));
  next = Math.round(next * 1000) / 1000;
  if (next === old) return;
  doc.scale = next;
  _nativeContDetail.reset();
  _applyContinuousZoomInstant(old, anchorY, anchorX);
  updateAllStatus(); // zoom % tracks the gesture immediately
  if (_contRerenderTimer) clearTimeout(_contRerenderTimer);
  _contRerenderTimer = setTimeout(() => {
    _contRerenderTimer = null;
    if (getActiveDocument()?.viewMode !== 'continuous') return;
    reRenderVisibleContinuousPages();
  }, 130);
}

// Absolute variant voor setZoom/fit/actualSize in de doorlopende weergave:
// doc.scale is al op de nieuwe waarde gezet door de aanroeper; pas de
// instant-zoom toe vanaf oldScale en plan dezelfde debounced crisp re-render
// als continuousZoomBy. (Was een dangling verwijzing: de drie aanroepers
// gooiden een ReferenceError zodat absolute zoom/ware grootte in de
// doorlopende weergave helemaal niets deed.)
async function _continuousRezoom(oldScale) {
  _nativeContDetail.reset();
  _applyContinuousZoomInstant(oldScale);
  updateAllStatus();
  if (_contRerenderTimer) clearTimeout(_contRerenderTimer);
  _contRerenderTimer = setTimeout(() => {
    _contRerenderTimer = null;
    if (getActiveDocument()?.viewMode !== 'continuous') return;
    reRenderVisibleContinuousPages();
  }, 130);
}

// One discrete zoom step (zoom buttons / keyboard) anchored at anchorY.
export function continuousZoomStep(direction, anchorY = null) {
  continuousZoomBy(direction > 0 ? 1.25 : 0.8, anchorY);
}

// While the user scrolls freely, the page whose center sits closest to the
// viewport center becomes doc.currentPage — status bar and thumbnail
// highlight track the scroll just like explicit navigation does.
let _contScrollSyncBound = false;
function _bindContinuousScrollSync() {
  if (_contScrollSyncBound) return;
  const container = document.getElementById('pdf-container');
  if (!container) return;
  _contScrollSyncBound = true;
  let pending = null;
  container.addEventListener('scroll', () => {
    const doc = getActiveDocument();
    // Facing toont één spread zonder scroll-navigatie; scroll mag currentPage
    // (het spread-anker) niet naar de rechterpagina verschuiven, anders breekt
    // vorige/volgende. Daarom hier overslaan.
    if (!doc || doc.viewMode !== 'continuous') return;
    _nativeContDetail.schedule();
    if (doc.facingSpread) return;
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      _syncCurrentPageFromScroll(container);
      // Annotatie-uitsnedes op de nieuwe scrollpositie zetten, alleen waar
      // de huidige uitsnede het zicht niet meer dekt.
      reclipAllContinuousAnnotationCanvases({ alleenNodig: true });
      // Scherpe pagina-uitsnedes volgen (PDF.js-pad).
      _werkContDetailLagenBij();
    }, 120);
  }, { passive: true });
}

function _syncCurrentPageFromScroll(container) {
  const doc = getActiveDocument();
  if (!doc || doc.viewMode !== 'continuous' || doc.facingSpread) return;
  const box = container.getBoundingClientRect();
  const mid = box.top + box.height / 2;
  let bestPage = null;
  let bestDist = Infinity;
  document.querySelectorAll('#continuous-container .page-wrapper').forEach(w => {
    const r = w.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestDist) {
      bestDist = d;
      bestPage = parseInt(w.dataset.page, 10);
    }
  });
  if (bestPage && doc.currentPage !== bestPage) {
    doc.currentPage = bestPage;
    updateActiveThumbnail();
    updateAllStatus();
  }
}

// Issue #336: in de doorlopende weergave moet #canvas-wrapper met de
// BREEDSTE pagina kunnen meegroeien (width: max-content via de klasse
// .continuous-mode in layout.css), anders centreert flexbox een bredere
// pagina met onbereikbare overloop links. In de enkelpagina-weergave
// behoudt de wrapper zijn vaste 100%-breedte.
function _setContinuousLayoutActive(on) {
  document.getElementById('canvas-wrapper')?.classList.toggle('continuous-mode', !!on);
}

// Render all pages (continuous mode) — creates placeholders, lazily renders visible pages
export async function renderContinuous(forceRebuild) {
  // Clear search highlights immediately to prevent stale positions during re-render
  clearHighlights();

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const pdfDoc = doc.pdfDoc;
  const scale = doc.scale;
  const buildGeneration = ++_continuousBuildGeneration;

  // Install the cross-monitor DPI watcher (issue #263) even when a document is
  // only ever viewed in continuous mode — initViewport (single path) may never
  // run for it. Idempotent: re-arming replaces the previous listener.
  import('./pdf-viewport.js').then(m => m.ensureDprWatcher()).catch(() => {});

  // Continuous mode uses its own per-page canvases inside #continuous-container,
  // not the shared #pdf-canvas. Disable the vector viewport singleton so its
  // RAF loop can't redraw a previously-active single-page document on top of
  // continuous-mode content if the user toggled view modes / switched tabs.
  if (window.__pdfViewport) window.__pdfViewport.active = false;

  const continuousContainer = document.getElementById('continuous-container');

  // Boekweergave (issue #201): sync the spread-layout class + display with
  // the doc flag HERE so every re-render path (zoom, search, tab switch,
  // thin-lines toggle) keeps the book layout without knowing about it.
  continuousContainer.classList.toggle('book-spread', !!doc.bookSpread);
  // Facing (issue #164): één spread naast elkaar, niet-doorlopend. Eigen
  // layout-klasse zodat de left/right-plaatsing per pagina expliciet gaat (zie
  // de wrapper-lus onder) en niet afhangt van de DOM-kindindex zoals book-spread.
  continuousContainer.classList.toggle('facing-spread', !!doc.facingSpread);
  if (continuousContainer.style.display !== 'none') {
    continuousContainer.style.display = (doc.bookSpread || doc.facingSpread) ? 'grid' : 'flex';
  }
  _setContinuousLayoutActive(continuousContainer.style.display !== 'none');

  // Cleanup previous observer
  if (_continuousObserver) {
    _continuousObserver.disconnect();
    _continuousObserver = null;
  }
  for (const pageNum of _contPageRenderGen.keys()) {
    _contPageRenderGen.set(pageNum, _contPageRenderGen.get(pageNum) + 1);
  }
  _renderedPages.clear();
  _residentPages.clear();
  _continuousInRangePages.clear();
  _nativeContDetail.reset();

  wisContDetailLagen();
  continuousContainer.innerHTML = '';

  clearTextLayers();
  clearLinkLayers();
  clearFormLayers();

  // Facing-modus bouwt alleen de huidige spread (1-2 pagina's); doorlopend/boek
  // bouwt alle pagina's. doc.currentPage is in facing het spread-anker.
  const _pageList = doc.facingSpread
    ? _spreadPagesFor(_spreadAnchor(doc.currentPage), pdfDoc.numPages)
    : Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);

  // Keep a small metadata window in flight. PDF.js page-descriptor requests
  // have per-request overhead; this overlaps them without flooding the worker
  // or forcing the visible page to wait for an entire batch.
  const pendingInfo = new Map();
  let nextInfo = 0;
  const queueInfo = () => {
    while (pendingInfo.size < 6 && nextInfo < _pageList.length) {
      const pageNum = _pageList[nextInfo++];
      const task = continuousPageInfo(pdfDoc, pageNum);
      task.catch(() => {}); // a newer build may leave this prefetch unawaited
      pendingInfo.set(pageNum, task);
    }
  };
  queueInfo();

  // First pass: create all page wrappers with exact mixed-sheet dimensions.
  for (const pageNum of _pageList) {
    const info = await pendingInfo.get(pageNum);
    pendingInfo.delete(pageNum);
    queueInfo();
    if (_continuousBuildGeneration !== buildGeneration || _isStaleDoc(doc)
        || doc.viewMode !== 'continuous') return;
    if (!doc.pageDims) doc.pageDims = {};
    doc.pageDims[pageNum] = {
      widthPt: info.widthPt,
      heightPt: info.heightPt,
      offsetXPt: info.offsetXPt,
      offsetYPt: info.offsetYPt,
      rotation: info.rotation,
    };
    // Paginarotatie plus weergaverotatie (#200): de wrapper krijgt de maat
    // van de pagina zoals hij op het scherm ligt.
    const extraRotation = beeldRotatie(pageNum);
    const sideways = isKwartslag(extraRotation);
    const viewport = {
      width: (sideways ? info.baseH : info.baseW) * scale,
      height: (sideways ? info.baseW : info.baseH) * scale,
    };

    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'page-wrapper';
    pageWrapper.dataset.page = pageNum;
    // Scale-1 base dims so instant zoom can resize synchronously without a
    // per-step getPage() round-trip — see _applyContinuousZoomInstant.
    pageWrapper.dataset.baseW = viewport.width / scale;
    pageWrapper.dataset.baseH = viewport.height / scale;

    // Facing: expliciete kolomplaatsing zodat het paar tegen de rug aansluit,
    // onafhankelijk van hoeveel wrappers er in de DOM staan. Linkerpagina (even)
    // → kolom 1; rechterpagina (oneven) en de alleenstaande pagina 1 → kolom 2.
    if (doc.facingSpread) {
      const rightSide = (pageNum === 1) || (pageNum % 2 === 1);
      pageWrapper.style.gridColumn = rightSide ? '2' : '1';
      pageWrapper.style.justifySelf = rightSide ? 'start' : 'end';
    }

    // Placeholder container with correct dimensions
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'canvas-container-cont';
    canvasContainer.style.position = 'relative';
    canvasContainer.style.display = 'inline-block';
    canvasContainer.style.width = `${viewport.width}px`;
    canvasContainer.style.height = `${viewport.height}px`;
    canvasContainer.style.background = 'white';
    canvasContainer.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';

    pageWrapper.appendChild(canvasContainer);
    continuousContainer.appendChild(pageWrapper);
    if (pageNum === 1 && doc.currentPage === 1 && !_renderedPages.has(1)) {
      // The first page can start rasterizing while metadata for the rest of
      // the drawing set is still arriving. The observer below handles all
      // other pages once their exact layout is available.
      renderContinuousPage(1);
    }
  }

  updateAllStatus();

  // Setup IntersectionObserver to lazily render pages as they scroll into view
  const scrollContainer = document.getElementById('pdf-container');
  _continuousObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pageNum = parseInt(entry.target.dataset.page, 10);
      if (!pageNum) continue;
      if (entry.isIntersecting) {
        _continuousInRangePages.add(pageNum);
        if (pageNum && !_renderedPages.has(pageNum)) {
          renderContinuousPage(pageNum);
        }
      } else {
        _continuousInRangePages.delete(pageNum);
      }
    }
    _trimContinuousPageSurfaces();
  }, {
    root: scrollContainer,
    rootMargin: '200px 0px'
  });

  // Observe all page wrappers
  continuousContainer.querySelectorAll('.page-wrapper').forEach(wrapper => {
    _continuousObserver.observe(wrapper);
  });

  // Belt-and-suspenders: de IntersectionObserver mist soms zijn eerste fire als
  // de container-layout/zichtbaarheid nog niet is uitgekristalliseerd — precies
  // wat gebeurt vlak na een sessie-herstel/paginaherlaad of een moduswissel.
  // Gevolg: de bovenste pagina('s) blijven blanco tot je scrollt. Render daarom
  // expliciet wat er in beeld staat (dezelfde 200px-marge als de observer).
  // Veilig: pagina's die de observer al deed, worden overgeslagen via
  // _renderedPages. Twee pogingen (frame + korte timeout) dekken trage layout.
  const _renderVisibleContinuousNow = () => {
    if (!scrollContainer || getActiveDocument()?.pdfDoc !== pdfDoc) return;
    const contRect = scrollContainer.getBoundingClientRect();
    if (contRect.height === 0) return; // layout nog niet gezet
    continuousContainer.querySelectorAll('.page-wrapper').forEach(wrapper => {
      const pageNum = parseInt(wrapper.dataset.page, 10);
      if (!pageNum || _renderedPages.has(pageNum)) return;
      const r = wrapper.getBoundingClientRect();
      if (r.bottom >= contRect.top - 200 && r.top <= contRect.bottom + 200) {
        renderContinuousPage(pageNum);
      }
    });
  };
  requestAnimationFrame(_renderVisibleContinuousNow);
  setTimeout(_renderVisibleContinuousNow, 150);

  // Keep doc.currentPage in sync with free scrolling (status bar, thumbnails).
  _bindContinuousScrollSync();

  // Fire-and-forget: pre-render low-res previews in background for fast scroll
  // This runs without blocking — pages that scroll into view get full render via observer.
  // Facing toont maar één spread (geen scroll), dus geen zin om alle pagina's te primen.
  // PDF.js draws each preview on the main thread; a CAD sheet costs tens to
  // hundreds of milliseconds even at half scale. Pages 1..200 in order kept
  // the input busy long after the view opened, mostly for pages nobody
  // scrolls to. The nearest pages come first, the main thread gets a turn
  // after every page, and the run stops when the document or view changes.
  if (pdfDoc.numPages > 1 && !doc.facingSpread) {
    const PREVIEW_PAGES = 24;
    const start = Math.min(Math.max(1, doc.currentPage || 1), pdfDoc.numPages);
    const pages = [];
    for (let d = 0; pages.length < PREVIEW_PAGES && (start - d >= 1 || start + d <= pdfDoc.numPages); d++) {
      if (start + d <= pdfDoc.numPages) pages.push(start + d);
      if (d > 0 && start - d >= 1) pages.push(start - d);
    }
    (async () => {
      for (const p of pages.slice(0, PREVIEW_PAGES)) {
        if (getActiveDocument() !== doc || doc.pdfDoc !== pdfDoc || doc.viewMode !== 'continuous') return;
        if (_lowResCache.has(_lowResKey(p))) continue;
        try {
          await renderLowResPreview(pdfDoc, p, 0, 0);
        } catch {}
        await new Promise(r => setTimeout(r, 0));
      }
    })();
  }
}

// Setup pointer events for continuous mode pages
function setupContinuousPageEvents(canvas, pageNum) {
  // Store pageNum in dataset for the dispatcher's resolvePointerCoords
  canvas.dataset.page = pageNum;
  // Bind op de paginacontainer, niet op het annotatiecanvas: dat canvas is
  // een viewport-uitsnede en dekt de pagina niet volledig — buiten de
  // uitsnede zou een klik anders in een dode zone vallen. Het filter
  // repliceert het oude bereik: lagen die bewust bóven het canvas staan
  // (tekst/formulier/link) houden hun eigen gedrag, en pointer-events:none
  // op het canvas (tekst-toegang van het select-/editText-gereedschap)
  // schakelt de afhandeling uit zoals voorheen.
  const cc = canvas.closest('.canvas-container-cont') || canvas;
  cc.dataset.page = pageNum;
  const magAfhandelen = (e) => {
    if ((canvas.style.pointerEvents || '') === 'none') return false;
    const t = e.target;
    if (t === cc || t === canvas) return true;
    return !!(t.classList && (t.classList.contains('pdf-canvas') || t.classList.contains('annotation-canvas')));
  };
  // Import event handlers dynamically to avoid circular dependencies
  import('../tools/tool-dispatcher.js').then(({ handlePointerDown, handlePointerMove, handlePointerUp, handleDblClick }) => {
    const wrap = (fn) => (e) => { if (magAfhandelen(e)) fn(e); };
    cc.addEventListener('pointerdown', wrap(handlePointerDown));
    cc.addEventListener('pointermove', wrap(handlePointerMove));
    cc.addEventListener('pointerup', wrap(handlePointerUp));
    cc.addEventListener('dblclick', wrap(handleDblClick));
  });
}

// ─── Spread-pariteit (facing/boek) ──────────────────────────────────────────
// Book-conventie: pagina 1 staat alleen (rechts), daarna de paren 2-3, 4-5, …
// De "anker"-pagina van een spread is de LINKERpagina van het paar (even), of
// pagina 1 voor de eerste spread. doc.currentPage bewaart in facing-modus altijd
// dit anker, zodat vorige/volgende deterministisch per spread springen.
function _spreadAnchor(p) {
  if (p <= 1) return 1;
  return (p % 2 === 0) ? p : p - 1; // even = linkerpagina; oneven = rechter → anker links
}
function _spreadPagesFor(anchor, numPages) {
  if (anchor <= 1) return [1];
  const pages = [anchor];
  if (anchor + 1 <= numPages) pages.push(anchor + 1);
  return pages;
}
function _nextSpreadAnchor(anchor, numPages) {
  if (anchor <= 1) return numPages >= 2 ? 2 : 1;
  return anchor + 2 <= numPages ? anchor + 2 : anchor;
}
function _prevSpreadAnchor(anchor) {
  return anchor <= 2 ? 1 : anchor - 2;
}

// Switch view mode
export async function setViewMode(mode) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;

  // 'book' (boekweergave, issue #201) is a LAYOUT VARIANT of continuous:
  // spreads of two pages side by side with page 1 alone on the right, like
  // a real book. Internally doc.viewMode stays 'continuous' so every
  // existing `viewMode === 'continuous'` branch (redraw dispatch, hit
  // testing, search, clipboard, tools, zoom) keeps working unchanged;
  // the doc.bookSpread flag drives the grid layout in renderContinuous().
  //
  // 'facing' (issue #164, 4e modus) toont ÉÉN spread van twee pagina's naast
  // elkaar tegelijk, NIET-doorlopend: vorige/volgende bladert per spread. Ook
  // dit is intern doc.viewMode='continuous' (zelfde per-pagina-canvas/tekstlaag/
  // tool/hit-test-infrastructuur), maar met doc.facingSpread=true i.p.v.
  // bookSpread — zo licht de doorlopend/boek-knop niet op en bouwt
  // renderContinuous alleen de huidige spread i.p.v. alle pagina's.
  if (mode === 'book') {
    doc.viewMode = 'continuous';
    doc.bookSpread = true;
    doc.facingSpread = false;
  } else if (mode === 'facing') {
    doc.viewMode = 'continuous';
    doc.bookSpread = false;
    doc.facingSpread = true;
    // Normaliseer naar het spread-anker zodat navigatie consistent per spread
    // springt (currentPage = linkerpagina van het huidige paar, of 1).
    doc.currentPage = _spreadAnchor(doc.currentPage);
  } else {
    doc.viewMode = mode;
    doc.facingSpread = false;
    if (mode === 'continuous') doc.bookSpread = false;
  }
  const singleContainer = document.getElementById('canvas-container');
  const continuousContainer = document.getElementById('continuous-container');
  const pdfContainer = document.getElementById('pdf-container');

  if (doc.viewMode === 'single') {
    _nativeContDetail.reset();
    singleContainer.style.display = 'inline-block';
    continuousContainer.style.display = 'none';
    _setContinuousLayoutActive(false);
    await renderPage(doc.currentPage);
  } else {
    singleContainer.style.display = 'none';
    continuousContainer.style.display = (doc.bookSpread || doc.facingSpread) ? 'grid' : 'flex';
    _setContinuousLayoutActive(true);
    // CRUCIAAL: single-/rasterweergave zet #pdf-container inline op
    // `overflow:hidden` (het viewport-singleton bezit dan de pan/zoom).
    // Doorlopende/boekweergave scrollt juist NATIEF via deze container
    // (scrollTop/scrollIntoView/_continuousRezoom). Zonder deze reset blijft
    // de inline `hidden` staan na één single-render en kan de gebruiker niet
    // meer scrollen — alleen de eerste pagina('s) zijn zichtbaar. Terug naar
    // '' laat de CSS-regel (.main-view > #pdf-container.visible { overflow:auto })
    // het weer overnemen.
    if (pdfContainer) pdfContainer.style.overflow = '';
    await renderContinuous();
    notePagePainted(doc);
    // Stay on the page the user was reading — the rebuild starts at page 1.
    const wrapper = continuousContainer.querySelector(`.page-wrapper[data-page="${doc.currentPage}"]`);
    if (wrapper) wrapper.scrollIntoView({ block: 'start' });
  }
}

// ─── Adjacent-page prefetch (idle-gated) ────────────────────────────────────
// The original prefetchAdjacentPages was removed (see the renderPage() note)
// because it ran unconditionally and starved visible-thumbnail generation —
// Rust backend contention that froze the app on large files. This version only
// fires after a navigation settles AND the pipeline is genuinely idle, and it
// aborts the instant the user navigates again. It primes the NEXT page's vector
// draw-commands into the same cache renderPage() reads (vr.hasCachedCommands),
// so sequential paging becomes a cache hit instead of a cold Rust extract.
let _prefetchTimer = null;
const PREFETCH_DELAY_MS = 600;       // settle window after a navigation
const PREFETCH_RETRY_MS = 400;       // re-poll cadence while waiting for idle
const PREFETCH_MAX_WAIT_MS = 4000;   // give up after this — never busy-loop

export function schedulePrefetch(centerPage) {
  if (window.__aecVectorPath !== true) return;
  if (_prefetchTimer) clearTimeout(_prefetchTimer);
  _prefetchTimer = setTimeout(() => { _prefetchTimer = null; _runPrefetch(centerPage, 0); }, PREFETCH_DELAY_MS);
}

// The active doc IFF the user is still parked on `centerPage` (else navigation
// moved on and this prefetch is stale).
function _prefetchDocIfStill(centerPage) {
  const doc = getActiveDocument();
  return doc && doc.pdfDoc && doc.currentPage === centerPage ? doc : null;
}

async function _runPrefetch(centerPage, waited) {
  const doc = _prefetchDocIfStill(centerPage);
  if (!doc) return; // user navigated — the new nav scheduled its own prefetch
  // Don't compete with a foreground render or with visible-thumbnail work.
  // Re-poll for a bounded window (timer-based, never a busy loop), then give up.
  if ((window.__pdfRenderInFlight || 0) > 0 || !isThumbnailPipelineIdle()) {
    if (waited >= PREFETCH_MAX_WAIT_MS) return;
    _prefetchTimer = setTimeout(
      () => { _prefetchTimer = null; _runPrefetch(centerPage, waited + PREFETCH_RETRY_MS); },
      PREFETCH_RETRY_MS,
    );
    return;
  }
  // Forward first (normal reading direction), then backward.
  const targets = [];
  if (centerPage + 1 <= doc.pdfDoc.numPages) targets.push(centerPage + 1);
  if (centerPage - 1 >= 1) targets.push(centerPage - 1);
  for (const pn of targets) {
    if (!_prefetchDocIfStill(centerPage)) return; // user moved — stop starting new IPC
    if (!isThumbnailPipelineIdle()) return;       // visible thumbnails resumed — yield
    try { await _prefetchOnePage(doc, pn, centerPage); }
    catch { /* best-effort: a failed prefetch just means the next nav renders cold */ }
  }
}

// Cache-only mirror of renderPage()'s cold vector path: analyze → extract →
// prepareImages. Never touches #pdf-canvas or the viewport singleton.
async function _prefetchOnePage(doc, pageNum, centerPage) {
  if (!isTauri() || !doc.filePath) return;
  // The normal viewer uses PDFium. Do not extract a second vector scene that
  // it cannot display; extraction can hold the native IPC lane for seconds.
  if (window.__aecVectorPath !== true) return;
  if (state.renderEngineOverride != null) return; // user forced a raster engine
  const rotation = getPageRotation(pageNum);
  const vr = await import('./vector-renderer.js');
  if (vr.hasCachedCommands(doc.filePath, pageNum, rotation)) return; // already primed
  const ptcMod = await import('./page-type-cache.js');
  let pageType = ptcMod.getCachedPageType(doc.filePath, pageNum - 1);
  if (!pageType) {
    pageType = await invoke('analyze_page_type', { path: doc.filePath, pageIndex: pageNum - 1 });
    ptcMod.cachePageType(doc.filePath, pageNum - 1, pageType);
  }
  if (pageType !== 'vector') return; // raster pages aren't command-cached
  if (!_prefetchDocIfStill(centerPage)) return;
  const cmdData = await invoke('extract_draw_commands', { path: doc.filePath, pageIndex: pageNum - 1, rotation });
  const cmdBytes = cmdData instanceof Uint8Array ? cmdData : new Uint8Array(cmdData);
  vr.cacheCommands(doc.filePath, pageNum, cmdBytes, rotation);
  if (!_prefetchDocIfStill(centerPage)) return;
  await vr.prepareImages(doc.filePath, pageNum, rotation);
  console.log(`[prefetch] primed page ${pageNum}`);
}

// Go to specific page.
// `options.skipScroll` laat het scrollen aan de aanroeper over. Een hyperlink
// met een /XYZ- of /FitH-bestemming wil naar een positie MIDDEN op de pagina;
// de standaard scrollIntoView({behavior:'smooth'}) hieronder loopt door nadat
// deze functie is teruggekeerd en zou die positie weer overschrijven.
//
// Every page change is a view for Previous/Next View (core/view-history.js);
// `options.skipHistory` leaves it out of the history.
export async function goToPage(pageNum, options = {}) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  const target = Math.min(Math.max(pageNum, 1), doc.pdfDoc.numPages);
  const track = !options.skipHistory && target !== doc.currentPage;
  if (track) noteViewBefore(doc);
  try {
    await _goToPageImpl(pageNum, options);
  } finally {
    if (track) noteViewAfter(doc, 'page');
  }
}

async function _goToPageImpl(pageNum, options) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;

  if (pageNum < 1) pageNum = 1;
  if (pageNum > doc.pdfDoc.numPages) pageNum = doc.pdfDoc.numPages;

  // Facing-modus (issue #164): niet-doorlopend, navigeert per SPREAD van twee
  // pagina's. Alle bestaande navigatie (statusbalk, ribbon, toetsen, thumbnails,
  // links) loopt via goToPage(currentPage ± 1) / goToPage(n); hier vertalen we
  // die naar spread-stappen zodat élke aanroeper vanzelf per spread bladert.
  if (doc.facingSpread) {
    const numPages = doc.pdfDoc.numPages;
    const curAnchor = _spreadAnchor(doc.currentPage);
    let targetAnchor = _spreadAnchor(pageNum);
    // Een vorige/volgende-knop levert currentPage ± 1: dat landt op de zíjpagina
    // van de huidige spread (zelfde anker). Dat interpreteren we als "spring een
    // hele spread in die richting".
    if (targetAnchor === curAnchor && pageNum !== curAnchor) {
      targetAnchor = pageNum > curAnchor
        ? _nextSpreadAnchor(curAnchor, numPages)
        : _prevSpreadAnchor(curAnchor);
    }
    doc.currentPage = targetAnchor;
    hideProperties();
    await renderContinuous();
    updateActiveThumbnail();
    updateAllStatus();
    return;
  }

  if (doc) doc.currentPage = pageNum;
  hideProperties();

  if (doc?.viewMode === 'single') {
    // Instant feedback: blit the page's cached thumbnail as a placeholder over
    // the canvas so the switch feels immediate even while the (possibly cold)
    // render runs. Hidden one frame after renderPage() resolves, so the crisp
    // page has painted underneath. No-op if the thumbnail isn't cached yet.
    const _phGen = showPagePlaceholder(pageNum);
    try {
      await renderPage(pageNum);
    } finally {
      // Keep the placeholder up until the real page content has painted (raster
      // bitmaps fill asynchronously after renderPage resolves) — avoids a blank
      // flash between hiding the thumbnail and the bitmap landing.
      hidePagePlaceholderWhenReady(_phGen);
    }
    const pdfContainer = document.getElementById('pdf-container');
    if (pdfContainer && !options.skipScroll) {
      pdfContainer.scrollTop = 0;
    }
    // Prime the neighbouring pages while the backend is idle so the next
    // sequential nav is a cache hit (skips the cold Rust extract).
    schedulePrefetch(pageNum);
  } else {
    // Scroll to page in continuous mode
    const pageWrapper = document.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
    if (pageWrapper && !options.skipScroll) {
      // Een lopende wieluitloop zou deze vloeiende sprong afbreken (#522).
      stopAlleWielScrollers();
      pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Update active thumbnail in left panel
  updateActiveThumbnail();
}

// Zoom controls.
//
// In vector viewport mode (the modern path) the truth is `viewport.zoom`,
// not `doc.scale` — `_render()` overwrites `doc.scale = viewport.zoom`
// every frame, so any function that mutates `doc.scale` and then re-renders
// via the legacy PDF.js path will have its change immediately stomped.
// We must therefore mutate the viewport directly when it's active, and
// only fall back to the legacy `doc.scale` path otherwise.
//
// Each explicit zoom change (buttons, field, fit, actual size) is a view for
// Previous/Next View; wheel and pinch zoom are not recorded.
async function _trackZoom(change) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return change();
  noteViewBefore(doc);
  try {
    return await change();
  } finally {
    noteViewAfter(doc, 'zoom');
  }
}

export function zoomIn() { return _trackZoom(_zoomIn); }
export function zoomOut() { return _trackZoom(_zoomOut); }
export function setZoom(newScale) { return _trackZoom(() => _setZoom(newScale)); }
export function fitWidth() { return _trackZoom(_fitWidth); }
export function fitPage() { return _trackZoom(_fitPage); }
export function actualSize() { return _trackZoom(_actualSize); }

// Single page without the vector viewport (browser build): show the new zoom
// at once by stretching what is on screen around the middle of the view, then
// render sharp and keep that point in the middle (zoom-rek.js). Without this a
// zoom button, Ctrl+=/-, a typed zoom or Fit showed nothing until the render
// finished (about 1.4 s on a heavy sheet) and then jumped.
//
// Quick repeated zooms (Ctrl+= held or pressed twice) during a render only
// stretch further and remember the latest zoom; the page point from the first
// press stays in the middle, and renders run one after another until the
// latest zoom is drawn. Without that the renders overlapped and the page
// jumped about 50 px when the second one landed.
let _lzPunt = null;
let _lzBezig = null;
let _lzNogEens = false;

async function _legacyZoomTo(doc, newScale) {
  const old = doc.scale || 1.5;
  if (!(newScale > 0) || newScale === old) {
    if (_lzBezig) return _lzBezig;
    doc.scale = newScale;
    await renderPage(doc.currentPage);
    return;
  }
  const { rekHuidigBeeld, paginaPuntOnder, houdPuntVast } = await import('./zoom-rek.js');
  if (!_lzPunt) _lzPunt = paginaPuntOnder(null, old);
  doc.scale = newScale;
  rekHuidigBeeld(newScale / old);
  houdPuntVast(_lzPunt, newScale);
  if (_lzBezig) { _lzNogEens = true; return _lzBezig; }
  _lzBezig = (async () => {
    try {
      do {
        _lzNogEens = false;
        const getekend = doc.scale;
        await renderPage(doc.currentPage);
        // Zoomed further while this render ran: stretch its result to the
        // latest zoom before anything is painted, then draw that one too.
        if (doc.scale !== getekend) rekHuidigBeeld(doc.scale / getekend);
        houdPuntVast(_lzPunt, doc.scale);
      } while (_lzNogEens);
    } finally {
      _lzBezig = null;
      _lzPunt = null;
    }
  })();
  return _lzBezig;
}

async function _zoomIn() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;
  const vp = window.__pdfViewport;
  // Only delegate to vector viewport if the ACTIVE doc actually uses it.
  // Blank docs (filePath===null) are rendered via PDF.js / legacy path
  // — vp.active may still be true from a previously-opened PDF, but
  // zoomStepAtCenter would mutate that stale page's zoom, not the blank
  // doc's doc.scale → button appears dead from the user's perspective.
  if (vp && vp.active && doc.filePath) {
    const m = await import('./pdf-viewport.js');
    m.zoomStepAtCenter(+1);
    return;
  }
  if (doc.viewMode === 'continuous') {
    await continuousZoomStep(+1);
    return;
  }
  await _legacyZoomTo(doc, doc.scale + 0.25);
}

async function _zoomOut() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;
  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    const m = await import('./pdf-viewport.js');
    m.zoomStepAtCenter(-1);
    return;
  }
  if (doc.viewMode === 'continuous') {
    await continuousZoomStep(-1);
    return;
  }
  // Allow zooming out to 0.05 (5 %) for huge blank pages — A0 (2384×3370 pt)
  // at 0.05 = 119×169 px which fits any reasonable viewport with margin.
  // Floor of 0.1 was visible to the user as "kan niet zo ver uitzoomen om
  // het hele tekeningkader te zien" on A2/A1/A0 blank docs that bypass
  // the vector viewport (filePath===null skips the viewport singleton).
  if (doc.scale > 0.05) {
    let nieuw;
    if (doc.scale <= 0.2) nieuw = Math.max(0.05, doc.scale - 0.025);
    else if (doc.scale <= 0.5) nieuw = Math.max(0.05, doc.scale - 0.1);
    else nieuw = doc.scale - 0.25;
    await _legacyZoomTo(doc, nieuw);
  }
}

async function _setZoom(newScale) {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;
  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    // Set absolute zoom anchored at the canvas center (CSS pixels — the
    // backing store is dpr-scaled and would mis-centre on 125%/150%).
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (pdfCanvas) {
      const m = await import('./pdf-viewport.js');
      const dpr = window.devicePixelRatio || 1;
      m.setZoomAtPoint(pdfCanvas.width / dpr / 2, pdfCanvas.height / dpr / 2, newScale);
    }
    return;
  }
  if (doc.viewMode === 'continuous') {
    const _old = doc.scale;
    doc.scale = newScale;
    await _continuousRezoom(_old);
    return;
  }
  await _legacyZoomTo(doc, newScale);
}

// Helper: pick the right (pageW, pageH, canvasW, canvasH) tuple for the
// current rendering mode and return them. Vector viewport reads from the
// singleton; legacy mode reads PDF.js viewport + #pdf-container.
//
// Returns null if the rendering mode can't compute fit yet (no viewport or
// no page loaded).
async function _getFitInputs() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return null;

  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (!pdfCanvas) return null;
    // CSS pixels, NOT the dpr-scaled backing store: viewport zoom/offset are
    // CSS-based, so fitting against canvas.width/height makes every fit dpr×
    // too large (page sticks out of view on 125%/150% Windows scaling —
    // most visible on tall A1/A0 sheets).
    const dpr = window.devicePixelRatio || 1;
    return {
      mode: 'vector',
      pageW: vp.pageW,
      pageH: vp.pageH,
      canvasW: pdfCanvas.width / dpr,
      canvasH: pdfCanvas.height / dpr,
      pdfCanvas,
    };
  }

  // Legacy mode — read dimensions from PDF.js viewport + container.
  const page = await doc.pdfDoc.getPage(doc.currentPage);
  // Zoals de pagina op het scherm ligt: met de weergaverotatie (#200).
  const extraRot = beeldRotatie(doc.currentPage);
  const opts = { scale: 1 };
  if (extraRot) opts.rotation = (page.rotate + extraRot) % 360;
  const pageViewport = page.getViewport(opts);
  const container = document.getElementById('pdf-container');
  if (!container) return null;
  const fit = {
    mode: 'legacy',
    pageW: pageViewport.width,
    pageH: pageViewport.height,
    canvasW: container.clientWidth,
    canvasH: container.clientHeight,
    doc,
  };
  // Doorlopende weergave (issue #336): alle pagina's delen één schaal, dus
  // fit-breedte moet op de BREEDSTE pagina van het document passen — niet op
  // de huidige. Anders bepaalt een smallere (bv. eerste) pagina de zoom en
  // valt een bredere pagina deels buiten beeld.
  if (doc.viewMode === 'continuous') {
    fit.maxPageW = await _maxContinuousPageWidthPt(doc);
  }
  return fit;
}

// Breedste effectieve paginabreedte (PDF-punten, ná intrinsieke rotatie +
// eventuele gebruikersrotatie) over alle pagina's. Gebruikt per pagina de door
// renderContinuous() gevulde doc.pageDims-cache en valt voor ontbrekende
// pagina's terug op getPage().
async function _maxContinuousPageWidthPt(doc) {
  let maxW = 0;
  for (let p = 1; p <= doc.pdfDoc.numPages; p++) {
    const dims = doc.pageDims?.[p];
    let wPt, hPt, baseRot;
    if (dims) {
      wPt = dims.widthPt;
      hPt = dims.heightPt;
      baseRot = dims.rotation || 0;
    } else {
      const page = await doc.pdfDoc.getPage(p);
      const [x0, y0, x1, y1] = page.view;
      wPt = x1 - x0;
      hPt = y1 - y0;
      baseRot = page.rotate || 0;
    }
    // Zoals de pagina op het scherm ligt: met de weergaverotatie (#200).
    const totalRot = normaliseerRotatie(baseRot + beeldRotatie(p));
    maxW = Math.max(maxW, isKwartslag(totalRot) ? hPt : wPt);
  }
  return maxW;
}

// Apply a computed zoom value, dispatching to the right renderer for the
// active mode. Centralized so fitWidth/fitPage/setZoom all share the same
// "now actually use this zoom value" code path.
async function _applyZoom(fitInputs, newZoom) {
  if (fitInputs.mode === 'vector') {
    const m = await import('./pdf-viewport.js');
    m.setZoomAtPoint(fitInputs.canvasW / 2, fitInputs.canvasH / 2, newZoom);
    return;
  }
  // Legacy
  const doc = fitInputs.doc;
  if (doc.viewMode === 'continuous') {
    const _old = doc.scale;
    doc.scale = newZoom;
    await _continuousRezoom(_old);
    return;
  }
  await _legacyZoomTo(doc, newZoom);
}

async function _fitWidth() {
  const fit = await _getFitInputs();
  if (!fit) return;
  const m = await import('./pdf-viewport.js');
  if (fit.mode === 'vector') {
    // Zelfde centreringscontract als fitPage(): de oude route zette alleen de
    // zoom en behield de pan-offset, waardoor de pagina na navigatie tussen
    // afwijkende formaten deels buiten beeld bleef staan.
    m.fitToViewport('width');
    return;
  }
  // Doorlopende weergave: fit op de breedste pagina (zie _getFitInputs,
  // issue #336) zodat elke pagina volledig binnen de breedte past; smallere
  // pagina's worden door de flex-layout gecentreerd.
  const fitW = fit.maxPageW || fit.pageW;
  const newZoom = m.computeFitZoom('width', fitW, fit.pageH, fit.canvasW, fit.canvasH, 0);
  await _applyZoom(fit, newZoom);
}

async function _fitPage() {
  const fit = await _getFitInputs();
  if (!fit) return;
  const m = await import('./pdf-viewport.js');
  if (fit.mode === 'vector') {
    // Canonieke fit + centrering. De vorige route (setZoomAtPoint verankerd op
    // het canvas-midden) zette wel de juiste zoom maar behield de bestaande
    // pan-offset. Na paginanavigatie binnen een document met afwijkende
    // paginaformaten (A4 -> A0) stond de pagina daardoor deels of geheel
    // buiten beeld — terwijl clampAndCenter() bewust een no-op is met als
    // contract: "de gebruiker her-centreert met Fit Page". fitToViewport()
    // centreert expliciet en gebruikt bovendien de post-rotatie-afmetingen.
    m.fitToViewport();
    return;
  }
  const newZoom = m.computeFitZoom('page', fit.pageW, fit.pageH, fit.canvasW, fit.canvasH, 0);
  await _applyZoom(fit, newZoom);
}

async function _actualSize() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;

  // Vector viewport mode: 100% = 1.0 zoom, anchored at canvas center.
  // This makes 1 PDF point = 1 CSS pixel, the standard "Actual Size"
  // interpretation.
  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (!pdfCanvas) return;
    const m = await import('./pdf-viewport.js');
    // Anchor in CSS pixels (same unit as zoomStepAtCenter) — the backing
    // store is dpr-scaled and would mis-centre on 125%/150% displays.
    const dpr = window.devicePixelRatio || 1;
    m.setZoomAtPoint(pdfCanvas.width / dpr / 2, pdfCanvas.height / dpr / 2, 1.0);
    return;
  }

  if (doc.viewMode === 'continuous' && doc.pdfDoc) {
    const _old = doc.scale;
    doc.scale = 1;
    await _continuousRezoom(_old);
    return;
  }
  if (doc.pdfDoc) await _legacyZoomTo(doc, 1);
  else doc.scale = 1;
}

// Rotate the current page by a delta (±90)
// ─── Annotation coordinate transforms for page rotation ─────────────────────

function rotatePoint(px, py, normDelta, oldW, oldH) {
  switch (normDelta) {
    case 90:  return { x: oldH - py, y: px };
    case 270: return { x: py, y: oldW - px };
    case 180: return { x: oldW - px, y: oldH - py };
    default:  return { x: px, y: py };
  }
}

function rotateRect(x, y, w, h, normDelta, oldW, oldH) {
  switch (normDelta) {
    case 90:  return { x: oldH - y - h, y: x, width: h, height: w };
    case 270: return { x: y, y: oldW - x - w, width: h, height: w };
    case 180: return { x: oldW - x - w, y: oldH - y - h, width: w, height: h };
    default:  return { x, y, width: w, height: h };
  }
}

function recalcBoundsFromPoints(ann, pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  ann.x = minX; ann.y = minY;
  ann.width = maxX - minX; ann.height = maxY - minY;
}

function rotateAnnotation(ann, normDelta, oldW, oldH) {
  if (normDelta === 0) return;
  let boundsHandled = false;

  // Leesrichting van tekstgebonden annotaties (markeringen, invoegteken,
  // #508) draait mee: verticale tekst krijgt zo een doorhaling langs de tekst
  // en de juiste quadvolgorde bij het opslaan.
  if (isTextAnchored(ann)) ann.textDir = rotateTextDir(ann.textDir, normDelta);

  // Path-based (draw/freehand)
  if (ann.path && ann.path.length > 0) {
    ann.path = ann.path.map(p => rotatePoint(p.x, p.y, normDelta, oldW, oldH));
    recalcBoundsFromPoints(ann, ann.path);
    boundsHandled = true;
  }

  // Points-based (polygon, polyline, cloud, measureArea, measurePerimeter)
  if (ann.points && ann.points.length > 0) {
    ann.points = ann.points.map(p => rotatePoint(p.x, p.y, normDelta, oldW, oldH));
    recalcBoundsFromPoints(ann, ann.points);
    boundsHandled = true;
  }

  // Line endpoints (line, arrow, measureDistance)
  if (ann.startX != null && ann.startY != null && ann.endX != null && ann.endY != null) {
    const s = rotatePoint(ann.startX, ann.startY, normDelta, oldW, oldH);
    const e = rotatePoint(ann.endX, ann.endY, normDelta, oldW, oldH);
    ann.startX = s.x; ann.startY = s.y;
    ann.endX = e.x; ann.endY = e.y;
    ann.x = Math.min(s.x, e.x); ann.y = Math.min(s.y, e.y);
    ann.width = Math.abs(e.x - s.x); ann.height = Math.abs(e.y - s.y);
    boundsHandled = true;
  }

  // MeasureDistance leader lines
  if (ann.leaderStartX != null && ann.leaderStartY != null) {
    const ls = rotatePoint(ann.leaderStartX, ann.leaderStartY, normDelta, oldW, oldH);
    ann.leaderStartX = ls.x; ann.leaderStartY = ls.y;
  }
  if (ann.leaderEndX != null && ann.leaderEndY != null) {
    const le = rotatePoint(ann.leaderEndX, ann.leaderEndY, normDelta, oldW, oldH);
    ann.leaderEndX = le.x; ann.leaderEndY = le.y;
  }
  // MeasureDistance text offset is a VECTOR (relative to the line midpoint):
  // rotate it with the linear part of the page rotation only (no translation).
  if (ann.textOffsetX != null || ann.textOffsetY != null) {
    const tox = ann.textOffsetX || 0;
    const toy = ann.textOffsetY || 0;
    switch (normDelta) {
      case 90:  ann.textOffsetX = -toy; ann.textOffsetY = tox; break;
      case 270: ann.textOffsetX = toy;  ann.textOffsetY = -tox; break;
      case 180: ann.textOffsetX = -tox; ann.textOffsetY = -toy; break;
    }
  }

  // Callout arrow/knee/armOrigin points
  if (ann.arrowX != null && ann.arrowY != null) {
    const a = rotatePoint(ann.arrowX, ann.arrowY, normDelta, oldW, oldH);
    ann.arrowX = a.x; ann.arrowY = a.y;
  }
  if (ann.kneeX != null && ann.kneeY != null) {
    const k = rotatePoint(ann.kneeX, ann.kneeY, normDelta, oldW, oldH);
    ann.kneeX = k.x; ann.kneeY = k.y;
  }
  if (ann.armOriginX != null && ann.armOriginY != null) {
    const ao = rotatePoint(ann.armOriginX, ann.armOriginY, normDelta, oldW, oldH);
    ann.armOriginX = ao.x; ann.armOriginY = ao.y;
  }

  // Text markup rects (textHighlight, textStrikethrough, textUnderline)
  if (ann.rects && ann.rects.length > 0) {
    ann.rects = ann.rects.map(r => rotateRect(r.x, r.y, r.width, r.height, normDelta, oldW, oldH));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of ann.rects) {
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
    }
    ann.x = minX; ann.y = minY;
    ann.width = maxX - minX; ann.height = maxY - minY;
    boundsHandled = true;
  }

  // Visual-content annotations: rotate center, keep w/h, add rotation property
  const visualTypes = new Set(['text', 'textbox', 'callout', 'stamp', 'image', 'signature']);
  if (!boundsHandled && visualTypes.has(ann.type) && ann.x != null && ann.y != null && ann.width != null && ann.height != null) {
    const cx = ann.x + ann.width / 2;
    const cy = ann.y + ann.height / 2;
    const rc = rotatePoint(cx, cy, normDelta, oldW, oldH);
    ann.x = rc.x - ann.width / 2;
    ann.y = rc.y - ann.height / 2;
    ann.rotation = ((ann.rotation || 0) + normDelta) % 360;
    boundsHandled = true;
  }

  // Bounding box for rect-only annotations (box, circle, highlight, etc.)
  if (!boundsHandled && ann.x != null && ann.y != null) {
    if (ann.width != null && ann.height != null) {
      const nr = rotateRect(ann.x, ann.y, ann.width, ann.height, normDelta, oldW, oldH);
      ann.x = nr.x; ann.y = nr.y; ann.width = nr.width; ann.height = nr.height;
    } else {
      const p = rotatePoint(ann.x, ann.y, normDelta, oldW, oldH);
      ann.x = p.x; ann.y = p.y;
    }
  }
}

function rotateAnnotationsForPage(pageNum, normDelta, oldW, oldH) {
  const doc = getActiveDocument();
  if (!doc) return;
  const annotations = doc.annotations;
  if (!annotations || annotations.length === 0) return;
  for (const ann of annotations) {
    if (ann.page === pageNum) {
      rotateAnnotation(ann, normDelta, oldW, oldH);
    }
  }
}

// `tekenen: false` laat het opnieuw tekenen aan de aanroeper: pagina-draaien.js
// draait meerdere pagina's en tekent daarna één keer (#464).
export async function rotatePage(delta, targetPage, { tekenen = true } = {}) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  const pageNum = targetPage || doc.currentPage;
  const current = getPageRotation(pageNum);

  // Get old viewport dimensions (at current rotation) for annotation transform
  const page = await doc.pdfDoc.getPage(pageNum);
  const oldViewport = page.getViewport({ scale: 1, rotation: (page.rotate + current) % 360 });
  const normDelta = ((delta % 360) + 360) % 360;

  // Transform annotation coordinates to match new rotation
  rotateAnnotationsForPage(pageNum, normDelta, oldViewport.width, oldViewport.height);
  // The measure scales the PDF itself carries (/VP) live in the same display
  // space as the annotations: turn them along, or a dimension line would fall
  // outside every viewport (or into the neighbour's) until save + reopen (#400).
  if (doc.pdfViewports?.[pageNum]) {
    const { draaiViewports } = await import('./pdf-viewports.js');
    doc.pdfViewports[pageNum] = draaiViewports(doc.pdfViewports[pageNum], normDelta, oldViewport.width, oldViewport.height);
  }

  setPageRotation(pageNum, current + delta);

  // Mark document as modified
  if (doc) doc.modified = true;

  // Re-render
  if (tekenen) {
    if (doc?.viewMode === 'continuous') {
      await renderContinuous();
    } else {
      await renderPage(pageNum);
    }
  }

  // Update thumbnails
  const { invalidateThumbnail } = await import('../ui/panels/left-panel.js');
  invalidateThumbnail(pageNum);
}

// Doorlopende weergave opnieuw opbouwen in de stand van nu (na weergave
// draaien, #200) en op de pagina blijven die de gebruiker las: de opbouw
// begint anders weer bij pagina 1.
export async function tekenDoorlopendOpnieuw() {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc || doc.viewMode !== 'continuous') return;
  const pagina = doc.currentPage;
  await renderContinuous();
  if (doc.facingSpread) return;
  const wrapper = document.querySelector(`#continuous-container .page-wrapper[data-page="${pagina}"]`);
  if (wrapper) wrapper.scrollIntoView({ block: 'start' });
}

// Het beeld opnieuw opbouwen in de draaistand van nu: na het draaien van
// pagina's, en na ongedaan maken of opnieuw doen daarvan. Tekent de pagina die
// de gebruiker bekijkt, niet de laatst gedraaide.
export async function tekenNaPaginaRotatie() {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  if (doc.viewMode === 'continuous') {
    await renderContinuous();
  } else {
    await renderPage(doc.currentPage);
  }
}

// Clear the PDF view when no document is open
export function clearPdfView() {
  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;

  // Deactivate vector viewport so its RAF loop stops redrawing the last
  // viewed document on the now-empty canvas.
  if (window.__pdfViewport) window.__pdfViewport.active = false;

  // Clear single page mode canvases
  const pdfCtx = pdfCanvas.getContext('2d');
  pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  const annotationCtx = annotationCanvas.getContext('2d');
  annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);

  // Clear caches
  _lowResCache.clear();
  _continuousBuildGeneration++;
  _renderedPages.clear();
  _residentPages.clear();
  _continuousInRangePages.clear();
  _contPageRenderGen.clear();
  if (_continuousObserver) {
    _continuousObserver.disconnect();
    _continuousObserver = null;
  }
  _nativeContDetail.reset();

  // Clear continuous mode container
  const continuousContainer = document.getElementById('continuous-container');
  if (continuousContainer) {
    wisContDetailLagen();
    continuousContainer.innerHTML = '';
  }

  // Clear PDF vector snap cache
  clearPdfVectorCache();

  // Clear high-res page bitmap cache
  import('./page-bitmap-cache.js').then(m => m.clearAllBitmaps()).catch(() => {});

  // Clear element detection cache
  clearDetectionCache();

  // Clear text, link, and form layers
  clearSinglePageTextLayer();
  clearTextLayers();
  clearSinglePageLinkLayer();
  clearLinkLayers();
  clearSinglePageFormLayer();
  clearFormLayers();
  hideFormFieldsBar();
  hidePdfABar();

  // Show placeholder if no documents open
  const placeholder = document.getElementById('placeholder');
  const pdfContainer = document.getElementById('pdf-container');
  if (placeholder) placeholder.style.display = 'flex';
  if (pdfContainer) pdfContainer.classList.remove('visible');

  // Update status bar (derives from reactive state)
  updateAllStatus();
}

// ─── Self-test: call from DevTools console with window.__testRender() ──────
// Tests the full rendering pipeline and reports what engine is used.
if (typeof window !== 'undefined') {
  window.__testRender = async function(filePath) {
    const testPath = filePath || String.raw`C:\3BM\50_projecten\3_3BM_bouwtechniek\3059 Woonhuis Benedenkerkseweg 87 Stolwijk\20_post_IN\01 27-03-2026 beginstukken\begane grond do 3 constructie verwerkt_50.pdf`;
    console.log('=== Render Self-Test ===');
    console.log('Path:', testPath);
    console.log('isTauri():', isTauri());

    // Step 1: Test Rust render command directly
    if (isTauri()) {
      try {
        console.log('Testing invoke("render_pdf_page")...');
        const t0 = performance.now();
        const selection = nativeOcgSelectionForPath(testPath);
        const result = await invoke('render_pdf_page', { path: testPath, pageIndex: 0, scale: 1.5,
          ocgVisibility: selection.ocgVisibility });
        if (nativeOcgSelectionForPath(testPath).revision !== selection.revision) return;
        const elapsed = Math.round(performance.now() - t0);
        if (result && result.length > 8) {
          // Parse 8-byte header: width (u32 LE) + height (u32 LE)
          const hdr = new DataView(result.buffer, result.byteOffset, 8);
          const w = hdr.getUint32(0, true);
          const h = hdr.getUint32(4, true);
          const rgbaLen = result.length - 8;
          console.log(`✅ Rust render: ${w}x${h}, ${rgbaLen} bytes (${rgbaLen === w*h*4 ? 'size OK' : 'SIZE MISMATCH'}), ${elapsed}ms`);

          // Draw to canvas to verify
          const canvas = document.getElementById('pdf-canvas');
          if (canvas && w * h * 4 === rgbaLen) {
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = Math.floor(w / (window.devicePixelRatio || 1)) + 'px';
            canvas.style.height = Math.floor(h / (window.devicePixelRatio || 1)) + 'px';
            const rgba = result.slice(8);
            const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h);
            canvas.getContext('2d').putImageData(imgData, 0, 0);
            document.getElementById('placeholder')?.style.setProperty('display', 'none');
            document.getElementById('pdf-container')?.classList.add('visible');
            console.log('✅ Drawn to canvas');
          }
        } else {
          console.log('❌ Rust render returned empty or too small:', result?.length);
        }
      } catch (e) {
        console.log('❌ Rust render error:', e);
      }
    } else {
      console.log('⚠️ Not in Tauri — Rust render unavailable, PDF.js will be used');
    }

    // Step 2: Test via the full renderPage pipeline
    const doc = getActiveDocument();
    if (doc) {
      console.log('Active doc:', doc.filePath, 'page:', doc.currentPage, 'scale:', doc.scale);
      console.log('Calling renderPage()...');
      const t0 = performance.now();
      await renderPage(doc.currentPage || 1);
      console.log(`renderPage() total: ${Math.round(performance.now() - t0)}ms`);
    } else {
      console.log('No active document. Open a PDF first, then run __testRender() again.');
    }
    console.log('=== End Self-Test ===');
  };

  window.__testRustDirect = async function(filePath) {
    const testPath = filePath || String.raw`C:\3BM\50_projecten\3_3BM_bouwtechniek\3059 Woonhuis Benedenkerkseweg 87 Stolwijk\20_post_IN\01 27-03-2026 beginstukken\begane grond do 3 constructie verwerkt_50.pdf`;
    if (!isTauri()) { console.log('Not in Tauri'); return; }
    try {
      console.log('Invoking render_pdf_page directly...');
      const t0 = performance.now();
      const selection = nativeOcgSelectionForPath(testPath);
      const rgba = await invoke('render_pdf_page', { path: testPath, pageIndex: 0, scale: 1.5,
        ocgVisibility: selection.ocgVisibility });
      if (nativeOcgSelectionForPath(testPath).revision !== selection.revision) return;
      const elapsed = Math.round(performance.now() - t0);
      console.log(`Result: ${rgba?.length || 0} bytes in ${elapsed}ms`);
      if (rgba && rgba.length > 8) {
        // Parse 8-byte header: width (u32 LE) + height (u32 LE)
        const hdr = new DataView(rgba.buffer, rgba.byteOffset, 8);
        const w = hdr.getUint32(0, true);
        const h = hdr.getUint32(4, true);
        const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset + 8, rgba.length - 8);
        console.log(`Dimensions: ${w}x${h}, RGBA: ${pixels.length} bytes`);
        const canvas = document.getElementById('pdf-canvas');
        if (canvas && w * h * 4 === pixels.length) {
          canvas.width = w;
          canvas.height = h;
          canvas.style.width = (w / (window.devicePixelRatio || 1)) + 'px';
          canvas.style.height = (h / (window.devicePixelRatio || 1)) + 'px';
          const imgData = new ImageData(pixels, w, h);
          canvas.getContext('2d').putImageData(imgData, 0, 0);
          document.getElementById('placeholder')?.style.setProperty('display', 'none');
          document.getElementById('pdf-container')?.classList.add('visible');
          console.log(`Drawn to canvas: ${w}x${h}`);
        }
      }
    } catch (e) {
      console.log('❌ Error:', e);
    }
  };
}

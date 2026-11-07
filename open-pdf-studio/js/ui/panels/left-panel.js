import { state, getActiveDocument, getPageRotation } from '../../core/state.js';
import { nativeOcgHasGroups, nativeOcgPdfJsConfig, nativeOcgSelectionForDocument } from '../../pdf/native-ocg-selection.js';
import { drawAnnotation } from '../../annotations/rendering.js';
import { edition } from '../../editions/active.js';
import { scrollThumbnailToPage } from '../../solid/stores/panels/thumbnailStore.js';
import { updateAnnotationsList } from './annotations-list.js';
import { updateAttachmentsList } from './attachments.js';
import { updateSignaturesList } from './signatures.js';
import { updateLayersList } from './layers.js';
import { updateFormFieldsList } from './form-fields.js';
import { updateDestinationsList } from './destinations.js';
import { updateTagsList } from './tags.js';
import { updateLinksList } from './links.js';
import { updateBookmarksList } from './bookmarks.js';
import {
  showMessage,
  switchToLeftPanelTab, toggleLeftPanelCollapsed,
  leftPanelActiveTab as activeTab, setLeftPanelActiveTab as setActiveTab,
  setLeftPanelCollapsed as setCollapsed,
  isPanelShown,
  setThumbnailPageCount as setPageCount, setThumbnailActivePage as setActivePage,
  setThumbnailPlaceholderSize as setPlaceholderSize,
  setThumbnailImage, clearAllThumbnails, removeThumbnailImage,
  getThumbnailContainerRef as getContainerRef,
  thumbnailSelectedPages, selectThumbnailPage,
} from '../../bridge.js';
import {
  thumbnailResultKeepsQueue,
  createThumbnailCoordinator,
  raceThumbnailRender,
  partitionThumbnailInvalidations,
  THUMBNAIL_DEFER_MS,
  THUMBNAIL_RENDER_TIMEOUT_MS,
} from '../../pdf/thumbnail-schedule.js';

// Thumbnail scale (relative to actual page size). The thumbnail panel
// displays at ~152 px wide; rendering close to that 1:1 saves PDFium
// work without visible quality loss. 0.14 puts an A4 portrait at
// ~595*0.14 = 83 pt = ~111 px wide; landscape A0 at ~5156*0.14 = 722 pt
// → capped to targetW=140 by the JS-replay path.
const THUMBNAIL_SCALE = 0.14;

// Cache for thumbnail data per document: Map<docId, Map<pageNum, imageDataURL>>
const thumbnailCache = new Map();
let detachedVisibleRange = null;
let detachedThumbnailChanged = null;

/** The separate view subscribes only while its drawing window owns it. */
export function onDetachedThumbnailChange(handler) {
  detachedThumbnailChanged = handler;
}

function notifyDetachedThumbnailChange() {
  detachedThumbnailChanged?.();
}

/** Share only the active document's cached thumbnail with its view window. */
export function cachedThumbnailForDocument(docId, pageNum) {
  return thumbnailCache.get(docId)?.get(pageNum) || null;
}

/** Prioritize the bounded set of pages visible in the separate thumbnail window. */
export function setDetachedThumbnailPages(docId, pages) {
  const wanted = Array.isArray(pages)
    ? pages.filter((page) => Number.isSafeInteger(page) && page >= 1).slice(0, 48) : [];
  detachedVisibleRange = docId && wanted.length ? { docId, pages: new Set(wanted) } : null;
  const deferred = deferredThumbnailPages.get(docId);
  if (deferred && detachedVisibleRange) {
    const visible = [...deferred].filter((page) => detachedVisibleRange.pages.has(page));
    for (const page of visible) deferred.delete(page);
    if (!deferred.size) deferredThumbnailPages.delete(docId);
    if (visible.length) invalidateThumbnails(visible);
  }
  updateVisiblePriorities();
}

// Per-doc per-page generation counter. Bumped on invalidateThumbnail() so a
// stale render-completion (annotations changed mid-flight, rapid re-invalidate)
// can be discarded and not overwrite a newer cache entry. See bumpPageGen /
// pageGenMatches usage below.
const pageGeneration = new Map(); // Map<docId, Map<pageNum, int>>

function bumpPageGen(docId, pageNum) {
  let m = pageGeneration.get(docId);
  if (!m) { m = new Map(); pageGeneration.set(docId, m); }
  const g = (m.get(pageNum) || 0) + 1;
  m.set(pageNum, g);
  return g;
}
function getPageGen(docId, pageNum) {
  return pageGeneration.get(docId)?.get(pageNum) || 0;
}
function pageGenMatches(docId, pageNum, gen) {
  return getPageGen(docId, pageNum) === gen;
}

// Store pdfDoc references and state for each document
const documentState = new Map(); // { pdfDoc, numPages, nextPage, startPage }

// Visible thumbnails. The coordinator also remembers a row that is cooling
// down or still rendering, and a start that arrived mid-await.
const thumbnailQueue = createThumbnailCoordinator();
const priorityPages = thumbnailQueue.pages;
const visibleJobs = new Set();
const actualThumbnailRenders = new Set();
const MAX_VISIBLE_THUMBNAILS = 2;
let queuedDocId = null;

// Track the last scroll position to continue loading from there
let lastVisiblePage = 1;

// Per-document thumbnail scroll position: Map<docId, number>
const thumbnailScrollPositions = new Map();

// Scroll debounce timer
let scrollDebounceTimer = null;

// Track if scroll listener is attached
let scrollListenerAttached = false;

// Initialize left panel
export function initLeftPanel() {
  attachScrollListener();
}

// Attach scroll listener to the thumbnails container via store ref
function attachScrollListener() {
  if (scrollListenerAttached) return;
  const tc = getContainerRef();
  if (tc) {
    tc.addEventListener('scroll', handleThumbnailScroll);
    observeStripSize(tc);
    scrollListenerAttached = true;
  } else {
    // Retry until SolidJS sets the ref
    setTimeout(attachScrollListener, 100);
  }
}

// The rows on screen are measured when the document opens, often while the
// panel is still hidden: every row then measures 0 x 0 and none counts as
// visible. A large set paints only the rows on screen, so opening the
// Thumbnails panel afterwards showed spinners until the user scrolled. Measure
// again whenever the strip changes size: the panel opens, expands, or the
// window is resized.
let stripResizeObserver = null;
let observedStrip = null;
function observeStripSize(tc) {
  if (typeof ResizeObserver === 'undefined' || observedStrip === tc) return;
  stripResizeObserver ??= new ResizeObserver(() => handleThumbnailScroll());
  if (observedStrip) stripResizeObserver.unobserve(observedStrip);
  stripResizeObserver.observe(tc);
  observedStrip = tc;
}

// Handle scroll in thumbnails container - debounced
function handleThumbnailScroll() {
  if (scrollDebounceTimer) {
    clearTimeout(scrollDebounceTimer);
  }

  scrollDebounceTimer = setTimeout(() => {
    updateVisiblePriorities();
  }, 100);
}

// Find visible thumbnails and add them to priority queue
function updateVisiblePriorities() {
  const thumbnailsContainer = getContainerRef();
  const activeDoc = getActiveDocument();
  if (!activeDoc) return;

  const docCache = thumbnailCache.get(activeDoc.id);
  if (!docCache) return;

  const docState = documentState.get(activeDoc.id);

  // The original sidebar may be unmounted while its separate view still needs
  // pages. Its requested range can drive rendering without a DOM container.
  const containerRect = thumbnailsContainer?.getBoundingClientRect();
  const thumbnails = thumbnailsContainer?.querySelectorAll('.thumbnail-item') || [];

  priorityPages.clear();

  let firstVisiblePage = null;

  thumbnails.forEach(thumb => {
    const thumbRect = thumb.getBoundingClientRect();

    const isVisible = (
      thumbRect.top < containerRect.bottom &&
      thumbRect.bottom > containerRect.top
    );

    if (isVisible) {
      const pageNum = Number(thumb.dataset.page);
      if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > docState?.numPages) return;

      if (firstVisiblePage === null) {
        firstVisiblePage = pageNum;
      }

      if (!docCache.has(pageNum)) {
        priorityPages.add(pageNum);
      }
    }
  });

  if (detachedVisibleRange?.docId === activeDoc.id && docState) {
    for (const pageNum of detachedVisibleRange.pages) {
      if (pageNum <= docState.numPages && !docCache.has(pageNum)) priorityPages.add(pageNum);
    }
  }

  if (firstVisiblePage !== null && docState) {
    lastVisiblePage = firstVisiblePage;
    docState.nextPage = firstVisiblePage;
    docState.startPage = firstVisiblePage;
    docState.wrapped = false;
  }

  // A row that scrolled off screen must not keep a cooldown. A row that is
  // still on screen keeps its hold, so a scroll event cannot spin on it.
  thumbnailQueue.pruneHolds();

  if (priorityPages.size > 0) {
    startProcessor();
  }
}

// A classify chunk finished: rows that were waiting on a type can paint now.
export function refreshVisibleThumbnails() {
  thumbnailQueue.releaseTypeHolds();
  updateVisiblePriorities();
}

// Switch between tabs
export function switchLeftPanelTab(panelId) {
  switchToLeftPanelTab(panelId);
  refreshTabContent(panelId);
}

const REFRESHABLE_TABS = ['annotations', 'attachments', 'signatures', 'layers', 'form-fields', 'destinations', 'tags', 'links', 'bookmarks'];

// Refresh whichever tab is currently active (call after loading a new document)
// (the panel hosts can show a left, a right and a bottom panel at once).
export function refreshActiveTab() {
  const panelId = activeTab();
  if (panelId && panelId !== 'thumbnails') {
    refreshTabContent(panelId);
  }
  for (const tab of REFRESHABLE_TABS) {
    if (tab !== panelId && isPanelShown(tab)) refreshTabContent(tab);
  }
}

export function refreshAllTabs() {
  for (const tab of REFRESHABLE_TABS) {
    refreshTabContent(tab);
  }
}

// Rebuild one panel's list (the panel hosts call this when a tab comes up).
export function refreshLeftPanelTab(panelId) {
  refreshTabContent(panelId);
}

function refreshTabContent(panelId) {
  if (panelId === 'annotations') {
    updateAnnotationsList();
  } else if (panelId === 'attachments') {
    updateAttachmentsList();
  } else if (panelId === 'signatures') {
    updateSignaturesList();
  } else if (panelId === 'layers') {
    updateLayersList();
  } else if (panelId === 'form-fields') {
    updateFormFieldsList();
  } else if (panelId === 'destinations') {
    updateDestinationsList();
  } else if (panelId === 'tags') {
    updateTagsList();
  } else if (panelId === 'links') {
    updateLinksList();
  } else if (panelId === 'bookmarks') {
    updateBookmarksList();
  }
}

// Toggle panel collapse/expand
export function toggleLeftPanel() {
  toggleLeftPanelCollapsed();
}

// Document rows (not the visible strip) that must wait before another try.
const docNotBefore = new Map();
const docInFlight = new Set();
let deferRetryTimer = null;

function clearDeferRetry() {
  if (deferRetryTimer) {
    clearTimeout(deferRetryTimer);
    deferRetryTimer = null;
  }
}

function docKey(docId, pageNum) {
  return `${docId}:${pageNum}`;
}

function docCooling(docId, pageNum) {
  return (docNotBefore.get(docKey(docId, pageNum)) || 0) > Date.now();
}

function holdDocPage(docId, pageNum) {
  docNotBefore.set(docKey(docId, pageNum), Date.now() + THUMBNAIL_DEFER_MS);
}

function docHoldsPending() {
  const now = Date.now();
  for (const until of docNotBefore.values()) {
    if (until > now) return true;
  }
  return docInFlight.size > 0;
}

// Generate thumbnails for all pages (sets store signals and starts generation)
export async function generateThumbnails() {
  const activeDoc = getActiveDocument();
  if (!activeDoc || !activeDoc.pdfDoc) {
    return;
  }

  const pdfDoc = activeDoc.pdfDoc;
  const docId = activeDoc.id;
  const numPages = pdfDoc.numPages;
  if (queuedDocId !== docId) {
    thumbnailQueue.reset();
    queuedDocId = docId;
  }

  // Get first page dimensions for placeholder sizing
  let placeholderWidth = 150;
  let placeholderHeight = Math.round(150 * 1.414);
  try {
    const firstPage = await pdfDoc.getPage(1);
    const extraRot = getPageRotation(1);
    const thOpts = { scale: THUMBNAIL_SCALE };
    if (extraRot) thOpts.rotation = (firstPage.rotate + extraRot) % 360;
    const viewport = firstPage.getViewport(thOpts);
    // Every native file thumbnail path returns a 140px-wide image. Match
    // that width before any page finishes rendering so the virtual rows do
    // not collapse as their placeholders turn into images.
    placeholderWidth = activeDoc.filePath && window.__TAURI__
      ? 140 : Math.min(140, Math.round(viewport.width));
    placeholderHeight = Math.round(viewport.height * placeholderWidth / viewport.width);
  } catch (err) {
    console.warn('[Thumbnails] Could not get first page dimensions:', err);
  }

  // Initialize or update document state
  if (!documentState.has(docId)) {
    documentState.set(docId, {
      pdfDoc,
      // Keep a reference to the owning document so background thumbnail
      // renders resolve paths/annotations against THIS document, not whatever
      // happens to be active (see renderThumbnailToDataURL).
      doc: activeDoc,
      numPages,
      nextPage: 1,
      startPage: 1,
      wrapped: false
    });
  }

  // Initialize cache for this document if needed
  if (!thumbnailCache.has(docId)) {
    thumbnailCache.set(docId, new Map());
  }
  const docCache = thumbnailCache.get(docId);

  // Update Solid store signals - this triggers reactive rendering of ThumbnailItem components
  setPlaceholderSize({ width: placeholderWidth, height: placeholderHeight });
  setPageCount(numPages);

  // Clear old thumbnail data before populating from the new document's cache
  // (prevents stale images from the previous document showing through)
  clearAllThumbnails();
  setPageCount(numPages);

  // Populate store with any already-cached thumbnail data
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    if (docCache.has(pageNum)) {
      setThumbnailImage(pageNum, docCache.get(pageNum));
    }
  }

  // Mark current page as active and restore scroll position
  updateActiveThumbnail(true);

  // Ensure scroll listener is attached (Solid may have re-rendered the container)
  scrollListenerAttached = false;
  attachScrollListener();

  // Update priorities based on initially visible thumbnails
  setTimeout(updateVisiblePriorities, 50);

  // Start the processor if not running
  startProcessor();
}

// Pause/resume mechanism: when the user navigates pages, pause thumbnail
// rendering so Rust IPC calls for page rendering aren't blocked.
let _thumbnailsPaused = false;
let _thumbnailPauseTimer = null;

async function finishThumbnailPause() {
  let busy = false;
  try {
    const orch = await import('../../pdf/bitmap-orchestrator.js');
    busy = orch.isSheetRenderBusy?.() === true;
  } catch { busy = false; }
  // A sheet that finished during the import already resumed the strip.
  if (!_thumbnailsPaused) return;
  if (busy) {
    _thumbnailPauseTimer = setTimeout(() => { void finishThumbnailPause(); }, 500);
    return;
  }
  _thumbnailsPaused = false;
  _thumbnailPauseTimer = null;
  startProcessor();
}

export function pauseThumbnails() {
  _thumbnailsPaused = true;
  if (_thumbnailPauseTimer) clearTimeout(_thumbnailPauseTimer);
  // Auto-resume after a short window of no navigation. Was 3000ms — that
  // caused thumbnails to sit idle for ~3s after document open because
  // renderer.js calls pauseThumbnails() on the very first page render.
  // 500ms is enough to coalesce rapid page-up/page-down without making the
  // user wait several seconds for thumbnails on initial load. While the
  // open sheet is still painting, the timer waits instead of taking a worker.
  _thumbnailPauseTimer = setTimeout(() => { void finishThumbnailPause(); }, 500);
}

// Resume thumbnail rendering immediately. Called by the page renderer once
// its IPC-heavy work (extract_draw_commands / prepareImages) has finished,
// so thumbnails don't have to wait the full pause window on initial load.
export function resumeThumbnails() {
  if (!_thumbnailsPaused) return;
  if (_thumbnailPauseTimer) {
    clearTimeout(_thumbnailPauseTimer);
    _thumbnailPauseTimer = null;
  }
  _thumbnailsPaused = false;
  startProcessor();
}

// True when the thumbnail pipeline is quiet enough that a low-priority page
// prefetch won't contend with VISIBLE-thumbnail generation — the exact
// contention that got the old prefetchAdjacentPages removed. Safe to prefetch
// when: not paused for active navigation, AND no visible (priority) thumbnails
// are still pending. Background (off-screen) thumbnails are low priority and
// fine to yield to a prefetch.
export function isThumbnailPipelineIdle() {
  return !_thumbnailsPaused && priorityPages.size === 0;
}

function rememberThumbnail(docId, pageNum, gen, imageData) {
  if (!imageData?.dataURL || thumbnailResultKeepsQueue(imageData)) return false;
  if (!pageGenMatches(docId, pageNum, gen)) return false;
  const docCache = thumbnailCache.get(docId);
  if (!docCache) return false;
  docCache.set(pageNum, imageData);
  docNotBefore.delete(docKey(docId, pageNum));
  docInFlight.delete(docKey(docId, pageNum));
  const currentActiveDoc = getActiveDocument();
  if (currentActiveDoc && currentActiveDoc.id === docId) {
    thumbnailQueue.forget(pageNum);
    priorityPages.delete(pageNum);
    setThumbnailImage(pageNum, imageData);
    notifyDetachedThumbnailChange();
  }
  return true;
}

// One render, then the rest of the strip. A worker that never answers
// (the read timeout in worker_pool is 60s, and that worker keeps its
// request lock the whole time) used to freeze every later row, because
// this queue is one page at a time. The JS deadline lets the other
// visible rows paint. The late picture is still stored. The hung call
// is not started again until it settles — a second invoke would sit
// behind the same worker lock.
function renderThumbnailBounded(pdfDoc, pageNum, doc, docId, gen, lane) {
  const key = docKey(docId, pageNum);
  const work = renderThumbnailToDataURL(pdfDoc, pageNum, doc);
  actualThumbnailRenders.add(key);
  void Promise.resolve(work).then(
    () => actualThumbnailRenders.delete(key),
    () => actualThumbnailRenders.delete(key),
  );
  return raceThumbnailRender(
    work,
    THUMBNAIL_RENDER_TIMEOUT_MS,
    (late) => {
      if (lane === 'visible' && getActiveDocument()?.id === docId) thumbnailQueue.clearInFlight(pageNum);
      else docInFlight.delete(key);
      if (rememberThumbnail(docId, pageNum, gen, late)) return;
      if (lane === 'visible') {
        if (getActiveDocument()?.id !== docId) return;
        if (!priorityPages.has(pageNum)) return;
        thumbnailQueue.hold(pageNum, 'slow');
      } else {
        holdDocPage(docId, pageNum);
      }
      startProcessor();
    },
    () => {
      if (lane === 'visible') {
        if (getActiveDocument()?.id === docId) {
          thumbnailQueue.markInFlight(pageNum);
          priorityPages.add(pageNum);
        }
      } else {
        docInFlight.add(key);
      }
    },
  );
}

function scheduleStripRetry(delay) {
  if (deferRetryTimer) return;
  deferRetryTimer = setTimeout(() => {
    deferRetryTimer = null;
    if (_thumbnailsPaused) return;
    if (priorityPages.size === 0 && !docHoldsPending()) return;
    startProcessor();
  }, delay);
}

// A pass finished without scheduling the next tick. A start() that arrived
// while this pass was inside await must still run — that used to be ignored
// because processorRunning was already true, and the strip never woke up.
function endPass(kind, delay = THUMBNAIL_DEFER_MS) {
  const again = thumbnailQueue.finishPass();
  if (again === 'again' && !_thumbnailsPaused) {
    // The pass that just finished may have cooled a row whose type arrived
    // while it was awaiting. Drop those type holds so the kicked pass asks
    // again instead of waiting out the defer.
    thumbnailQueue.releaseTypeHolds();
    startProcessor();
    return;
  }
  if (kind === 'later' && !_thumbnailsPaused) scheduleStripRetry(delay);
}

// Start the thumbnail processor. The previous 250ms delay added a visible
// lag on small documents — once paused-state is honored, the very first
// thumbnail no longer competes with the active-page render, so a tiny
// yield (1 task tick) is enough to let the UI paint the placeholder first.
function startProcessor() {
  clearDeferRetry();
  if (!thumbnailQueue.requestRun()) return;
  setTimeout(processNextThumbnail, 0);
}

// Process the next thumbnail (prioritizes visible pages, then active document)
async function processNextThumbnail() {
  try {
    // If paused (user is navigating), wait. resumeThumbnails() starts again.
    if (_thumbnailsPaused) {
      endPass('stop');
      return;
    }

    const activeDoc = getActiveDocument();
    const activeDocId = activeDoc?.id;

    if (activeDocId && priorityPages.size > 0) {
      const outcome = await processPriorityThumbnail(activeDocId);
      if (_thumbnailsPaused) {
        endPass('stop');
        return;
      }
      if (outcome === 'continue') {
        setTimeout(processNextThumbnail, 0);
        return;
      }
      // Visible rows are still queued, but none of them may render on this
      // tick. Do not walk the rest of the file ahead of them.
      if (outcome === 'later') {
        endPass('later');
        return;
      }
    }

    // A large set paints the thumbnails on screen. Walking every sheet
    // renders hundreds of pages through PDFium while the file stays open.
    const visibleOnly = documentState.get(activeDocId)?.doc?._largeOpen === true;

    if (activeDocId && documentState.has(activeDocId) && !visibleOnly) {
      const processed = await processDocumentThumbnail(activeDocId);
      if (_thumbnailsPaused) {
        endPass('stop');
        return;
      }
      if (processed === true) {
        setTimeout(processNextThumbnail, 0);
        return;
      }
      if (processed === 'later') {
        endPass('later');
        return;
      }
    }

    for (const [docId, docState] of documentState) {
      if (visibleOnly || docId === activeDocId) continue;

      const processed = await processDocumentThumbnail(docId);
      if (_thumbnailsPaused) {
        endPass('stop');
        return;
      }
      if (processed === true) {
        setTimeout(processNextThumbnail, 0);
        return;
      }
      if (processed === 'later') {
        endPass('later');
        return;
      }
    }

    endPass('stop');
  } catch (err) {
    console.error('[Thumbnails] Processor error:', err);
    endPass('later', 100);
  }
}

// Process a priority (visible) thumbnail first.
// Returns 'continue' (run the next row now), 'later' (rows are queued but
// cooling or still rendering — wait, do not spin), or 'stop'.
async function processPriorityThumbnail(docId) {
  const docState = documentState.get(docId);
  const docCache = thumbnailCache.get(docId);

  if (!docState || !docCache || priorityPages.size === 0) {
    return 'stop';
  }
  if ([...visibleJobs].filter((key) => key.startsWith(`${docId}:`)).length >= MAX_VISIBLE_THUMBNAILS) return 'later';

  const { pdfDoc } = docState;

  const step = thumbnailQueue.take({
    isCached: (page) => docCache.has(page),
    isBlocked: (page) => actualThumbnailRenders.has(docKey(docId, page)),
  });
  if (step.page == null) return step.status === 'deferred' ? 'later' : 'stop';

  const pageNum = step.page;
  const gen = getPageGen(docId, pageNum);
  const key = docKey(docId, pageNum);
  visibleJobs.add(key);
  thumbnailQueue.markInFlight(pageNum);
  priorityPages.add(pageNum);
  void renderThumbnailBounded(pdfDoc, pageNum, docState.doc, docId, gen, 'visible')
    .then((imageData) => {
      if (thumbnailResultKeepsQueue(imageData)) {
        // A timed-out render remains in flight until its late result arrives.
        if (imageData.deferred !== 'slow' && getActiveDocument()?.id === docId) {
          thumbnailQueue.clearInFlight(pageNum);
          thumbnailQueue.hold(pageNum, imageData.deferred === 'waiting' ? 'type' : 'cancelled');
        }
      } else if (!rememberThumbnail(docId, pageNum, gen, imageData) && getActiveDocument()?.id === docId) {
        thumbnailQueue.clearInFlight(pageNum);
        if (priorityPages.has(pageNum)) thumbnailQueue.hold(pageNum, 'cancelled');
      }
    })
    .catch((err) => {
      if (getActiveDocument()?.id === docId) {
        thumbnailQueue.clearInFlight(pageNum);
        if (priorityPages.has(pageNum)) thumbnailQueue.hold(pageNum, 'cancelled');
      }
      console.warn(`[Thumbnails] Error rendering priority page ${pageNum}:`, err);
    })
    .finally(() => {
      visibleJobs.delete(key);
      if (getActiveDocument()?.id === docId) startProcessor();
    });
  return 'continue';
}

// Process one thumbnail for a specific document (sequential with wrap-around)
async function processDocumentThumbnail(docId) {
  const docState = documentState.get(docId);
  const docCache = thumbnailCache.get(docId);

  if (!docState || !docCache) {
    return false;
  }

  const { pdfDoc, numPages } = docState;
  const startPage = docState.startPage || 1;

  let attempts = 0;
  const maxAttempts = numPages;
  let waiting = false;

  while (attempts < maxAttempts) {
    if (docState.wrapped && docState.nextPage === startPage) {
      return waiting ? 'later' : false;
    }

    const pageNum = docState.nextPage;
    attempts++;

    docState.nextPage++;
    if (docState.nextPage > numPages) {
      docState.nextPage = 1;
      docState.wrapped = true;
    }

    if (docCache.has(pageNum)) continue;
    const key = docKey(docId, pageNum);
    if (docInFlight.has(key) || actualThumbnailRenders.has(key) || docCooling(docId, pageNum)) {
      waiting = true;
      continue;
    }

    const gen = getPageGen(docId, pageNum);
    try {
      const imageData = await renderThumbnailBounded(pdfDoc, pageNum, docState.doc, docId, gen, 'document');
      // Leave nextPage where it is so the following sheet still runs.
      // Rewinding onto a cancelled row used to stop the whole strip.
      if (imageData?.deferred === 'slow') return true;
      if (thumbnailResultKeepsQueue(imageData)) {
        holdDocPage(docId, pageNum);
        return true;
      }
      if (imageData?.dataURL) rememberThumbnail(docId, pageNum, gen, imageData);
      return true;
    } catch (err) {
      console.warn(`[Thumbnails] Error rendering page ${pageNum} of doc ${docId}:`, err);
      return true;
    }
  }

  return waiting ? 'later' : false;
}

// Composite plugin/Solid-store annotations on top of a rendered thumbnail
// dataURL. Returns a new dataURL with annotations overlayed. If the page has
// no annotations, returns the input dataURL unchanged (zero-cost early-exit).
function overlayAnnotationsOnCanvas(ctx, pageNum, scale, doc) {
  // Overlay the OWNING document's annotations, not the active one's (see
  // renderThumbnailToDataURL) — otherwise a background thumbnail got the
  // active document's annotations painted on it.
  if (!doc) doc = getActiveDocument();
  const annotations = (doc?.annotations || []).filter(a => a.page === pageNum);
  if (annotations.length === 0) return;
  annotations.sort((a, b) => Number(!!edition.rendering?.isUnderlay?.(b)) - Number(!!edition.rendering?.isUnderlay?.(a)));
  ctx.save();
  try {
    // Page coordinates from the canvas origin, whatever the page render left.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    annotations.forEach(a => {
      try { drawAnnotation(ctx, a); }
      catch (e) {
        // Tolerant: 1 broken annotation mag thumb niet breken — wel loggen
        // zodat plugin-bugs niet stilletjes verdwijnen in productie.
        console.warn(`[Thumbnails] drawAnnotation failed page ${pageNum} id=${a?.id ?? '?'} type=${a?.type ?? '?'}:`, e);
      }
    });
  } catch (e) {
    console.warn(`[Thumbnails] overlay failed for page ${pageNum}:`, e);
  } finally {
    ctx.restore();
  }
}

// Draw the markups straight onto the thumbnail canvas, then encode once.
// The old route encoded the page to a JPEG data URL, decoded it into an
// <img>, drew it with the markups onto a second canvas and encoded again:
// two JPEG generations and a decode per thumbnail with markups.
function thumbnailDataURL(canvas, ctx, pageNum, scale, doc) {
  overlayAnnotationsOnCanvas(ctx, pageNum, scale, doc);
  return canvas.toDataURL('image/jpeg', 0.7);
}

// Render a single page thumbnail — prefers replaying JS-cached vector commands
// (already extracted by the main viewer) for ~3-6× speedup; falls back to the
// Rust backend, then PDF.js. Reusing the cache avoids re-parsing the PDF
// content stream + IPC + JPEG encode + base64 round-trip.
async function renderThumbnailToDataURL(pdfDoc, pageNum, doc) {
  if (!pdfDoc || !Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) return null;
  const _th0 = performance.now();

  // `doc` is the document that owns `pdfDoc`, passed by the thumbnail processor.
  // The old code always used getActiveDocument() here, so a background
  // document's thumbnails were rendered against the ACTIVE document's file
  // path (and annotations) — one file's pages leaked into another's panel when
  // several documents were open. Only fall back to the active doc for legacy
  // direct callers that don't pass one.
  if (!doc) doc = getActiveDocument();

  // ── Fast path: JS replay of cached vector commands ────────────────────────
  // Only viable if the main viewer has already populated the cache for this
  // page (e.g. user navigated to it once, or it was prefetched).
  try {
    if (doc?.filePath) {
      const vr = await import('../../pdf/vector-renderer.js');
      const rotation = doc.pageRotations?.[pageNum] || 0;
      if (!nativeOcgHasGroups(doc) && vr.hasCachedCommands(doc.filePath, pageNum, rotation)) {
        const dims = vr.getCachedPageDimensions(doc.filePath, pageNum, rotation);
        console.log(`[thumb] p${pageNum} JS-replay: dims=`, dims, `rotation=${rotation}`);
        if (dims && dims.w > 0 && dims.h > 0) {
          // Target 200 px wide thumbnail (matches Rust path).
          // For LANDSCAPE pages (w > h), 200 px wide stays under common UI
          // limits. For PORTRAIT pages (h > w), 200 px wide may produce a
          // thumbnail taller than the panel — but downstream layout handles
          // that. The original sizing is preserved here for compatibility.
          const targetW = 140;
          const scale = targetW / dims.w;
          const w = Math.max(1, Math.round(dims.w * scale));
          const h = Math.max(1, Math.round(dims.h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          // Paint white background so transparency doesn't bleed to JPEG.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          // Replay the cached vector commands at the thumbnail scale.
          // renderVectorPage applies its own Y-flip + MediaBox-origin shift
          // — caller transform is just (scale, scale) with zero translation.
          vr.renderVectorPage(ctx, doc.filePath, pageNum, { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }, rotation);
          console.log(`[thumb] p${pageNum} JS-replay rendered: canvas=${w}x${h} scale=${scale.toFixed(4)}`);
          // Blanco-vangnet: op pagina's met een gecentreerde MediaBox
          // (x0/y0 negatief, AutoCAD/InDesign-export) plaatst de replay de
          // content buiten het canvas — de hoofdweergave maskeert dat met een
          // PDFium-bitmap eronder, maar de thumbnail blijft dan wit. Sample de
          // canvas; is hij (vrijwel) leeg terwijl er wél commando's waren, val
          // dan door naar het Rust-pad dat via PDFium correct rendert.
          let _blank = true;
          try {
            const _d = ctx.getImageData(0, 0, w, h).data;
            let _ink = 0;
            for (let k = 0; k < _d.length; k += 4 * 7) {
              if (!(_d[k] > 245 && _d[k + 1] > 245 && _d[k + 2] > 245)) { _ink++; if (_ink > 8) break; }
            }
            _blank = _ink <= 8;
          } catch { _blank = false; /* sampling faalt → vertrouw de replay */ }
          if (_blank) {
            console.log(`[thumb] p${pageNum} JS-replay leeg → val terug op Rust-pad`);
          } else {
            // Overlay annotations on top (same as Rust path).
            return { dataURL: thumbnailDataURL(canvas, ctx, pageNum, scale, doc), width: w, height: h };
          }
        }
      }
    }
  } catch (_) { /* fall through to Rust path */ }

  // Reuse any page bitmap already decoded for the view. A cold thumbnail is
  // sent only to a PDFium worker, so an image-heavy sheet cannot be parsed in
  // the GUI process while the user is navigating.
  const rotation = doc?.pageRotations?.[pageNum] || 0;
  if (doc?.filePath) {
    try {
      const pbc = await import('../../pdf/page-bitmap-cache.js');
      const best = pbc.getLargestCachedBitmap(doc.filePath, pageNum, rotation);
      if (best?.bitmap && best.w >= 140) {
        const w = 140;
        const h = Math.max(1, Math.round(best.h * w / best.w));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(best.bitmap, 0, 0, w, h);
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
        return { dataURL: thumbnailDataURL(canvas, ctx, pageNum, w / viewport.width, doc), width: w, height: h };
      }
    } catch { /* a cache miss still has the worker path */ }
  }

  if (doc?.filePath && window.__TAURI__) {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const thumbScale = Math.min(0.5, 280 / viewport.width);
      const raw = await window.__TAURI__.core.invoke('render_pdf_page', {
        path: doc.filePath,
        pageIndex: pageNum - 1,
        scale: thumbScale,
        rotation,
        workerOnly: true,
        ocgVisibility: nativeOcgSelectionForDocument(doc).ocgVisibility,
      });
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (bytes.length < 8) throw new Error('Empty worker thumbnail');
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
      const rw = dv.getUint32(0, true), rh = dv.getUint32(4, true);
      if (!rw || !rh || rw * rh * 4 !== bytes.length - 8) throw new Error('Invalid worker thumbnail');
      const src = document.createElement('canvas');
      src.width = rw;
      src.height = rh;
      src.getContext('2d').putImageData(new ImageData(
        new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, rw * rh * 4), rw, rh), 0, 0);
      const w = 140;
      const h = Math.max(1, Math.round(rh * w / rw));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      return { dataURL: thumbnailDataURL(canvas, ctx, pageNum, w / viewport.width, doc), width: w, height: h };
    } catch (e) {
      console.warn(`[Thumbnails] Worker thumbnail failed for page ${pageNum}:`, e);
      return { deferred: 'cancelled' };
    }
  }

  // Fallback: PDF.js rendering
  console.log(`[PERF-THUMB] page ${pageNum}: PDF.js fallback START`);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Render timeout')), 10000);
  });

  try {
    const renderPromise = (async () => {
      const page = await pdfDoc.getPage(pageNum);
      const extraRot = doc?.pageRotations?.[pageNum] || 0;
      const trOpts = { scale: 1 };
      if (extraRot) trOpts.rotation = (page.rotate + extraRot) % 360;
      const pageWidth = page.getViewport(trOpts).width;
      const thumbScale = Math.min(THUMBNAIL_SCALE, 140 / pageWidth);
      trOpts.scale = thumbScale;
      const viewport = page.getViewport(trOpts);

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({
        canvasContext: ctx,
        viewport: viewport,
        annotationMode: 0,
        optionalContentConfigPromise: nativeOcgPdfJsConfig(doc),
      }).promise;

      // Overlay plugin/Solid-store annotations op dezelfde ctx vóór toDataURL.
      // viewport.width = pdfPtWidth * thumbScale, dus schaalfactor naar
      // PDF-pt-coordsysteem = thumbScale.
      try {
        // Use the owning document's annotations (not the active one's) — same
        // cross-document leak as the other thumbnail paths.
        const docAnn = doc || getActiveDocument();
        const annotations = (docAnn?.annotations || []).filter(a => a.page === pageNum);
        annotations.sort((a, b) => Number(!!edition.rendering?.isUnderlay?.(b)) - Number(!!edition.rendering?.isUnderlay?.(a)));
        if (annotations.length > 0) {
          ctx.save();
          ctx.scale(thumbScale, thumbScale);
          annotations.forEach(a => {
            try { drawAnnotation(ctx, a); }
            catch (e) {
              console.warn(`[Thumbnails] drawAnnotation failed (PDF.js path) page ${pageNum} id=${a?.id ?? '?'} type=${a?.type ?? '?'}:`, e);
            }
          });
          ctx.restore();
        }
      } catch (e) {
        console.warn(`[Thumbnails] PDF.js overlay failed for page ${pageNum}:`, e);
      }

      return {
        dataURL: canvas.toDataURL('image/jpeg', 0.7),
        width: viewport.width,
        height: viewport.height
      };
    })();

    const result = await Promise.race([renderPromise, timeoutPromise]);
    console.log(`[PERF-THUMB] page ${pageNum}: PDF.js fallback DONE: ${(performance.now() - _th0).toFixed(0)}ms`);
    return result;
  } catch (err) {
    console.warn(`[PERF-THUMB] page ${pageNum}: PDF.js fallback FAILED (${(performance.now() - _th0).toFixed(0)}ms):`, err.message);
    return null;
  }
}

// Show page properties dialog
export async function showPageProperties(pageNum) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  try {
    const page = await doc.pdfDoc.getPage(pageNum);
    const rotation = getPageRotation(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const widthPt = viewport.width;
    const heightPt = viewport.height;
    const widthMm = (widthPt / 72 * 25.4).toFixed(1);
    const heightMm = (heightPt / 72 * 25.4).toFixed(1);
    const widthIn = (widthPt / 72).toFixed(2);
    const heightIn = (heightPt / 72).toFixed(2);
    const totalRotation = (page.rotate + (rotation || 0)) % 360;

    const msg = `Page ${pageNum}\n\n` +
      `Size: ${widthPt.toFixed(0)} x ${heightPt.toFixed(0)} pt\n` +
      `Size: ${widthMm} x ${heightMm} mm\n` +
      `Size: ${widthIn} x ${heightIn} in\n` +
      `Rotation: ${totalRotation}\u00B0`;

    if (window.__TAURI__?.dialog?.message) {
      await window.__TAURI__.dialog.message(msg, { title: 'Page Properties', kind: 'info' });
    } else {
      showMessage(msg);
    }
  } catch (err) {
    console.error('Error showing page properties:', err);
  }
}

// Invalidate and re-render a single page's thumbnail (e.g. after rotation)
export function invalidateThumbnail(pageNum) {
  const activeDoc = getActiveDocument();
  if (!activeDoc) return;
  const docCache = thumbnailCache.get(activeDoc.id);
  if (docCache) {
    docCache.delete(pageNum);
  }
  // Bump generation: any in-flight render for this page will discard its
  // result on completion (see pageGenMatches in process*Thumbnail).
  bumpPageGen(activeDoc.id, pageNum);
  // Remove from Solid store so component shows loading spinner
  removeThumbnailImage(pageNum);
  // A cooldown or an in-flight render of the old picture must not delay this.
  thumbnailQueue.forget(pageNum);
  priorityPages.add(pageNum);
  startProcessor();
  notifyDetachedThumbnailChange();
}

// Invalidate several pages' thumbnails at once (e.g. after "Clear All" or a
// bulk annotation edit spanning multiple pages). Cheaper than N single calls:
// one processor restart at the end instead of per page.
export function invalidateThumbnails(pageNums) {
  const activeDoc = getActiveDocument();
  if (!activeDoc || !pageNums) return;
  // Thumbnails panel not shown: re-rendering the page for a thumbnail nobody
  // sees cost a full page render after every markup edit (a quarter second
  // on a large drawing). Keep the old thumbnail (still fine as the page
  // transition placeholder) and redo it when the panel comes up.
  const range = detachedVisibleRange?.docId === activeDoc.id ? detachedVisibleRange : null;
  const { immediate, deferred } = partitionThumbnailInvalidations(pageNums, isPanelShown('thumbnails'), range);
  if (deferred.length) {
    if (!deferredThumbnailPages.has(activeDoc.id)) deferredThumbnailPages.set(activeDoc.id, new Set());
    for (const pageNum of deferred) deferredThumbnailPages.get(activeDoc.id).add(pageNum);
  }
  if (!immediate.length) return;
  pageNums = immediate;
  const docCache = thumbnailCache.get(activeDoc.id);
  let any = false;
  for (const pageNum of pageNums) {
    if (!Number.isInteger(pageNum) || pageNum < 1) continue;
    if (docCache) docCache.delete(pageNum);
    bumpPageGen(activeDoc.id, pageNum);
    removeThumbnailImage(pageNum);
    thumbnailQueue.forget(pageNum);
    priorityPages.add(pageNum);
    any = true;
  }
  if (any) {
    startProcessor();
    notifyDetachedThumbnailChange();
  }
}

// Pages whose thumbnail an edit made stale while the panel was hidden, per
// document id (see invalidateThumbnails).
const deferredThumbnailPages = new Map();

/** The Thumbnails panel came up: redo the thumbnails edits made stale. */
export function flushDeferredThumbnails() {
  const activeDoc = getActiveDocument();
  const pages = activeDoc ? deferredThumbnailPages.get(activeDoc.id) : null;
  if (!pages?.size || !isPanelShown('thumbnails')) return;
  deferredThumbnailPages.delete(activeDoc.id);
  invalidateThumbnails([...pages]);
}

export function invalidateDocumentThumbnails(doc) {
  if (!doc?.id || !doc.pdfDoc) return;
  const cache = thumbnailCache.get(doc.id);
  for (let pageNum = 1; pageNum <= doc.pdfDoc.numPages; pageNum++) {
    cache?.delete(pageNum);
    bumpPageGen(doc.id, pageNum);
  }
  const docState = documentState.get(doc.id);
  if (docState) {
    docState.nextPage = 1;
    docState.startPage = 1;
    docState.wrapped = false;
  }
  if (getActiveDocument() === doc) {
    notifyDetachedThumbnailChange();
    clearAllThumbnails();
    setPageCount(doc.pdfDoc.numPages);
    thumbnailQueue.reset();
    docNotBefore.clear();
    docInFlight.clear();
    if (doc._largeOpen) {
      updateVisiblePriorities();
    } else {
      for (let pageNum = 1; pageNum <= doc.pdfDoc.numPages; pageNum++) priorityPages.add(pageNum);
      startProcessor();
    }
  }
}

// Clear thumbnail cache for a specific document
export function clearThumbnailCache(docId) {
  if (docId) {
    thumbnailCache.delete(docId);
    documentState.delete(docId);
    notifyDetachedThumbnailChange();
  }
}

// Save thumbnail scroll position for the current document
export function saveThumbnailScrollPosition() {
  const doc = getActiveDocument();
  if (!doc) return;
  const container = getContainerRef();
  if (container) {
    thumbnailScrollPositions.set(doc.id, container.scrollTop);
  }
}

// Update which thumbnail is marked as active
export function updateActiveThumbnail(restoreScroll = false) {
  const doc = getActiveDocument();
  const newPage = doc ? doc.currentPage : 1;
  setActivePage(newPage);
  notifyDetachedThumbnailChange();

  // Keep the thumbnail selection in sync with the active page when the user
  // has a single-page selection (which is the default after a normal click).
  // If they have a multi-page selection (Ctrl/Shift-click), leave it alone so
  // they don't lose their selection while navigating with the wheel/keyboard.
  const sel = thumbnailSelectedPages();
  if (sel.size <= 1) {
    selectThumbnailPage(newPage);
  }

  setTimeout(() => {
    const container = getContainerRef();
    if (!container) return;

    if (restoreScroll && doc && thumbnailScrollPositions.has(doc.id)) {
      // Restore saved scroll position (tab switch)
      container.scrollTop = thumbnailScrollPositions.get(doc.id);
    } else {
      // Scroll active thumbnail into view (page navigation)
      scrollThumbnailToPage(newPage);
    }
  }, 0);
}

// Clear thumbnails (when PDF is closed)
export function clearThumbnails() {
  clearAllThumbnails();
  thumbnailQueue.reset();
  queuedDocId = null;
  docNotBefore.clear();
  docInFlight.clear();
  clearDeferRetry();
  notifyDetachedThumbnailChange();
}

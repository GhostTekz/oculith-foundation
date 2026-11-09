// The drawing window owns PDF rendering and the thumbnail cache. A separate
// floating tile receives only visible cached images and page captions, and
// sends page navigation back here; it never opens a second copy of the drawing.
import { putBackInApp, takeOffApp } from './panel-popout.js';
import { getActiveDocument } from '../../core/state.js';
import { cachedThumbnailForDocument, onDetachedThumbnailChange, setDetachedThumbnailPages } from './left-panel.js';
import { TILE_DEFAULTS, TILE_MEMORY_KEY, tilePlacement } from './thumbnail-tile-placement.js';
import { tilePageInfo, validTilePages } from './thumbnail-tile-grid.js';

const STATE = 'thumbnail-view:state';
const IMAGES = 'thumbnail-view:images';
const INFO = 'thumbnail-view:info';
const READY = 'thumbnail-view:ready';
const RANGE = 'thumbnail-view:range';
const GOTO = 'thumbnail-view:goto';
const DOCK = 'thumbnail-view:dock';
const CLOSED = 'thumbnail-view:closed';
const FIRST_PAGES = Array.from({ length: 12 }, (_, index) => index + 1);
const MAX_IMAGES_PER_SYNC = 4;

let childLabel = '';
let sourceLabel = '';
let listeners = null;
let timer = null;
let ready = false;
let requested = { docId: '', pages: FIRST_PAGES };
let lastState = '';
let lastInfo = { docId: '', pdfDoc: null, register: null, sent: false };
let sentImages = new Map();
let sending = false;
let pendingSync = false;
let checks = 0;
let opening = null;

const tauri = () => window.__TAURI__;
const documentName = (doc) => String(doc?.filePath || doc?.name || 'Drawing')
  .split(/[\\/]/).pop() || 'Drawing';

function snapshot() {
  const doc = getActiveDocument();
  const count = doc?.pdfDoc?.numPages || 0;
  return { docId: count ? doc.id : '', count,
    activePage: count ? Math.max(1, Math.min(count, doc.currentPage || 1)) : 0,
    title: count ? documentName(doc) : '' };
}

function clearConnection() {
  if (timer) clearInterval(timer);
  timer = null;
  ready = false;
  lastState = '';
  lastInfo = { docId: '', pdfDoc: null, register: null, sent: false };
  sentImages = new Map();
  pendingSync = false;
  requested = { docId: '', pages: FIRST_PAGES };
  onDetachedThumbnailChange(null);
  setDetachedThumbnailPages(null, []);
}

/** Page labels and drawing-set sheet numbers/titles, sent once per document change. */
async function syncInfo(current) {
  const doc = getActiveDocument();
  if (!current.docId || doc?.id !== current.docId) return;
  const { sheetRegister } = await import('../../solid/stores/sheetRegisterStore.js');
  const register = sheetRegister();
  if (lastInfo.sent && lastInfo.docId === doc.id && lastInfo.pdfDoc === doc.pdfDoc
      && lastInfo.register === register) return;
  const pdfDoc = doc.pdfDoc;
  let labels = null;
  try { labels = await pdfDoc.getPageLabels(); } catch { labels = null; }
  if (getActiveDocument() !== doc || doc.pdfDoc !== pdfDoc || !ready) return;
  const info = tilePageInfo(pdfDoc.numPages, labels, register?.sheets, doc.filePath);
  await tauri().event.emitTo(childLabel, INFO, { source: sourceLabel, docId: doc.id, info });
  lastInfo = { docId: doc.id, pdfDoc, register, sent: true };
}

async function sync(force = false) {
  if (!ready || !childLabel) return;
  if (sending) { pendingSync = true; return; }
  sending = true;
  try {
    const current = snapshot();
    const key = JSON.stringify(current);
    if (force || key !== lastState) {
      await tauri().event.emitTo(childLabel, STATE, { source: sourceLabel, ...current });
      if (current.docId !== requested.docId) {
        requested = { docId: current.docId, pages: FIRST_PAGES };
        sentImages = new Map();
        setDetachedThumbnailPages(current.docId, FIRST_PAGES);
      }
      lastState = key;
    }
    if (!current.docId) return;
    if (force) lastInfo.sent = false;
    await syncInfo(current);
    const changed = [];
    for (const page of requested.pages) {
      if (page > current.count) continue;
      const image = cachedThumbnailForDocument(current.docId, page);
      if (!image?.dataURL) {
        if (sentImages.has(page)) changed.push({ page, dataURL: null });
        continue;
      }
      if (sentImages.get(page) === image.dataURL) continue;
      changed.push({ page, dataURL: image.dataURL, width: image.width, height: image.height });
      if (changed.length >= MAX_IMAGES_PER_SYNC) break;
    }
    if (changed.length) {
      await tauri().event.emitTo(childLabel, IMAGES,
        { source: sourceLabel, docId: current.docId, pages: changed });
      for (const image of changed) {
        if (image.dataURL) sentImages.set(image.page, image.dataURL);
        else sentImages.delete(image.page);
      }
      if (changed.length === MAX_IMAGES_PER_SYNC) pendingSync = true;
    }
  } catch (error) {
    console.warn('[thumbnails] separate view update failed:', error);
  } finally {
    sending = false;
    if (pendingSync) {
      pendingSync = false;
      queueMicrotask(() => { void sync(); });
    }
  }
}

async function ensureListeners() {
  if (listeners) return listeners;
  listeners = (async () => {
    const event = tauri()?.event;
    if (!event?.listen || !event?.emitTo) throw new Error('A desktop window is required.');
    sourceLabel = await tauri().core.invoke('current_window_label');
    childLabel = `thumbnail-${sourceLabel}`;
    await event.listen(READY, (message) => {
      if (message.payload?.child !== childLabel) return;
      ready = true;
      lastState = '';
      sentImages = new Map();
      void sync(true);
    });
    await event.listen(RANGE, (message) => {
      const { child, docId } = message.payload || {};
      const current = snapshot();
      const pages = validTilePages(message.payload?.pages, current.count);
      if (child !== childLabel || docId !== current.docId || !pages) return;
      if (requested.docId === docId && requested.pages.length === pages.length
          && requested.pages.every((page, index) => page === pages[index])) return;
      requested = { docId, pages };
      const wanted = new Set(pages);
      for (const page of sentImages.keys()) {
        if (!wanted.has(page)) sentImages.delete(page);
      }
      setDetachedThumbnailPages(docId, pages);
      void sync();
    });
    await event.listen(GOTO, (message) => {
      const { child, docId, page, focus } = message.payload || {};
      const current = snapshot();
      if (child !== childLabel || docId !== current.docId
          || !Number.isSafeInteger(page) || page < 1 || page > current.count) return;
      import('../../pdf/renderer.js').then(({ goToPage }) => goToPage(page))
        .then(() => { if (focus) return tauri()?.window?.getCurrentWindow?.()?.setFocus?.(); })
        .catch((error) => console.warn('[thumbnails] page navigation failed:', error));
    });
    await event.listen(DOCK, (message) => {
      if (message.payload?.child !== childLabel) return;
      putBackInApp('thumbnails');
      import('../../solid/commands/window.js').then(({ revealPanel }) => revealPanel('thumbnails'))
        .then(() => tauri()?.window?.getCurrentWindow?.()?.setFocus?.())
        .catch((error) => console.warn('[thumbnails] could not show the side panel:', error));
    });
    await event.listen(CLOSED, (message) => {
      if (message.payload?.child !== childLabel) return;
      clearConnection();
      putBackInApp('thumbnails');
    });
  })().catch((error) => { listeners = null; throw error; });
  return listeners;
}

function startWatchdog(W) {
  if (timer) return;
  checks = 0;
  timer = setInterval(() => {
    void sync();
    if (++checks % 2 === 0) {
      W.getByLabel(childLabel).then((found) => { if (!found) { clearConnection(); putBackInApp('thumbnails'); } }).catch(() => {});
    }
  }, 2000);
}

function readMemory() {
  try { return globalThis.localStorage?.getItem(TILE_MEMORY_KEY) || null; } catch { return null; }
}

/** Physical rectangle for the tile: remembered, else beside this window. */
async function tileRect() {
  const api = tauri().window;
  const self = api.getCurrentWindow();
  let owner = null;
  try {
    const [position, size] = await Promise.all([self.outerPosition(), self.outerSize()]);
    if (size.width > 0 && size.height > 0) owner = { x: position.x, y: position.y, width: size.width, height: size.height };
  } catch { /* fall back to the browser's view of this window */ }
  if (!owner && window.outerWidth > 0) {
    const ratio = window.devicePixelRatio || 1;
    owner = { x: window.screenX * ratio, y: window.screenY * ratio,
      width: window.outerWidth * ratio, height: window.outerHeight * ratio };
  }
  let monitors = [];
  try { monitors = await api.availableMonitors(); } catch { monitors = []; }
  return tilePlacement({ memory: readMemory(), monitors, owner });
}

async function createTile(W) {
  const rect = await tileRect();
  const scale = rect.scale || 1;
  const view = new W(childLabel, {
    url: `index.html?view=thumbnails&source=${encodeURIComponent(sourceLabel)}`,
    title: 'Pages',
    x: Math.round(rect.x / scale), y: Math.round(rect.y / scale),
    width: Math.round(rect.width / scale), height: Math.round(rect.height / scale),
    minWidth: TILE_DEFAULTS.minWidth, minHeight: TILE_DEFAULTS.minHeight,
    resizable: true, maximizable: false, minimizable: false, fullscreen: false,
    decorations: false, shadow: true, skipTaskbar: true,
    // Owned by the drawing window: kept above it, closed with it (Windows),
    // a transient dialog (Linux) or a child window (macOS).
    parent: sourceLabel,
    visible: false, focus: true,
  });
  await new Promise((resolve, reject) => {
    view.once('tauri://created', resolve);
    view.once('tauri://error', (event) => reject(new Error(String(event?.payload ?? 'window error'))));
  });
  // Logical options are converted with one scale factor; set the exact
  // physical geometry so a tile on a second monitor with another scale lands right.
  const dpi = tauri().dpi;
  if (dpi?.PhysicalSize && dpi?.PhysicalPosition) {
    try {
      await view.setSize(new dpi.PhysicalSize(rect.width, rect.height));
      await view.setPosition(new dpi.PhysicalPosition(rect.x, rect.y));
    } catch (error) {
      console.warn('[thumbnails] tile placement was not applied:', error);
    }
  }
  await view.show();
  await view.setFocus();
}

async function openView() {
  await ensureListeners();
  onDetachedThumbnailChange(() => { queueMicrotask(() => { void sync(); }); });
  const W = tauri()?.webviewWindow?.WebviewWindow;
  if (!W) throw new Error('A desktop window is required.');
  const existing = await W.getByLabel(childLabel);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    takeOffApp('thumbnails');
    startWatchdog(W);
    if (!ready) { ready = true; void sync(true); }
    return;
  }
  startWatchdog(W);
  try {
    await createTile(W);
    // The thumbnails are in their own view now, not also in the app.
    takeOffApp('thumbnails');
  } catch (error) {
    console.warn('[thumbnails] separate view failed:', error);
    clearConnection();
    throw error;
  }
}

/** Open or focus one tile per drawing window. The source retains PDF ownership. */
export function openDetachedThumbnails() {
  if (!opening) opening = openView().finally(() => { opening = null; });
  return opening;
}

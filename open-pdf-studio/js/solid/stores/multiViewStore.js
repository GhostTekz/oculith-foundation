// MultiView (split screen) and Sync, docs/reference/editor/workspace.md. The pane model lives
// in multiViewModel.js (pure); this module keeps it in a Solid signal and
// joins it to the live renderer (#pdf-container, switchToTab) and to the
// passive pane (js/pdf/multiview-pane.js, mounted by MultiViewPanes.jsx).

import { createSignal } from 'solid-js';
import { state } from '../../core/state.js';
import * as M from './multiViewModel.js';
import { syncedPage, mapScroll, pageOffsetFor } from '../../pdf/multiview-sync.js';

const [model, setModel] = createSignal(M.createMultiView());

export const multiView = model;
export const isSplitView = () => M.isSplit(model());
export const splitOrientation = () => model().orientation;
export const activePaneIndex = () => model().activePane;
export const passivePaneIndex = () => M.otherPane(model());
export const syncState = () => model().sync;
export const paneDocIds = (pane) => model().panes[pane]?.docIds || [];
export const paneActiveDocId = (pane) => model().panes[pane]?.activeDocId ?? null;

const docById = (id) => state.documents.find((d) => d.id === id) || null;
const indexOfDoc = (id) => state.documents.findIndex((d) => d.id === id);
const activeDoc = () => state.documents[state.activeDocumentIndex] || null;
const tabs = () => import('../../ui/chrome/tabs.js');
const liveContainer = () => (typeof document !== 'undefined' ? document.getElementById('pdf-container') : null);

function setBodyClass(on) {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle('mv-split', on);
}

function commit(next) {
  const was = M.isSplit(model());
  setModel(next);
  const now = M.isSplit(next);
  if (was !== now) setBodyClass(now);
}

// ── The live view (the active pane) ──────────────────────────────────────

/** The vector/raster viewport singleton (Tauri) pans without scrolling. */
const viewportActive = () => {
  const vp = typeof window !== 'undefined' ? window.__pdfViewport : null;
  return !!(vp && vp.active && activeDoc()?.filePath);
};

export function liveView() {
  const doc = activeDoc();
  const c = liveContainer();
  const vp = typeof window !== 'undefined' ? window.__pdfViewport : null;
  const scale = viewportActive() && vp.zoom ? vp.zoom / ((window.devicePixelRatio) || 1) : (doc?.scale || 1);
  return {
    page: doc?.currentPage || 1,
    scale,
    scrollLeft: c?.scrollLeft || 0,
    scrollTop: c?.scrollTop || 0,
  };
}

function liveBox() {
  const c = liveContainer();
  if (!c || viewportActive() || activeDoc()?.viewMode === 'continuous') return null;
  return {
    scrollLeft: c.scrollLeft, scrollTop: c.scrollTop, clientWidth: c.clientWidth,
    clientHeight: c.clientHeight, scrollWidth: c.scrollWidth, scrollHeight: c.scrollHeight,
  };
}

// ── The passive pane ─────────────────────────────────────────────────────

let passive = null; // createPassivePane() api while split

export function registerPassivePane(api) { passive = api; }
export function unregisterPassivePane(api) { if (passive === api) passive = null; }
export const passivePane = () => passive;

/** The view the passive pane should open with (stored, or the doc's own). */
export function storedPassiveView() {
  const mv = model();
  const pane = M.otherPane(mv);
  if (pane < 0) return null;
  const docId = mv.panes[pane].activeDocId;
  const doc = docById(docId);
  if (!doc) return null;
  const v = M.paneView(mv, pane, docId);
  return {
    doc,
    view: v || {
      page: doc.currentPage || 1, scale: doc.scale || 1,
      scrollLeft: doc.scrollPosition?.x || 0, scrollTop: doc.scrollPosition?.y || 0,
    },
  };
}

function passiveSnapshot() {
  if (!passive || !passive.doc) return null;
  const b = passive.box();
  return { docId: passive.doc.id, view: { page: passive.page, scale: passive.scale, scrollLeft: b.scrollLeft, scrollTop: b.scrollTop } };
}

/** Store what both splits show now: the live view and the passive view. */
function captureViews(mv) {
  if (!M.isSplit(mv)) return mv;
  let next = mv;
  const live = activeDoc();
  if (live && next.panes[next.activePane].docIds.includes(live.id)) {
    next = M.setPaneView(next, next.activePane, live.id, liveView());
  }
  const other = M.otherPane(next);
  const snap = passiveSnapshot();
  if (snap && next.panes[other].docIds.includes(snap.docId)) next = M.setPaneView(next, other, snap.docId, snap.view);
  return next;
}

// ── Split / unsplit / panes ──────────────────────────────────────────────

export function splitView(orientation) {
  const doc = activeDoc();
  if (!doc?.pdfDoc) return false;
  const mv = model();
  const next = M.split(mv, orientation, {
    docIds: state.documents.map((d) => d.id), activeDocId: doc.id, view: liveView(),
  });
  if (next === mv) return false;
  commit(next);
  return true;
}

export function unsplitView() {
  const mv = model();
  if (!M.isSplit(mv)) return false;
  commit(M.unsplit(mv));
  return true;
}

export function toggleSplitOrientation() {
  const mv = model();
  const next = M.toggleOrientation(mv);
  if (next === mv) return false;
  commit(next);
  return true;
}

let swapping = false;
export const isSwapping = () => swapping;

/**
 * Make pane `index` the active one (optionally showing `docId` there): the
 * live view is stored into its pane, the other pane's view moves into the
 * live renderer, and the old pane becomes the passive view.
 */
export async function activatePane(index, docId = null, { captured = false } = {}) {
  let mv = model();
  if (!M.isSplit(mv)) return false;
  if (index === mv.activePane) {
    if (docId != null && docId !== activeDoc()?.id) {
      const i = indexOfDoc(docId);
      if (i >= 0) (await tabs()).switchToTab(i);
    }
    return true;
  }
  if (!captured) mv = captureViews(mv);
  if (docId != null) mv = M.showInPane(mv, index, docId);
  const targetId = mv.panes[index].activeDocId;
  const target = docById(targetId);
  const view = M.paneView(mv, index, targetId);
  swapping = true;
  commit(M.setActivePane(mv, index));
  try {
    if (target) {
      if (view) {
        target.currentPage = Math.min(view.page, target.pdfDoc?.numPages || view.page);
        target.scale = view.scale;
      }
      const m = await tabs();
      m.switchToTab(indexOfDoc(targetId));
      if (view) target.scrollPosition = { x: view.scrollLeft, y: view.scrollTop };
    }
  } finally {
    setTimeout(() => { swapping = false; }, 120);
  }
  return true;
}

/** the external editor Switch / tab drag: move a document's tab to another pane. */
export async function moveTabToPane(docId, from, to, opts = {}) {
  let mv = model();
  if (!M.isSplit(mv) || from === to) return false;
  // Both views are stored first; the moving tab's view travels with it.
  mv = captureViews(mv);
  const next = M.moveDocToPane(mv, docId, from, to, opts);
  if (next === mv) return false;
  const wasActive = mv.activePane;
  if (!M.isSplit(next)) {
    // The source pane had only this tab: one pane remains, showing it.
    commit(next);
    const i = indexOfDoc(docId);
    if (i >= 0 && i !== state.activeDocumentIndex) (await tabs()).switchToTab(i);
    return true;
  }
  // moveDocToPane activated the target pane; run the real swap from the old
  // active pane so the renderer follows.
  swapping = true; // the views are captured already; activatePane must not re-read them
  commit({ ...next, activePane: wasActive });
  swapping = false;
  return activatePane(to, docId, { captured: true });
}

/** Close a pane's tab: only the view when the other pane shows it too. */
export async function closePaneTab(pane, docId) {
  const mv = model();
  if (!M.isSplit(mv)) return false;
  const other = 1 - pane;
  if (mv.panes[other]?.docIds.includes(docId)) {
    const wasLive = pane === mv.activePane && activeDoc()?.id === docId;
    const next = M.removeFromPane(mv, pane, docId);
    commit(next);
    if (wasLive && M.isSplit(next)) {
      const i = indexOfDoc(next.panes[pane].activeDocId);
      if (i >= 0) (await tabs()).switchToTab(i);
    } else if (!M.isSplit(next) && pane === mv.activePane) {
      // The live split closed: the other split's document comes forward.
      const i = indexOfDoc(mv.panes[other].activeDocId);
      if (i >= 0 && i !== state.activeDocumentIndex) (await tabs()).switchToTab(i);
    }
    return true;
  }
  const i = indexOfDoc(docId);
  if (i < 0) return false;
  return (await tabs()).closeTab(i);
}

/** Keep the panes in step with the open documents (opened, closed, active). */
export function reconcileWithDocuments() {
  const mv = model();
  if (!M.isSplit(mv)) return;
  const next = M.reconcile(mv, state.documents.map((d) => d.id), activeDoc()?.id ?? null);
  if (next !== mv) commit(next);
}

// Which pane's tab row opened the document tab menu (for Switch).
let menuPane = null;
export function setTabMenuPane(pane) { menuPane = pane; }
export function tabMenuPane() { return menuPane; }

// ── Sync ─────────────────────────────────────────────────────────────────

export function setSync({ enabled, mode } = {}) {
  const mv = model();
  if (!M.isSplit(mv) && enabled) return false;
  const nextMode = mode || mv.sync.mode;
  let pageOffset = mv.sync.pageOffset;
  const turningOn = enabled ?? mv.sync.enabled;
  if (turningOn && (nextMode !== mv.sync.mode || !mv.sync.enabled)) {
    const livePage = liveView().page;
    const otherPage = passive?.page || livePage;
    pageOffset = mv.activePane === 0 ? pageOffsetFor(livePage, otherPage) : pageOffsetFor(otherPage, livePage);
  }
  const next = M.setSync(mv, { enabled: turningOn, mode: nextMode, pageOffset });
  if (next === mv) return false;
  commit(next);
  if (next.sync.enabled) syncFromLive();
  return true;
}

/** Status bar / View menu: Sync on or off (keeps the mode). */
export const toggleSync = () => setSync({ enabled: !model().sync.enabled });

let echo = { pane: null, until: 0 };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const echoing = (pane) => echo.pane === pane && now() < echo.until;
const markEcho = (pane) => { echo = { pane, until: now() + 150 }; };

let liveFrame = 0;
/** Live view moved (page, zoom, scroll): bring the passive pane along. */
export function scheduleSyncFromLive() {
  if (liveFrame || !M.isSplit(model()) || !model().sync.enabled) return;
  liveFrame = requestAnimationFrame(() => { liveFrame = 0; syncFromLive(); });
}

export async function syncFromLive() {
  const mv = model();
  if (!M.isSplit(mv) || !mv.sync.enabled || swapping || !passive || echoing('live')) return;
  const target = storedPassiveView();
  if (!target?.doc?.pdfDoc) return;
  const live = liveView();
  const page = syncedPage({
    mode: mv.sync.mode, sourcePage: live.page, sourcePane: mv.activePane,
    pageOffset: mv.sync.pageOffset, targetPageCount: target.doc.pdfDoc.numPages,
  });
  const src = liveBox();
  await passive.show(target.doc, { page, scale: live.scale });
  if (src && passive) {
    markEcho('passive');
    const s = mapScroll(src, passive.box());
    await passive.show(target.doc, { page, scale: live.scale, ...s });
  }
}

/** The passive pane was scrolled or zoomed by the user. */
export async function syncFromPassive({ zoomed = false } = {}) {
  const mv = model();
  if (!M.isSplit(mv) || !mv.sync.enabled || swapping || !passive || echoing('passive')) return;
  const c = liveContainer();
  if (zoomed && passive.scale) {
    markEcho('live');
    const r = await import('../../pdf/renderer.js');
    await r.setZoom(passive.scale);
  }
  const box = liveBox();
  if (c && box) {
    markEcho('live');
    const s = mapScroll(passive.box(), box);
    c.scrollLeft = s.scrollLeft;
    c.scrollTop = s.scrollTop;
  }
}

/** Test hook: replace the model (node tests). */
export function _setModelForTests(mv) { commit(mv); }

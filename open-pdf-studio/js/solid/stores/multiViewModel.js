// MultiView (split screen) pane model, docs/reference/editor/workspace.md. Pure: no Solid, no
// DOM, no app state, so node tests cover it. Every function returns a new
// model (or the same object when nothing changed).
//
// Model:
//   orientation  null (unsplit) | 'vertical' (side by side) | 'horizontal'
//   activePane   index of the pane that holds the live renderer
//   panes        [{ docIds, activeDocId, views: { [docId]: view } }]
//                view = { page, scale, scrollLeft, scrollTop }
//   sync         { enabled, mode: 'document' | 'page', pageOffset }
//                pageOffset = page in pane 1 minus page in pane 0, taken
//                when Sync Page is turned on.

export const MAX_PANES = 2;
export const ORIENTATIONS = ['vertical', 'horizontal'];
export const SYNC_MODES = ['document', 'page'];

export function createMultiView() {
  return { orientation: null, activePane: 0, panes: [], sync: { enabled: false, mode: 'document', pageOffset: 0 } };
}

export const isSplit = (mv) => !!mv && mv.orientation !== null && mv.panes.length > 1;

/** The pane that is not active (the passive view), or -1 when unsplit. */
export const otherPane = (mv) => (isSplit(mv) ? 1 - mv.activePane : -1);

const cleanView = (view) => (view && typeof view === 'object'
  ? {
    page: Number.isInteger(view.page) && view.page > 0 ? view.page : 1,
    scale: Number(view.scale) > 0 ? Number(view.scale) : 1,
    scrollLeft: Math.max(0, Number(view.scrollLeft) || 0),
    scrollTop: Math.max(0, Number(view.scrollTop) || 0),
  }
  : null);

function withPane(mv, index, change) {
  const panes = mv.panes.map((pane, i) => (i === index ? { ...pane, ...change(pane) } : pane));
  return { ...mv, panes };
}

/**
 * Split the workspace. Unsplit: pane 0 gets every open tab, pane 1 a
 * duplicate of the active one (the external editor), both starting from the live view; the
 * first pane stays active. Already split: only the orientation changes.
 */
export function split(mv, orientation, { docIds = [], activeDocId = null, view = null } = {}) {
  if (!ORIENTATIONS.includes(orientation)) return mv;
  if (isSplit(mv)) return mv.orientation === orientation ? mv : { ...mv, orientation };
  if (activeDocId == null || !docIds.includes(activeDocId)) return mv;
  const v = cleanView(view);
  const views = v ? { [activeDocId]: v } : {};
  return {
    ...mv,
    orientation,
    activePane: 0,
    panes: [
      { docIds: [...docIds], activeDocId, views: { ...views } },
      { docIds: [activeDocId], activeDocId, views: { ...views } },
    ],
  };
}

/** Back to one pane; the live (active) pane stays. Sync turns off. */
export function unsplit(mv) {
  if (!isSplit(mv) && mv.orientation === null && mv.panes.length === 0) return mv;
  return { ...mv, orientation: null, activePane: 0, panes: [], sync: { ...mv.sync, enabled: false } };
}

/** the external editor Toggle Split: vertical ↔ horizontal. */
export function toggleOrientation(mv) {
  if (!isSplit(mv)) return mv;
  return { ...mv, orientation: mv.orientation === 'vertical' ? 'horizontal' : 'vertical' };
}

export function setActivePane(mv, index) {
  if (!isSplit(mv) || !Number.isInteger(index) || index < 0 || index >= mv.panes.length) return mv;
  return index === mv.activePane ? mv : { ...mv, activePane: index };
}

/** Remember a pane's view of a document (scroll, page, zoom). */
export function setPaneView(mv, index, docId, view) {
  if (!isSplit(mv) || !mv.panes[index] || docId == null) return mv;
  const v = cleanView(view);
  if (!v) return mv;
  return withPane(mv, index, (pane) => ({ views: { ...pane.views, [docId]: v } }));
}

export const paneView = (mv, index, docId) => mv?.panes?.[index]?.views?.[docId] || null;

/** Show `docId` in pane `index` (a tab click there); adds the tab if needed. */
export function showInPane(mv, index, docId) {
  if (!isSplit(mv) || !mv.panes[index] || docId == null) return mv;
  return withPane(mv, index, (pane) => ({
    docIds: pane.docIds.includes(docId) ? pane.docIds : [...pane.docIds, docId],
    activeDocId: docId,
  }));
}

function neighbour(docIds, docId) {
  const i = docIds.indexOf(docId);
  const rest = docIds.filter((id) => id !== docId);
  return rest.length ? rest[Math.min(Math.max(i, 0), rest.length - 1)] : null;
}

/**
 * Remove a document's tab from one pane (closing a tab that the other pane
 * still shows). A pane left without tabs unsplits; the other pane remains.
 */
export function removeFromPane(mv, index, docId) {
  if (!isSplit(mv) || !mv.panes[index]?.docIds.includes(docId)) return mv;
  const pane = mv.panes[index];
  const docIds = pane.docIds.filter((id) => id !== docId);
  if (!docIds.length) return unsplit({ ...mv, activePane: 1 - index });
  const { [docId]: _gone, ...views } = pane.views;
  return withPane(mv, index, () => ({
    docIds,
    views,
    activeDocId: pane.activeDocId === docId ? neighbour(pane.docIds, docId) : pane.activeDocId,
  }));
}

/**
 * Move a tab to another pane (the external editor Switch, or dragging a tab onto the other
 * tab row). The target pane shows it and becomes active; the source pane
 * keeps its other tabs, or unsplits when it had only this one. The source's
 * view of the document travels with it.
 */
export function moveDocToPane(mv, docId, from, to, { index = null } = {}) {
  if (!isSplit(mv) || from === to || !mv.panes[from] || !mv.panes[to]) return mv;
  if (!mv.panes[from].docIds.includes(docId)) return mv;
  const view = mv.panes[from].views[docId] || null;
  let next = withPane(mv, to, (pane) => {
    const ids = pane.docIds.filter((id) => id !== docId);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, ids.length)) : ids.length;
    ids.splice(at, 0, docId);
    return { docIds: ids, activeDocId: docId, views: view ? { ...pane.views, [docId]: view } : pane.views };
  });
  next = { ...next, activePane: to };
  return removeFromPane(next, from, docId);
}

/**
 * Follow the open documents: drop closed ones (a pane left empty unsplits),
 * put new ones in the active pane, and make the active pane show the active
 * document.
 */
export function reconcile(mv, docIds, activeDocId) {
  if (!isSplit(mv)) return mv;
  const open = new Set(docIds);
  let next = mv;
  for (let i = 0; i < next.panes.length && isSplit(next); i++) {
    for (const id of next.panes[i].docIds.filter((d) => !open.has(d))) {
      next = removeFromPane(next, i, id);
      if (!isSplit(next)) return next;
    }
  }
  const shown = new Set(next.panes.flatMap((p) => p.docIds));
  const fresh = docIds.filter((id) => !shown.has(id));
  if (fresh.length) {
    next = withPane(next, next.activePane, (pane) => ({ docIds: [...pane.docIds, ...fresh] }));
  }
  if (activeDocId != null && open.has(activeDocId) && next.panes[next.activePane].activeDocId !== activeDocId) {
    next = showInPane(next, next.activePane, activeDocId);
  }
  return next;
}

/** Sync on/off and mode. Sync Page keeps the current page offset. */
export function setSync(mv, { enabled = mv.sync.enabled, mode = mv.sync.mode, pageOffset = mv.sync.pageOffset } = {}) {
  const m = SYNC_MODES.includes(mode) ? mode : mv.sync.mode;
  const offset = Number.isInteger(pageOffset) ? pageOffset : 0;
  const sync = { enabled: !!enabled, mode: m, pageOffset: offset };
  const same = sync.enabled === mv.sync.enabled && sync.mode === mv.sync.mode && sync.pageOffset === mv.sync.pageOffset;
  return same ? mv : { ...mv, sync };
}

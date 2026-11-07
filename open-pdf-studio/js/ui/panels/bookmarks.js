import i18next from '../../i18n/config.js';
import { state, getActiveDocument } from '../../core/state.js';
import { goToPage } from '../../pdf/renderer.js';
import { markDocumentModified } from '../../ui/chrome/tabs.js';
import { isPdfAReadOnly } from '../../pdf/loader.js';
import {
  openDialog, setBookmarkTree as setTree, setBookmarkCountText as setCountText,
  setBookmarkEmptyMessage as setEmptyMessage, setBookmarkSelectedId as setSelectedId,
  setBookmarkToolbarDisabled as setToolbarDisabled,
} from '../../bridge.js';

let selectedBookmarkId = null;

// Initialize bookmarks - no-op, kept for callers
export function initBookmarks() {
  return;
}

// Load bookmarks from PDF outline (js/pdf/outline-bookmarks.js).
export { loadBookmarksFromPdf } from '../../pdf/outline-bookmarks.js';

// Build tree from flat array
function buildTree(bookmarks) {
  const map = {};
  const roots = [];
  for (const bm of bookmarks) {
    map[bm.id] = { ...bm, children: [] };
  }
  for (const bm of bookmarks) {
    const node = map[bm.id];
    if (bm.parentId && map[bm.parentId]) {
      map[bm.parentId].children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by sortOrder
  function sortChildren(nodes) {
    nodes.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    for (const n of nodes) {
      if (n.children.length > 0) sortChildren(n.children);
    }
  }
  sortChildren(roots);
  return roots;
}

// Convert tree nodes to component format (add hasChildren flag recursively)
function toComponentTree(nodes) {
  return nodes.map(node => ({
    id: node.id,
    title: node.title,
    page: node.page,
    bold: node.bold,
    italic: node.italic,
    color: node.color,
    expanded: node.expanded,
    hasChildren: node.children.length > 0,
    children: toComponentTree(node.children),
  }));
}

// Update the bookmarks list display by pushing to the store
export function updateBookmarksList() {
  const doc = getActiveDocument();
  if (!doc) {
    setTree([]);
    setCountText(i18next.t('leftPanel.bookmarksCount', { count: 0 }));
    setEmptyMessage(i18next.t('leftPanel.noDocumentOpen'));
    setSelectedId(null);
    updateToolbarState();
    return;
  }

  const bookmarks = doc.bookmarks || [];
  if (bookmarks.length === 0) {
    setTree([]);
    setCountText(i18next.t('leftPanel.bookmarksCount', { count: 0 }));
    setEmptyMessage(i18next.t('leftPanel.noBookmarks'));
    updateToolbarState();
    return;
  }

  const tree = buildTree(bookmarks);
  const componentTree = toComponentTree(tree);

  setTree(componentTree);
  setCountText(i18next.t('leftPanel.bookmarksCount', { count: bookmarks.length }));
  setEmptyMessage(null);
  updateToolbarState();
}

// Update toolbar button enabled state by pushing to store
function updateToolbarState() {
  const doc = getActiveDocument();
  const hasDoc = !!doc?.pdfDoc;
  const hasSelection = selectedBookmarkId !== null;
  const readOnly = isPdfAReadOnly();

  setToolbarDisabled({
    add: !hasDoc || readOnly,
    addChild: !hasDoc || !hasSelection || readOnly,
    edit: !hasDoc || !hasSelection || readOnly,
    delete: !hasDoc || !hasSelection || readOnly,
  });
}

// Generate unique id
function generateId() {
  return 'bm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// Select a bookmark and navigate
export function selectBookmark(id) {
  selectedBookmarkId = id;
  setSelectedId(id);
  updateToolbarState();
  // Navigate
  const doc = getActiveDocument();
  if (doc && doc.bookmarks) {
    const bm = doc.bookmarks.find(b => b.id === id);
    if (bm) navigateToBookmark(bm);
  }
}

// Clear bookmark selection
export function clearBookmarkSelection() {
  selectedBookmarkId = null;
  setSelectedId(null);
  updateToolbarState();
}

function navigateToBookmark(bm) {
  if (!bm || !getActiveDocument()?.pdfDoc) return;
  goToPage(bm.page);
}

// Toggle expand/collapse
export function toggleBookmarkExpand(id) {
  const doc = getActiveDocument();
  if (!doc || !doc.bookmarks) return;
  const bm = doc.bookmarks.find(b => b.id === id);
  if (!bm) return;
  bm.expanded = !bm.expanded;
  updateBookmarksList();
}

// Expand all
export function expandAll() {
  const doc = getActiveDocument();
  if (!doc || !doc.bookmarks) return;
  for (const bm of doc.bookmarks) bm.expanded = true;
  updateBookmarksList();
}

// Collapse all
export function collapseAll() {
  const doc = getActiveDocument();
  if (!doc || !doc.bookmarks) return;
  for (const bm of doc.bookmarks) bm.expanded = false;
  updateBookmarksList();
}

// Add bookmark at root
export async function addBookmark() {
  if (isPdfAReadOnly()) return;
  const doc = getActiveDocument();
  if (!doc) return;

  const result = await showBookmarkDialog('Add Bookmark', '', doc.currentPage);
  if (!result) return;

  if (!doc.bookmarks) doc.bookmarks = [];

  const bm = {
    id: generateId(),
    title: result.title,
    page: result.page,
    top: null,
    left: null,
    zoom: null,
    parentId: null,
    expanded: true,
    bold: false,
    italic: false,
    color: null,
    sortOrder: doc.bookmarks.filter(b => b.parentId === null).length,
    fromPdf: false,
  };

  doc.bookmarks.push(bm);
  selectedBookmarkId = bm.id;
  markDocumentModified();

  // Record undo
  const { recordAddBookmark } = await import('../../core/undo-manager.js');
  recordAddBookmark(bm);

  updateBookmarksList();
}

// Add child bookmark under selected
export async function addChildBookmark() {
  if (isPdfAReadOnly()) return;
  const doc = getActiveDocument();
  if (!doc || !selectedBookmarkId) return;

  const result = await showBookmarkDialog('Add Child Bookmark', '', doc.currentPage);
  if (!result) return;

  if (!doc.bookmarks) doc.bookmarks = [];

  const siblings = doc.bookmarks.filter(b => b.parentId === selectedBookmarkId);

  const bm = {
    id: generateId(),
    title: result.title,
    page: result.page,
    top: null,
    left: null,
    zoom: null,
    parentId: selectedBookmarkId,
    expanded: true,
    bold: false,
    italic: false,
    color: null,
    sortOrder: siblings.length,
    fromPdf: false,
  };

  // Ensure parent is expanded
  const parent = doc.bookmarks.find(b => b.id === selectedBookmarkId);
  if (parent) parent.expanded = true;

  doc.bookmarks.push(bm);
  selectedBookmarkId = bm.id;
  markDocumentModified();

  const { recordAddBookmark } = await import('../../core/undo-manager.js');
  recordAddBookmark(bm);

  updateBookmarksList();
}

// Edit selected bookmark
export async function editBookmark() {
  if (isPdfAReadOnly()) return;
  const doc = getActiveDocument();
  if (!doc || !selectedBookmarkId) return;

  const bm = doc.bookmarks.find(b => b.id === selectedBookmarkId);
  if (!bm) return;

  const result = await showBookmarkDialog('Edit Bookmark', bm.title, bm.page);
  if (!result) return;

  const oldState = { ...bm };
  bm.title = result.title;
  bm.page = result.page;
  markDocumentModified();

  const { recordModifyBookmark } = await import('../../core/undo-manager.js');
  recordModifyBookmark(bm.id, oldState, { ...bm });

  updateBookmarksList();
}

// Delete selected bookmark
export async function deleteBookmark() {
  if (isPdfAReadOnly()) return;
  const doc = getActiveDocument();
  if (!doc || !selectedBookmarkId) return;

  const bm = doc.bookmarks.find(b => b.id === selectedBookmarkId);
  if (!bm) return;

  // Check if bookmark has children
  const children = getDescendants(doc.bookmarks, bm.id);

  if (children.length > 0) {
    // Confirm with user
    let confirmed = false;
    if (window.__TAURI__?.dialog?.ask) {
      confirmed = await window.__TAURI__.dialog.ask(
        `Delete "${bm.title}" and its ${children.length} child bookmark${children.length !== 1 ? 's' : ''}?`,
        { title: 'Delete Bookmark', kind: 'warning' }
      );
    } else {
      confirmed = confirm(`Delete "${bm.title}" and its ${children.length} child bookmark(s)?`);
    }
    if (!confirmed) return;
  }

  // Collect all IDs to remove (bookmark + descendants)
  const idsToRemove = new Set([bm.id, ...children.map(c => c.id)]);
  const removedBookmarks = doc.bookmarks.filter(b => idsToRemove.has(b.id));

  doc.bookmarks = doc.bookmarks.filter(b => !idsToRemove.has(b.id));
  selectedBookmarkId = null;
  markDocumentModified();

  const { recordRemoveBookmark } = await import('../../core/undo-manager.js');
  recordRemoveBookmark(removedBookmarks);

  updateBookmarksList();
}

// Get all descendants of a bookmark
function getDescendants(bookmarks, parentId) {
  const result = [];
  const directChildren = bookmarks.filter(b => b.parentId === parentId);
  for (const child of directChildren) {
    result.push(child);
    result.push(...getDescendants(bookmarks, child.id));
  }
  return result;
}

function showBookmarkDialog(dialogTitle, currentTitle, currentPage) {
  return new Promise((resolve) => {
    const isEdit = dialogTitle.toLowerCase().includes('edit');
    openDialog('bookmark', {
      title: currentTitle,
      page: currentPage,
      isEdit,
      onOk: resolve,
    });
  });
}


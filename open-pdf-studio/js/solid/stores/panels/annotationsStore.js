import { createSignal } from 'solid-js';
import { readGroupBy, writeGroupBy } from '../../../ui/panels/markup-columns.js';

const [items, setItems] = createSignal([]);
const [countText, setCountText] = createSignal('0 annotations');
// Sheets whose markups are read, while some are not yet ({ loaded, total }),
// else null.
const [sheetsPending, setSheetsPending] = createSignal(null);
const [emptyMessage, setEmptyMessage] = createSignal('');
// Group By (the rows' grouping): Subject by default, as the external editor; the choice is
// remembered on this device.
const [sortMode, setSortModeRaw] = createSignal(readGroupBy());
function setSortMode(value) {
  const next = typeof value === 'function' ? value(sortMode()) : value;
  setSortModeRaw(next);
  writeGroupBy(next);
  return next;
}
// the external editor's eye in the Markups List header: hide every markup on the canvas
// (view only: printing, export and saving are not affected; see
// annotations/view-filters.js). Not remembered across restarts.
const [allMarkupsHidden, setAllMarkupsHiddenRaw] = createSignal(false);
// Column order is independent of Group By. It only changes the list rows,
// never PDF markup visibility or the current document selection.
const [columnSort, setColumnSort] = createSignal(null);
// Which markups the list shows: the sheet on screen ('current', the default)
// or every sheet ('all'). The choice is remembered.
const FILTER_KEY = 'ocudraw-markups-list-filter';
const storedFilter = (() => { try { return localStorage.getItem(FILTER_KEY); } catch { return null; } })();
const [filterMode, setFilterModeSignal] = createSignal(storedFilter === 'all' || storedFilter === 'current' ? storedFilter
  : (storedFilter && storedFilter !== 'null' ? storedFilter : 'current'));
const setFilterMode = (value) => {
  const next = setFilterModeSignal(value);
  if (next === 'all' || next === 'current') { try { localStorage.setItem(FILTER_KEY, next); } catch { /* private mode */ } }
  return next;
};
// Text search filters Markups List rows only; it does not hide canvas markups.
const [searchQuery, setSearchQuery] = createSignal('');
// Review-statussen (kleine letters: none/accepted/cancelled/completed/rejected)
// die de gebruiker via Tonen > Status heeft verborgen. Leeg = alles zichtbaar.
const [hiddenStatuses, setHiddenStatuses] = createSignal(new Set());
const [collapsedGroups, setCollapsedGroups] = createSignal(new Set());
// Markup groups (Group rows, docs/reference/editor/markups-list.md) shown open: closed by
// default, as in the external editor. Only shapes the list rows.
const [expandedMarkupGroups, setExpandedMarkupGroups] = createSignal(new Set());

function toggleMarkupGroup(id) {
  setExpandedMarkupGroups(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}
// Reply threads (markup ids) shown open under their markup row, and the
// markup whose inline reply box is open. Both only shape the list rows.
const [expandedThreads, setExpandedThreads] = createSignal(new Set());
const [replyTarget, setReplyTarget] = createSignal(null);
// Column header filters: { column: [hidden cell texts] } (markup-column-filter.js).
const [columnFilters, setColumnFilters] = createSignal({});

function toggleThread(id) {
  setExpandedThreads(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

function openThread(id) {
  if (expandedThreads().has(id)) return;
  setExpandedThreads(prev => new Set(prev).add(id));
}

// Afgeleide zichtbaarheid van het statusfilter — de ENIGE rekenplek, zodat
// lijst (annotations-list.js) en canvas (rendering/hit-test via
// annotations/view-filters.js) gegarandeerd dezelfde uitkomst zien (#333).
// Hoofdletter-ongevoelig ('Accepted' == 'accepted'); geen status telt als
// 'none'.
function isStatusHidden(ann) {
  const hidden = hiddenStatuses();
  if (hidden.size === 0) return false;
  return hidden.has(String((ann && ann.status) || 'none').toLowerCase());
}

function replaceHiddenStatuses(statusKeys) {
  setHiddenStatuses(new Set(statusKeys));
  // Canvas volgt het statusfilter (#333): laat een selectie die zojuist
  // onzichtbaar werd los (onzichtbaar = niet klik- of sleepbaar, dus ook
  // niet geselecteerd) en herteken de actieve weergave. Lazy imports om
  // laad-cycli met rendering.js/state.js te vermijden — zelfde patroon als
  // elementVisibilityStore.redraw().
  Promise.all([
    import('../../../core/state.js'),
    import('../../../annotations/rendering.js'),
  ]).then(([{ getActiveDocument }, m]) => {
    const doc = getActiveDocument();
    if (!doc) return;
    const prevSel = doc.selectedAnnotations || [];
    const sel = prevSel.filter(a => !isStatusHidden(a));
    if (sel.length !== prevSel.length) {
      doc.selectedAnnotations = sel;
      if (doc.selectedAnnotation && isStatusHidden(doc.selectedAnnotation)) {
        doc.selectedAnnotation = sel.length > 0 ? sel[sel.length - 1] : null;
      }
    }
    if (doc.viewMode === 'continuous') m.redrawContinuous();
    else m.redrawAnnotations();
  }).catch(() => { /* renderer nog niet geladen */ });
}

function toggleHiddenStatus(statusKey) {
  const next = new Set(hiddenStatuses());
  if (next.has(statusKey)) next.delete(statusKey);
  else next.add(statusKey);
  replaceHiddenStatuses(next);
}

function setAllMarkupsHidden(hidden) {
  setAllMarkupsHiddenRaw(!!hidden);
  // Like the status filter: a selection that just disappeared is let go,
  // then the canvas redraws.
  Promise.all([
    import('../../../core/state.js'),
    import('../../../annotations/rendering.js'),
  ]).then(([{ getActiveDocument }, m]) => {
    const doc = getActiveDocument();
    if (!doc) return;
    if (hidden && (doc.selectedAnnotations?.length || doc.selectedAnnotation)) {
      doc.selectedAnnotations = [];
      doc.selectedAnnotation = null;
    }
    if (doc.viewMode === 'continuous') m.redrawContinuous();
    else m.redrawAnnotations();
  }).catch(() => { /* renderer nog niet geladen */ });
}

function toggleGroup(groupKey) {
  setCollapsedGroups(prev => {
    const next = new Set(prev);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    return next;
  });
}

function expandGroup(groupKey) {
  setCollapsedGroups(prev => {
    if (!prev.has(groupKey)) return prev;
    const next = new Set(prev);
    next.delete(groupKey);
    return next;
  });
}

function expandAllGroups() {
  setCollapsedGroups(new Set());
}

function collapseAllGroups(allKeys) {
  setCollapsedGroups(new Set(allKeys));
}

export {
  items, setItems,
  countText, setCountText,
  sheetsPending, setSheetsPending,
  emptyMessage, setEmptyMessage,
  sortMode, setSortMode,
  columnSort, setColumnSort,
  filterMode, setFilterMode,
  searchQuery, setSearchQuery,
  hiddenStatuses, toggleHiddenStatus, replaceHiddenStatuses, isStatusHidden,
  allMarkupsHidden, setAllMarkupsHidden,
  collapsedGroups, toggleGroup, expandGroup, expandAllGroups, collapseAllGroups,
  expandedMarkupGroups, setExpandedMarkupGroups, toggleMarkupGroup,
  expandedThreads, setExpandedThreads, toggleThread, openThread,
  replyTarget, setReplyTarget,
  columnFilters, setColumnFilters,
};

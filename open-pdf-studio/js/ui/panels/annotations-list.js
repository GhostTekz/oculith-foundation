import { perfRecord } from '../../core/perf.js';
import { edition } from '../../editions/active.js';
import { collectAddonListGroups } from './addon-list-groups.js';
import { $PROXY } from 'solid-js';
import { $RAW } from 'solid-js/store';
import i18next from '../../i18n/config.js';
import { state, getActiveDocument, isSelected, getAnnotationBounds, addToSelection, removeFromSelection } from '../../core/state.js';
import { getTypeDisplayName, getAnnotationDisplayName, createDateFormatter } from '../../utils/helpers.js';
import {
  withoutFoldedChildren, listPreview, expandCorrectionGroups, replaceParentOf,
} from '../../annotations/corrections/model.js';
import { showProperties, showMultiSelectionProperties } from './properties-panel.js';
import { goToPage } from '../../pdf/renderer.js';
import { annotationSheetsLoaded } from '../../pdf/loader.js';
import { viewport, markAnchored } from '../../pdf/pdf-viewport.js';
import { stopAlleWielScrollers } from '../../pdf/wiel-scroll.js';
import { redrawAnnotations, redrawContinuous } from '../../annotations/rendering.js';
import { paginaNaarWeergave } from '../../pdf/weergave-ruimte.js';
import { switchLeftPanelTab } from './left-panel.js';
import { matchesMarkupSearch } from './markup-search.js';
import { memoizeMarkupSortValue, sortMarkupRows } from './markup-column-sort.js';
import { markupSubjectLabel } from './markup-columns.js';
import { choiceColumn, choiceValue } from '../../annotations/custom-choice-column.js';
import { numberColumn, numberValue, numberText } from '../../annotations/custom-number-column.js';
import { formulaColumn, formulaNumberSourceValue, formulaScaledValue, formulaText } from '../../annotations/custom-formula-column.js';
import { checkmarkColumn, checkmarkValue, checkmarkRank, checkmarkText } from '../../annotations/custom-checkmark-column.js';
import { expressionResultsCache, expressionColumnIndex, EXPRESSION_COLUMN_KEYS } from '../../annotations/formula-captions.js';
import { columnFilterPredicate, columnFilterValues, FILTERABLE_COLUMNS } from './markup-column-filter.js';
import { markupSpacePather, collectSpaces } from '../../spaces/model.js';
import { markupReplies, newReply } from '../../annotations/markup-replies.js';
import { commitAnnotationMutation } from '../../annotations/mutations.js';
import { attachmentCount, attachmentNames } from '../../annotations/capture.js';
import { layerOf, layerIdOf, layerDisplayName, isLayerHidden } from '../../annotations/annotatie-lagen.js';
import { recordModify, recordBulkModify } from '../../core/undo-manager.js';
import {
  groupPathOf, correctionGroupIds, membersOfGroup, groupLevel, addToGroup, groupTotals, groupTotalsText, categoryEyeState, toggleCategoryHidden,
} from '../../annotations/markup-groups.js';
import { cloneAnnotation } from '../../annotations/factory.js';
import { statusKey, statusLabel, statusColor, statusHistory, applyStatusChange } from '../../annotations/markup-status.js';
import { fieldColumnDefined, fieldValue, runMarkupFieldHooks } from '../../annotations/markup-fields.js';
import {
  expandedThreads, replyTarget, openThread, setReplyTarget, columnFilters, setSheetsPending,
  expandGroup, setExpandedMarkupGroups, items as markupListItems,
  collapsedGroups, expandedMarkupGroups,
} from '../../solid/stores/panels/annotationsStore.js';
import {
  isPanelShown, setLeftPanelCollapsed,
  setAnnotationItems as setItems, setAnnotationCountText as setCountText,
  setAnnotationEmptyMessage as setEmptyMessage, annotationSortMode as sortMode,
  annotationColumnSort as columnSort,
  annotationFilterMode as filterMode, setAnnotationFilterMode as setFilterMode,
  annotationSearchQuery as searchQuery,
  isAnnotationStatusHidden,
  refreshAnnotationLayers,
} from '../../bridge.js';


// Toggle the Markups List (F11, ribbon): it lives in a panel host (the bottom
// one by default), so showing it opens that host and toggling it off
// collapses the host again.
export function toggleAnnotationsListPanel() {
  if (isPanelShown('annotations')) {
    hideAnnotationsListPanel();
  } else {
    // Bring the Markups List up (also expands its host if collapsed)
    switchLeftPanelTab('annotations');
  }
}

// Show annotations list panel
export function showAnnotationsListPanel() {
  switchLeftPanelTab('annotations');
}

// Hide annotations list panel (collapse the host it sits in)
export function hideAnnotationsListPanel() {
  if (!isPanelShown('annotations')) return;
  switchLeftPanelTab('annotations');
  setLeftPanelCollapsed(true);
}

// The default markup layer's name as the Layers panel shows it; the Markups
// List component sets the translation (this module has no i18n).
let defaultLayerLabel = 'Default';
export function setDefaultLayerLabel(name) {
  if (typeof name === 'string' && name.trim()) defaultLayerLabel = name;
}
// Group By Group: the section of markups in no group, and a group's name
// when it has none (set by the Markups List from its translations).
let noGroupLabel = '(No Group)';
let defaultGroupLabel = 'Group';
export function setGroupLabels({ none, group } = {}) {
  if (none) noGroupLabel = none;
  if (group) defaultGroupLabel = group;
}
let noSpaceLabel = '(No Space)';
// A loaded add-on may add a group level and handle selection of its group rows.
let extensionGrouping = null;
export function setExtensionListGrouping(hooks) { extensionGrouping = hooks || null; }
let addonGroupOwners = new Map();
const extensionRowsSeen = new Set();
function openNewExtensionRows(paths) {
  if (!paths?.size) return;
  const fresh = [];
  for (const level of new Set(paths.values())) {
    if (!level?.id || extensionRowsSeen.has(level.id)) continue;
    extensionRowsSeen.add(level.id); fresh.push(level.id);
  }
  if (fresh.length) setTimeout(() => setExpandedMarkupGroups((prev) => new Set([...prev, ...fresh])), 0);
}
/** The translated "(No Space)" group header (set by the Markups List). */
export function setNoSpaceLabel(label) { if (label) noSpaceLabel = label; }

/**
 * (ann) → Space path ('' outside every space), as the list shows it; null
 * when the document has no spaces (summaries then leave the column out).
 */
export function markupSpaceNamer(doc) {
  if (!collectSpaces(doc).length) return null;
  return markupSpacePather(doc, getAnnotationBounds);
}

/** The markup layer name a markup is on, as the Layers panel shows it. */
export function markupLayerName(doc, ann) {
  // During a list build the name is looked up once per layer: layerOf()
  // normalises the document's whole layer list on every call, and the build
  // asks per markup, several times (sort, group, row, search).
  if (layerNameMemo && layerNameMemo.doc === doc) {
    const id = layerIdOf(ann);
    let name = layerNameMemo.names.get(id);
    if (name === undefined) {
      name = layerDisplayName(layerOf(doc, ann), defaultLayerLabel) || '';
      layerNameMemo.names.set(id, name);
    }
    return name;
  }
  return layerDisplayName(layerOf(doc, ann), defaultLayerLabel) || '';
}
// Layer names of the list build in progress (see updateAnnotationsList).
let layerNameMemo = null;

// PDF page labels (/PageLabels, e.g. "A-101" or "iv") per document, read once
// from PDF.js; until they are read, and for a PDF without labels, a page's
// label is its number.
const pageLabelCache = new WeakMap();
function pageLabelsOf(doc) {
  if (!doc?.pdfDoc || typeof doc.pdfDoc.getPageLabels !== 'function') return null;
  const cached = pageLabelCache.get(doc.pdfDoc);
  if (cached) return cached.labels;
  const entry = { labels: null };
  pageLabelCache.set(doc.pdfDoc, entry);
  Promise.resolve().then(() => doc.pdfDoc.getPageLabels()).then(labels => {
    if (!Array.isArray(labels) || !labels.some(label => label)) return;
    entry.labels = labels;
    if (state.documents[state.activeDocumentIndex] === doc) updateAnnotationsList();
  }).catch(() => { /* A broken label tree leaves page numbers. */ });
  return null;
}
/** A page's label as the PDF names it, else its number. */
export function markupPageLabel(doc, page) {
  const label = pageLabelsOf(doc)?.[Number(page) - 1];
  return typeof label === 'string' && label.trim() ? label : String(page ?? '');
}

// The custom column definitions the list shows, validated once per build.
function columnDefinitions(doc) {
  const definedChoice = choiceColumn(doc?.markupChoiceColumn, doc?.markupTextColumnName);
  const definedNumber = numberColumn(doc?.markupNumberColumn, doc?.markupTextColumnName, definedChoice?.name);
  const definedSecondNumber = numberColumn(doc?.markupNumberColumn2);
  const definedCheckmark = checkmarkColumn(doc?.markupCheckmarkColumn, doc?.markupTextColumnName,
    definedChoice?.name, definedNumber?.name);
  return {
    definedChoice, definedNumber, definedSecondNumber, definedCheckmark,
    // Space column (Spaces panel): one resolver per list build.
    spaceOf: markupSpacePather(doc, getAnnotationBounds),
    definedSecondChoice: choiceColumn(doc?.markupChoiceColumn2),
    definedFormula: formulaColumn(doc?.markupFormulaColumn, definedNumber, doc?.markupTextColumnName,
      definedChoice?.name, definedCheckmark?.name, definedChoice, definedSecondNumber),
    // Formula columns with expressions (formula-captions.js), evaluated once per markup.
    expressionResults: expressionResultsCache(doc),
  };
}

// Row fields of the Formula columns: exprFormula1..5 (text) and their warnings.
function expressionFields(ann, expressionResults) {
  const fields = {};
  if (!expressionResults) return fields;
  expressionResults(ann).forEach((result, i) => {
    fields[EXPRESSION_COLUMN_KEYS[i]] = result.text;
    fields[`${EXPRESSION_COLUMN_KEYS[i]}Warning`] = result.warning || '';
  });
  return fields;
}

// A cell's text as the list shows it: what a column filter matches on.
function columnTextFor(doc, byId, defs) {
  const { definedChoice, definedSecondChoice, definedNumber, definedSecondNumber, definedCheckmark, definedFormula, spaceOf } = defs;
  return (ann, column) => {
    switch (column) {
      case 'page': return String(ann.page ?? '');
      case 'type': return getAnnotationDisplayName(ann, byId) || '';
      case 'comment': return listPreview(ann, byId) || ann.text || '';
      case 'status': return statusKey(ann.status) !== 'none' ? statusLabel(ann.status, doc?.markupStatusSet) : '';
      case 'author': return ann.author || 'User';
      case 'subject': return ann.subject || '';
      case 'customText': return doc?.markupTextColumnName ? (ann.markupTextValue || '') : '';
      case 'customText2': return doc?.markupTextColumn2Name ? (ann.markupTextValue2 || '') : '';
      case 'customChoice': return choiceValue(ann.markupChoiceValue, definedChoice?.options);
      case 'customChoice2': return choiceValue(ann.markupChoiceValue2, definedSecondChoice?.options);
      case 'customNumber': return definedNumber ? numberText(ann.markupNumberValue) : '';
      case 'customNumber2': return definedSecondNumber ? numberText(ann.markupNumberValue2) : '';
      case 'customFormula': return formulaText(formulaNumberSourceValue(ann, definedFormula), definedFormula,
        ann.markupChoiceValue, definedChoice);
      case 'customCheckmark': return definedCheckmark ? checkmarkText(ann.markupCheckmarkValue) : '';
      case 'layer': return markupLayerName(doc, ann);
      case 'pageLabel': return markupPageLabel(doc, ann.page);
      case 'attachments': return attachmentNames(ann).join('; ');
      case 'space': return spaceOf(ann);
      default: {
        const index = expressionColumnIndex(column);
        return index >= 0 ? (defs.expressionResults?.(ann)[index]?.text || '') : '';
      }
    }
  };
}

/**
 * The values a column filter offers: every distinct cell text among the
 * document's markups (as the list folds them), with counts.
 */
export function markupColumnFilterValues(column) {
  if (!FILTERABLE_COLUMNS.includes(column)) return [];
  const doc = state.documents[state.activeDocumentIndex];
  const annotations = (doc && rawOf(doc.annotations)) || [];
  const byId = new Map(annotations.map(a => [a.id, a]));
  const markups = withoutFoldedChildren(annotations.filter(a => a.type !== 'scaleRegion'), byId);
  return columnFilterValues(markups, column, columnTextFor(doc, byId, columnDefinitions(doc)));
}

// The list is only built while it can be seen (#491). Every full redraw calls
// updateAnnotationsList; with the panel hidden that sorted, grouped and
// formatted every annotation and made the (always mounted) panel recreate all
// its rows, for nothing. A hidden list is marked stale instead and rebuilt as
// soon as it is shown (AnnotationsPanel calls refreshAnnotationsListIfStale);
// only its count is kept current, for the Markups List dock header.
let listStale = false;
// The markups the list shows, in row order once built (summaries use them).
let listedMarkups = [];
/** The markups the Markups List currently shows (filters applied), in list order. */
export function currentListMarkups() {
  if (listStale && listVisible()) updateAnnotationsList();
  return storeObjects(listedMarkups);
}

// The build reads the markups raw (not through the store's proxies); its
// callers get the store's objects, which a selection holds.
function storeObjects(list) {
  let byRaw = null;
  return list.map((ann) => {
    const proxy = ann && ann[$PROXY];
    if (proxy) return proxy;
    if (!byRaw) {
      byRaw = new Map();
      for (const item of state.documents[state.activeDocumentIndex]?.annotations || []) byRaw.set(rawOf(item), item);
    }
    return byRaw.get(ann) || ann;
  });
}

function listVisible() {
  return isPanelShown('annotations');
}

/** Rebuild the list if an update came in while it was hidden. */
export function refreshAnnotationsListIfStale() {
  if (listStale && listVisible()) updateAnnotationsList();
}

// The rows of the previous build by key. A row whose content did not change
// is handed back as the same object, so the list component keeps its DOM row
// instead of recreating every row on each update (#491).
let previousItems = new Map();

function sameItem(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

// A markup's last change (else creation) in ms, for the Date column sort.
function markupTime(ann) {
  const time = Date.parse(ann.modifiedAt || ann.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

// Update annotations list - pushes data to the Solid.js store
export function updateAnnotationsList(filterValue) {
  const perfT0 = performance.now();
  try { return updateAnnotationsListNow(filterValue); } finally { perfRecord('list.build', performance.now() - perfT0); }
}

function updateAnnotationsListNow(filterValue) {
  layerNameMemo = { doc: state.documents[state.activeDocumentIndex], names: new Map() };
  try {
    lastBuild = { token: listInputsToken(), at: Date.now() };
    buildAnnotationsList(filterValue);
  } finally {
    layerNameMemo = null;
  }
}

// Every full canvas redraw (a click, a selection, a page render) asked for a
// list build: O(all markups) through the store's proxies, with filters,
// layer counts and element types, even while the list is hidden; on a
// drawing with tens of thousands of markups 100 ms and more per click. The
// redraw path now asks updateAnnotationsListIfChanged, which builds only when
// the markups (read raw), the selection, the page or the list's own
// settings changed. Callers that change something else the list shows call
// updateAnnotationsList as before; as a safety net a skipped request is
// followed by one build two seconds later.
let lastBuild = null;
let trailingTimer = 0;
const TRAILING_MS = 2000;

const rawOf = (value) => (value && value[$RAW]) || value;
function mixStr(h, s) {
  h = Math.imul(h ^ s.length, 0x01000193) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
function mixNum(h, n) {
  return Math.imul(h ^ ((Number.isFinite(n) ? Math.round(n * 100) : 0x7fffffff) | 0), 0x01000193) >>> 0;
}

function listInputsToken() {
  const doc = state.documents[state.activeDocumentIndex];
  let h = 0x811c9dc5;
  h = mixNum(h, state.activeDocumentIndex);
  if (!doc) return String(h);
  h = mixNum(h, doc.currentPage || 0);
  const list = rawOf(doc.annotations) || [];
  h = mixNum(h, list.length);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== 'object') continue;
    h = mixNum(h, i);
    for (const k in a) {
      const v = a[k];
      if (typeof v === 'string') h = mixStr(h, v);
      else if (typeof v === 'number') h = mixNum(h, v);
      else if (typeof v === 'boolean') h = mixNum(h, v ? 1 : 2);
      else if (Array.isArray(v)) h = mixNum(h, v.length + 3);
      else if (v == null) h = mixNum(h, 4);
      else h = mixNum(h, 5);
    }
  }
  for (const a of rawOf(doc.selectedAnnotations) || []) h = mixStr(h, String(a?.id || ''));
  try {
    const plain = (v) => (v instanceof Set || v instanceof Map ? [...v] : v);
    h = mixStr(h, JSON.stringify([filterMode(), sortMode(), columnSort(), columnFilters(), searchQuery(), expandedThreads(), replyTarget()?.id ?? replyTarget() ?? null, collapsedGroups(), expandedMarkupGroups()].map(plain)));
  } catch { h = mixNum(h, Date.now()); }
  return String(h);
}

export function updateAnnotationsListIfChanged() {
  if (!lastBuild || listInputsToken() !== lastBuild.token) {
    if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = 0; }
    updateAnnotationsList();
    return;
  }
  if (trailingTimer) return;
  const at = lastBuild.at;
  trailingTimer = setTimeout(() => {
    trailingTimer = 0;
    if (lastBuild && lastBuild.at === at) updateAnnotationsList();
  }, TRAILING_MS);
}

// Sorting compares with collators made once: localeCompare() sets up the
// locale's collation again on every call.
const textCollator = new Intl.Collator();
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Sorts `list` in place by keys worked out once per markup, not twice per
// comparison. `compare` gets two { ann, page, created, k1, k2 } entries.
function sortByKeys(list, keysOf, compare) {
  const keyed = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const ann = list[i];
    const entry = keysOf(ann);
    entry.ann = ann;
    entry.page = ann.page;
    entry.created = new Date(ann.createdAt).getTime();
    keyed[i] = entry;
  }
  keyed.sort(compare);
  for (let i = 0; i < keyed.length; i++) list[i] = keyed[i].ann;
  return list;
}
const pageThenDate = (a, b) => {
  if (a.page !== b.page) return a.page - b.page;
  return a.created - b.created;
};
const byTextKey = (a, b) => (a.k1 !== b.k1 ? textCollator.compare(a.k1, b.k1) : pageThenDate(a, b));
// '' (outside every space, in no group) sorts last.
const byNaturalKeyEmptyLast = (a, b) => (a.k1 !== b.k1
  ? (a.k1 === '' ? 1 : b.k1 === '' ? -1 : naturalCollator.compare(a.k1, b.k1))
  : pageThenDate(a, b));

// The Element Visibility panel (types and counts) and the Layers panel
// (markups per layer, #468, and the selection's layer) follow the list
// build: it is the canonical "markups changed" call (add, delete, document
// switch). Both count every markup through the store, so each is refreshed
// only when what it shows changed.
let countedPanels = null;
function refreshCountingPanels(doc, annotations) {
  const types = new Map();
  const layers = new Map();
  for (const a of annotations) {
    if (!a) continue;
    types.set(a.type, (types.get(a.type) || 0) + 1);
    const layer = layerIdOf(a);
    layers.set(layer, (layers.get(layer) || 0) + 1);
  }
  const selected = [];
  for (const a of rawOf(doc?.selectedAnnotations) || []) selected.push(a?.id ?? null, layerIdOf(a));
  const single = rawOf(doc?.selectedAnnotation);
  let typesToken;
  let layersToken;
  try {
    typesToken = JSON.stringify([...types]);
    layersToken = JSON.stringify([[...layers], rawOf(doc?.annotationLayers) ?? null, doc?.currentLayerId ?? null,
      selected, single ? [single.id ?? null, layerIdOf(single)] : null]);
  } catch {
    typesToken = layersToken = String(Math.random());
  }
  // By id, not the document itself: this outlives a closed document.
  const docKey = doc?.id ?? null;
  const previous = countedPanels;
  countedPanels = { docKey, typesToken, layersToken };
  const sameDoc = previous && previous.docKey === docKey;
  if (!sameDoc || previous.typesToken !== typesToken) {
    import('../../solid/stores/elementVisibilityStore.js')
      .then(m => m.refreshElementTypes())
      .catch(() => { /* store nog niet geladen */ });
  }
  if (!sameDoc || previous.layersToken !== layersToken) refreshAnnotationLayers();
}

// One date formatter for every build of a document: it keeps each date text
// it made (a list rebuilt after one change formats nothing again).
// Kept by document id: holding the document itself kept a closed one, with
// its markups and its PDF.js document, until another list was built.
let dateFormatter = null;
let dateFormatterDocId = null;

// Markup rows by markup (the raw object), with what each was made from. A
// markup whose fields and row context are unchanged keeps its row object, so
// the build does not remake ~45 fields per markup and the list component
// keeps its DOM row.
let rowCache = new WeakMap();

const floatView = new Float64Array(1);
const floatWords = new Uint32Array(floatView.buffer);
function mixExact(h, n) {
  floatView[0] = n;
  h = Math.imul(h ^ floatWords[0], 0x01000193) >>> 0;
  return Math.imul(h ^ floatWords[1], 0x01000193) >>> 0;
}
function mixValue(h, v, depth) {
  switch (typeof v) {
    case 'string':
      // Image data counts by its length and ends.
      if (v.length > 256 && (depth > 0 || v.startsWith('data:'))) {
        return mixStr(mixExact(h, v.length), v.slice(0, 64) + v.slice(-64));
      }
      return mixStr(h, v);
    case 'number': return mixExact(h, v);
    case 'boolean': return mixExact(h, v ? -1.25 : -1.5);
    case 'undefined': return mixExact(h, -2.5);
    case 'object': {
      if (v === null) return mixExact(h, -3.5);
      if (depth > 1) return mixExact(h, -4.5);
      if (Array.isArray(v)) {
        h = mixExact(h, v.length);
        for (let i = 0; i < v.length; i++) h = mixValue(h, v[i], depth + 1);
        return h;
      }
      for (const key in v) h = mixValue(mixStr(h, key), v[key], depth + 1);
      return h;
    }
    default: return mixExact(h, -5.5);
  }
}
// A markup's own fields, two levels deep (replies, status history, photos
// and their entries), as a number.
function markupFieldsHash(ann) {
  let h = 0x811c9dc5;
  for (const key in ann) h = mixValue(mixStr(h, key), ann[key], 0);
  return h;
}

function buildAnnotationsList(filterValue) {
  // Use provided filter or fall back to stored filter mode
  if (filterValue !== undefined) {
    setFilterMode(filterValue);
  }
  const activeFilter = filterValue !== undefined ? filterValue : filterMode();

  const doc = state.documents[state.activeDocumentIndex];
  // The markups are read raw, not through the store's proxies: the build only
  // reads, and a proxy read per field per markup was most of its time on a
  // large drawing. currentListMarkups hands out the store's objects.
  const annotations = (doc && rawOf(doc.annotations)) || [];
  refreshCountingPanels(doc, annotations);
  const defs = columnDefinitions(doc);
  const { definedChoice, definedSecondChoice, definedNumber, definedSecondNumber, definedCheckmark,
    definedFormula, spaceOf } = defs;

  // Filter annotations, in one pass:
  // - Benoemde viewports (scaleRegion) zijn geen markeringen: ze staan in het
  //   meetpaneel, niet in de markeringslijst.
  // - Statusfilter (Tonen > Status): verberg annotaties waarvan de
  //   review-status door de gebruiker is uitgevinkt. De berekening leeft op
  //   ÉÉN plek (annotationsStore.isStatusHidden) zodat lijst en canvas (#333)
  //   gegarandeerd hetzelfde filteren.
  const currentPage = doc ? doc.currentPage : 1;
  let filteredAnnotations = annotations.filter(a => a.type !== 'scaleRegion'
    && (activeFilter === 'current' ? a.page === currentPage : activeFilter === 'all' || a.type === activeFilter)
    && !isAnnotationStatusHidden(a));

  // Proefleescorrecties (#508): de doorhaling van een vervanging staat in de
  // regel van haar invoegteken, met de naam en voorvertoning van de correctie.
  const byId = new Map(annotations.map(a => [a.id, a]));
  // Per build: names, group paths and layer visibility are asked for more
  // than once per markup (sort, group, row, eyes); work each out once.
  const nameMemo = new Map();
  const displayName = (ann) => {
    let name = nameMemo.get(ann);
    if (name === undefined) { name = getAnnotationDisplayName(ann, byId); nameMemo.set(ann, name); }
    return name;
  };
  const columnValue = (ann, column) => {
    switch (column) {
      case 'page': return Number(ann.page) || 0;
      case 'type': return displayName(ann) || '';
      case 'comment': return listPreview(ann, byId) || ann.text || '';
      case 'status': return statusKey(ann.status) !== 'none' ? statusLabel(ann.status, doc?.markupStatusSet) : '';
      case 'author': return ann.author || 'User';
      case 'subject': return markupSubjectLabel(ann.subject, displayName(ann));
      case 'lock': return ann.locked ? 1 : 0;
      case 'date': return markupTime(ann);
      case 'color': return String(ann.color || ann.strokeColor || '#000').toLowerCase();
      case 'customText': return ann.markupTextValue || '';
      case 'customText2': return ann.markupTextValue2 || '';
      case 'customChoice': return choiceValue(ann.markupChoiceValue, definedChoice?.options);
      case 'customChoice2': return choiceValue(ann.markupChoiceValue2, definedSecondChoice?.options);
      case 'customNumber': return definedNumber ? numberValue(ann.markupNumberValue) : null;
      case 'customNumber2': return definedSecondNumber ? numberValue(ann.markupNumberValue2) : null;
      case 'customFormula': return formulaScaledValue(formulaNumberSourceValue(ann, definedFormula), definedFormula,
        ann.markupChoiceValue, definedChoice);
      case 'customCheckmark': return definedCheckmark ? checkmarkRank(checkmarkValue(ann.markupCheckmarkValue)) : 0;
      case 'layer': return markupLayerName(doc, ann);
      case 'pageLabel': return markupPageLabel(doc, ann.page);
      case 'attachments': return attachmentCount(ann);
      case 'space': return spaceOf(ann);
      default: {
        const index = expressionColumnIndex(column);
        return index >= 0 ? (defs.expressionResults?.(ann)[index]?.value ?? null) : '';
      }
    }
  };
  filteredAnnotations = withoutFoldedChildren(filteredAnnotations, byId);
  // Column filters (header checklists): the cell text as the list shows it.
  const columnFilterMatch = columnFilterPredicate(columnFilters(), columnTextFor(doc, byId, defs));
  if (columnFilterMatch) filteredAnnotations = filteredAnnotations.filter(columnFilterMatch);
  if (searchQuery().trim()) {
    filteredAnnotations = filteredAnnotations.filter(a =>
      matchesMarkupSearch(a, searchQuery(),
        `${displayName(a)} ${listPreview(a, byId) || ''}`,
        [doc?.markupTextColumnName ? a.markupTextValue : '',
          doc?.markupTextColumn2Name ? a.markupTextValue2 : '',
          definedChoice ? choiceValue(a.markupChoiceValue, definedChoice.options) : '',
          definedSecondChoice ? choiceValue(a.markupChoiceValue2, definedSecondChoice.options) : '',
          definedNumber ? numberText(a.markupNumberValue) : '',
          definedSecondNumber ? numberText(a.markupNumberValue2) : '',
          markupLayerName(doc, a), markupPageLabel(doc, a.page), spaceOf(a)]));
  }

  // Update count text. The Markups List dock shows it in its header while
  // the list is collapsed, so it is kept current even when the rows are not
  // built.
  setCountText(`${filteredAnnotations.length} annotation${filteredAnnotations.length !== 1 ? 's' : ''}`);
  // A large drawing reads a sheet's markups when it is shown: say how many
  // sheets the list covers until all are read.
  try {
    const sheets = annotationSheetsLoaded(doc);
    setSheetsPending(doc && sheets.loaded < sheets.total ? sheets : null);
  } catch { setSheetsPending(null); }

  listedMarkups = filteredAnnotations;
  // Sorting, grouping and formatting the rows waits until the list is shown.
  if (!listVisible()) {
    listStale = true;
    return;
  }
  listStale = false;

  // Sort and group based on current sort mode
  const currentSort = sortMode();
  const activeColumnSort = columnSort();

  const groupCg = correctionGroupIds(annotations);
  const pathMemo = new Map();
  let legacyPaths = null; try { legacyPaths = extensionGrouping?.paths(doc, annotations) || null; } catch { legacyPaths = null; }
  const addonGroups = collectAddonListGroups(edition.listGroupings, doc, annotations, legacyPaths,
    (id) => extensionGrouping?.ownsGroup?.(id) === true);
  const extensionPaths = addonGroups.paths;
  addonGroupOwners = addonGroups.owners;
  openNewExtensionRows(extensionPaths);
  const pathOf = (ann) => {
    let path = pathMemo.get(ann);
    if (path === undefined && extensionPaths?.has(ann)) { path = [extensionPaths.get(ann), ...groupPathOf(ann, groupCg)]; pathMemo.set(ann, path); }
    if (path === undefined) { path = groupPathOf(ann, groupCg); pathMemo.set(ann, path); }
    return path;
  };
  const groupNameKey = (ann) => {
    const top = pathOf(ann)[0];
    return top ? (top.name || defaultGroupLabel) : '';
  };
  // Sort keys are worked out once per markup (sortByKeys).
  const typeNames = new Map();
  const typeName = (type) => {
    let name = typeNames.get(type);
    if (name === undefined) { name = getTypeDisplayName(type); typeNames.set(type, name); }
    return name;
  };
  const getLastStatusAuthor = (ann) => {
    if (ann.replies && ann.replies.length > 0) {
      for (let i = ann.replies.length - 1; i >= 0; i--) {
        if (ann.replies[i].author) return ann.replies[i].author;
      }
    }
    return ann.author || 'User';
  };
  const statusOf = ann => (ann.status || 'none').toLowerCase();
  const authorOf = ann => (ann.author || 'User').toLowerCase();

  if (currentSort === 'type') {
    sortByKeys(filteredAnnotations, a => ({ k1: typeName(a.type) }), byTextKey);
  } else if (currentSort === 'modifiedDate') {
    sortByKeys(filteredAnnotations, a => ({ k1: new Date(a.modifiedAt).getTime() }), (a, b) => b.k1 - a.k1);
  } else if (currentSort === 'creationDate') {
    sortByKeys(filteredAnnotations, () => ({}), (a, b) => b.created - a.created);
  } else if (currentSort === 'author') {
    sortByKeys(filteredAnnotations, a => ({ k1: authorOf(a) }), byTextKey);
  } else if (currentSort === 'color') {
    sortByKeys(filteredAnnotations, a => ({ k1: (a.color || a.strokeColor || '#000').toLowerCase() }), byTextKey);
  } else if (currentSort === 'subject') {
    sortByKeys(filteredAnnotations, a => ({ k1: markupSubjectLabel(a.subject, displayName(a)).toLowerCase() }), byTextKey);
  } else if (currentSort === 'status') {
    sortByKeys(filteredAnnotations, a => ({ k1: statusOf(a) }), byTextKey);
  } else if (currentSort === 'statusAndAuthor') {
    sortByKeys(filteredAnnotations, a => ({ k1: statusOf(a), k2: authorOf(a) }), (a, b) => {
      if (a.k1 !== b.k1) return textCollator.compare(a.k1, b.k1);
      if (a.k2 !== b.k2) return textCollator.compare(a.k2, b.k2);
      return pageThenDate(a, b);
    });
  } else if (currentSort === 'lastStatusAuthor') {
    sortByKeys(filteredAnnotations, a => ({ k1: getLastStatusAuthor(a).toLowerCase() }), byTextKey);
  } else if (currentSort === 'layer') {
    // Group by markup layer (docs/reference/editor/layers.md): by layer name.
    sortByKeys(filteredAnnotations, a => ({ k1: markupLayerName(doc, a).toLowerCase() }), byTextKey);
  } else if (currentSort === 'markupGroup') {
    sortByKeys(filteredAnnotations, a => ({ k1: groupNameKey(a) }), byNaturalKeyEmptyLast);
  } else if (currentSort === 'space') {
    sortByKeys(filteredAnnotations, a => ({ k1: spaceOf(a) }), byNaturalKeyEmptyLast);
  } else {
    // Default: sort by page
    sortByKeys(filteredAnnotations, () => ({}), pageThenDate);
  }

  if (filteredAnnotations.length === 0) {
    setEmptyMessage('No annotations found');
    setItems([]);
    toonSelectieInLijst(doc, []);
    return;
  }

  // Clear empty message so the list renders
  setEmptyMessage('');

  // One date formatter and one selection set for the whole list, instead of
  // new locale formatters and a scan of the selection per annotation.
  // Match by id. A canvas click can hold a different object than the row
  // (a proxy, or the array replaced by undo) and an identity check then
  // leaves every row unselected.
  if (!dateFormatter || dateFormatterDocId !== (doc?.id ?? null)) {
    dateFormatter = createDateFormatter();
    dateFormatterDocId = doc?.id ?? null;
    rowCache = new WeakMap();
  }
  const formatDate = dateFormatter;
  const selectedIds = new Set();
  for (const ann of (doc && rawOf(doc.selectedAnnotations)) || []) {
    if (ann && ann.id != null) selectedIds.add(String(ann.id));
  }
  const openThreads = expandedThreads();
  const replyingTo = replyTarget();
  const nextItems = new Map();
  const reuse = (key, item) => {
    if (nextItems.has(key)) return item; // a second row with the same id keeps its own object
    const previous = previousItems.get(key);
    const row = previous && sameItem(previous, item) ? previous : item;
    nextItems.set(key, row);
    return row;
  };

  // What every markup row depends on besides its markup and its place: the
  // language, the status set and the custom column definitions.
  let rowContext;
  try {
    rowContext = JSON.stringify([i18next.language ?? null, rawOf(doc?.markupStatusSet) ?? null,
      doc?.markupTextColumnName ?? null, doc?.markupTextColumn2Name ?? null, definedChoice ?? null,
      definedSecondChoice ?? null, definedNumber ?? null, definedSecondNumber ?? null, definedCheckmark ?? null,
      definedFormula ?? null]);
  } catch {
    rowContext = String(Math.random());
  }
  // The markups the list shows, in row order.
  const listed = [];
  // Page labels, one lookup per page.
  const pageLabels = new Map();
  const pageLabelOf = (page) => {
    let label = pageLabels.get(page);
    if (label === undefined) { label = markupPageLabel(doc, page); pageLabels.set(page, label); }
    return label;
  };
  // Group keys of the date sorts, one per date text.
  const dayKeys = new Map();
  const dayKey = (value) => {
    let day = dayKeys.get(value);
    if (day === undefined) {
      const d = new Date(value);
      day = isNaN(d.getTime()) ? 'Unknown' : d.toLocaleDateString();
      dayKeys.set(value, day);
    }
    return day;
  };


  // Group annotations based on sort mode
  const groups = {};
  filteredAnnotations.forEach(ann => {
    let groupKey;
    if (currentSort === 'type') {
      groupKey = ann.type;
    } else if (currentSort === 'author') {
      groupKey = ann.author || 'User';
    } else if (currentSort === 'modifiedDate') {
      groupKey = dayKey(ann.modifiedAt);
    } else if (currentSort === 'creationDate') {
      groupKey = dayKey(ann.createdAt);
    } else if (currentSort === 'color') {
      groupKey = ann.color || ann.strokeColor || '#000';
    } else if (currentSort === 'subject') {
      // the external editor: a markup without its own subject is listed under its type name.
      groupKey = markupSubjectLabel(ann.subject, displayName(ann));
    } else if (currentSort === 'status') {
      groupKey = statusKey(ann.status);
    } else if (currentSort === 'statusAndAuthor') {
      const s = statusKey(ann.status);
      const a = ann.author || 'User';
      groupKey = `${s}|${a}`;
    } else if (currentSort === 'lastStatusAuthor') {
      groupKey = getLastStatusAuthor(ann);
    } else if (currentSort === 'layer') {
      groupKey = markupLayerName(doc, ann);
    } else if (currentSort === 'markupGroup') {
      // Group By Group: the top-level group's name; '' = not in a group, last.
      groupKey = groupNameKey(ann);
    } else if (currentSort === 'space') {
      // Space path; '' (outside every space) is the "(No Space)" group, last.
      groupKey = spaceOf(ann);
    } else {
      groupKey = ann.page;
    }
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(ann);
  });

  // Build flat items array for the store
  const flatItems = [];
  const groupKeys = Object.keys(groups);

  // Sort group keys
  if (currentSort === 'page') {
    groupKeys.sort((a, b) => a - b);
  } else if (currentSort === 'space' || currentSort === 'markupGroup') {
    groupKeys.sort((a, b) => (a === '' ? 1 : b === '' ? -1 : naturalCollator.compare(a, b)));
  } else if (currentSort === 'modifiedDate' || currentSort === 'creationDate') {
    // Keep insertion order (already sorted by date)
  } else {
    groupKeys.sort((a, b) => textCollator.compare(String(a), String(b)));
  }

  // A Page header click can reverse page groups as well as rows. Other
  // column sorts retain the grouping selected in the existing Group By menu.
  if (currentSort === 'page' && activeColumnSort?.column === 'page' && activeColumnSort.direction === 'descending') {
    groupKeys.reverse();
  }

  // Markup groups (docs/reference/editor/markups-list.md): a group is listed once, as a Group
  // row with its members under it, in the section of its dominant markup
  // (else of its first listed member).
  const hiddenMemo = new Map();
  const layerHiddenOf = (ann) => {
    const id = layerIdOf(ann);
    let hidden = hiddenMemo.get(id);
    if (hidden === undefined) { hidden = isLayerHidden(doc, ann); hiddenMemo.set(id, hidden); }
    return hidden;
  };
  eyeMembers = new Map();
  const sectionOf = new Map();
  groupKeys.forEach(key => groups[key].forEach(ann => sectionOf.set(ann, key)));
  const groupHome = new Map(); // top group id -> section key
  const groupListed = new Map(); // top group id -> its listed markups
  groupKeys.forEach(key => groups[key].forEach(ann => {
    const top = pathOf(ann)[0];
    if (!top) return;
    if (!groupHome.has(top.id)) { groupHome.set(top.id, key); groupListed.set(top.id, []); }
    groupListed.get(top.id).push(ann);
  }));
  for (const [id, leden] of groupListed) {
    const level = pathOf(leden[0])[0];
    const dom = leden.find(a => a.id === level.dominant);
    if (dom) groupHome.set(id, sectionOf.get(dom));
  }
  const sectionMarkups = new Map(groupKeys.map(key => [key, []]));
  groupKeys.forEach(key => groups[key].forEach(ann => {
    const top = pathOf(ann)[0];
    sectionMarkups.get(top ? groupHome.get(top.id) : key).push(ann);
  }));

  // A column sort asks each markup's value once, not twice per comparison.
  const sortValue = memoizeMarkupSortValue(columnValue);

  const pushMarkup = (ann, key, depth = 0, mgAncestors = '') => {
    const listedAnn = byId.get(ann.id);
    if (listedAnn) listed.push(listedAnn);
    // Only an open thread builds its reply rows (#491: no work for what is
    // not shown).
    const threadOpen = openThreads.has(ann.id);
    const selected = selectedIds.has(String(ann.id));
    const correction = listPreview(ann, byId);
    const layerName = markupLayerName(doc, ann);
    const layerHidden = layerHiddenOf(ann);
    const pageLabel = pageLabelOf(ann.page);
    const spaceName = spaceOf(ann);
    const expression = expressionFields(ann, defs.expressionResults);
    const expressionText = defs.expressionResults ? JSON.stringify(expression) : '';
    const fieldsHash = markupFieldsHash(ann);
    const rowKey = `annotation:${ann.id}`;
    const cached = rowCache.get(ann);
    let row;
    if (cached && cached.fieldsHash === fieldsHash && cached.context === rowContext && cached.key === key
      && cached.depth === depth && cached.mgAncestors === mgAncestors && cached.threadOpen === threadOpen
      && cached.selected === selected && cached.correction === correction && cached.layerName === layerName
      && cached.layerHidden === layerHidden && cached.pageLabel === pageLabel && cached.spaceName === spaceName
      && cached.expressionText === expressionText && nextItems.get(rowKey) !== cached.row) {
      row = cached.row;
    } else {
      const hasStatus = statusKey(ann.status) !== 'none';
      const replyCount = markupReplies(ann).length;
      // Status changes are part of the thread (the external editor shows who set what).
      const historyCount = Array.isArray(ann.statusHistory) && ann.statusHistory.length ? statusHistory(ann).length : 0;
      const preview = correction || ann.text;
      const item = {
        isHeader: false,
        groupKey: key,
        // Inside a markup group: its depth and the groups above (fold keys).
        depth,
        mgAncestors,
        id: ann.id,
        page: ann.page,
        type: ann.type,
        typeLabel: displayName(ann),
        color: ann.color || ann.strokeColor || '#000',
        accentColor: extensionPaths?.get(ann)?.color || '',
        text: preview ? preview.substring(0, 50) + (preview.length > 50 ? '...' : '') : null,
        meta: `[${ann.author || 'User'}] - ${formatDate(ann.modifiedAt)}`,
        author: ann.author || 'User',
        subject: ann.subject || '',
        subjectLabel: markupSubjectLabel(ann.subject, displayName(ann)),
        date: formatDate(ann.modifiedAt || ann.createdAt),
        ownLock: !!ann.locked,
        customTextValue: ann.markupTextValue || '',
        customTextValue2: ann.markupTextValue2 || '',
        customChoiceValue: choiceValue(ann.markupChoiceValue, definedChoice?.options),
        customChoiceValue2: choiceValue(ann.markupChoiceValue2, definedSecondChoice?.options),
        customNumberValue: definedNumber ? numberText(ann.markupNumberValue) : '',
        customNumberValue2: definedSecondNumber ? numberText(ann.markupNumberValue2) : '',
        customFormulaValue: formulaText(formulaNumberSourceValue(ann, definedFormula), definedFormula,
          ann.markupChoiceValue, definedChoice),
        customCheckmarkValue: definedCheckmark ? checkmarkValue(ann.markupCheckmarkValue) : null,
        ...expression,
        layerName,
        // The row eye: its own Hidden flag, or hidden by its layer.
        hidden: !!ann.hidden,
        layerHidden,
        pageLabel,
        // Capture photos + File Attachment file (capture.js).
        attachmentCount: attachmentCount(ann),
        attachmentNames: attachmentNames(ann).join('; '),
        spaceName,
        statusKey: statusKey(ann.status),
        statusColor: hasStatus ? statusColor(ann.status, doc?.markupStatusSet) : null,
        statusTitle: hasStatus ? statusLabel(ann.status, doc?.markupStatusSet) : null,
        statusBy: hasStatus ? (ann.statusBy || '') : '',
        locked: !!(ann.locked || ann.readOnly),
        replyCount,
        threadCount: replyCount + historyCount,
        threadOpen,
        selected,
      };
      // A markup object that is new (undo puts back copies) keeps the row of
      // the previous build when nothing in it changed.
      const previous = nextItems.has(rowKey) ? null : previousItems.get(rowKey);
      row = previous && sameItem(previous, item) ? previous : item;
      rowCache.set(ann, {
        row, fieldsHash, context: rowContext, key, depth, mgAncestors, threadOpen, selected, correction,
        layerName, layerHidden, pageLabel, spaceName, expressionText,
      });
    }
    if (!nextItems.has(rowKey)) nextItems.set(rowKey, row); // a second row with the same id keeps its own object
    flatItems.push(row);
    if (threadOpen) {
      const replies = markupReplies(ann);
      const history = Array.isArray(ann.statusHistory) && ann.statusHistory.length ? statusHistory(ann) : [];
      const thread = [
        ...replies.map((reply, index) => ({ kind: 'reply', date: reply.createdAt, index, reply })),
        ...history.map((entry, index) => ({ kind: 'status', date: entry.date, index: replies.length + index, entry })),
      ].sort((a, b) => {
        const da = Date.parse(a.date);
        const db = Date.parse(b.date);
        if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return da - db;
        return a.index - b.index;
      });
      thread.forEach(({ kind, reply, entry, index }) => {
        flatItems.push(reuse(kind === 'reply' ? `reply:${ann.id}:${reply.id}:${index}` : `status:${ann.id}:${index}`, {
          isHeader: false,
          isReply: true,
          isStatusEntry: kind === 'status',
          groupKey: key,
          parentId: ann.id,
          page: ann.page,
          replyId: kind === 'reply' ? reply.id : null,
          author: kind === 'reply' ? reply.author : entry.author,
          date: formatDate(kind === 'reply' ? reply.createdAt : entry.date),
          text: kind === 'reply' ? reply.text : statusLabel(entry.state, doc?.markupStatusSet),
        }));
      });
    }
    if (replyingTo === ann.id) {
      flatItems.push(reuse(`reply-input:${ann.id}`, {
        isHeader: false,
        isReplyInput: true,
        groupKey: key,
        parentId: ann.id,
        page: ann.page,
        locked: !!(ann.locked || ann.readOnly),
      }));
    }
  };

  // A Group row and, under it, its members and subgroups. `leden` are the
  // listed markups of this group, in row order.
  const pushGroup = (level, leden, key, depth, mgAncestors) => {
    const dom = leden.find(a => a.id === level.dominant) || leden[0];
    const totals = groupTotals(leden);
    const ancestors = mgAncestors ? `${mgAncestors}|${level.id}` : level.id;
    eyeMembers.set(`group:${level.id}`, leden.map(a => a.id));
    flatItems.push(reuse(`group:${level.id}`, {
      isHeader: false,
      isMarkupGroup: true,
      groupKey: key,
      mgId: level.id,
      depth,
      mgAncestors,
      // The dominant markup's columns (the external editor); the Subject is the group's name.
      id: `group:${level.id}`,
      dominantId: dom.id,
      page: dom.page,
      pageLabel: markupPageLabel(doc, dom.page),
      name: level.name || defaultGroupLabel,
      count: leden.length - (level.hideDominant && leden.some(a => a.id === level.dominant) ? 1 : 0),
      color: dom.color || dom.strokeColor || '#000',
      author: dom.author || 'User',
      date: formatDate(dom.modifiedAt || dom.createdAt),
      layerName: markupLayerName(doc, dom),
      spaceName: spaceOf(dom),
      totalsText: groupTotalsText(totals),
      eye: categoryEyeState(leden, layerHiddenOf),
      groupSelected: leden.every(a => selectedIds.has(String(a.id))),
      locked: leden.some(a => a.locked || a.readOnly),
      nested: leden.some(a => pathOf(a).length > depth + 1),
    }));
    // The listed markups of each subgroup, in row order (one pass).
    const perSub = new Map();
    for (const ann of leden) {
      const sub = pathOf(ann)[depth + 1];
      if (!sub) continue;
      if (!perSub.has(sub.id)) perSub.set(sub.id, []);
      perSub.get(sub.id).push(ann);
    }
    const gedaan = new Set();
    for (const ann of leden) {
      if (level.hideDominant && ann.id === level.dominant) continue;
      const sub = pathOf(ann)[depth + 1];
      if (!sub) { pushMarkup(ann, key, depth + 1, ancestors); continue; }
      if (gedaan.has(sub.id)) continue;
      gedaan.add(sub.id);
      pushGroup(sub, perSub.get(sub.id), key, depth + 1, ancestors);
    }
  };

  groupKeys.forEach(key => {
    // A section whose markups all sit in a group listed elsewhere.
    if (!(sectionMarkups.get(key) || []).length) return;
    // Header entry
    let headerLabel, headerColor;
    if (currentSort === 'type') {
      headerLabel = getTypeDisplayName(key);
    } else if (currentSort === 'color') {
      headerColor = key;
    } else if (currentSort === 'status') {
      headerLabel = statusLabel(key, doc?.markupStatusSet);
    } else if (currentSort === 'statusAndAuthor') {
      const [s, a] = key.split('|');
      headerLabel = `${statusLabel(s, doc?.markupStatusSet)} — ${a}`;
    } else if (currentSort === 'page') {
      // page number stored in item.page
    } else if (currentSort === 'space') {
      headerLabel = key || noSpaceLabel;
    } else if (currentSort === 'markupGroup') {
      headerLabel = key || noGroupLabel;
    } else {
      headerLabel = key;
    }

    // Group By Layer: the group header's eye switches that markup layer, the
    // same switch as the Layers panel (docs/reference/editor/layers.md).
    const groupLayer = currentSort === 'layer' ? layerOf(doc, groups[key][0]) : null;
    const sectie = sectionMarkups.get(key) || [];
    eyeMembers.set(`section:${key}`, sectie.map(a => a.id));
    flatItems.push(reuse(`header:${key}`, {
      isHeader: true,
      groupKey: key,
      page: currentSort === 'page' ? parseInt(key) : null,
      headerLabel,
      headerColor,
      count: sectie.length,
      sortMode: currentSort,
      // Every section has an eye (docs/reference/editor/markups-list.md): its markups' own
      // Hidden flags; Group By Layer keeps the layer's switch.
      eye: categoryEyeState(sectie, layerHiddenOf),
      sectionSelected: sectie.length > 0 && sectie.every(ann => selectedIds.has(String(ann.id))),
      ...(groupLayer ? { layerId: groupLayer.id, layerHidden: groupLayer.visible === false } : {}),
    }));


    // Annotation item entries; a group at the place of its first row.
    const rijen = sortMarkupRows(sectionMarkups.get(key) || [], activeColumnSort, sortValue);
    // The rows of each group in this section, in row order (one pass).
    const perGroep = new Map();
    for (const ann of rijen) {
      const top = pathOf(ann)[0];
      if (!top) continue;
      if (!perGroep.has(top.id)) perGroep.set(top.id, []);
      perGroep.get(top.id).push(ann);
    }
    const gedaan = new Set();
    rijen.forEach(ann => {
      const top = pathOf(ann)[0];
      if (!top) { pushMarkup(ann, key); return; }
      if (gedaan.has(top.id)) return;
      gedaan.add(top.id);
      pushGroup(top, perGroep.get(top.id), key, 0, '');
    });
  });

  previousItems = nextItems;
  listedMarkups = listed;
  setItems(flatItems);
  toonSelectieInLijst(doc, flatItems);
}

// The id set last scrolled into view. A redraw while the same markups stay
// selected must not reopen a section the user just closed.
let laatstGetoondeSelectie = '';

function cssEscape(value) {
  const s = String(value);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function selectieSleutel(doc) {
  const ids = [];
  for (const ann of doc?.selectedAnnotations || []) {
    if (ann && ann.id != null) ids.push(String(ann.id));
  }
  if (!ids.length) return '';
  ids.sort();
  return `${doc?.id ?? ''}\0${ids.join('\0')}`;
}

/**
 * Which row a canvas selection should bring into view, and which folds to open.
 * A member row wins over its Group row. `selectedIds` are markup ids.
 * @param {Array<object>} items
 * @param {Set<string>|Iterable<string>} selectedIds
 * @param {string|null} [preferredId] the markup the click picked
 * @returns {{sectionKey: *, markupGroups: string[], rowId: string|null, groupId: string|null}|null}
 */
export function revealPlan(items, selectedIds, preferredId = null) {
  const ids = new Set();
  const bron = selectedIds instanceof Set ? selectedIds : (selectedIds || []);
  for (const id of bron) if (id != null) ids.add(String(id));
  if (!ids.size || !Array.isArray(items)) return null;
  const isRow = (it) => it && !it.isHeader && !it.isReply && !it.isReplyInput && !it.isMarkupGroup
    && ids.has(String(it.id));
  const want = preferredId != null ? String(preferredId) : null;
  let row = want != null ? items.find((it) => isRow(it) && String(it.id) === want) : null;
  if (!row) row = items.find(isRow);
  const group = !row ? items.find((it) => it && it.isMarkupGroup && it.groupSelected) : null;
  const target = row || group;
  if (!target) return null;
  return {
    sectionKey: target.groupKey,
    markupGroups: target.mgAncestors ? String(target.mgAncestors).split('|').filter(Boolean) : [],
    rowId: row ? row.id : null,
    groupId: row ? null : group.mgId,
  };
}

function toonSelectieInLijst(doc, items) {
  const sleutel = selectieSleutel(doc);
  if (sleutel === laatstGetoondeSelectie) return;
  const plan = sleutel
    ? revealPlan(items, (doc.selectedAnnotations || []).map((ann) => ann && ann.id), doc.selectedAnnotation?.id)
    : null;
  // The row is filtered out of this build. Keep the previous key so the next
  // build that includes it still opens and scrolls.
  if (sleutel && !plan) return;
  laatstGetoondeSelectie = sleutel;
  if (!plan) return;
  if (plan.sectionKey != null) expandGroup(plan.sectionKey);
  if (plan.markupGroups.length) {
    setExpandedMarkupGroups((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of plan.markupGroups) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }
  const selector = plan.rowId != null
    ? `[data-annotation-id="${cssEscape(plan.rowId)}"]`
    : (plan.groupId != null ? `[data-markup-group-id="${cssEscape(plan.groupId)}"]` : '');
  if (!selector || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const scroll = () => {
    const el = document.querySelector(`#annotations-panel ${selector}`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('ocudraw:reveal-markup-row', {
        detail: { rowId: plan.rowId, groupId: plan.groupId },
      }));
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll);
  else scroll();
}

// The markups behind each section and Group row eye of the last build
// ('section:<key>' / 'group:<id>' -> markup ids).
let eyeMembers = new Map();

/**
 * A section or Group row eye (docs/reference/editor/markups-list.md): hide every markup of
 * the category, or, when any is hidden, show them all, with their own Hidden
 * flags, as one undo step. Markups their layer hides keep their flag (the
 * layer decides). Both halves of a replacement (#508) switch together.
 * @param {string} eyeKey  'section:<key>' or 'group:<group id>'
 * @returns {boolean|null} the new hidden state, or null when nothing changed
 */
export function toggleCategoryEye(eyeKey) {
  const doc = getActiveDocument();
  const ids = new Set(eyeMembers.get(eyeKey) || []);
  if (!doc || !ids.size) return null;
  const members = expandCorrectionGroups(doc.annotations, doc.annotations.filter(a => ids.has(a.id)));
  const r = toggleCategoryHidden(members, (ann) => isLayerHidden(doc, ann), { clone: cloneAnnotation });
  if (!r.changed.length) return null;
  recordBulkModify(r.changed, r.before);
  if (doc.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
  updateAnnotationsList();
  return r.hidden;
}

/**
 * The Markups List row eye (docs/reference/editor/layers.md): hide or show one markup
 * with its own Hidden flag (`hidden`, saved as /F bit 2), as one undo step.
 * Both halves of a replacement (#508) share a row and switch together. A
 * markup on a hidden layer is hidden by its layer: the eye changes nothing
 * then (its tooltip names the layer). Selection is left as it is.
 * @returns {boolean|null} the new hidden state, or null when nothing changed
 */
export function toggleMarkupHidden(id) {
  const doc = getActiveDocument();
  const annotation = (doc?.annotations || []).find(a => a.id === id);
  if (!annotation || isLayerHidden(doc, annotation)) return null;
  const hide = !annotation.hidden;
  const members = expandCorrectionGroups(doc.annotations, [annotation]);
  const before = members.map(cloneAnnotation);
  // Showing removes the key: a markup hidden and shown again is the markup
  // it was, so an untouched the external editor markup stays byte-equal on save.
  for (const member of members) {
    if (hide) member.hidden = true;
    else delete member.hidden;
  }
  if (members.length === 1) recordModify(annotation.id, before[0], annotation);
  else recordBulkModify(members, before);
  if (doc.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
  updateAnnotationsList();
  return hide;
}

// Scroll the pdf-container viewport to center on the given annotation
export function scrollToAnnotation(annotation) {
  const bounds = getAnnotationBounds(annotation);
  if (!bounds) return;

  const doc = getActiveDocument();
  const scale = doc?.scale || 1.5;
  const pdfContainer = document.getElementById('pdf-container');
  if (!pdfContainer) return;

  // Het midden zoals het op het scherm ligt: bij een gedraaide weergave (#200)
  // staat het elders dan in de paginaruimte. Viewport en scrollcontainer
  // rekenen in de weergaveruimte.
  const midden = paginaNaarWeergave(annotation.page ?? doc?.currentPage ?? 1,
    bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, doc);
  const centerX = midden.x * scale;
  const centerY = midden.y * scale;

  // Enkelpagina met de vector-viewport (issue #318): daar scrollt de
  // container NIET — het canvas staat vast en pannen/zoomen gebeurt via
  // viewport.offsetX/Y in de RAF-render. `pdfContainer.scrollTo()` verschoof
  // dan het vaste canvas-element zelf, waardoor de hele pagina uit beeld
  // verdween zodra een opmerking buiten het zichtbare deel lag. Centreer in
  // plaats daarvan de viewport op de annotatie.
  if (viewport.active && doc?.viewMode !== 'continuous') {
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const vpW = canvas.width / dpr;   // CSS-px
    const vpH = canvas.height / dpr;
    // De viewport rekent in de weergaveruimte (punten, oorsprong linksboven
    // van de getoonde, eventueel gedraaide pagina).
    const cx = midden.x;
    const cy = midden.y;
    stopAlleWielScrollers();
    viewport.offsetX = vpW / 2 - cx * viewport.zoom;
    viewport.offsetY = vpH / 2 - cy * viewport.zoom;
    // Door de gebruiker (indirect) gepositioneerd → niet automatisch her-fitten.
    markAnchored();
    viewport.dirty = true;
    return;
  }

  if (getActiveDocument()?.viewMode === 'continuous') {
    const pageWrapper = document.querySelector(`.page-wrapper[data-page="${annotation.page}"]`);
    if (!pageWrapper) return;
    const canvasContainer = pageWrapper.querySelector('.canvas-container-cont');
    if (!canvasContainer) return;

    const wrapperOffset = pageWrapper.offsetTop;
    const canvasOffset = canvasContainer.offsetTop;
    const scrollX = centerX - pdfContainer.clientWidth / 2;
    const scrollY = wrapperOffset + canvasOffset + centerY - pdfContainer.clientHeight / 2;
    // Een lopende wieluitloop zou deze vloeiende sprong afbreken (#522).
    stopAlleWielScrollers();
    pdfContainer.scrollTo({ left: Math.max(0, scrollX), top: Math.max(0, scrollY), behavior: 'smooth' });
  } else {
    const scrollX = centerX - pdfContainer.clientWidth / 2;
    const scrollY = centerY - pdfContainer.clientHeight / 2;
    stopAlleWielScrollers();
    pdfContainer.scrollTo({ left: Math.max(0, scrollX), top: Math.max(0, scrollY), behavior: 'smooth' });
  }
}

// Select an annotation item - navigates to its page and selects it
// When ctrlKey is true, toggles the annotation in/out of multi-selection
export async function selectAnnotationItem(id, page, ctrlKey = false) {
  const selDoc = getActiveDocument();
  const annotation = (selDoc?.annotations || []).find(a => a.id === id);
  if (!annotation) return;
  const selDocPage = selDoc ? selDoc.currentPage : 1;
  // Een vervanging (#508) is één regel en één selectie: beide helften.
  const leden = expandCorrectionGroups(selDoc?.annotations, [annotation]);
  if (ctrlKey) {
    if (isSelected(annotation)) {
      for (const lid of leden) removeFromSelection(lid);
    } else {
      if (annotation.page !== selDocPage) {
        await goToPage(annotation.page);
      }
      for (const lid of leden) addToSelection(lid);
    }
  } else {
    if (annotation.page !== selDocPage) {
      await goToPage(annotation.page);
    }
    const _selListDoc = getActiveDocument();
    const ouder = leden.length > 1 ? replaceParentOf(leden, _selListDoc?.annotations) : null;
    if (_selListDoc) { _selListDoc.selectedAnnotation = ouder || annotation; _selListDoc.selectedAnnotations = leden; }
  }

  redrawAnnotations();
  const _listDoc2 = getActiveDocument();
  const _listSel = _listDoc2 ? _listDoc2.selectedAnnotations : [];
  const _listOuder = _listSel.length > 1 ? replaceParentOf(_listSel, _listDoc2?.annotations) : null;
  if (_listOuder) {
    showProperties(_listOuder);
  } else if (_listSel.length > 1) {
    showMultiSelectionProperties();
  } else if (_listDoc2?.selectedAnnotation) {
    showProperties(_listDoc2.selectedAnnotation);
  }
  updateAnnotationsList();

  // Scroll to the annotation when selecting (not when Ctrl+deselecting)
  if (isSelected(annotation)) {
    setTimeout(() => scrollToAnnotation(annotation), 50);
  }
}

/**
 * Visible Markups List rows, top to bottom. Section headers, replies and
 * rows inside a collapsed section or a closed group are not in the span.
 * A Group row stands for its members.
 * @param {object[]} items
 * @param {Set<string>} collapsed
 * @param {Set<string>} expanded
 * @param {(groupId: string) => string[]} memberIdsOf
 */
export function visibleMarkupSpan(items, collapsed, expanded, memberIdsOf = () => []) {
  const folded = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const open = expanded instanceof Set ? expanded : new Set(expanded || []);
  const shown = (item) => !folded.has(item.groupKey)
    && (!item.mgAncestors || String(item.mgAncestors).split('|').filter(Boolean).every((id) => open.has(id)));
  const rows = [];
  for (const item of items || []) {
    if (!item || item.isHeader || item.isReply || item.isReplyInput) continue;
    if (!shown(item)) continue;
    if (item.isMarkupGroup) rows.push({ key: `group:${item.mgId}`, ids: memberIdsOf(item.mgId) || [] });
    else if (item.id) rows.push({ key: `markup:${item.id}`, ids: [item.id] });
  }
  return rows;
}

/**
 * Markup ids from the anchor row through the clicked row, inclusive, in list
 * order. The anchor counts when that row is still visible. Otherwise the
 * first selected visible row is the start. With neither, the click stands
 * alone.
 */
export function markupIdsInSpan(rows, anchorKey, clickedKey, selectedIds = new Set()) {
  const at = (key) => (rows || []).findIndex((row) => row.key === key);
  const end = at(clickedKey);
  if (end < 0) return String(clickedKey || '').startsWith('markup:') ? [clickedKey.slice(7)] : [];
  let startKey = at(anchorKey) >= 0 ? anchorKey : null;
  if (!startKey) {
    const selected = (rows || []).filter((row) => (row.key.startsWith('markup:')
      ? selectedIds.has(row.key.slice(7))
      : row.ids.length > 0 && row.ids.every((id) => selectedIds.has(String(id)))));
    if (selected.length) startKey = selected[0].key;
  }
  const start = startKey ? at(startKey) : end;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const ids = [];
  const seen = new Set();
  for (let i = lo; i <= hi; i++) {
    for (const id of rows[i].ids) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Shift-click in the Markups List: select every visible markup from the
 * anchor row through the clicked row. `clickedKey` is `markup:<id>` or
 * `group:<id>`.
 */
export async function selectMarkupRange(anchorKey, clickedKey, page) {
  const doc = getActiveDocument();
  if (!doc || !clickedKey) return;
  const memberIdsOf = (groupId) => membersOfGroup(doc.annotations, groupId).map((a) => a.id);
  const rows = visibleMarkupSpan(markupListItems(), collapsedGroups(), expandedMarkupGroups(), memberIdsOf);
  const selectedIds = new Set((doc.selectedAnnotations || []).map((a) => String(a?.id)));
  const ids = markupIdsInSpan(rows, anchorKey, clickedKey, selectedIds);
  const byId = new Map((doc.annotations || []).filter(Boolean).map((a) => [String(a.id), a]));
  const leden = expandCorrectionGroups(doc.annotations, ids.map((id) => byId.get(String(id))).filter(Boolean));
  let focus = null;
  if (String(clickedKey).startsWith('markup:')) focus = byId.get(clickedKey.slice(7)) || null;
  else if (String(clickedKey).startsWith('group:')) {
    const level = groupLevel(doc.annotations, clickedKey.slice(6));
    focus = (level && byId.get(String(level.dominant))) || leden[0] || null;
  }
  const focusPage = focus?.page ?? page;
  if (focusPage && doc.currentPage !== focusPage) await goToPage(focusPage);
  const live = getActiveDocument();
  if (!live) return;
  const ouder = leden.length > 1 ? replaceParentOf(leden, live.annotations) : null;
  live.selectedAnnotations = leden;
  live.selectedAnnotation = ouder || focus || leden[0] || null;
  if (ouder) showProperties(ouder);
  else if (leden.length > 1) showMultiSelectionProperties();
  else if (live.selectedAnnotation) showProperties(live.selectedAnnotation);
  redrawAnnotations();
  updateAnnotationsList();
  if (focus && isSelected(focus)) setTimeout(() => scrollToAnnotation(focus), 50);
}

/**
 * Select a Group row (docs/reference/editor/markups-list.md): every markup of the group, the
 * dominant one as the main selection. Ctrl adds or removes the group.
 */
export async function selectMarkupGroupItem(groupId, ctrlKey = false) {
  if (extensionGrouping?.ownsGroup?.(groupId)) return extensionGrouping.select?.(groupId, ctrlKey);
  if (addonGroupOwners.has(groupId)) return addonGroupOwners.get(groupId)(groupId, ctrlKey);
  const doc = getActiveDocument();
  if (!doc) return;
  const leden = membersOfGroup(doc.annotations, groupId);
  if (!leden.length) return;
  const level = groupLevel(doc.annotations, groupId);
  const dom = leden.find(a => a.id === level?.dominant) || leden[0];
  if (ctrlKey) {
    if (leden.every(a => isSelected(a))) for (const a of leden) removeFromSelection(a);
    else for (const a of leden) addToSelection(a);
  } else {
    if (dom.page !== doc.currentPage) await goToPage(dom.page);
    const d = getActiveDocument();
    d.selectedAnnotations = [...leden];
    d.selectedAnnotation = dom;
  }
  redrawAnnotations();
  const d = getActiveDocument();
  if (d.selectedAnnotations.length > 1) showMultiSelectionProperties();
  else if (d.selectedAnnotation) showProperties(d.selectedAnnotation);
  updateAnnotationsList();
  if (isSelected(dom)) setTimeout(() => scrollToAnnotation(dom), 50);
}

/**
 * Put markups in a subject (the external editor's category): one undo step. A locked
 * markup is left as it is. Returns how many changed.
 */
export function setMarkupsSubject(annotations, subject) {
  const doc = getActiveDocument();
  const naam = String(subject ?? '').trim();
  if (!doc || !naam) return 0;
  const doelen = expandCorrectionGroups(doc.annotations, (annotations || []).filter(Boolean))
    .filter(a => !a.locked && !a.readOnly && a.subject !== naam);
  if (!doelen.length) return 0;
  const before = doelen.map(cloneAnnotation);
  const now = new Date().toISOString();
  for (const a of doelen) { a.subject = naam; a.modifiedAt = now; }
  recordBulkModify(doelen, before);
  if (doc.selectedAnnotations?.length > 1) showMultiSelectionProperties();
  else if (doc.selectedAnnotation) showProperties(doc.selectedAnnotation);
  updateAnnotationsList();
  return doelen.length;
}

/**
 * Markups List rows dropped on a section header or a Group row: they go into
 * that category. Subject, Author and Layer sections assign that value; a
 * Group row adds them to the group. Other sections (page, date, type, ...)
 * are not something a markup can be put in. Returns how many changed.
 * @param {string[]} ids
 * @param {{ sortMode?: string, groupKey?: string, layerId?: string, groupId?: string }} target
 */
export async function dropMarkupsOnCategory(ids, target) {
  const doc = getActiveDocument();
  const set = new Set(ids || []);
  const markups = (doc?.annotations || []).filter(a => set.has(a.id));
  if (!doc || !markups.length || !target) return 0;
  if (extensionGrouping?.ownsGroup?.(target.groupId) || addonGroupOwners.has(target.groupId)) return 0;
  if (target.groupId) {
    const r = addToGroup(doc.annotations, markups, target.groupId, { clone: cloneAnnotation });
    if (!r) return 0;
    const now = new Date().toISOString();
    for (const a of r.changed) a.modifiedAt = now;
    recordBulkModify(r.changed, r.before);
    redrawAnnotations();
    updateAnnotationsList();
    return r.changed.length;
  }
  if (target.sortMode === 'subject') return setMarkupsSubject(markups, target.groupKey);
  if (target.sortMode === 'layer' && target.layerId) {
    const { moveAnnotationsToAnnotationLayer } = await import('../../solid/stores/annotationLayersStore.js');
    return moveAnnotationsToAnnotationLayer(markups, target.layerId);
  }
  if (target.sortMode === 'author') {
    const doelen = markups.filter(a => !a.locked && !a.readOnly && (a.author || 'User') !== target.groupKey);
    if (!doelen.length) return 0;
    const before = doelen.map(cloneAnnotation);
    for (const a of doelen) a.author = target.groupKey;
    recordBulkModify(doelen, before);
    updateAnnotationsList();
    return doelen.length;
  }
  return 0;
}

/** Can rows be dropped on this section header (see dropMarkupsOnCategory)? */
export function isDropCategory(sortMode) {
  return sortMode === 'subject' || sortMode === 'layer' || sortMode === 'author';
}

/**
 * Add a reply to a markup from the list's inline reply box. One undo step;
 * the thread opens so the new reply is seen. Returns false for an empty
 * reply or a locked markup.
 */
export function addMarkupReply(id, text) {
  const doc = getActiveDocument();
  const annotation = (doc?.annotations || []).find(a => a.id === id);
  if (!annotation || annotation.locked || annotation.readOnly) return false;
  const reply = newReply(text, state.defaultAuthor || 'User');
  if (!reply) return false;
  commitAnnotationMutation(annotation, current => {
    // Blank placeholder replies (older context menu) are dropped here.
    current.replies = [...(current.replies || []).filter(r => String(r?.text ?? '').trim()), reply];
  });
  openThread(id);
  setReplyTarget(null);
  // The Properties panel shows the same thread.
  if (doc.selectedAnnotation === annotation) showProperties(annotation);
  updateAnnotationsList();
  return true;
}

/**
 * Set a markup's review status from the list (status cell dropdown) and record
 * who set it when (status history, saved as review-status replies). One undo
 * step. Returns false for a locked markup or an unchanged status.
 */
export function setMarkupStatus(id, status) {
  const doc = getActiveDocument();
  const annotation = (doc?.annotations || []).find(a => a.id === id);
  if (!annotation || annotation.locked || annotation.readOnly) return false;
  if (statusKey(status) === statusKey(annotation.status)) return false;
  commitAnnotationMutation(annotation, current => {
    applyStatusChange(current, status, state.defaultAuthor || 'User');
    runMarkupFieldHooks(current, 'status', current.status, doc);
  });
  // The canvas hides markups whose status is filtered out (#333).
  redrawAnnotations();
  if (doc.selectedAnnotation === annotation) showProperties(annotation);
  updateAnnotationsList();
  return true;
}

/**
 * Edit one field of a markup from its Markups List row (comment or a custom
 * column value). Returns false when the value is not allowed or nothing
 * changed. One undo step.
 */
export function setMarkupField(id, field, raw) {
  const doc = getActiveDocument();
  const annotation = (doc?.annotations || []).find(a => a.id === id);
  if (!annotation || annotation.locked || annotation.readOnly || !fieldColumnDefined(doc, field)) return false;
  const value = fieldValue(doc, field, raw);
  if (value === undefined) return false;
  const before = annotation[field] ?? (field.startsWith('markupNumber') ? null : '');
  if (value === before) return false;
  commitAnnotationMutation(annotation, current => {
    if (value === null || value === '') delete current[field];
    else current[field] = value;
    runMarkupFieldHooks(current, field, value, doc);
  });
  doc.modified = true;
  redrawAnnotations();
  if (doc.selectedAnnotation === annotation) showProperties(annotation);
  updateAnnotationsList();
  return true;
}

/** Open the inline reply box under a markup (list context menu "Reply"). */
export function startMarkupReply(id) {
  const annotation = (getActiveDocument()?.annotations || []).find(a => a.id === id);
  if (!annotation) return false;
  openThread(id);
  setReplyTarget(id);
  updateAnnotationsList();
  return true;
}

/** Open a markup's thread (replies and status history) in the list. */
export function showMarkupThread(id) {
  if (!(getActiveDocument()?.annotations || []).some(a => a.id === id)) return false;
  openThread(id);
  updateAnnotationsList();
  return true;
}

export function cancelMarkupReply() {
  if (replyTarget() === null) return;
  setReplyTarget(null);
  updateAnnotationsList();
}

// Initialize annotations list panel (no-op, filter is handled by the component)
export function initAnnotationsList() {
}

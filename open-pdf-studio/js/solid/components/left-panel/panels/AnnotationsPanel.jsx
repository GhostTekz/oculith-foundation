import { For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from 'solid-js';
import { activeTab, panelShown } from '../../../stores/leftPanelStore.js';
import { items, countText, emptyMessage, sortMode, setSortMode, columnSort, setColumnSort, filterMode, setFilterMode, searchQuery, setSearchQuery, hiddenStatuses, toggleHiddenStatus, replaceHiddenStatuses, collapsedGroups, toggleGroup, expandAllGroups, collapseAllGroups, toggleThread, columnFilters, setColumnFilters, allMarkupsHidden, setAllMarkupsHidden, expandedMarkupGroups, toggleMarkupGroup, sheetsPending } from '../../../stores/panels/annotationsStore.js';
import { FILTERABLE_COLUMNS, activeColumnFilters, toggleColumnFilterValue, setColumnFilterValues, normalizeColumnFilters } from '../../../../ui/panels/markup-column-filter.js';
import { showAnnotationMenu, showMultiAnnotationMenu } from '../../../stores/contextMenuStore.js';
import { openDialog } from '../../../stores/dialogStore.js';
import { lucide } from '../../../data/lucideIcons.js';
import CaptureThumbTip, { showCaptureTip, hideCaptureTip } from '../../capture/CaptureThumbTip.jsx';
import { REPLY_TEXT_MAX } from '../../../../annotations/markup-replies.js';
import { statusSet as validStatusSet, statusOptions, statusLines, parseStatusLines, DEFAULT_STATUS_SET,
  STATUS_SET_NAME_MAX } from '../../../../annotations/markup-status.js';
import { useTranslation } from '../../../../i18n/useTranslation.js';
import { state, clearSelection, getActiveDocument } from '../../../../core/state.js';
import { commitAnnotationMutation, deleteAnnotationsWithUndo } from '../../../../annotations/mutations.js';
import { expandCorrectionGroups } from '../../../../annotations/corrections/model.js';
import { markupCsv, markupSummaryRows } from '../../../../annotations/markup-csv.js';
import { customTextColumnName, customTextValue, CUSTOM_TEXT_NAME_MAX, CUSTOM_TEXT_VALUE_MAX } from '../../../../annotations/custom-text-column.js';
import { choiceColumn as validChoiceColumn, choiceValue, CHOICE_SCHEMA_VERSION,
  CHOICE_NUMERIC_SCHEMA_VERSION,
  CHOICE_OPTION_MAX, CHOICE_OPTIONS_MAX } from '../../../../annotations/custom-choice-column.js';
import { numberColumn as validNumberColumn, numberValue, numberText,
  NUMBER_SCHEMA_VERSION, NUMBER_TEXT_MAX } from '../../../../annotations/custom-number-column.js';
import { checkmarkColumn as validCheckmarkColumn, checkmarkValue, checkmarkText,
  CHECKMARK_SCHEMA_VERSION } from '../../../../annotations/custom-checkmark-column.js';
import { formulaColumn as validFormulaColumn, FORMULA_SCHEMA_VERSION,
  FORMULA_CHOICE_SCHEMA_VERSION, FORMULA_SECOND_NUMBER_SCHEMA_VERSION } from '../../../../annotations/custom-formula-column.js';
import { ensureMarkupColumnsReady } from '../../../../pdf/markup-columns.js';
import { expressionColumns, expressionColumnIndex } from '../../../../annotations/formula-captions.js';
import { FormulaCaptionsButton, FormulaTotalsBar } from './FormulaCaptions.jsx';
import { nextMarkupColumnSort } from '../../../../ui/panels/markup-column-sort.js';
import { MARKUP_COLUMNS, ANCHOR_COLUMN, readVisibleColumns, writeVisibleColumns, withColumnToggled,
  columnGridTemplate } from '../../../../ui/panels/markup-columns.js';
import PanelHeader from '../../panels/PanelHeader.jsx';
import { openPanelMenu } from '../../panels/PanelMenu.jsx';
import { toolIcon } from '../../../data/oculithToolIcons.js';
import { addSavedFilter, readSavedFilters, writeSavedFilters } from '../../../../ui/panels/markup-saved-filters.js';
import { isTauri, saveFileDialog, writeBinaryFile } from '../../../../core/platform.js';
import { directoryOf } from '../../../../pdf/remote-link.js';
import { joinOutputPath } from '../../../../batch/runner.js';
import { buildVirtualRows, virtualRowKey, virtualRowWindow } from '../../../../ui/panels/markup-virtual-rows.js';
import {
  cutIcon, copyIcon, deleteIcon, flattenIcon, exportIcon, deselectIcon, propertiesIcon
} from '../../../data/contextMenuIcons.js';

// Menu icons (codicon-style, viewBox 0 0 16 16, fill currentColor)
const expandAllIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M15 6v5c0 2.21-1.79 4-4 4H6c-.74 0-1.38-.4-1.73-1H11c1.65 0 3-1.35 3-3V4.27c.6.35 1 .99 1 1.73m-4 7H4c-1.103 0-2-.897-2-2V4c0-1.103.897-2 2-2h7c1.103 0 2 .897 2 2v7c0 1.103-.897 2-2 2m-7-1h7c.551 0 1-.448 1-1V4c0-.551-.449-1-1-1H4c-.551 0-1 .449-1 1v7c0 .552.449 1 1 1m5.5-5H8V5.5a.5.5 0 0 0-1 0V7H5.5a.5.5 0 0 0 0 1H7v1.5a.5.5 0 0 0 1 0V8h1.5a.5.5 0 0 0 0-1"/></svg>`;
const collapseAllIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><g><path d="M14 4.27c.6.35 1 .99 1 1.73v5c0 2.21-1.79 4-4 4H6c-.74 0-1.38-.4-1.73-1H11c1.65 0 3-1.35 3-3zM9.5 7a.5.5 0 0 1 0 1h-4a.5.5 0 0 1 0-1z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M11 2c1.103 0 2 .897 2 2v7c0 1.103-.897 2-2 2H4c-1.103 0-2-.897-2-2V4c0-1.103.897-2 2-2zM4 3c-.551 0-1 .449-1 1v7c0 .552.449 1 1 1h7c.551 0 1-.448 1-1V4c0-.551-.449-1-1-1z"/></g></svg>`;
const summarizeIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5zM2 4v8h12V4zm1 1h6v1H3zm0 2h10v1H3zm0 2h8v1H3z"/></svg>`;
const importIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-1 0v-8a.5.5 0 0 1 .5-.5M5.854 8.146a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L4.293 9H11.5a.5.5 0 0 1 0-1H4.293l3.146-3.146a.5.5 0 0 0-.707-.708l-4 4z"/></svg>`;
const exportCommentsIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-1 0v-8a.5.5 0 0 1 .5-.5m8.646.146a.5.5 0 0 1 .707 0l4 4a.5.5 0 0 1 0 .707l-4 4a.5.5 0 0 1-.707-.707L13.293 8H4.5a.5.5 0 0 1 0-1h8.793l-3.146-3.146a.5.5 0 0 1 0-.707z"/></svg>`;
const groupByIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M14 2h-3a1 1 0 0 0-1 1v1H8v-.25A.75.75 0 0 0 7.25 3h-1.5a.75.75 0 0 0-.75.75v1.5c0 .413.337.75.75.75h1.5c.413 0 .75-.337.75-.75V5h2v1a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1M7 5H6V4h1zm7 1h-3V3h3zm0 2h-3a1 1 0 0 0-1 1v1H8v-.25A.75.75 0 0 0 7.25 9h-1.5a.75.75 0 0 0-.75.75v1.5c0 .413.337.75.75.75h1.5c.413 0 .75-.337.75-.75V11h2v1a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1m-7 3H6v-1h1zm7 1h-3V9h3z"/></svg>`;
const showIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.984 8.625a.5.5 0 0 1-.612.355c-.431-.114-.355-.611-.355-.611l.018-.062s.026-.084.047-.145a6.7 6.7 0 0 1 1.117-1.982C4.096 5.089 5.605 4 8 4s3.904 1.089 4.802 2.183a6.7 6.7 0 0 1 1.117 1.982a4 4 0 0 1 .06.187l.003.013v.006a.5.5 0 0 1-.966.258l-.008-.025l-.035-.109a5.7 5.7 0 0 0-.945-1.674C11.286 5.912 10.045 5 8 5s-3.285.912-4.028 1.817a5.7 5.7 0 0 0-.945 1.674l-.035.109zM8 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5M6.5 9.5a1.5 1.5 0 1 1 3 0a1.5 1.5 0 0 1-3 0"/></svg>`;

const chevronRightIcon = lucide('chevron-right');
const chevronDownIcon = lucide('chevron-down');
const paperclipIcon = lucide('paperclip');
const replyIcon = lucide('message-square-reply');
const eyeIcon = lucide('eye');
const eyeOffIcon = lucide('eye-off');
const groupGlyph = lucide('group');

const groupOptions = [
  { key: 'page', label: 'groupByPage' },
  { key: 'type', label: 'groupByType' },
  { key: 'modifiedDate', label: 'groupByModifiedDate' },
  { key: 'creationDate', label: 'groupByCreationDate' },
  { key: 'author', label: 'groupByAuthor' },
  { key: 'color', label: 'groupByColor' },
  { key: 'subject', label: 'groupBySubject' },
  { key: 'status', label: 'groupByStatus' },
  { key: 'statusAndAuthor', label: 'groupByStatusAndAuthor' },
  { key: 'lastStatusAuthor', label: 'groupByLastStatusAuthor' },
  { key: 'space', common: 'spaces.groupBySpace' },
  { key: 'layer', common: 'markupLayers.groupByLayer' },
  // the external editor groups (docs/reference/editor/markups-list.md): a section per group name.
  { key: 'markupGroup', common: 'markupGroups.groupByGroup' },
];


// Markups List type glyphs in the Subject column (the external editor shows the markup's
// tool icon before its subject), drawn in the markup's colour.
const TYPE_GLYPHS = {
  line: () => toolIcon('line'), arrow: () => lucide('arrow-up-right'), box: () => lucide('square'),
  circle: () => toolIcon('ellipse'), ellipse: () => toolIcon('ellipse'), highlight: () => lucide('highlighter'),
  cloud: () => toolIcon('cloud'), cloudPolyline: () => toolIcon('cloud'), textbox: () => lucide('type'),
  callout: () => toolIcon('callout'), count: () => toolIcon('count'), polyline: () => toolIcon('polyline'),
  polygon: () => lucide('pentagon'), comment: () => lucide('message-square'), stamp: () => lucide('stamp'),
  draw: () => lucide('pencil'), ink: () => lucide('pencil'), measureDistance: () => toolIcon('dimension'),
  measureArea: () => toolIcon('area'), measurePerimeter: () => toolIcon('perimeter'), image: () => lucide('image'),
  link: () => lucide('link'), arc: () => toolIcon('arc'),
};
const typeGlyphCache = new Map();
function typeGlyph(type) {
  if (!typeGlyphCache.has(type)) typeGlyphCache.set(type, (TYPE_GLYPHS[type] || (() => lucide('square-pen')))());
  return typeGlyphCache.get(type);
}
const FILTER_LIST_KEY = 'ocudraw.markups.filterList.v1';
function storedFilterList() {
  try { return globalThis.localStorage?.getItem(FILTER_LIST_KEY) === '1'; } catch { return false; }
}

/** A markup export's default path: beside its saved source drawing. */
function markupExportPath(doc, name) {
  if (!isTauri() || doc?.isUntitled || doc?._renderTemp) return name;
  return joinOutputPath(directoryOf(doc?.filePath || doc?.currentPdfPath), name);
}

export default function AnnotationsPanel() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const { t: tContext } = useTranslation('context');

  // The list is not built while it is hidden (annotations-list.js, #491):
  // bring it up to date the moment it is shown, whichever way that happens
  // (tab switch, expanding the panel, the ribbon).
  createEffect(() => {
    if (panelShown('annotations')) {
      import('../../../../ui/panels/annotations-list.js').then(m => m.refreshAnnotationsListIfStale());
    }
  });

  const { t: tRibbon } = useTranslation('ribbon');
  createEffect(() => {
    const name = tRibbon('annotationLayers.defaultName');
    import('../../../../ui/panels/annotations-list.js').then(m => m.setDefaultLayerLabel(name));
  });
  createEffect(() => {
    const label = tCommon('spaces.none');
    import('../../../../ui/panels/annotations-list.js').then(m => m.setNoSpaceLabel(label));
  });
  createEffect(() => {
    const labels = { none: tCommon('markupGroups.noGroup'), group: tCommon('markupGroups.group') };
    import('../../../../ui/panels/annotations-list.js').then(m => m.setGroupLabels(labels));
  });

  const [menuOpen, setMenuOpen] = createSignal(false);
  // A large drawing reads its sheets when shown; this reads the rest.
  const [readingAll, setReadingAll] = createSignal(false);
  async function readAllSheets() {
    if (readingAll()) return;
    setReadingAll(true);
    try {
      const { ensureAllAnnotations } = await import('../../../../pdf/loader.js');
      await ensureAllAnnotations();
    } finally {
      setReadingAll(false);
    }
  }
  const [columnsOpen, setColumnsOpen] = createSignal(false);
  // In the bottom panel host the columns menu opens upwards. The host's panel
  // body clips its overflow, so the menu is placed fixed above the button and
  // kept below the menu bar however tall the host is.
  const columnsMenuRoom = () => {
    if (!columnsOpen() || !columnsRef?.closest('.markups-dock')) return {};
    const r = columnsRef.getBoundingClientRect();
    return {
      position: 'fixed', top: 'auto', left: `${Math.round(Math.max(4, Math.min(r.left, window.innerWidth - 250)))}px`,
      bottom: `${Math.round(window.innerHeight - r.top + 3)}px`,
      'max-height': `${Math.max(160, Math.floor(r.top) - 40)}px`,
    };
  };
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  const [savedFilters, setSavedFilters] = createSignal(readSavedFilters());
  const [filterName, setFilterName] = createSignal('');
  const [filterMessage, setFilterMessage] = createSignal('');
  const [visibleColumns, setVisibleColumns] = createSignal(readVisibleColumns());
  // the external editor "Filter List": shows the filter ▾ in every column header (a column
  // with an active filter always shows it).
  const [filterListOn, setFilterListOn] = createSignal(storedFilterList());
  const toggleFilterList = () => {
    const next = !filterListOn();
    setFilterListOn(next);
    try { globalThis.localStorage?.setItem(FILTER_LIST_KEY, next ? '1' : '0'); } catch { /* session only */ }
  };
  const [customName, setCustomName] = createSignal('');
  const [customNameInput, setCustomNameInput] = createSignal('');
  const [customNameError, setCustomNameError] = createSignal('');
  const [customValueInput, setCustomValueInput] = createSignal('');
  const [secondTextName, setSecondTextName] = createSignal('');
  const [secondTextNameInput, setSecondTextNameInput] = createSignal('');
  const [secondTextNameError, setSecondTextNameError] = createSignal('');
  const [secondTextValueInput, setSecondTextValueInput] = createSignal('');
  const [choiceDefinition, setChoiceDefinition] = createSignal(null);
  const [choiceNameInput, setChoiceNameInput] = createSignal('');
  const [choiceOptionsInput, setChoiceOptionsInput] = createSignal('');
  const [choiceNumericInput, setChoiceNumericInput] = createSignal('');
  const [choiceError, setChoiceError] = createSignal('');
  const [secondChoiceDefinition, setSecondChoiceDefinition] = createSignal(null);
  const [secondChoiceNameInput, setSecondChoiceNameInput] = createSignal('');
  const [secondChoiceOptionsInput, setSecondChoiceOptionsInput] = createSignal('');
  const [secondChoiceNumericInput, setSecondChoiceNumericInput] = createSignal('');
  const [secondChoiceError, setSecondChoiceError] = createSignal('');
  const [numberDefinition, setNumberDefinition] = createSignal(null);
  const [numberNameInput, setNumberNameInput] = createSignal('');
  const [numberNameError, setNumberNameError] = createSignal('');
  const [numberValueInput, setNumberValueInput] = createSignal('');
  const [numberValueError, setNumberValueError] = createSignal('');
  const [secondNumberDefinition, setSecondNumberDefinition] = createSignal(null);
  const [secondNumberNameInput, setSecondNumberNameInput] = createSignal('');
  const [secondNumberNameError, setSecondNumberNameError] = createSignal('');
  const [secondNumberValueInput, setSecondNumberValueInput] = createSignal('');
  const [secondNumberValueError, setSecondNumberValueError] = createSignal('');
  const [checkmarkDefinition, setCheckmarkDefinition] = createSignal(null);
  const [checkmarkNameInput, setCheckmarkNameInput] = createSignal('');
  const [checkmarkNameError, setCheckmarkNameError] = createSignal('');
  const [formulaDefinition, setFormulaDefinition] = createSignal(null);
  // Formula columns with expressions (FormulaCaptions.jsx), one per exprFormula key.
  const [expressionDefinitions, setExpressionDefinitions] = createSignal([]);
  createEffect(() => {
    items();
    setExpressionDefinitions(expressionColumns(getActiveDocument()?.formulaCaptions?.columns));
  });
  const expressionDefined = column => expressionColumnIndex(column) < 0
    || !!expressionDefinitions()[expressionColumnIndex(column)];
  const [formulaNameInput, setFormulaNameInput] = createSignal('');
  const [formulaSourceInput, setFormulaSourceInput] = createSignal('customNumber');
  const [formulaMultiplierInput, setFormulaMultiplierInput] = createSignal('1');
  const [formulaOffsetInput, setFormulaOffsetInput] = createSignal('0');
  const [formulaError, setFormulaError] = createSignal('');
  const [statusSetDefinition, setStatusSetDefinition] = createSignal(null);
  const [statusSetNameInput, setStatusSetNameInput] = createSignal('');
  const [statusSetLinesInput, setStatusSetLinesInput] = createSignal('');
  const [statusSetError, setStatusSetError] = createSignal('');
  createEffect(() => {
    items();
    const definition = validStatusSet(getActiveDocument()?.markupStatusSet);
    setStatusSetDefinition(definition);
    setStatusSetNameInput(definition?.name || '');
    setStatusSetLinesInput(statusLines(definition));
  });
  // Built-in statuses keep their translated names; a user set shows its own.
  const builtInStatusLabels = { none: 'annotation.statusNone', accepted: 'annotation.statusAccepted',
    cancelled: 'annotation.statusCancelled', completed: 'annotation.statusCompleted', rejected: 'annotation.statusRejected' };
  const statusMenuOptions = () => statusOptions(statusSetDefinition()).map(option => ({ ...option,
    label: !statusSetDefinition() || option.key === 'none' ? tContext(builtInStatusLabels[option.key] || option.name) : option.name }));
  const saveStatusSet = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setStatusSetError('Open a PDF first.'); return; }
    try { await ensureMarkupColumnsReady(doc); }
    catch { setStatusSetError(t('markupsList.statusSetUnreadable')); return; }
    if (getActiveDocument() !== doc) return;
    const definition = parseStatusLines(statusSetNameInput(), statusSetLinesInput());
    if (!definition) { setStatusSetError(t('markupsList.statusSetInvalid')); return; }
    if (JSON.stringify(validStatusSet(doc.markupStatusSet)) !== JSON.stringify(definition)) {
      doc.markupStatusSet = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setStatusSetDefinition(definition);
    setStatusSetError('');
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const resetStatusSet = async () => {
    const doc = getActiveDocument();
    if (!doc) return;
    try { await ensureMarkupColumnsReady(doc); } catch { /* reset still applies */ }
    if (getActiveDocument() !== doc) return;
    if (doc.markupStatusSet) {
      doc.markupStatusSet = false; // the saver then removes the set from the PDF
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setStatusSetDefinition(null);
    setStatusSetNameInput('');
    setStatusSetLinesInput(statusLines(null));
    setStatusSetError('');
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const changeStatus = (item, value) => import('../../../../ui/panels/annotations-list.js')
    .then(module => module.setMarkupStatus(item.id, value));
  const changeField = (item, field, value) => import('../../../../ui/panels/annotations-list.js')
    .then(module => module.setMarkupField(item.id, field, value));
  // The selected row edits in place: comment and custom column values.
  // Enter or leaving the field saves, Escape puts the old value back.
  const InlineText = (props) => (
    <Show when={props.item.selected && !props.item.locked} fallback={<span title={props.shown}>{props.shown}</span>}>
      <input class="annotation-cell-input" type="text" value={props.value ?? ''}
        aria-label={props.label}
        on:click={(event) => event.stopPropagation()}
        on:dblclick={(event) => event.stopPropagation()}
        on:keydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { event.currentTarget.value = props.value ?? ''; event.currentTarget.blur(); }
        }}
        onChange={(event) => changeField(props.item, props.field, event.currentTarget.value)} />
    </Show>
  );
  const InlineChoice = (props) => (
    <Show when={props.item.selected && !props.item.locked && props.options?.length} fallback={<span>{props.shown}</span>}>
      <select class="annotation-cell-input" value={props.shown || ''} aria-label={props.label}
        on:click={(event) => event.stopPropagation()}
        on:keydown={(event) => event.stopPropagation()}
        onChange={(event) => changeField(props.item, props.field, event.currentTarget.value)}>
        <option value=""></option>
        <For each={props.options}>{option => <option value={option}>{option}</option>}</For>
      </select>
    </Show>
  );
  const selectedCustomMarkup = () => {
    const selected = items().filter(item => !item.isHeader && item.selected);
    return selected.length === 1 ? selected[0] : null;
  };
  const selectedCustomAnnotation = () => getActiveDocument()?.annotations?.find(
    annotation => annotation.id === selectedCustomMarkup()?.id);
  createEffect(() => {
    items();
    const name = customTextColumnName(getActiveDocument()?.markupTextColumnName);
    setCustomName(name);
    setCustomNameInput(name);
    const second = customTextColumnName(getActiveDocument()?.markupTextColumn2Name);
    setSecondTextName(second);
    setSecondTextNameInput(second);
  });
  createEffect(() => {
    items();
    const definition = validChoiceColumn(getActiveDocument()?.markupChoiceColumn,
      getActiveDocument()?.markupTextColumnName);
    setChoiceDefinition(definition);
    setChoiceNameInput(definition?.name || '');
    setChoiceOptionsInput(definition?.options.join('\n') || '');
    setChoiceNumericInput(definition?.version === CHOICE_NUMERIC_SCHEMA_VERSION
      ? definition.numericValues.map(value => value ?? '').join('\n') : '');
  });
  createEffect(() => {
    items();
    const definition = validChoiceColumn(getActiveDocument()?.markupChoiceColumn2);
    setSecondChoiceDefinition(definition);
    setSecondChoiceNameInput(definition?.name || '');
    setSecondChoiceOptionsInput(definition?.options.join('\n') || '');
    setSecondChoiceNumericInput(definition?.version === CHOICE_NUMERIC_SCHEMA_VERSION
      ? definition.numericValues.map(value => value ?? '').join('\n') : '');
  });
  createEffect(() => {
    items();
    const doc = getActiveDocument();
    const definition = validNumberColumn(doc?.markupNumberColumn, doc?.markupTextColumnName,
      doc?.markupChoiceColumn?.name);
    setNumberDefinition(definition);
    setNumberNameInput(definition?.name || '');
  });
  createEffect(() => {
    items();
    const definition = validNumberColumn(getActiveDocument()?.markupNumberColumn2);
    setSecondNumberDefinition(definition);
    setSecondNumberNameInput(definition?.name || '');
  });
  createEffect(() => {
    items();
    const doc = getActiveDocument();
    const definition = validCheckmarkColumn(doc?.markupCheckmarkColumn, doc?.markupTextColumnName,
      doc?.markupChoiceColumn?.name, doc?.markupNumberColumn?.name);
    setCheckmarkDefinition(definition);
    setCheckmarkNameInput(definition?.name || '');
  });
  createEffect(() => {
    items();
    const doc = getActiveDocument();
    const definition = validFormulaColumn(doc?.markupFormulaColumn, doc?.markupNumberColumn,
      doc?.markupTextColumnName, doc?.markupChoiceColumn?.name,
      doc?.markupCheckmarkColumn?.name, doc?.markupChoiceColumn, doc?.markupNumberColumn2);
    setFormulaDefinition(definition);
    setFormulaNameInput(definition?.name || '');
    setFormulaSourceInput(definition?.source || (doc?.markupNumberColumn ? 'customNumber'
      : doc?.markupNumberColumn2 ? 'customNumber2' : 'customChoice'));
    setFormulaMultiplierInput(definition?.multiplier || '1');
    setFormulaOffsetInput(definition?.offset || '0');
  });
  createEffect(() => {
    const selected = selectedCustomMarkup();
    setCustomValueInput(selected?.customTextValue || '');
    setSecondTextValueInput(selected?.customTextValue2 || '');
    setNumberValueInput(selected?.customNumberValue || '');
    setSecondNumberValueInput(selected?.customNumberValue2 || '');
    setNumberValueError('');
    setSecondNumberValueError('');
  });
  const [exporting, setExporting] = createSignal(false);
  const [exportMessage, setExportMessage] = createSignal('');
  const [menuPos, setMenuPos] = createSignal({ top: 0, left: 0 });
  let menuRef;
  let menuBtnRef;
  let columnsRef;
  let filtersRef;

  const displayColumns = () => visibleColumns().filter(column =>
    (column !== 'customText' || customName()) && (column !== 'customText2' || secondTextName())
    && (column !== 'customChoice' || choiceDefinition())
    && (column !== 'customChoice2' || secondChoiceDefinition())
    && (column !== 'customNumber' || numberDefinition())
    && (column !== 'customNumber2' || secondNumberDefinition())
    && (column !== 'customCheckmark' || checkmarkDefinition())
    && (column !== 'customFormula' || formulaDefinition()) && expressionDefined(column));
  const columnGrid = () => `22px ${columnGridTemplate(displayColumns())}`;
  const persistColumns = (next) => {
    setVisibleColumns(next);
    writeVisibleColumns(next);
  };
  // Another part of the app showed columns (e.g. after filling them).
  const columnsShown = (event) => { if (Array.isArray(event.detail?.columns)) setVisibleColumns(event.detail.columns); };
  window.addEventListener('ocudraw:markup-columns', columnsShown);
  onCleanup(() => window.removeEventListener('ocudraw:markup-columns', columnsShown));
  const toggleColumn = (column) => {
    if (column === ANCHOR_COLUMN) return;
    const next = withColumnToggled(visibleColumns(), column);
    persistColumns(next);
    if (columnSort() && !next.includes(columnSort().column)) {
      setColumnSort(null);
      import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
    }
  };
  const moveColumn = (column, offset) => {
    const next = [...visibleColumns()];
    const from = next.indexOf(column);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    persistColumns(next);
  };
  const columnOptions = () => [...visibleColumns(), ...MARKUP_COLUMNS.filter(column => !visibleColumns().includes(column))]
    .filter(column => (column !== 'customText' || customName())
      && (column !== 'customText2' || secondTextName())
      && (column !== 'customChoice' || choiceDefinition())
      && (column !== 'customChoice2' || secondChoiceDefinition())
      && (column !== 'customNumber' || numberDefinition())
      && (column !== 'customNumber2' || secondNumberDefinition())
      && (column !== 'customCheckmark' || checkmarkDefinition())
      && (column !== 'customFormula' || formulaDefinition()) && expressionDefined(column));
  const saveCustomName = async (event) => {
    event.preventDefault();
    const name = customTextColumnName(customNameInput());
    if (!name) { setCustomNameError(`Enter a unique single-line name up to ${CUSTOM_TEXT_NAME_MAX} characters.`); return; }
    const doc = getActiveDocument();
    if (!doc) { setCustomNameError('Open a PDF first.'); return; }
    try { await ensureMarkupColumnsReady(doc); }
    catch { setCustomNameError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    if (name.toLocaleLowerCase() === doc.markupTextColumn2Name?.toLocaleLowerCase()
        || name.toLocaleLowerCase() === doc.markupChoiceColumn?.name?.toLocaleLowerCase()
        || name.toLocaleLowerCase() === doc.markupChoiceColumn2?.name?.toLocaleLowerCase()
        || name.toLocaleLowerCase() === doc.markupNumberColumn?.name?.toLocaleLowerCase()
        || name.toLocaleLowerCase() === doc.markupNumberColumn2?.name?.toLocaleLowerCase()
        || name.toLocaleLowerCase() === doc.markupCheckmarkColumn?.name?.toLocaleLowerCase()
        || name.toLocaleLowerCase() === doc.markupFormulaColumn?.name?.toLocaleLowerCase()) {
      setCustomNameError('Text, Choice, Number, Checkmark and Formula columns need different names.'); return;
    }
    if (name !== doc.markupTextColumnName) {
      doc.markupTextColumnName = name;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setCustomName(name);
    setCustomNameError('');
    if (!visibleColumns().includes('customText')) persistColumns([...visibleColumns(), 'customText']);
  };
  const saveCustomValue = (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!annotation || annotation.locked || annotation.readOnly) return;
    const value = customTextValue(customValueInput());
    if (value === (annotation.markupTextValue || '')) return;
    commitAnnotationMutation(annotation, current => { current.markupTextValue = value; });
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveSecondTextName = async (event) => {
    event.preventDefault();
    const name = customTextColumnName(secondTextNameInput());
    if (!name) { setSecondTextNameError(`Enter a unique single-line name up to ${CUSTOM_TEXT_NAME_MAX} characters.`); return; }
    const doc = getActiveDocument();
    if (!doc) { setSecondTextNameError('Open a PDF first.'); return; }
    try { await ensureMarkupColumnsReady(doc); }
    catch { setSecondTextNameError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const otherNames = [doc.markupTextColumnName, doc.markupChoiceColumn?.name,
      doc.markupChoiceColumn2?.name,
      doc.markupNumberColumn?.name, doc.markupNumberColumn2?.name,
      doc.markupCheckmarkColumn?.name, doc.markupFormulaColumn?.name];
    if (otherNames.some(other => name.toLocaleLowerCase() === other?.toLocaleLowerCase())) {
      setSecondTextNameError('Text, Choice, Number, Checkmark and Formula columns need different names.'); return;
    }
    if (name !== doc.markupTextColumn2Name) {
      doc.markupTextColumn2Name = name;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setSecondTextName(name);
    setSecondTextNameError('');
    if (!visibleColumns().includes('customText2')) persistColumns([...visibleColumns(), 'customText2']);
  };
  const saveSecondTextValue = (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!annotation || annotation.locked || annotation.readOnly) return;
    const value = customTextValue(secondTextValueInput());
    if (value === (annotation.markupTextValue2 || '')) return;
    commitAnnotationMutation(annotation, current => { current.markupTextValue2 = value; });
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveChoiceDefinition = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setChoiceError('Open a PDF first.'); return; }
    const proposedName = choiceNameInput();
    const proposedOptions = choiceOptionsInput();
    const proposedNumeric = choiceNumericInput();
    try { await ensureMarkupColumnsReady(doc); }
    catch { setChoiceError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const options = proposedOptions.split(/\r?\n/u).map(option => option.trim()).filter(Boolean);
    const numericLines = proposedNumeric.split(/\r?\n/u);
    const numericValues = options.map((_, index) => {
      const entered = (numericLines[index] || '').trim();
      return entered && numberValue(entered) !== null ? numberText(entered) : entered || null;
    });
    const hasNumeric = numericValues.some(value => value !== null);
    const definition = numericLines.slice(options.length).some(line => line.trim()) ? null
      : validChoiceColumn(hasNumeric
        ? { version: CHOICE_NUMERIC_SCHEMA_VERSION, name: proposedName, options, numericValues }
        : { version: CHOICE_SCHEMA_VERSION, name: proposedName, options }, doc.markupTextColumnName);
    if (!definition || definition.name.toLocaleLowerCase() === doc.markupNumberColumn?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupNumberColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupCheckmarkColumn?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupTextColumn2Name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupChoiceColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupFormulaColumn?.name?.toLocaleLowerCase()) {
      setChoiceError(`Enter a unique name and 1–${CHOICE_OPTIONS_MAX} distinct options, one per line (max ${CHOICE_OPTION_MAX} characters each).`);
      return;
    }
    if (doc.markupFormulaColumn?.source === 'customChoice'
        && definition.version !== CHOICE_NUMERIC_SCHEMA_VERSION) {
      setChoiceError('Keep at least one numeric Choice value while Formula uses Choice.');
      return;
    }
    const previous = validChoiceColumn(doc.markupChoiceColumn);
    if (previous && !previous.options.every((option, index) => definition.options[index] === option)) {
      setChoiceError('Existing options must stay in order so saved markup choices remain valid.');
      return;
    }
    if (JSON.stringify(previous) !== JSON.stringify(definition)) {
      doc.markupChoiceColumn = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setChoiceDefinition(definition);
    setChoiceNumericInput(definition.version === CHOICE_NUMERIC_SCHEMA_VERSION
      ? definition.numericValues.map(value => value ?? '').join('\n') : '');
    if (!doc.markupNumberColumn && definition.version === CHOICE_NUMERIC_SCHEMA_VERSION) {
      setFormulaSourceInput('customChoice');
    }
    setChoiceError('');
    if (!visibleColumns().includes('customChoice')) persistColumns([...visibleColumns(), 'customChoice']);
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveChoiceValue = (event) => {
    const definition = choiceDefinition();
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!definition || !annotation || annotation.locked || annotation.readOnly) return;
    const value = choiceValue(event.currentTarget.value, definition.options);
    if (value === (annotation.markupChoiceValue || '')) return;
    commitAnnotationMutation(annotation, current => { current.markupChoiceValue = value; });
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveSecondChoiceDefinition = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setSecondChoiceError('Open a PDF first.'); return; }
    const proposedName = secondChoiceNameInput();
    const options = secondChoiceOptionsInput().split(/\r?\n/u).map(option => option.trim()).filter(Boolean);
    const numericLines = secondChoiceNumericInput().split(/\r?\n/u);
    const numericValues = options.map((_, index) => {
      const entered = (numericLines[index] || '').trim();
      return entered && numberValue(entered) !== null ? numberText(entered) : entered || null;
    });
    try { await ensureMarkupColumnsReady(doc); }
    catch { setSecondChoiceError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const hasNumeric = numericValues.some(value => value !== null);
    const definition = numericLines.slice(options.length).some(line => line.trim()) ? null
      : validChoiceColumn(hasNumeric
        ? { version: CHOICE_NUMERIC_SCHEMA_VERSION, name: proposedName, options, numericValues }
        : { version: CHOICE_SCHEMA_VERSION, name: proposedName, options });
    const otherNames = [doc.markupTextColumnName, doc.markupTextColumn2Name,
      doc.markupChoiceColumn?.name, doc.markupNumberColumn?.name, doc.markupNumberColumn2?.name,
      doc.markupCheckmarkColumn?.name, doc.markupFormulaColumn?.name];
    if (!definition || otherNames.some(other =>
      definition.name.toLocaleLowerCase() === other?.toLocaleLowerCase())) {
      setSecondChoiceError(`Enter a unique name and 1–${CHOICE_OPTIONS_MAX} distinct options, one per line (max ${CHOICE_OPTION_MAX} characters each).`);
      return;
    }
    const previous = validChoiceColumn(doc.markupChoiceColumn2);
    if (previous && !previous.options.every((option, index) => definition.options[index] === option)) {
      setSecondChoiceError('Existing options must stay in order so saved markup choices remain valid.');
      return;
    }
    if (JSON.stringify(previous) !== JSON.stringify(definition)) {
      doc.markupChoiceColumn2 = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setSecondChoiceDefinition(definition);
    setSecondChoiceNumericInput(definition.version === CHOICE_NUMERIC_SCHEMA_VERSION
      ? definition.numericValues.map(value => value ?? '').join('\n') : '');
    setSecondChoiceError('');
    if (!visibleColumns().includes('customChoice2')) persistColumns([...visibleColumns(), 'customChoice2']);
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveSecondChoiceValue = (event) => {
    const definition = secondChoiceDefinition();
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!definition || !annotation || annotation.locked || annotation.readOnly) return;
    const value = choiceValue(event.currentTarget.value, definition.options);
    if (value === (annotation.markupChoiceValue2 || '')) return;
    commitAnnotationMutation(annotation, current => { current.markupChoiceValue2 = value; });
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveNumberDefinition = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setNumberNameError('Open a PDF first.'); return; }
    const proposedName = numberNameInput();
    try { await ensureMarkupColumnsReady(doc); }
    catch { setNumberNameError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const definition = validNumberColumn({ version: NUMBER_SCHEMA_VERSION, name: proposedName },
      doc.markupTextColumnName, doc.markupChoiceColumn?.name);
    if (!definition || definition.name.toLocaleLowerCase() === doc.markupCheckmarkColumn?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupNumberColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupChoiceColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupTextColumn2Name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupFormulaColumn?.name?.toLocaleLowerCase()) {
      setNumberNameError('Enter a unique single-line name; Text, Choice, Number, Checkmark and Formula names must differ.');
      return;
    }
    if (JSON.stringify(doc.markupNumberColumn) !== JSON.stringify(definition)) {
      doc.markupNumberColumn = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setNumberDefinition(definition);
    setNumberNameError('');
    if (!visibleColumns().includes('customNumber')) persistColumns([...visibleColumns(), 'customNumber']);
  };
  const saveNumberValue = (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!numberDefinition() || !annotation || annotation.locked || annotation.readOnly) return;
    const entered = numberValueInput().trim();
    const value = entered ? numberValue(entered) : null;
    if (entered && value === null) {
      setNumberValueError('Enter a plain decimal with up to 9 integer and 6 fractional digits.');
      return;
    }
    setNumberValueError('');
    if (value === numberValue(annotation.markupNumberValue)
        && (value !== null || annotation.markupNumberValue == null)) return;
    commitAnnotationMutation(annotation, current => { current.markupNumberValue = value; });
    setNumberValueInput(numberText(value));
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveSecondNumberDefinition = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setSecondNumberNameError('Open a PDF first.'); return; }
    const proposedName = secondNumberNameInput();
    try { await ensureMarkupColumnsReady(doc); }
    catch { setSecondNumberNameError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const definition = validNumberColumn({ version: NUMBER_SCHEMA_VERSION, name: proposedName });
    const otherNames = [doc.markupTextColumnName, doc.markupTextColumn2Name,
      doc.markupChoiceColumn?.name, doc.markupChoiceColumn2?.name,
      doc.markupNumberColumn?.name, doc.markupCheckmarkColumn?.name, doc.markupFormulaColumn?.name];
    if (!definition || otherNames.some(other =>
      definition.name.toLocaleLowerCase() === other?.toLocaleLowerCase())) {
      setSecondNumberNameError('Enter a unique single-line name; custom column names must differ.');
      return;
    }
    if (JSON.stringify(doc.markupNumberColumn2) !== JSON.stringify(definition)) {
      doc.markupNumberColumn2 = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setSecondNumberDefinition(definition);
    setSecondNumberNameError('');
    if (!visibleColumns().includes('customNumber2')) persistColumns([...visibleColumns(), 'customNumber2']);
  };
  const saveSecondNumberValue = (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!secondNumberDefinition() || !annotation || annotation.locked || annotation.readOnly) return;
    const entered = secondNumberValueInput().trim();
    const value = entered ? numberValue(entered) : null;
    if (entered && value === null) {
      setSecondNumberValueError('Enter a plain decimal with up to 9 integer and 6 fractional digits.');
      return;
    }
    setSecondNumberValueError('');
    if (value === numberValue(annotation.markupNumberValue2)
        && (value !== null || annotation.markupNumberValue2 == null)) return;
    commitAnnotationMutation(annotation, current => { current.markupNumberValue2 = value; });
    setSecondNumberValueInput(numberText(value));
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveCheckmarkDefinition = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setCheckmarkNameError('Open a PDF first.'); return; }
    const proposedName = checkmarkNameInput();
    try { await ensureMarkupColumnsReady(doc); }
    catch { setCheckmarkNameError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const definition = validCheckmarkColumn({ version: CHECKMARK_SCHEMA_VERSION, name: proposedName },
      doc.markupTextColumnName, doc.markupChoiceColumn?.name, doc.markupNumberColumn?.name);
    if (!definition || definition.name.toLocaleLowerCase() === doc.markupFormulaColumn?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupNumberColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupChoiceColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupTextColumn2Name?.toLocaleLowerCase()) {
      setCheckmarkNameError('Enter a unique single-line name; Text, Choice, Number, Checkmark and Formula names must differ.');
      return;
    }
    if (JSON.stringify(doc.markupCheckmarkColumn) !== JSON.stringify(definition)) {
      doc.markupCheckmarkColumn = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setCheckmarkDefinition(definition);
    setCheckmarkNameError('');
    if (!visibleColumns().includes('customCheckmark')) persistColumns([...visibleColumns(), 'customCheckmark']);
  };
  const saveCheckmarkValue = (event) => {
    const doc = getActiveDocument();
    const annotation = doc?.annotations?.find(candidate => candidate.id === selectedCustomMarkup()?.id);
    if (!checkmarkDefinition() || !annotation || annotation.locked || annotation.readOnly) return;
    const value = checkmarkValue(event.currentTarget.value);
    if (value === checkmarkValue(annotation.markupCheckmarkValue)) return;
    commitAnnotationMutation(annotation, current => { current.markupCheckmarkValue = value; });
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };
  const saveFormulaDefinition = async (event) => {
    event.preventDefault();
    const doc = getActiveDocument();
    if (!doc) { setFormulaError('Open a PDF first.'); return; }
    const enteredMultiplier = formulaMultiplierInput().trim();
    const enteredOffset = formulaOffsetInput().trim();
    const source = formulaSourceInput();
    const proposal = { version: source === 'customChoice'
      ? FORMULA_CHOICE_SCHEMA_VERSION : source === 'customNumber2'
        ? FORMULA_SECOND_NUMBER_SCHEMA_VERSION : FORMULA_SCHEMA_VERSION, name: formulaNameInput(),
      source,
      multiplier: numberValue(enteredMultiplier) === null ? enteredMultiplier : numberText(enteredMultiplier),
      offset: numberValue(enteredOffset) === null ? enteredOffset : numberText(enteredOffset) };
    try { await ensureMarkupColumnsReady(doc); }
    catch { setFormulaError('Could not read the PDF column definitions.'); return; }
    if (getActiveDocument() !== doc) return;
    const definition = validFormulaColumn(proposal, doc.markupNumberColumn,
      doc.markupTextColumnName, doc.markupChoiceColumn?.name,
      doc.markupCheckmarkColumn?.name, doc.markupChoiceColumn, doc.markupNumberColumn2);
    if (!definition || definition.name.toLocaleLowerCase() === doc.markupTextColumn2Name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupNumberColumn2?.name?.toLocaleLowerCase()
        || definition.name.toLocaleLowerCase() === doc.markupChoiceColumn2?.name?.toLocaleLowerCase()) {
      setFormulaError('Choose a Number or numerically mapped Choice source, then enter a unique name and plain decimal multiplier and offset (up to 9 integer and 6 fractional digits).');
      return;
    }
    if (JSON.stringify(doc.markupFormulaColumn) !== JSON.stringify(definition)) {
      doc.markupFormulaColumn = definition;
      doc.modified = true;
      doc.savedUndoStackLength = -1;
    }
    setFormulaDefinition(definition);
    setFormulaSourceInput(definition.source);
    setFormulaMultiplierInput(definition.multiplier);
    setFormulaOffsetInput(definition.offset);
    setFormulaError('');
    if (!visibleColumns().includes('customFormula')) persistColumns([...visibleColumns(), 'customFormula']);
    import('../../../../ui/panels/annotations-list.js').then(module => module.updateAnnotationsList());
  };

  const closeMenu = (e) => {
    if (menuRef && !menuRef.contains(e.target) && menuBtnRef && !menuBtnRef.contains(e.target)) {
      setMenuOpen(false);
    }
  };

  document.addEventListener('mousedown', closeMenu);
  onCleanup(() => document.removeEventListener('mousedown', closeMenu));

  const closeColumns = (event) => {
    if (columnsRef && !columnsRef.contains(event.target)) setColumnsOpen(false);
  };
  document.addEventListener('mousedown', closeColumns);
  onCleanup(() => document.removeEventListener('mousedown', closeColumns));

  const closeFilters = (event) => {
    if (filtersRef && !filtersRef.contains(event.target)) setFiltersOpen(false);
  };
  document.addEventListener('mousedown', closeFilters);
  onCleanup(() => document.removeEventListener('mousedown', closeFilters));

  const saveCurrentFilter = () => {
    const result = addSavedFilter(savedFilters(), filterName(), {
      searchQuery: searchQuery(), filterMode: filterMode(), hiddenStatuses: [...hiddenStatuses()],
      columnFilters: columnFilters(),
    });
    if (result.error) { setFilterMessage(result.error); return; }
    setSavedFilters(result.filters);
    setFilterName('');
    setFilterMessage(writeSavedFilters(result.filters)
      ? `Saved ${result.filters.at(-1).name}.` : 'Saved for this session. Local storage is unavailable.');
  };

  const applySavedFilter = (filter) => {
    setSearchQuery(filter.searchQuery);
    setFilterMode(filter.filterMode);
    replaceHiddenStatuses(filter.hiddenStatuses);
    setColumnFilters(normalizeColumnFilters(filter.columnFilters));
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
    setFilterMessage(`Applied ${filter.name}.`);
    setFiltersOpen(false);
  };

  const deleteSavedFilter = (name) => {
    const next = savedFilters().filter(filter => filter.name !== name);
    setSavedFilters(next);
    setFilterMessage(writeSavedFilters(next) ? `Deleted ${name}.` : 'Removed for this session. Local storage is unavailable.');
  };

  const closeAndRun = (fn) => {
    setMenuOpen(false);
    fn();
  };

  const applyFilter = (value) => {
    setFilterMode(value);
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList(value));
    setMenuOpen(false);
  };

  const applySearch = (value) => {
    setSearchQuery(value);
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
  };

  // Status aan/uit zetten sluit het menu bewust NIET, zodat meerdere
  // statussen achter elkaar (de)geselecteerd kunnen worden (#236).
  const toggleStatusFilter = (statusKey) => {
    toggleHiddenStatus(statusKey);
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
  };

  const applySort = (value) => {
    setSortMode(value);
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
    setMenuOpen(false);
  };

  const applyColumnSort = (column) => {
    setColumnSort(current => nextMarkupColumnSort(current, column));
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
  };

  // the external editor column names.
  const columnLabels = { page: t('markupsList.colPageIndex'), type: t('markupsList.colType'),
    comment: t('markupsList.colComments'), status: t('markupsList.colStatus'), author: t('markupsList.colAuthor'),
    subject: t('markupsList.colSubject'), layer: t('markupsList.layer'), pageLabel: t('markupsList.pageLabel'),
    lock: t('markupsList.colLock'), date: t('markupsList.colDate'), color: t('markupsList.colColor'),
    attachments: tCommon('capture.column'), space: tCommon('spaces.column') };
  const columnLabel = column => column === 'customText' ? customName()
    : column === 'customText2' ? secondTextName()
    : column === 'customChoice' ? choiceDefinition()?.name
      : column === 'customChoice2' ? secondChoiceDefinition()?.name
      : column === 'customNumber' ? numberDefinition()?.name
      : column === 'customNumber2' ? secondNumberDefinition()?.name
        : column === 'customCheckmark' ? checkmarkDefinition()?.name
          : column === 'customFormula' ? formulaDefinition()?.name
            : expressionColumnIndex(column) >= 0 ? expressionDefinitions()[expressionColumnIndex(column)]?.name
              : columnLabels[column];
  const sortScope = (column) => column === 'page' && sortMode() === 'page'
    ? 'across page groups' : 'within groups';
  const sortSummary = () => {
    const sort = columnSort();
    return sort ? `Sorted: ${columnLabel(sort.column)} ${sort.direction === 'ascending' ? '↑' : '↓'} ${sortScope(sort.column)}` : '';
  };

  // Column header filters (the external editor "Filter List"): a checklist of the values in
  // a column; unchecked values hide their rows.
  const [filterPopover, setFilterPopover] = createSignal(null);
  let filterPopoverRef;
  const openColumnFilter = async (column, event) => {
    event.stopPropagation();
    if (filterPopover()?.column === column) { setFilterPopover(null); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const list = await import('../../../../ui/panels/annotations-list.js');
    setFilterPopover({ column, values: list.markupColumnFilterValues(column),
      // The dock sits at the bottom: keep the 320px checklist on screen.
      top: Math.round(Math.max(8, Math.min(rect.bottom + 2, window.innerHeight - 330))),
      left: Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - 240))) });
  };
  const applyColumnFilters = (next) => {
    setColumnFilters(next);
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
  };
  const hiddenInColumn = (column) => new Set(columnFilters()[column] || []);
  const closeFilterPopover = (event) => {
    if (filterPopoverRef && !filterPopoverRef.contains(event.target)
        && !event.target.closest?.('.annotation-column-filter')) setFilterPopover(null);
  };
  document.addEventListener('mousedown', closeFilterPopover);
  onCleanup(() => document.removeEventListener('mousedown', closeFilterPopover));

  const columnHeader = (column, label) => {
    const direction = () => columnSort()?.column === column ? columnSort().direction : 'none';
    const filtered = () => !!columnFilters()[column]?.length;
    return (
      <div class={`annotation-cell annotation-cell-${column}`}>
        <Show when={FILTERABLE_COLUMNS.includes(column) && (filterListOn() || filtered())}>
          <button type="button" class={`annotation-column-filter${filtered() ? ' active' : ''}`}
            aria-haspopup="dialog" aria-expanded={filterPopover()?.column === column}
            aria-label={t(filtered() ? 'markupsList.filterColumnActive' : 'markupsList.filterColumn', { column: label })}
            title={t(filtered() ? 'markupsList.filterColumnActive' : 'markupsList.filterColumn', { column: label })}
            onClick={(event) => openColumnFilter(column, event)}
            innerHTML={chevronDownIcon}></button>
        </Show>
        <button
          type="button"
          class="annotation-column-sort"
          aria-label={`Sort ${label} ${direction() === 'ascending' ? 'descending' : 'ascending'} ${sortScope(column)}`}
          aria-pressed={direction() !== 'none'}
          onClick={() => applyColumnSort(column)}
        >
          <span>{label}</span>
          <span class="annotation-sort-indicator" aria-hidden="true">{direction() === 'ascending' ? '▲' : direction() === 'descending' ? '▼' : ''}</span>
        </button>
      </div>
    );
  };

  const openCaptureOf = (item) => import('../../../../annotations/capture-actions.js').then((m) => {
    const annotation = m.findAnnotation(item.id);
    if (!annotation) return;
    if (!m.openPhotoViewer(annotation)) m.openAttachedFile(annotation);
  });

  // Lock column (the external editor): toggles the markup's own lock, with undo.
  const toggleLock = (item) => {
    const annotation = getActiveDocument()?.annotations?.find(candidate => candidate.id === item.id);
    if (!annotation) return;
    commitAnnotationMutation(annotation, current => { current.locked = !current.locked; });
    if (getActiveDocument()?.selectedAnnotation === annotation) {
      import('../../../../ui/panels/properties-panel.js').then(m => m.showProperties(annotation));
    }
    refreshList();
  };

  // The eyes (docs/reference/editor/layers.md): a click or key on them never reaches
  // the row or group header, so it neither selects nor folds.
  const stopEye = (event) => event.stopPropagation();
  const onEyeKeyDown = (event) => {
    // App shortcuts (Ctrl+Z after an eye click, Ctrl+G, ...) still work.
    if (event.ctrlKey || event.metaKey) return;
    event.stopPropagation();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault();
  };
  // The list rebuilds the row or header after a switch; a keyboard user keeps
  // focus on the same eye.
  const refocusEye = (selector, hadFocus) => {
    if (!hadFocus) return;
    queueMicrotask(() => document.querySelector(selector)?.focus({ preventScroll: true }));
  };
  const toggleRowEye = (item, event) => {
    event.stopPropagation();
    event.preventDefault();
    // Hidden by its layer: the eye explains (tooltip) and changes nothing.
    if (item.layerHidden) return;
    const hadFocus = document.activeElement === event.currentTarget;
    import('../../../../ui/panels/annotations-list.js').then((m) => {
      m.toggleMarkupHidden(item.id);
      refocusEye(`.annotation-list-item[data-annotation-id="${CSS.escape(item.id)}"] .annotation-eye`, hadFocus);
    });
  };
  const rowEye = (item) => (
    <button type="button"
      class={`annotation-eye${item.hidden || item.layerHidden ? ' is-hidden' : ''}${item.layerHidden ? ' by-layer' : ''}`}
      aria-pressed={!!(item.hidden || item.layerHidden)}
      aria-disabled={item.layerHidden ? 'true' : undefined}
      aria-label={item.layerHidden
        ? t('markupsList.hiddenByLayerFor', { markup: item.subjectLabel, layer: item.layerName })
        : t(item.hidden ? 'markupsList.showMarkupFor' : 'markupsList.hideMarkupFor', { markup: item.subjectLabel })}
      title={item.layerHidden
        ? t('markupsList.hiddenByLayerTip', { layer: item.layerName })
        : t(item.hidden ? 'markupsList.showMarkupFor' : 'markupsList.hideMarkupFor', { markup: item.subjectLabel })}
      on:click={(event) => toggleRowEye(item, event)}
      on:mousedown={stopEye}
      on:dblclick={stopEye}
      on:keydown={onEyeKeyDown}
      innerHTML={item.hidden || item.layerHidden ? eyeOffIcon : eyeIcon}></button>
  );
  const groupEye = (item) => (
    <button type="button" class={`annotation-eye annotation-group-eye${item.layerHidden ? ' is-hidden' : ''}`}
      aria-pressed={!!item.layerHidden}
      aria-label={t(item.layerHidden ? 'markupsList.showLayerFor' : 'markupsList.hideLayerFor', { layer: item.headerLabel })}
      title={t(item.layerHidden ? 'markupsList.showLayerFor' : 'markupsList.hideLayerFor', { layer: item.headerLabel })}
      data-layer-id={item.layerId}
      on:click={(event) => {
        event.stopPropagation();
        event.preventDefault();
        const hadFocus = document.activeElement === event.currentTarget;
        // The Layers panel's own switch: one state for both panels.
        import('../../../stores/annotationLayersStore.js').then((m) => {
          m.setAnnotationLayerFlag(item.layerId, 'visible', !!item.layerHidden);
          // The list refreshes after the layer change (a dynamic import): wait a frame.
          if (hadFocus) requestAnimationFrame(() => refocusEye(`.annotation-group-eye[data-layer-id="${CSS.escape(item.layerId)}"]`, true));
        });
      }}
      on:mousedown={stopEye}
      on:dblclick={stopEye}
      on:keydown={onEyeKeyDown}
      innerHTML={item.layerHidden ? eyeOffIcon : eyeIcon}></button>
  );
  // The eye of a section (every Group By) or of a Group row (docs/reference/editor/markups-list.md):
  // its markups' own Hidden flags. 'mixed' shows a half eye; a click then
  // shows all. 'layer': their layers hide them all, the layer decides.
  const categoryEye = (item, eyeKey, label) => (
    <button type="button"
      class={`annotation-eye annotation-group-eye annotation-category-eye${item.eye === 'hidden' ? ' is-hidden' : ''}${item.eye === 'mixed' ? ' is-mixed' : ''}${item.eye === 'layer' ? ' by-layer' : ''}`}
      aria-pressed={item.eye === 'mixed' ? 'mixed' : item.eye === 'hidden' || item.eye === 'layer'}
      aria-disabled={item.eye === 'layer' ? 'true' : undefined}
      aria-label={t(item.eye === 'layer' ? 'markupsList.categoryHiddenByLayer'
        : item.eye === 'shown' ? 'markupsList.hideCategoryFor' : 'markupsList.showCategoryFor', { name: label })}
      title={t(item.eye === 'layer' ? 'markupsList.categoryHiddenByLayer'
        : item.eye === 'shown' ? 'markupsList.hideCategoryFor'
          : item.eye === 'mixed' ? 'markupsList.showMixedCategoryFor' : 'markupsList.showCategoryFor', { name: label })}
      data-eye-key={eyeKey}
      on:click={(event) => {
        event.stopPropagation();
        event.preventDefault();
        if (item.eye === 'layer') return;
        const hadFocus = document.activeElement === event.currentTarget;
        import('../../../../ui/panels/annotations-list.js').then((m) => {
          m.toggleCategoryEye(eyeKey);
          refocusEye(`.annotation-category-eye[data-eye-key="${CSS.escape(eyeKey)}"]`, hadFocus);
        });
      }}
      on:mousedown={stopEye}
      on:dblclick={stopEye}
      on:keydown={onEyeKeyDown}
      innerHTML={item.eye === 'shown' ? eyeIcon : eyeOffIcon}></button>
  );
  const sectionEye = (item) => categoryEye(item, `section:${item.groupKey}`,
    item.sortMode === 'color' ? item.headerColor : headerText(item));
  const headerEye = (item) => (item.sortMode === 'layer' && item.layerId ? groupEye(item) : sectionEye(item));

  // Drag rows onto a section header or a Group row: put them in that
  // category (Subject, Author, Layer, or the group). docs/reference/editor/markups-list.md.
  const DRAG_TYPE = 'application/x-ocudraw-markups';
  const onRowDragStart = (item, event) => {
    const doc = getActiveDocument();
    const ids = item.selected || item.groupSelected
      ? (doc?.selectedAnnotations || []).map(a => a.id)
      : item.isMarkupGroup ? (doc?.annotations || []).filter(a => a.groupPath?.some(g => g.id === item.mgId)).map(a => a.id)
        : [item.id];
    if (!ids.length || !event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
  };
  const [dropTarget, setDropTarget] = createSignal(null);
  const canDrop = (item) => (item.isMarkupGroup ? !item.locked
    : item.isHeader && (item.sortMode === 'subject' || item.sortMode === 'author' || (item.sortMode === 'layer' && item.layerId)));
  const dropKey = (item) => (item.isMarkupGroup ? `group:${item.mgId}` : `header:${item.groupKey}`);
  const onDragOver = (item, event) => {
    if (!canDrop(item) || !event.dataTransfer?.types?.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(dropKey(item));
  };
  const onDragLeave = (item) => { if (dropTarget() === dropKey(item)) setDropTarget(null); };
  const onDrop = (item, event) => {
    setDropTarget(null);
    if (!canDrop(item)) return;
    let ids;
    try { ids = JSON.parse(event.dataTransfer?.getData(DRAG_TYPE) || '[]'); } catch { ids = []; }
    if (!Array.isArray(ids) || !ids.length) return;
    event.preventDefault();
    import('../../../../ui/panels/annotations-list.js').then(m => m.dropMarkupsOnCategory(ids, item.isMarkupGroup
      ? { groupId: item.mgId } : { sortMode: item.sortMode, groupKey: item.groupKey, layerId: item.layerId }));
  };
  const dropProps = (item) => ({
    'on:dragover': (event) => onDragOver(item, event),
    'on:dragleave': () => onDragLeave(item),
    'on:drop': (event) => onDrop(item, event),
  });

  // A row is shown when its section is open and every Group above it is open.
  const rowShown = (item) => !collapsedGroups().has(item.groupKey)
    && (!item.mgAncestors || item.mgAncestors.split('|').every(id => expandedMarkupGroups().has(id)));

  let listElement;
  let listHeaderElement;
  const [listScrollTop, setListScrollTop] = createSignal(0);
  const [listHeight, setListHeight] = createSignal(600);
  const [listHeaderHeight, setListHeaderHeight] = createSignal(30);
  const [measureRevision, setMeasureRevision] = createSignal(0);
  const measuredRows = new Map();
  const visibleRows = createMemo(() => items().filter(item => item.isHeader || rowShown(item)));
  const rowLayout = createMemo(() => {
    measureRevision();
    return buildVirtualRows(visibleRows(), measuredRows);
  });
  const rowWindow = createMemo(() => virtualRowWindow(rowLayout(),
    Math.max(0, listScrollTop() - listHeaderHeight()),
    Math.max(0, listHeight() - listHeaderHeight())));
  const updateListSize = () => {
    if (!listElement) return;
    setListHeight(listElement.clientHeight);
    setListHeaderHeight(listHeaderElement?.offsetHeight || 30);
    setListScrollTop(listElement.scrollTop);
  };
  const rowSizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      const key = entry.target.dataset.virtualKey;
      const height = entry.target.getBoundingClientRect().height;
      if (!key || !(height > 0) || measuredRows.get(key) === height) continue;
      measuredRows.delete(key);
      measuredRows.set(key, height);
      changed = true;
    }
    while (measuredRows.size > 5000) measuredRows.delete(measuredRows.keys().next().value);
    if (changed) setMeasureRevision(value => value + 1);
  }) : null;
  const scrollToRowIndex = (index) => {
    if (!listElement || index < 0) return;
    const layout = rowLayout();
    const top = listHeaderHeight() + layout.offsets[index];
    const bottom = listHeaderHeight() + layout.offsets[index + 1];
    const viewTop = listElement.scrollTop + listHeaderHeight();
    const viewBottom = listElement.scrollTop + listElement.clientHeight;
    if (top < viewTop) listElement.scrollTop = Math.max(0, top - listHeaderHeight());
    else if (bottom > viewBottom) listElement.scrollTop = bottom - listElement.clientHeight;
    setListScrollTop(listElement.scrollTop);
  };
  const focusMarkupRow = (id, fromId = null) => {
    const selector = `.annotation-list-item[data-annotation-id="${CSS.escape(String(id))}"]`;
    let attempts = 0;
    const focus = () => {
      const active = document.activeElement;
      if (active !== document.body && active?.dataset.annotationId !== String(id)
          && (fromId == null || active?.dataset.annotationId !== String(fromId))) return;
      listElement?.querySelector(selector)?.focus({ preventScroll: true });
      if (++attempts < 4) requestAnimationFrame(focus);
    };
    requestAnimationFrame(focus);
  };
  let sizeObserver;
  let revealListener;
  onMount(() => {
    updateListSize();
    sizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(updateListSize) : null;
    if (listElement) sizeObserver?.observe(listElement);
    if (listHeaderElement) sizeObserver?.observe(listHeaderElement);
    revealListener = event => {
      const detail = event.detail || {};
      const index = visibleRows().findIndex(item => detail.rowId != null
        ? !item.isHeader && !item.isReply && !item.isReplyInput && String(item.id) === String(detail.rowId)
        : item.isMarkupGroup && String(item.mgId) === String(detail.groupId));
      if (index < 0) return;
      scrollToRowIndex(index);
    };
    document.addEventListener('ocudraw:reveal-markup-row', revealListener);
  });
  onCleanup(() => {
    if (revealListener) document.removeEventListener('ocudraw:reveal-markup-row', revealListener);
    sizeObserver?.disconnect();
    rowSizeObserver?.disconnect();
  });

  const activateGroupRow = (item, event) => {
    const key = `group:${item.mgId}`;
    const shiftSelect = !!event.shiftKey;
    const multiSelect = !shiftSelect && !!(event.ctrlKey || event.metaKey);
    // Read the anchor now. The selection itself waits its turn, and a later
    // click must not change the row this one ranges from.
    const anchorAtClick = markupAnchorKey;
    if (shiftSelect) {
      if (!markupAnchorKey) markupAnchorKey = key;
    } else if (!multiSelect) markupAnchorKey = key;
    const operation = selectionQueue.then(async () => {
      const m = await import('../../../../ui/panels/annotations-list.js');
      if (shiftSelect) return m.selectMarkupRange(anchorAtClick, key, item.page);
      return m.selectMarkupGroupItem(item.mgId, multiSelect);
    });
    selectionQueue = operation.catch(() => {});
    return operation;
  };
  const onGroupRowContextMenu = (item, event) => {
    event.preventDefault();
    const x = event.clientX;
    const y = event.clientY;
    const ready = item.groupSelected ? Promise.resolve() : activateGroupRow(item, { ctrlKey: false, metaKey: false });
    void ready.then(() => {
      const doc = getActiveDocument();
      const dom = doc?.annotations?.find(a => a.id === item.dominantId) || null;
      showMultiAnnotationMenu(x, y, doc?.selectedAnnotations?.length || 0, { markupGroupId: item.mgId, annotation: dom });
    }).catch(() => {});
  };
  const renameGroupRow = (item) => openDialog('markup-name', { mode: 'groupName', groupId: item.mgId, value: item.name });
  const groupCell = (item, column) => {
    switch (column) {
      case 'subject': return <div class="annotation-cell annotation-cell-subject annotation-group-subject"
        style={{ 'padding-left': `${item.depth * 14}px` }} title={item.name}
        on:dblclick={(event) => { event.stopPropagation(); if (!item.locked) renameGroupRow(item); }}>
        <button type="button" class="annotation-thread-toggle annotation-mg-toggle"
          aria-expanded={expandedMarkupGroups().has(item.mgId)}
          aria-label={t(expandedMarkupGroups().has(item.mgId) ? 'markupsList.collapseGroup' : 'markupsList.expandGroup', { name: item.name })}
          on:click={(event) => { event.stopPropagation(); toggleMarkupGroup(item.mgId); }}
          on:keydown={(event) => event.stopPropagation()}>
          <span class="annotation-thread-chevron" innerHTML={expandedMarkupGroups().has(item.mgId) ? chevronDownIcon : chevronRightIcon}></span>
        </button>
        <span class="annotation-type-glyph" style={{ color: item.color }} innerHTML={groupGlyph}></span>
        <span class="annotation-cell-subject-label">{item.name}</span>
        <span class="annotations-group-count">({item.count})</span>
      </div>;
      case 'page': return <div class="annotation-cell annotation-cell-page">{item.page}</div>;
      case 'pageLabel': return <div class="annotation-cell annotation-cell-pageLabel">{item.pageLabel}</div>;
      case 'type': return <div class="annotation-cell annotation-cell-type">
        <div class="annotation-list-color" style={{ 'background-color': item.color }}></div>
        <span class="annotation-cell-type-label">{tCommon('markupGroups.group')}</span>
      </div>;
      case 'author': return <div class="annotation-cell annotation-cell-author">{item.author}</div>;
      case 'date': return <div class="annotation-cell annotation-cell-date" title={item.date}>{item.date}</div>;
      case 'color': return <div class="annotation-cell annotation-cell-color">
        <span class="annotation-color-swatch" style={{ 'background-color': item.color }} title={item.color}></span>
      </div>;
      // the external editor: Count, Length and Area of the members on the Group row.
      case 'comment': return <div class="annotation-cell annotation-cell-comment" title={item.totalsText}>{item.totalsText}</div>;
      case 'layer': return <div class="annotation-cell annotation-cell-layer" title={item.layerName}>{item.layerName}</div>;
      case 'space': return <div class="annotation-cell annotation-cell-space">{item.spaceName}</div>;
      default: return <div class={`annotation-cell annotation-cell-${column}`}></div>;
    }
  };
  const groupRow = (item) => (
    <div class={`annotation-list-item annotation-group-row${item.groupSelected ? ' selected' : ''}${item.eye === 'hidden' || item.eye === 'layer' ? ' markup-hidden' : ''}${dropTarget() === `group:${item.mgId}` ? ' drop-target' : ''}`}
      role="button" tabIndex="0" aria-pressed={item.groupSelected} aria-expanded={expandedMarkupGroups().has(item.mgId)}
      aria-label={`${tCommon('markupGroups.group')} ${item.name}, ${item.count}`}
      data-markup-group-id={item.mgId}
      draggable={!item.locked}
      on:dragstart={(event) => onRowDragStart(item, event)}
      {...dropProps(item)}
      on:click={(event) => activateGroupRow(item, event)}
      on:keydown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          if ((event.key === 'ArrowRight') !== expandedMarkupGroups().has(item.mgId)) toggleMarkupGroup(item.mgId);
          return;
        }
        if (event.key === 'F2' && !item.locked) { event.preventDefault(); renameGroupRow(item); return; }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateGroupRow(item, event);
      }}
      on:contextmenu={(event) => onGroupRowContextMenu(item, event)}>
      <div class="annotation-cell annotation-cell-gutter">{categoryEye(item, `group:${item.mgId}`, item.name)}</div>
      <For each={displayColumns()}>{(column) => groupCell(item, column)}</For>
    </div>
  );

  const columnCell = (item, column) => {
    switch (column) {
      case 'page': return <div class="annotation-cell annotation-cell-page">{item.page}</div>;
      case 'type': return <div class="annotation-cell annotation-cell-type">
        <div class="annotation-list-color" style={{ 'background-color': item.color }}></div>
        <span class="annotation-cell-type-label">{item.typeLabel}</span>
      </div>;
      case 'subject': return <div class="annotation-cell annotation-cell-subject" title={item.typeLabel}
        style={item.depth ? { 'padding-left': `${item.depth * 14 + 18}px` } : undefined}>
        <span class="annotation-type-glyph" style={{ color: item.color }} innerHTML={typeGlyph(item.type)}></span>
        <span class="annotation-cell-subject-label">{item.subjectLabel}</span>
        <Show when={item.threadCount > 0}>
          <button type="button" class="annotation-thread-toggle" aria-expanded={!!item.threadOpen}
            aria-label={t(item.threadOpen ? 'markupsList.hideReplies' : 'markupsList.showReplies', { count: item.threadCount })}
            title={t(item.threadOpen ? 'markupsList.hideReplies' : 'markupsList.showReplies', { count: item.threadCount })}
            on:click={(event) => { event.stopPropagation(); toggleThread(item.id); refreshList(); }}
            on:keydown={(event) => event.stopPropagation()}>
            <span class="annotation-thread-chevron" innerHTML={item.threadOpen ? chevronDownIcon : chevronRightIcon}></span>
            <span>{item.threadCount}</span>
          </button>
        </Show>
      </div>;
      case 'lock': return <div class="annotation-cell annotation-cell-lock">
        <input type="checkbox" checked={item.ownLock} aria-label={t('markupsList.lockFor', { markup: item.subjectLabel })}
          title={t('markupsList.lockFor', { markup: item.subjectLabel })}
          on:click={(event) => { event.stopPropagation(); toggleLock(item); }}
          on:keydown={(event) => event.stopPropagation()} />
      </div>;
      case 'date': return <div class="annotation-cell annotation-cell-date" title={item.date}>{item.date}</div>;
      case 'color': return <div class="annotation-cell annotation-cell-color">
        <span class="annotation-color-swatch" style={{ 'background-color': item.color }} title={item.color}></span>
      </div>;
      case 'comment': return <div class="annotation-cell annotation-cell-comment">
        <InlineText item={item} field="text" value={item.text || ''} shown={item.text || ''} label="Comment" /></div>;
      case 'status': return <div class="annotation-cell annotation-cell-status">
        <Show when={item.statusColor}>
          <span class="annotation-status-dot" style={{ 'background-color': item.statusColor }}></span>
        </Show>
        <Show when={item.selected && !item.locked} fallback={
          <Show when={item.statusColor}>
            <span title={item.statusBy ? t('markupsList.statusBy', { status: item.statusTitle, author: item.statusBy }) : item.statusTitle}>{item.statusTitle}</span>
          </Show>
        }>
          <select class="annotation-status-select" aria-label={t('markupsList.statusFor', { markup: item.typeLabel })}
            value={item.statusKey}
            on:click={(event) => event.stopPropagation()}
            on:keydown={(event) => event.stopPropagation()}
            onChange={(event) => changeStatus(item, event.currentTarget.value)}>
            <Show when={!statusMenuOptions().some(option => option.key === item.statusKey)}>
              <option value={item.statusKey}>{item.statusTitle}</option>
            </Show>
            <For each={statusMenuOptions()}>{option => <option value={option.key}>{option.label}</option>}</For>
          </select>
        </Show>
      </div>;
      case 'author': return <div class="annotation-cell annotation-cell-author">{item.author}</div>;
      case 'customText': return <div class="annotation-cell annotation-cell-customText">
        <InlineText item={item} field="markupTextValue" value={item.customTextValue} shown={item.customTextValue} label="Text value" /></div>;
      case 'customText2': return <div class="annotation-cell annotation-cell-customText2">
        <InlineText item={item} field="markupTextValue2" value={item.customTextValue2} shown={item.customTextValue2} label="Second text value" /></div>;
      case 'customChoice': return <div class="annotation-cell annotation-cell-customChoice">
        <InlineChoice item={item} field="markupChoiceValue" options={choiceDefinition()?.options}
          shown={choiceValue(item.customChoiceValue, choiceDefinition()?.options)} label="Choice value" /></div>;
      case 'customChoice2': return <div class="annotation-cell annotation-cell-customChoice2">
        <InlineChoice item={item} field="markupChoiceValue2" options={secondChoiceDefinition()?.options}
          shown={choiceValue(item.customChoiceValue2, secondChoiceDefinition()?.options)} label="Second choice value" /></div>;
      case 'customNumber': return <div class="annotation-cell annotation-cell-customNumber">
        <InlineText item={item} field="markupNumberValue" value={numberText(item.customNumberValue)}
          shown={numberText(item.customNumberValue)} label="Number value" /></div>;
      case 'customNumber2': return <div class="annotation-cell annotation-cell-customNumber2">
        <InlineText item={item} field="markupNumberValue2" value={numberText(item.customNumberValue2)}
          shown={numberText(item.customNumberValue2)} label="Second number value" /></div>;
      case 'customCheckmark': return <div class="annotation-cell annotation-cell-customCheckmark">
        {checkmarkText(item.customCheckmarkValue)}</div>;
      case 'customFormula': return <div class="annotation-cell annotation-cell-customFormula">
        {item.customFormulaValue}</div>;
      case 'layer': return <div class="annotation-cell annotation-cell-layer" title={item.layerName}>{item.layerName}</div>;
      case 'pageLabel': return <div class="annotation-cell annotation-cell-pageLabel" title={item.pageLabel}>{item.pageLabel}</div>;
      // Capture photos / attached file (capture.js): thumbnails on hover,
      // double-click opens the viewer (or the attached file).
      case 'attachments': return <div class="annotation-cell annotation-cell-attachments"
        aria-label={item.attachmentCount ? tCommon('capture.columnTip', { count: item.attachmentCount }) : undefined}
        on:mouseenter={(event) => item.attachmentCount && showCaptureTip(item.id, event)}
        on:mouseleave={hideCaptureTip}
        on:dblclick={(event) => { event.stopPropagation(); hideCaptureTip(); openCaptureOf(item); }}>
        <Show when={item.attachmentCount > 0}><span innerHTML={paperclipIcon}></span>{item.attachmentCount}</Show>
      </div>;
      case 'space': return <div class="annotation-cell annotation-cell-space" title={item.spaceName}>{item.spaceName}</div>;
      default: return expressionColumnIndex(column) >= 0
        ? <div class={`annotation-cell annotation-cell-exprFormula${item[`${column}Warning`] === 'uncalibrated' ? ' uncalibrated' : ''}`}
          title={item[`${column}Warning`] === 'uncalibrated' ? tCommon('formulaCaptions.scaleNotSet') : undefined}>
          {item[`${column}Warning`] === 'uncalibrated' ? '⚠' : item[column]}</div>
        : null;
    }
  };

  const expandAll = () => expandAllGroups();
  const anyGroupOpen = () => items().some(item => item.isHeader && !collapsedGroups().has(item.groupKey));

  const collapseAll = () => {
    const allKeys = items().filter(i => i.isHeader).map(i => i.groupKey);
    collapseAllGroups(allKeys);
  };

  const hasSelection = () => !!state.documents[state.activeDocumentIndex]?.selectedAnnotation;

  const exportMarkups = async (selectionOnly) => {
    const doc = getActiveDocument();
    if (!doc?.annotations?.length || exporting()) return;
    const selected = selectionOnly
      ? (doc.selectedAnnotations?.length ? doc.selectedAnnotations : [doc.selectedAnnotation].filter(Boolean))
      : null;
    if (selectionOnly && !selected.length) return;
    setExporting(true);
    setExportMessage('');
    try {
      await ensureMarkupColumnsReady(doc);
      if (getActiveDocument() !== doc) return;
      const fileName = (doc.filePath || doc.currentPdfPath || 'drawing').split(/[\\/]/u).pop().replace(/\.pdf$/iu, '');
      const suffix = selectionOnly ? '-selected-markups.csv' : '-markups.csv';
      const path = await saveFileDialog(markupExportPath(doc, `${fileName}${suffix}`), [{ name: 'CSV', extensions: ['csv'] }]);
      if (!path) return;
      const csv = markupCsv(doc.annotations, selected, doc.markupTextColumnName,
        doc.markupChoiceColumn, doc.markupNumberColumn, doc.markupCheckmarkColumn,
        doc.markupFormulaColumn, doc.markupTextColumn2Name, doc.markupChoiceColumn2,
        doc.markupNumberColumn2, { replyRows: true, layerName: await markupLayerNamer(doc),
          spaceOf: await markupSpaceNamer(doc) });
      await writeBinaryFile(path, new TextEncoder().encode(csv));
      setExportMessage(`Exported ${selectionOnly ? 'selected ' : ''}markups CSV.`);
    } catch (error) {
      setExportMessage(`Could not export markups: ${error.message}`);
    } finally {
      setExporting(false);
    }
  };

  // The Space column in exports, only when the document has spaces.
  const markupSpaceNamer = async (doc) => {
    const list = await import('../../../../ui/panels/annotations-list.js');
    return list.markupSpaceNamer(doc) || undefined;
  };

  const markupLayerNamer = async (doc) => {
    const list = await import('../../../../ui/panels/annotations-list.js');
    return annotation => list.markupLayerName(doc, annotation);
  };

  // Summary (the external editor Summarize): the markups the list shows, in list order,
  // with replies and status history; CSV, PDF or XML from the same rows.
  const [summarySelectedOnly, setSummarySelectedOnly] = createSignal(false);
  const [latestStatusOnly, setLatestStatusOnly] = createSignal(false);
  const exportSummary = async (format) => {
    const doc = getActiveDocument();
    if (!doc?.annotations?.length || exporting()) return;
    setExporting(true);
    setExportMessage('');
    try {
      await ensureMarkupColumnsReady(doc);
      if (getActiveDocument() !== doc) return;
      const list = await import('../../../../ui/panels/annotations-list.js');
      const listed = list.currentListMarkups();
      const selectedSet = new Set(doc.selectedAnnotations?.length ? doc.selectedAnnotations : [doc.selectedAnnotation].filter(Boolean));
      const markups = summarySelectedOnly() ? listed.filter(annotation => selectedSet.has(annotation)) : listed;
      if (!markups.length) { setExportMessage(t('markupsList.summaryEmpty')); return; }
      const options = { replyRows: true, statusHistory: true, latestStatusOnly: latestStatusOnly(),
        statusSet: doc.markupStatusSet, inListOrder: true,
        layerName: annotation => list.markupLayerName(doc, annotation),
        pageLabel: annotation => list.markupPageLabel(doc, annotation.page),
        spaceOf: await markupSpaceNamer(doc) };
      const sourcePath = doc.filePath || doc.currentPdfPath || 'drawing.pdf';
      const base = String(sourcePath).split(/[\\/]/u).pop().replace(/\.pdf$/iu, '') || 'drawing';
      const path = await saveFileDialog(markupExportPath(doc, `${base}-markups-summary.${format}`),
        [{ name: format.toUpperCase(), extensions: [format] }]);
      if (!path) return;
      const columns = { customTextColumn: doc.markupTextColumnName, customSecondTextColumn: doc.markupTextColumn2Name,
        customChoiceColumn: doc.markupChoiceColumn, customSecondChoiceColumn: doc.markupChoiceColumn2,
        customNumberColumn: doc.markupNumberColumn, customSecondNumberColumn: doc.markupNumberColumn2,
        customCheckmarkColumn: doc.markupCheckmarkColumn, customFormulaColumn: doc.markupFormulaColumn };
      const rows = () => markupSummaryRows(doc.annotations, markups, doc.markupChoiceColumn,
        doc.markupNumberColumn, doc.markupCheckmarkColumn, doc.markupFormulaColumn,
        doc.markupChoiceColumn2, doc.markupNumberColumn2, options);
      let bytes;
      if (format === 'csv') {
        bytes = new TextEncoder().encode(markupCsv(doc.annotations, markups, doc.markupTextColumnName,
          doc.markupChoiceColumn, doc.markupNumberColumn, doc.markupCheckmarkColumn,
          doc.markupFormulaColumn, doc.markupTextColumn2Name, doc.markupChoiceColumn2,
          doc.markupNumberColumn2, options));
      } else if (format === 'xml') {
        const { markupSummaryXml } = await import('../../../../annotations/markup-xml.js');
        bytes = new TextEncoder().encode(markupSummaryXml({ sourcePath, rows: rows(), ...columns,
          latestStatusOnly: latestStatusOnly() }));
      } else {
        const [module, response] = await Promise.all([
          import('../../../../annotations/markup-pdf.js'),
          fetch('/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf'),
        ]);
        if (!response.ok) throw new Error('Could not load the bundled markup report font.');
        bytes = await module.buildMarkupSummaryPdf({ sourcePath, rows: rows(), ...columns,
          showStatusHistory: true, latestStatusOnly: latestStatusOnly() },
        new Uint8Array(await response.arrayBuffer()));
      }
      await writeBinaryFile(path, bytes);
      setExportMessage(t('markupsList.summaryDone', { count: markups.length, format: format.toUpperCase() }));
    } catch (error) {
      setExportMessage(`Could not export markups: ${error.message}`);
    } finally {
      setExporting(false);
    }
  };

  // the external editor's export button (↑): CSV export and the Summary formats.
  const openExportMenu = (event) => {
    const r = event.currentTarget.getBoundingClientRect();
    const none = !getActiveDocument()?.annotations?.length || exporting();
    openPanelMenu(r.left, r.bottom + 2, [
      { label: t('markupsList.exportCsv'), icon: exportCommentsIcon, disabled: none, run: () => exportMarkups(false) },
      { label: t('markupsList.exportSelectedCsv'), icon: exportCommentsIcon, disabled: none || !hasSelection(),
        run: () => exportMarkups(true) },
      { separator: true },
      { label: t('markupsList.summary'), icon: summarizeIcon, items: [
        ...['csv', 'pdf', 'xml'].map(format => ({ label: t(`markupsList.summary${format.toUpperCase()}`), disabled: none,
          run: () => exportSummary(format) })),
        { separator: true },
        { label: t('markupsList.summarySelectedOnly'), checked: summarySelectedOnly(), run: () => setSummarySelectedOnly(v => !v) },
        { label: t('markupsList.summaryLatestStatus'), checked: latestStatusOnly(), run: () => setLatestStatusOnly(v => !v) },
      ] },
    ]);
  };

  const cutSelected = () => {
    const doc = getActiveDocument();
    const ann = doc?.selectedAnnotation;
    if (!ann) return;
    import('../../../../annotations/clipboard.js').then(({ copyAnnotation, copyAnnotations }) => {
      // Een vervanging (#508) wordt in haar geheel geknipt.
      const weg = expandCorrectionGroups(doc.annotations, [ann]);
      // Een vergrendelde andere helft gaat niet ongevraagd mee.
      if (weg.some(a => a.locked && a !== ann)) return;
      if (weg.length > 1) copyAnnotations(weg);
      else copyAnnotation(ann);
      deleteAnnotationsWithUndo(doc, weg);
      if (doc) { doc.selectedAnnotation = null; doc.selectedAnnotations = []; }
      import('../../../../annotations/rendering.js').then(({ redrawAnnotations }) => redrawAnnotations());
      import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
    });
  };

  const copySelected = () => {
    const doc = getActiveDocument();
    const ann = doc?.selectedAnnotation;
    if (!ann) return;
    import('../../../../annotations/clipboard.js').then(({ copyAnnotation }) => copyAnnotation(ann));
  };

  const deleteSelected = async () => {
    const doc = getActiveDocument();
    const ann = doc?.selectedAnnotation;
    if (!ann) return;
    const { showConfirm } = await import('../../../../ui/chrome/confirm-dialog.js');
    const confirmed = await showConfirm({
      title: t('deleteAnnotation.title'),
      message: t('deleteAnnotation.confirmSingle'),
      preferenceKey: 'confirmBeforeDelete'
    });
    if (confirmed) {
      // Een vervanging (#508) gaat in haar geheel, met één ongedaan-stap.
      deleteAnnotationsWithUndo(doc, [ann]);
      if (doc) { doc.selectedAnnotation = null; doc.selectedAnnotations = []; }
      import('../../../../annotations/rendering.js').then(({ redrawAnnotations }) => redrawAnnotations());
      import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
    }
  };

  // Document ▸ Flatten… on the selected markups (docs/reference/editor/markup-tools.md).
  const flattenSelected = () => {
    import('../../../commands/index.js').then(m => m.runCommand('document.flatten', { selection: true }))
      .catch(() => {});
  };

  const deselectAll = () => {
    clearSelection();
    import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
    import('../../../../annotations/rendering.js').then(({ redrawAnnotations }) => redrawAnnotations());
  };

  const showProperties = () => {
    const doc = getActiveDocument();
    const ann = doc?.selectedAnnotation;
    if (ann) {
      import('../../../../ui/panels/properties-panel.js').then(m => m.showProperties(ann));
    }
  };

  const headerText = (item) => {
    if (item.sortMode === 'page') return `${tCommon('page')} ${item.page}`;
    if (item.sortMode === 'color') return '';
    return item.headerLabel || '';
  };

  let markupActivation = 0;
  let selectionQueue = Promise.resolve();
  // The row a plain click last selected. Shift-click selects through to it.
  let markupAnchorKey = null;
  const activateMarkup = (item, event) => {
    const shiftSelect = !!event.shiftKey;
    const multiSelect = !shiftSelect && (event.ctrlKey || event.metaKey);
    const key = `markup:${item.id}`;
    const anchorAtClick = markupAnchorKey;
    if (shiftSelect) {
      if (!markupAnchorKey) markupAnchorKey = key;
    } else if (!multiSelect) markupAnchorKey = key;
    const activation = ++markupActivation;
    const operation = selectionQueue.then(async () => {
      const list = await import('../../../../ui/panels/annotations-list.js');
      if (shiftSelect) {
        await list.selectMarkupRange(anchorAtClick, key, item.page);
        return;
      }
      await list.selectAnnotationItem(item.id, item.page, multiSelect);
    });
    selectionQueue = operation.catch(() => {});
    return { activation, operation };
  };
  const onMarkupKeyDown = (item, event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      // The document-level arrow handler nudges markups or turns pages.
      event.stopPropagation();
      const rows = visibleRows();
      const current = rows.findIndex(candidate => !candidate.isHeader && String(candidate.id) === String(item.id));
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let nextIndex = current + step;
      while (nextIndex >= 0 && nextIndex < rows.length
          && (rows[nextIndex].isHeader || rows[nextIndex].isMarkupGroup
            || rows[nextIndex].isReply || rows[nextIndex].isReplyInput)) nextIndex += step;
      const nextItem = rows[nextIndex];
      if (!nextItem) return;
      scrollToRowIndex(nextIndex);
      focusMarkupRow(nextItem.id, item.id);
      const { activation, operation } = activateMarkup(nextItem, { ctrlKey: false, metaKey: false });
      void operation.finally(() => {
        // Selection refreshes the list and can replace the focused row.
        // Restore focus so a second arrow key continues from this markup.
        if (activation !== markupActivation) return;
        if (document.activeElement !== document.body &&
            !document.activeElement?.classList.contains('annotation-list-item')) return;
        const refreshedIndex = visibleRows().findIndex(row => !row.isHeader && String(row.id) === String(nextItem.id));
        scrollToRowIndex(refreshedIndex);
        focusMarkupRow(nextItem.id);
      }).catch(() => {});
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activateMarkup(item, event);
  };
  const refreshList = () => import('../../../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
  const onMarkupContextMenu = (item, event) => {
    event.preventDefault();
    const annotation = getActiveDocument()?.annotations?.find(candidate => candidate.id === item.id);
    if (!annotation) return;
    const x = event.clientX;
    const y = event.clientY;
    const { operation } = item.selected ? { operation: Promise.resolve() } : activateMarkup(item, event);
    void operation.then(() => {
      // A multi-selection (or a group) gets the selection menu, as on the canvas.
      const count = getActiveDocument()?.selectedAnnotations?.length || 0;
      if (count > 1 && item.selected) showMultiAnnotationMenu(x, y, count, { annotation });
      else showAnnotationMenu(x, y, annotation);
    }).catch(() => {});
  };
  const startReply = (id) => import('../../../../ui/panels/annotations-list.js').then(m => m.startMarkupReply(id));
  const ReplyInput = (props) => {
    let input;
    const [error, setError] = createSignal('');
    const post = async (event) => {
      event.preventDefault();
      const list = await import('../../../../ui/panels/annotations-list.js');
      if (!list.addMarkupReply(props.item.parentId, input?.value || '')) setError(t('markupsList.replyEmpty'));
    };
    const cancel = () => import('../../../../ui/panels/annotations-list.js').then(m => m.cancelMarkupReply());
    queueMicrotask(() => input?.focus({ preventScroll: true }));
    return (
      <form class="annotation-reply-form" onSubmit={post}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}>
        <span class="annotation-reply-indent" aria-hidden="true" innerHTML={replyIcon}></span>
        <input ref={input} type="text" maxLength={REPLY_TEXT_MAX} disabled={props.item.locked}
          aria-label={t('markupsList.replyPlaceholder')} placeholder={t('markupsList.replyPlaceholder')}
          onInput={() => setError('')} />
        <button type="submit" disabled={props.item.locked}>{t('markupsList.replyPost')}</button>
        <button type="button" onClick={cancel}>{tCommon('cancel')}</button>
        <Show when={props.item.locked}><span class="annotation-reply-error">{t('markupsList.replyLocked')}</span></Show>
        <Show when={error()}><span role="alert" class="annotation-reply-error">{error()}</span></Show>
      </form>
    );
  };
  const replyRow = (item) => (
    <div class={`annotation-reply-row${item.isStatusEntry ? ' status-entry' : ''}`} data-parent-id={item.parentId}
      title={`${item.author} · ${item.date}`}
      on:click={() => activateMarkup({ id: item.parentId, page: item.page }, { ctrlKey: false, metaKey: false })}>
      <span class="annotation-reply-indent" aria-hidden="true" innerHTML={replyIcon}></span>
      <span class="annotation-reply-author">{item.author}</span>
      <span class="annotation-reply-date">{item.date}</span>
      <span class="annotation-reply-text">{item.isStatusEntry ? t('markupsList.statusChanged', { status: item.text }) : item.text}</span>
    </div>
  );

  // A markup-layer header selects that layer's markups (and the list highlights
  // them). Shift-click from a selected layer header to another selects every
  // layer in between, in list order. The chevron still folds the group.
  // Other headers only fold.
  let layerAnchorId = null;
  const onSectionHeaderClick = (item, event) => {
    if (event.target?.closest?.('.annotations-group-chevron')) {
      toggleGroup(item.groupKey);
      return;
    }
    if (item.sortMode === 'layer' && item.layerId) {
      import('../../../stores/annotationLayersStore.js').then(m => {
        if (event.shiftKey) {
          const headers = items().filter(it => it.isHeader && it.sortMode === 'layer' && it.layerId);
          m.selectAnnotationsOnLayers(m.layerRangeIds(headers, layerAnchorId, item.layerId));
          return;
        }
        layerAnchorId = item.layerId;
        m.selectAnnotationsOnLayer(item.layerId);
      });
      return;
    }
    toggleGroup(item.groupKey);
  };
  const onGroupKeyDown = (item, event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSectionHeaderClick(item, event);
  };

  return (
    <div class={`left-panel-content${activeTab() === 'annotations' ? ' active' : ''}`} id="annotations-panel">
      <PanelHeader panelId="markupsList" class="ml-header">
      <div class="annotations-toolbar ml-toolbar">
        <button type="button" class={`annotations-toolbar-btn ml-eye${allMarkupsHidden() ? ' active' : ''}`}
          aria-pressed={allMarkupsHidden()}
          title={allMarkupsHidden() ? t('markupsList.showMarkups') : t('markupsList.hideMarkups')}
          aria-label={allMarkupsHidden() ? t('markupsList.showMarkups') : t('markupsList.hideMarkups')}
          onClick={() => setAllMarkupsHidden(!allMarkupsHidden())}
          innerHTML={lucide('eye-off')}></button>
        <div class="ml-search" role="search">
          <span class="ml-search-icon" innerHTML={lucide('search')}></span>
          <input
            class="annotations-search"
            type="search"
            aria-label={`${tCommon('search')} ${t('leftPanel.annotations')}`}
            placeholder={tCommon('search')}
            value={searchQuery()}
            onInput={(event) => applySearch(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Escape' && searchQuery()) { event.stopPropagation(); applySearch(''); } }}
          />
          <Show when={searchQuery()}>
            <button type="button" class="ml-search-clear" aria-label={t('markupsList.searchClear')}
              title={t('markupsList.searchClear')} onClick={() => applySearch('')} innerHTML={lucide('x')}></button>
          </Show>
        </div>
        <button type="button" class={`annotations-toolbar-btn ml-filter-list${filterListOn() ? ' active' : ''}`}
          aria-pressed={filterListOn()} title={t('markupsList.filterListTitle')} onClick={toggleFilterList}>
          <span class="ml-btn-icon" innerHTML={lucide('funnel')}></span>
          <span>{t('markupsList.filterList')}</span>
        </button>
        <button type="button" class="annotations-toolbar-btn ml-export" aria-haspopup="menu"
          title={t('markupsList.export')} aria-label={t('markupsList.export')}
          disabled={!getActiveDocument()?.annotations?.length || exporting()}
          onClick={(event) => openExportMenu(event)} innerHTML={lucide('share')}></button>
        <div class="annotations-toolbar-menu-wrapper ml-more">
          <button
            ref={menuBtnRef}
            class={`annotations-toolbar-btn${menuOpen() ? ' active' : ''}`}
            title={t('markupsList.more')}
            aria-label={t('markupsList.more')}
            onClick={() => {
              if (!menuOpen() && menuBtnRef) {
                const rect = menuBtnRef.getBoundingClientRect();
                const isRtl = document.documentElement.dir === 'rtl';
                // In the bottom dock the menu opens upwards, so it stays on screen.
                const vertical = rect.top > window.innerHeight / 2
                  ? { bottom: window.innerHeight - rect.top } : { top: rect.bottom };
                if (isRtl) {
                  setMenuPos({ ...vertical, right: window.innerWidth - rect.right });
                } else {
                  // The » sits at the right end: keep the menu inside the window.
                  setMenuPos({ ...vertical, left: Math.max(4, Math.min(rect.left, window.innerWidth - 260)) });
                }
              }
              setMenuOpen(!menuOpen());
            }}
            innerHTML={lucide('chevrons-right')}
          >
          </button>
          <Show when={menuOpen()}>
            <div class={`annotations-menu${menuPos().bottom !== undefined ? ' opens-up' : ''}`} ref={menuRef} style={{
              ...(menuPos().bottom !== undefined ? { bottom: `${menuPos().bottom}px` } : { top: `${menuPos().top}px` }),
              ...(menuPos().right !== undefined ? { right: `${menuPos().right}px` } : { left: `${menuPos().left}px` })
            }}>
              <div class={`annotations-menu-item${!getActiveDocument()?.annotations?.length || exporting() ? ' disabled' : ''}`}
                role="button" aria-disabled={!getActiveDocument()?.annotations?.length || exporting()}
                tabIndex={!getActiveDocument()?.annotations?.length || exporting() ? -1 : 0}
                onClick={() => getActiveDocument()?.annotations?.length && closeAndRun(() => void exportMarkups(false))}
                onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && getActiveDocument()?.annotations?.length && !exporting()) { event.preventDefault(); closeAndRun(() => void exportMarkups(false)); } }}>
                <span class="annotations-menu-icon" innerHTML={exportCommentsIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.exportComments')} (CSV)</span>
              </div>
              <div class={`annotations-menu-item${!hasSelection() || exporting() ? ' disabled' : ''}`}
                role="button" aria-disabled={!hasSelection() || exporting()}
                tabIndex={!hasSelection() || exporting() ? -1 : 0}
                onClick={() => hasSelection() && closeAndRun(() => void exportMarkups(true))}
                onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && hasSelection() && !exporting()) { event.preventDefault(); closeAndRun(() => void exportMarkups(true)); } }}>
                <span class="annotations-menu-icon" innerHTML={exportCommentsIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.exportSelectedComments')} (CSV)</span>
              </div>
              <div class="annotations-menu-separator"></div>
              {/* Cut / Copy / Delete / Flatten */}
              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(cutSelected)}
              >
                <span class="annotations-menu-icon" innerHTML={cutIcon}></span>
                <span class="annotations-menu-label">{tCommon('cut')}</span>
                <span class="annotations-menu-shortcut">Ctrl+X</span>
              </div>
              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(copySelected)}
              >
                <span class="annotations-menu-icon" innerHTML={copyIcon}></span>
                <span class="annotations-menu-label">{tCommon('copy')}</span>
                <span class="annotations-menu-shortcut">Ctrl+C</span>
              </div>
              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(deleteSelected)}
              >
                <span class="annotations-menu-icon" innerHTML={deleteIcon}></span>
                <span class="annotations-menu-label">{tCommon('delete')}</span>
                <span class="annotations-menu-shortcut">Delete</span>
              </div>
              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(flattenSelected)}
              >
                <span class="annotations-menu-icon" innerHTML={flattenIcon}></span>
                <span class="annotations-menu-label">{tCommon('flatten')}</span>
              </div>

              <div class="annotations-menu-separator"></div>

              {/* Expand / Collapse All */}
              <div class="annotations-menu-item" onClick={() => closeAndRun(expandAll)}>
                <span class="annotations-menu-icon" innerHTML={expandAllIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.expandAll')}</span>
              </div>
              <div class="annotations-menu-item" onClick={() => closeAndRun(collapseAll)}>
                <span class="annotations-menu-icon" innerHTML={collapseAllIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.collapseAll')}</span>
              </div>

              <div class="annotations-menu-separator"></div>

              {/* Summarize: the listed markups as CSV, PDF or XML (the external editor) */}
              <div class={`annotations-menu-item annotations-menu-submenu-trigger${!getActiveDocument()?.annotations?.length || exporting() ? ' disabled' : ''}`}>
                <span class="annotations-menu-icon" innerHTML={summarizeIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.summarize')}</span>
                <svg class="annotations-menu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 6 15 12 9 18"/>
                </svg>
                <div class="annotations-submenu">
                  <For each={['csv', 'pdf', 'xml']}>{format => (
                    <div class={`annotations-menu-item${!getActiveDocument()?.annotations?.length || exporting() ? ' disabled' : ''}`}
                      role="button" tabIndex="0"
                      onClick={() => getActiveDocument()?.annotations?.length && !exporting() && closeAndRun(() => void exportSummary(format))}
                      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && getActiveDocument()?.annotations?.length && !exporting()) { event.preventDefault(); closeAndRun(() => void exportSummary(format)); } }}>
                      <span class="annotations-menu-check"></span>
                      <span class="annotations-menu-label">{t(`markupsList.summary${format.toUpperCase()}`)}</span>
                    </div>
                  )}</For>
                  <div class="annotations-menu-separator"></div>
                  <div class={`annotations-menu-item${summarySelectedOnly() ? ' checked' : ''}`}
                    role="menuitemcheckbox" aria-checked={summarySelectedOnly()}
                    onClick={() => setSummarySelectedOnly(!summarySelectedOnly())}>
                    <span class="annotations-menu-check">{summarySelectedOnly() ? '\u2713' : ''}</span>
                    <span class="annotations-menu-label">{t('markupsList.summarySelectedOnly')}</span>
                  </div>
                  <div class={`annotations-menu-item${latestStatusOnly() ? ' checked' : ''}`}
                    role="menuitemcheckbox" aria-checked={latestStatusOnly()}
                    onClick={() => setLatestStatusOnly(!latestStatusOnly())}>
                    <span class="annotations-menu-check">{latestStatusOnly() ? '\u2713' : ''}</span>
                    <span class="annotations-menu-label">{t('markupsList.summaryLatestStatus')}</span>
                  </div>
                </div>
              </div>
              <div class="annotations-menu-item disabled">
                <span class="annotations-menu-icon" innerHTML={importIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.importComments')}</span>
              </div>
              <div class="annotations-menu-separator"></div>

              {/* Group By — submenu */}
              <div class="annotations-menu-item annotations-menu-submenu-trigger">
                <span class="annotations-menu-icon" innerHTML={groupByIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.groupBy')}</span>
                <svg class="annotations-menu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 6 15 12 9 18"/>
                </svg>
                <div class="annotations-submenu">
                  {groupOptions.map(opt => (
                    <div
                      class={`annotations-menu-item${sortMode() === opt.key ? ' checked' : ''}`}
                      onClick={() => applySort(opt.key)}
                    >
                      <span class="annotations-menu-check">{sortMode() === opt.key ? '\u2713' : ''}</span>
                      <span class="annotations-menu-label">{opt.common ? tCommon(opt.common) : t(`leftPanel.${opt.label}`)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Show (filter) — submenu */}
              <div class="annotations-menu-item annotations-menu-submenu-trigger">
                <span class="annotations-menu-icon" innerHTML={showIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.show')}</span>
                <svg class="annotations-menu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 6 15 12 9 18"/>
                </svg>
                <div class="annotations-submenu">
                  <div
                    class={`annotations-menu-item${filterMode() === 'all' ? ' checked' : ''}`}
                    onClick={() => applyFilter('all')}
                  >
                    <span class="annotations-menu-check">{filterMode() === 'all' ? '\u2713' : ''}</span>
                    <span class="annotations-menu-label">{t('leftPanel.allPages')}</span>
                  </div>
                  <div
                    class={`annotations-menu-item${filterMode() === 'current' ? ' checked' : ''}`}
                    onClick={() => applyFilter('current')}
                  >
                    <span class="annotations-menu-check">{filterMode() === 'current' ? '\u2713' : ''}</span>
                    <span class="annotations-menu-label">{t('leftPanel.currentPage')}</span>
                  </div>

                  {/* Filter op review-status (#236) \u2014 vinkje = zichtbaar */}
                  <div class="annotations-menu-separator"></div>
                  <div class="annotations-menu-section">{tContext('annotation.status')}</div>
                  <For each={statusMenuOptions()}>{opt => (
                    <div
                      class={`annotations-menu-item${!hiddenStatuses().has(opt.key) ? ' checked' : ''}`}
                      onClick={() => toggleStatusFilter(opt.key)}
                    >
                      <span class="annotations-menu-check">{!hiddenStatuses().has(opt.key) ? '\u2713' : ''}</span>
                      <span class="annotations-menu-label">{opt.label}</span>
                    </div>
                  )}</For>
                </div>
              </div>

              <div class="annotations-menu-separator"></div>

              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(() => startReply(getActiveDocument()?.selectedAnnotation?.id))}
              >
                <span class="annotations-menu-icon" innerHTML={replyIcon}></span>
                <span class="annotations-menu-label">{t('markupsList.reply')}</span>
              </div>

              {/* Deselect */}
              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(deselectAll)}
              >
                <span class="annotations-menu-icon" innerHTML={deselectIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.deselect')}</span>
              </div>

              <div class="annotations-menu-separator"></div>

              {/* Properties */}
              <div
                class={`annotations-menu-item${!hasSelection() ? ' disabled' : ''}`}
                onClick={() => hasSelection() && closeAndRun(showProperties)}
              >
                <span class="annotations-menu-icon" innerHTML={propertiesIcon}></span>
                <span class="annotations-menu-label">{t('leftPanel.properties')}</span>
              </div>
            </div>
          </Show>
        </div>
        <div class="annotations-columns-wrapper" ref={columnsRef}>
          <button type="button" class={`annotations-toolbar-btn annotations-columns-btn${columnsOpen() ? ' active' : ''}`}
            aria-expanded={columnsOpen()} aria-controls="annotations-columns-menu"
            title={t('markupsList.columns')} aria-label={t('markupsList.columns')}
            onClick={() => setColumnsOpen(!columnsOpen())} innerHTML={lucide('columns-3')}></button>
          <Show when={columnsOpen()}>
            <div id="annotations-columns-menu" class="annotations-columns-menu" role="group"
              style={columnsMenuRoom()}
              aria-label="Visible Markups List columns"
              onKeyDown={(event) => { if (event.key === 'Escape') { setColumnsOpen(false); event.currentTarget.previousElementSibling?.focus(); } }}>
              <For each={columnOptions()}>{(column) => (
                <div class="annotations-columns-option">
                  <label>
                    <input type="checkbox" checked={visibleColumns().includes(column)}
                      disabled={column === ANCHOR_COLUMN} onChange={() => toggleColumn(column)} />
                    <span>{columnLabel(column)}</span>
                  </label>
                  <button type="button" aria-label={`Move ${columnLabel(column)} left`}
                    disabled={!visibleColumns().includes(column) || visibleColumns().indexOf(column) === 0}
                    onClick={() => moveColumn(column, -1)}>←</button>
                  <button type="button" aria-label={`Move ${columnLabel(column)} right`}
                    disabled={!visibleColumns().includes(column) || visibleColumns().indexOf(column) === visibleColumns().length - 1}
                    onClick={() => moveColumn(column, 1)}>→</button>
                </div>
              )}</For>
              <form class="annotations-custom-column-form" onSubmit={saveCustomName}>
                <label for="annotations-custom-column-name">Text column name</label>
                <div class="annotations-custom-column-form-row">
                  <input id="annotations-custom-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                    value={customNameInput()} onInput={event => setCustomNameInput(event.currentTarget.value)} />
                  <button type="submit">{customName() ? 'Rename' : 'Add'}</button>
                </div>
                <Show when={customNameError()}><span role="alert">{customNameError()}</span></Show>
              </form>
              <form class="annotations-custom-column-form" onSubmit={saveSecondTextName}>
                <label for="annotations-second-text-column-name">Second Text column name</label>
                <div class="annotations-custom-column-form-row">
                  <input id="annotations-second-text-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                    value={secondTextNameInput()} onInput={event => setSecondTextNameInput(event.currentTarget.value)} />
                  <button type="submit">{secondTextName() ? 'Rename' : 'Add'}</button>
                </div>
                <Show when={secondTextNameError()}><span role="alert">{secondTextNameError()}</span></Show>
              </form>
              <form class="annotations-custom-column-form" onSubmit={saveChoiceDefinition}>
                <label for="annotations-choice-column-name">Choice column name</label>
                <input id="annotations-choice-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                  value={choiceNameInput()} onInput={event => setChoiceNameInput(event.currentTarget.value)} />
                <label for="annotations-choice-options">Options · one per line</label>
                <textarea id="annotations-choice-options" rows="3" maxLength="1024"
                  value={choiceOptionsInput()} onInput={event => setChoiceOptionsInput(event.currentTarget.value)} />
                <label for="annotations-choice-numeric-values">Optional numeric values · one line per option, blank for none</label>
                <textarea id="annotations-choice-numeric-values" rows="3" maxLength="512"
                  value={choiceNumericInput()} onInput={event => setChoiceNumericInput(event.currentTarget.value)} />
                <div class="annotations-custom-column-form-row">
                  <span class="annotations-columns-hint">Existing options stay in order; append new ones.</span>
                  <button type="submit">{choiceDefinition() ? 'Save choices' : 'Add choice'}</button>
                </div>
                <Show when={choiceError()}><span role="alert">{choiceError()}</span></Show>
              </form>
              <form class="annotations-custom-column-form" onSubmit={saveSecondChoiceDefinition}>
                <label for="annotations-second-choice-column-name">Second Choice column name</label>
                <input id="annotations-second-choice-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                  value={secondChoiceNameInput()} onInput={event => setSecondChoiceNameInput(event.currentTarget.value)} />
                <label for="annotations-second-choice-options">Second Choice options · one per line</label>
                <textarea id="annotations-second-choice-options" rows="3" maxLength="1024"
                  value={secondChoiceOptionsInput()} onInput={event => setSecondChoiceOptionsInput(event.currentTarget.value)} />
                <label for="annotations-second-choice-numeric-values">Second Choice numeric values · one line per option, blank for none</label>
                <textarea id="annotations-second-choice-numeric-values" rows="3" maxLength="512"
                  value={secondChoiceNumericInput()} onInput={event => setSecondChoiceNumericInput(event.currentTarget.value)} />
                <div class="annotations-custom-column-form-row">
                  <span class="annotations-columns-hint">Existing options stay in order. Formula uses the first Choice column.</span>
                  <button type="submit">{secondChoiceDefinition() ? 'Save choices' : 'Add choice'}</button>
                </div>
                <Show when={secondChoiceError()}><span role="alert">{secondChoiceError()}</span></Show>
              </form>
              <form class="annotations-custom-column-form" onSubmit={saveNumberDefinition}>
                <label for="annotations-number-column-name">Number column name</label>
                <div class="annotations-custom-column-form-row">
                  <input id="annotations-number-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                    value={numberNameInput()} onInput={event => setNumberNameInput(event.currentTarget.value)} />
                  <button type="submit">{numberDefinition() ? 'Rename' : 'Add'}</button>
                </div>
                <Show when={numberNameError()}><span role="alert">{numberNameError()}</span></Show>
              </form>
              <form class="annotations-custom-column-form" onSubmit={saveSecondNumberDefinition}>
                <label for="annotations-second-number-column-name">Second Number column name</label>
                <div class="annotations-custom-column-form-row">
                  <input id="annotations-second-number-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                    value={secondNumberNameInput()} onInput={event => setSecondNumberNameInput(event.currentTarget.value)} />
                  <button type="submit">{secondNumberDefinition() ? 'Rename' : 'Add'}</button>
                </div>
                <Show when={secondNumberNameError()}><span role="alert">{secondNumberNameError()}</span></Show>
              </form>
              <form class="annotations-custom-column-form" onSubmit={saveCheckmarkDefinition}>
                <label for="annotations-checkmark-column-name">Checkmark column name</label>
                <div class="annotations-custom-column-form-row">
                  <input id="annotations-checkmark-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                    value={checkmarkNameInput()} onInput={event => setCheckmarkNameInput(event.currentTarget.value)} />
                  <button type="submit">{checkmarkDefinition() ? 'Rename' : 'Add'}</button>
                </div>
                <Show when={checkmarkNameError()}><span role="alert">{checkmarkNameError()}</span></Show>
              </form>
              <Show when={numberDefinition() || secondNumberDefinition()
                || choiceDefinition()?.version === CHOICE_NUMERIC_SCHEMA_VERSION}>
                <form class="annotations-custom-column-form" onSubmit={saveFormulaDefinition}>
                  <label for="annotations-formula-column-name">Formula column name</label>
                  <input id="annotations-formula-column-name" type="text" maxLength={CUSTOM_TEXT_NAME_MAX}
                    value={formulaNameInput()} onInput={event => setFormulaNameInput(event.currentTarget.value)} />
                  <label for="annotations-formula-source">Formula source</label>
                  <select id="annotations-formula-source" value={formulaSourceInput()}
                    onChange={event => setFormulaSourceInput(event.currentTarget.value)}>
                    <Show when={numberDefinition()}><option value="customNumber">{numberDefinition()?.name} (Number)</option></Show>
                    <Show when={secondNumberDefinition()}><option value="customNumber2">{secondNumberDefinition()?.name} (Number)</option></Show>
                    <Show when={choiceDefinition()?.version === CHOICE_NUMERIC_SCHEMA_VERSION}>
                      <option value="customChoice">{choiceDefinition()?.name} (Choice numeric value)</option>
                    </Show>
                  </select>
                  <div class="annotations-columns-hint">{formulaSourceInput() === 'customChoice'
                    ? choiceDefinition()?.name : formulaSourceInput() === 'customNumber2'
                      ? secondNumberDefinition()?.name : numberDefinition()?.name} × multiplier + offset</div>
                  <label for="annotations-formula-multiplier">Multiplier</label>
                  <input id="annotations-formula-multiplier" type="text" inputMode="decimal" maxLength={NUMBER_TEXT_MAX}
                    value={formulaMultiplierInput()} onInput={event => setFormulaMultiplierInput(event.currentTarget.value)} />
                  <label for="annotations-formula-offset">Offset</label>
                  <input id="annotations-formula-offset" type="text" inputMode="decimal" maxLength={NUMBER_TEXT_MAX}
                    value={formulaOffsetInput()} onInput={event => setFormulaOffsetInput(event.currentTarget.value)} />
                  <button type="submit">{formulaDefinition() ? 'Save formula' : 'Add formula'}</button>
                  <Show when={formulaError()}><span role="alert">{formulaError()}</span></Show>
                </form>
              </Show>
              <form class="annotations-custom-column-form" onSubmit={saveStatusSet}>
                <label for="annotations-status-set-name">{t('markupsList.statusSetName')}</label>
                <input id="annotations-status-set-name" type="text" maxLength={STATUS_SET_NAME_MAX}
                  placeholder={DEFAULT_STATUS_SET.name}
                  value={statusSetNameInput()} onInput={event => setStatusSetNameInput(event.currentTarget.value)} />
                <label for="annotations-status-set-lines">{t('markupsList.statusSetLines')}</label>
                <textarea id="annotations-status-set-lines" rows="4" maxLength="1024"
                  value={statusSetLinesInput()} onInput={event => setStatusSetLinesInput(event.currentTarget.value)} />
                <div class="annotations-custom-column-form-row">
                  <button type="button" disabled={!statusSetDefinition()} onClick={resetStatusSet}>{t('markupsList.statusSetReset')}</button>
                  <button type="submit">{t('markupsList.statusSetSave')}</button>
                </div>
                <Show when={statusSetError()}><span role="alert">{statusSetError()}</span></Show>
              </form>
              <div class="annotations-columns-hint">Subject stays visible. Use the arrows to change column order.</div>
            </div>
          </Show>
        </div>
        <div class="annotations-filters-wrapper" ref={filtersRef}>
          <button type="button" class="annotations-toolbar-btn annotations-filters-btn"
            aria-expanded={filtersOpen()} aria-controls="annotations-filters-menu"
            title={t('markupsList.savedFilters')} aria-label={t('markupsList.savedFilters')}
            onClick={() => { setFiltersOpen(!filtersOpen()); setFilterMessage(''); }} innerHTML={chevronDownIcon}></button>
          <Show when={filtersOpen()}>
            <div id="annotations-filters-menu" class="annotations-filters-menu" role="group"
              aria-label="Saved Markups List filters"
              onKeyDown={(event) => { if (event.key === 'Escape') { setFiltersOpen(false); event.currentTarget.previousElementSibling?.focus(); } }}>
              <form class="annotations-filter-save" onSubmit={(event) => { event.preventDefault(); saveCurrentFilter(); }}>
                <label for="annotations-filter-name">Save current filter</label>
                <div class="annotations-filter-save-row">
                  <input id="annotations-filter-name" type="text" maxLength="64" value={filterName()}
                    onInput={(event) => { setFilterName(event.currentTarget.value); setFilterMessage(''); }}
                    placeholder="Filter name" />
                  <button type="submit">Save</button>
                </div>
              </form>
              <Show when={savedFilters().length} fallback={<div class="annotations-columns-hint">No saved filters yet.</div>}>
                <div class="annotations-filter-list" aria-label="Saved filters">
                  <For each={savedFilters()}>{(filter) => (
                    <div class="annotations-filter-entry">
                      <button type="button" class="annotations-filter-apply" title={`Apply ${filter.name}`}
                        onClick={() => applySavedFilter(filter)}>{filter.name}</button>
                      <button type="button" class="annotations-filter-delete" aria-label={`Delete ${filter.name}`}
                        title={`Delete ${filter.name}`} onClick={() => deleteSavedFilter(filter.name)}>×</button>
                    </div>
                  )}</For>
                </div>
              </Show>
              <Show when={filterMessage()}><div role="status" class="annotations-filter-message">{filterMessage()}</div></Show>
            </div>
          </Show>
        </div>
        <FormulaCaptionsButton onColumnsApplied={(keys) => {
          const missing = keys.filter(key => !visibleColumns().includes(key));
          if (missing.length) persistColumns([...visibleColumns(), ...missing]);
        }} />
        <Show when={columnSort()}>
          <span class="annotations-sort-summary" role="status">{sortSummary()}</span>
        </Show>
        <Show when={activeColumnFilters(columnFilters()).length}>
          <button type="button" class="annotations-column-filters-chip"
            title={t('markupsList.filterClearAll')}
            onClick={() => applyColumnFilters({})}>
            {t('markupsList.filterActiveCount', { count: activeColumnFilters(columnFilters()).length })} ×</button>
        </Show>
        <div class="annotations-toolbar-spacer"></div>
      </div>
      </PanelHeader>
      <div class="annotations-custom-values">
      <Show when={customName() && selectedCustomMarkup()}>
        <form class="annotations-custom-value-form" onSubmit={saveCustomValue}>
          <label for="annotations-custom-value">{customName()} · selected markup</label>
          <input id="annotations-custom-value" type="text" maxLength={CUSTOM_TEXT_VALUE_MAX}
            value={customValueInput()} onInput={event => setCustomValueInput(event.currentTarget.value)}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly} />
          <button type="submit">Apply</button>
        </form>
      </Show>
      <Show when={secondTextName() && selectedCustomMarkup()}>
        <form class="annotations-custom-value-form" onSubmit={saveSecondTextValue}>
          <label for="annotations-second-text-value">{secondTextName()} · selected markup</label>
          <input id="annotations-second-text-value" type="text" maxLength={CUSTOM_TEXT_VALUE_MAX}
            value={secondTextValueInput()} onInput={event => setSecondTextValueInput(event.currentTarget.value)}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly} />
          <button type="submit">Apply</button>
        </form>
      </Show>
      <Show when={choiceDefinition() && selectedCustomMarkup()}>
        <div class="annotations-custom-value-form">
          <label for="annotations-choice-value">{choiceDefinition().name} · selected markup</label>
          <select id="annotations-choice-value"
            value={choiceValue(selectedCustomMarkup()?.customChoiceValue, choiceDefinition().options)}
            onChange={saveChoiceValue}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly}>
            <option value="">No choice</option>
            <For each={choiceDefinition().options}>{option => <option value={option}>{option}</option>}</For>
          </select>
        </div>
      </Show>
      <Show when={secondChoiceDefinition() && selectedCustomMarkup()}>
        <div class="annotations-custom-value-form">
          <label for="annotations-second-choice-value">{secondChoiceDefinition().name} · selected markup</label>
          <select id="annotations-second-choice-value"
            value={choiceValue(selectedCustomMarkup()?.customChoiceValue2, secondChoiceDefinition().options)}
            onChange={saveSecondChoiceValue}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly}>
            <option value="">No choice</option>
            <For each={secondChoiceDefinition().options}>{option => <option value={option}>{option}</option>}</For>
          </select>
        </div>
      </Show>
      <Show when={numberDefinition() && selectedCustomMarkup()}>
        <form class="annotations-custom-value-form" onSubmit={saveNumberValue}>
          <label for="annotations-number-value">{numberDefinition().name} · selected markup</label>
          <input id="annotations-number-value" type="text" inputMode="decimal" maxLength={NUMBER_TEXT_MAX}
            value={numberValueInput()} onInput={event => setNumberValueInput(event.currentTarget.value)}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly} />
          <button type="submit">Apply</button>
          <Show when={numberValueError()}><span role="alert">{numberValueError()}</span></Show>
        </form>
      </Show>
      <Show when={secondNumberDefinition() && selectedCustomMarkup()}>
        <form class="annotations-custom-value-form" onSubmit={saveSecondNumberValue}>
          <label for="annotations-second-number-value">{secondNumberDefinition().name} · selected markup</label>
          <input id="annotations-second-number-value" type="text" inputMode="decimal" maxLength={NUMBER_TEXT_MAX}
            value={secondNumberValueInput()} onInput={event => setSecondNumberValueInput(event.currentTarget.value)}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly} />
          <button type="submit">Apply</button>
          <Show when={secondNumberValueError()}><span role="alert">{secondNumberValueError()}</span></Show>
        </form>
      </Show>
      <Show when={checkmarkDefinition() && selectedCustomMarkup()}>
        <div class="annotations-custom-value-form">
          <label for="annotations-checkmark-value">{checkmarkDefinition().name} · selected markup</label>
          <select id="annotations-checkmark-value"
            value={checkmarkValue(selectedCustomAnnotation()?.markupCheckmarkValue) || ''}
            onChange={saveCheckmarkValue}
            disabled={!!selectedCustomAnnotation()?.locked || !!selectedCustomAnnotation()?.readOnly}>
            <option value="">No decision</option>
            <option value="unchecked">Unchecked</option>
            <option value="checked">Checked</option>
          </select>
        </div>
      </Show>
      </div>
      <Show when={filterPopover()}>
        <div class="annotation-filter-popover" ref={filterPopoverRef} role="dialog"
          aria-label={t('markupsList.filterColumn', { column: columnLabel(filterPopover().column) })}
          style={{ top: `${filterPopover().top}px`, left: `${filterPopover().left}px` }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setFilterPopover(null); } }}>
          <div class="annotation-filter-popover-title">{columnLabel(filterPopover().column)}</div>
          <label class="annotation-filter-option annotation-filter-all">
            <input type="checkbox" checked={!hiddenInColumn(filterPopover().column).size}
              onChange={(event) => applyColumnFilters(setColumnFilterValues(columnFilters(), filterPopover().column,
                event.currentTarget.checked ? [] : filterPopover().values.map(entry => entry.value)))} />
            <span>{t('markupsList.filterSelectAll')}</span>
          </label>
          <div class="annotation-filter-values">
            <For each={filterPopover().values}>{(entry) => (
              <label class="annotation-filter-option">
                <input type="checkbox" checked={!hiddenInColumn(filterPopover().column).has(entry.value)}
                  onChange={() => applyColumnFilters(toggleColumnFilterValue(columnFilters(), filterPopover().column, entry.value))} />
                <span class="annotation-filter-value">{entry.value === '' ? t('markupsList.filterBlank') : entry.value}</span>
                <span class="annotation-filter-count">{entry.count}</span>
              </label>
            )}</For>
          </div>
          <div class="annotation-filter-actions">
            <button type="button" disabled={!hiddenInColumn(filterPopover().column).size}
              onClick={() => applyColumnFilters(setColumnFilterValues(columnFilters(), filterPopover().column, []))}>
              {t('markupsList.filterClear')}</button>
            <button type="button" onClick={() => setFilterPopover(null)}>{tCommon('close')}</button>
          </div>
        </div>
      </Show>
      <div class="annotations-list-content" ref={listElement}
        onScroll={event => setListScrollTop(event.currentTarget.scrollTop)}
        style={{ '--markup-grid-columns': columnGrid() }}>
        <Show when={emptyMessage()}>
          <div class="annotations-list-empty">{emptyMessage()}</div>
        </Show>
        <Show when={!emptyMessage()}>
          <div class="annotation-list-header" ref={listHeaderElement}>
            <div class="annotation-cell annotation-cell-gutter">
              <button type="button" class="annotation-groups-toggle"
                title={anyGroupOpen() ? t('markupsList.collapseGroups') : t('markupsList.expandGroups')}
                aria-label={anyGroupOpen() ? t('markupsList.collapseGroups') : t('markupsList.expandGroups')}
                onClick={() => (anyGroupOpen() ? collapseAll() : expandAll())}
                innerHTML={anyGroupOpen() ? lucide('square-minus') : lucide('square-plus')}></button>
            </div>
            <For each={displayColumns()}>{(column) => columnHeader(column, columnLabel(column))}</For>
          </div>
          <div class="annotations-virtual-spacer" style={{ height: `${rowWindow().top}px` }} aria-hidden="true" />
          <For each={visibleRows().slice(rowWindow().start, rowWindow().end)}>
            {(item, offset) => {
              let rowElement;
              onCleanup(() => { if (rowElement) rowSizeObserver?.unobserve(rowElement); });
              return <div class="annotations-virtual-row"
                ref={element => { rowElement = element; rowSizeObserver?.observe(element); }}
                data-virtual-key={virtualRowKey(item, rowWindow().start + offset())}>
              <Show when={item.isHeader} fallback={
                  <Show when={!item.isReply && !item.isReplyInput && !item.isMarkupGroup} fallback={
                    item.isMarkupGroup ? groupRow(item) : item.isReply ? replyRow(item) : <ReplyInput item={item} />
                  }>
                  <div
                    class={`annotation-list-item${item.selected ? ' selected' : ''}${item.hidden || item.layerHidden ? ' markup-hidden' : ''}`}
                    title={item.meta}
                    role="button" tabIndex="0" aria-pressed={item.selected}
                    data-annotation-id={item.id}
                    draggable={!item.locked}
                    on:dragstart={(event) => onRowDragStart(item, event)}
                    aria-label={`${item.typeLabel}, page ${item.page}${item.text ? `, ${item.text}` : ''}`}
                    on:click={(event) => activateMarkup(item, event)}
                    on:keydown={(event) => onMarkupKeyDown(item, event)}
                    on:contextmenu={(event) => onMarkupContextMenu(item, event)}
                  >
                    <div class="annotation-cell annotation-cell-gutter">
                      <Show when={item.accentColor}><i class="annotation-area-stripe" style={{ background: item.accentColor }} title="Group colour" /></Show>
                      {rowEye(item)}
                    </div>
                    <For each={displayColumns()}>{(column) => columnCell(item, column)}</For>
                  </div>
                  </Show>
              }>
                <Show when={item.sortMode === 'color'}>
                  <div
                    class={`annotations-list-page-header annotations-list-color-header${collapsedGroups().has(item.groupKey) ? ' collapsed' : ''}${item.sectionSelected ? ' selected' : ''}`}
                    role="button" tabIndex="0" aria-expanded={!collapsedGroups().has(item.groupKey)}
                    aria-pressed={item.sectionSelected ? 'true' : undefined}
                    aria-label={`Color ${item.headerColor}`}
                    onClick={(event) => onSectionHeaderClick(item, event)}
                    onKeyDown={(event) => onGroupKeyDown(item, event)}
                  >
                    {headerEye(item)}
                    <svg class="annotations-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points={collapsedGroups().has(item.groupKey) ? "9 6 15 12 9 18" : "6 9 12 15 18 9"}/>
                    </svg>
                    <span class="annotations-list-color-swatch" style={{ 'background-color': item.headerColor }}></span>
                    <span class="annotations-group-label">{item.headerColor}</span>
                    <span class="annotations-group-count">({item.count})</span>
                  </div>
                </Show>
                <Show when={item.sortMode !== 'color'}>
                  <div
                    class={`annotations-list-page-header${collapsedGroups().has(item.groupKey) ? ' collapsed' : ''}${item.sectionSelected ? ' selected' : ''}${dropTarget() === `header:${item.groupKey}` ? ' drop-target' : ''}`}
                    role="button" tabIndex="0" aria-expanded={!collapsedGroups().has(item.groupKey)}
                    aria-pressed={item.sectionSelected ? 'true' : undefined}
                    onClick={(event) => onSectionHeaderClick(item, event)}
                    onKeyDown={(event) => onGroupKeyDown(item, event)}
                    {...dropProps(item)}
                  >
                    {headerEye(item)}
                    <svg class="annotations-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points={collapsedGroups().has(item.groupKey) ? "9 6 15 12 9 18" : "6 9 12 15 18 9"}/>
                    </svg>
                    <span class="annotations-group-label">{headerText(item)}</span>
                    <span class="annotations-group-count">({item.count})</span>
                  </div>
                </Show>
              </Show>
              </div>;
            }}
          </For>
          <div class="annotations-virtual-spacer" style={{ height: `${rowWindow().bottom}px` }} aria-hidden="true" />
        </Show>
      </div>
      <CaptureThumbTip />
      <FormulaTotalsBar items={items} />
      <div class="annotations-list-count">
        {countText()}
        <Show when={sheetsPending()}>{(sheets) => (
          <>
            {' · '}{t('markupsList.sheetsRead', { loaded: sheets().loaded, total: sheets().total })}{' '}
            <button type="button" class="annotations-read-all" disabled={readingAll()} onClick={readAllSheets}>
              {readingAll() ? t('markupsList.readingSheets') : t('markupsList.readAllSheets')}
            </button>
          </>
        )}</Show>
      </div>
      <Show when={exportMessage()}><div role="status" class="annotations-list-count">{exportMessage()}</div></Show>
    </div>
  );
}

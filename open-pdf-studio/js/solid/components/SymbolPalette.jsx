import { Show, For, createSignal, createMemo, createEffect } from 'solid-js';
import { state, getActiveDocument } from '../../core/state.js';
import { setTool } from '../../tools/manager.js';
import {
  getToolChestPresets, canSaveToolPreset, saveToolPreset, deleteToolPreset,
  activeToolPreset, getRecentTools, clearRecentTools,
  DEFAULT_TOOL_SET_ID, MAX_TOOL_SETS, getToolChestSets, createToolSet, deleteToolSet, moveToolPreset,
  toggleToolPresetMode, canUpdateToolPreset, updateToolPresetFromAnnotation,
  reorderToolPreset, placeToolPresetAt, setToolPresetSequence, presetToolOf,
  setToolSetReferenceScale, referenceScaleRatio, cleanReferenceScale,
  renameToolSet, renameToolPreset, copyToolPreset, setToolSetMode,
  setToolPresetLayer, setToolSetLayer, cleanToolLayerName, TOOL_LAYER_NAME_LIMIT,
  canEditToolSet, toolSetVisible, setToolPresetDetails, ALWAYS_DRAWING_TOOL_TYPES, MAX_TOOL_CHEST_TOOLS,
} from '../../tools/tool-chest-presets.js';
import {
  startToolSetSharing, toolSetShareStatus, toolSetShareRevision, checkOutToolSet, checkInToolSet,
  cancelToolSetCheckOut, exportToolSetFile,
} from '../stores/toolSetLibrary.js';
import { shareMessage } from './dialogs/tool-set-share-messages.js';
import { activeProfile } from '../stores/workspaceLayout.js';
import {
  cleanSequence, formatSequenceLabel, nextSequenceValue, setNextSequenceValue, SEQUENCE_LIMITS,
} from '../../tools/tool-sequences.js';
import { useToolPreset, useRecentToolPreset, registerSymbolPresetActivator } from '../../tools/tool-chest-use.js';
import { getMeasureScale } from '../../annotations/measurement.js';
import {
  searchQuery, setSearchQuery,
  filteredCategories, allCategories,
  symbolPaletteVisible, setSymbolPaletteVisible,
  symbolPaletteMode, setSymbolPaletteMode,
  symbolFloatPos, setSymbolFloatPos,
  saveSymbolPaletteState,
  settingsOpen, setSettingsOpen,
  selectedIndustry, setSelectedIndustry,
  selectedCountry, setSelectedCountry,
  toggleGroupEnabled, isGroupEnabled,
  addCustomGroup, removeCustomGroup, addSymbolToGroup, getCustomGroups, upsertCustomGroup,
  resolveSymbolSvg,
} from '../stores/symbolStore.js';
import {
  RECENT_SECTION, toolSetSectionId, librarySectionId, filterToolChestSections, toolDescription,
  toolTypeName, myToolsBadge,
} from './tool-chest/tool-chest-view.js';
import {
  sectionOpen, toggleSection, openSection, sectionViewOf, setSectionView, setLiveSections,
  newSetFormOpen, setNewSetFormOpen, chestMessage, showChestMessage, transferBusy,
  exportToolSetToFile,
} from '../stores/toolChestUi.js';
import PanelHeader from './panels/PanelHeader.jsx';
import { openPanelMenu } from './panels/PanelMenu.jsx';
import { toolIcon } from '../data/oculithToolIcons.js';
import { matchesLocale, INDUSTRIES, COUNTRIES } from '../data/symbolLocales.js';
import { registerPaletteDock, unregisterPaletteDock } from '../stores/paletteOrder.js';
import { movePanel, workspaceLayout } from '../stores/workspaceLayout.js';
import { panelShown } from '../stores/leftPanelStore.js';
import { ifcCategoryForSymbol } from '../data/ifcCategoryMap.js';
import { nenIfcForSymbolId } from '../data/nenIfcMap.js';
import { SYMBOL_STAMP_DEFAULT_SIZE } from '../../annotations/stamp-defaults.js';
import { setPendingSymbolId } from '../stores/parametricSymbolStore.js';
import { symboolSchaal, setSymboolSchaal } from '../../symbols/symbol-scale-store.js';
import { SCHAAL_STAPPEN, schaalLabel } from '../../symbols/symbol-scale.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { parseLineworkCatalog, lineworkCatalogToGroup, LINEWORK_TEMPLATE_PREFIX } from '../../symbols/linework-catalog.js';
import { BUILT_IN_CATEGORIES } from '../data/symbolLibrary.js';

// Alleen catalogus-FAMILIES (maat-keuze, geen sprekend pictogram) krijgen de
// brede tegel met naam; gewone parametrische symbolen houden het compacte
// pictogrammenraster. Op `parametricId` alleen gaten maakte van elke
// parametrische groep één lange lijst met grote tegels.
const isCatalogusFamilie = (sym) =>
  typeof sym?.parametricId === 'string' && sym.parametricId.startsWith(LINEWORK_TEMPLATE_PREFIX);
const isFeaturedCategory = (cat) => BUILT_IN_CATEGORIES.some(featured => featured.id === cat.id);
const [showOtherLibraries, setShowOtherLibraries] = createSignal(false);
const featuredFirst = (categories) => [
  ...categories.filter(isFeaturedCategory),
  ...categories.filter(cat => !isFeaturedCategory(cat)),
];
import { registerLineworkCatalog } from '../../symbols/linework-catalog-store.js';
import { openDialog } from '../stores/dialogStore.js';
import { updateStatusMessage } from '../../ui/chrome/status-bar.js';
import { lucide } from '../data/lucideIcons.js';
import SymbolCountPresetForm, { CountSymbolPreview } from './tool-chest/SymbolCountPresetForm.jsx';
import { countPresetSource } from '../stores/countStore.js';

const sizedIcon = (svg, size) => svg.replace('<svg ', `<svg width="${size}" height="${size}" `);

const DOCK_SNAP = 60;

// --- Shared drag logic ---
function startDrag(e, fromDocked) {
  if (e.button !== 0) return;
  e.preventDefault();
  const mainViewEl = document.querySelector('.main-view');
  if (!mainViewEl) return;
  let hasMoved = false;
  const startCX = e.clientX;
  const startCY = e.clientY;
  const offsetX = fromDocked ? 17 : (e.clientX - symbolFloatPos().x);
  const offsetY = fromDocked ? 12 : (e.clientY - symbolFloatPos().y);

  function getSnapSide(cx) {
    const rect = mainViewEl.getBoundingClientRect();
    if (cx - rect.left < DOCK_SNAP) return 'left';
    if (rect.right - cx < DOCK_SNAP) return 'right';
    return null;
  }

  function onMove(ev) {
    if (!hasMoved) {
      if (Math.abs(ev.clientX - startCX) < 4 && Math.abs(ev.clientY - startCY) < 4) return;
      hasMoved = true;
      if (fromDocked) {
        setSymbolPaletteMode('float');
        unregisterPaletteDock('symbols');
      }
    }
    const el = document.querySelector('.sp-float');
    const pw = el ? el.offsetWidth : 240;
    const ph = el ? el.offsetHeight : 300;
    const nx = Math.max(0, Math.min(ev.clientX - offsetX, window.innerWidth - pw));
    const ny = Math.max(0, Math.min(ev.clientY - offsetY, window.innerHeight - ph));
    setSymbolFloatPos({ x: nx, y: ny });
  }

  function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!hasMoved) return;
    const snap = getSnapSide(ev.clientX);
    if (snap) {
      // Dropped on a window side: back into the Tool Chest panel, in that host.
      setSymbolPaletteMode(`docked-${snap}`);
      registerPaletteDock('symbols', snap);
      movePanel('toolChest', snap);
    } else {
      unregisterPaletteDock('symbols');
    }
    saveSymbolPaletteState();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Select symbol → activate stamp tool with SVG override ---
function selectSymbol(symbol) {
  // Parametric entries (NL Tekenwerk: stramien, peilmaat, …) place an
  // editable parametricSymbol annotation instead of a static stamp — the
  // click on the page goes through the parametricSymbol tool and the params
  // stay editable in the properties panel.
  if (symbol.parametricId) {
    setPendingSymbolId(symbol.parametricId);
    setTool('parametricSymbol');
    return;
  }
  // Generic tool entries: palette items that simply activate a drawing tool
  // (e.g. 'mask' — maskeervlak). Keeps future tool-items one-liners.
  if (symbol.tool) {
    setTool(symbol.tool);
    return;
  }
  // Wall entries (NL Wanden / IfcWall): activate the wall tool with the
  // material hatch + default thickness; draw start→end like a line.
  if (symbol.wall) {
    state.toolOverrides = {
      wallPattern: symbol.wall.pattern,
      wallDikteMm: symbol.wall.dikteMm || 100,
      ifcCategory: ifcCategoryForSymbol(symbol),
    };
    setTool('wall');
    return;
  }
  // Resolve any user-edited geometry for this type. effectiveSvg is what gets
  // rasterized/placed; stampBaseSvg keeps the original source so a later
  // "Edit Type" on the placed stamp maps back to the same override key.
  const effectiveSvg = resolveSymbolSvg(symbol.svg);
  // Set overrides BEFORE setTool — manager.js preserves them for stamp tool
  state.toolOverrides = {
    stampSvg: effectiveSvg,
    stampBaseSvg: symbol.svg,
    stampName: symbol.name,
    // Alleen de hoogte vastzetten: de breedte volgt uit de beeldverhouding van
    // de SVG (placeOverrideStamp), zodat een niet-vierkant symbool niet in een
    // vierkant wordt geduwd. Voor de vierkante meegeleverde symbolen blijft de
    // uitkomst 400 x 400.
    stampHeight: symbol.stampHeight || SYMBOL_STAMP_DEFAULT_SIZE,
    lockAspectRatio: true,
    ifcCategory: symbol.ifcCategory || ifcCategoryForSymbol(symbol),
    // Symbool-id + IFC PredefinedType meegeven zodat de geplaatste stempel
    // (en de saver/loader-roundtrip) de herkomst kent — zie nenIfcMap.js.
    symbolId: symbol.id,
    ifcPredefinedType: nenIfcForSymbolId(symbol.id)?.ifcPredefinedType,
  };
  // Pre-cache rasterized preview image for cursor preview
  const blob = new Blob([effectiveSvg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const pngImg = new Image();
    pngImg.onload = () => {
      if (state.toolOverrides) state.toolOverrides._previewImg = pngImg;
    };
    pngImg.src = canvas.toDataURL('image/png');
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
  setTool('stamp');
}

// Tool Chest symbol tools store only the palette symbol id; picking one
// selects that symbol again (the palette may have changed since).
registerSymbolPresetActivator((symbolId) => {
  for (const category of allCategories()) {
    const symbol = (category.symbols || []).find(item => item.id === symbolId);
    if (symbol && typeof symbol.svg === 'string' && !symbol.parametricId && !symbol.tool && !symbol.wall) {
      selectSymbol(symbol);
      return true;
    }
  }
  updateStatusMessage(`Symbol ${symbolId} is not in the symbol palette`);
  return false;
});

// Colorize SVG: replace #000 and #d00 strokes/fills with category color
function colorizeSvg(svg, color) {
  if (!color) return svg;
  return svg.replace(/stroke="#000"/g, `stroke="${color}"`)
            .replace(/fill="#000"/g, `fill="${color}"`)
            .replace(/stroke="#d00"/g, `stroke="${color}"`)
            .replace(/fill="#d00"/g, `fill="${color}"`);
}

const searchSvg = sizedIcon(lucide('search'), 14);

const settingsSvg = lucide('settings');

const closeSvg = sizedIcon(lucide('x'), 12);

const chevronRightSvg = sizedIcon(lucide('chevron-right'), 14);
const chevronDownSvg = sizedIcon(lucide('chevron-down'), 14);

// Sequence settings of one saved tool (the external editor Sequences): the label pattern is
// stored with the tool; the next value belongs to the active document.
function SequenceEditor(props) {
  const { t } = useTranslation('ribbon');
  const initial = props.preset.sequence || { prefix: '', suffix: '', start: 1, step: 1, digits: 2 };
  const [prefix, setPrefix] = createSignal(initial.prefix);
  const [suffix, setSuffix] = createSignal(initial.suffix);
  const [start, setStart] = createSignal(String(initial.start));
  const [step, setStep] = createSignal(String(initial.step));
  const [digits, setDigits] = createSignal(String(initial.digits));
  const [nextText, setNextText] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const draft = () => cleanSequence({ prefix: prefix(), suffix: suffix(),
    start: Number(start()), step: Number(step()), digits: Number(digits()) });
  const doc = () => getActiveDocument();
  // The stored sequence decides the document counter; a changed draft is
  // previewed from its own start until it is saved.
  const nextValue = () => {
    const current = props.preset.sequence;
    const sequence = draft();
    if (!sequence) return null;
    return doc() ? nextSequenceValue(doc(), current && JSON.stringify(current) === JSON.stringify(sequence) ? current : sequence) : sequence.start;
  };
  const save = () => {
    const sequence = draft();
    if (!sequence) { setError(t('toolChest.sequenceInvalid')); return; }
    setToolPresetSequence(props.preset.id, sequence);
    setError('');
    setMessage(t('toolChest.sequenceSaved'));
  };
  const setNext = (value) => {
    const sequence = props.preset.sequence;
    if (!sequence || !doc()) return;
    if (!Number.isInteger(value) || value < 0 || value > SEQUENCE_LIMITS.maxValue ||
        !setNextSequenceValue(doc(), sequence, value)) {
      setError(t('toolChest.sequenceNextInvalid'));
      return;
    }
    setError('');
    setNextText('');
    setMessage(t('toolChest.sequenceNextSet', { label: formatSequenceLabel(sequence, value) }));
  };
  return (
    <form class="sp-sequence-editor" aria-label={t('toolChest.sequenceFor', { name: props.preset.name })}
      onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label>{t('toolChest.sequencePrefix')}<input value={prefix()} maxLength={SEQUENCE_LIMITS.affix}
        onInput={(e) => { setPrefix(e.currentTarget.value); setMessage(''); }} /></label>
      <label>{t('toolChest.sequenceStart')}<input type="number" min="0" max={SEQUENCE_LIMITS.maxValue} value={start()}
        onInput={(e) => { setStart(e.currentTarget.value); setMessage(''); }} /></label>
      <label>{t('toolChest.sequenceStep')}<input type="number" min="1" max={SEQUENCE_LIMITS.maxStep} value={step()}
        onInput={(e) => { setStep(e.currentTarget.value); setMessage(''); }} /></label>
      <label>{t('toolChest.sequenceDigits')}<input type="number" min="1" max={SEQUENCE_LIMITS.maxDigits} value={digits()}
        onInput={(e) => { setDigits(e.currentTarget.value); setMessage(''); }} /></label>
      <label>{t('toolChest.sequenceSuffix')}<input value={suffix()} maxLength={SEQUENCE_LIMITS.affix}
        onInput={(e) => { setSuffix(e.currentTarget.value); setMessage(''); }} /></label>
      <p class="sp-sequence-preview" role="status">
        {draft() ? t(doc() ? 'toolChest.sequenceNextInDocument' : 'toolChest.sequenceNextNoDocument',
          { label: formatSequenceLabel(draft(), nextValue()) }) : t('toolChest.sequenceInvalid')}
      </p>
      <div class="sp-sequence-actions">
        <button type="submit" disabled={!draft()}>{t('toolChest.sequenceSave')}</button>
        <Show when={props.preset.sequence}>
          <button type="button" onClick={() => { setToolPresetSequence(props.preset.id, null); props.onClose(); }}>
            {t('toolChest.sequenceRemove')}</button>
        </Show>
        <button type="button" onClick={() => props.onClose()}>{t('toolChest.sequenceClose')}</button>
      </div>
      <Show when={props.preset.sequence && doc()}>
        <div class="sp-sequence-actions">
          <input type="number" min="0" max={SEQUENCE_LIMITS.maxValue} aria-label={t('toolChest.sequenceNextValue')}
            placeholder={t('toolChest.sequenceNextValue')} value={nextText()}
            onInput={(e) => setNextText(e.currentTarget.value)} />
          <button type="button" disabled={nextText().trim() === ''}
            onClick={() => setNext(Number(nextText()))}>{t('toolChest.sequenceSetNext')}</button>
          <button type="button" onClick={() => setNext(props.preset.sequence.start)}>{t('toolChest.sequenceReset')}</button>
        </div>
      </Show>
      <Show when={message()}><p class="sp-tool-set-message" role="status">{message()}</p></Show>
      <Show when={error()}><p class="sp-tool-set-error" role="alert">{error()}</p></Show>
    </form>
  );
}

// --- Tool Chest body (the external editor layout; shared by the panel and the floating window) ---
// Collapsible sections: My Tools (hot-key badges 1-0), Recent Tools, the named
// sets, then the symbol library groups. Each section has a ▸/▾ chevron, its
// name and a ⚙ menu; tools show as an icon grid (Symbol view) or a list
// (Detail view). Right-click a tool for its menu; drag a tool to reorder it
// or onto another set to move it (Ctrl: copy). Section state and the view
// mode are remembered (stores/toolChestUi.js).

const PRESET_ICONS = {
  line: () => toolIcon('line'), arrow: () => lucide('arrow-up-right'), box: () => lucide('square'),
  circle: () => toolIcon('ellipse'), highlight: () => lucide('highlighter'), cloud: () => toolIcon('cloud'),
  textbox: () => lucide('type'), callout: () => toolIcon('callout'), count: () => toolIcon('count'),
  polyline: () => toolIcon('polyline'), polygon: () => lucide('pentagon'), cloudPolyline: () => toolIcon('cloud'),
  typewriter: () => lucide('text-cursor'), flag: () => lucide('flag'), stamp: () => lucide('stamp'),
  group: () => lucide('group'),
};

function findPaletteSymbol(symbolId) {
  for (const category of allCategories()) {
    const symbol = (category.symbols || []).find(item => item.id === symbolId);
    if (symbol) return { symbol, color: category.color };
  }
  return null;
}

function presetIcon(preset) {
  if (preset.tool === 'symbol') {
    const hit = findPaletteSymbol(preset.style?.symbolId);
    return hit && typeof hit.symbol.svg === 'string' ? colorizeSvg(hit.symbol.svg, hit.color) : lucide('stamp');
  }
  return (PRESET_ICONS[preset.tool] || (() => lucide('square-pen')))();
}

function presetColor(preset) {
  const style = preset?.style || {};
  for (const value of [style.strokeColor, style.color, style.textColor, style.fillColor]) {
    if (typeof value === 'string' && value.startsWith('#')) return value;
  }
  return 'currentColor';
}

/** The Tool Chest search box (header row; also on top of the floating window). */
function ToolChestSearch() {
  const { t } = useTranslation('common');
  return (
    <div class="tc-search" role="search">
      <input type="search" placeholder={t('search')} aria-label={t('panelHost.toolChestSearch')}
        value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && searchQuery()) { e.stopPropagation(); setSearchQuery(''); } }} />
      <Show when={searchQuery()} fallback={<span class="tc-search-icon" innerHTML={searchSvg} />}>
        <button type="button" class="tc-search-clear" aria-label={t('clear')} title={t('clear')}
          onClick={() => setSearchQuery('')} innerHTML={closeSvg} />
      </Show>
    </div>
  );
}

function SymbolContent(props) {
  const { t } = useTranslation('ribbon');
  const [addingTo, setAddingTo] = createSignal(null); // set id whose "add selected" form is open
  const [countFormFor, setCountFormFor] = createSignal(null); // set id whose "New Symbol Count" form is open
  const [toolName, setToolName] = createSignal('');
  const [includeTextboxTextAndSize, setIncludeTextboxTextAndSize] = createSignal(false);
  const [includeCalloutGeometry, setIncludeCalloutGeometry] = createSignal(false);
  const [presetSaveError, setPresetSaveError] = createSignal('');
  const [newSetName, setNewSetName] = createSignal('');
  const [renaming, setRenaming] = createSignal(null); // set id
  const [renameText, setRenameText] = createSignal('');
  const [editingToolId, setEditingToolId] = createSignal(null);
  const [editName, setEditName] = createSignal('');
  // "Layer…" on a saved tool (docs/reference/editor/layers.md): the tool id and the name being typed.
  const [layerToolId, setLayerToolId] = createSignal(null);
  const [layerText, setLayerText] = createSignal('');
  const [dragged, setDragged] = createSignal(null); // { id, setId }
  const [dropTarget, setDropTarget] = createSignal(null);
  const [customScaleOpen, setCustomScaleOpen] = createSignal(false);

  const selectedMarkup = () => {
    const doc = getActiveDocument();
    return doc?.selectedAnnotations?.length === 1 ? doc.selectedAnnotations[0] : null;
  };
  const savedTools = () => getToolChestPresets();
  const namedSets = () => getToolChestSets();
  startToolSetSharing();
  const tShare = (key, params) => t(`common:toolSetSharing.${key}`, params);
  // Shared sets (docs/reference/editor/tool-chest.md): read-only until checked out.
  const editable = (setId) => { toolSetShareRevision(); return canEditToolSet(setId); };
  const shareOf = (setId) => toolSetShareStatus(setId);
  const runShare = async (section, action, kind) => {
    const message = shareMessage(tShare, section.name, await action(section.setId), kind);
    if (message) showChestMessage(message.text, !!message.error);
    else showChestMessage(null);
  };
  const toggleCheckOut = (section) => {
    const status = shareOf(section.setId);
    if (status.offline) { showChestMessage(tShare('offlineTitle'), true); return; }
    if (status.editable) runShare(section, checkInToolSet, 'checkIn');
    else runShare(section, checkOutToolSet, 'checkOut');
  };

  const paletteCategories = createMemo(() => {
    const categories = featuredFirst(filteredCategories());
    if (showOtherLibraries() || searchQuery().trim()) return categories;
    const featured = categories.filter(isFeaturedCategory);
    return featured.length ? featured : categories;
  });
  const librarySymbolCount = () => paletteCategories().reduce((count, category) => count + category.symbols.length, 0);

  const sections = createMemo(() => {
    const presets = savedTools();
    // `index`: the tool's place in its set (hot-key slot, drop position),
    // kept while the search hides other tools.
    const presetTool = (preset, index) => ({ id: preset.id, name: preset.name, tool: preset.tool,
      description: toolDescription(preset), kind: 'preset', preset, index });
    const out = [];
    toolSetShareRevision();
    for (const set of namedSets()) {
      const mine = set.id === DEFAULT_TOOL_SET_ID;
      // Manage Tool Sets: Display off, or a set limited to another profile.
      if (!mine && !toolSetVisible(set, activeProfile())) continue;
      out.push({ id: toolSetSectionId(set.id), kind: 'set', setId: set.id, set,
        name: mine ? t('toolChest.myTools') : set.name,
        tools: presets.filter(preset => preset.setId === set.id).map(presetTool) });
      if (mine) {
        out.push({ id: RECENT_SECTION, kind: 'recent', name: t('toolChest.recentTools'),
          tools: getRecentTools().map(preset => ({ id: preset.id, name: preset.name, tool: preset.tool,
            description: toolDescription(preset, { recent: true }), kind: 'recent', preset })) });
      }
    }
    for (const category of paletteCategories()) {
      out.push({ id: librarySectionId(category.id), kind: 'lib', category, name: category.name,
        tools: category.symbols.map(symbol => ({ id: symbol.id, name: symbol.name,
          description: symbol.group || category.name, kind: 'symbol', symbol, color: category.color })) });
    }
    return out;
  });
  createEffect(() => setLiveSections(sections().map(section => section.id), [
    ...namedSets().map(set => toolSetSectionId(set.id)), RECENT_SECTION,
    ...allCategories().map(category => librarySectionId(category.id)),
  ]));
  const visibleSections = createMemo(() => filterToolChestSections(sections(), searchQuery()));
  const isOpen = (section) => !!section.searchOpen || sectionOpen(section.id);
  const firstLibrary = () => visibleSections().find(section => section.kind === 'lib')?.id;

  // --- Using tools ---
  const isActive = (tool) => tool.kind === 'symbol'
    ? state.toolOverrides?.stampSvg === tool.symbol.svg
    : activeToolPreset()?.id === tool.id;
  const useTool = (tool) => {
    if (tool.kind === 'preset') useToolPreset(tool.preset);
    else if (tool.kind === 'recent') useRecentToolPreset(tool.preset);
    else selectSymbol(tool.symbol);
  };
  const toolTooltip = (tool, badge) => {
    const base = t('toolChest.toolTitle', { name: tool.name, description: tool.description });
    const slot = badge ? `${base} · ${t('toolChest.slotTitle', { key: badge })}` : base;
    return tool.kind === 'preset' && tool.preset.layer
      ? `${slot} · ${t('common:markupLayers.toolLayerTooltip', { layer: tool.preset.layer })}` : slot;
  };
  // Tool layers: the external editor suggests the tool set name.
  const setNameOf = (setId) => setId === DEFAULT_TOOL_SET_ID ? t('toolChest.myTools')
    : (namedSets().find(set => set.id === setId)?.name || t('toolChest.myTools'));
  // Shared sets: tool layers are an edit, so a read-only set refuses them
  // with the read-only hint (the presets store's edit guard decides).
  const readOnlyHint = (setId) => tShare('readOnlySet', { name: setNameOf(setId) });
  const startToolLayer = (preset) => {
    if (!editable(preset.setId)) { showChestMessage(readOnlyHint(preset.setId), true); return; }
    setLayerText(preset.layer || setNameOf(preset.setId));
    setLayerToolId(preset.id);
  };
  const commitToolLayer = (clear = false) => {
    const preset = savedTools().find(item => item.id === layerToolId());
    if (!preset) { setLayerToolId(null); return; }
    const name = clear ? null : cleanToolLayerName(layerText());
    if (!clear && !name) { showChestMessage(t('common:markupLayers.toolLayerInvalid'), true); return; }
    const updated = setToolPresetLayer(preset.id, name);
    setLayerToolId(null);
    if (!updated && !editable(preset.setId)) { showChestMessage(readOnlyHint(preset.setId), true); return; }
    if (updated) {
      showChestMessage(name ? t('common:markupLayers.toolLayerSet', { name: preset.name, layer: name })
        : t('common:markupLayers.toolLayerCleared', { name: preset.name }));
    }
  };
  const assignSetLayer = (section, name) => {
    if (!editable(section.setId)) { showChestMessage(readOnlyHint(section.setId), true); return; }
    const count = setToolSetLayer(section.setId, name);
    if (!count) return;
    showChestMessage(name ? t('common:markupLayers.setLayerDone', { count, layer: name })
      : t('common:markupLayers.setLayerCleared', { count }));
  };
  const isSymbolCountPreset = (tool) => tool.kind !== 'symbol'
    && tool.preset?.tool === 'count' && tool.preset.style?.markerStyle === 'symbol';
  const iconFor = (tool) => tool.kind === 'symbol' ? colorizeSvg(tool.symbol.svg, tool.color) : presetIcon(tool.preset);

  // --- Adding the selected markup to a set ---
  const startAdding = (setId) => {
    const markup = selectedMarkup();
    if (!canSaveToolPreset(markup)) return;
    const tool = presetToolOf(markup);
    setToolName(`${toolTypeName(tool)} ${savedTools().length + 1}`);
    setIncludeTextboxTextAndSize(false);
    setIncludeCalloutGeometry(false);
    setPresetSaveError('');
    setCountFormFor(null);
    setAddingTo(setId);
    openSection(toolSetSectionId(setId));
  };
  // New Symbol Count… (set ⚙ menu): a count tool that places a symbol and
  // numbers it in its own category (SymbolCountPresetForm.jsx).
  const startCountTool = (setId) => {
    setAddingTo(null);
    setCountFormFor(setId);
    showChestMessage(null);
    openSection(toolSetSectionId(setId));
  };
  const saveSelectedTool = () => {
    const saved = saveToolPreset(countPresetSource(selectedMarkup()), toolName(), addingTo(),
      { includeTextAndSize: includeTextboxTextAndSize(), includeCalloutGeometry: includeCalloutGeometry() });
    if (saved) {
      setAddingTo(null);
      setPresetSaveError('');
    } else {
      setPresetSaveError(includeTextboxTextAndSize()
        ? 'Drawing Mode needs nonempty text of at most 2,000 characters with a valid size.'
        : includeCalloutGeometry()
          ? 'Drawing Mode needs an unrotated callout with a valid box and connected leader.'
          : t('toolChest.saveFailed'));
    }
  };

  // --- Sets ---
  const createSet = () => {
    const created = createToolSet(newSetName());
    if (!created) { showChestMessage(t('toolChest.setNameTaken'), true); return; }
    setNewSetName('');
    setNewSetFormOpen(false);
    showChestMessage(null);
    openSection(toolSetSectionId(created.id));
  };
  const commitRename = () => {
    const id = renaming();
    if (!id) return;
    if (!renameToolSet(id, renameText())) { showChestMessage(t('toolChest.setNameTaken'), true); return; }
    showChestMessage(null);
    setRenaming(null);
  };
  const scaleText = (scale) => {
    const ratio = referenceScaleRatio(scale);
    return ratio ? `1:${ratio}` : `${scale.pixelsPerUnit} pt/${scale.unit}`;
  };
  // the external editor scale-aware set: the reference is the calibrated scale of the
  // current page; Drawing Mode tools of the set resize to other scales.
  const toggleScaleAware = (setId, on) => {
    if (!on) { setToolSetReferenceScale(setId, null); showChestMessage(null); return; }
    const doc = getActiveDocument();
    const scale = doc ? getMeasureScale(doc.currentPage || 1) : null;
    const reference = scale?.calibrated ? cleanReferenceScale({ pixelsPerUnit: scale.pixelsPerUnit, unit: scale.unit }) : null;
    if (!reference) { showChestMessage(t('toolChest.scaleNeedsCalibration'), true); return; }
    setToolSetReferenceScale(setId, reference);
    showChestMessage(t('toolChest.scaleSet', { scale: scaleText(reference) }));
  };
  const addSetToMyTools = (section) => {
    let count = 0;
    for (const tool of section.tools) {
      if (!copyToolPreset(tool.id, DEFAULT_TOOL_SET_ID)) {
        showChestMessage(t('toolChest.chestFull'), true);
        return;
      }
      count++;
    }
    showChestMessage(t('toolChest.copiedToMyTools', { count }));
  };

  // --- Menus ---
  const displayItems = (section) => ({
    label: t('toolChest.display'),
    items: [
      { label: t('toolChest.symbolView'), icon: lucide('layout-grid'), checked: sectionViewOf(section.id) === 'symbol',
        run: () => setSectionView(section.id, 'symbol') },
      { label: t('toolChest.detailView'), icon: lucide('list'), checked: sectionViewOf(section.id) === 'detail',
        run: () => setSectionView(section.id, 'detail') },
    ],
  });
  const gearItems = (section) => {
    if (section.kind === 'recent') {
      return [displayItems(section), { separator: true },
        { label: t('toolChest.clearRecent'), disabled: !section.tools.length, run: clearRecentTools }];
    }
    if (section.kind === 'lib') {
      const items = [displayItems(section), { separator: true },
        { label: t('toolChest.showOtherLibraries'), checked: showOtherLibraries(), run: () => setShowOtherLibraries(v => !v) },
        { label: t('drawing.symbolScale'), items: SCHAAL_STAPPEN.map(step => ({ label: schaalLabel(step),
          checked: Number(symboolSchaal()) === step, run: () => setSymboolSchaal(String(step)) })) },
        { label: `${t('toolChest.customScale')}…`, run: () => setCustomScaleOpen(true) },
        { label: t('toolChest.librarySettings'), icon: settingsSvg, run: () => setSettingsOpen(true) }];
      return items;
    }
    const named = section.setId !== DEFAULT_TOOL_SET_ID;
    const tools = section.tools.map(tool => tool.preset);
    const allDrawing = tools.length > 0 && tools.every(preset => preset.mode === 'drawing');
    const canEdit = editable(section.setId);
    const share = named ? shareOf(section.setId) : { shared: false };
    const items = [];
    if (share.shared) {
      items.push(share.editable
        ? { label: tShare('checkIn'), icon: lucide('circle-check'), run: () => runShare(section, checkInToolSet, 'checkIn') }
        : { label: tShare('checkOut'), icon: lucide('lock-open'), disabled: !!share.offline,
          run: () => runShare(section, checkOutToolSet, 'checkOut') });
      if (share.editable) items.push({ label: tShare('cancelCheckOut'), run: () => runShare(section, cancelToolSetCheckOut, 'cancel') });
      if (!share.editable && share.stale) {
        items.push({ label: tShare('breakLock'), run: () => runShare(section, (id) => checkOutToolSet(id, { breakStale: true }), 'checkOut') });
      }
      items.push({ separator: true });
    }
    items.push(
      { label: t('toolChest.propertiesMode'), checked: tools.length > 0 && !tools.some(p => p.mode === 'drawing'),
        disabled: !tools.length || !canEdit, run: () => setToolSetMode(section.setId, 'properties') },
      { label: t('toolChest.drawingMode'), checked: allDrawing,
        disabled: !tools.some(preset => preset.geometry) || !canEdit, run: () => setToolSetMode(section.setId, 'drawing') },
      { separator: true },
      displayItems(section),
      { label: t('toolChest.addSelected'), icon: lucide('plus'),
        disabled: !canEdit || !canSaveToolPreset(selectedMarkup()) || savedTools().length >= MAX_TOOL_CHEST_TOOLS,
        run: () => startAdding(section.setId) },
      { label: t('common:symbolCountPresets.new'), icon: toolIcon('count'),
        disabled: !canEdit || savedTools().length >= MAX_TOOL_CHEST_TOOLS, run: () => startCountTool(section.setId) },
      { separator: true },
      { label: t('common:markupLayers.assignSetToLayer', { name: section.name }), icon: lucide('layers'),
        disabled: !canEdit || !tools.length || tools.every(preset => preset.layer === cleanToolLayerName(section.name)),
        title: canEdit ? undefined : readOnlyHint(section.setId),
        run: () => assignSetLayer(section, cleanToolLayerName(section.name)) },
      { label: t('common:markupLayers.clearSetLayers'), disabled: !canEdit || !tools.some(preset => preset.layer),
        title: canEdit ? undefined : readOnlyHint(section.setId),
        run: () => assignSetLayer(section, null) },
    );
    if (named) {
      items.push(
        { label: t('toolChest.rename'), disabled: !canEdit, run: () => { setRenameText(section.set.name); setRenaming(section.setId); } },
        { label: t('toolChest.export'), icon: lucide('download'), disabled: transferBusy(),
          run: () => exportToolSetToFile(section.setId) },
        { label: tShare('exportFile'), icon: lucide('share'), run: async () => {
          try {
            const result = await exportToolSetFile(section.setId);
            if (result) showChestMessage(tShare('exported', { name: result.name }));
          } catch (error) { showChestMessage(error?.message || String(error), true); }
        } },
        { label: section.set.referenceScale
          ? t('toolChest.scaleAwareOn', { scale: scaleText(section.set.referenceScale) }) : t('toolChest.scale'),
        checked: !!section.set.referenceScale, disabled: !canEdit,
        run: () => toggleScaleAware(section.setId, !section.set.referenceScale) },
        { label: t('toolChest.addToMyTools'), disabled: !section.tools.length, run: () => addSetToMyTools(section) },
        { separator: true },
        { label: t('toolChest.remove'), icon: lucide('trash-2'), disabled: share.shared,
          run: () => deleteToolSet(section.setId) });
    }
    items.push({ separator: true },
      { label: tShare('manage'), icon: lucide('settings'), run: () => openDialog('manage-tool-sets') });
    return items;
  };
  const openGear = (section, event) => {
    event.preventDefault();
    event.stopPropagation();
    const r = event.currentTarget.getBoundingClientRect?.();
    const x = event.type === 'contextmenu' ? event.clientX : (r ? r.right - 200 : event.clientX);
    const y = event.type === 'contextmenu' ? event.clientY : (r ? r.bottom + 2 : event.clientY);
    openPanelMenu(x, y, gearItems(section));
  };
  const toolMenuItems = (section, tool, index) => {
    if (tool.kind === 'symbol') {
      return [{ label: t('toolChest.place'), run: () => selectSymbol(tool.symbol) }, displayItems(section)];
    }
    if (tool.kind === 'recent') {
      return [{ label: t('toolChest.use'), run: () => useTool(tool) }, { separator: true },
        { label: t('toolChest.clearRecent'), run: clearRecentTools }];
    }
    const preset = tool.preset;
    const sets = namedSets();
    const setName = (set) => set.id === DEFAULT_TOOL_SET_ID ? t('toolChest.myTools') : set.name;
    const canEdit = editable(preset.setId);
    const fixedMode = ALWAYS_DRAWING_TOOL_TYPES.includes(preset.tool);
    return [
      { label: t('toolChest.propertiesMode'), checked: preset.mode !== 'drawing', disabled: !canEdit || fixedMode,
        run: () => { if (preset.mode === 'drawing') toggleToolPresetMode(preset.id); } },
      { label: t('toolChest.drawingMode'), checked: preset.mode === 'drawing', disabled: !preset.geometry || !canEdit || fixedMode,
        run: () => { if (preset.mode !== 'drawing') toggleToolPresetMode(preset.id); } },
      { separator: true },
      { label: t('toolChest.edit'), icon: lucide('pencil'), disabled: !canEdit,
        run: () => { setEditName(preset.name); setEditingToolId(preset.id); } },
      { label: preset.layer ? `${t('common:markupLayers.toolLayer')} (${preset.layer})` : t('common:markupLayers.toolLayer'),
        icon: lucide('layers'), disabled: !canEdit, title: canEdit ? undefined : readOnlyHint(preset.setId),
        run: () => startToolLayer(preset) },
      { label: t('toolChest.copyTo'), icon: lucide('copy'), items: sets.map(set => ({ label: setName(set),
        disabled: savedTools().length >= MAX_TOOL_CHEST_TOOLS || !editable(set.id), run: () => copyToolPreset(preset.id, set.id) })) },
      { label: t('toolChest.moveTo'), disabled: !canEdit, items: sets.filter(set => set.id !== preset.setId).map(set => ({ label: setName(set),
        disabled: !editable(set.id), run: () => { moveToolPreset(preset.id, set.id); openSection(toolSetSectionId(set.id)); } })) },
      { label: t('toolChest.moveUp', { name: preset.name }), icon: lucide('chevron-up'), disabled: index === 0 || !canEdit,
        run: () => reorderToolPreset(preset.id, -1) },
      { label: t('toolChest.moveDown', { name: preset.name }), icon: lucide('chevron-down'),
        disabled: !canEdit || index === savedTools().filter(p => p.setId === preset.setId).length - 1,
        run: () => reorderToolPreset(preset.id, 1) },
      { separator: true },
      { label: t('toolChest.delete'), icon: lucide('trash-2'), disabled: !canEdit, run: () => deleteToolPreset(preset.id) },
    ];
  };

  // --- Drag and drop between sets ---
  const dropOn = (event, section, index) => {
    event.preventDefault();
    event.stopPropagation();
    const drag = dragged();
    setDragged(null);
    setDropTarget(null);
    if (!drag || section.kind !== 'set' || !editable(section.setId) ||
        (!(event.ctrlKey || event.metaKey) && !editable(drag.setId))) return;
    let id = drag.id;
    if (event.ctrlKey || event.metaKey) {
      const copy = copyToolPreset(id, section.setId);
      if (!copy) { showChestMessage(t('toolChest.chestFull'), true); return; }
      id = copy.id;
    } else if (drag.setId !== section.setId) {
      moveToolPreset(id, section.setId);
    }
    if (Number.isInteger(index)) placeToolPresetAt(id, index);
    openSection(section.id);
  };
  const allowDrop = (event, section, key) => {
    if (!dragged() || section.kind !== 'set') return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move'; } catch { /* optional */ }
    setDropTarget(key);
  };

  const editingTool = () => savedTools().find(preset => preset.id === editingToolId()) || null;
  const layerTool = () => savedTools().find(preset => preset.id === layerToolId()) || null;

  const ToolTile = (tileProps) => {
    const tool = tileProps.tool;
    const position = () => (Number.isInteger(tool.index) ? tool.index : tileProps.index());
    const badge = () => tileProps.section.setId === DEFAULT_TOOL_SET_ID ? myToolsBadge(position()) : '';
    const draggable = tool.kind === 'preset';
    return (
      <button type="button"
        class={`tc-tool${tool.kind === 'symbol' && isCatalogusFamilie(tool.symbol) ? ' tc-tool-named' : ''}${tool.kind === 'symbol' && tool.symbol?.id?.startsWith('oculith-') ? ' sp-symbol-btn sp-symbol-oculith' : ''}${isActive(tool) ? ' active' : ''}${dragged()?.id === tool.id ? ' dragging' : ''}${dropTarget() === tool.id ? ' drop-target' : ''}`}
        data-tool-id={tool.id} data-tool-kind={tool.kind}
        aria-pressed={isActive(tool)}
        aria-keyshortcuts={badge() || undefined}
        aria-label={toolTooltip(tool, badge())} title={toolTooltip(tool, badge())}
        draggable={draggable ? 'true' : undefined}
        onClick={() => useTool(tool)}
        onDblClick={() => {
          // the external editor: double-click a tool to switch Drawing / Properties Mode.
          if (tool.kind === 'preset' && tool.preset.geometry && editable(tool.preset.setId) &&
              !ALWAYS_DRAWING_TOOL_TYPES.includes(tool.preset.tool)) toggleToolPresetMode(tool.preset.id);
        }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation();
          openPanelMenu(e.clientX, e.clientY, toolMenuItems(tileProps.section, tool, position())); }}
        onDragStart={(e) => {
          if (!draggable) return;
          setDragged({ id: tool.id, setId: tool.preset.setId });
          try { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', tool.name); } catch { /* optional */ }
        }}
        onDragOver={(e) => allowDrop(e, tileProps.section, tool.id)}
        onDragLeave={() => { if (dropTarget() === tool.id) setDropTarget(null); }}
        onDrop={(e) => dropOn(e, tileProps.section, position())}
        onDragEnd={() => { setDragged(null); setDropTarget(null); }}>
        <Show when={isSymbolCountPreset(tool)} fallback={
          <span class="tc-tool-icon" style={{ color: tool.kind === 'symbol' ? undefined : presetColor(tool.preset) }}
            innerHTML={iconFor(tool)} />}>
          <span class="tc-tool-icon tc-tool-icon-count">
            <CountSymbolPreview symbolId={tool.preset.style.symbolId} color={tool.preset.style.color} size={22} />
          </span>
        </Show>
        <Show when={tool.kind !== 'symbol'}>
          <span class="tc-tool-swatch" style={{ 'background-color': presetColor(tool.preset) }} />
        </Show>
        <Show when={badge()}><span class="tc-tool-badge" aria-hidden="true">{badge()}</span></Show>
        <Show when={tool.kind === 'preset'}>
          <span class={`tc-tool-mode${tool.preset.mode === 'drawing' ? '' : ' tc-tool-mode-properties'}`} aria-hidden="true"
            data-mode={tool.preset.mode}
            title={`${tool.preset.mode === 'drawing' ? t('toolChest.drawingMode') : t('toolChest.propertiesMode')} · ${
              ALWAYS_DRAWING_TOOL_TYPES.includes(tool.preset.tool) ? tShare('alwaysDrawing') : tShare('dblClickToggle')}`}>
            {tool.preset.mode === 'drawing' ? 'D' : 'P'}</span>
        </Show>
        <Show when={tool.kind === 'preset' && tool.preset.layer}>
          <span class="tc-tool-layer" aria-hidden="true" innerHTML={sizedIcon(lucide('layers'), 10)} />
        </Show>
        <span class="tc-tool-text">
          <span class="tc-tool-name">{tool.name}</span>
          <span class="tc-tool-desc">{tool.description}</span>
          <Show when={tool.kind === 'preset' && (tool.preset.subject || tool.preset.comment)}>
            <span class="tc-tool-detail">
              <Show when={tool.preset.subject}><span class="tc-tool-subject">{tShare('subject')}: {tool.preset.subject}</span></Show>
              <Show when={tool.preset.comment}><span class="tc-tool-comment">{tShare('comment')}: {tool.preset.comment}</span></Show>
            </span>
          </Show>
        </span>
      </button>
    );
  };

  const Section = (sectionProps) => {
    const section = () => sectionProps.section;
    const open = () => isOpen(section());
    const view = () => sectionViewOf(section().id);
    return (
      <div class={`tc-section${open() ? ' open' : ''}${dropTarget() === section().id ? ' drop-target' : ''}`}
        data-section={section().id} data-kind={section().kind}
        onDragOver={(e) => allowDrop(e, section(), section().id)}
        onDrop={(e) => dropOn(e, section())}>
        <Show when={section().kind === 'lib' && section().id === firstLibrary()}>
          <div class="tc-library-divider">
            <span>{t('toolChest.library')}</span>
            <span class="tc-library-count">{librarySymbolCount()}</span>
            <select class="tc-library-scale" aria-label={t('drawing.symbolScale')} title={t('drawing.symbolScaleTitle')}
              value={String(symboolSchaal())} onChange={(e) => setSymboolSchaal(e.currentTarget.value)}>
              <For each={SCHAAL_STAPPEN}>{(step) => <option value={String(step)}>{schaalLabel(step)}</option>}</For>
              <Show when={!SCHAAL_STAPPEN.includes(Number(symboolSchaal()))}>
                <option value={String(symboolSchaal())}>{schaalLabel(Number(symboolSchaal()))}</option>
              </Show>
            </select>
          </div>
          <Show when={customScaleOpen()}>
            <div class="tc-inline-form">
              <label for="tc-custom-scale">{t('toolChest.customScale')}</label>
              <input id="tc-custom-scale" type="number" class="sp-scale-eigen" min="0.1" max="10" step="0.05"
                value={symboolSchaal()} title={t('drawing.symbolScaleCustom')}
                onChange={(e) => setSymboolSchaal(e.currentTarget.value)} />
              <button type="button" onClick={() => setCustomScaleOpen(false)}>{t('toolChest.close')}</button>
            </div>
          </Show>
        </Show>
        <div class="tc-section-header" role="button" tabIndex="0" aria-expanded={open()}
          onClick={() => { if (!section().searchOpen) toggleSection(section().id); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!section().searchOpen) toggleSection(section().id); }
          }}
          onContextMenu={(e) => openGear(section(), e)}>
          <span class="tc-chevron" aria-hidden="true" innerHTML={open() ? chevronDownSvg : chevronRightSvg} />
          <Show when={renaming() === section().setId && section().kind === 'set'} fallback={
            <span class="tc-section-name" title={section().name}>{section().name}</span>
          }>
            <form class="tc-rename" onSubmit={(e) => { e.preventDefault(); commitRename(); }}
              onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
              }}>
              <input aria-label={t('toolChest.rename')} maxLength="48" value={renameText()}
                ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onInput={(e) => setRenameText(e.currentTarget.value)} onBlur={commitRename} />
            </form>
          </Show>
          <Show when={section().set?.referenceScale}>
            <span class="tc-section-scale" title={t('toolChest.scaleAwareTitle')}>{scaleText(section().set.referenceScale)}</span>
          </Show>
          <Show when={section().kind === 'lib' && section().category.id === 'nl-ifc-bouw'}>
            {/* Tekeninstellingen and Systeemtypen of the NL IFC Bouw group (fixed ids for the rig). */}
            <button id="btn-tekeninstellingen" type="button" class="tc-gear" title="Tekeninstellingen"
              onClick={(e) => { e.stopPropagation(); openDialog('tekeninstellingen'); }} innerHTML={settingsSvg} />
            <button id="btn-systeemtypen" type="button" class="tc-gear" title="Systeemtypen beheren"
              onClick={(e) => { e.stopPropagation(); openDialog('systeemtypen'); }}
              innerHTML={`<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10"/><line x1="4.3" y1="1" x2="4.3" y2="11"/><line x1="7.6" y1="1" x2="7.6" y2="11"/><line x1="1" y1="4.3" x2="11" y2="4.3"/><line x1="1" y1="7.6" x2="11" y2="7.6"/></svg>`} />
          </Show>
          <Show when={section().kind === 'set' && section().setId !== DEFAULT_TOOL_SET_ID && shareOf(section().setId).shared}>
            {(() => {
              const status = () => shareOf(section().setId);
              const title = () => status().offline ? tShare('offlineTitle') : status().editable ? tShare('editableTitle')
                : status().lockedBy ? tShare('lockedByTitle', { user: status().lockedBy }) : tShare('readOnlyTitle');
              return (
                <button type="button" class={`tc-gear tc-share-state${status().editable ? ' editable' : ''}${status().offline ? ' offline' : ''}`}
                  data-share-state={status().offline ? 'offline' : status().editable ? 'editable' : 'readonly'}
                  aria-label={title()} title={title()} aria-pressed={!!status().editable}
                  onClick={(e) => { e.stopPropagation(); toggleCheckOut(section()); }}
                  innerHTML={lucide(status().offline ? 'unlink' : status().editable ? 'circle-check' : 'lock')
                    .replace('<svg ', '<svg width="13" height="13" ')} />
              );
            })()}
          </Show>
          <button type="button" class="tc-gear" aria-haspopup="menu"
            aria-label={t('toolChest.gear', { name: section().name })} title={t('toolChest.gear', { name: section().name })}
            onClick={(e) => openGear(section(), e)} innerHTML={settingsSvg} />
        </div>
        <Show when={open()}>
          <Show when={section().kind === 'set' && addingTo() === section().setId}>
            <form class="sp-my-tools-form tc-inline-form" onSubmit={(e) => { e.preventDefault(); saveSelectedTool(); }}>
              <input aria-label={t('toolChest.name')} maxLength="80" value={toolName()}
                ref={(el) => queueMicrotask(() => el.focus())}
                onInput={(e) => setToolName(e.currentTarget.value)} />
              <button type="submit" disabled={!toolName().trim()}>{t('toolChest.save')}</button>
              <button type="button" onClick={() => { setAddingTo(null); setPresetSaveError(''); }}>{t('toolChest.cancel')}</button>
              <Show when={selectedMarkup()?.type === 'textbox' || selectedMarkup()?.type === 'typewriter'}>
                <label class="sp-my-tools-text-choice">
                  <input type="checkbox" checked={includeTextboxTextAndSize()}
                    onChange={(e) => setIncludeTextboxTextAndSize(e.currentTarget.checked)} />
                  Include text and size for Drawing Mode and tool set export
                </label>
              </Show>
              <Show when={selectedMarkup()?.type === 'callout'}>
                <label class="sp-my-tools-text-choice">
                  <input type="checkbox" checked={includeCalloutGeometry()}
                    onChange={(e) => setIncludeCalloutGeometry(e.currentTarget.checked)} />
                  Include box and leader shape for Drawing Mode and tool set export (text stays blank)
                </label>
              </Show>
              <Show when={presetSaveError()}><p class="sp-tool-set-error" role="alert">{presetSaveError()}</p></Show>
            </form>
          </Show>
          <Show when={section().kind === 'set' && countFormFor() === section().setId}>
            <SymbolCountPresetForm setId={section().setId}
              onCancel={() => setCountFormFor(null)}
              onDone={(preset) => {
                setCountFormFor(null);
                showChestMessage(t('common:symbolCountPresets.saved', { name: preset.name }));
              }} />
          </Show>
          <div class={`tc-tools tc-view-${view()}${section().kind === 'lib' ? ' tc-tools-lib' : ''}`}
            role="group" aria-label={section().name}>
            <For each={section().tools}>{(tool, index) => <ToolTile tool={tool} index={index} section={section()} />}</For>
            <Show when={!section().tools.length}>
              <p class="tc-empty">{section().kind === 'recent' ? t('toolChest.recentEmpty') : t('toolChest.setEmpty')}</p>
            </Show>
          </div>
          <Show when={layerTool() && section().kind === 'set' && layerTool().setId === section().setId}>
            <form class="tc-inline-form tc-layer-form" role="group"
              aria-label={t('common:markupLayers.toolLayerTitle', { name: layerTool().name })}
              onSubmit={(e) => { e.preventDefault(); commitToolLayer(); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLayerToolId(null); } }}>
              <p class="tc-layer-hint">{t('common:markupLayers.toolLayerHint')}</p>
              <label for="tc-tool-layer-name">{t('common:markupLayers.toolLayerName')}</label>
              <input id="tc-tool-layer-name" maxLength={TOOL_LAYER_NAME_LIMIT} value={layerText()}
                ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onInput={(e) => setLayerText(e.currentTarget.value)} />
              <button type="submit" disabled={!layerText().trim()}>{t('common:markupLayers.toolLayerOk')}</button>
              <Show when={layerTool().layer}>
                <button type="button" onClick={() => commitToolLayer(true)}>{t('common:markupLayers.toolLayerClear')}</button>
              </Show>
              <button type="button" onClick={() => setLayerToolId(null)}>{t('common:markupLayers.toolLayerCancel')}</button>
            </form>
          </Show>
          <Show when={editingTool() && section().kind === 'set' && editingTool().setId === section().setId}>
            <div class="tc-editor" role="group" aria-label={t('toolChest.editTitle', { name: editingTool().name })}>
              <form class="tc-inline-form" onSubmit={(e) => { e.preventDefault(); renameToolPreset(editingTool().id, editName()); }}>
                <label for="tc-edit-name">{t('toolChest.name')}</label>
                <input id="tc-edit-name" maxLength="80" value={editName()} onInput={(e) => setEditName(e.currentTarget.value)} />
                <button type="submit" disabled={!editName().trim() || editName().trim() === editingTool().name}>{t('toolChest.save')}</button>
              </form>
              <div class="tc-inline-form">
                <button type="button" class="tc-mode-btn" disabled={!editingTool().geometry}
                  aria-pressed={editingTool().mode === 'drawing'} onClick={() => toggleToolPresetMode(editingTool().id)}
                  title={editingTool().geometry ? '' : 'Save a drawn markup with dimensions to enable Drawing Mode'}>
                  {editingTool().mode === 'drawing' ? t('toolChest.drawingMode') : t('toolChest.propertiesMode')}
                </button>
                <button type="button" disabled={!canUpdateToolPreset(editingTool().id, selectedMarkup())}
                  onClick={() => {
                    const updated = updateToolPresetFromAnnotation(editingTool().id, selectedMarkup());
                    showChestMessage(updated ? `${updated.name} updated from the selected ${updated.tool}.`
                      : `Select one unlocked ${editingTool().tool} markup to update ${editingTool().name}.`, !updated);
                  }}>{t('toolChest.updateFromSelected')}</button>
                <button type="button" onClick={() => setEditingToolId(null)}>{t('toolChest.close')}</button>
              </div>
              <form class="tc-inline-form tc-details-form" onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                setToolPresetDetails(editingTool().id, { subject: String(data.get('subject') || ''), comment: String(data.get('comment') || '') });
              }}>
                <label>{tShare('subject')}<input name="subject" maxLength="200" value={editingTool().subject || ''} /></label>
                <label>{tShare('comment')}<input name="comment" maxLength="200" value={editingTool().comment || ''} /></label>
                <button type="submit">{t('toolChest.save')}</button>
              </form>
              <SequenceEditor preset={editingTool()} onClose={() => setEditingToolId(null)} />
            </div>
          </Show>
        </Show>
      </div>
    );
  };

  return (
    <div class="tc-body">
      <Show when={props.withSearch}><div class="tc-float-search"><ToolChestSearch /></div></Show>
      <Show when={chestMessage()}>
        <p class={`tc-message${chestMessage().error ? ' error' : ''}`} role={chestMessage().error ? 'alert' : 'status'}>
          <span>{chestMessage().text}</span>
          <button type="button" aria-label={t('toolChest.close')} onClick={() => showChestMessage(null)} innerHTML={closeSvg} />
        </p>
      </Show>
      <Show when={newSetFormOpen()}>
        <form class="tc-inline-form tc-new-set" onSubmit={(e) => { e.preventDefault(); createSet(); }}>
          <input aria-label={t('toolChest.newSetName')} placeholder={t('toolChest.newSetName')} maxLength="48"
            value={newSetName()} ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => setNewSetName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNewSetFormOpen(false); } }} />
          <button type="submit" disabled={!newSetName().trim() || namedSets().length > MAX_TOOL_SETS}>{t('toolChest.create')}</button>
          <button type="button" onClick={() => setNewSetFormOpen(false)}>{t('toolChest.cancel')}</button>
        </form>
      </Show>
      <div class="tc-sections">
        <For each={visibleSections()}>{(section) => <Section section={section} />}</For>
        <Show when={searchQuery().trim() && !visibleSections().length}>
          <p class="tc-empty tc-no-results">{t('toolChest.noResults')}</p>
        </Show>
      </div>
    </div>
  );
}

// --- Tool Chest panel (the panel hosts render this; spec WP2) ---
// The Tool Chest is a normal panel tab (left host by default, Attach ▸ moves
// it) with its own header: "Tool Chest ▾" and the search box (current plan-review releases).
// It can still float.
export function ToolChestPanel() {
  const { t } = useTranslation('common');
  const floating = () => symbolPaletteVisible() && symbolPaletteMode() === 'float';
  return (
    <div class="sp-panel sp-hosted tc-panel">
      <PanelHeader panelId="toolChest" class="tc-header">
        <Show when={!floating()}><ToolChestSearch /></Show>
      </PanelHeader>
      <Show when={!floating()} fallback={
        <div class="sp-hosted-floating">
          <p>{t('panelHost.floating')}</p>
          <button type="button" onClick={dockToolChest}>{t('panelHost.dock')}</button>
        </div>
      }>
        <SymbolContent />
      </Show>
    </div>
  );
}

/** Detach the Tool Chest into its floating window (the external editor Detach). */
export function floatToolChest() {
  setSymbolPaletteMode('float');
  setSymbolPaletteVisible(true);
  unregisterPaletteDock('symbols');
  saveSymbolPaletteState();
}

/** Put a floating Tool Chest back into its panel. */
export function dockToolChest() {
  const where = ['left', 'right', 'bottom'].find((h) => workspaceLayout().hosts[h].tabs.includes('toolChest')) || 'left';
  setSymbolPaletteMode(`docked-${where === 'right' ? 'right' : 'left'}`);
  setSymbolPaletteVisible(true);
  saveSymbolPaletteState();
  import('./panels/panelActions.js').then((m) => m.activatePanel('toolChest'));
}

// Old docked strip: replaced by ToolChestPanel in the panel hosts.
export function DockedSymbolPalette() {
  return null;
}

// --- Floating Tool Chest window ---
export function FloatingSymbolPalette() {
  const shouldShow = () => symbolPaletteVisible() && symbolPaletteMode() === 'float';

  return (
    <Show when={shouldShow()}>
      <div
        class="sp-panel sp-float tc-panel"
        style={`left:${symbolFloatPos().x}px; top:${symbolFloatPos().y}px`}
      >
        <div class="sp-float-header" onMouseDown={(e) => {
          if (e.target.closest('.sp-float-close') || e.target.closest('button')) return;
          startDrag(e, false);
        }}>
          <span class="sp-float-title">Tool Chest</span>
          <button class="sp-settings-btn" title="Dock" onClick={dockToolChest} innerHTML={sizedIcon(lucide('panel-left'), 12)} />
          <button class="sp-settings-btn" title="Settings" onClick={() => setSettingsOpen(true)} innerHTML={settingsSvg} />
          <button class="sp-float-close" onClick={() => { setSymbolPaletteVisible(false); saveSymbolPaletteState(); }} innerHTML={closeSvg} />
        </div>
        <SymbolContent withSearch />
      </div>
    </Show>
  );
}


// --- Settings Dialog ---
export function SymbolSettingsDialog() {
  const [newGroupName, setNewGroupName] = createSignal('');
  let fileInputRef;
  let importGroupInputRef;

  // Existing local groups may carry locale tags from an earlier library.
  // Keep those groups selectable without contacting a remote catalog.
  const localeOptions = (base, field, selected) => {
    const options = new Map(base.map(item => [item.id, item]));
    for (const category of allCategories()) {
      const tags = category[field];
      for (const id of Array.isArray(tags) ? tags : tags ? [tags] : []) {
        if (!options.has(id)) options.set(id, { id, name: id });
      }
    }
    if (selected && !options.has(selected)) options.set(selected, { id: selected, name: selected });
    return [...options.values()];
  };
  const industries = createMemo(() => localeOptions(INDUSTRIES, 'industry', selectedIndustry()));
  const countries = createMemo(() => localeOptions(COUNTRIES, 'country', selectedCountry()));

  function handleAddGroup() {
    const name = newGroupName().trim();
    if (!name) return;
    addCustomGroup(name);
    setNewGroupName('');
  }

  // Upload SVG or raster image as symbol to a custom group
  const [uploadTargetGroup, setUploadTargetGroup] = createSignal(null);

  function handleUploadClick(groupId) {
    setUploadTargetGroup(groupId);
    fileInputRef?.click();
  }

  async function handleFileSelected(e) {
    const files = e.target.files;
    const groupId = uploadTargetGroup();
    if (!files || !groupId) return;

    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      if (file.type === 'image/svg+xml' || file.name.endsWith('.svg')) {
        // Vector SVG
        const text = await file.text();
        addSymbolToGroup(groupId, name, text);
      } else if (file.type.startsWith('image/')) {
        // Raster image → convert to data URL
        const reader = new FileReader();
        const dataUrl = await new Promise(resolve => {
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        // Wrap in SVG <image> for consistent handling
        const svg = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><image href="${dataUrl}" width="64" height="64"/></svg>`;
        addSymbolToGroup(groupId, name, svg);
      }
    }
    e.target.value = '';
  }

  // Export a custom group as a downloadable JSON file
  function handleExportGroup(cat) {
    const groupData = getCustomGroups().find(g => g.id === cat.id);
    if (!groupData) return;
    const json = JSON.stringify({ id: groupData.id, name: groupData.name, color: groupData.color || null, symbols: groupData.symbols }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${groupData.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Import a group from a JSON file
  async function handleImportGroup(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Parametrische catalogus met vaste fabrikantgeometrie: registreer de
      // families als templates in plaats van als losse platte symbolen. Eén
      // palet-ingang per productlijn, maat te kiezen in het
      // eigenschappenpaneel. Zelfde behandeling als een gedownloade
      // collectie, maar dan vanaf schijf.
      const catalog = parseLineworkCatalog(data);
      if (catalog) {
        const collectionId = String(data.id || file.name.replace(/\.json$/i, ''))
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        registerLineworkCatalog(collectionId, catalog);
        upsertCustomGroup(lineworkCatalogToGroup(collectionId, data, catalog));
        // Melden wat er binnenkwam. Een catalogus zonder previews krijgt een
        // generiek icoon, en dat is aan het palet niet te onderscheiden van
        // een fout in de app — dus benoemen we het.
        const maten = catalog.families.reduce((n, f) => n + f.variants.length, 0);
        const zonderPreview = catalog.families.filter(f => !f.preview).length;
        updateStatusMessage(
          `Catalogus '${collectionId}' geladen: ${catalog.families.length} families, ${maten} maten`
          + (zonderPreview ? ` — ${zonderPreview} zonder preview in het bestand` : '')
        );
        return;
      }

      if (!data.name || !Array.isArray(data.symbols)) {
        console.warn('Invalid symbol group file: missing name or symbols array');
        updateStatusMessage('Bestand niet herkend: geen symboolgroep en geen catalogus');
        return;
      }
      const groupId = addCustomGroup(data.name);
      // Add all symbols from the imported group
      for (const sym of data.symbols) {
        if (sym.name && sym.svg) {
          addSymbolToGroup(groupId, sym.name, sym.svg);
        }
      }
    } catch (err) {
      console.error('Failed to import symbol group:', err);
      // Een catalogus die zichzelf wel als linework-variants aankondigt maar
      // niet klopt, gooit uit parseLineworkCatalog. Die reden hoort de
      // gebruiker te zien in plaats van alleen in de console te belanden.
      updateStatusMessage(`Import mislukt: ${err?.message || err}`, 6000);
    }
    e.target.value = '';
  }

  return (
    <Show when={settingsOpen()}>
      <input ref={fileInputRef} type="file" accept=".svg,image/*" multiple
        style={{ display: 'none' }} onChange={handleFileSelected} />
      <input ref={importGroupInputRef} type="file" accept=".json"
        style={{ display: 'none' }} onChange={handleImportGroup} />
      <div class="sp-settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
        <div class="sp-settings-dialog">
          <div class="sp-settings-header">
            <h3>Symbol Library Settings</h3>
            <button class="sp-float-close" onClick={() => setSettingsOpen(false)} innerHTML={closeSvg} />
          </div>
          <div class="sp-settings-locale">
            <label class="sp-settings-locale-field">
              <span>Industrie</span>
              <select value={selectedIndustry()} onChange={(e) => setSelectedIndustry(e.target.value)}>
                <For each={industries()}>
                  {(ind) => <option value={ind.id} selected={ind.id === selectedIndustry()}>{ind.name}</option>}
                </For>
              </select>
            </label>
            <label class="sp-settings-locale-field">
              <span>Land</span>
              <select value={selectedCountry()} onChange={(e) => setSelectedCountry(e.target.value)}>
                <For each={countries()}>
                  {(c) => <option value={c.id} selected={c.id === selectedCountry()}>{c.flag ? c.flag + ' ' : ''}{c.name}</option>}
                </For>
              </select>
            </label>
          </div>
          <div class="sp-settings-body">
            <For each={featuredFirst(allCategories()).filter(c => matchesLocale(c, selectedIndustry(), selectedCountry()))}>
              {(cat) => (
                <div class="sp-settings-group" style={{ opacity: isGroupEnabled(cat.id) ? 1 : 0.5 }}>
                  <div class="sp-settings-group-header">
                    <label style={{ display: 'flex', 'align-items': 'center', gap: '6px', cursor: 'pointer', flex: 1 }}>
                      <input type="checkbox" checked={isGroupEnabled(cat.id)}
                        onChange={() => toggleGroupEnabled(cat.id)}
                        style={{ margin: 0, cursor: 'pointer' }} />
                      <span class="sp-settings-group-name" style={{ color: cat.color || '#333' }}>{cat.name}</span>
                    </label>
                    <Show when={cat.builtin}>
                      <span class="sp-settings-group-badge">Built-in</span>
                    </Show>
                    <Show when={!cat.builtin && cat.online}>
                      <span class="sp-settings-group-badge">Saved locally</span>
                    </Show>
                    <Show when={!cat.builtin}>
                      <button class="sp-settings-btn-add" style={{ height: '20px', 'font-size': '9px', padding: '0 6px' }}
                        onClick={() => handleUploadClick(cat.id)}>+ Add Symbol</button>
                      <button class="sp-settings-btn-add" style={{ height: '20px', 'font-size': '9px', padding: '0 6px' }}
                        onClick={() => handleExportGroup(cat)}>Export</button>
                      <button class="sp-settings-btn-remove" onClick={() => removeCustomGroup(cat.id)}>Remove</button>
                    </Show>
                  </div>
                  <div class="sp-settings-symbols">
                    <For each={cat.symbols}>
                      {(sym) => (
                        <div class="sp-settings-symbol" title={sym.name}
                          innerHTML={colorizeSvg(sym.svg, cat.color)} />
                      )}
                    </For>
                    <Show when={cat.symbols.length === 0}>
                      <span style={{ 'font-size': '10px', color: '#999' }}>No symbols yet</span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div class="sp-settings-footer">
            <input
              type="text"
              placeholder="New group name..."
              value={newGroupName()}
              onInput={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddGroup(); }}
            />
            <button class="sp-settings-btn-add" disabled={!newGroupName().trim()} onClick={handleAddGroup}>
              Add Group
            </button>
            <button class="sp-settings-btn-add" onClick={() => importGroupInputRef?.click()}>
              Import Group
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function toggleSymbolPalette() {
  // Floating: show/hide the window. Otherwise the Tool Chest panel toggles.
  if (symbolPaletteMode() === 'float') {
    setSymbolPaletteVisible(!symbolPaletteVisible());
    saveSymbolPaletteState();
    return;
  }
  import('./panels/panelActions.js').then((m) => m.togglePanel('toolChest'));
}

/** Is the Tool Chest on screen (panel shown, or floating)? */
export function toolChestVisible() {
  return (symbolPaletteVisible() && symbolPaletteMode() === 'float') || panelShown('toolChest');
}

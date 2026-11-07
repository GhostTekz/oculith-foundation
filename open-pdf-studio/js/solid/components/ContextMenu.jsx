import { createEffect, createSignal, onMount, onCleanup, Show, Switch, Match, For } from 'solid-js';
import { showConfirm } from '../../ui/chrome/confirm-dialog.js';
import {
  visible, menuType, position, targetAnnotation, multiSelectCount, targetPage, hideMenu, vertexContext,
  targetTab, targetPanel, targetMarkupGroup,
} from '../stores/contextMenuStore.js';
import {
  openPopupIcon, hidePopupIcon, resetPopupIcon, cutIcon, copyIcon, pasteIcon,
  deleteIcon, flattenIcon, addReplyIcon, lockedIcon, unlockedIcon, markedIcon, printableIcon,
  statusIcon, reviewHistoryIcon, layerIcon, arrangeIcon, flipLineIcon,
  convertMeasurementIcon, convertPolylineIcon, convertPolygonIcon,
  styleToolsIcon, exportIcon, propertiesIcon, transformIcon, duplicateIcon,
  bookmarkIcon, stickyNoteIcon, imageIcon, handToolIcon,
  snapshotIcon, selectTextPageIcon, pageCutIcon, pageCopyIcon,
  pagePasteIcon, pageDeleteIcon, selectAllIcon, deselectIcon, goToIcon,
  printIcon, findIcon,
} from '../data/contextMenuIcons.js';
import { lucide } from '../data/lucideIcons.js';
import { getCommand, isCommandEnabled, runCommand, commandLabel } from '../commands/index.js';
import { MENUS, menuItem } from '../commands/menus.js';
import { ARRANGE_MENU, arrangeAllowed } from '../commands/arrange-menu.js';
import { docTabMenuItems, tabLabel } from './document-tab-menu.js';
import { runDocTabAction, switchToDocument } from './DocumentTabs.jsx';
import { isTauri } from '../../core/platform.js';
import { compareActive, compareFocused, focusCompareTab } from '../../compare/compare-store.js';
import { HOSTS, getPanelHost } from '../stores/workspaceLayout.js';
import { activatePanel, attachPanel, hidePanelById } from './panels/panelActions.js';
import { PANEL_ORDER } from './panels/panelRegistry.js';
import { getToolChestSets, canEditToolSet } from '../../tools/tool-chest-presets.js';
import { toolChestAddTarget, suggestedToolName, addToToolChest, selectionToolChestTarget, addSelectionToToolChest } from '../stores/toolChestAdd.js';
import { selectionIsOneGroup } from '../../tools/tool-chest-groups.js';
import { copyStyleFromSelection, pasteStyleToSelection, copiedStyle } from '../stores/stylePresetsStore.js';
import { panelMode, getCurrentAnnotation, storeShowMultiSelection } from '../stores/propertiesStore.js';
import { getAnnotationDisplayName } from '../../utils/helpers.js';

import { state, getActiveDocument, clearSelection, isSelected } from '../../core/state.js';
import { statusKey, statusOptions, statusSet as validStatusSet, applyStatusChange } from '../../annotations/markup-status.js';
import { showProperties, hideProperties } from '../../ui/panels/properties-panel.js';
import { selecteerRuimteVanTag } from '../../plattegrond/ruimte-selectie.js';
import { redrawAnnotations, redrawContinuous } from '../../annotations/rendering.js';
import { copyAnnotation, copyAnnotations, pasteFromClipboard, pasteAnnotationsInPlace, duplicateAnnotation } from '../../annotations/clipboard.js';
import { cloneAnnotation } from '../../annotations/factory.js';
import { commitAnnotationMutation, deleteAnnotationsWithUndo } from '../../annotations/mutations.js';
import { expandCorrectionGroups } from '../../annotations/corrections/model.js';
import { recordModify, recordBulkModify } from '../../core/undo-manager.js';
import { isMarkupChecked, toggleMarkupCheck } from '../../annotations/markup-check.js';
import { ensureMarkupColumnsReady } from '../../pdf/markup-columns.js';
import { startTextEditing } from '../../tools/text-editing.js';
import { openStickyPopup, closeStickyPopup } from '../stores/stickyNotePopupStore.js';
import { createTextMarkupAnnotation, createCalloutFromSelection } from '../../text/text-markup.js';
import { setAsDefaultStyle, applyDefaultStyle } from '../../core/preferences.js';
import { setTool } from '../../tools/manager.js';
import {
  resolveSysteem, paneelKey, setPaneelType, addSparing, rotToRaster,
  buildSysteemraster,
} from '../../annotations/systeemraster.js';
import { systeemrasterBuildOpts } from '../../annotations/systeemraster-scale.js';
import { joinToegestaan, zetJoin, dichtstbijzijndEind, hoekTrimPlan, pasTrimToe } from '../../annotations/wand-join.js';
import { wallHalfWidthPx } from '../../annotations/rendering/walls.js';
import { dichtstbijzijndUiteinde } from '../../annotations/stramien-koppeling.js';
import { stramienSlotStatus, schakelStramienSlot, slotLabelSleutel } from '../../annotations/stramien-slot.js';
import { createDefaultPaneelTypen } from '../../annotations/systeem-typen.js';
import { getSysteemTypeById } from '../../annotations/systeem-typen-registry.js';
import { getSelectedText, clearTextSelection } from '../../text/text-selection.js';
import { showCalibrationDialog, showSetScaleDialog } from '../../annotations/measurement.js';
import { openDialog } from '../stores/dialogStore.js';
import { getSelectedPagesArray, formatPageRangeString, selectAllPages, clearPageSelection } from '../stores/panels/thumbnailStore.js';
import { hiddenStatuses, toggleHiddenStatus } from '../stores/panels/annotationsStore.js';
import { layersVersion, moveAnnotationsToAnnotationLayer, moveAnnotationsToNewAnnotationLayer } from '../stores/annotationLayersStore.js';
import { layerRows, sharedLayerId } from '../../annotations/annotatie-lagen.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import i18next from '../../i18n/config.js';
import { gevelPreset } from '../../gevelelement/herkenning.js';
import { paneelTypenVoor, typeNaam } from '../../gevelelement/catalogus.js';
import { indeling, veldBij, voegStijlToe, verwijderStijl, wisselPaneel } from '../../gevelelement/indeling.js';
import { pasToe, zetInWand } from '../../gevelelement/app-bewerking.js';
import { updateStatusMessage } from '../../ui/chrome/status-bar.js';
import { isSplitView } from '../stores/multiViewStore.js';
import {
  revealInFileManager,
  revealInFileManagerLabelKey,
  canRevealInFileManager,
} from '../../core/file-manager-reveal.js';

function redraw() {
  if (getActiveDocument()?.viewMode === 'continuous') {
    redrawContinuous();
  } else {
    redrawAnnotations();
  }
}

let menuReturnFocus;

// Check (Checkmark column) from the context menu; see annotations/markup-check.js.
function runMarkupCheck(annotations) {
  const doc = getActiveDocument();
  toggleMarkupCheck(doc, annotations.filter(Boolean), { ready: ensureMarkupColumnsReady }).then((result) => {
    if (!result) return;
    import('../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList()).catch(() => {});
    if (doc?.selectedAnnotation) showProperties(doc.selectedAnnotation);
  });
}

function restoreFocusAfterMenuAction(button) {
  queueMicrotask(() => {
    if (visible()) return;
    if (document.activeElement !== button && document.activeElement !== document.body) return;
    const modal = [...document.querySelectorAll('.modal-overlay [role="dialog"][aria-modal="true"]')]
      .find(element => element.getClientRects().length > 0);
    if (modal) modal.focus();
    else if (menuReturnFocus?.isConnected) menuReturnFocus.focus();
  });
}

function MenuItem(props) {
  const handleClick = (e) => {
    if (props.disabled) return;
    e.stopPropagation();
    hideMenu();
    if (props.onClick) props.onClick();
    restoreFocusAfterMenuAction(e.currentTarget);
  };

  return (
    <button
      type="button"
      class={`context-menu-item${props.disabled ? ' disabled' : ''}${props.checkbox ? ' context-menu-checkbox' : ''}${props.checked ? ' checked' : ''}`}
      role={props.checkbox ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={props.checkbox ? Boolean(props.checked) : undefined}
      aria-disabled={props.disabled ? true : undefined}
      title={props.title}
      disabled={props.disabled}
      onClick={handleClick}
    >
      {/* 16 px icon column; a checked item shows its check mark there. */}
      <span class="context-menu-icon" innerHTML={props.checkbox && props.checked ? CHECK_ICON : (props.icon || '')} />
      <span class="context-menu-label">{props.label}</span>
      <span class="context-menu-shortcut">{props.shortcut || ''}</span>
    </button>
  );
}

const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>';
const SUBMENU_ICON = lucide('chevron-right');

function Separator() {
  return <div class="context-menu-separator" role="separator" />;
}

function Submenu(props) {
  const [open, setOpen] = createSignal(false);
  let submenuRef;
  return (
    <div ref={submenuRef} class={`context-menu-item context-menu-submenu${props.disabled ? ' disabled' : ''}`}
      title={props.title} role="menuitem" tabIndex={props.disabled ? -1 : 0} aria-disabled={Boolean(props.disabled)}
      aria-haspopup="menu" aria-expanded={open()}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!submenuRef.contains(document.activeElement)) setOpen(false); }}
      onFocusIn={() => setOpen(true)}
      onFocusOut={(e) => { if (!submenuRef.contains(e.relatedTarget)) setOpen(false); }}>
      <span class="context-menu-icon" innerHTML={props.icon || ''} />
      <span class="context-menu-label">{props.label}</span>
      <span class="context-menu-arrow" innerHTML={SUBMENU_ICON} />
      <div class="context-menu-submenu-content" role="menu">
        {props.children}
      </div>
    </div>
  );
}

// "Laag:" met de lagen van het document (#468). Het vinkje staat bij de laag
// van de markering(en); een klik verplaatst ze daarheen (één undo-stap). Bij
// markeringen op verschillende lagen staat er geen waarde en geen vinkje.
// Onderaan "Nieuwe laag…": maakt een laag, zet de markering(en) erop en opent
// het paneel Markeringslagen met de naam in bewerking.
function LayerSubmenu(props) {
  const { t } = useTranslation('context');
  const { t: tRibbon } = useTranslation('ribbon');
  const anns = () => (props.annotations() || []).filter(Boolean);
  const rijen = () => {
    layersVersion();
    return layerRows(getActiveDocument(), tRibbon('annotationLayers.defaultName'));
  };
  // Dezelfde regel als de keuzelijst Laag in het eigenschappenpaneel.
  const gedeeldeLaag = () => sharedLayerId(getActiveDocument(), anns());
  const waarde = () => rijen().find((r) => r.id === gedeeldeLaag())?.name || '';
  return (
    <Submenu icon={layerIcon} label={<>{t('annotation.layer')} <span class="context-menu-value">{waarde()}</span></>}
      disabled={anns().length === 0}>
      <For each={rijen()}>
        {(r) => (
          <MenuItem label={r.name} checkbox={true} checked={r.id === gedeeldeLaag()}
            onClick={() => moveAnnotationsToAnnotationLayer(anns(), r.id)} />
        )}
      </For>
      <Separator />
      <MenuItem label={t('annotation.newLayer')}
        onClick={() => moveAnnotationsToNewAnnotationLayer(anns())} />
    </Submenu>
  );
}

// "Subject…" (docs/MARKUP-GROUPS.md): put the markups in a subject, the external editor's
// main category. Opens the name dialog with their shared subject.
function SubjectMenuItem(props) {
  const { t } = useTranslation('context');
  const anns = () => (props.annotations() || []).filter(Boolean);
  const gedeeld = () => {
    const s = new Set(anns().map((a) => a.subject || ''));
    return s.size === 1 ? [...s][0] : '';
  };
  return (
    <MenuItem icon={lucide('tag')} label={t('annotation.subject')}
      disabled={anns().length === 0 || anns().every((a) => a.locked || a.readOnly)}
      onClick={() => {
        const d = getActiveDocument();
        if (d && anns().length === 1) { d.selectedAnnotation = anns()[0]; d.selectedAnnotations = [anns()[0]]; }
        openDialog('markup-name', { mode: 'subject', value: gedeeld() });
      }} />
  );
}

// A registry command as a menu item (label, icon and shortcut from the
// command). Without onClick it runs the command; disabled follows
// isCommandEnabled() unless given.
function CommandMenuItem(props) {
  const { t } = useTranslation('context');
  const cmd = () => getCommand(props.id);
  return (
    <Show when={cmd()}>
      <MenuItem icon={cmd().icon} label={commandLabel(cmd(), t)} shortcut={cmd().shortcut}
        disabled={props.disabled ?? !isCommandEnabled(cmd())}
        onClick={props.onClick || (() => runCommand(props.id))} />
    </Show>
  );
}

// Arrange ▸ (the external editor): align, distribute and size submenus, z-order, rotate and
// flip, from the old ribbon Arrange tab (commands/arrange.js). `count` is how
// many markups the commands act on; `run(id)` runs one of them. Extra items
// (Transform, Duplicate) come in as children.
function ArrangeSubmenu(props) {
  const { t } = useTranslation('context');
  const item = (id) => {
    const cmd = getCommand(id);
    if (!cmd) return null;
    return (
      <MenuItem icon={cmd.icon} label={commandLabel(cmd, t)} shortcut={cmd.shortcut}
        disabled={props.disabled || !arrangeAllowed(id, props.count())}
        onClick={() => props.run(id)} />
    );
  };
  const render = (entries) => entries.map((entry) => {
    if (!entry) return <Separator />;
    if (typeof entry === 'string') return item(entry);
    const ids = entry.items.filter(Boolean);
    return (
      <Submenu label={t(entry.label)} icon={getCommand(ids[0])?.icon}
        disabled={props.disabled || !ids.some((id) => arrangeAllowed(id, props.count()))}>
        {render(entry.items)}
      </Submenu>
    );
  });
  return (
    <Submenu icon={arrangeIcon} label={t('annotation.arrange')}>
      {render(ARRANGE_MENU)}
      <Show when={props.children}>
        <Separator />
        {props.children}
      </Show>
    </Submenu>
  );
}

// Add to Tool Chest ▸: save the markup's style as a tool in one of the tool
// sets (same saveToolPreset path as the Tool Chest panel's "Add").
// A grouped markup saves its whole group as one tool. A loose multi-selection
// (props.selection) saves those markups as one tool too. Notes, links,
// attachments, text markups and sequenced symbols are refused (the external editor rules,
// docs/TOOL-SET-SHARING.md). "Several sets…" picks more than one set.
function AddToToolChestSubmenu(props) {
  const { t } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');
  const ann = () => props.annotation();
  const loose = () => {
    const list = typeof props.selection === 'function' ? props.selection() : null;
    return Array.isArray(list) && list.length >= 2 ? list : null;
  };
  const target = () => {
    const list = loose();
    if (list) return selectionToolChestTarget(list);
    const a = ann();
    return a ? toolChestAddTarget(a) : { kind: 'blocked', reason: 'unsupported' };
  };
  const canSave = () => target().kind !== 'blocked';
  const add = (set) => {
    const list = loose();
    if (list) {
      const name = suggestedToolName(list[0], { kind: 'group' });
      if (addSelectionToToolChest(list, [set.id], { name }).saved.length) {
        try { updateStatusMessage(t('annotation.addedToToolChest', { set: set.name })); } catch (_) { /* optioneel */ }
      }
      return;
    }
    const a = ann();
    if (!a) return;
    const name = target().kind === 'group' ? suggestedToolName(a)
      : (a.subject || getAnnotationDisplayName(a, getActiveDocument()?.annotations) || a.type || 'Tool').trim();
    if (addToToolChest(a, [set.id], { name }).saved.length) {
      try { updateStatusMessage(t('annotation.addedToToolChest', { set: set.name })); } catch (_) { /* optioneel */ }
    }
  };
  return (
    <Submenu icon={lucide('toolbox')} label={t('annotation.addToToolChest')} disabled={!canSave()}
      title={canSave() ? undefined : tCommon(`toolSetSharing.blocked_${target().reason}`)}>
      <For each={getToolChestSets()}>
        {(set) => <MenuItem label={set.name} disabled={!canEditToolSet(set.id)} onClick={() => add(set)} />}
      </For>
      <Separator />
      <MenuItem label={tCommon('toolSetSharing.chooseSets')} onClick={() => {
        const list = loose();
        if (list) {
          openDialog('add-to-tool-chest', { annotationIds: list.map(item => item.id) });
          return;
        }
        const a = ann();
        if (a) openDialog('add-to-tool-chest', { annotationId: a.id });
      }} />
    </Submenu>
  );
}

// Capture (docs/CAPTURE.md): Attach Photo…, View Photos and, on a File
// Attachment, open or save its file.
const cameraIcon = lucide('camera');
const photosIcon = lucide('image');
const paperclipIcon = lucide('paperclip');
const captureActions = () => import('../../annotations/capture-actions.js');
function CaptureMenuItems(props) {
  const photoCount = () => (Array.isArray(props.ann()?.capturePhotos) ? props.ann().capturePhotos.length : 0);
  return (
    <>
      <MenuItem icon={cameraIcon} label={props.tCommon('capture.contextAttach')} disabled={props.locked()}
        onClick={() => { const a = props.ann(); if (a) captureActions().then(m => m.attachPhotosTo(a)); }} />
      <Show when={photoCount() > 0}>
        <MenuItem icon={photosIcon} label={props.tCommon('capture.contextView', { count: photoCount() })}
          onClick={() => { const a = props.ann(); if (a) captureActions().then(m => m.openPhotoViewer(a)); }} />
      </Show>
      <Show when={props.ann()?.attachedFile}>
        <MenuItem icon={paperclipIcon} label={props.tCommon('capture.contextOpenFile')}
          onClick={() => { const a = props.ann(); if (a) captureActions().then(m => m.openAttachedFile(a)); }} />
        <MenuItem label={props.tCommon('capture.contextSaveFile')}
          onClick={() => { const a = props.ann(); if (a) captureActions().then(m => m.saveAttachedFileAs(a)); }} />
      </Show>
    </>
  );
}

function AnnotationMenuContent() {
  const { t } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');
  const ann = () => targetAnnotation();
  const isLocked = () => ann()?.locked || false;
  // Knippen, verwijderen en platmaken nemen bij een vervanging (#508) de andere
  // helft mee: vergrendeld als een van beide helften vergrendeld is.
  const isPaarVergrendeld = () => { const a = ann(); return !!a && expandCorrectionGroups(getActiveDocument()?.annotations, [a]).some(x => x.locked); };
  const isLineType = () => ['line', 'arrow'].includes(ann()?.type);
  const isMeasureDistance = () => ann()?.type === 'measureDistance';
  const isMeasureArea = () => ann()?.type === 'measureArea' || ann()?.type === 'filledArea';
  // Wand (#476): het uiteinde bij de rechtsklik. Zonder klikpunt (menu via
  // een ander pad geopend) geen join-schakelaar — dan is niet duidelijk welk
  // uiteinde bedoeld is.
  const wandEind = () => {
    const a = ann();
    const v = vertexContext();
    if (a?.type !== 'wall' || v?.kind !== 'wand' || v.annotationId !== a.id) return null;
    return dichtstbijzijndEind(a, { x: v.appX, y: v.appY });
  };

  // The document's status set (Markups List); built-in names are translated.
  const builtInStatusLabels = { none: 'annotation.statusNone', accepted: 'annotation.statusAccepted',
    cancelled: 'annotation.statusCancelled', completed: 'annotation.statusCompleted', rejected: 'annotation.statusRejected' };
  const statusItems = () => {
    const set = validStatusSet(getActiveDocument()?.markupStatusSet);
    return statusOptions(set).map(option => ({ key: option.key,
      label: () => (!set || option.key === 'none') && builtInStatusLabels[option.key] ? t(builtInStatusLabels[option.key]) : option.name }));
  };

  // Edit-contour vertex actions — only shown when right-clicking a vertex/edge
  // handle of the annotation that's currently in edit-contour mode.
  const renderVertexActions = () => {
    const v = vertexContext();
    const a = ann();
    if (!v || !a || a.id !== v.annotationId) return null;
    // Wand-context draagt alleen het klikpunt (zie wandEind hieronder).
    if (v.kind === 'wand') return null;
    // Systeem-paneel (rechtsklik op een cel van een systeemraster/-plafond):
    // paneeltype direct wisselen — het ASSORTIMENT komt als data van het
    // systeemtype (typeDef.paneelTypen) — of het paneel vervangen door een
    // COMPONENT uit de symbolenbibliotheek. Zelfde kern-helpers als het
    // eigenschappenpaneel.
    // "Sparing toevoegen" — voor elke klik binnen een systeem (paneel- of
    // systeem-context): rechthoekige sparing van 600×600 mm gecentreerd op
    // de klikpositie; regime volgt de sparingsregels van het type.
    const sparingToevoegen = (v.kind === 'paneel' || v.kind === 'systeem')
      && Number.isFinite(v.appX) ? () => {
        try {
          const before = cloneAnnotation(a);
          const geom = buildSysteemraster(a, systeemrasterBuildOpts(a));
          if (!geom) { hideMenu(); return; }
          const q = rotToRaster(geom.rot, { x: v.appX, y: v.appY });
          const k = geom.pxPerMm;
          const sp = addSparing(a, {
            xMm: (q.x - geom.rasterAabb.x) / k - 300,
            yMm: (q.y - geom.rasterAabb.y) / k - 300,
            bMm: 600, hMm: 600,
          });
          a.modifiedAt = new Date().toISOString();
          recordModify(a.id, before, cloneAnnotation(a));
          const d = getActiveDocument();
          if (d) { d.selectedAnnotations = [a]; d.selectedAnnotation = a; }
          if (sp) {
            a.selectedSub = { kind: 'sparing', id: sp.id, xMm: sp.xMm, yMm: sp.yMm,
              bMm: sp.bMm, hMm: sp.hMm };
          }
          showProperties(a);
          redraw();
        } catch (err) { console.error('[contextmenu] sparing toevoegen', err); }
        hideMenu();
      } : null;
    // Gevelelement (vliesgevel/kozijn): stijl hier toevoegen, dichtstbijzijnde
    // stijl verwijderen, paneel van het aangeklikte veld wisselen, en een los
    // getekend element in de wand eronder zetten. Elke keuze is één
    // ongedaan-stap (app-bewerking.js).
    if (v.kind === 'gevelelement') {
      const presetId = gevelPreset(a);
      if (!presetId) return null;
      const lay = indeling(a.params, presetId);
      const u = Number.isFinite(v.uMm) ? v.uMm : null;
      const sub = v.onderdeel;
      const laatste = lay.stijlen.length - 1;
      const veldIndex = sub?.soort === 'paneel' ? sub.index : (u !== null ? veldBij(lay, u) : -1);
      let stijlIndex = sub?.soort === 'stijl' && sub.index > 0 && sub.index < laatste ? sub.index : -1;
      if (stijlIndex < 0 && u !== null) {
        let beste = Infinity;
        for (const st of lay.stijlen.slice(1, laatste)) {
          const d = Math.abs(st.posMm - u);
          if (d < beste) { beste = d; stijlIndex = st.index; }
        }
      }
      const huidig = lay.velden[veldIndex]?.paneel?.type;
      const meld = (r) => {
        if (r && !r.ok) {
          try { updateStatusMessage(`${t('gevelelement.editRefused')}: ${r.error}`); } catch (_) { /* optioneel */ }
        }
        hideMenu();
      };
      return (
        <>
          <MenuItem label={t('gevelelement.addMullionHere')} disabled={isLocked() || u === null}
            onClick={() => meld(pasToe(a, (p, id) => voegStijlToe(p, id, u),
              { onderdeel: (r) => ({ soort: 'stijl', index: r.index }) }))} />
          <MenuItem label={t('gevelelement.removeMullion')} disabled={isLocked() || stijlIndex < 0}
            onClick={() => meld(pasToe(a, (p, id) => verwijderStijl(p, id, stijlIndex),
              { onderdeel: { soort: 'paneel', index: stijlIndex - 1 } }))} />
          <Show when={veldIndex >= 0}>
            <For each={paneelTypenVoor(presetId)}>{(pt) => (
              <MenuItem label={t('gevelelement.panelItem', { name: typeNaam(pt, i18next.language) })}
                checkbox checked={huidig === pt.id} disabled={isLocked()}
                onClick={() => meld(pasToe(a, (p, id) => wisselPaneel(p, id, veldIndex, pt.id),
                  { onderdeel: { soort: 'paneel', index: veldIndex } }))} />
            )}</For>
          </Show>
          <Show when={!a.params?.host}>
            <MenuItem label={t('gevelelement.placeInWall')} disabled={isLocked()}
              onClick={() => {
                const r = zetInWand(a);
                if (!r.ok && r.error === 'no wall under the element') {
                  try { updateStatusMessage(t('gevelelement.noHostWall')); } catch (_) { /* optioneel */ }
                  hideMenu();
                  return;
                }
                meld(r);
              }} />
          </Show>
          <Separator />
        </>
      );
    }
    // Stramienlijn: koppeling van het uiteinde het dichtst bij de klik los
    // zetten of weer vastzetten (zelfde schakelaar als het slotje).
    if (v.kind === 'stramien') {
      if (!Number.isFinite(v.appX)) return null;
      const eind = dichtstbijzijndUiteinde(a, { x: v.appX, y: v.appY });
      const status = stramienSlotStatus(a, eind);
      if (!status) return null;
      return (
        <>
          <MenuItem icon={status === 'dicht' ? unlockedIcon : lockedIcon}
            label={t(slotLabelSleutel(status))}
            disabled={isLocked()}
            onClick={() => schakelStramienSlot(a, eind, status !== 'dicht')} />
          <Separator />
        </>
      );
    }
    if (v.kind === 'systeem') {
      return (
        <>
          <MenuItem label={t('systemGrid.addOpening')} onClick={sparingToevoegen} />
          <Separator />
        </>
      );
    }
    if (v.kind === 'paneel') {
      const rawOv = resolveSysteem(a).layers[0].panels[paneelKey(v.ix, v.iy)];
      const huidig = !rawOv ? 'tegel' : (typeof rawOv === 'string' ? rawOv : 'component');
      const zet = (type) => {
        const before = cloneAnnotation(a);
        setPaneelType(a, v.ix, v.iy, type);
        a.selectedSub = { kind: 'paneel', ix: v.ix, iy: v.iy };
        a.modifiedAt = new Date().toISOString();
        recordModify(a.id, before, cloneAnnotation(a));
        redraw();
        hideMenu();
      };
      const assortiment = getSysteemTypeById(a.systeemTypeId)?.paneelTypen
        || createDefaultPaneelTypen();
      const anderComponent = () => {
        // Paneel selecteren zodat de kiezer (via updateAnnotProp) op het
        // juiste sub-element schrijft, dan de kiezer openen.
        const d = getActiveDocument();
        if (d) { d.selectedAnnotations = [a]; d.selectedAnnotation = a; }
        a.selectedSub = { kind: 'paneel', ix: v.ix, iy: v.iy };
        showProperties(a);
        openDialog('systeem-paneel-component');
        hideMenu();
      };
      return (
        <>
          {assortiment.map((pt) => (
            <MenuItem label={t('systemGrid.panelItem', { name: pt.naam })} checkbox checked={huidig === pt.id}
              onClick={() => zet(pt.id)} />
          ))}
          <MenuItem label={huidig === 'component'
            ? t('systemGrid.otherComponentCurrent', { name: rawOv?.naam || rawOv?.symbolId })
            : t('systemGrid.otherComponent')}
            checkbox checked={huidig === 'component'}
            onClick={anderComponent} />
          <Show when={sparingToevoegen}>
            <MenuItem label={t('systemGrid.addOpening')} onClick={sparingToevoegen} />
          </Show>
          <Separator />
        </>
      );
    }
    const isVertex = v.kind === 'vertex';
    const isEdge = v.kind === 'edge';
    const deleteLabel = t('contextMenu.deleteVertex') || 'Delete vertex';
    const insertLabel = t('contextMenu.insertVertex') || 'Insert vertex here';
    const toArcLabel = t('contextMenu.convertToArc') || 'Convert to arc';
    const toLineLabel = t('contextMenu.convertToLine') || 'Convert to line';
    // The vertex's `arc` flag determines the segment ENDING at this vertex
    // (i.e. previous vertex -> this vertex). See arcControlPoint() in
    // js/annotations/measurement.js.
    let clickedVertex = null;
    if (isVertex) {
      if (v.holeIndex != null && Array.isArray(a.holes) && a.holes[v.holeIndex]) {
        clickedVertex = a.holes[v.holeIndex][v.nodeIndex];
      } else if (Array.isArray(a.points)) {
        clickedVertex = a.points[v.nodeIndex];
      }
    }
    const isArcVertex = !!(clickedVertex && clickedVertex.arc);
    const handleDelete = () => {
      const before = cloneAnnotation(a);
      let ok = false;
      if (v.holeIndex != null && Array.isArray(a.holes) && a.holes[v.holeIndex]) {
        const hole = a.holes[v.holeIndex];
        if (hole.length > 3) { hole.splice(v.nodeIndex, 1); ok = true; }
      } else if (Array.isArray(a.points) && a.points.length > 3) {
        a.points.splice(v.nodeIndex, 1);
        ok = true;
      }
      if (ok) {
        a.modifiedAt = new Date().toISOString();
        recordModify(a.id, before, cloneAnnotation(a));
        redraw();
      }
      hideMenu();
    };
    const handleInsert = () => {
      const before = cloneAnnotation(a);
      const ei = v.edgeIndex;
      if (v.holeIndex != null && Array.isArray(a.holes) && a.holes[v.holeIndex]) {
        const hole = a.holes[v.holeIndex];
        if (ei >= 0 && ei < hole.length) {
          const p1 = hole[ei], p2 = hole[(ei + 1) % hole.length];
          hole.splice(ei + 1, 0, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
        }
      } else if (Array.isArray(a.points) && ei >= 0 && ei < a.points.length) {
        const p1 = a.points[ei], p2 = a.points[(ei + 1) % a.points.length];
        a.points.splice(ei + 1, 0, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
      }
      a.modifiedAt = new Date().toISOString();
      recordModify(a.id, before, cloneAnnotation(a));
      redraw();
      hideMenu();
    };
    const handleConvert = () => {
      if (!clickedVertex) { hideMenu(); return; }
      const before = cloneAnnotation(a);
      if (clickedVertex.arc) {
        clickedVertex.arc = false;
        delete clickedVertex.bulge;
      } else {
        clickedVertex.arc = true;
        clickedVertex.bulge = 0.5;
      }
      a.modifiedAt = new Date().toISOString();
      recordModify(a.id, before, cloneAnnotation(a));
      redraw();
      hideMenu();
    };
    return (
      <>
        <Show when={isVertex}>
          <MenuItem icon={deleteIcon} label={deleteLabel} onClick={handleDelete} />
          <MenuItem label={isArcVertex ? toLineLabel : toArcLabel} onClick={handleConvert} />
        </Show>
        <Show when={isEdge}>
          <MenuItem label={insertLabel} onClick={handleInsert} />
        </Show>
        <Separator />
      </>
    );
  };

  return (
    <>
      {renderVertexActions()}
      <Show when={['textbox', 'callout'].includes(ann()?.type)}>
        <MenuItem label={t('annotation.editText')} disabled={isLocked()} onClick={() => startTextEditing(ann())} />
        <Separator />
      </Show>

      <Show when={wandEind()}>
        {/* wandEind() leest het klikpunt (vertexContext, bij elke
            rechtsklik nieuw), zodat het label na een wissel klopt. */}
        <MenuItem
          label={joinToegestaan(ann(), wandEind())
            ? t('annotation.wallJoinDisallow')
            : t('annotation.wallJoinAllow')}
          disabled={isLocked()}
          onClick={() => {
            const a = ann();
            const eind = wandEind();
            if (!a || !eind) return;
            const nu = joinToegestaan(a, eind);
            // Eén ongedaan-stap; de partnerwand leest de vlag bij het
            // hertekenen, dus hij hoeft zelf niet te veranderen.
            commitAnnotationMutation(a, (w) => zetJoin(w, eind, !nu));
            if (getActiveDocument()?.selectedAnnotation === a) showProperties(a);
            redraw();
          }}
        />
        <Separator />
      </Show>

      {/* the external editor order: clipboard, review (reply/status), organise (layer,
          arrange, group, lock, flatten, tool chest), type-specific
          commands, and Properties last. */}
      <MenuItem icon={cutIcon} label={tCommon('cut')} shortcut="Ctrl+X" disabled={isPaarVergrendeld()} onClick={() => {
        const a = ann();
        const doc = getActiveDocument();
        // Een vervanging (#508) wordt in haar geheel geknipt.
        const weg = expandCorrectionGroups(doc?.annotations, [a]);
        if (weg.length > 1) copyAnnotations(weg);
        else copyAnnotation(a);
        deleteAnnotationsWithUndo(doc, weg);
        hideProperties();
        redraw();
      }} />
      <MenuItem icon={copyIcon} label={tCommon('copy')} shortcut="Ctrl+C" onClick={() => copyAnnotation(ann())} />
      <MenuItem icon={pasteIcon} label={tCommon('paste')} shortcut="Ctrl+V" onClick={() => pasteFromClipboard()} />
      <MenuItem icon={pasteIcon} label={tCommon('pasteInPlace')} shortcut="Ctrl+Shift+V" onClick={() => pasteAnnotationsInPlace()} />
      <MenuItem label={tCommon('copyToPages.menu')} onClick={() => {
        const a = ann();
        if (a) openDialog('copy-to-pages', { annotationIds: [a.id] });
      }} />
      <MenuItem label={tCommon('assemblies.menu')} onClick={() => openDialog('assemblies')} />
      <MenuItem icon={deleteIcon} label={tCommon('delete')} shortcut="Delete" disabled={isPaarVergrendeld()} onClick={async () => {
        const a = ann();
        const confirmed = await showConfirm({
          title: t('deleteAnnotation.title'),
          message: t('deleteAnnotation.confirmSingle'),
          preferenceKey: 'confirmBeforeDelete'
        });
        if (confirmed) {
          // Een vervanging (#508) gaat in haar geheel, met één ongedaan-stap.
          deleteAnnotationsWithUndo(getActiveDocument(), [a]);
          hideProperties();
          redraw();
        }
      }} />

      <Separator />

      <MenuItem icon={addReplyIcon} label={t('annotation.addReply')} onClick={() => {
        // Reply in the Markups List thread: open the list with an inline
        // reply box under this markup (an empty reply is never stored).
        const a = ann();
        if (a) {
          import('../../ui/panels/left-panel.js')
            .then(m => m.switchLeftPanelTab('annotations'))
            .then(() => import('../../ui/panels/annotations-list.js'))
            .then(m => m.startMarkupReply(a.id))
            .catch(() => {});
        }
      }} />
      <Submenu icon={statusIcon} label={t('annotation.status')}>
        <For each={statusItems()}>
          {(s) => (
            <MenuItem label={s.label()} checkbox={true} checked={statusKey(ann()?.status) === s.key} onClick={() => {
              const a = ann();
              // Recorded in the status history (author + time), saved as a
              // review-status reply.
              if (a && statusKey(a.status) !== s.key) {
                commitAnnotationMutation(a, annotation => {
                  applyStatusChange(annotation, s.key, state.defaultAuthor || 'User');
                });
                import('../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
              }
            }} />
          )}
        </For>
      </Submenu>
      {/* Statusfilter (Tonen > Status, #333): dezelfde zichtbaarheids-
          toggles als het lijstmenu, bereikbaar vanaf het canvas. Vinkje =
          zichtbaar; de store hertekent het canvas, de lijst gaat mee via
          updateAnnotationsList. Sleutels zijn kleine letters — zelfde
          afspraak als het paneelmenu (#236). */}
      <Submenu icon={statusIcon} label={t('annotation.showByStatus')}>
        <For each={statusItems()}>
          {(s) => (
            <MenuItem label={s.label()} checkbox={true} checked={!hiddenStatuses().has(s.key)} onClick={() => {
              toggleHiddenStatus(s.key);
              import('../../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList());
            }} />
          )}
        </For>
      </Submenu>
      <MenuItem icon={reviewHistoryIcon} label={t('annotation.reviewHistory')} onClick={() => {
        // The status history and replies, as the markup's thread in the
        // Markups List.
        const a = ann();
        if (a) {
          showProperties(a);
          import('../../ui/panels/left-panel.js')
            .then(m => m.switchLeftPanelTab('annotations'))
            .then(() => import('../../ui/panels/annotations-list.js'))
            .then(m => m.showMarkupThread(a.id))
            .catch(() => {});
        }
      }} />

      <CaptureMenuItems ann={ann} locked={isLocked} tCommon={tCommon} />

      <Separator />

      <LayerSubmenu annotations={() => (ann() ? [ann()] : [])} />
      <ArrangeSubmenu count={() => (ann() ? 1 : 0)} disabled={isLocked()}
        run={(id) => { const a = ann(); if (a) runCommand(id, [a]); }}>
        <MenuItem icon={transformIcon} label={t('annotation.transform')} onClick={() => showProperties(ann())} />
        <MenuItem icon={duplicateIcon} label={tCommon('duplicate')} onClick={() => {
          const _d = getActiveDocument();
          const _a = ann();
          if (_d && _a) { _d.selectedAnnotation = _a; _d.selectedAnnotations = [_a]; }
          duplicateAnnotation();
        }} />
      </ArrangeSubmenu>
      <SubjectMenuItem annotations={() => (ann() ? [ann()] : [])} />
      <Show when={ann()?.groupId} fallback={
        <CommandMenuItem id="edit.group" disabled={true} />
      }>
        <CommandMenuItem id="edit.ungroup" disabled={isLocked()} onClick={() => {
          const _d = getActiveDocument();
          const _a = ann();
          if (_d && _a) { _d.selectedAnnotation = _a; _d.selectedAnnotations = [_a]; }
          runCommand('edit.ungroup');
        }} />
        {/* One member of a group, picked in the Markups List or with Alt. */}
        <CommandMenuItem id="edit.removeFromGroup" disabled={isLocked()} onClick={() => {
          const _d = getActiveDocument();
          const _a = ann();
          if (_d && _a) { _d.selectedAnnotation = _a; _d.selectedAnnotations = [_a]; }
          runCommand('edit.removeFromGroup');
        }} />
      </Show>
      <MenuItem icon={isLocked() ? lockedIcon : unlockedIcon} label={t('annotation.locked')} checkbox={true} checked={isLocked()} onClick={() => {
        const a = ann();
        if (a) {
          commitAnnotationMutation(a, annotation => { annotation.locked = !annotation.locked; });
          if (getActiveDocument()?.selectedAnnotation === a) showProperties(a);
        }
      }} />
      <MenuItem icon={lucide('circle-check')} label={tCommon('stampEditor.check')} checkbox={true}
        checked={isMarkupChecked(ann())} disabled={isLocked()} onClick={() => runMarkupCheck([ann()])} />
      <MenuItem icon={markedIcon} label={t('annotation.marked')} checkbox={true} checked={ann()?.marked || false} onClick={() => {
        const a = ann();
        if (a) commitAnnotationMutation(a, annotation => { annotation.marked = !annotation.marked; });
      }} />
      <MenuItem icon={printableIcon} label={t('annotation.printable')} checkbox={true} checked={ann()?.printable !== false} onClick={() => {
        const a = ann();
        if (a) commitAnnotationMutation(a, annotation => { annotation.printable = annotation.printable === false; });
      }} />
      {/* Document ▸ Flatten… on the selected markup (docs/FLATTEN.md). */}
      <MenuItem icon={flattenIcon} label={tCommon('flatten')} disabled={isPaarVergrendeld()}
        onClick={() => runCommand('document.flatten', { selection: true })} />
      <AddToToolChestSubmenu annotation={ann} />

      <Separator />

      <Show when={ann()?.type === 'viewport'}>
        <MenuItem label={t('annotation.editViewportScale') || 'Edit Viewport Scale'} onClick={() => {
          const a = ann();
          if (a) {
            import('../stores/dialogStore.js').then(m => m.openDialog('viewport-scale', {
              annotationId: a.id,
              pageNum: a.page,
            }));
          }
        }} />
        <Separator />
      </Show>
      <Show when={isLineType()}>
        <MenuItem icon={flipLineIcon} label={t('annotation.flipLine')} onClick={() => {
          const a = ann();
          if (a) {
            commitAnnotationMutation(a, annotation => {
              const startX = annotation.startX;
              const startY = annotation.startY;
              annotation.startX = annotation.endX;
              annotation.startY = annotation.endY;
              annotation.endX = startX;
              annotation.endY = startY;
            });
            redraw();
          }
        }} />
        <Separator />
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.convertToMeasurement')} onClick={() => {
          const a = ann();
          if (a) {
            commitAnnotationMutation(a, annotation => { annotation.type = 'measureDistance'; });
            redraw();
          }
        }} />
        <MenuItem icon={convertPolylineIcon} label={t('annotation.convertToPolyline')} onClick={() => {
          const a = ann();
          if (a) {
            commitAnnotationMutation(a, annotation => {
              annotation.type = 'polyline';
              annotation.points = [
                { x: annotation.startX, y: annotation.startY },
                { x: annotation.endX, y: annotation.endY },
              ];
            });
            redraw();
          }
        }} />
        <MenuItem icon={convertPolygonIcon} label={t('annotation.convertToPolygon')} onClick={() => {
          const a = ann();
          if (a) {
            commitAnnotationMutation(a, annotation => {
              annotation.type = 'polygon';
              annotation.points = [
                { x: annotation.startX, y: annotation.startY },
                { x: annotation.endX, y: annotation.endY },
              ];
            });
            redraw();
          }
        }} />
        <Separator />
      </Show>

      <Show when={isMeasureDistance()}>
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.calibrateFromLine')} onClick={() => {
          const a = ann();
          if (a) {
            const px = a.measurePixels || Math.sqrt(
              (a.endX - a.startX) ** 2 + (a.endY - a.startY) ** 2
            );
            // Set Scale with the line as the paper length, on the line's page.
            showCalibrationDialog(px, { pageNum: a.page || undefined });
          }
        }} />
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.setScale')} onClick={() => {
          const a = ann();
          if (a) showSetScaleDialog(a.page);
        }} />
        <Separator />
        {/* Maatketting verlengen of inkorten (#477): dimension-chain-tool.js. */}
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.dimChainAdd')} disabled={isLocked()} onClick={() => {
          const a = ann();
          if (a) {
            setTool('dimChainAdd');
            // Pas na het kiezen: het wisselen ruimt het vorige doel op, en een
            // geweigerde wissel (alleen-lezen PDF/A) laat geen doel achter.
            if (state.currentTool === 'dimChainAdd') state.dimChainTargetId = a.id;
          }
        }} />
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.dimChainRemove')} disabled={isLocked()} onClick={() => {
          const a = ann();
          if (a) {
            setTool('dimChainRemove');
            // Pas na het kiezen: het wisselen ruimt het vorige doel op, en een
            // geweigerde wissel (alleen-lezen PDF/A) laat geen doel achter.
            if (state.currentTool === 'dimChainRemove') state.dimChainTargetId = a.id;
          }
        }} />
        <Separator />
      </Show>

      {/* Ruimtetag: de ruimte zelf is met een klik niet te pakken (#477). */}
      <Show when={ann()?.type === 'parametricSymbol' && ann()?.symbolId === 'room-tag'}>
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.selectRoom')} shortcut="Tab" onClick={() => {
          const a = ann();
          if (a) selecteerRuimteVanTag(a);
        }} />
        <Separator />
      </Show>

      <Show when={isMeasureArea()}>
        <MenuItem icon={convertMeasurementIcon} label={t('annotation.addHole')} disabled={isLocked()} onClick={() => {
          const a = ann();
          if (a) {
            state.addHoleTargetId = a.id;
            state.addHolePoints = [];
            setTool('addHole');
          }
        }} />
        <Separator />
      </Show>

      <Submenu icon={openPopupIcon} label={t('annotation.popUpNote')}>
        <MenuItem icon={openPopupIcon} label={t('annotation.openPopUpNote')} onClick={() => {
          const a = ann();
          if (a) openStickyPopup(a);
        }} />
        <MenuItem icon={hidePopupIcon} label={t('annotation.hidePopUpNote')} onClick={() => {
          const a = ann();
          if (a) closeStickyPopup(a.id);
        }} />
        <MenuItem icon={resetPopupIcon} label={t('annotation.resetPopUpLocation')} onClick={() => {
          const a = ann();
          if (a) {
            commitAnnotationMutation(a, annotation => {
              annotation.popupX = undefined;
              annotation.popupY = undefined;
            });
            // Re-open if currently open
            closeStickyPopup(a.id);
            openStickyPopup(a);
          }
        }} />
      </Submenu>
      <Submenu icon={styleToolsIcon} label={t('annotation.styleTools')}>
        <MenuItem label={t('annotation.setAsDefaultStyle')} onClick={() => setAsDefaultStyle(ann())} />
        <MenuItem label={t('annotation.applyDefaultStyle')} onClick={() => {
          const a = ann();
          if (a) {
            commitAnnotationMutation(a, annotation => applyDefaultStyle(annotation));
            redraw();
          }
        }} />
      </Submenu>

      <Submenu icon={exportIcon} label={t('annotation.exportSubmenu')}>
        <MenuItem label={t('annotation.exportAsImage')} onClick={async () => {
          const a = ann();
          if (a) {
            const { exportAnnotationAsImage } = await import('../../pdf/exporter.js');
            await exportAnnotationAsImage(a);
          }
        }} />
      </Submenu>

      <Separator />

      <MenuItem icon={propertiesIcon} label={t('annotation.properties')} onClick={() => showProperties(ann())} />
    </>
  );
}

function MultiAnnotationMenuContent() {
  const { t } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');
  const count = () => multiSelectCount();
  // Lock and Check for the whole selection (the external editor): checked when all are.
  const selected = () => { count(); position(); return getActiveDocument()?.selectedAnnotations || []; };
  const allSelectedLocked = () => selected().length > 0 && selected().every(a => a.locked);
  const allSelectedChecked = () => selected().length > 0 && selected().every(isMarkupChecked);
  const toggleSelectionLock = () => {
    const targets = [...selected()];
    if (!targets.length) return;
    const lock = !targets.every(a => a.locked);
    const before = targets.map(cloneAnnotation);
    const now = new Date().toISOString();
    for (const a of targets) { a.locked = lock; a.modifiedAt = now; }
    recordBulkModify(targets, before);
    redraw();
  };
  // Hoek trimmen (#476): de geselecteerde wanden. count() en position()
  // (bij elke rechtsklik een nieuw object) maken dit reactief op elke nieuwe
  // multiselectie; de selectie zelf is geen signaal.
  const geselecteerdeWanden = () => {
    count(); position();
    return (getActiveDocument()?.selectedAnnotations || [])
      .filter(a => a?.type === 'wall' && !a.locked);
  };

  // the external editor order: clipboard, organise (layer, arrange, group), then the
  // wall-corner trim, and Properties last. The old flat align/distribute and
  // bring-all/send-all items live in Arrange ▸ (commands/arrange.js).
  return (
    <>
      <MenuItem icon={cutIcon} label={t('multiSelect.cutAnnotations', { count: count() })} onClick={() => {
        const _d = getActiveDocument();
        const _sel = _d ? expandCorrectionGroups(_d.annotations, _d.selectedAnnotations) : [];
        // Geen vergrendelde helft van een vervanging ongevraagd meenemen.
        if (_sel.some(a => a.locked && !_d.selectedAnnotations.includes(a))) return;
        copyAnnotations(_sel);
        deleteAnnotationsWithUndo(_d, _sel);
        clearSelection();
        hideProperties();
        redraw();
      }} />
      <MenuItem icon={copyIcon} label={t('multiSelect.copyAnnotations', { count: count() })} onClick={() => {
        const _d = getActiveDocument();
        copyAnnotations(_d ? _d.selectedAnnotations : []);
      }} />
      <MenuItem icon={pasteIcon} label={tCommon('paste')} shortcut="Ctrl+V" onClick={() => pasteFromClipboard()} />
      <MenuItem label={tCommon('copyToPages.menu')} onClick={() => {
        const ids = (getActiveDocument()?.selectedAnnotations || []).map((item) => item.id);
        if (ids.length) openDialog('copy-to-pages', { annotationIds: ids });
      }} />
      <MenuItem label={tCommon('assemblies.menu')} onClick={() => openDialog('assemblies')} />
      <MenuItem icon={deleteIcon} label={t('multiSelect.deleteAnnotations', { count: count() })} onClick={async () => {
        const confirmed = await showConfirm({
          title: t('multiSelect.deleteTitle'),
          message: t('multiSelect.deleteConfirm', { count: count() }),
          preferenceKey: 'confirmBeforeDelete'
        });
        if (confirmed) {
          const _d = getActiveDocument();
          deleteAnnotationsWithUndo(_d, _d ? [..._d.selectedAnnotations] : []);
          clearSelection();
          hideProperties();
          redraw();
        }
      }} />

      <Separator />

      <LayerSubmenu annotations={() => [...(getActiveDocument()?.selectedAnnotations || [])]} />
      <SubjectMenuItem annotations={() => [...(getActiveDocument()?.selectedAnnotations || [])]} />
      <ArrangeSubmenu count={count} run={(id) => runCommand(id)} />
      {/* the external editor: the right-clicked markup is the dominant one of the group. */}
      <CommandMenuItem id="edit.group" onClick={() => runCommand('edit.group', { dominant: targetAnnotation() })} />
      <CommandMenuItem id="edit.ungroup" />
      <Show when={targetMarkupGroup()}>
        <CommandMenuItem id="edit.removeFromGroup"
          onClick={() => runCommand('edit.removeFromGroup', { groupIds: [targetMarkupGroup()] })} />
        <CommandMenuItem id="edit.removeGroupNesting"
          onClick={() => runCommand('edit.removeGroupNesting', { groupId: targetMarkupGroup() })} />
      </Show>
      <MenuItem icon={flattenIcon} label={tCommon('flatten')} disabled={!isCommandEnabled('document.flatten')}
        onClick={() => runCommand('document.flatten', { selection: true })} />
      {/* A selected group goes into the Tool Chest as one tool (the external editor). */}
      <Show when={selectionIsOneGroup(selected(), getActiveDocument()?.annotations || [])}>
        <AddToToolChestSubmenu annotation={() => selected()[0] || null} />
      </Show>
      {/* Loose multi-selection, not already one group: still one tool. */}
      <Show when={selected().length >= 2 && !selectionIsOneGroup(selected(), getActiveDocument()?.annotations || [])}>
        <AddToToolChestSubmenu annotation={() => selected()[0] || null} selection={() => selected()} />
      </Show>
      <MenuItem icon={allSelectedLocked() ? lockedIcon : unlockedIcon} label={tCommon('stampEditor.lock')}
        checkbox={true} checked={allSelectedLocked()} onClick={toggleSelectionLock} />
      <MenuItem icon={lucide('circle-check')} label={tCommon('stampEditor.check')} checkbox={true}
        checked={allSelectedChecked()}
        onClick={() => runMarkupCheck([...(getActiveDocument()?.selectedAnnotations || [])])} />

      <Show when={geselecteerdeWanden().length >= 2}>
        <MenuItem label={t('multiSelect.trimWallCorners')} onClick={() => {
          const wanden = geselecteerdeWanden();
          const plan = hoekTrimPlan(wanden, wallHalfWidthPx);
          const geraakt = wanden.filter(w => plan.some(z => z.id === w.id));
          if (!geraakt.length) return;
          // Alles in één ongedaan-stap.
          const voor = geraakt.map(w => cloneAnnotation(w));
          const nu = new Date().toISOString();
          for (const w of geraakt) {
            pasTrimToe(w, plan);
            w.modifiedAt = nu;
          }
          recordBulkModify(geraakt, voor);
          redraw();
        }} />
      </Show>

      <Separator />

      <MenuItem icon={propertiesIcon} label={t('annotation.properties')} onClick={() => {
        const _d = getActiveDocument();
        if (_d?.selectedAnnotations?.length > 1) storeShowMultiSelection([..._d.selectedAnnotations]);
      }} />
    </>
  );
}

function PageMenuContent() {
  const { t } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');
  const isCurrentTool = (tool) => state.currentTool === tool;
  const revealInFolderIcon = lucide('folder-open');

  // Canvas menu (the external editor's is not documented; same spine as the markup menu):
  // clipboard, selection and view tools, add, navigate, find/print, and
  // Properties last.
  return (
    <>
      <MenuItem icon={pageCutIcon} label={tCommon('cut')} shortcut="Ctrl+X" disabled={true} />
      <MenuItem icon={pageCopyIcon} label={tCommon('copy')} shortcut="Ctrl+C" disabled={true} />
      <MenuItem icon={pagePasteIcon} label={tCommon('paste')} shortcut="Ctrl+V" onClick={() => pasteFromClipboard()} />
      <MenuItem icon={pagePasteIcon} label={tCommon('pasteInPlace')} shortcut="Ctrl+Shift+V" onClick={() => pasteAnnotationsInPlace()} />
      <MenuItem icon={pageDeleteIcon} label={tCommon('delete')} shortcut="Delete" disabled={true} />

      <Separator />

      <MenuItem icon={selectAllIcon} label={tCommon('select')} onClick={() => setTool('select')} />
      <MenuItem icon={deselectIcon} label={tCommon('deselect')} onClick={() => clearSelection()} />

      <Separator />

      <MenuItem icon={handToolIcon} label={t('page.handTool')} checkbox={true} checked={isCurrentTool('hand')} onClick={() => setTool('hand')} />
      {/* Text selection lives in the Select tool (text-layer.js enables it there). */}
      <MenuItem icon={selectTextPageIcon} label={t('page.selectText')} checkbox={true} checked={isCurrentTool('select')} onClick={() => setTool('select')} />
      <MenuItem icon={snapshotIcon} label={t('page.snapshotTool')} onClick={() => {
        import('../../tools/screenshot.js').then(m => m.startRegionScreenshot());
      }} />

      <Separator />

      <MenuItem icon={bookmarkIcon} label={t('page.addBookmark')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.addBookmark());
      }} />
      <MenuItem icon={stickyNoteIcon} label={t('page.addStickyNote')} onClick={() => setTool('comment')} />
      <MenuItem icon={imageIcon} label={t('page.addImage')} onClick={() => {
        import('../../annotations/image-drop.js').then(m => m.pickAndAddImage());
      }} />

      <Separator />

      <Submenu icon={goToIcon} label={t('page.goTo')}>
        <MenuItem label={t('page.firstPage')} onClick={() => {
          import('../../pdf/renderer.js').then(m => m.renderPage && m.renderPage(1));
        }} />
        <MenuItem label={t('page.lastPage')} onClick={() => {
          import('../../pdf/renderer.js').then(m => {
            const doc = getActiveDocument();
            if (doc?.pdfDoc && m.renderPage) m.renderPage(doc.pdfDoc.numPages);
          });
        }} />
        <MenuItem label={t('page.previousPage')} onClick={() => {
          import('../../pdf/renderer.js').then(m => {
            const doc = getActiveDocument();
            if (doc && doc.currentPage > 1 && m.renderPage) m.renderPage(doc.currentPage - 1);
          });
        }} />
        <MenuItem label={t('page.nextPage')} onClick={() => {
          import('../../pdf/renderer.js').then(m => {
            const doc = getActiveDocument();
            if (doc?.pdfDoc && doc.currentPage < doc.pdfDoc.numPages && m.renderPage) m.renderPage(doc.currentPage + 1);
          });
        }} />
      </Submenu>

      <Separator />

      <MenuItem icon={printIcon} label={t('page.printMenu')} shortcut="Ctrl+P" onClick={() => {
        import('../stores/dialogStore.js').then(m => m.openDialog('print'));
      }} />
      <MenuItem icon={findIcon} label={t('page.findMenu')} shortcut="Ctrl+F" onClick={() => {
        const findBar = document.getElementById('find-bar');
        const findInput = document.getElementById('find-input');
        if (findBar) { findBar.style.display = 'flex'; if (findInput) findInput.focus(); }
      }} />
      {/* Search: the Search panel (Alt+1), across the document; Find is the find bar. */}
      <CommandMenuItem id="window.panel.search" />

      <Separator />

      {/* Toon het geopende bestand in de bestandsbeheerder van het OS —
          alleen voor documenten met een echt bestandspad (dus niet voor
          naamloze/nieuwe documenten in een temp-bestand). */}
      <Show when={canRevealInFileManager(getActiveDocument())}>
        <MenuItem
          icon={revealInFolderIcon}
          label={t(revealInFileManagerLabelKey())}
          onClick={() => {
            const doc = getActiveDocument();
            if (doc?.filePath) revealInFileManager(doc.filePath);
          }} />
        <Separator />
      </Show>
      <MenuItem icon={propertiesIcon} label={t('page.propertiesMenu')} onClick={() => {
        import('../stores/dialogStore.js').then(m => m.openDialog('doc-properties'));
      }} />
    </>
  );
}

function BookmarkMenuContent() {
  const { t } = useTranslation('context');

  return (
    <>
      <MenuItem label={t('bookmark.addBookmark')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.addBookmark());
      }} />
      <MenuItem label={t('bookmark.addChildBookmark')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.addChildBookmark());
      }} />
      <Separator />
      <MenuItem label={t('bookmark.editBookmark')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.editBookmark());
      }} />
      <MenuItem label={t('bookmark.deleteBookmark')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.deleteBookmark());
      }} />
      <Separator />
      <MenuItem label={t('bookmark.expandAll')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.expandAll());
      }} />
      <MenuItem label={t('bookmark.collapseAll')} onClick={() => {
        import('../../ui/panels/bookmarks.js').then(m => m.collapseAll());
      }} />
    </>
  );
}

function ThumbnailMenuContent() {
  const { t } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');
  const pageNum = () => targetPage();

  const pages = () => getSelectedPagesArray();
  const count = () => pages().length;
  const isMulti = () => count() > 1;
  const numPages = () => state.documents[state.activeDocumentIndex]?.pdfDoc?.numPages || 1;
  // Build a reorderPages() permutation that swaps the target page with its
  // neighbour (dir -1 = up, +1 = down). Returns null at the ends.
  const swapOrder = (p, dir) => {
    const N = numPages();
    const a = p - 1, b = a + dir;
    if (b < 0 || b >= N) return null;
    const order = Array.from({ length: N }, (_, i) => i + 1);
    [order[a], order[b]] = [order[b], order[a]];
    return order;
  };
  const moveUpIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 13a.5.5 0 0 0 1 0V4.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L7.5 4.707V13z"/></svg>';
  const moveDownIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8.5 3a.5.5 0 0 0-1 0v8.293L4.354 8.146a.5.5 0 1 0-.708.708l4 4a.5.5 0 0 0 .708 0l4-4a.5.5 0 0 0-.708-.708L8.5 11.293V3z"/></svg>';

  const thumbnailCutIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5a2.5 2.5 0 1 1 3.164 2.414L8.5 7.25l1.336-2.336a2.5 2.5 0 1 1 1.414 0L9.914 7.25 13 12.5V14H3v-1.5L6.086 7.25 4.75 4.914A2.5 2.5 0 0 1 4 2.5zm2.5 1a1 1 0 1 0-2 0 1 1 0 0 0 2 0zm5 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0z"/></svg>';
  const thumbnailCopyIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6z"/><path d="M2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/></svg>';
  const thumbnailPasteIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10 1.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1zm-5 0A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5v1A1.5 1.5 0 0 1 9.5 4h-3A1.5 1.5 0 0 1 5 2.5v-1zm-2 0h1v1A2.5 2.5 0 0 0 6.5 5h3A2.5 2.5 0 0 0 12 2.5v-1h1a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3.5a2 2 0 0 1 2-2z"/></svg>';
  const thumbnailInsertIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 0h5.5L14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm5.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5H9.5V1z"/><path d="M8 6.5a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V11a.5.5 0 0 1-1 0V9.5H6a.5.5 0 0 1 0-1h1.5V7a.5.5 0 0 1 .5-.5z"/></svg>';
  const thumbnailExtractIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 0h5.5L14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm5.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5H9.5V1z"/><path d="M8 12a.5.5 0 0 0 .5-.5V8.207l1.146 1.147a.5.5 0 0 0 .708-.708l-2-2a.5.5 0 0 0-.708 0l-2 2a.5.5 0 1 0 .708.708L7.5 8.207V11.5a.5.5 0 0 0 .5.5z"/></svg>';
  const thumbnailReplaceIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 11.5a.5.5 0 0 0 .5.5h11.793l-3.147 3.146a.5.5 0 0 0 .708.708l4-4a.5.5 0 0 0 0-.708l-4-4a.5.5 0 0 0-.708.708L13.293 11H1.5a.5.5 0 0 0-.5.5zm14-7a.5.5 0 0 1-.5.5H2.707l3.147 3.146a.5.5 0 1 1-.708.708l-4-4a.5.5 0 0 1 0-.708l4-4a.5.5 0 1 1 .708.708L2.707 4H14.5a.5.5 0 0 1 .5.5z"/></svg>';
  const thumbnailDeleteIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1z"/></svg>';
  const thumbnailRotateLeftIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>';
  const thumbnailRotateRightIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';
  const thumbnailPropertiesIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/></svg>';
  const selectAllIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2zm10.03 4.97a.75.75 0 0 1 .011 1.05l-4.5 4.75a.75.75 0 0 1-1.072.014L4.22 8.53a.75.75 0 1 1 1.06-1.06l1.705 1.705L10.97 4.98a.75.75 0 0 1 1.06-.01z"/></svg>';

  return (
    <>
      <MenuItem icon={thumbnailCutIcon}
        label={isMulti() ? t('thumbnail.cutPages', { count: count() }) : tCommon('cut')}
        disabled={state.documents[state.activeDocumentIndex]?.pdfDoc?.numPages <= count()}
        onClick={async () => {
          const pm = await import('../../pdf/page-manager.js');
          if (isMulti()) {
            await pm.cutPages(pages());
          } else {
            await pm.cutPage(pages()[0]);
          }
        }} />
      <MenuItem icon={thumbnailCopyIcon}
        label={isMulti() ? t('thumbnail.copyPages', { count: count() }) : tCommon('copy')}
        onClick={async () => {
          const pm = await import('../../pdf/page-manager.js');
          if (isMulti()) {
            await pm.copyPages(pages());
          } else {
            await pm.copyPage(pages()[0]);
          }
        }} />
      <MenuItem icon={thumbnailPasteIcon} label={tCommon('paste')} onClick={async () => {
        const { pastePage } = await import('../../pdf/page-manager.js');
        await pastePage(pageNum());
      }} />

      <Separator />

      <MenuItem icon={thumbnailRotateLeftIcon}
        label={isMulti() ? t('thumbnail.rotateLeftPages', { count: count() }) : t('thumbnail.rotateLeft')}
        onClick={async () => {
          const { draaiPaginas } = await import('../../pdf/pagina-draaien.js');
          await draaiPaginas(-90, pages());
        }} />
      <MenuItem icon={thumbnailRotateRightIcon}
        label={isMulti() ? t('thumbnail.rotateRightPages', { count: count() }) : t('thumbnail.rotateRight')}
        onClick={async () => {
          const { draaiPaginas } = await import('../../pdf/pagina-draaien.js');
          await draaiPaginas(90, pages());
        }} />

      <Separator />

      <MenuItem icon={moveUpIcon}
        label={t('thumbnail.moveUp')}
        disabled={isMulti() || pageNum() <= 1}
        onClick={async () => {
          const { reorderPages } = await import('../../pdf/page-manager.js');
          const order = swapOrder(pageNum(), -1);
          if (order) await reorderPages(order);
        }} />
      <MenuItem icon={moveDownIcon}
        label={t('thumbnail.moveDown')}
        disabled={isMulti() || pageNum() >= numPages()}
        onClick={async () => {
          const { reorderPages } = await import('../../pdf/page-manager.js');
          const order = swapOrder(pageNum(), 1);
          if (order) await reorderPages(order);
        }} />

      <Separator />

      <MenuItem icon={thumbnailInsertIcon} label={t('thumbnail.insertPages')} onClick={() => {
        import('../../ui/chrome/dialogs.js').then(m => m.showInsertPageDialog());
      }} />
      <Submenu icon={thumbnailInsertIcon} label={t('thumbnail.insertFromFile')}>
        <MenuItem label={t('thumbnail.insertFromFileBefore')} onClick={async () => {
          const { insertPagesFromFile } = await import('../../pdf/page-manager.js');
          await insertPagesFromFile(pageNum(), 'before');
        }} />
        <MenuItem label={t('thumbnail.insertFromFileAfter')} onClick={async () => {
          const { insertPagesFromFile } = await import('../../pdf/page-manager.js');
          await insertPagesFromFile(pageNum(), 'after');
        }} />
      </Submenu>
      <MenuItem icon={thumbnailExtractIcon} label={t('thumbnail.extractPages')} onClick={() => {
        const rangeStr = formatPageRangeString(pages());
        import('../stores/dialogStore.js').then(m => m.openDialog('extract-pages', {
          totalPages: state.documents[state.activeDocumentIndex]?.pdfDoc?.numPages, currentPage: pageNum(), pageRange: rangeStr
        }));
      }} />
      <MenuItem icon={thumbnailReplaceIcon} label={t('thumbnail.replacePages')} disabled={isMulti()} onClick={async () => {
        const { replacePages } = await import('../../pdf/page-manager.js');
        replacePages(pageNum());
      }} />
      <MenuItem icon={thumbnailDeleteIcon}
        label={isMulti() ? t('thumbnail.deletePagesMulti', { count: count() }) : t('thumbnail.deletePages')}
        disabled={state.documents[state.activeDocumentIndex]?.pdfDoc?.numPages <= count()}
        onClick={() => {
          const rangeStr = formatPageRangeString(pages());
          import('../stores/dialogStore.js').then(m => m.openDialog('delete-pages', {
            totalPages: state.documents[state.activeDocumentIndex]?.pdfDoc?.numPages, currentPage: pageNum(), pageRange: rangeStr
          }));
        }} />

      <Separator />

      <MenuItem icon={selectAllIcon} label={t('thumbnail.selectAll')} onClick={() => selectAllPages()} />
      <MenuItem label={t('thumbnail.deselectAll')} onClick={() => clearPageSelection()} />

      <Separator />

      <MenuItem icon={thumbnailPropertiesIcon} label={t('thumbnail.properties')} disabled={isMulti()} onClick={() => {
        import('../stores/dialogStore.js').then(m => m.openDialog('page-properties', { pageNum: pageNum() }));
      }} />
    </>
  );
}

function TextSelectionMenuContent() {
  const { t } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');

  return (
    <>
      <MenuItem label={t('textSelection.curvedLeaderSelection')} onClick={() => {
        createCalloutFromSelection();
        clearTextSelection();
      }} />

      <Separator />

      <MenuItem icon={copyIcon} label={tCommon('copy')} onClick={async () => {
        const selectedText = getSelectedText();
        if (!selectedText) return;
        try {
          await navigator.clipboard.writeText(selectedText);
        } catch {
          const textarea = document.createElement('textarea');
          textarea.value = selectedText;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
      }} />

      <Separator />

      <MenuItem label={t('textSelection.highlightSelection')} onClick={() => {
        createTextMarkupAnnotation('textHighlight', '#FFFF00', 0.3);
        clearTextSelection();
      }} />
      <MenuItem label={t('textSelection.strikethroughSelection')} onClick={() => {
        createTextMarkupAnnotation('textStrikethrough', '#FF0000', 1.0);
        clearTextSelection();
      }} />
      <MenuItem label={t('textSelection.underlineSelection')} onClick={() => {
        createTextMarkupAnnotation('textUnderline', '#0000FF', 1.0);
        clearTextSelection();
      }} />

    </>
  );
}

// Properties toolbar doc ▾: the menu bar's Document menu (commands/menus.js),
// with its submenus and separators, so both list the same commands.
function MenuEntries(props) {
  const { t } = useTranslation('common');
  return (
    <For each={props.items}>{(raw) => {
      const item = menuItem(raw);
      if (item.kind === 'separator') return <Separator />;
      if (item.kind === 'submenu') {
        return (
          <Submenu label={t(item.label)} icon={getCommand(item.items.find((i) => typeof i === 'string' && i !== '-'))?.icon}>
            <MenuEntries items={item.items} />
          </Submenu>
        );
      }
      if (item.kind === 'command' && !item.args.length) return <CommandMenuItem id={item.command} />;
      return null;
    }}</For>
  );
}

function DocumentMenuContent() {
  return <MenuEntries items={MENUS.find((m) => m.id === 'document')?.items || []} />;
}

// Properties toolbar type ▾: style tools for the selected markup(s).
function MarkupStyleMenuContent() {
  const { t } = useTranslation('context');
  const { t: tProps } = useTranslation('properties');
  const selected = () => [...(getActiveDocument()?.selectedAnnotations || [])];
  // A single real markup (not the active tool's defaults).
  const single = () => {
    if (panelMode() !== 'annotation') return null;
    const a = getCurrentAnnotation();
    return a && a.id !== '__tool-defaults__' ? a : null;
  };
  const targets = () => (panelMode() === 'multi' ? selected() : (single() ? [single()] : []));
  return (
    <>
      <MenuItem label={t('annotation.setAsDefaultStyle')} disabled={!single()}
        onClick={() => setAsDefaultStyle(single())} />
      <MenuItem label={t('annotation.applyDefaultStyle')} disabled={targets().length === 0} onClick={() => {
        for (const a of targets()) commitAnnotationMutation(a, annotation => applyDefaultStyle(annotation));
        redraw();
      }} />
      <Separator />
      <MenuItem icon={copyIcon} label={tProps('stylePresets.copyStyle')} disabled={targets().length === 0}
        onClick={() => copyStyleFromSelection()} />
      <MenuItem icon={pasteIcon} label={tProps('stylePresets.pasteStyle')} disabled={targets().length === 0 || !copiedStyle()}
        onClick={() => pasteStyleToSelection()} />
      <AddToToolChestSubmenu annotation={single} />
      <Separator />
      <MenuItem icon={propertiesIcon} label={t('annotation.properties')} onClick={() => {
        if (single()) showProperties(single());
        else if (panelMode() === 'multi' && selected().length > 1) storeShowMultiSelection(selected());
      }} />
    </>
  );
}

// Right-click on a document tab (the external editor): Close / Close All / Close Others |
// Split Vertical / Split Horizontal / Switch (MultiView) / Detach |
// Show in folder | Properties.
function DocTabMenuContent() {
  const { t } = useTranslation('context');
  const index = () => targetTab();
  const doc = () => state.documents[index()];
  const items = () => docTabMenuItems({
    index: index(), count: state.documents.length, desktop: isTauri(),
    canReveal: canRevealInFileManager(doc()), split: isSplitView(),
  });
  const ICONS = {
    close: lucide('x'), splitVertical: lucide('columns-2'), splitHorizontal: lucide('rows-2'),
    switch: lucide('arrow-left-right'), detach: lucide('app-window'), showInFolder: lucide('folder-open'),
    properties: propertiesIcon,
  };
  const label = (id) => (id === 'showInFolder' ? t(revealInFileManagerLabelKey()) : t(`docTab.${id}`));
  const later = (id) => id === 'switch';
  return (
    <For each={items()}>
      {(item) => (item
        ? <MenuItem icon={ICONS[item.id]} label={label(item.id)} shortcut={item.shortcut}
            disabled={item.disabled} title={later(item.id) && item.disabled ? t('docTab.multiViewLater') : undefined}
            onClick={() => runDocTabAction(item.id, index())} />
        : <Separator />)}
    </For>
  );
}

// The ▾ at the right end of the tab strip: the open documents.
function DocListMenuContent() {
  const { t } = useTranslation('context');
  const { t: tStatus } = useTranslation('statusbar');
  return (
    <>
      <Show when={state.documents.length === 0 && !compareActive()}>
        <MenuItem label={t('docTab.noDocuments')} disabled={true} />
      </Show>
      <For each={state.documents}>
        {(doc, i) => (
          <MenuItem checkbox={true} checked={i() === state.activeDocumentIndex && !compareFocused()}
            icon={lucide('file-text')} label={tabLabel(doc)} title={doc.filePath || doc.fileName}
            onClick={() => switchToDocument(i())} />
        )}
      </For>
      <Show when={compareActive()}>
        <MenuItem checkbox={true} checked={compareFocused()} icon={lucide('columns-2')}
          label={tStatus('compareTabTitle') || 'Compare'} onClick={() => focusCompareTab()} />
      </Show>
    </>
  );
}

// Right-click on a panel tab (the external editor): Show ▸ (every panel), Hide, and
// Attach ▸ Left / Right / Bottom / Detach (float, not available yet). The
// access bar passes titleOf(id) for its own titles; otherwise the context
// namespace's panelTab.panels.<id>. The items run the access bars' actions
// (panels/panelActions.js), which also refresh the panel's list.
function PanelTabMenuContent() {
  const { t } = useTranslation('context');
  const panel = () => targetPanel();
  const title = (id) => panel()?.titleOf?.(id) || t(`panelTab.panels.${id}`);
  const host = () => (panel() ? getPanelHost(panel().id) : null);
  const HOST_LABEL = { left: 'panelTab.attachLeft', right: 'panelTab.attachRight', bottom: 'panelTab.attachBottom' };
  return (
    <>
      <Submenu icon={lucide('eye')} label={t('panelTab.show')}>
        <For each={PANEL_ORDER}>
          {(id) => (
            <MenuItem label={title(id)} checkbox={true} checked={!!getPanelHost(id)}
              onClick={() => (getPanelHost(id) ? hidePanelById(id) : activatePanel(id))} />
          )}
        </For>
      </Submenu>
      <MenuItem icon={lucide('eye-off')} label={t('panelTab.hide')} disabled={!host()}
        onClick={() => hidePanelById(panel().id)} />
      <Separator />
      <Submenu icon={lucide('panel-right')} label={t('panelTab.attach')} disabled={!panel()}>
        <For each={HOSTS}>
          {(h) => (
            <MenuItem label={t(HOST_LABEL[h])} checkbox={true} checked={host() === h}
              onClick={() => attachPanel(panel().id, h)} />
          )}
        </For>
        <Separator />
        <MenuItem label={t('panelTab.detach')} disabled={true} />
      </Submenu>
    </>
  );
}

export default function ContextMenu() {
  let menuRef;

  // Position the menu when it becomes visible
  createEffect(() => {
    if (visible()) {
      menuType();
      if (!menuRef?.contains(document.activeElement)) menuReturnFocus = document.activeElement;
      const pos = position();
      requestAnimationFrame(() => {
        if (!menuRef || !visible()) return;
        menuRef.style.left = `${pos.x}px`;
        menuRef.style.top = `${pos.y}px`;

        const rect = menuRef.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
          menuRef.style.left = `${Math.max(0, window.innerWidth - rect.width - 10)}px`;
        }
        if (rect.bottom > window.innerHeight) {
          menuRef.style.top = `${Math.max(0, window.innerHeight - rect.height - 10)}px`;
        }
        if (!menuRef.contains(document.activeElement)) {
          const first = menuRef.querySelector(':scope > .context-menu-item:not(.disabled)');
          if (first) first.focus();
          else menuRef.focus();
        }
      });
    }
  });

  // Dismiss when clicking outside the menu.
  // mousedown on document handles clicks on ribbon, panels, title bar, etc.
  // Canvas clicks are handled by the tool dispatcher (which calls hideMenu).
  function handleOutsideClick(e) {
    if (!visible()) return;
    if (menuRef && menuRef.contains(e.target)) return;
    hideMenu();
  }

  function handleMenuKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
      menuReturnFocus?.focus?.();
      return;
    }
    const item = e.target.closest?.('.context-menu-item');
    if (!item || !menuRef.contains(item)) return;
    const group = item.parentElement;
    if (e.key === 'ArrowRight' && item.classList.contains('context-menu-submenu')) {
      const first = item.querySelector(':scope > .context-menu-submenu-content > .context-menu-item:not(.disabled)');
      if (first) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'ArrowLeft' && group.classList.contains('context-menu-submenu-content')) {
      e.preventDefault();
      group.closest('.context-menu-submenu').focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const items = [...group.children].filter(child => child.classList.contains('context-menu-item') && !child.classList.contains('disabled'));
      if (!items.length) return;
      e.preventDefault();
      const index = items.indexOf(item);
      const target = e.key === 'Home' ? items[0] : e.key === 'End' ? items.at(-1)
        : items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      target?.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && item.classList.contains('context-menu-submenu')) {
      const first = item.querySelector(':scope > .context-menu-submenu-content > .context-menu-item:not(.disabled)');
      if (first) { e.preventDefault(); first.focus(); }
    }
  }

  function handleWindowBlur() {
    if (visible()) hideMenu();
  }

  onMount(() => {
    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('blur', handleWindowBlur);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleOutsideClick);
    window.removeEventListener('blur', handleWindowBlur);
  });

  return (
    <div
      ref={menuRef}
      class="context-menu"
      classList={{ visible: visible() }}
      role="menu"
      tabIndex={-1}
      onKeyDown={handleMenuKeyDown}
      onFocusOut={(e) => { if (!menuRef.contains(e.relatedTarget)) hideMenu(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Switch>
        <Match when={menuType() === 'annotation'}>
          <AnnotationMenuContent />
        </Match>
        <Match when={menuType() === 'annotationMulti'}>
          <MultiAnnotationMenuContent />
        </Match>
        <Match when={menuType() === 'page'}>
          <PageMenuContent />
        </Match>
        <Match when={menuType() === 'textSelection'}>
          <TextSelectionMenuContent />
        </Match>
        <Match when={menuType() === 'bookmark'}>
          <BookmarkMenuContent />
        </Match>
        <Match when={menuType() === 'thumbnail'}>
          <ThumbnailMenuContent />
        </Match>
        <Match when={menuType() === 'document'}>
          <DocumentMenuContent />
        </Match>
        <Match when={menuType() === 'markupStyle'}>
          <MarkupStyleMenuContent />
        </Match>
        <Match when={menuType() === 'docTab'}>
          <DocTabMenuContent />
        </Match>
        <Match when={menuType() === 'docList'}>
          <DocListMenuContent />
        </Match>
        <Match when={menuType() === 'panelTab'}>
          <PanelTabMenuContent />
        </Match>
      </Switch>
    </div>
  );
}

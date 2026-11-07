// Small, additive UI contributions. This module has no editor imports so the
// complete edition can be assembled before active.js is evaluated.
import { composePdfHooks, validatePdfContribution } from './pdf-hooks.js';
import { validateBoxTools } from './box-tools.js';
import { validateTours } from '../tour/tour-model.js';
import { validateWorkspaceContributions } from './contract.js';

const SLOTS = ['panels', 'fileCommands', 'fileMenuItems', 'toolbarItems', 'symbolCategories', 'symbolTemplates',
  'commands', 'workflows', 'profiles'];
const ALLOWED = new Set(['apiVersion', 'id', 'dialogs', 'pdf', 'listGrouping', 'boxTools', 'homeActions', 'launchActions', 'tours', 'documentTitle', 'authorName', 'undo', ...SLOTS]);
const CORE_PANELS = new Set([
  'thumbnails', 'sheets', 'bookmarks', 'layers', 'toolChest', 'links', 'measurements',
  'properties', 'formFields', 'signatures', 'attachments', 'search', 'tags', 'spaces',
  'quantities', 'markupsList', 'elementVisibility', 'annotationLayers',
]);
// Built-in bindings and command ids are reserved before main.js registers
// them. Keep this list in step with shortcut-table.js and solid/commands.
const CORE_SHORTCUTS = new Set(`V Shift+V L A R E C K Q T N P H S I W Shift+H Shift+F F G
  Shift+L Shift+C Shift+E Shift+N Shift+P M Shift+Alt+L Shift+Alt+Q Shift+Alt+A
  Shift+Alt+P Shift+Alt+V Shift+Alt+D Shift+Alt+U Shift+Alt+G Shift+Alt+C J
  Ctrl+G Ctrl+J Ctrl+Shift+G Ctrl+Shift+L Ctrl+Shift+C Shift+O O Ctrl+N Ctrl+O Ctrl+S
  Ctrl+Shift+S Ctrl+P Ctrl+W Ctrl+D Ctrl+Shift+M Ctrl+Shift+U Ctrl+Shift+P
  Ctrl+Z Delete Ctrl+A Ctrl+X Ctrl+C Ctrl+V Ctrl+Shift+V Escape Shift+Space
  Ctrl+Shift+H Ctrl+= Ctrl+- Ctrl+0 Ctrl+1 Ctrl+2 Ctrl+5 Ctrl+Shift++ Ctrl+Shift+_
  Ctrl+F F3 Ctrl+L F1 F4 F7 F8 F9 F10 F11 F12 Shift+F3 Ctrl+Shift+F8
  Ctrl+Shift+F7 Ctrl+Shift+F9 Shift+F9 Ctrl+4 Ctrl+6 Ctrl+7 Ctrl+3 Ctrl+F5
  Ctrl+Alt+2 Ctrl+H Ctrl+Shift+2 Alt+ArrowLeft Alt+ArrowRight Shift+F4 Ctrl+B
  Alt+X Alt+L Alt+T Alt+P Alt+U Alt+Y Alt+B Alt+N Alt+1 Alt+2 Alt+Q Alt+4
  Alt+S Ctrl+K Ctrl+, Alt+F4 Ctrl+Y Alt+O Alt+F Alt+E Alt+V Alt+D Alt+W Alt+H`
  .split(/\s+/).filter(Boolean).map((key) => key.toLowerCase()));
const CORE_COMMAND_IDS = new Set(`format.applyStyle format.applyStylePreset format.copyStyle
  format.pasteStyle format.resetLocation format.openProperties format.hideMarkup
  format.editSymbolType format.imageCrop format.imageGrayscale format.imageReset
  batch.slipSheet batch.summary tools.markup.fileAttachment tools.markup.attachPhoto
  tools.markup.viewPhotos document.properties document.insertPages document.deletePages
  document.extractPages document.reorderPages document.rotatePagesLeft
  document.rotatePagesRight document.crop document.pageSetup document.shiftPage
  document.straighten document.ocr document.reduceFileSize document.compare
  document.pageLabels document.addWatermark document.headerFooter
  document.manageWatermarks document.flatten document.unflatten batch.combine
  batch.link batch.linkRemove edit.lasso edit.offset edit.cycleSelection
  edit.selectionCycle edit.undoHistory edit.cut edit.copy edit.paste
  edit.pasteInPlace edit.duplicate edit.delete edit.move edit.pan edit.select
  edit.selectArea edit.selectAll edit.deselect edit.find edit.snapshot
  edit.screenshotPage edit.screenshotRegion edit.screenshotOverlay
  edit.vectorSnippet edit.vectorSnippetPaste edit.formatPainter edit.multiply
  edit.group edit.ungroup edit.removeFromGroup edit.removeGroupNesting
  edit.clearPage edit.clearAll edit.editText edit.addText edit.redact
  edit.applyRedactions file.new file.openRecent file.close file.closeAll
  file.import file.export file.exportRaster file.exportCad file.exportIfcReport
  file.email file.annotateScreenshot view.splitVertical view.splitHorizontal
  view.toggleSplit view.switchPane view.unsplit view.syncDocument view.syncPage
  oculith.about oculith.preferences oculith.keyboardShortcuts oculith.exit
  help.findCommands help.showTour help.showBasicsTour help.extensions help.fileAssociations help.startupDiagnostics
  file.open file.save file.saveAs file.print edit.undo edit.redo view.fitPage
  view.fitWidth view.zoomIn view.zoomOut batch.setLink document.bookmarksFromLabels
  tools.markup.image tools.markup.removeImage tools.measure.setScale tools.measure.detectScales tools.quantities
  tools.join tools.explode tools.stampEditor tools.parametricSymbol tools.reuse
  view.actualSize view.rotateLeft view.rotateRight view.firstPage view.previousPage
  view.nextPage view.lastPage view.goToSheet view.thinLines view.readerMode view.keystrokes
  view.menuBar tools.visualSearch window.leftPanel window.hidePanels
  window.autoHidePanelAccess window.fullScreen tools.lineStyles edit.addReply edit.reviewHistory
  edit.lockMarkup edit.markMarkup edit.printableMarkup edit.copyToPages tools.assemblies
  format.setDefaultStyle format.applyDefaultStyle tools.measure.convertToMeasurement
  edit.convertToPolyline edit.convertToPolygon tools.measure.calibrateFromLine edit.exportMarkupImage
  document.addBookmark document.replacePages document.insertFromFile tools.markup.highlightText
  tools.markup.strikeoutText tools.markup.underlineText`
  .split(/\s+/).filter(Boolean));
const CORE_DIALOG_IDS = new Set(`doc-properties preferences new-doc insert-page
  style-type-editor tekeninstellingen systeemtypen systeem-paneel-component
  delete-pages flatten page-properties extract-pages merge-pdfs print print-queue
  page-setup watermark header-footer manage-watermarks line-styles signature
  text-annotation update bookmark form-validation stamp-picker stamp-editor
  setScale scaleReview crop-margins straighten-page shift-page ocr-language resize-pages
  compress slipSheet message about shortcuts extensions confirm layer-selection handtekening-detail
  title-block-edit viewport-scale scale-region measured-length hyperlink
  capture-viewer page-labels batch-link multiply offset undoHistory compare
  cad-export cad-import annotation-layer-delete batch-summary batch-ops
  set-batch-link manage-tool-sets add-to-tool-chest assemblies copy-to-pages
  markup-name addon-tool-log`.split(/\s+/).filter(Boolean));

function unique(name, values) {
  const ids = new Set();
  for (const id of values) {
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error(`Invalid or duplicate ${name} id: ${String(id)}`);
    ids.add(id);
  }
  return ids;
}

function entries(name, values) {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
  return unique(name, values.map((value) => value?.id));
}

function shortcuts(addon) {
  const keys = [...(addon.panels || []).map((panel) => panel.shortcut),
    ...(addon.fileCommands || []).map((command) => command.shortcut),
    ...(addon.commands || []).map((command) => command.shortcut)];
  return unique('shortcut', keys.filter(Boolean).map((key) => {
    if (typeof key !== 'string') throw new Error('Shortcut must be a string');
    return key.replace(/\s+/g, '').toLowerCase();
  }));
}

export function validateAddon(addon, expectedId) {
  if (!addon || typeof addon !== 'object' || Array.isArray(addon)) throw new Error('Add-on must be an object');
  if (![1, 2].includes(addon.apiVersion) || typeof addon.id !== 'string' || !addon.id || addon.id !== expectedId) {
    throw new Error('Add-on API version or package id mismatch');
  }
  for (const field of Object.keys(addon)) {
    if (!ALLOWED.has(field)) throw new Error(`Unsupported add-on field: ${field}`);
  }
  if (addon.pdf != null) {
    if (addon.apiVersion !== 2) throw new Error('PDF hooks require add-on API version 2');
    validatePdfContribution(expectedId, addon.pdf);
  }
  if (addon.listGrouping != null) {
    if (addon.apiVersion !== 2 || !addon.listGrouping || typeof addon.listGrouping !== 'object'
        || Array.isArray(addon.listGrouping)
        || Object.keys(addon.listGrouping).some((key) => !['paths', 'select'].includes(key))
        || typeof addon.listGrouping.paths !== 'function'
        || typeof addon.listGrouping.select !== 'function') {
      throw new Error('List grouping requires add-on API version 2 and paths/select callbacks');
    }
  }
  if (addon.boxTools != null) {
    if (addon.apiVersion !== 2) throw new Error('boxTools require add-on API version 2');
    validateBoxTools(expectedId, addon.boxTools);
  }
  if (addon.homeActions != null) {
    if (addon.apiVersion !== 2 || !Array.isArray(addon.homeActions)) {
      throw new Error('Home actions require add-on API version 2 and an array');
    }
    entries('home action', addon.homeActions);
    if (addon.homeActions.some((action) => typeof action.label !== 'function'
        || typeof action.run !== 'function')) {
      throw new Error('Home actions need label and run callbacks');
    }
  }
  if (addon.launchActions != null) {
    if (addon.apiVersion !== 2 || !Array.isArray(addon.launchActions)) {
      throw new Error('Launch actions require add-on API version 2 and an array');
    }
    entries('launch action', addon.launchActions);
    if (addon.launchActions.some((action) => typeof action.label !== 'function'
        || typeof action.run !== 'function')) {
      throw new Error('Launch actions need label and run callbacks');
    }
  }
  if (addon.tours != null) {
    if (addon.apiVersion !== 2) throw new Error('Tours require add-on API version 2');
    validateTours(addon.tours, 'Add-on tours');
  }
  if (addon.documentTitle != null && (addon.apiVersion !== 2 || typeof addon.documentTitle !== 'function')) {
    throw new Error('Document title provider requires add-on API version 2 and a function');
  }
  if (addon.authorName != null && (addon.apiVersion !== 2 || typeof addon.authorName !== 'function')) {
    throw new Error('Author name provider requires add-on API version 2 and a function');
  }
  if (addon.undo != null && (addon.apiVersion !== 2 || !addon.undo
      || typeof addon.undo !== 'object' || Array.isArray(addon.undo)
      || Object.keys(addon.undo).some((key) => key !== 'restoreExtensionState')
      || typeof addon.undo.restoreExtensionState !== 'function')) {
    throw new Error('Undo contribution requires add-on API version 2 and a restoreExtensionState callback');
  }
  if (addon.dialogs != null && (typeof addon.dialogs !== 'object' || Array.isArray(addon.dialogs))) {
    throw new Error('dialogs must be an object');
  }
  for (const slot of SLOTS) if (addon[slot] != null && !Array.isArray(addon[slot])) {
    throw new Error(`${slot} must be an array`);
  }
  validateWorkspaceContributions(addon, 'Add-on');
  for (const slot of SLOTS.filter((name) => name !== 'fileMenuItems')) entries(slot, addon[slot] || []);
  unique('dialog', Object.keys(addon.dialogs || {}));
  for (const item of addon.fileMenuItems || []) {
    if (typeof item !== 'string' || !item) throw new Error('fileMenuItems must contain nonempty command ids');
  }
  shortcuts(addon);
  return addon;
}

// Each candidate is checked against the last accepted composition. A rejected
// package cannot leave a partially modified edition behind.
export function composeAddons(base, candidates, { reservedShortcuts = [], reservedTemplateIds = [] } = {}) {
  let edition = base;
  const accepted = [];
  const rejected = [];
  for (const { id, addon } of candidates) {
    try {
      if (accepted.includes(id)) throw new Error(`Duplicate add-on id: ${id}`);
      validateAddon(addon, id);
      for (const slot of SLOTS.filter((name) => name !== 'fileMenuItems')) {
        const used = entries(slot, edition[slot] || []);
        if (slot === 'panels') for (const builtIn of CORE_PANELS) used.add(builtIn);
        if (slot === 'fileCommands' || slot === 'commands') {
          for (const builtIn of CORE_COMMAND_IDS) used.add(builtIn);
          // File commands and other commands share one id space.
          for (const other of [...(edition.fileCommands || []), ...(edition.commands || []),
            ...(slot === 'commands' ? addon.fileCommands || [] : [])]) used.add(other.id);
        }
        if (slot === 'symbolTemplates') for (const builtIn of reservedTemplateIds) used.add(builtIn);
        for (const value of addon[slot] || []) {
          if (used.has(value.id)) throw new Error(`Duplicate ${slot} id: ${value.id}`);
        }
      }
      const dialogs = new Set([...CORE_DIALOG_IDS, ...Object.keys(edition.dialogs || {})]);
      for (const key of Object.keys(addon.dialogs || {})) {
        if (dialogs.has(key)) throw new Error(`Duplicate dialog id: ${key}`);
      }
      const menuCommands = new Set([...CORE_COMMAND_IDS,
        ...(edition.fileCommands || []).map((command) => command.id),
        ...(addon.fileCommands || []).map((command) => command.id)]);
      for (const item of addon.fileMenuItems || []) {
        if (item !== '-' && !menuCommands.has(item)) throw new Error(`Unknown file menu command: ${item}`);
      }
      const usedKeys = new Set([...CORE_SHORTCUTS, ...reservedShortcuts,
        ...(edition.panels || []).map((panel) => panel.shortcut),
        ...(edition.fileCommands || []).map((command) => command.shortcut),
        ...(edition.commands || []).map((command) => command.shortcut)]
        .filter(Boolean).map((key) => key.replace(/\s+/g, '').toLowerCase()));
      for (const key of shortcuts(addon)) if (usedKeys.has(key)) throw new Error(`Duplicate shortcut: ${key}`);
      const boxTools = addon.boxTools ? validateBoxTools(id, addon.boxTools) : [];
      const usedTools = new Set([...(edition.tools?.shapeToolIds || []), ...(edition.boxTools || []).map((tool) => tool.id)]);
      for (const tool of boxTools) if (usedTools.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
      const homeActions = edition.home?.actions || [];
      const launchActions = edition.launchActions || [];
      const previousTitle = edition.documentTitle;
      const usedHomeActions = new Set(homeActions.map((action) => action.id).filter(Boolean));
      for (const action of addon.homeActions || []) {
        if (usedHomeActions.has(action.id)) throw new Error(`Duplicate home action id: ${action.id}`);
      }
      const usedLaunchActions = new Set(launchActions.map((action) => action.id));
      for (const action of addon.launchActions || []) {
        if (usedLaunchActions.has(action.id)) throw new Error(`Duplicate launch action id: ${action.id}`);
      }
      const usedTours = new Set((edition.tours || []).map((tour) => tour.id));
      for (const tour of addon.tours || []) {
        if (usedTours.has(tour.id)) throw new Error(`Duplicate tour id: ${tour.id}`);
      }
      const previousUndo = edition.undo?.restoreExtensionState;
      edition = {
        ...edition,
        dialogs: { ...edition.dialogs, ...addon.dialogs },
        ...Object.fromEntries(SLOTS.map((slot) => [slot, [...(edition[slot] || []), ...(addon[slot] || [])]])),
        panelIds: [...(edition.panelIds || []), ...(addon.panels || []).map((panel) => panel.id)],
        pdf: addon.pdf ? composePdfHooks(edition.pdf, id, addon.pdf) : edition.pdf,
        listGroupings: addon.listGrouping
          ? [...(edition.listGroupings || []), { id, ...addon.listGrouping }]
          : (edition.listGroupings || []),
        boxTools: [...(edition.boxTools || []), ...boxTools],
        home: addon.homeActions?.length ? {
          title: edition.home?.title || (() => 'Start a drawing review'),
          description: edition.home?.description || (() => 'Open a plan set to place symbols, mark up details, and measure the work.'),
          actions: [...homeActions, ...addon.homeActions],
        } : edition.home,
        launchActions: [...launchActions, ...(addon.launchActions || [])],
        tours: [...(edition.tours || []), ...(addon.tours || [])],
        documentTitle: addon.documentTitle ? async (path) => {
          for (const provider of [previousTitle, addon.documentTitle]) {
            if (!provider) continue;
            try {
              const title = await provider(path);
              if (typeof title === 'string' && title.trim()) return title;
            } catch { /* A title provider cannot stop document opening or later providers. */ }
          }
          return '';
        } : edition.documentTitle,
        // A later provider owns the current author. Falling back to a stale
        // earlier provider after sign-out could reuse the previous identity.
        authorName: addon.authorName || edition.authorName,
        ...(addon.undo ? { undo: { restoreExtensionState(doc, extensionId, state, meta) {
          if (extensionId === id) return addon.undo.restoreExtensionState(doc, state, meta);
          return previousUndo?.(doc, extensionId, state, meta);
        } } } : {}),
      };
      accepted.push(id);
    } catch (error) {
      rejected.push({ id, error });
    }
  }
  return { edition, accepted, rejected };
}

export async function resolvePluginEntries(invoke) {
  try {
    const entries = await invoke('edition_plugins');
    if (Array.isArray(entries)) return entries;
  } catch { /* old native builds expose only edition_plugin */ }
  try {
    const legacy = await invoke('edition_plugin');
    return legacy ? [{ ...legacy, kind: 'edition', id: legacy.id || 'legacy' }] : [];
  } catch { return []; }
}

// The menu bar (external plan-review files menus, docs/WORKSPACE-SPEC.md §1.9 and §4.2):
// Data selected by edition, so tests load it without the app. Every entry names
// a command id from the registry; labels, icons, shortcuts, enabled and
// checked state come from the command.
//
// Item forms:
//   'file.open'                       a command
//   '-'                               a separator
//   { command, args?, label? }        a command run with args (label: an
//                                     i18n key that replaces the command's)
//   { command, pending }              a command a later package registers
//                                     (pending = fallback i18n label); shown
//                                     disabled until the id exists (none left;
//                                     the split views landed)
//   { submenu, icon?, items }         a submenu (submenu = i18n label key)
//   { submenu, dynamic, commands }    a submenu whose items MenuBar.jsx builds
//                                     at open time (DYNAMIC_MENUS); `commands`
//                                     lists the ids those items run
//   { placeholder }                   a disabled item for an external editor command we do
//                                     not have yet (Batch menu, spec §8)

import { edition } from '../../editions/active.js';
import { PROFILE_IDS } from '../stores/workspaceLayout.js';
import { WORKFLOWS, BUILTIN_WORKFLOWS } from './workflows.js';

export const SEP = '-';

const STYLE_GALLERY = [
  ['red', 'styleRed'], ['purple', 'stylePurple'], ['indigo', 'styleIndigo'], ['blue', 'styleBlue'],
  ['green', 'styleGreen'], ['yellow', 'styleYellow'], ['black', 'styleBlack'], ['red-cloudy', 'styleRedCloudy'],
  ['purple-cloudy', 'stylePurpleCloudy'], ['indigo-cloudy', 'styleIndigoCloudy'],
];

const PANELS = [
  'thumbnails', 'sheets', 'bookmarks', 'layers', 'toolChest', 'links', 'measurements', 'properties',
  'formFields', 'signatures', 'attachments', 'search', 'tags', 'quantities', 'markupsList',
  'elementVisibility', 'annotationLayers', 'spaces', ...edition.panelIds,
];

const BATCH_PENDING = [
  'cropPageSetup', 'rotate', 'split', 'headersFooters', 'security', 'signSeal', 'applyStamp',
];
// Batch > Link sits between Apply Stamp and Compare, as in the external editor.
const BATCH_PENDING_AFTER_LINK = [
  'compare', 'overlay', 'slipSheet', 'ocr', 'script', 'reduceFileSize', 'repair', 'flatten', 'summary', 'print',
];

// Batch entries that have a command now, in their the external editor position. The
// operations run on js/batch/runner.js (docs/BATCH-OPS.md); Slip Sheet is the
// Sets panel flow; Compare and Overlay are Document ▸ Compare, whose compare
// view runs set pairs in batch. Link is its own submenu (Batch Link, WP8).
const BATCH_LIVE = {
  summary: 'batch.summary',
  cropPageSetup: 'batch.cropPageSetup', rotate: 'batch.rotate', split: 'batch.split',
  headersFooters: 'batch.headersFooters', applyStamp: 'batch.applyStamp',
  compare: { command: 'document.compare', label: 'common:menu.batchPending.compare' },
  overlay: { command: 'document.compare', label: 'common:menu.batchPending.overlay' },
  slipSheet: 'batch.slipSheet', ocr: 'batch.ocr', reduceFileSize: 'batch.reduceFileSize',
  repair: 'batch.repair', flatten: 'batch.flatten', print: 'batch.print',
};

const sub = (key, items, extra = {}) => ({ submenu: `common:menu.${key}`, items, ...extra });

// View ▸ Workflow: one entry per workflow tab (workflows.js).
const WORKFLOW_ITEMS = WORKFLOWS.filter((wf) => !wf.contextual).map((wf) => `view.workflow.${wf.id}`);
// Tools ▸ <edition workflow>: an edition's workflow tab as a submenu, its
// groups between separators, so every command it brings is in a menu too.
const groupsAsItems = (wf) => wf.groups.flatMap((group, i) => (i ? [SEP, ...group.items] : group.items));
const EDITION_TOOL_MENUS = WORKFLOWS
  .filter((wf) => !wf.contextual && !BUILTIN_WORKFLOWS.some((b) => b.id === wf.id))
  .map((wf) => ({ submenu: wf.label, icon: wf.icon, items: groupsAsItems(wf) }));

export const MENUS = [
  {
    id: 'oculith', label: 'common:menu.oculith', mnemonic: 'O', items: [
      'oculith.about',
      SEP,
      'oculith.preferences',
      sub('profiles', PROFILE_IDS.map((id) => `oculith.profile.${id}`)),
      'oculith.keyboardShortcuts',
      SEP,
      'oculith.exit',
    ],
  },
  {
    id: 'file', label: 'common:menu.file', mnemonic: 'F', items: [
      'file.new', 'file.open', 'file.openRecent', 'batch.combine',
      SEP,
      'file.close', 'file.closeAll',
      SEP,
      'file.save', 'file.saveAs',
      SEP,
      'file.import',
      sub('export', ['file.export', 'file.exportRaster', 'file.exportCad', 'file.exportIfcReport']),
      'file.email', 'file.annotateScreenshot',
      SEP,
      'file.print',
      ...edition.fileMenuItems,
    ],
  },
  {
    id: 'edit', label: 'common:menu.edit', mnemonic: 'E', items: [
      'edit.undo', 'edit.redo', 'edit.undoHistory',
      SEP,
      'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteInPlace', 'edit.duplicate', 'edit.move', 'edit.multiply', 'edit.offset',
      SEP,
      'edit.delete', 'edit.clearPage', 'edit.clearAll',
      SEP,
      'edit.pan', 'edit.select', 'edit.selectArea', 'edit.lasso', 'edit.selectAll', 'edit.deselect',
      'edit.cycleSelection', 'edit.selectionCycle',
      SEP,
      'edit.snapshot',
      sub('screenshot', ['edit.screenshotPage', 'edit.screenshotRegion', 'edit.screenshotOverlay']),
      sub('vectorSnippet', ['edit.vectorSnippet', 'edit.vectorSnippetPaste']),
      'edit.formatPainter', 'edit.group', 'edit.ungroup', 'edit.removeFromGroup', 'edit.removeGroupNesting',
      // The markup context menu's actions on the selected markups.
      sub('markupActions', ['edit.addReply', 'edit.reviewHistory', SEP, 'edit.lockMarkup', 'edit.markMarkup',
        'edit.printableMarkup', SEP, 'edit.copyToPages', 'edit.convertToPolyline', 'edit.convertToPolygon',
        'edit.exportMarkupImage']),
      sub('arrange', [
        sub('align', ['arrange.alignLeft', 'arrange.alignCenter', 'arrange.alignRight', SEP,
          'arrange.alignTop', 'arrange.alignMiddle', 'arrange.alignBottom', SEP,
          'arrange.alignToSelection', 'arrange.alignToLast']),
        sub('distribute', ['arrange.distributeSpaceH', 'arrange.distributeSpaceV', SEP,
          'arrange.distributeLeft', 'arrange.distributeCenter', 'arrange.distributeRight', SEP,
          'arrange.distributeTop', 'arrange.distributeMiddle', 'arrange.distributeBottom']),
        sub('size', ['arrange.sameSize', 'arrange.sameWidth', 'arrange.sameHeight']),
        sub('rotate', ['arrange.rotateCcw', 'arrange.rotateCw', 'arrange.rotate180']),
        sub('flip', ['arrange.flipHorizontal', 'arrange.flipVertical']),
        sub('order', ['arrange.bringToFront', 'arrange.bringForward', 'arrange.sendBackward', 'arrange.sendToBack']),
      ]),
      sub('format', [
        sub('styles', STYLE_GALLERY.map(([name, key]) => ({ command: 'format.applyStyle', args: [name], label: `ribbon:format.${key}` }))),
        sub('stylePresets', [], { dynamic: 'stylePresets', commands: ['format.applyStylePreset'] }),
        'format.copyStyle', 'format.pasteStyle', 'format.setDefaultStyle', 'format.applyDefaultStyle',
        SEP,
        'format.resetLocation', 'format.hideMarkup', 'format.openProperties', 'format.editSymbolType',
      ]),
      sub('image', ['format.imageCrop', 'format.imageGrayscale', 'format.imageReset']),
      SEP,
      sub('pdfContent', ['edit.editText', 'edit.addText']),
      sub('redaction', ['edit.redact', 'edit.applyRedactions']),
      SEP,
      'edit.find',
    ],
  },
  {
    id: 'view', label: 'common:menu.view', mnemonic: 'V', items: [
      'view.fitPage', 'view.fitWidth', 'view.actualSize', 'view.zoomIn', 'view.zoomOut',
      SEP,
      'view.singlePage', 'view.continuous', 'view.sideBySide', 'view.continuousSideBySide',
      SEP,
      sub('rotateView', ['view.rotateLeft', 'view.rotateRight']),
      sub('goTo', ['view.goToSheet', SEP, 'view.firstPage', 'view.previousPage', 'view.nextPage', 'view.lastPage']),
      'view.previousView', 'view.nextView',
      SEP,
      // MultiView (WP5, docs/MULTIVIEW.md); the external editor order.
      'view.splitVertical', 'view.splitHorizontal', 'view.toggleSplit', 'view.switchPane', 'view.unsplit',
      'view.syncDocument', 'view.syncPage',
      SEP,
      'view.showGrid', 'view.snapToGrid', 'view.snapToContent', 'view.snapToMarkup',
      SEP,
      'view.darkMode', 'view.dimmer',
      sub('theme', ['view.themeDark', 'view.themeLight']),
      'view.thinLines', 'view.readerMode', 'view.keystrokes',
      SEP,
      sub('workflow', WORKFLOW_ITEMS),
      'tools.toolbar.standard', 'tools.toolbar.navigation', 'tools.toolbar.status', 'view.menuBar',
      // The right side toolbar repeats the workflow toolbar's markup and
      // measure tools; hidden by default in most profiles, shown from here.
      'tools.toolbar.markup', 'tools.toolbar.measure',
    ],
  },
  {
    id: 'document', label: 'common:menu.document', mnemonic: 'D', items: [
      'document.properties',
      SEP,
      'document.pageSetup',
      sub('rotatePages', ['document.rotatePagesLeft', 'document.rotatePagesRight']),
      'document.insertPages', 'document.insertFromFile', 'document.replacePages', 'document.extractPages',
      'document.deletePages', 'document.reorderPages', 'document.crop', 'document.shiftPage', 'document.straighten',
      SEP,
      'document.pageLabels', 'document.addBookmark',
      'document.headerFooter',
      sub('watermark', ['document.addWatermark', 'document.manageWatermarks']),
      SEP,
      'document.compare',
      SEP,
      'document.ocr', 'document.reduceFileSize',
      SEP,
      'document.flatten', 'document.unflatten',
    ],
  },
  {
    id: 'batch', label: 'common:menu.batch', mnemonic: 'B', items: [
      'batch.combine',
      SEP,
      ...BATCH_PENDING.map((key) => BATCH_LIVE[key] || { placeholder: `common:menu.batchPending.${key}` }),
      sub('batchLink', ['batch.link', 'batch.linkRemove', SEP, 'batch.setLink', 'document.bookmarksFromLabels']),
      ...BATCH_PENDING_AFTER_LINK.map((key) => BATCH_LIVE[key] || { placeholder: `common:menu.batchPending.${key}` }),
    ],
  },
  {
    id: 'tools', label: 'common:menu.tools', mnemonic: 'T', items: [
      sub('markup', [
        'tools.markup.textBox', 'tools.markup.typewriter', 'tools.markup.note', 'tools.markup.callout',
        'tools.markup.highlight', 'tools.markup.pen', 'tools.markup.eraser',
        SEP,
        'tools.markup.highlightText', 'tools.markup.strikeoutText', 'tools.markup.underlineText',
        SEP,
        'tools.markup.cloud', 'tools.markup.cloudPolyline', 'tools.markup.line', 'tools.markup.arrow',
        'tools.markup.curvedArrow', 'tools.markup.polyline', 'tools.markup.spline', 'tools.markup.rectangle',
        'tools.markup.ellipse', 'tools.markup.circle', 'tools.markup.polygon', 'tools.markup.arc',
        'tools.markup.lShape', 'tools.markup.filledArea',
        SEP,
        'tools.markup.flag', 'tools.markup.image', 'tools.markup.removeImage',
      ]),
      sub('stamp', ['tools.stamp', 'tools.stampEditor', 'tools.parametricSymbol']),
      sub('measure', [
        'tools.measure.calibrate', 'tools.measure.calibrateFromLine', 'tools.measure.setScale', 'tools.measure.detectScales',
        'tools.measure.addViewport',
        SEP,
        'tools.measure.length', 'tools.measure.polylength', 'tools.measure.area', 'tools.measure.perimeter',
        'tools.measure.angle', 'tools.measure.volume', 'tools.measure.arcLength', 'tools.measure.radius3',
        'tools.measure.radius', 'tools.measure.diameter', 'tools.measure.count',
        SEP,
        'tools.measure.dynamicFill', 'tools.measure.convertToMeasurement',
        SEP,
        'tools.quantities', 'tools.assemblies',
      ]),
      sub('raceway', ['tools.raceway.conduit', 'tools.raceway.cableTray']),
      ...EDITION_TOOL_MENUS,
      sub('sketchToScale', ['tools.trim', 'tools.extend', 'tools.split', 'tools.break', 'tools.lengthen',
        'tools.array', 'tools.join', 'tools.explode']),
      sub('form', ['window.panel.formFields']),
      sub('signature', ['tools.signature.place', 'window.panel.signatures']),
      SEP,
      'tools.markup.hyperlink', 'tools.markup.fileAttachment', 'tools.markup.attachPhoto', 'tools.markup.viewPhotos',
      'window.panel.attachments',
      'tools.visualSearch',
      SEP,
      sub('toolbars', ['tools.toolbar.properties', 'tools.toolbar.navigation', 'tools.toolbar.status', 'view.menuBar',
        SEP, 'tools.toolbar.standard', 'tools.toolbar.markup', 'tools.toolbar.measure']),
      SEP,
      'tools.reuse', 'tools.lineStyles',
    ],
  },
  {
    id: 'window', label: 'common:menu.window', mnemonic: 'W', items: [
      sub('panels', PANELS.map((id) => `window.panel.${id}`)),
      'window.leftPanel',
      SEP,
      'window.hidePanels', 'window.autoHidePanelAccess',
      SEP,
      'window.fullScreen',
    ],
  },
  {
    id: 'help', label: 'common:menu.help', mnemonic: 'H', items: [
      'help.findCommands',
      'help.showTour', 'help.showBasicsTour',
      SEP,
      'oculith.keyboardShortcuts',
      SEP,
      'help.extensions', 'help.fileAssociations', 'help.startupDiagnostics',
      SEP,
      'oculith.about',
    ],
  },
];

/** Normalised view of an item: { kind, ... }. */
export function menuItem(item) {
  if (item === SEP) return { kind: 'separator' };
  if (typeof item === 'string') return { kind: 'command', command: item, args: [] };
  if (item.submenu) return { kind: 'submenu', label: item.submenu, icon: item.icon || null, items: item.items || [], dynamic: item.dynamic || null, commands: item.commands || [] };
  if (item.placeholder) return { kind: 'placeholder', label: item.placeholder };
  return { kind: 'command', command: item.command, args: item.args || [], label: item.label || null, pending: item.pending || null };
}

/** Walk every item: visit(item, path) with path = labels of the menus above. */
export function walkMenus(visit, menus = MENUS) {
  const walk = (items, path) => {
    for (const raw of items) {
      const item = menuItem(raw);
      visit(item, path);
      if (item.kind === 'submenu') walk(item.items, [...path, item.label]);
    }
  };
  for (const menu of menus) walk(menu.items, [menu.label]);
}

/** Every command id a menu can run (static items and dynamic submenus). */
export function menuCommandIds(menus = MENUS) {
  const ids = new Set();
  walkMenus((item) => {
    if (item.kind === 'command') ids.add(item.command);
    if (item.kind === 'submenu') item.commands.forEach((id) => ids.add(id));
  }, menus);
  return ids;
}

/**
 * Label keys of the menus that hold a command, first occurrence:
 * 'document.extractPages' → ['common:menu.document']. null when absent.
 */
export function menuPathOf(commandId, menus = MENUS) {
  let found = null;
  walkMenus((item, path) => {
    if (!found && item.kind === 'command' && item.command === commandId && !item.args.length) found = path;
  }, menus);
  return found;
}

/** Index of the menu whose mnemonic is `letter` (case-insensitive), or -1. */
export function menuIndexForMnemonic(letter, menus = MENUS) {
  const up = String(letter || '').toUpperCase();
  return menus.findIndex((m) => m.mnemonic === up);
}

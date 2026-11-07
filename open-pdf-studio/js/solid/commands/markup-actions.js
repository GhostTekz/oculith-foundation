// The context-menu actions as commands, so the command palette (Ctrl+K) and
// Quick Access reach them too: markup replies, lock / marked / printable,
// copy to pages, default style, line conversions, export as image, page
// bookmarks and page replace / insert from file, and text-selection markups.
// Each acts on the current selection (markups, the text selection or the
// current page) and is disabled without it. The context menus keep their
// own items, which act on the markup or page they were opened on.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { activeDoc, currentPage, editable, hasPdf, modifySelection, redrawView, selection } from './util.js';
import { state } from '../../core/state.js';
import {
  addReplyIcon, reviewHistoryIcon, lockedIcon, markedIcon, printableIcon, convertMeasurementIcon,
  convertPolylineIcon, convertPolygonIcon, styleToolsIcon, exportIcon, bookmarkIcon,
} from '../data/contextMenuIcons.js';

const L = (key) => `common:commands.markupActions.${key}`;
const one = () => (selection().length === 1 ? selection()[0] : null);
const oneEditable = () => editable() && !!one() && !one().locked;
const someEditable = () => editable() && selection().length > 0;
const allOf = (test) => selection().length > 0 && selection().every(test);
const lineSelected = () => oneEditable() && ['line', 'arrow'].includes(one().type);

/** Open the Markups List on this markup's thread: a reply box, or its history. */
async function markupThread(a, mode) {
  if (!a) return;
  if (mode === 'history') (await import('../../ui/panels/properties-panel.js')).showProperties(a);
  await (await import('../../ui/panels/left-panel.js')).switchLeftPanelTab('annotations');
  const list = await import('../../ui/panels/annotations-list.js');
  if (mode === 'history') list.showMarkupThread(a.id);
  else list.startMarkupReply(a.id);
}

registerCommand({
  id: 'edit.addReply', label: L('addReply'), icon: addReplyIcon, category: 'edit',
  enabled: () => hasPdf() && !!one(), keywords: ['reply', 'comment', 'thread', 'markup'],
  run: () => markupThread(one(), 'reply'),
});
registerCommand({
  id: 'edit.reviewHistory', label: L('reviewHistory'), icon: reviewHistoryIcon, category: 'edit',
  enabled: () => hasPdf() && !!one(), keywords: ['status', 'history', 'thread', 'replies'],
  run: () => markupThread(one(), 'history'),
});

// Toggles over the whole selection, one undo step: on for all unless all are on.
function toggleOnSelection(id, key, icon, test, apply, keywords, extra = {}) {
  registerCommand({
    id, label: L(key), icon, category: 'edit', enabled: someEditable, checked: () => allOf(test), keywords,
    run: async () => {
      const on = !allOf(test);
      await modifySelection((a) => { apply(a, on); a.modifiedAt = new Date().toISOString(); });
      await redrawView();
    },
    ...extra,
  });
}
toggleOnSelection('edit.lockMarkup', 'lock', lockedIcon, (a) => !!a.locked, (a, on) => { a.locked = on; },
  ['lock', 'unlock', 'protect'], { shortcut: 'Ctrl+Shift+L' });
toggleOnSelection('edit.markMarkup', 'marked', markedIcon, (a) => !!a.marked, (a, on) => { a.marked = on; },
  ['marked', 'check', 'flag']);
toggleOnSelection('edit.printableMarkup', 'printable', printableIcon, (a) => a.printable !== false,
  (a, on) => { a.printable = on; }, ['print', 'printable', 'hide when printing']);

registerCommand({
  id: 'edit.copyToPages', label: L('copyToPages'), icon: lucide('copy-plus'), category: 'edit',
  enabled: someEditable, keywords: ['copy', 'pages', 'repeat', 'every page'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('copy-to-pages', {
    annotationIds: selection().map((a) => a.id) })),
});
registerCommand({
  id: 'tools.assemblies', label: 'common:assemblies.menu', icon: lucide('list-tree'), category: 'tools',
  enabled: hasPdf, keywords: ['assembly', 'parts', 'prices', 'cost', 'estimate'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('assemblies')),
});

// --- Style ---------------------------------------------------------------------------
registerCommand({
  id: 'format.setDefaultStyle', label: L('setDefaultStyle'), icon: styleToolsIcon, category: 'format',
  enabled: () => hasPdf() && !!one(), keywords: ['default', 'style', 'tool', 'remember'],
  run: () => import('../../core/preferences.js').then((m) => m.setAsDefaultStyle(one())),
});
registerCommand({
  id: 'format.applyDefaultStyle', label: L('applyDefaultStyle'), icon: styleToolsIcon, category: 'format',
  enabled: someEditable, keywords: ['default', 'style', 'reset'],
  run: async () => {
    const { applyDefaultStyle } = await import('../../core/preferences.js');
    await modifySelection((a) => applyDefaultStyle(a));
    await redrawView();
  },
});

// --- Lines: convert, calibrate --------------------------------------------------------
async function convertLine(type) {
  const a = one();
  if (!a) return;
  await modifySelection((ann) => {
    if (ann !== a) return;
    if (type !== 'measureDistance') ann.points = [{ x: ann.startX, y: ann.startY }, { x: ann.endX, y: ann.endY }];
    ann.type = type;
  });
  await redrawView();
}
registerCommand({
  id: 'tools.measure.convertToMeasurement', label: L('convertToMeasurement'), icon: convertMeasurementIcon,
  category: 'tools.measure', enabled: lineSelected, keywords: ['convert', 'line', 'length', 'dimension'],
  run: () => convertLine('measureDistance'),
});
registerCommand({
  id: 'edit.convertToPolyline', label: L('convertToPolyline'), icon: convertPolylineIcon, category: 'edit',
  enabled: lineSelected, keywords: ['convert', 'line', 'polyline'], run: () => convertLine('polyline'),
});
registerCommand({
  id: 'edit.convertToPolygon', label: L('convertToPolygon'), icon: convertPolygonIcon, category: 'edit',
  enabled: lineSelected, keywords: ['convert', 'line', 'polygon', 'shape'], run: () => convertLine('polygon'),
});
registerCommand({
  id: 'tools.measure.calibrateFromLine', label: L('calibrateFromLine'), icon: convertMeasurementIcon,
  category: 'tools.measure', enabled: () => editable() && one()?.type === 'measureDistance',
  keywords: ['calibrate', 'scale', 'known length', 'line'],
  run: async () => {
    const a = one();
    if (!a) return;
    const px = a.measurePixels || Math.hypot(a.endX - a.startX, a.endY - a.startY);
    (await import('../../annotations/measurement.js')).showCalibrationDialog(px, { pageNum: a.page || undefined });
  },
});
registerCommand({
  id: 'edit.exportMarkupImage', label: L('exportImage'), icon: exportIcon, category: 'edit',
  enabled: () => hasPdf() && !!one(), keywords: ['export', 'image', 'png', 'picture'],
  run: async () => {
    const a = one();
    if (a) await (await import('../../pdf/exporter.js')).exportAnnotationAsImage(a);
  },
});

// --- Pages -----------------------------------------------------------------------------
registerCommand({
  id: 'document.addBookmark', label: L('addBookmark'), icon: bookmarkIcon, category: 'document',
  enabled: editable, keywords: ['bookmark', 'outline', 'page'],
  run: () => import('../../ui/panels/bookmarks.js').then((m) => m.addBookmark()),
});
registerCommand({
  id: 'document.replacePages', label: L('replacePages'), icon: lucide('file-pen-line'), category: 'document',
  enabled: editable, keywords: ['replace', 'page', 'swap', 'revision'],
  run: () => import('../../pdf/page-manager.js').then((m) => m.replacePages(currentPage())),
});
registerCommand({
  id: 'document.insertFromFile', label: L('insertFromFile'), icon: lucide('file-plus'), category: 'document',
  enabled: editable, keywords: ['insert', 'pages', 'file', 'merge', 'append'],
  run: () => import('../../pdf/page-manager.js').then((m) => m.insertPagesFromFile(currentPage(), 'after')),
});

// --- Text selection ----------------------------------------------------------------------
const hasTextSelection = () => editable() && !!state.textSelection?.hasSelection && !!activeDoc();
const TEXT_MARKUPS = [
  ['highlightText', 'textHighlight', '#FFFF00', 0.3, lucide('highlighter'), ['highlight', 'text']],
  ['strikeoutText', 'textStrikethrough', '#FF0000', 1.0, lucide('minus'), ['strikethrough', 'strike out', 'text']],
  ['underlineText', 'textUnderline', '#0000FF', 1.0, lucide('underline'), ['underline', 'text']],
];
for (const [key, type, color, opacity, icon, keywords] of TEXT_MARKUPS) {
  registerCommand({
    id: `tools.markup.${key}`, label: L(key), icon, category: 'tools.markup', enabled: hasTextSelection, keywords,
    run: async () => {
      (await import('../../text/text-markup.js')).createTextMarkupAnnotation(type, color, opacity);
      (await import('../../text/text-selection.js')).clearTextSelection();
    },
  });
}

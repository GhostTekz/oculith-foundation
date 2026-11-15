// Edit menu commands (the external editor Edit menu, spec §1.9 and §4.2): clipboard,
// selection, Snapshot / screenshots, PDF Content, Redaction, Format Painter.
// edit.undo and edit.redo are seed commands in registry.js.

import { registerCommand } from './registry.js';
import { state } from '../../core/state.js';
import { lucide } from '../data/lucideIcons.js';
import {
  handIcon, selectCommentsIcon, selectTextIcon, selectAllIcon, deselectIcon, findIcon,
  cutIcon, copyAnnIcon, pasteIcon, pasteInPlaceIcon, deleteIcon, moveIcon,
  snapshotIcon, screenshotPageMenuIcon, screenshotRegionMenuIcon, formatPainterIcon, multiplyIcon,
  knipselIcon, knipselPlakIcon, editTextIcon, addTextIcon, redactionIcon, applyRedactionsIcon,
  clearPageIcon, clearAllIcon, collectionCreateIcon, collectionExplodeIcon,
} from '../data/ribbonIcons.js';
import { hasPdf, editable, activeDoc, selection, hasSelection, isTool, useTool, redrawView, ask } from './util.js';
import { lastCaptureAvailable } from '../stores/screenshotStore.js';

const C = 'edit';
const t = (key) => import('../../i18n/config.js').then((m) => m.default.t(key));
const deleteKey = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

async function copySelected() {
  const sel = selection();
  if (!sel.length) return;
  const m = await import('../../annotations/clipboard.js');
  if (sel.length > 1) m.copyAnnotations(sel);
  else m.copyAnnotation(sel[0]);
}

// Without selected markups, Cut and Copy take the select tool's region
// selection: that part of the drawing as a vector snippet. The page itself is
// not changed, so Cut copies too.
async function copyRegion() {
  const { hasRegionSelection } = await import('../../tools/region-selection.js');
  if (!hasRegionSelection()) return false;
  const { copyRegionSelection } = await import('../../annotations/region-clipboard.js');
  await copyRegionSelection();
  return true;
}

// --- Clipboard ---------------------------------------------------------------

registerCommand({
  id: 'edit.cut', label: 'common:commands.cut', icon: cutIcon, shortcut: 'Ctrl+X', category: C,
  enabled: editable, run: async () => {
    if (!hasSelection()) { await copyRegion(); return; }
    await copySelected();
    // Delete through the keyboard path so locks, groups and undo apply.
    deleteKey();
  },
});
registerCommand({
  id: 'edit.copy', label: 'common:commands.copy', icon: copyAnnIcon, shortcut: 'Ctrl+C', category: C,
  enabled: editable, run: async () => {
    if (!hasSelection()) { await copyRegion(); return; }
    await copySelected();
  },
});
registerCommand({
  // pasteAnnotations() falls back to pasteAnnotation() for a single item. A
  // region cut from a drawing pastes when it is the latest copy.
  id: 'edit.paste', label: 'common:commands.paste', icon: pasteIcon, shortcut: 'Ctrl+V', category: C,
  enabled: editable, run: async () => {
    const region = await import('../../annotations/region-clipboard.js');
    if (region.regionPasteIsLatest()) { await region.pasteRegion(); return; }
    (await import('../../annotations/clipboard.js')).pasteAnnotations();
  },
});
registerCommand({
  id: 'edit.pasteInPlace', label: 'common:commands.pasteInPlace', icon: pasteInPlaceIcon, shortcut: 'Ctrl+Shift+V',
  category: C, enabled: editable,
  run: () => import('../../annotations/clipboard.js').then((m) => m.pasteAnnotationsInPlace()),
});
registerCommand({
  id: 'edit.duplicate', label: 'common:commands.duplicate', icon: copyAnnIcon, category: C,
  enabled: editable, keywords: ['copy'],
  run: () => import('../../annotations/clipboard.js').then((m) => m.duplicateAnnotation()),
});
registerCommand({
  id: 'edit.delete', label: 'common:commands.delete', icon: deleteIcon, shortcut: 'Delete', category: C,
  enabled: editable, keywords: ['remove'], run: deleteKey,
});
registerCommand({
  // Same move session as the G key, started directly (a synthetic G would
  // start Snapshot when nothing is selected).
  id: 'edit.move', label: 'common:commands.move', icon: moveIcon, category: C,
  enabled: editable, run: () => import('../../tools/g-move-mode.js').then((m) => m.tryStartGMove()),
});

// --- Selection ---------------------------------------------------------------

registerCommand({
  id: 'edit.pan', label: 'common:commands.pan', icon: handIcon, shortcut: 'Shift+V', category: C,
  enabled: hasPdf, checked: () => isTool('hand'), keywords: ['hand'],
  run: () => useTool('hand'),
});
registerCommand({
  id: 'edit.select', label: 'common:commands.select', icon: selectCommentsIcon, shortcut: 'V', category: C,
  enabled: hasPdf, checked: () => isTool('select'),
  run: () => useTool('select'),
});
registerCommand({
  // Select, then arm the marquee: the next pointer-down anywhere on the
  // canvas starts a rubber-band selection, also on top of a markup.
  id: 'edit.selectArea', label: 'common:commands.selectArea', icon: selectTextIcon, category: C,
  enabled: hasPdf, keywords: ['marquee', 'rubber band', 'window'],
  run: async () => { await useTool('select'); state.armedMarquee = true; },
});
registerCommand({
  // selectAllOnPage/clearSelection only set state; without a redraw the
  // selection handles and the selection-dependent UI lag behind.
  id: 'edit.selectAll', label: 'common:commands.selectAll', icon: selectAllIcon, shortcut: 'Ctrl+A', category: C,
  enabled: hasPdf,
  run: async () => { (await import('../../core/stores/selection-helpers.js')).selectAllOnPage(); redrawView(); },
});
registerCommand({
  id: 'edit.deselect', label: 'common:commands.deselect', icon: deselectIcon, category: C,
  enabled: hasPdf, keywords: ['clear selection'],
  run: async () => { (await import('../../core/stores/selection-helpers.js')).clearSelection(); redrawView(); },
});
registerCommand({
  id: 'edit.find', label: 'common:commands.find', icon: findIcon, shortcut: 'Ctrl+F', category: C,
  enabled: hasPdf, keywords: ['search', 'replace', 'text'],
  run: () => import('../../search/find-bar.js').then((m) => m.openFindBar()),
});

// --- Snapshot, screenshots, vector snippet ------------------------------------

registerCommand({
  id: 'edit.snapshot', label: 'common:commands.snapshot', icon: snapshotIcon, shortcut: 'G', category: C,
  enabled: editable, checked: () => isTool('snapshot'), keywords: ['capture', 'image'],
  run: () => useTool('snapshot'),
});
registerCommand({
  id: 'edit.screenshotPage', label: 'common:commands.screenshotPage', icon: screenshotPageMenuIcon, category: C,
  enabled: hasPdf, keywords: ['capture', 'full page', 'clipboard'],
  run: () => import('../../tools/screenshot.js').then((m) => m.screenshotFullPage()),
});
registerCommand({
  id: 'edit.screenshotRegion', label: 'common:commands.screenshotRegion', icon: screenshotRegionMenuIcon, category: C,
  enabled: hasPdf, keywords: ['capture', 'area', 'clipboard'],
  run: () => import('../../tools/screenshot.js').then((m) => m.startRegionScreenshot()),
});
registerCommand({
  id: 'edit.screenshotOverlay', label: 'common:commands.screenshotOverlay', icon: lucide('image'), category: C,
  enabled: () => hasPdf() && lastCaptureAvailable(), keywords: ['capture', 'overlay', 'place'],
  run: () => import('../../tools/screenshot.js').then((m) => m.placeLastScreenshotAsOverlay()),
});
registerCommand({
  id: 'edit.vectorSnippet', label: 'common:commands.vectorSnippet', icon: knipselIcon, category: C,
  enabled: editable, checked: () => isTool('vectorSnippet'), keywords: ['cut', 'region', 'vector'],
  run: () => useTool('vectorSnippet'),
});
registerCommand({
  id: 'edit.vectorSnippetPaste', label: 'common:commands.vectorSnippetPaste', icon: knipselPlakIcon, category: C,
  enabled: editable, keywords: ['paste', 'vector'],
  run: async () => {
    const { plakKnipsel, heeftKnipsel } = await import('../../annotations/vector-snippet-clipboard.js');
    if (!heeftKnipsel()) {
      const { updateStatusMessage } = await import('../../ui/chrome/status-bar.js');
      updateStatusMessage(await t('vectorSnippet.clipboardEmpty'));
      return;
    }
    if (plakKnipsel({})) redrawView();
  },
});

// --- Markup editing -------------------------------------------------------------

registerCommand({
  id: 'edit.formatPainter', label: 'common:commands.formatPainter', icon: formatPainterIcon, shortcut: 'Ctrl+Shift+C',
  category: C, enabled: editable, checked: () => isTool('formatPainter'), keywords: ['style', 'copy style'],
  run: () => import('../../tools/tools/format-painter-tool.js').then((m) => m.startFormatPainter()),
});
registerCommand({
  id: 'edit.multiply', label: 'common:commands.multiply', icon: multiplyIcon, category: C,
  enabled: () => editable() && hasSelection(), keywords: ['array', 'copies', 'repeat'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('multiply')),
});
registerCommand({
  id: 'edit.group', label: 'common:commands.group', icon: collectionCreateIcon, shortcut: 'Ctrl+G', category: C,
  enabled: editable, keywords: ['collection', 'combine'],
  // args.dominant: the right-clicked markup is the dominant one (the external editor).
  run: (args) => import('../../annotations/segment-ops.js').then((m) => m.createCollection({ dominant: args?.dominant })),
});
registerCommand({
  id: 'edit.ungroup', label: 'common:commands.ungroup', icon: collectionExplodeIcon, shortcut: 'Ctrl+Shift+G', category: C,
  enabled: editable, keywords: ['collection', 'explode'],
  run: () => import('../../annotations/segment-ops.js').then((m) => m.explodeCollection()),
});
registerCommand({
  id: 'edit.removeFromGroup', label: 'common:commands.removeFromGroup', icon: collectionExplodeIcon, category: C,
  enabled: editable, keywords: ['group', 'member', 'extract'],
  run: (args) => import('../../annotations/segment-ops.js').then((m) => m.removeSelectionFromGroup(args || {})),
});
registerCommand({
  id: 'edit.removeGroupNesting', label: 'common:commands.removeGroupNesting', icon: collectionCreateIcon, category: C,
  enabled: editable, keywords: ['group', 'nested', 'flatten'],
  run: (args) => import('../../annotations/segment-ops.js').then((m) => m.flattenGroupNesting(args?.groupId)),
});
registerCommand({
  id: 'edit.clearPage', label: 'common:commands.clearPage', icon: clearPageIcon, category: C,
  enabled: editable, keywords: ['delete', 'markups', 'page'],
  run: async () => {
    const doc = activeDoc();
    if (!doc) return;
    if (!(await ask(await t('ribbon:comment.clearPageConfirm'), await t('ribbon:comment.clearPage')))) return;
    const page = doc.currentPage || 1;
    const [{ recordClearPage }, { clearSelection }, { hideProperties }] = await Promise.all([
      import('../../core/undo-manager.js'), import('../../core/stores/selection-helpers.js'),
      import('../../ui/panels/properties-panel.js'),
    ]);
    recordClearPage(page, doc.annotations || []);
    doc.annotations = doc.annotations.filter((a) => a.page !== page);
    clearSelection();
    hideProperties();
    redrawView();
  },
});
registerCommand({
  id: 'edit.clearAll', label: 'common:commands.clearAll', icon: clearAllIcon, category: C,
  enabled: editable, keywords: ['delete', 'markups', 'document'],
  run: async () => {
    const doc = activeDoc();
    if (!doc || doc.annotations.length === 0) return;
    if (!(await ask(await t('ribbon:comment.clearAllConfirm'), await t('ribbon:comment.clearAll')))) return;
    const [{ recordClearAll }, { clearSelection }, { hideProperties }] = await Promise.all([
      import('../../core/undo-manager.js'), import('../../core/stores/selection-helpers.js'),
      import('../../ui/panels/properties-panel.js'),
    ]);
    recordClearAll(doc.annotations);
    doc.annotations = [];
    clearSelection();
    hideProperties();
    redrawView();
  },
});

// --- PDF Content ▸ and Redaction ▸ --------------------------------------------------

registerCommand({
  id: 'edit.editText', label: 'common:commands.editText', icon: editTextIcon, category: C,
  enabled: editable, checked: () => isTool('editText'), keywords: ['pdf content', 'text'],
  run: () => useTool('editText'),
});
registerCommand({
  id: 'edit.addText', label: 'common:commands.addText', icon: addTextIcon, category: C,
  enabled: editable, checked: () => isTool('text'), keywords: ['pdf content', 'text'],
  run: () => useTool('text'),
});
registerCommand({
  id: 'edit.redact', label: 'common:commands.redact', icon: redactionIcon, category: C,
  enabled: editable, checked: () => isTool('redaction'), keywords: ['redaction', 'black out', 'mark'],
  run: () => useTool('redaction'),
});
registerCommand({
  id: 'edit.applyRedactions', label: 'common:commands.applyRedactions', icon: applyRedactionsIcon, category: C,
  enabled: editable, keywords: ['redaction', 'burn in'],
  run: () => import('../../annotations/redaction.js').then((m) => m.applyRedactions()),
});

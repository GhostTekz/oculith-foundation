// Document menu commands (the external editor Document menu, spec §1.9 and §4.2) and the
// Batch menu's Combine and Link. Page operations edit the document (undoable, saved);
// they need an editable PDF.

import { registerCommand } from './registry.js';
import { state } from '../../core/state.js';
import { lucide } from '../data/lucideIcons.js';
import {
  insertPageIcon, deletePageIcon, extractPagesIcon, reorderIcon, rotateLeftIcon, rotateRightIcon,
  cropMarginsIcon, resizePagesIcon, shiftPageIcon, straightenIcon, ocrIcon, compressIcon, compareIcon,
  watermarkIcon, headerFooterIcon, manageWatermarksIcon, mergePdfsIcon,
} from '../data/ribbonIcons.js';
import { hasPdf, editable, currentPage, pageCount, ask } from './util.js';
import { isTauri } from '../../core/platform.js';
import { compareActive, exitCompare } from '../../compare/compare-store.js';
import { revealPanel } from './window.js';
import { flattenIcon } from '../data/contextMenuIcons.js';

const C = 'document';
const openDialog = (name, data) => import('../stores/dialogStore.js').then((m) => m.openDialog(name, data));
const pages = () => ({ totalPages: pageCount(), currentPage: currentPage() });
const dialogs = () => import('../../ui/chrome/dialogs.js');
const watermarks = () => import('../../watermark/watermark-dialog.js');

registerCommand({
  id: 'document.properties', label: 'common:commands.documentProperties', icon: lucide('info'), shortcut: 'Ctrl+D',
  category: C, enabled: hasPdf, keywords: ['metadata', 'title', 'author', 'info'],
  run: () => dialogs().then((m) => m.showDocPropertiesDialog()),
});
registerCommand({
  id: 'document.insertPages', label: 'common:commands.insertPages', icon: insertPageIcon, category: C,
  enabled: editable, keywords: ['blank page', 'add page'],
  run: () => dialogs().then((m) => m.showInsertPageDialog()),
});
registerCommand({
  id: 'document.deletePages', label: 'common:commands.deletePages', icon: deletePageIcon, category: C,
  enabled: editable, keywords: ['remove page'],
  run: () => openDialog('delete-pages', pages()),
});
registerCommand({
  id: 'document.extractPages', label: 'common:commands.extractPages', icon: extractPagesIcon, category: C,
  enabled: editable, keywords: ['split', 'save pages'],
  run: () => dialogs().then((m) => m.showExtractPagesDialog()),
});
registerCommand({
  // Thumbnails, where pages are dragged into a new order.
  id: 'document.reorderPages', label: 'common:commands.reorderPages', icon: reorderIcon, category: C,
  enabled: hasPdf, keywords: ['move page', 'order', 'thumbnails'],
  run: () => revealPanel('thumbnails'),
});
// Rotate the selected thumbnails, or else the current page (#464).
registerCommand({
  id: 'document.rotatePagesLeft', label: 'common:commands.rotatePagesLeft', icon: rotateLeftIcon, shortcut: 'Ctrl+Shift+_',
  category: C, enabled: editable, keywords: ['rotate page', 'counterclockwise'],
  run: () => import('../../pdf/pagina-draaien.js').then((m) => m.draaiVanafKnop(-90)),
});
registerCommand({
  id: 'document.rotatePagesRight', label: 'common:commands.rotatePagesRight', icon: rotateRightIcon, shortcut: 'Ctrl+Shift++',
  category: C, enabled: editable, keywords: ['rotate page', 'clockwise'],
  run: () => import('../../pdf/pagina-draaien.js').then((m) => m.draaiVanafKnop(90)),
});
registerCommand({
  id: 'document.crop', label: 'common:commands.cropPages', icon: cropMarginsIcon, category: C,
  enabled: editable, keywords: ['margins', 'trim'],
  run: () => openDialog('crop-margins', pages()),
});
registerCommand({
  // the external editor "Page Setup": page size.
  id: 'document.pageSetup', label: 'common:commands.pageSetup', icon: resizePagesIcon, category: C,
  enabled: editable, keywords: ['resize', 'page size', 'paper'],
  run: () => openDialog('resize-pages', pages()),
});
registerCommand({
  id: 'document.shiftPage', label: 'common:commands.shiftPage', icon: shiftPageIcon, category: C,
  enabled: editable, keywords: ['offset', 'move content'],
  run: () => openDialog('shift-page', { totalPages: pageCount() || 1, currentPage: currentPage() }),
});
registerCommand({
  // the external editor "Deskew".
  id: 'document.straighten', label: 'common:commands.straighten', icon: straightenIcon, category: C,
  enabled: editable, keywords: ['deskew', 'skew', 'scan'],
  run: () => import('../../tools/straighten-select.js').then((m) => m.startStraightenPage()),
});
registerCommand({
  id: 'document.ocr', label: 'common:commands.ocr', icon: ocrIcon, category: C,
  enabled: () => editable() && isTauri(), keywords: ['recognize text', 'scan'],
  run: () => openDialog('ocr-language', { totalPages: pageCount() }),
});
registerCommand({
  // the external editor "Reduce File Size".
  id: 'document.reduceFileSize', label: 'common:commands.reduceFileSize', icon: compressIcon, category: C,
  enabled: () => hasPdf() && isTauri(), keywords: ['compress', 'optimize'],
  run: async () => {
    const { getCurrentDocumentSize } = await import('../../pdf/compress.js');
    openDialog('compress', { currentSize: getCurrentDocumentSize() });
  },
});
registerCommand({
  id: 'document.compare', label: 'common:commands.compareDocuments', icon: compareIcon, category: C,
  enabled: () => (state.documents?.length || 0) >= 2, checked: () => compareActive(),
  keywords: ['diff', 'revision', 'overlay'],
  run: () => (compareActive() ? exitCompare() : openDialog('compare', {})),
});
registerCommand({
  // the external editor "Page Labels" (and Create from Page Region): /PageLabels in the PDF.
  id: 'document.pageLabels', label: 'common:commands.pageLabels', icon: lucide('tag'), category: C,
  enabled: editable, keywords: ['sheet number', 'label', 'title block', 'page region', 'numbering'],
  run: () => openDialog('page-labels', {}),
});
registerCommand({
  id: 'document.addWatermark', label: 'common:commands.addWatermark', icon: watermarkIcon, category: C,
  enabled: editable, keywords: ['stamp', 'draft', 'confidential'],
  run: () => watermarks().then((m) => m.showWatermarkDialog()),
});
registerCommand({
  id: 'document.headerFooter', label: 'common:commands.headerFooter', icon: headerFooterIcon, category: C,
  enabled: editable, keywords: ['page numbers', 'header', 'footer'],
  run: () => watermarks().then((m) => m.showHeaderFooterDialog()),
});
registerCommand({
  id: 'document.manageWatermarks', label: 'common:commands.manageWatermarks', icon: manageWatermarksIcon, category: C,
  enabled: editable, keywords: ['watermark', 'remove'],
  run: () => watermarks().then((m) => m.showManageWatermarksDialog()),
});

// the external editor "Flatten" / "Unflatten" (docs/reference/editor/markup-tools.md). `{ selection: true }`
// (the Markups List and markup context menus) opens the dialog on the
// selected markups.
registerCommand({
  id: 'document.flatten', label: 'common:flattenMarkups.command', icon: flattenIcon, shortcut: 'Ctrl+Shift+M',
  category: C, enabled: editable, keywords: ['flatten', 'burn', 'markups', 'merge markups', 'issue'],
  run: async (opts = {}) => {
    const { flattenTypeSummary } = await import('../../pdf/flatten-document.js');
    const doc = state.documents[state.activeDocumentIndex];
    const selected = (doc?.selectedAnnotations?.length ? doc.selectedAnnotations
      : doc?.selectedAnnotation ? [doc.selectedAnnotation] : []).map((a) => a.id);
    return openDialog('flatten', { ...pages(), types: flattenTypeSummary(doc), selectedIds: selected,
      selection: !!opts?.selection });
  },
});
registerCommand({
  id: 'document.unflatten', label: 'common:flattenMarkups.unflattenCommand', icon: lucide('layers'), shortcut: 'Ctrl+Shift+U',
  category: C, enabled: editable, keywords: ['unflatten', 'restore markups', 'recover'],
  run: async () => {
    const [{ unflattenDocument }, i18n, { showMessage }] = await Promise.all([
      import('../../pdf/flatten-document.js'), import('../../i18n/config.js'), import('../stores/dialogStore.js')]);
    try {
      const result = await unflattenDocument();
      if (result.reason) showMessage(i18n.default.t(`flattenMarkups.unflatten_${result.reason}`, { ns: 'common' }));
      return result;
    } catch (e) {
      console.warn('[unflatten] failed:', e);
      showMessage(i18n.default.t('flattenMarkups.failed', { ns: 'common' }));
      return null;
    }
  },
});

// --- Batch -----------------------------------------------------------------------

registerCommand({
  // the external editor "Combine".
  id: 'batch.combine', label: 'common:commands.combine', icon: mergePdfsIcon, category: 'batch',
  enabled: editable, keywords: ['merge', 'join', 'append'],
  run: () => dialogs().then((m) => m.showMergePdfsDialog()),
});
registerCommand({
  // the external editor "Batch Link": hyperlinks from sheet references to the labelled pages.
  id: 'batch.link', label: 'common:commands.batchLink', icon: lucide('link'), category: 'batch',
  enabled: editable, keywords: ['hyperlink', 'sheet reference', 'callout', 'page label', 'automatic links'],
  run: () => openDialog('batch-link', {}),
});
registerCommand({
  id: 'batch.linkRemove', label: 'common:commands.batchLinkRemove', icon: lucide('unlink'), category: 'batch',
  enabled: editable, keywords: ['hyperlink', 'delete links', 'batch link'],
  run: async () => {
    const [{ documentBatchLinks, removeDocumentBatchLinks }, { default: i18n }, { updateStatusMessage }] = await Promise.all([
      import('../../pdf/batch-link-app.js'), import('../../i18n/config.js'), import('../../ui/chrome/status-bar.js'),
    ]);
    const found = (await documentBatchLinks()).length;
    if (!found) { updateStatusMessage(i18n.t('dialogs:batchLink.noneToRemove')); return 0; }
    if (!(await ask(i18n.t('dialogs:batchLink.confirmRemove', { count: found }), i18n.t('common:commands.batchLinkRemove')))) return 0;
    const removed = await removeDocumentBatchLinks();
    updateStatusMessage(i18n.t('dialogs:batchLink.removed', { count: removed }));
    return removed;
  },
});

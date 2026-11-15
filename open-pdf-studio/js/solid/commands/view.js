// View menu commands (the external editor View menu, spec §1.9): zoom, page display, rotate
// view, go to page, grid and snaps, theme, display toggles, menu bar.
// view.fitPage, view.fitWidth, view.zoomIn and view.zoomOut are seed
// commands in registry.js.

import { registerCommand } from './registry.js';
import { OPEN_GO_TO_SHEET } from './go-to-sheet.js';
import { state } from '../../core/state.js';
import { lucide } from '../data/lucideIcons.js';
import {
  actualSizeIcon, singlePageIcon, continuousIcon, bookViewIcon, facingPagesIcon,
  rotateLeftIcon, rotateRightIcon, firstPageIcon, prevPageIcon, nextPageIcon, lastPageIcon,
  thinLinesIcon, readerModeIcon, keystrokesIcon,
} from '../data/ribbonIcons.js';
import { hasPdf, activeDoc, currentPage, pageCount, lazyModule } from './util.js';
import { pageStepTarget } from '../../pdf/page-step.js';
import { readerTrackingPath } from '../../core/reader-mode-tracking.js';
import { isSnapToggleOn, toggleSnapPreference } from '../../tools/snap-toggles.js';
import { currentTheme } from '../stores/ribbonStore.js';
import { isToolbarVisible, setToolbarVisible } from '../stores/workspaceLayout.js';

const C = 'view';
const renderer = () => import('../../pdf/renderer.js');
// Previous / Next Page (also PageUp / PageDown, held down): every step builds
// on the one before it, so quick repeats are not lost (page-step.js).
const stepPage = (delta) => {
  const target = pageStepTarget(activeDoc(), delta);
  return target == null ? undefined : renderer().then((m) => m.goToPage(target));
};
const keystrokes = lazyModule(() => import('../components/KeystrokeOverlay.jsx'));

registerCommand({
  id: 'view.actualSize', label: 'common:commands.actualSize', icon: actualSizeIcon, shortcut: 'Ctrl+0', category: C,
  enabled: hasPdf, keywords: ['100%', 'zoom'],
  run: () => renderer().then((m) => m.actualSize()),
});

// --- Page display ------------------------------------------------------------
// the external editor names: Single Page, Continuous, Side-by-Side (two pages, paged =
// our "facing") and Continuous Side-by-Side (our "book" spread grid).

const viewMode = () => activeDoc()?.viewMode || 'single';
const PAGE_MODES = [
  ['view.singlePage', 'singlePage', singlePageIcon, 'Ctrl+4', 'single',
    () => viewMode() === 'single'],
  ['view.continuous', 'continuous', continuousIcon, null, 'continuous',
    () => viewMode() === 'continuous' && !activeDoc()?.bookSpread && !activeDoc()?.facingSpread],
  ['view.sideBySide', 'sideBySide', facingPagesIcon, 'Ctrl+6', 'facing',
    () => viewMode() === 'continuous' && !!activeDoc()?.facingSpread],
  ['view.continuousSideBySide', 'continuousSideBySide', bookViewIcon, 'Ctrl+7', 'book',
    () => viewMode() === 'continuous' && !!activeDoc()?.bookSpread && !activeDoc()?.facingSpread],
];
for (const [id, key, icon, shortcut, mode, checked] of PAGE_MODES) {
  registerCommand({
    id, label: `common:commands.${key}`, icon, shortcut, category: C, enabled: hasPdf, checked,
    keywords: ['page display', 'layout', mode],
    run: () => renderer().then((m) => m.setViewMode(mode)),
  });
}

// Rotate View: only the view turns, the document does not (no edit, so also
// on a read-only PDF/A document). Rotating the pages is Document > Rotate.
registerCommand({
  id: 'view.rotateLeft', label: 'common:commands.rotateViewLeft', icon: rotateLeftIcon, category: C,
  enabled: hasPdf, keywords: ['rotate view', 'counterclockwise'],
  run: () => import('../../pdf/weergave-draaien.js').then((m) => m.draaiWeergave(-90)),
});
registerCommand({
  id: 'view.rotateRight', label: 'common:commands.rotateViewRight', icon: rotateRightIcon, category: C,
  enabled: hasPdf, keywords: ['rotate view', 'clockwise'],
  run: () => import('../../pdf/weergave-draaien.js').then((m) => m.draaiWeergave(90)),
});

// --- Go To ▸ -------------------------------------------------------------------

registerCommand({
  id: 'view.firstPage', label: 'common:commands.firstPage', icon: firstPageIcon, category: C,
  enabled: () => hasPdf() && currentPage() > 1,
  run: () => renderer().then((m) => m.goToPage(1)),
});
registerCommand({
  id: 'view.previousPage', label: 'common:commands.previousPage', icon: prevPageIcon, category: C,
  shortcut: 'PageUp',
  enabled: () => hasPdf() && currentPage() > 1,
  run: () => stepPage(-1),
});
registerCommand({
  id: 'view.nextPage', label: 'common:commands.nextPage', icon: nextPageIcon, category: C,
  shortcut: 'PageDown',
  enabled: () => hasPdf() && currentPage() < pageCount(),
  run: () => stepPage(1),
});
registerCommand({
  id: 'view.lastPage', label: 'common:commands.lastPage', icon: lastPageIcon, category: C,
  enabled: () => hasPdf() && currentPage() < pageCount(),
  run: () => renderer().then((m) => m.goToPage(pageCount())),
});

registerCommand({
  // Ctrl+J ("jump"); Ctrl+G stays Group (shortcut-table.js).
  id: 'view.goToSheet', label: 'common:commands.goToSheet', icon: lucide('file-search'), shortcut: 'Ctrl+J', category: C,
  enabled: hasPdf, keywords: ['sheet', 'sheet number', 'page label', 'jump', 'go to', 'drawing'],
  // GoToSheet.jsx listens for this event (no import cycle with the UI).
  run: () => window.dispatchEvent(new CustomEvent(OPEN_GO_TO_SHEET)),
});

// --- Grid and snaps (same toggles as the status bar, tools/snap-toggles.js) ---

for (const [id, toggle, key, shortcut, icon] of [
  ['view.showGrid', 'showGrid', 'showGrid', 'Shift+F9', lucide('grid-2x2')],
  ['view.snapToGrid', 'grid', 'snapToGrid', 'Ctrl+Shift+F9', lucide('layout-grid')],
  ['view.snapToContent', 'content', 'snapToContent', 'Ctrl+Shift+F8', lucide('magnet')],
  ['view.snapToMarkup', 'markup', 'snapToMarkup', 'Ctrl+Shift+F7', lucide('locate')],
]) {
  registerCommand({
    id, label: `common:commands.${key}`, icon, shortcut, category: C, keywords: ['snap', 'grid'],
    checked: () => isSnapToggleOn(state.preferences, toggle),
    run: () => toggleSnapPreference(toggle),
  });
}

// --- Display -------------------------------------------------------------------

registerCommand({
  // the external editor "Disable Line Weights".
  id: 'view.thinLines', label: 'common:commands.thinLines', icon: thinLinesIcon, shortcut: 'Ctrl+5', category: C,
  enabled: hasPdf, checked: () => !!state.preferences?.thinLines, keywords: ['line weights', 'thin'],
  run: async () => {
    state.preferences.thinLines = !state.preferences.thinLines;
    const doc = activeDoc();
    const m = await renderer();
    if (doc?.viewMode === 'continuous') m.renderContinuous();
    else if (doc) m.renderPage(doc.currentPage);
    const r = await import('../../annotations/rendering.js');
    r.redrawAnnotations();
  },
});
registerCommand({
  // Per document: remembers this PDF's page, scroll position and zoom in a
  // sidecar file next to it (written on, removed off). Needs a file of its
  // own and a finished load.
  id: 'view.readerMode', label: 'common:commands.readerMode', icon: readerModeIcon, category: C,
  enabled: () => hasPdf() && !!readerTrackingPath(activeDoc()) && !activeDoc()?._isLoading,
  checked: () => !!activeDoc()?.readerModeActive, keywords: ['remember position', 'resume'],
  run: async () => {
    const doc = activeDoc();
    if (!doc) return;
    const { setReaderTracking } = await import('../../pdf/reader-mode-view.js');
    if (!(await setReaderTracking(doc, !doc.readerModeActive))) {
      const [{ showMessage }, { default: i18next }] = await Promise.all([
        import('../stores/dialogStore.js'), import('../../i18n/config.js'),
      ]);
      showMessage(i18next.t('ribbon:view.readerModeSaveFailed'));
    }
  },
});
registerCommand({
  id: 'view.keystrokes', label: 'common:commands.keystrokes', icon: keystrokesIcon, category: C,
  checked: () => !!keystrokes()?.keystrokeOverlayVisible(), keywords: ['presentation', 'keys', 'overlay'],
  run: () => import('../components/KeystrokeOverlay.jsx').then((m) => m.toggleKeystrokeOverlay()),
});

// --- Theme ▸ (Oculith dark is the default; light is the other Oculith theme) --

for (const [id, value, key, icon] of [
  ['view.themeDark', 'default', 'themeDark', lucide('moon')],
  ['view.themeLight', 'light', 'themeLight', lucide('sun')],
]) {
  registerCommand({
    id, label: `common:commands.${key}`, icon, category: C, keywords: ['theme', 'appearance', 'colour'],
    checked: () => currentTheme() === value,
    run: async () => {
      const m = await import('../../core/preferences.js');
      state.preferences.theme = value;
      m.applyTheme(value);
      m.savePreferences();
    },
  });
}

// --- Menu bar (F9, the external editor) -------------------------------------------------------

registerCommand({
  id: 'view.menuBar', label: 'common:commands.menuBar', icon: null, shortcut: 'F9', category: C,
  checked: () => isToolbarVisible('menu'), keywords: ['menu', 'toolbar', 'hide'],
  run: () => setToolbarVisible('menu', !isToolbarVisible('menu')),
});

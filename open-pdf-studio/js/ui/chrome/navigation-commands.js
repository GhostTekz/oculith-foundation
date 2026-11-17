// Commands of the Navigation bar and status bar work package: Previous /
// Next View, the content Dimmer and Dark Mode. They go into the command
// registry so the View menu and the command palette list them; a command
// another module already registered under the same id is left alone. Showing
// the Navigation bar (F4) and status bar (F8) are the Tools ▸ Toolbars
// commands tools.toolbar.navigation / tools.toolbar.status (commands/tools.js).
//
// The keys go through tools/shortcut-table.js and keyboard-handlers.js (F4,
// F8, Ctrl+3, Ctrl+F5). installNavigationKeys() still binds F4, Alt+Left /
// Alt+Right and Ctrl+3 on window in the bubble phase as a fallback; it skips
// any event a handler before it already handled (defaultPrevented), so a key
// the keyboard handler ran does not fire twice. Alt+Left / Alt+Right are
// bound only here.

import { getCommand, registerCommand } from '../../solid/commands/registry.js';
import { isToolbarVisible, setToolbarVisible } from '../../solid/stores/workspaceLayout.js';
import { goBackView, goForwardView, canGoBackView, canGoForwardView } from '../../core/view-history.js';
import { isDimmerOn, toggleDimmer, isDarkContentOn, toggleDarkContent } from '../../solid/stores/contentDisplay.js';
import { state } from '../../core/state.js';
import { lucide } from '../../solid/data/lucideIcons.js';
import { shouldHandleGlobalKey } from './global-key-guard.js';

export const toggleNavigationBar = () => setToolbarVisible('navigation', !isToolbarVisible('navigation'));
export const toggleStatusBar = () => setToolbarVisible('status', !isToolbarVisible('status'));

const hasPdf = () => !!state.documents?.[state.activeDocumentIndex]?.pdfDoc;

export const NAVIGATION_COMMANDS = [
  {
    id: 'view.previousView', label: 'statusbar:navbar.previousView', icon: lucide('circle-arrow-left'),
    shortcut: 'Alt+Left', category: 'view', enabled: () => canGoBackView(), keywords: ['back', 'history'],
    run: () => goBackView(),
  },
  {
    id: 'view.nextView', label: 'statusbar:navbar.nextView', icon: lucide('circle-arrow-right'),
    shortcut: 'Alt+Right', category: 'view', enabled: () => canGoForwardView(), keywords: ['forward', 'history'],
    run: () => goForwardView(),
  },
  {
    id: 'view.dimmer', label: 'statusbar:navbar.dimmer', icon: lucide('sun'),
    shortcut: 'Ctrl+F5', category: 'view', enabled: hasPdf, checked: isDimmerOn, keywords: ['fade', 'dim'],
    run: () => toggleDimmer(),
  },
  {
    id: 'view.darkMode', label: 'statusbar:navbar.darkMode', icon: lucide('sun-moon'),
    shortcut: 'Ctrl+3', category: 'view', enabled: hasPdf, checked: isDarkContentOn, keywords: ['invert', 'night'],
    run: () => toggleDarkContent(),
  },
];

for (const def of NAVIGATION_COMMANDS) {
  if (!getCommand(def.id)) registerCommand(def);
}

/** The command id a keydown event maps to here, or null (pure). */
export function navigationKeyCommand(e) {
  if (!e || e.metaKey) return null;
  const ctrl = !!e.ctrlKey;
  const shift = !!e.shiftKey;
  const alt = !!e.altKey;
  if (e.key === 'F4' && !ctrl && !shift && !alt) return 'tools.toolbar.navigation';
  if (alt && !ctrl && !shift && e.key === 'ArrowLeft') return 'view.previousView';
  if (alt && !ctrl && !shift && e.key === 'ArrowRight') return 'view.nextView';
  if (ctrl && !shift && !alt && (e.key === '3' || e.code === 'Digit3')) return 'view.darkMode';
  return null;
}

function isTextEntry(target) {
  return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''));
}

function onKeydown(e) {
  if (e.defaultPrevented || isTextEntry(e.target) || !shouldHandleGlobalKey(e)) return;
  const id = navigationKeyCommand(e);
  if (!id) return;
  e.preventDefault();
  const cmd = getCommand(id);
  if (cmd) { if (!cmd.enabled || cmd.enabled()) cmd.run(); }
  else if (id === 'tools.toolbar.navigation') toggleNavigationBar();
}

/** Bind F4, Alt+Left/Right and Ctrl+3 (idempotent). */
export function installNavigationKeys() {
  if (typeof window === 'undefined' || window.__ocuNavigationKeys) return;
  window.__ocuNavigationKeys = true;
  window.addEventListener('keydown', onKeydown);
}

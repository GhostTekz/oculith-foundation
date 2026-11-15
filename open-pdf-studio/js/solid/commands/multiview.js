// MultiView commands (View menu, Navigation bar, tab menu, status bar Sync):
// docs/reference/editor/workspace.md. the external editor keys: Ctrl+H Split Horizontal, Ctrl+Shift+2
// Unsplit. the external editor's Ctrl+2 stays Fit Page here, so Split Vertical is
// Ctrl+Alt+2 (shortcut-table.js).

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { hasPdf, activeDoc } from './util.js';
import {
  isSplitView, splitOrientation, syncState, splitView, unsplitView, toggleSplitOrientation,
  setSync, moveTabToPane, activePaneIndex, passivePaneIndex,
} from '../stores/multiViewStore.js';

const C = 'view';

registerCommand({
  id: 'view.splitVertical', label: 'common:commands.splitVertical', icon: lucide('columns-2'),
  shortcut: 'Ctrl+Alt+2', category: C, keywords: ['multiview', 'split screen', 'side by side'],
  enabled: hasPdf, checked: () => splitOrientation() === 'vertical',
  run: () => splitView('vertical'),
});

registerCommand({
  id: 'view.splitHorizontal', label: 'common:commands.splitHorizontal', icon: lucide('rows-2'),
  shortcut: 'Ctrl+H', category: C, keywords: ['multiview', 'split screen'],
  enabled: hasPdf, checked: () => splitOrientation() === 'horizontal',
  run: () => splitView('horizontal'),
});

registerCommand({
  id: 'view.toggleSplit', label: 'common:commands.toggleSplit', icon: lucide('rotate-cw'),
  shortcut: null, category: C, keywords: ['multiview', 'orientation'],
  enabled: isSplitView,
  run: () => toggleSplitOrientation(),
});

registerCommand({
  id: 'view.switchPane', label: 'common:commands.switchPane', icon: lucide('arrow-left-right'),
  shortcut: null, category: C, keywords: ['multiview', 'move to other pane', 'split'],
  enabled: () => isSplitView() && !!activeDoc(),
  run: () => moveTabToPane(activeDoc().id, activePaneIndex(), passivePaneIndex()),
});

registerCommand({
  id: 'view.unsplit', label: 'common:commands.unsplit', icon: lucide('square'),
  shortcut: 'Ctrl+Shift+2', category: C, keywords: ['multiview', 'single view'],
  enabled: isSplitView,
  run: () => unsplitView(),
});

// the external editor View > Synchronize Document / Synchronize Page. Choosing the mode that
// is on turns Sync off; the status bar Sync button keeps the mode.
const syncToggle = (mode) => () => {
  const s = syncState();
  return setSync(s.enabled && s.mode === mode ? { enabled: false } : { enabled: true, mode });
};

registerCommand({
  id: 'view.syncDocument', label: 'common:commands.syncDocument', icon: lucide('refresh-cw'),
  shortcut: null, category: C, keywords: ['sync', 'multiview', 'page index'],
  enabled: isSplitView, checked: () => syncState().enabled && syncState().mode === 'document',
  run: syncToggle('document'),
});

registerCommand({
  id: 'view.syncPage', label: 'common:commands.syncPage', icon: lucide('refresh-ccw'),
  shortcut: null, category: C, keywords: ['sync', 'multiview', 'page offset'],
  enabled: isSplitView, checked: () => syncState().enabled && syncState().mode === 'page',
  run: syncToggle('page'),
});

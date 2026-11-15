// Oculith menu (≙ the external editor menu, spec §1.9) and Help menu commands.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { aboutIcon, shortcutsIcon, updatesIcon, fileAssocIcon, preferencesIcon, extensionsIcon } from '../data/ribbonIcons.js';
import { isTauri } from '../../core/platform.js';
import { PROFILE_IDS, BUILTIN_PROFILE_IDS, activeProfile, profileLabelKey } from '../stores/workspaceLayout.js';
import { applyWorkspaceProfile } from '../stores/workspaceProfiles.js';

/** Event that opens the command palette (Help > Find Tools + Commands). */
export const OPEN_COMMAND_PALETTE = 'ocudraw:open-command-palette';

const openDialog = (name, data) => import('../stores/dialogStore.js').then((m) => m.openDialog(name, data));

// --- Oculith ---------------------------------------------------------------

registerCommand({
  id: 'oculith.about', label: 'common:commands.about', icon: aboutIcon, category: 'oculith',
  keywords: ['version', 'license', 'credits'],
  run: () => openDialog('about'),
});
registerCommand({
  // Ctrl+, (Ctrl+K opens the command palette, shortcut-table.js).
  id: 'oculith.preferences', label: 'common:commands.preferences', icon: preferencesIcon, shortcut: 'Ctrl+,',
  category: 'oculith', keywords: ['settings', 'options', 'theme', 'language'],
  run: () => import('../../core/preferences.js').then((m) => m.showPreferencesDialog()),
});
for (const profile of PROFILE_IDS) {
  registerCommand({
    id: `oculith.profile.${profile}`, icon: null, category: 'oculith',
    // An edition's profile names its own label.
    label: BUILTIN_PROFILE_IDS.includes(profile) ? `common:commands.profiles.${profile}` : profileLabelKey(profile),
    keywords: ['profile', 'workspace', 'layout'],
    checked: () => activeProfile() === profile,
    // Resets the panel layout to the profile (and keeps the ribbon tab in step).
    run: () => applyWorkspaceProfile(profile),
  });
}
registerCommand({
  id: 'oculith.keyboardShortcuts', label: 'common:commands.keyboardShortcuts', icon: shortcutsIcon, shortcut: 'F1',
  category: 'oculith', keywords: ['keys', 'hotkeys', 'help'],
  run: () => openDialog('shortcuts'),
});
registerCommand({
  id: 'oculith.exit', label: 'common:commands.exit', icon: lucide('log-out'), shortcut: 'Alt+F4', category: 'oculith',
  keywords: ['quit', 'close'],
  run: async () => {
    const [{ hasUnsavedChanges, getUnsavedDocumentNames }, { closeWindow }, { default: i18next }, { persistAllReaderPositions }] = await Promise.all([
      import('../../ui/chrome/tabs.js'), import('../../core/platform.js'),
      import('../../i18n/config.js'), import('../../pdf/reader-mode-view.js'),
    ]);
    if (hasUnsavedChanges()) {
      const message = i18next.t('dialogs:unsavedChanges.message', { names: getUnsavedDocumentNames().join(', ') });
      const title = i18next.t('dialogs:unsavedChanges.title');
      const ok = window.__TAURI__?.dialog?.ask
        ? await window.__TAURI__.dialog.ask(message, { title, kind: 'warning' })
        : confirm(message);
      if (!ok) return;
    }
    // closeWindow() destroys the window without a close-requested event, so
    // the per-tab close that saves Reader Mode positions never runs.
    await persistAllReaderPositions();
    closeWindow();
  },
});

// --- Help ------------------------------------------------------------------

registerCommand({
  id: 'help.findCommands', label: 'common:commands.findCommands', icon: lucide('command'), shortcut: 'Ctrl+K',
  category: 'help', keywords: ['search', 'palette', 'command', 'tools', 'go to', 'page', 'sheet'],
  // CommandPalette.jsx listens for this event (no import cycle with the UI).
  run: () => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE)),
});
registerCommand({
  id: 'help.showTour', label: 'common:commands.showTour', icon: lucide('book-open'), category: 'help',
  keywords: ['tour', 'guide', 'getting started', 'help', 'introduction'],
  run: () => import('../../tour/tours.js').then((m) => m.startTour(m.primaryTourId())),
});
registerCommand({
  id: 'help.showBasicsTour', label: 'common:commands.showBasicsTour', icon: lucide('book-open'), category: 'help',
  keywords: ['tour', 'guide', 'basics', 'getting started'],
  run: () => import('../../tour/tours.js').then((m) => m.startTour('foundation.basics')),
});
registerCommand({
  id: 'help.extensions', label: 'common:commands.extensions', icon: extensionsIcon, category: 'help',
  enabled: () => isTauri(), keywords: ['plugins', 'add-ons'],
  run: () => openDialog('extensions'),
});
registerCommand({
  // Settings ▸ General ▸ AI link (MCP) opens the same panel.
  id: 'help.aiConnections', label: 'common:commands.aiConnections', icon: lucide('cable'), category: 'help',
  enabled: () => isTauri(),
  keywords: ['ai', 'mcp', 'assistant', 'claude', 'copilot', 'vs code', 'cursor', 'codex', 'opencode', 'openai', 'link'],
  run: () => openDialog('ai-connections'),
});
registerCommand({
  id: 'help.fileAssociations', label: 'common:commands.fileAssociations', icon: fileAssocIcon, category: 'help',
  enabled: () => isTauri(), keywords: ['default', 'pdf', 'application'],
  run: () => import('../../core/preferences.js').then((m) => m.showPreferencesDialog('fileassoc')),
});
registerCommand({
  id: 'help.startupDiagnostics', label: 'common:commands.startupDiagnostics', icon: updatesIcon, category: 'help',
  enabled: () => isTauri(), keywords: ['log', 'diagnostics', 'support'],
  run: async () => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    const path = await invoke('startup_diagnostics_path');
    await invoke('reveal_in_file_manager', { path });
  },
});

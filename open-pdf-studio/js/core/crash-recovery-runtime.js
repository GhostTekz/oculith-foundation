// Crash recovery in the running app (the model is crash-recovery.js).
//
// - After start: if the page came back after its web process ended (the
//   native shell reloads it, src-tauri/src/webview_recovery.rs), or the
//   crash-recovery file holds unsaved markups from a run that did not close
//   normally, the user is asked whether to restore them. The drawings are
//   opened again and their markups put back, marked as unsaved.
// - While running: every few seconds, when the open drawings changed, the
//   unsaved markups are written to the crash-recovery file; with nothing
//   unsaved the file is removed.

import i18next from '../i18n/config.js';
import { isTauri, invoke } from './platform.js';
import { state, findDocumentByPath } from './state.js';
import { undoStackOf } from './undo-stacks.js';
import { applyRecoveredMarkups, parseRecovery, recoverySignature, recoverySnapshot } from './crash-recovery.js';

export const AUTOSAVE_INTERVAL_MS = 5000;
// With unsaved changes, write at least this often even when the fingerprint
// did not move (a property edit that left no history step).
const AUTOSAVE_FORCE_MS = 60000;

function diagnostic(phase) {
  try { void invoke('startup_diagnostic', { phase, detail: null })?.catch?.(() => {}); } catch { /* never throws */ }
}

/** How the page's last web process ended, once; null when it did not (or outside the desktop app). */
export async function takeWebviewTermination() {
  if (!isTauri()) return null;
  try { return (await invoke('webview_termination_notice')) || null; } catch { return null; }
}

/** Remove the crash-recovery file. */
export async function clearCrashRecovery() {
  if (!isTauri()) return;
  try { await invoke('crash_recovery_clear'); } catch (e) { console.warn('[crash-recovery] clear failed', e); }
}

async function ask(message, title) {
  const dialog = window.__TAURI__?.dialog;
  if (dialog?.ask) {
    return dialog.ask(message, {
      title,
      kind: 'warning',
      okLabel: i18next.t('dialogs:crashRecovery.restore', { defaultValue: 'Restore' }),
      cancelLabel: i18next.t('dialogs:crashRecovery.discard', { defaultValue: 'Discard' }),
    });
  }
  return window.confirm(message);
}

async function redraw() {
  try {
    const { refreshAnnotationLayers } = await import('../solid/stores/annotationLayersStore.js');
    refreshAnnotationLayers();
    const { redrawAnnotations, redrawContinuous } = await import('../annotations/rendering.js');
    if (state.documents[state.activeDocumentIndex]?.viewMode === 'continuous') redrawContinuous();
    else redrawAnnotations();
  } catch (e) {
    console.warn('[crash-recovery] redraw failed', e);
  }
}

/**
 * Offer the unsaved markups of the crash-recovery file. `openFiles(paths)`
 * opens drawings and resolves when they are loaded (main.js).
 * @returns {Promise<{offered: number, restored: number}>}
 */
export async function offerCrashRecovery({ openFiles, notice = null }) {
  if (!isTauri()) return { offered: 0, restored: 0 };
  if (notice) console.error(`[crash-recovery] the page was reloaded after its web process ended (${notice.reason})`);
  let snapshot = null;
  try { snapshot = parseRecovery(await invoke('crash_recovery_load')); } catch { snapshot = null; }
  if (!snapshot) return { offered: 0, restored: 0 };

  const present = [];
  for (const entry of snapshot.documents) {
    // The native check: the fs plugin's stat refuses a path this run has
    // not opened yet (its scope), which would count every drawing as gone.
    try { if (await invoke('file_exists', { path: entry.filePath })) present.push(entry); } catch { /* gone */ }
  }
  if (present.length === 0) {
    await clearCrashRecovery();
    return { offered: 0, restored: 0 };
  }

  diagnostic('crash-recovery-offered');
  const count = present.length;
  const title = i18next.t('dialogs:crashRecovery.title', { defaultValue: 'Recover unsaved markups' });
  const message = notice
    ? i18next.t('dialogs:crashRecovery.afterReload', {
      count,
      defaultValue: 'The drawing view stopped unexpectedly and was reloaded. Unsaved markups of {{count}} drawing(s) were kept. Restore them?',
    })
    : i18next.t('dialogs:crashRecovery.afterRestart', {
      count,
      defaultValue: 'The app did not close normally last time. Unsaved markups of {{count}} drawing(s) were kept. Restore them?',
    });
  let restore = false;
  try { restore = await ask(message, title); } catch { restore = false; }
  if (!restore) {
    await clearCrashRecovery();
    return { offered: count, restored: 0 };
  }

  await openFiles(present.map((entry) => entry.filePath), { activate: true });
  const { ensureAnnotationsForPage } = await import('../pdf/loader.js');
  let restored = 0;
  for (const entry of present) {
    const index = findDocumentByPath(entry.filePath);
    const doc = index === -1 ? null : state.documents[index];
    if (!doc?.pdfDoc) continue;
    try {
      const result = await applyRecoveredMarkups(doc, entry, { ensurePage: (page, d) => ensureAnnotationsForPage(page, d) });
      if (result.skipped) console.warn(`[crash-recovery] markups of a drawing not restored (${result.skipped})`);
      restored += result.restored;
    } catch (e) {
      console.warn('[crash-recovery] restoring markups failed', e);
    }
  }
  await redraw();
  diagnostic('crash-recovery-restored');
  return { offered: count, restored };
}

/**
 * Keep the crash-recovery file current while the app runs.
 * @returns {() => void} stop
 */
export function startCrashRecoveryAutosave({ intervalMs = AUTOSAVE_INTERVAL_MS, keepExisting = false } = {}) {
  if (!isTauri()) return () => {};
  let lastSignature = null;
  let lastWrite = 0;
  // A file from before is removed on the first tick with nothing unsaved,
  // unless the offer of its markups failed (`keepExisting`): then it stays
  // until there is something new to write.
  let hasFile = !keepExisting;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const documents = state.documents;
      const signature = recoverySignature(documents, (doc) => undoStackOf(doc)?.length || 0);
      const anyUnsaved = documents.some((doc) => doc?.modified);
      const due = anyUnsaved && Date.now() - lastWrite >= AUTOSAVE_FORCE_MS;
      if (signature === lastSignature && !due) return;
      lastSignature = signature;
      const snapshot = recoverySnapshot(documents);
      if (snapshot.documents.length > 0) {
        await invoke('crash_recovery_save', { data: JSON.stringify(snapshot) });
        hasFile = true;
        lastWrite = Date.now();
      } else if (hasFile) {
        await invoke('crash_recovery_clear');
        hasFile = false;
      }
    } catch (e) {
      console.warn('[crash-recovery] autosave failed', e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return () => clearInterval(timer);
}

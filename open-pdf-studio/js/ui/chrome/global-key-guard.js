// One check for every document-wide keydown handler: while a modal dialog is
// open, keys belong to that dialog and never act on the drawing behind it
// (undo, close tab, delete, tool letters, tab cycling, view history).
//
// A modal is any of: a dialog in the Solid dialog store, a rendered
// [aria-modal="true"] element (Dialog.jsx and anything else that declares
// itself modal), an event target inside such an element, or a caller-provided
// extra check (the canvas uses tool-context isModalOpen for legacy overlays).

import { getDialogs } from '../../solid/stores/dialogStore.js';

const MODAL_SELECTOR = '[aria-modal="true"]';

/**
 * Pure core. True when a modal should swallow this key.
 * @param {{ target?: any }} e
 * @param {{ dialogCount?: number, root?: { querySelector?: Function } | null, modalOpen?: boolean }} env
 */
export function modalBlocksGlobalKey(e, { dialogCount = 0, root = null, modalOpen = false } = {}) {
  if (modalOpen) return true;
  if (dialogCount > 0) return true;
  const t = e?.target;
  if (t && typeof t.closest === 'function' && t.closest(MODAL_SELECTOR)) return true;
  return !!(root && typeof root.querySelector === 'function' && root.querySelector(MODAL_SELECTOR));
}

/**
 * Should a global (document-wide) keydown handler act on this event?
 * @param {KeyboardEvent} e
 * @param {{ modalOpen?: () => boolean }} [extra]
 */
export function shouldHandleGlobalKey(e, extra = {}) {
  let dialogCount = 0;
  try { dialogCount = (getDialogs() || []).length; } catch { /* store unavailable */ }
  return !modalBlocksGlobalKey(e, {
    dialogCount,
    root: typeof document === 'undefined' ? null : document,
    modalOpen: typeof extra.modalOpen === 'function' ? !!extra.modalOpen() : false,
  });
}

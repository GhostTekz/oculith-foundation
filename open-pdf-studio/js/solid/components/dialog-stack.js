// Stacked modal dialogs: the one opened last is rendered last in the document
// (DialogHost renders the store in order; a dialog opened from inside another
// is nested after it), so it is the last modal in document order. Only that
// dialog reacts to Escape.

export const MODAL_DIALOG_SELECTOR = '.modal-overlay [role="dialog"][aria-modal="true"]';

/**
 * @param {Element|null|undefined} dialog
 * @param {{ querySelectorAll?: Function }} root
 */
export function isTopmostDialog(dialog, root) {
  if (!dialog || !root || typeof root.querySelectorAll !== 'function') return false;
  const all = [...root.querySelectorAll(MODAL_DIALOG_SELECTOR)];
  return all.length > 0 && all[all.length - 1] === dialog;
}

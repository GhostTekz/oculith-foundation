// A text field in the Properties panel for a multi-selection applies its
// value on change, which fires on blur (properties-panel/multi-edit.js). A tab
// switch by keyboard (Ctrl+Tab) leaves focus in the field while the panel is
// rebuilt for the new document, so the edit was lost. Blurring the field while
// its document is still active commits it there.

const PANEL_SELECTOR = '#properties-panel';

/**
 * Blur a focused text field inside the Properties panel. Returns true when a
 * field was blurred.
 * @param {{ activeElement?: any } | null | undefined} doc  the DOM document
 */
export function commitFocusedPropertyField(doc = typeof document === 'undefined' ? null : document) {
  const el = doc?.activeElement;
  if (!el || !/^(INPUT|TEXTAREA|SELECT)$/u.test(el.tagName || '')) return false;
  if (typeof el.closest !== 'function' || !el.closest(PANEL_SELECTOR)) return false;
  if (typeof el.blur !== 'function') return false;
  el.blur();
  return true;
}

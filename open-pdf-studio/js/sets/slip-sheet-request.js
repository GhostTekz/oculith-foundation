// Batch ▸ Slip Sheet runs the Sets panel's "Slip sheet…" flow
// (docs/reference/editor/sets-and-batch.md). The command opens the panel and asks; the panel
// answers once it is mounted (at once when it already is).
let pending = false;
const listeners = new Set();

/** Ask the Sets panel to start Slip sheet…. */
export function requestSlipSheet() {
  pending = true;
  const first = [...listeners][0];
  if (first) { pending = false; first(); }
}

/** The Sets panel's handler; a request made before it mounted runs now. Returns the unsubscribe. */
export function onSlipSheetRequest(handler) {
  listeners.add(handler);
  if (pending) { pending = false; handler(); }
  return () => listeners.delete(handler);
}

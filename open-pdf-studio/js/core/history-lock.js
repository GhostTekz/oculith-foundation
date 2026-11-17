// One history step at a time. Undo, redo and the page operations (insert,
// delete, move, merge, replace pages) replace the document's PDF and
// await while they do; a second one started meanwhile would read or restore
// bytes of a state that is about to change. While one runs, the others are
// refused rather than queued: a queued step would run against whatever tab
// and state are current by then.

let busy = false;

/** True while an undo, redo or page operation runs. */
export function historyBusy() {
  return busy;
}

/**
 * Run `fn` as the only history step in flight. Resolves to its result, or to
 * `refused` without running it when another step is still running.
 */
export async function withHistoryLock(fn, refused = undefined) {
  if (busy) return refused;
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

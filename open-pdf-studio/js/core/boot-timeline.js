// The start-up timeline: one performance mark per start-up step
// (`ocudraw:boot:<step>`), always on and silent. Read it in the developer
// tools with performance.getEntriesByType('mark') or
// globalThis.__ocudrawBootTimeline(), which gives each step's time in ms
// since the page started (performance.timeOrigin). Only step names and
// times are recorded.

const PREFIX = 'ocudraw:boot:';

/** Mark start-up step `step` once (a repeated step keeps its first time). */
export function bootMark(step) {
  try {
    if (performance.getEntriesByName(PREFIX + step, 'mark').length) return;
    performance.mark(PREFIX + step);
  } catch { /* the timeline must never stop start-up */ }
}

/** Mark `step` at the next painted frame after now. */
export function bootMarkFrame(step) {
  try {
    requestAnimationFrame(() => setTimeout(() => bootMark(step), 0));
  } catch { bootMark(step); }
}

/** `{ step: ms }` in the order the steps happened. */
export function bootTimeline() {
  const out = {};
  try {
    for (const entry of performance.getEntriesByType('mark')) {
      if (entry.name.startsWith(PREFIX)) out[entry.name.slice(PREFIX.length)] = Math.round(entry.startTime * 10) / 10;
    }
  } catch { /* no timeline */ }
  return out;
}

globalThis.__ocudrawBootTimeline = bootTimeline;

// The page a Previous / Next click (or PageUp / PageDown) goes to.
//
// The click handlers reach goToPage() through a dynamic import, and a heavy
// page keeps the main thread busy while it renders. Clicks queued behind that
// work run back to back, before goToPage() has set the current page of the
// click before them, so each one read the same current page and several
// clicks turned only one page. Here every step builds on the target of the
// step before it while the current page has not moved yet: twenty quick
// clicks go twenty pages, and the renderer draws only the latest target
// (render generations in renderer.js).
//
// Pure: the document is passed in (page-step.test.mjs).

const _pending = new WeakMap();

/**
 * The page to go to for a step of `delta` pages, or null without pages.
 * @param {{currentPage?: number, pdfDoc?: {numPages?: number}, facingSpread?: boolean}} doc
 * @param {number} delta
 */
export function pageStepTarget(doc, delta) {
  const numPages = doc?.pdfDoc?.numPages || 0;
  if (!numPages || !doc || typeof doc !== 'object') return null;
  const current = doc.currentPage || 1;
  // `path`: the page the steps started on and every target issued since.
  // While the current page is on that path, the steps are still being
  // applied and the next one builds on the last target; a page off the path
  // was set by another route (thumbnail, link, page field), so start again.
  // The facing view turns whole spreads in goToPage(); its ±1 means "next
  // spread", so it does not stack here.
  let pending = _pending.get(doc);
  if (doc.facingSpread || !pending || !pending.path.has(current) || current === pending.to) {
    pending = { to: current, path: new Set([current]) };
  }
  const to = Math.min(numPages, Math.max(1, pending.to + delta));
  pending.to = to;
  pending.path.add(to);
  _pending.set(doc, pending);
  return to;
}

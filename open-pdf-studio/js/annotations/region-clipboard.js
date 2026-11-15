// Cut, Copy and Paste of a region of a drawing.
//
// The select tool leaves a region selection when a marquee captures no
// markups (tools/region-selection.js). Cut and Copy take that part of the
// page as a vector snippet: the page is copied out of the file natively and
// the box is applied when the snippet is embedded (tools/tools/
// vector-snippet-tool.js, pdf/vector-embed.js). Nothing is removed from the
// source page, so Cut and Copy do the same here.
//
// Paste places the snippet on the current page of the active drawing at the
// position it was taken from, kept on the page. The clipboard lives at module
// level, so it pastes on another tab or another drawing. Among the region,
// the markup clipboard and the snapshot, the most recent copy pastes
// (region-clipboard-logic.js).

import { state, getActiveDocument } from '../core/state.js';
import { getRegionSelection } from '../tools/region-selection.js';
import { latestCopy, pastePosition } from './region-clipboard-logic.js';
import { zetKnipselOpKlembord, plaatsKnipsel } from './vector-snippet-clipboard.js';
import { heeft } from './vector-snippet-store.js';
import { updateStatusMessage } from '../ui/chrome/status-bar.js';
import { paginaMaat } from '../pdf/weergave-ruimte.js';
import i18next from '../i18n/config.js';

/** @type {{knipsel: object, x: number, y: number} | null} */
let _clip = null;
/** The cut that is still running, so a paste can wait for it. */
let _pending = null;

const MESSAGE_WHILE_COPYING_MS = 120_000;

function redraw() {
  return import('./rendering.js').then((m) => {
    if (getActiveDocument()?.viewMode === 'continuous') m.redrawContinuous();
    else m.redrawAnnotations();
  });
}

/** Is there a region to paste, or one being cut? */
export function regionCopyAvailable() {
  return !!_pending || (!!_clip && heeft(_clip.knipsel.snippetKey));
}

/** Does Paste place the region (the most recent copy)? */
export function regionPasteIsLatest() {
  if (!regionCopyAvailable()) return false;
  const markups = (state.clipboardAnnotations?.length > 0 || state.clipboardAnnotation)
    ? state._internalCopyAt : null;
  return latestCopy({ region: state._regionCopyAt, markups, snapshot: state._snapshotAt }) === 'region';
}

/**
 * Cut or Copy the region selection of the active drawing onto the snippet
 * clipboard. The selection stays; the page is not changed.
 * @returns {Promise<boolean>} false without a region selection or when the cut failed
 */
export async function copyRegionSelection() {
  const doc = getActiveDocument();
  const region = doc ? getRegionSelection(doc) : null;
  if (!region) return false;
  const vak = { x: region.x, y: region.y, width: region.width, height: region.height };
  const previousAt = state._regionCopyAt;
  state._regionCopyAt = Date.now();
  updateStatusMessage(i18next.t('vectorSnippet.regionCopying'), MESSAGE_WHILE_COPYING_MS);

  // The task itself fills the clipboard, so a paste that waits for it finds
  // the region there.
  const task = (async () => {
    try {
      const { knipselVanVak } = await import('../tools/tools/vector-snippet-tool.js');
      const knipsel = await knipselVanVak(vak, region.page, doc);
      if (knipsel?.fout) throw new Error(knipsel.fout);
      if (_pending !== task) return false; // a later cut took over
      zetKnipselOpKlembord(knipsel);
      _clip = { knipsel, x: vak.x, y: vak.y };
      updateStatusMessage(i18next.t('vectorSnippet.regionCopied'));
      return true;
    } catch (err) {
      console.warn('[region] cut failed:', err?.message || err);
      if (_pending === task) state._regionCopyAt = previousAt;
      updateStatusMessage(i18next.t('vectorSnippet.failed'));
      return false;
    } finally {
      if (_pending === task) _pending = null;
    }
  })();
  _pending = task;
  return task;
}

/**
 * Paste the region on the current page of the active drawing, where it was
 * taken from (kept on the page), selected and undoable. Waits for a cut that
 * is still running.
 * @returns {Promise<object|null>} the new vectorSnippet markup
 */
export async function pasteRegion() {
  while (_pending) await _pending;
  const clip = _clip;
  const doc = getActiveDocument();
  if (!clip || !doc?.pdfDoc) return null;
  const page = doc.currentPage || 1;
  const maat = paginaMaat(page, doc);
  const { x, y } = pastePosition(clip, { width: clip.knipsel.breedte, height: clip.knipsel.hoogte },
    maat ? { width: maat.breedte, height: maat.hoogte } : null);
  const ann = plaatsKnipsel(clip.knipsel, { x, y, page });
  if (!ann) {
    updateStatusMessage(i18next.t('vectorSnippet.clipboardEmpty'));
    return null;
  }
  import('../ui/panels/properties-panel.js').then((m) => m.showProperties(ann)).catch(() => {});
  await redraw();
  updateStatusMessage(i18next.t('vectorSnippet.regionPasted'));
  return ann;
}

/** Paste the region when it is the most recent copy. @returns {boolean} whether it does */
export function pasteRegionIfLatest() {
  if (!regionPasteIsLatest()) return false;
  void pasteRegion();
  return true;
}

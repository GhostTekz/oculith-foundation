// Text of a page region (Page Labels > Create from Page Region) and the
// position of text runs on a page (Batch Link).
//
// Positions are in the annotation model space: the PDF.js viewport at scale 1
// with the page's /Rotate plus the app's own page rotation, origin at the top
// left of the CropBox (see AGENTS.md). PDF.js text items carry their place in
// PDF user space (item.transform); viewport.convertToViewportPoint takes care
// of the CropBox origin and the rotation.
//
// A region is drawn once on one page and applied to every page at the same
// place relative to the visible sheet (fractions of the viewport width and
// height), as a title block sits in the same corner of every sheet.

/** The model viewport of a page: scale 1, /Rotate plus the app rotation. */
export function modelViewport(page, extraRotation = 0) {
  const rotation = (((page.rotate || 0) + (extraRotation || 0)) % 360 + 360) % 360;
  return page.getViewport({ scale: 1, rotation });
}

/** A rectangle in model space as fractions of the page (0..1). */
export function regionFractions(rect, pageWidth, pageHeight) {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  const clamp = v => Math.max(0, Math.min(1, v));
  const x1 = clamp(rect.x / pageWidth);
  const y1 = clamp(rect.y / pageHeight);
  const x2 = clamp((rect.x + rect.width) / pageWidth);
  const y2 = clamp((rect.y + rect.height) / pageHeight);
  if (!(x2 > x1) || !(y2 > y1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** The region's rectangle on a page of the given model size. */
export function regionOnPage(fractions, pageWidth, pageHeight) {
  return {
    x: fractions.x * pageWidth,
    y: fractions.y * pageHeight,
    width: fractions.width * pageWidth,
    height: fractions.height * pageHeight,
  };
}

function unit(x, y) {
  const len = Math.hypot(x, y);
  return len > 0 ? [x / len, y / len] : null;
}

/**
 * The model-space box of a text item, or of the characters `from`..`to` of
 * its string: a share of its advance width, by character count or, with
 * `measure(text) -> width` (a canvas measureText in the run's font family),
 * by the measured widths of the text before and up to the range. Null for an
 * empty or degenerate item.
 */
export function textItemBox(item, viewport, from = 0, to = null, measure = null) {
  const str = String(item?.str ?? '');
  const t = item?.transform;
  if (!str.length || !Array.isArray(t) || t.length < 6) return null;
  const along = unit(t[0], t[1]);
  const up = unit(t[2], t[3]) || (along ? [-along[1], along[0]] : null);
  if (!along || !up) return null;
  const width = Number(item.width) || 0;
  const height = Number(item.height) || Math.hypot(t[2], t[3]) || 0;
  if (!(height > 0)) return null;
  const end = to == null ? str.length : to;
  let share = (n) => n / str.length;
  if (measure && (from > 0 || end < str.length)) {
    const total = Number(measure(str)) || 0;
    if (total > 0) share = (n) => (Number(measure(str.slice(0, n))) || 0) / total;
  }
  const a = width * share(from);
  const b = width * share(end);
  // A little below the baseline, for descenders.
  const descent = height * 0.2;
  const corners = [];
  for (const s of [a, b]) {
    for (const h of [-descent, height]) {
      const px = t[4] + along[0] * s + up[0] * h;
      const py = t[5] + along[1] * s + up[1] * h;
      corners.push(viewport.convertToViewportPoint(px, py));
    }
  }
  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function inside(box, rect) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
}

/** The non-blank text items of a page as runs `{ str, box }` in model space. */
export function textRuns(items, viewport) {
  const runs = [];
  for (const item of items || []) {
    if (!item?.str || !item.str.trim()) continue;
    const box = textItemBox(item, viewport);
    if (box) runs.push({ str: item.str, box });
  }
  return runs;
}

/**
 * The text of the runs (`{ str, box }`) whose centre is inside `rect`, in
 * reading order (top to bottom, left to right), runs joined by one space.
 */
export function textOfRuns(runs, rect) {
  const hits = (runs || []).filter(run => run?.box && String(run.str ?? '').trim() && inside(run.box, rect));
  hits.sort((a, b) => (a.box.y + a.box.height / 2) - (b.box.y + b.box.height / 2));
  const lines = [];
  for (const hit of hits) {
    const cy = hit.box.y + hit.box.height / 2;
    const line = lines[lines.length - 1];
    if (line && Math.abs(cy - line.cy) <= Math.max(line.h, hit.box.height) / 2) line.items.push(hit);
    else lines.push({ cy, h: hit.box.height, items: [hit] });
  }
  return lines
    .map(line => line.items.sort((a, b) => a.box.x - b.box.x).map(h => String(h.str).trim()).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text whose runs have their centre inside `rect`, in reading order
 * (top to bottom, left to right), runs joined by one space.
 */
export function textInRegion(items, viewport, rect) {
  return textOfRuns(textRuns(items, viewport), rect);
}

/**
 * Text of the region on each page of a PDF.js document.
 * @param {object} pdfDoc  PDF.js document
 * @param {{x,y,width,height}} fractions  region as fractions of the page
 * @param {{ rotationOf?: (page:number)=>number, isCurrent?: ()=>boolean, onProgress?: Function }} [options]
 * @returns {Promise<string[]|null>} one string per page; null when cancelled
 */
export async function extractRegionTexts(pdfDoc, fractions, options = {}) {
  const { rotationOf = () => 0, isCurrent = () => true, onProgress } = options;
  const texts = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const viewport = modelViewport(page, rotationOf(p));
    let items = [];
    try { items = (await page.getTextContent()).items; } catch { items = []; }
    if (!isCurrent()) return null;
    texts.push(textInRegion(items, viewport, regionOnPage(fractions, viewport.width, viewport.height)));
    onProgress?.(p, pdfDoc.numPages);
  }
  return texts;
}

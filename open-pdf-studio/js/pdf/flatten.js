// Flatten / Unflatten markups (the external editor Document ▸ Flatten… / Unflatten,
// docs/reference/editor/markup-tools.md). Pure pdf-lib: no app state, so node tests run it on real
// PDF bytes.
//
// Flatten draws each chosen annotation's normal appearance (/AP /N) into the
// page content, the way a viewer paints it (BBox × Matrix fitted to the
// Rect, /OC kept), and removes the annotation from /Annots together
// with its popup, replies and review-status notes. The existing content is
// wrapped in q … Q first, so a page that leaves its graphics state changed
// cannot shift the burnt-in markups.
//
// With "allow unflatten" the page keeps a private /OPS_Flattened record per
// run: the removed annotation refs (the original dictionaries, unchanged, so
// IDs, values and custom columns come back as they were), their /Annots
// positions, and the content streams and resource names this run added.
// Unflatten removes exactly those streams and names and puts the
// annotations back. Without it, the removed dictionaries and every object
// that only they used are deleted, so no private data stays in the file.

import { PDFName, PDFArray, PDFDict, PDFRef, PDFStream, PDFNumber } from 'pdf-lib';

export const FLATTEN_KEY = 'OPS_Flattened';
const VERSION = 1;

const N = (name) => PDFName.of(name);

// pdf.js names an annotation after its object: '12R', or '12R3' for a
// nonzero generation (pdf.js Ref.toString). The app uses it to find the
// restored annotations in getAnnotations().
export function pdfjsAnnotationId(ref) {
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

// Numbers in content streams: no exponent notation, no -0.
function num(value) {
  const n = Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
  return Object.is(n, -0) || n === 0 ? '0' : String(n);
}

function numbers(arr, context) {
  const list = context.lookupMaybe(arr, PDFArray);
  if (!list) return null;
  const out = [];
  for (let i = 0; i < list.size(); i++) {
    const v = context.lookupMaybe(list.get(i), PDFNumber);
    if (!v) return null;
    out.push(v.asNumber());
  }
  return out;
}

function normRect(r) {
  if (!r || r.length !== 4) return null;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

// The pdf.js / PDF 32000 12.5.5 algorithm: the BBox transformed by Matrix,
// scaled and moved onto the Rect.
export function appearanceTransform(rect, bbox, matrix = [1, 0, 0, 1, 0, 0]) {
  const [a, b, c, d, e, f] = matrix;
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = corners.map(p => p[0]);
  const ys = corners.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minX === maxX || minY === maxY) return [1, 0, 0, 1, rect[0], rect[1]];
  const sx = (rect[2] - rect[0]) / (maxX - minX);
  const sy = (rect[3] - rect[1]) / (maxY - minY);
  return [sx, 0, 0, sy, rect[0] - minX * sx, rect[1] - minY * sy];
}

const subtypeOf = (dict) => dict?.get(N('Subtype'))?.toString?.() || '';
const flagsOf = (dict, context) => context.lookupMaybe(dict.get(N('F')), PDFNumber)?.asNumber() || 0;
// Hidden (2) or NoView (32): a viewer paints nothing, so neither does flatten.
const invisible = (dict, context) => (flagsOf(dict, context) & (2 | 32)) !== 0;
const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

// Never flattened on their own: links and form fields are not markups, a
// popup belongs to its parent.
const NOT_MARKUP = new Set(['/Link', '/Widget', '/Popup']);

/** A reply or review-status note: a Text annotation /IRT another. */
function isReplyNote(dict) {
  if (!(dict.get(N('IRT')) instanceof PDFRef)) return false;
  if (subtypeOf(dict) !== '/Text') return false;
  return dict.get(N('RT'))?.toString?.() !== '/Group';
}

/** The stream /AP /N points at (the /AS state of a state dictionary). */
function normalAppearance(dict, context) {
  const ap = context.lookupMaybe(dict.get(N('AP')), PDFDict);
  if (!ap) return null;
  let nRef = ap.get(N('N'));
  const n = context.lookup(nRef);
  if (n instanceof PDFDict && !(n instanceof PDFStream)) {
    const as = dict.get(N('AS'));
    if (!(as instanceof PDFName)) return null;
    nRef = n.get(as);
  }
  if (!(nRef instanceof PDFRef)) return null;
  const stream = context.lookup(nRef);
  if (!(stream instanceof PDFStream)) return null;
  return { ref: nRef, stream };
}

function pageAnnots(page, context) {
  const arr = context.lookupMaybe(page.node.get(N('Annots')), PDFArray);
  return arr ? arr.asArray().slice() : [];
}

function contentRefs(page, context) {
  const raw = page.node.get(N('Contents'));
  if (!raw) return [];
  const looked = context.lookup(raw);
  if (looked instanceof PDFArray) return looked.asArray().slice();
  return raw instanceof PDFRef ? [raw] : [];
}

// The page's own Resources dictionary: an inherited one is copied first, so
// the names this run adds stay on this page.
function ownResources(page, context) {
  const own = page.node.get(N('Resources'));
  const ownDict = context.lookupMaybe(own, PDFDict);
  if (ownDict) return ownDict;
  const inherited = context.lookupMaybe(page.node.getInheritableAttribute(N('Resources')), PDFDict);
  const copy = inherited ? inherited.clone(context) : context.obj({});
  page.node.set(N('Resources'), copy);
  return copy;
}

function subDict(resources, key, context, create) {
  const existing = context.lookupMaybe(resources.get(N(key)), PDFDict);
  if (existing || !create) return existing || null;
  const fresh = context.obj({});
  resources.set(N(key), fresh);
  return fresh;
}

function uniqueName(dict, base) {
  let i = 1;
  while (dict.has(N(`${base}${i}`))) i++;
  return `${base}${i}`;
}

/**
 * Which annotations of a page go: the chosen ones (the caller's `select`),
 * plus everything that belongs to them (popup, replies, status notes,
 * textbox leaders and other /IRT children), until nothing new is added.
 */
function collectForPage(page, pageIndex, context, select) {
  const refs = pageAnnots(page, context).filter(r => r instanceof PDFRef);
  const dicts = new Map(refs.map(r => [refKey(r), context.lookupMaybe(r, PDFDict)]));
  const chosen = new Set();
  for (const ref of refs) {
    const dict = dicts.get(refKey(ref));
    if (!dict) continue;
    const st = subtypeOf(dict);
    if (!st || NOT_MARKUP.has(st) || isReplyNote(dict)) continue;
    if (select && !select(ref, dict, pageIndex)) continue;
    chosen.add(refKey(ref));
  }
  let grew = chosen.size > 0;
  while (grew) {
    grew = false;
    for (const ref of refs) {
      const key = refKey(ref);
      if (chosen.has(key)) continue;
      const dict = dicts.get(key);
      if (!dict) continue;
      const owner = dict.get(N('IRT')) || (subtypeOf(dict) === '/Popup' ? dict.get(N('Parent')) : null);
      if (owner instanceof PDFRef && chosen.has(refKey(owner))) { chosen.add(key); grew = true; }
    }
  }
  return refs.filter(r => chosen.has(refKey(r))).map(r => ({ ref: r, dict: dicts.get(refKey(r)) }));
}

/**
 * Flatten markups into the page content.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {object} [options]
 * @param {number[]|null} [options.pages] 1-based page numbers (all when null)
 * @param {(ref: PDFRef, dict: PDFDict, pageIndex: number) => boolean} [options.select]
 *   which markups to flatten (all markups when absent); popups, replies and
 *   other /IRT children follow their markup
 * @param {boolean} [options.allowUnflatten=true] keep a private copy so
 *   Unflatten can restore the markups
 * @returns {{ flattened: {page:number, ref:PDFRef}[], removed: {page:number, ref:PDFRef}[],
 *   skipped: {page:number, ref:PDFRef, reason:string}[] }}
 *   `flattened`: drawn into the content; `removed`: every annotation taken
 *   out (also the popups and replies); `skipped`: chosen but left in place
 *   because it has no usable appearance
 */
export function flattenPdfDocument(pdfDoc, { pages = null, select = null, allowUnflatten = true } = {}) {
  const context = pdfDoc.context;
  const all = pdfDoc.getPages();
  const targets = pages ? [...new Set(pages)].filter(p => p >= 1 && p <= all.length).sort((a, b) => a - b)
    : all.map((_, i) => i + 1);
  const flattened = [];
  const removed = [];
  const skipped = [];
  const deletedRefs = [];

  for (const pageNum of targets) {
    const page = all[pageNum - 1];
    const candidates = collectForPage(page, pageNum - 1, context, select);
    if (!candidates.length) continue;

    // Chosen markups without an appearance stay annotations (with their
    // popups and replies): there is nothing faithful to draw.
    const keep = new Set();
    const draws = [];
    for (const { ref, dict } of candidates) {
      if (isReplyNote(dict) || subtypeOf(dict) === '/Popup') continue;
      if (invisible(dict, context)) continue;
      const ap = normalAppearance(dict, context);
      const rect = normRect(numbers(dict.get(N('Rect')), context));
      const bbox = ap ? normRect(numbers(ap.stream.dict.get(N('BBox')), context)) : null;
      if (!ap || !rect || !bbox) {
        keep.add(refKey(ref));
        skipped.push({ page: pageNum, ref, reason: ap ? 'geometry' : 'no-appearance' });
        continue;
      }
      draws.push({ ref, dict, ap, rect, bbox, matrix: numbers(ap.stream.dict.get(N('Matrix')), context) || undefined });
    }
    // Followers of a kept markup stay with it.
    let grew = keep.size > 0;
    while (grew) {
      grew = false;
      for (const { ref, dict } of candidates) {
        const key = refKey(ref);
        if (keep.has(key)) continue;
        const owner = dict.get(N('IRT')) || (subtypeOf(dict) === '/Popup' ? dict.get(N('Parent')) : null);
        if (owner instanceof PDFRef && keep.has(refKey(owner))) { keep.add(key); grew = true; }
      }
    }
    const going = candidates.filter(c => !keep.has(refKey(c.ref)));
    const drawing = draws.filter(d => !keep.has(refKey(d.ref)));
    if (!going.length) continue;

    const resources = ownResources(page, context);
    const xobjects = subDict(resources, 'XObject', context, drawing.length > 0);
    const xNames = [];
    const propNames = [];
    const ops = ['Q'];
    for (const d of drawing) {
      const st = d.ap.stream.dict;
      if (!st.get(N('Type'))) st.set(N('Type'), N('XObject'));
      if (!st.get(N('Subtype'))) st.set(N('Subtype'), N('Form'));
      const name = uniqueName(xobjects, 'OPSFl');
      xobjects.set(N(name), d.ap.ref);
      xNames.push(name);
      let ocName = null;
      const oc = d.dict.get(N('OC'));
      if (oc instanceof PDFRef) {
        const props = subDict(resources, 'Properties', context, true);
        ocName = uniqueName(props, 'OPSFlOC');
        props.set(N(ocName), oc);
        propNames.push(ocName);
      }
      // No extra Rect clip: Do clips to the BBox, which this transform maps
      // onto the Rect, so the region is the viewer's. A second clip would
      // soften edges that fall on half pixels.
      const m = appearanceTransform(d.rect, d.bbox, d.matrix);
      if (ocName) ops.push(`/OC /${ocName} BDC`);
      ops.push(`q ${m.map(num).join(' ')} cm /${name} Do Q`);
      if (ocName) ops.push('EMC');
      flattened.push({ page: pageNum, ref: d.ref });
    }

    const pre = context.register(context.stream('q\n'));
    const post = context.register(context.stream(`${ops.join('\n')}\n`));
    page.node.set(N('Contents'), context.obj([pre, ...contentRefs(page, context), post]));

    const goingKeys = new Set(going.map(g => refKey(g.ref)));
    const before = pageAnnots(page, context);
    const positions = [];
    const remaining = [];
    before.forEach((r, i) => {
      if (r instanceof PDFRef && goingKeys.has(refKey(r))) positions.push(i);
      else remaining.push(r);
    });
    if (remaining.length) page.node.set(N('Annots'), context.obj(remaining));
    else page.node.delete(N('Annots'));
    for (const g of going) removed.push({ page: pageNum, ref: g.ref });

    if (allowUnflatten) {
      const record = context.obj({
        Annots: going.map(g => g.ref),
        Index: positions,
        Pre: pre,
        Post: post,
        XObjects: xNames.map(n => N(n)),
        Properties: propNames.map(n => N(n)),
      });
      const existing = context.lookupMaybe(page.node.get(N(FLATTEN_KEY)), PDFDict);
      const runs = existing ? context.lookupMaybe(existing.get(N('Runs')), PDFArray) : null;
      if (runs) runs.push(record);
      else page.node.set(N(FLATTEN_KEY), context.obj({ V: VERSION, Runs: [record] }));
    } else {
      deletedRefs.push(...going.map(g => g.ref));
    }
  }

  if (deletedRefs.length) deleteUnreachable(pdfDoc, deletedRefs);
  return { flattened, removed, skipped };
}

function walk(context, start, seen) {
  const stack = [...start];
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      const key = refKey(obj);
      if (seen.has(key)) continue;
      seen.add(key);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) stack.push(v);
    }
  }
  return seen;
}

// Delete the removed annotations and every object only they reached
// (popups, replies, border and measure dictionaries, rich text), keeping
// whatever the document still uses (the appearance streams now drawn from
// the page, the page itself, fonts).
function deleteUnreachable(pdfDoc, removedRefs) {
  const context = pdfDoc.context;
  const fromRemoved = walk(context, removedRefs, new Set());
  const t = context.trailerInfo;
  const live = walk(context, [t.Root, t.Info, t.Encrypt].filter(Boolean), new Set());
  for (const [ref] of context.enumerateIndirectObjects()) {
    const key = refKey(ref);
    if (fromRemoved.has(key) && !live.has(key)) context.delete(ref);
  }
}

/** 1-based numbers of the pages that hold recoverable flattened markups. */
export function flattenedPages(pdfDoc) {
  const context = pdfDoc.context;
  const out = [];
  pdfDoc.getPages().forEach((page, i) => {
    const rec = context.lookupMaybe(page.node.get(N(FLATTEN_KEY)), PDFDict);
    const runs = rec ? context.lookupMaybe(rec.get(N('Runs')), PDFArray) : null;
    if (runs && runs.size()) out.push(i + 1);
  });
  return out;
}

/**
 * Unflatten: put the markups of every recorded flatten run back as
 * annotations (same objects) and take their drawing out of the content.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {{ pages?: number[]|null }} [options] 1-based page numbers (all when null)
 * @returns {{ restored: {page:number, ref:PDFRef}[] }}
 */
export function unflattenPdfDocument(pdfDoc, { pages = null } = {}) {
  const context = pdfDoc.context;
  const all = pdfDoc.getPages();
  const want = pages ? new Set(pages) : null;
  const restored = [];
  all.forEach((page, i) => {
    const pageNum = i + 1;
    if (want && !want.has(pageNum)) return;
    const rec = context.lookupMaybe(page.node.get(N(FLATTEN_KEY)), PDFDict);
    const runs = rec ? context.lookupMaybe(rec.get(N('Runs')), PDFArray) : null;
    if (!runs) return;
    const resources = context.lookupMaybe(page.node.get(N('Resources')), PDFDict);
    const xobjects = resources ? subDict(resources, 'XObject', context, false) : null;
    const props = resources ? subDict(resources, 'Properties', context, false) : null;
    const dropStreams = new Set();
    let annots = pageAnnots(page, context);
    // Last run first, so each run's /Index positions apply to the /Annots
    // array as it was right after that run.
    for (let r = runs.size() - 1; r >= 0; r--) {
      const run = context.lookupMaybe(runs.get(r), PDFDict);
      if (!run) continue;
      for (const key of ['Pre', 'Post']) {
        const ref = run.get(N(key));
        if (ref instanceof PDFRef) dropStreams.add(refKey(ref));
      }
      for (const n of context.lookupMaybe(run.get(N('XObjects')), PDFArray)?.asArray() || []) {
        if (n instanceof PDFName) xobjects?.delete(n);
      }
      for (const n of context.lookupMaybe(run.get(N('Properties')), PDFArray)?.asArray() || []) {
        if (n instanceof PDFName) props?.delete(n);
      }
      const refs = (context.lookupMaybe(run.get(N('Annots')), PDFArray)?.asArray() || [])
        .filter(x => x instanceof PDFRef && context.lookup(x));
      const index = numbers(run.get(N('Index')), context) || [];
      const present = new Set(annots.filter(x => x instanceof PDFRef).map(refKey));
      refs.forEach((ref, k) => {
        if (present.has(refKey(ref))) return; // already back: no duplicate
        const at = Number.isInteger(index[k]) ? Math.min(index[k], annots.length) : annots.length;
        annots.splice(at, 0, ref);
        present.add(refKey(ref));
        restored.push({ page: pageNum, ref });
      });
    }
    const contents = contentRefs(page, context).filter(x => !(x instanceof PDFRef && dropStreams.has(refKey(x))));
    page.node.set(N('Contents'), context.obj(contents));
    for (const key of dropStreams) {
      const [o, g] = key.split(' ').map(Number);
      context.delete(PDFRef.of(o, g));
    }
    if (annots.length) page.node.set(N('Annots'), context.obj(annots));
    page.node.delete(N(FLATTEN_KEY));
  });
  return { restored };
}

// Saving a externally marked PDF without losing what the external editor wrote (see
// ../ext-interop.js and docs/reference/editor/markup-interop.md).
//
// Per page the saver asks this module, before it rebuilds /Annots, which
// the external editor markups are unchanged (their objects stay exactly as they are) and
// which were edited (rewritten from the model at the same object number,
// with the external editor's private keys carried over).

import { PDFName, PDFDict, PDFRef, PDFNumber, PDFString } from 'pdf-lib';
import { pdfTextString } from './pdf-text.js';
import {
  refTag, vingerafdruk, beeldVingerafdruk, zelfdeBron, neemExtSleutelsOver, directeVerwijzingen,
} from '../ext-interop.js';

const N = (s) => PDFName.of(s);
const BEELD_SOORTEN = new Set(['image', 'stamp']);

/**
 * @param {import('pdf-lib').PDFContext} context
 * @param {object[]} pageAnnotations  models on this page
 * @param {PDFRef[]} annotRefs  the page's current /Annots references
 * @param {Map<string, object>|null|undefined} extBron  doc._extBron
 */
export function extPaginaPlan(context, pageAnnotations, annotRefs, extBron) {
  const plan = {
    houd: new Set(), // ref tags written back untouched
    inPlaats: new Map(), // model id -> { ref, dict, entry }
    overslaan: new Set(), // model ids not written (their object is kept)
    bronDict: new Map(), // model id -> source dict for a copy
    oudeVerwijzingen: [], // objects the rewritten dicts pointed at (cleanup candidates)
  };
  if (!pageAnnotations?.length) return plan;
  const opPagina = new Map();
  for (const ref of annotRefs || []) if (ref instanceof PDFRef) opPagina.set(refTag(ref), ref);
  const geclaimd = new Set();
  for (const ann of pageAnnotations) {
    const tag = ann?.extBron?.ref;
    if (!tag) continue;
    const ref = opPagina.get(tag);
    const entry = extBron instanceof Map ? extBron.get(ann.id) : null;
    if (!ref || !zelfdeBron(context, ref, ann.extBron)) continue;
    const dict = context.lookup(ref);
    // The markup the loader read (same id, same object) owns the object;
    // another model made from it (a copy) only takes its private keys.
    if (entry && entry.ref === tag && !geclaimd.has(tag)) {
      geclaimd.add(tag);
      if (entry.sig && entry.sig === vingerafdruk(ann)) {
        plan.houd.add(tag);
        plan.overslaan.add(ann.id);
      } else {
        plan.inPlaats.set(ann.id, { ref, dict, entry });
        plan.oudeVerwijzingen.push(...directeVerwijzingen(dict));
      }
    } else {
      plan.bronDict.set(ann.id, dict);
    }
  }
  // Replies and review states of an untouched the external editor markup stay with it.
  if (plan.houd.size) {
    for (const ref of annotRefs || []) {
      const d = context.lookup(ref);
      if (!(d instanceof PDFDict) || d.get(N('Subtype'))?.toString() !== '/Text') continue;
      const irt = d.get(N('IRT'));
      if (irt instanceof PDFRef && plan.houd.has(refTag(irt))) plan.houd.add(refTag(ref));
    }
  }
  return plan;
}

/** Is this /Annots reference kept as it is (or as the slot of a rewrite)? */
export function extHoudtPlek(plan, ref) {
  const tag = refTag(ref);
  if (!tag || !plan) return false;
  if (plan.houd.has(tag)) return true;
  for (const v of plan.inPlaats.values()) if (refTag(v.ref) === tag) return true;
  return false;
}

/**
 * Before the saver registers a rewritten dictionary: carry the external editor's keys over
 * and, for the markup the object belongs to, return the reference to write
 * it at (the object keeps its number and its place in /Annots).
 * @returns {PDFRef|null} the reference to assign, or null to register anew
 */
export function extVoorRegistratie(context, annRaw, annotDict, plan, { fillOpacity } = {}) {
  if (!plan || !(annotDict instanceof PDFDict) || !annRaw?.extBron) return null;
  const inPl = plan.inPlaats.get(annRaw.id);
  const bron = inPl?.dict || plan.bronDict.get(annRaw.id);
  if (!(bron instanceof PDFDict)) return null;
  const overschrijf = [];
  // An image markup that only moved or was resized keeps the external editor's appearance:
  // viewers fit it to the new /Rect, so the image is not re-encoded.
  if (inPl && BEELD_SOORTEN.has(annRaw.type) && inPl.entry?.beeld && inPl.entry.beeld === beeldVingerafdruk(annRaw)
      && bron.get(N('AP'))) {
    overschrijf.push('AP');
    if (bron.get(N('Rotation')) !== undefined) overschrijf.push('Rotation');
  }
  // the external editor spells /IT its own way (FreeTextTypeWriter); keep that spelling.
  const it = annotDict.get(N('IT'))?.toString();
  const bronIt = bron.get(N('IT'))?.toString();
  if (it && bronIt && it !== bronIt && it.toLowerCase() === bronIt.toLowerCase()) overschrijf.push('IT');
  // OcuDraw does not model a callout's line ending: keep the external editor's.
  if (annRaw.type === 'callout' && bron.get(N('LE'))) overschrijf.push('LE');
  // A subject that is the external editor's /Subj is no comment: no /Contents for it. A
  // new subject (a category assigned in OcuDraw) is the external editor's /Subj too.
  if (annRaw.extBron.subj && !bron.get(N('Contents'))) {
    if (annRaw.subject && annRaw.subject !== annRaw.extBron.subj) annotDict.set(N('Subj'), pdfTextString(annRaw.subject));
    annotDict.delete(N('Contents'));
  }
  neemExtSleutelsOver(bron, annotDict, { kopie: !inPl, overschrijf });
  // the external editor reads its fill opacity and blend mode from its own keys.
  if (Number.isFinite(fillOpacity)) annotDict.set(N('FillOpacity'), PDFNumber.of(fillOpacity));
  else if (bron.get(N('FillOpacity')) !== undefined && Number.isFinite(annRaw.opacity)) {
    annotDict.set(N('FillOpacity'), PDFNumber.of(annRaw.opacity));
  }
  if (annRaw.blendMode === 'multiply') annotDict.set(N('BM'), N('Multiply'));
  // the external editor reads PDF dates (D:YYYYMMDDHHmmSS); the saver writes ISO text.
  const m = annotDict.lookup(N('M'));
  const iso = typeof m?.decodeText === 'function' ? m.decodeText() : '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(iso)) annotDict.set(N('M'), PDFString.of(pdfDatum(new Date(iso))));
  if (!inPl) return null;
  context.assign(inPl.ref, annotDict);
  return inPl.ref;
}

/** A date as PDF date text in UTC: D:YYYYMMDDHHmmSSZ. */
export function pdfDatum(datum) {
  const d = Number.isNaN(datum?.getTime?.()) ? new Date() : datum;
  const t = (n, l = 2) => String(n).padStart(l, '0');
  return `D:${t(d.getUTCFullYear(), 4)}${t(d.getUTCMonth() + 1)}${t(d.getUTCDate())}${t(d.getUTCHours())}${t(d.getUTCMinutes())}${t(d.getUTCSeconds())}Z`;
}

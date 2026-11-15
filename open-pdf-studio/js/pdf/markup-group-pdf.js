// Markup groups in the PDF (docs/reference/editor/markups-list.md), as external plan-review files writes them:
//
// - The dominant markup carries /GroupNesting [(Group name) /NMdominant /NMmember ...].
// - Every other member has /IRT to the dominant and /RT /Group.
//
// There is no group object. the external editor files seen so far have one level only, so
// OcuDraw writes every member's /IRT to the top-level dominant (what the external editor
// reads as one group). The levels below (nesting made in OcuDraw) go in
// OcuDraw's own key /OPS_GroupPathV1 on each member: an array of
// [(group id) (name) dominant?] from the top level down. A reader without it
// sees one flat group. the external editor's own nested encoding is not known (no sample).
//
// Load: membership comes from /IRT + /RT /Group only (a markup whose /IRT
// was removed elsewhere is not grouped, whatever its /OPS_GroupPathV1 says).

import { PDFName, PDFArray, PDFString, PDFHexString, PDFDict, PDFRef, PDFBool } from 'pdf-lib';
import { pdfTextString } from './saver/pdf-text.js';
import { groupPathOf, correctionGroupIds, DEFAULT_GROUP_NAME } from '../annotations/markup-groups.js';

const N = (s) => PDFName.of(s);
const MAX_NIVEAUS = 32;
const MAX_TEKST = 256;

function tekst(context, raw) {
  const v = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (v instanceof PDFString || v instanceof PDFHexString) {
    try { return v.decodeText(); } catch { return undefined; }
  }
  return undefined;
}

/**
 * Group keys of one annotation dictionary: the /GroupNesting name and member
 * names, and /OPS_GroupPathV1. Null when it has neither.
 * @returns {{ name?: string, nms?: string[], path?: Array<{id: string, name: string, dominant: boolean}> }|null}
 */
export function readGroupKeys(dict, context) {
  if (!(dict instanceof PDFDict)) return null;
  const uit = {};
  const gn = context.lookup(dict.get(N('GroupNesting')));
  if (gn instanceof PDFArray) {
    const items = gn.asArray();
    const naam = items.map((x) => tekst(context, x)).find((t) => typeof t === 'string');
    if (naam !== undefined) uit.name = naam.slice(0, MAX_TEKST);
    uit.nms = items.filter((x) => x instanceof PDFName).map((x) => x.decodeText());
  }
  const pad = context.lookup(dict.get(N('OPS_GroupPathV1')));
  if (pad instanceof PDFArray && pad.size() <= MAX_NIVEAUS) {
    const niveaus = [];
    for (const item of pad.asArray()) {
      const rij = context.lookup(item);
      if (!(rij instanceof PDFArray) || rij.size() < 2) { niveaus.length = 0; break; }
      const id = tekst(context, rij.get(0));
      const naam = tekst(context, rij.get(1));
      if (!id || id.length > MAX_TEKST || naam === undefined) { niveaus.length = 0; break; }
      niveaus.push({ id, name: naam.slice(0, MAX_TEKST), dominant: context.lookup(rij.get(2)) === PDFBool.True });
    }
    if (niveaus.length) uit.path = niveaus;
  }
  return 'name' in uit || uit.path ? uit : null;
}

/**
 * After a page's models are made: members (/IRT + /RT /Group, any depth of
 * /IRT chain) join the group of their root, which is the dominant markup.
 * Gives each member groupId and groupPath (name from /GroupNesting); the
 * levels below come from /OPS_GroupPathV1 when every member has it and it
 * agrees. `items[i].converted._groupKeys` is readGroupKeys() of its dict.
 * @param {Array<{converted: object, inReplyTo: string}>} items  /RT /Group children
 * @param {Map<string, object>} byPdfId
 * @param {object[]} [models]  every model of the page (to clear _groupKeys)
 * @returns {number} linked children
 */
export function linkMarkupGroups(items, byPdfId, models = []) {
  const ouderVan = new Map();
  for (const { converted, inReplyTo } of items || []) {
    // A replacement pair (#508) is linked already (correction-load.js).
    if (!converted || converted.groupId) continue;
    const ouder = byPdfId?.get(inReplyTo);
    if (!ouder || ouder === converted || ouder.page !== converted.page) continue;
    if (ouder.type === 'caret' && ouder.groupId === ouder.id) continue;
    ouderVan.set(converted, ouder);
  }
  const wortel = (m) => {
    const gezien = new Set();
    while (ouderVan.has(m) && !gezien.has(m)) { gezien.add(m); m = ouderVan.get(m); }
    return m;
  };
  const groepen = new Map(); // root -> members (root first)
  for (const [kind] of ouderVan) {
    const w = wortel(kind);
    if (w === kind) continue; // a cycle
    if (!groepen.has(w)) groepen.set(w, [w]);
    groepen.get(w).push(kind);
  }
  for (const [w, leden] of groepen) {
    const sleutels = w._groupKeys || {};
    const top = {
      id: w.groupId || w.id,
      name: typeof sleutels.name === 'string' && sleutels.name.trim() ? sleutels.name : DEFAULT_GROUP_NAME,
      dominant: w.id,
    };
    const paden = eigenPaden(leden);
    for (const lid of leden) {
      const onder = paden ? paden.get(lid) : [];
      lid.groupId = top.id;
      lid.groupPath = [top, ...onder].map((g) => ({ ...g }));
    }
  }
  for (const m of models || []) if (m) delete m._groupKeys;
  for (const { converted } of items || []) if (converted) delete converted._groupKeys;
  return [...groepen.values()].reduce((n, l) => n + l.length - 1, 0);
}

// The levels below the top from /OPS_GroupPathV1, when every member has the
// same top-level id there; else null (one flat group).
function eigenPaden(leden) {
  const paden = leden.map((l) => l._groupKeys?.path);
  if (paden.some((p) => !Array.isArray(p) || !p.length)) return null;
  if (new Set(paden.map((p) => p[0].id)).size !== 1) return null;
  const dominantVan = new Map();
  leden.forEach((l, i) => {
    for (const g of paden[i]) if (g.dominant && !dominantVan.has(g.id)) dominantVan.set(g.id, l.id);
  });
  return new Map(leden.map((l, i) => [l, paden[i].slice(1).map((g) => ({
    id: g.id, name: g.name || DEFAULT_GROUP_NAME, dominant: dominantVan.get(g.id) ?? null,
  }))]));
}

// --- Save --------------------------------------------------------------------

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function nmVoor(id, gebruikt) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  for (;;) {
    let s = '';
    let x = h;
    for (let i = 0; i < 16; i++) { s += ALPHA[x % 26]; x = Math.imul(x ^ (x >>> 13), 2654435761) >>> 0 || 1; }
    if (!gebruikt.has(s)) { gebruikt.add(s); return s; }
    h = (h + 1) >>> 0;
  }
}

const isGroepKind = (d) => d.get(N('RT'))?.toString() === '/Group';

function nmVan(context, dict) {
  return tekst(context, dict.get(N('NM'))) || '';
}

/**
 * Write the group keys of one page. `written` maps a model id to the
 * dictionary the saver wrote for it ({ ref, dict }); `kept` maps a model id
 * to the reference of an untouched the external editor markup that stays as it is. Kept
 * dictionaries are only changed when their group really changed (a member
 * left, the dominant was deleted, the name changed).
 * Correction markups (caret, strike) keep their own /IRT (correction-dicts.js).
 * @param {import('pdf-lib').PDFContext} context
 * @param {object[]} pageAnnotations
 * @param {Map<string, {ref: PDFRef, dict: PDFDict}>} written
 * @param {Map<string, PDFRef>} kept
 */
export function writeMarkupGroups(context, pageAnnotations, written, kept) {
  const cg = correctionGroupIds(pageAnnotations);
  const isCorrectie = (a) => a.type === 'caret' || a.type === 'textStrikethrough';
  const dictVan = (a) => {
    if (written.has(a.id)) return { ...written.get(a.id), eigen: true };
    const ref = kept.get(a.id);
    const dict = ref ? context.lookup(ref) : null;
    return dict instanceof PDFDict ? { ref, dict, eigen: false } : null;
  };
  // Every /NM on the page, so a new one is unique.
  const gebruikt = new Set();
  for (const a of pageAnnotations) {
    const d = dictVan(a)?.dict;
    const nm = d ? nmVan(context, d) : '';
    if (nm) gebruikt.add(nm);
  }

  const groepen = new Map(); // top id -> members on this page
  for (const a of pageAnnotations) {
    if (isCorrectie(a)) continue;
    const pad = groupPathOf(a, cg);
    if (!pad.length || !dictVan(a)) continue;
    if (!groepen.has(pad[0].id)) groepen.set(pad[0].id, []);
    groepen.get(pad[0].id).push(a);
  }
  const inGroep = new Set();
  for (const [, leden] of groepen) {
    // A group left with one markup on this page (its dominant or the other
    // members deleted) is no group: that markup loses its group keys, also
    // when its dictionary is kept, so no /IRT points at a deleted markup.
    if (leden.length < 2) {
      const { dict } = dictVan(leden[0]);
      dict.delete(N('GroupNesting'));
      dict.delete(N('OPS_GroupPathV1'));
      if (isGroepKind(dict)) { dict.delete(N('IRT')); dict.delete(N('RT')); }
      continue;
    }
    for (const a of leden) inGroep.add(a);
    const top = groupPathOf(leden[0], cg)[0];
    const dom = leden.find((a) => a.id === top.dominant) || leden[0];
    const domD = dictVan(dom);
    for (const a of leden) {
      const d = dictVan(a);
      if (!nmVan(context, d.dict)) d.dict.set(N('NM'), PDFString.of(nmVoor(a.id, gebruikt)));
    }
    const nms = leden.filter((a) => a !== dom).map((a) => nmVan(context, dictVan(a).dict));
    const naam = top.name || DEFAULT_GROUP_NAME;
    const genest = leden.some((a) => groupPathOf(a, cg).length > 1);

    // The dominant: /GroupNesting, no /IRT of a group.
    const gn = readGroupKeys(domD.dict, context);
    const andereNms = (gn?.nms || []).filter((n) => n !== nmVan(context, domD.dict));
    const gnKlopt = gn && gn.name === naam && andereNms.length === nms.length
      && nms.every((n) => andereNms.includes(n));
    if (!gnKlopt) {
      domD.dict.set(N('GroupNesting'), context.obj([pdfTextString(naam), N(nmVan(context, domD.dict)), ...nms.map((n) => N(n))]));
    }
    if (isGroepKind(domD.dict)) { domD.dict.delete(N('IRT')); domD.dict.delete(N('RT')); }

    for (const a of leden) {
      const d = dictVan(a);
      if (a !== dom) {
        d.dict.delete(N('GroupNesting'));
        // An untouched member may point at the dominant through a chain.
        if (!(d.eigen ? false : leidtNaar(context, d.dict, domD.ref))) {
          d.dict.set(N('IRT'), domD.ref);
          d.dict.set(N('RT'), N('Group'));
        }
      }
      // OcuDraw's levels; only written where the file can carry them anew.
      if (genest || d.eigen) schrijfPad(context, d.dict, groupPathOf(a, cg), a.id, genest);
    }
  }
  // Written markups that are in no group: no stale group keys.
  for (const a of pageAnnotations) {
    if (inGroep.has(a) || isCorrectie(a) || !written.has(a.id)) continue;
    const { dict } = written.get(a.id);
    dict.delete(N('GroupNesting'));
    dict.delete(N('OPS_GroupPathV1'));
    if (isGroepKind(dict)) { dict.delete(N('IRT')); dict.delete(N('RT')); }
  }
}

function leidtNaar(context, dict, doelRef) {
  let d = dict;
  const gezien = new Set();
  for (let i = 0; i < MAX_NIVEAUS && d instanceof PDFDict && isGroepKind(d); i++) {
    const irt = d.get(N('IRT'));
    if (!(irt instanceof PDFRef)) return false;
    if (irt === doelRef || irt.toString() === doelRef.toString()) return true;
    if (gezien.has(irt.toString())) return false;
    gezien.add(irt.toString());
    d = context.lookup(irt);
  }
  return false;
}

function schrijfPad(context, dict, pad, id, genest) {
  // A flat group in a written dictionary: the external editor's keys say it all, but the key
  // marks the dictionary as OcuDraw's (not an external editor markup to pass through).
  if (!genest && dict.get(N('OPS_RevuOrigin'))) { dict.delete(N('OPS_GroupPathV1')); return; }
  dict.set(N('OPS_GroupPathV1'), context.obj(pad.map((g) => context.obj([
    pdfTextString(g.id), pdfTextString(g.name || ''), g.dominant === id ? PDFBool.True : PDFBool.False,
  ]))));
}

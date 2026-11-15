// What an external plan-review program writes on every markup, written by OcuDraw too, so a
// markup made or edited in OcuDraw opens in the external editor as a native, editable the external editor
// markup (docs/reference/editor/markup-interop.md, "Markups made in OcuDraw").
//
// external plan-review files writes on each markup: /P (its page), /NM (a unique name),
// /Subj (the Markups list Subject), /T, /CreationDate and /M as PDF dates,
// /F, /AP /N, and for a measurement a /Measure with /X, /D and /A. A FreeText
// carries /DS and /RC with the same text as /Contents.
//
// The saver calls extNatief() once per written markup, after the external editor
// carry-over (ext-behoud.js), so a key the external editor already wrote wins.

import { PDFName, PDFDict, PDFString, PDFHexString, PDFArray, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfTextString, decodePdfTextObject } from './pdf-text.js';
import { pdfDatum } from './ext-behoud.js';

const N = (s) => PDFName.of(s);

/** the external editor's default Subject per OcuDraw markup type (external plan-review files tool names). */
export function extOnderwerp(ann) {
  if (!ann) return '';
  if (ann.measureKind === 'raceway') return ann.raceway?.kind === 'tray' ? 'Cable Tray' : 'Conduit';
  switch (ann.type) {
    case 'box': return 'Rectangle';
    case 'circle': return 'Ellipse';
    case 'cloud': case 'cloudPolyline': return 'Cloud';
    case 'polygon': return 'Polygon';
    case 'polyline': return 'Polyline';
    case 'line': return 'Line';
    case 'arrow': return 'Arrow';
    case 'draw': return 'Pen';
    case 'highlight': case 'textHighlight': return 'Highlight';
    case 'textUnderline': return 'Underline';
    case 'textStrikethrough': return 'Strikeout';
    case 'textSquiggly': return 'Squiggly';
    case 'textbox': return ann.noWrap ? 'Typewritten Text' : 'Text Box';
    case 'callout': return 'Callout';
    case 'comment': return 'Note';
    case 'count': return 'Count';
    case 'measureDistance': return 'Length Measurement';
    case 'measureArea': return 'Area Measurement';
    case 'measurePerimeter': return 'Perimeter Measurement';
    case 'measureAngle': return 'Angle Measurement';
    case 'image': return 'Image';
    case 'mask': return 'Wipeout';
    case 'arc': return 'Arc';
    case 'spline': case 'splineArrow': return 'Polyline';
    default: return '';
  }
}

function tekst(context, raw) {
  const v = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (!v) return undefined;
  return decodePdfTextObject(v) ?? (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined);
}

/** A model date (ISO text) as a PDF date, or null when it is not a date. */
function alsPdfDatum(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : pdfDatum(d);
}

let teller = 0;
/** A new /NM: unique per page, never mistaken for an external editor name (16 capitals). */
export function nieuweNm() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  teller += 1;
  return `ocu-${Date.now().toString(36)}-${teller.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const XML = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * /RC for a text: the body element of `bronRc` (the external editor's styling) when given,
 * else one built from `stijl`; a paragraph per line, as the external editor writes it.
 * @param {string} tekstInhoud  the /Contents text
 * @param {{ bronRc?: string, stijl?: string }} opties
 */
export function rcVoorTekst(tekstInhoud, { bronRc, stijl } = {}) {
  const regels = String(tekstInhoud ?? '').replace(/\r\n?/g, '\n').split('\n');
  const alinea = (r) => (r ? `<p>${XML(r)}</p>` : '<p>&#160;</p>');
  let body = /<body\b[^>]*>/i.exec(bronRc || '')?.[0];
  if (body && /\/>$/.test(body)) body = body.replace(/\s*\/>$/, '>');
  if (!body) {
    body = `<body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:contentType="text/html" xfa:APIVersion="OcuDraw:1" xfa:spec="2.2.0"${stijl ? ` style="${XML(stijl).replace(/"/g, '&quot;')}"` : ''}>`;
  }
  return `<?xml version="1.0"?>${body}${regels.map(alinea).join('')}</body>`;
}

/** Plain text of an /RC body (paragraphs as lines), for comparing with /Contents. */
export function rcPlatteTekst(rc) {
  if (typeof rc !== 'string') return '';
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(rc)?.[1] ?? rc;
  return body
    .replace(/<p\b[^>]*\/>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#160;|&nbsp;/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n$/, '');
}

const zonderWit = (s) => String(s ?? '').replace(/\s+/g, '');

// ── Measurement scale for the external editor ───────────────────────────────────────────

function oppervlak(punten) {
  let s = 0;
  for (let i = 0; i < punten.length; i++) {
    const a = punten[i];
    const b = punten[(i + 1) % punten.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function lengte(punten) {
  let s = 0;
  for (let i = 1; i < punten.length; i++) s += Math.hypot(punten[i].x - punten[i - 1].x, punten[i].y - punten[i - 1].y);
  return s;
}

/** The linear unit of a measurement unit text: 'm²' -> 'm', 'sq ft' -> 'ft'. */
export function lineaireEenheid(unit) {
  return String(unit || '').replace(/^sq\.?\s*/i, '').replace(/\s*(²|\^2|2)$/, '').trim();
}

/**
 * The scale of an OcuDraw measurement as units per PDF point, from its value
 * and its geometry (model points are page points). Null when it cannot be
 * known (no value, no geometry).
 */
export function schaalVanMeting(ann) {
  const v = Number(ann?.measureValue);
  if (!Number.isFinite(v) || v <= 0) return null;
  let geo = 0;
  if (ann.type === 'measureArea' && Array.isArray(ann.points) && ann.points.length >= 3) {
    geo = oppervlak(ann.points);
    for (const gat of Array.isArray(ann.holes) ? ann.holes : []) if (Array.isArray(gat) && gat.length >= 3) geo -= oppervlak(gat);
    return geo > 0 ? Math.sqrt(v / geo) : null;
  }
  if (ann.type === 'measurePerimeter' && Array.isArray(ann.points) && ann.points.length >= 2) geo = lengte(ann.points);
  else if (ann.type === 'measureDistance') geo = Math.hypot((ann.endX ?? 0) - (ann.startX ?? 0), (ann.endY ?? 0) - (ann.startY ?? 0));
  return geo > 0 ? v / geo : null;
}

function getalOpmaak(context, eenheid, c, decimalen) {
  return context.obj({
    Type: N('NumberFormat'), U: PDFString.of(eenheid), C: PDFNumber.of(c),
    F: N('D'), D: PDFNumber.of(10 ** decimalen), SS: PDFString.of(''),
  });
}

/**
 * A /Measure /RL for an OcuDraw measurement, as the external editor writes one: /R label,
 * /X (units per point), /D distance and /A area formats. /OPS_RevuMeasure
 * marks it as derived from the model (the loader keeps the model's scale).
 */
export function measureVoorMeting(context, ann) {
  const f = schaalVanMeting(ann);
  if (!(f > 0)) return null;
  const unit = lineaireEenheid(ann.measureUnit) || 'pt';
  const p = Number.isInteger(ann.measurePrecision) && ann.measurePrecision >= 0 && ann.measurePrecision <= 6
    ? ann.measurePrecision : 2;
  const rond = (x) => Math.round(x * 1e9) / 1e9;
  const m = context.obj({
    Type: N('Measure'),
    Subtype: N('RL'),
    R: PDFString.of(`1 pt = ${rond(f)} ${unit}`),
    X: context.obj([getalOpmaak(context, unit, rond(f), 4)]),
    D: context.obj([getalOpmaak(context, unit, 1, p)]),
    A: context.obj([getalOpmaak(context, ann.type === 'measureArea' && ann.measureUnit ? String(ann.measureUnit) : `sq ${unit}`, 1, p)]),
  });
  m.set(N('OPS_RevuMeasure'), context.obj(true));
  return m;
}

/** Complete a /Measure that has /X but no /D or /A (OcuDraw's dimension line). */
function vulMeasureAan(context, measure, ann) {
  const x = measure.lookup(N('X'));
  const x0 = x instanceof PDFArray ? x.lookup(0) : null;
  const unit = (x0 instanceof PDFDict ? tekst(context, x0.get(N('U'))) : '') || lineaireEenheid(ann.measureUnit) || 'pt';
  const p = Number.isInteger(ann.measurePrecision) ? ann.measurePrecision : 2;
  if (!measure.get(N('Type'))) measure.set(N('Type'), N('Measure'));
  if (!measure.get(N('D'))) measure.set(N('D'), context.obj([getalOpmaak(context, unit, 1, p)]));
  if (!measure.get(N('A'))) measure.set(N('A'), context.obj([getalOpmaak(context, `sq ${unit}`, 1, p)]));
}

/**
 * Make a written markup dictionary carry what the external editor writes on its own markups.
 * Keys already in the dictionary win (the external editor's carried keys, the saver's own).
 * @param {import('pdf-lib').PDFContext} context
 * @param {import('pdf-lib').PDFDict} dict  the annotation dictionary as it goes into /Annots
 * @param {object} ann  the model (its `nm` is set when a new /NM is made, so the next save keeps it)
 * @param {{ paginaRef?: PDFRef, gebruikteNm?: Set<string>, behoudenNm?: Set<string>, bronDict?: PDFDict|null }} opties
 *   gebruikteNm: names written on this page so far; behoudenNm: names of the markups kept as they are.
 *   bronDict: the external editor's dictionary this one rewrites (its /RC styling is kept).
 */
export function extNatief(context, dict, ann, { paginaRef, gebruikteNm, behoudenNm, bronDict = null } = {}) {
  if (!(dict instanceof PDFDict) || !ann) return;
  const subtype = dict.get(N('Subtype'))?.toString();
  if (!subtype || subtype === '/Popup' || subtype === '/Link' || subtype === '/Widget') return;
  if (paginaRef instanceof PDFRef) dict.set(N('P'), paginaRef);

  // /NM: kept from the file (the external editor's, or one OcuDraw wrote before), else new.
  const bestaand = tekst(context, dict.get(N('NM')));
  if (bestaand) {
    gebruikteNm?.add(bestaand);
  } else {
    let nm = typeof ann.nm === 'string' && ann.nm ? ann.nm : '';
    if (!nm || gebruikteNm?.has(nm) || behoudenNm?.has(nm)) nm = nieuweNm();
    gebruikteNm?.add(nm);
    dict.set(N('NM'), pdfTextString(nm));
    if (!ann.extBron) ann.nm = nm;
  }

  // the external editor's own markup without /Subj (external plan-review files writes none on some
  // rectangles) stays without one.
  const bronZonderSubj = bronDict instanceof PDFDict && !bronDict.get(N('Subj'));
  if (!dict.get(N('Subj')) && !bronZonderSubj) {
    const onderwerp = extOnderwerp(ann);
    if (onderwerp) dict.set(N('Subj'), pdfTextString(onderwerp));
  }

  // Dates: PDF dates, from the model (an untouched markup keeps its dates
  // from save to save, instead of "now" every time).
  if (!dict.get(N('CreationDate'))) {
    dict.set(N('CreationDate'), PDFString.of(alsPdfDatum(ann.createdAt) || pdfDatum(new Date())));
  }
  const m = tekst(context, dict.get(N('M')));
  if (!m || !m.startsWith('D:')) dict.set(N('M'), PDFString.of(alsPdfDatum(ann.modifiedAt) || pdfDatum(new Date())));

  // FreeText: /RC with the text of /Contents (the external editor edits the rich text).
  if (subtype === '/FreeText') {
    const inhoud = tekst(context, dict.get(N('Contents'))) ?? '';
    const rc = tekst(context, dict.get(N('RC')));
    if (!rc || zonderWit(rcPlatteTekst(rc)) !== zonderWit(inhoud)) {
      const bronRc = bronDict instanceof PDFDict ? tekst(context, bronDict.get(N('RC'))) : undefined;
      const ds = tekst(context, dict.get(N('DS')));
      dict.set(N('RC'), pdfTextString(rcVoorTekst(inhoud, { bronRc, stijl: ds })));
    }
  }

  // A measurement: a full /Measure (the external editor needs /D or /A to show the value).
  const it = dict.get(N('IT'))?.toString() || '';
  if (/Dimension$/.test(it)) {
    const measure = dict.lookup(N('Measure'));
    if (measure instanceof PDFDict) {
      if (measure.get(N('X')) && (!measure.get(N('D')) || !measure.get(N('A')))) vulMeasureAan(context, measure, ann);
    } else {
      const nieuw = measureVoorMeting(context, ann);
      if (nieuw) dict.set(N('Measure'), nieuw);
    }
    // the external editor shows the value of its measurement from /RC: the new value, in
    // the external editor's styling.
    const inhoud = tekst(context, dict.get(N('Contents')));
    const rc = tekst(context, dict.get(N('RC')))
      ?? (bronDict instanceof PDFDict ? tekst(context, bronDict.get(N('RC'))) : undefined);
    if (inhoud && rc && zonderWit(rcPlatteTekst(rc)) !== zonderWit(inhoud)) {
      dict.set(N('RC'), pdfTextString(rcVoorTekst(inhoud, { bronRc: rc })));
    } else if (rc && !dict.get(N('RC'))) dict.set(N('RC'), pdfTextString(rc));
  }

  // A rewritten the external editor markup: keys OcuDraw does not write for this subtype
  // stay as the external editor wrote them (label style of a measurement, line-ending fill).
  if (bronDict instanceof PDFDict) {
    behoudExtRotatie(context, dict, ann, bronDict, subtype);
    if (subtype !== '/FreeText' && !dict.get(N('DS')) && bronDict.get(N('DS'))) dict.set(N('DS'), bronDict.get(N('DS')));
    if ((subtype === '/PolyLine' || subtype === '/Line') && !dict.get(N('IC')) && bronDict.get(N('IC'))) dict.set(N('IC'), bronDict.get(N('IC')));
  }
}

/**
 * the external editor's /Rotation of a rewritten markup, when it is a quarter turn (a sheet
 * marked up in a turned view: every markup carries /Rotation 90). the external editor turns
 * labels, hatching and handles with it. A box or ellipse keeps it as is (its
 * /Rect is the same either way); a polygon or polyline is written as the external editor
 * keeps it: unturned /Vertices plus /Rotation (the loader turns them back,
 * ext-load.js). A quarter turn keeps the centre of the bounding box, so the
 * shown points turn back exactly. Other angles: the turned vertices only.
 */
function behoudExtRotatie(context, dict, ann, bronDict, subtype) {
  if (dict.get(N('Rotation')) !== undefined) return;
  const r = bronDict.lookup(N('Rotation'));
  const graden = r instanceof PDFNumber ? r.asNumber() : NaN;
  if (!Number.isFinite(graden)) return;
  const kwart = ((Math.round(graden) % 360) + 360) % 360;
  if (Math.abs(graden - Math.round(graden)) > 1e-6 || kwart % 90 !== 0) return;
  if (kwart === 0) { dict.set(N('Rotation'), r); return; }
  if (subtype === '/Square' || subtype === '/Circle') {
    // The model holds the external editor's turn as its own rotation (the loader read it);
    // a box the user turned to another angle does not keep the external editor's.
    const eigen = ((Math.round(Number(ann.rotation) || 0) % 360) + 360) % 360;
    if (eigen === kwart) dict.set(N('Rotation'), r);
    return;
  }
  if (subtype !== '/Polygon' && subtype !== '/PolyLine') return;
  const v = dict.lookup(N('Vertices'));
  const getallen = v instanceof PDFArray ? v.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN)) : [];
  if (getallen.length < 4 || getallen.some((x) => !Number.isFinite(x))) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < getallen.length; i += 2) {
    minX = Math.min(minX, getallen[i]); maxX = Math.max(maxX, getallen[i]);
    minY = Math.min(minY, getallen[i + 1]); maxY = Math.max(maxY, getallen[i + 1]);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Shown = turned by -r about the centre (extGedraaidePunten); back: +r.
  const [cos, sin] = [[1, 0], [0, 1], [-1, 0], [0, -1]][kwart / 90];
  const terug = [];
  for (let i = 0; i < getallen.length; i += 2) {
    const dx = getallen[i] - cx;
    const dy = getallen[i + 1] - cy;
    terug.push(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  }
  dict.set(N('Vertices'), context.obj(terug));
  dict.set(N('Rotation'), r);
}

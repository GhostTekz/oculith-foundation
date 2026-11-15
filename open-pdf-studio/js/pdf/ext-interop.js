// externally marked PDFs (docs/reference/editor/markup-interop.md).
//
// an external plan-review program writes markups with standard PDF keys plus its own private
// keys (/FillOpacity, /BM, /GroupNesting, /SlopeType, /Measure extras, ...).
// OcuDraw models most of what such a markup shows, but not everything the external editor
// needs to treat it as its own markup again. Three rules keep an external editor file
// intact:
//
// 1. A the external editor markup the user did not change is written back as the very same
//    object: the saver keeps its reference in /Annots (pass-through). Its
//    dictionary, appearance stream and everything it points to stay as the external editor
//    wrote them.
// 2. A the external editor markup the user did change is rewritten from the model, at the
//    SAME object number (so /IRT group links, /Popup /Parent and the external editor's own
//    references stay valid), and every key the app does not own is copied
//    over from the source dictionary.
// 3. An image markup (SquareImage, StampSnapshot) keeps its original
//    appearance stream when only its place or size changed: viewers map the
//    appearance onto the new /Rect, so the image is never re-encoded.
//
// This module holds the pure parts shared by the loader and the saver.

import {
  PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber, PDFBool, decodePDFRawStream,
} from 'pdf-lib';
import { leesGetalOpmaak } from './ext-getalopmaak.js';

/** the external editor-only keys seen in external plan-review files markups (all preserved). */
export const EXT_PRIVATE_KEYS = [
  'FillOpacity', 'BM', 'GroupNesting', 'SlopeType', 'PitchRun', 'Rotation',
  'AlignOnSegment', 'MeasurementTypes', 'Label', 'DepthUnit', 'LEIC', 'LES',
  'SetOpacityFromStampFile', 'Image', 'TargetUnitConversion', 'CountStyle',
  'SnapshotMode', 'PageRotation',
];

/** /IT values that only the external editor writes (spelling included). */
const EXT_INTENTS = new Set(['FreeTextTypeWriter', 'StampSnapshot', 'SquareImage', 'LineArrow', 'SquareCount', 'CircleCount']);

/**
 * Standard keys the saver writes from the model (or deliberately leaves out,
 * e.g. /IC when the user removed the fill). A rewrite never copies these from
 * the source; everything else is carried over.
 */
export const APP_OWNED_KEYS = new Set([
  'Type', 'Subtype', 'Rect', 'Contents', 'T', 'M', 'C', 'IC', 'CA', 'ca', 'BS', 'Border', 'BE',
  'AP', 'AS', 'Vertices', 'L', 'LE', 'LL', 'LLE', 'LLO', 'Cap', 'CP', 'CO', 'CL', 'DA', 'DS', 'RC', 'Q', 'RD',
  'QuadPoints', 'InkList', 'Name', 'Open', 'F', 'OC', 'P', 'Parent', 'Path', 'Sy', 'State', 'StateModel',
  'FillOpacity', 'BM', 'Rotation',
]);

/** Keys a COPY of an external editor markup must not take over (identity and grouping). */
const IDENTITY_KEYS = new Set(['NM', 'GroupNesting', 'IRT', 'RT', 'Popup']);

const N = (s) => PDFName.of(s);

function tekst(v) {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}

function getal(context, raw) {
  const v = raw instanceof PDFRef ? context.lookup(raw) : raw;
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function sleutels(dict) {
  return dict.keys().map((k) => k.asString().slice(1));
}

/**
 * Was this annotation dictionary written by the external editor? Strong signals are the external editor's
 * own keys, /IT values and rich text; a plain the external editor markup (a rectangle
 * without private keys) is recognised by its 16-letter /NM in a file that
 * the external editor produced or whose /M is still a PDF date. A dictionary OcuDraw wrote
 * from an external editor markup carries /OPS_RevuOrigin.
 * @param {import('pdf-lib').PDFDict} dict
 * @param {import('pdf-lib').PDFContext} context
 * @param {{ producerIsExt?: boolean }} [opties]
 */
export function isExtAnnotDict(dict, context, { producerIsExt = false } = {}) {
  if (!(dict instanceof PDFDict)) return false;
  const namen = sleutels(dict);
  if (namen.includes('OPS_RevuOrigin')) return true;
  // /GroupNesting next to /OPS_GroupPathV1 is a group OcuDraw wrote (markup-group-pdf.js).
  const eigenGroep = namen.includes('OPS_GroupPathV1');
  // OcuDraw's own markup (its keys, no the external editor origin): the external editor's /IT spelling
  // (FreeTextTypeWriter) on it does not make it an external editor markup.
  const eigen = namen.some((k) => k.startsWith('OPS_'));
  if (namen.some((k) => k === 'FillOpacity' || (k === 'GroupNesting' && !eigenGroep) || k === 'SlopeType' || k === 'PitchRun'
    || k === 'AlignOnSegment' || k === 'MeasurementTypes' || k === 'DepthUnit' || k === 'SetOpacityFromStampFile'
    || k === 'LEIC' || k === 'LES')) return true;
  const it = dict.get(N('IT'));
  if (!eigen && it instanceof PDFName && EXT_INTENTS.has(it.decodeText())) return true;
  const rc = tekst(context.lookup(dict.get(N('RC'))));
  if (rc && rc.includes('BluebeamPDFRevu')) return true;
  if (namen.some((k) => k.startsWith('OPS_'))) return false;
  const nm = tekst(context.lookup(dict.get(N('NM'))));
  if (!nm || !/^[A-Z]{16}$/.test(nm)) return false;
  if (producerIsExt) return true;
  const m = tekst(context.lookup(dict.get(N('M'))));
  return !!m && m.startsWith('D:');
}

/** Producer/Creator of the document mention an external publisher or the external editor. */
export function producerIsExt(pdfDoc) {
  try {
    const s = `${pdfDoc.getProducer?.() || ''} ${pdfDoc.getCreator?.() || ''}`;
    return /bluebeam|revu/i.test(s);
  } catch { return false; }
}

/** "12 0 R" for a reference, the key the saver and loader share. */
export const refTag = (ref) => (ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber} R` : null);
/** pdf.js annotation id ("12R", "12R3") as a reference tag. */
export function refTagUitPdfjsId(id) {
  const m = /^(\d+)R(\d*)$/.exec(String(id || ''));
  return m ? `${m[1]} ${m[2] || 0} R` : null;
}

function rectTekst(context, dict) {
  const r = context.lookup(dict.get(N('Rect')));
  if (!(r instanceof PDFArray)) return '';
  return r.asArray().map((n) => {
    const v = getal(context, n);
    return v === undefined ? '?' : Math.round(v * 1000) / 1000;
  }).join(',');
}

/**
 * A the external editor number-format array (/X, /D, /A, ...): the conversion factors
 * multiply along the chain, the first element names the unit.
 */
function leesNumberFormat(context, raw) {
  const arr = context.lookup(raw);
  if (!(arr instanceof PDFArray) || arr.size() === 0) return null;
  const eerste = context.lookup(arr.get(0));
  if (!(eerste instanceof PDFDict)) return null;
  const c = getal(context, eerste.get(N('C')));
  if (!(c > 0)) return null;
  const d = getal(context, eerste.get(N('D')));
  return {
    factor: c,
    unit: tekst(context.lookup(eerste.get(N('U')))) || '',
    ...(d > 0 ? { denominator: d } : {}),
  };
}

/**
 * The scale of an external editor measurement (/Measure /RL): label (/R), page-point
 * factor (/X) and the distance and area formats.
 * @returns {{ label: string, xFactor: number, xUnit: string, area?: object, distance?: object }|null}
 */
export function leesExtMeasure(context, raw) {
  const m = context.lookup(raw);
  if (!(m instanceof PDFDict)) return null;
  if (m.get(N('Subtype'))?.toString() !== '/RL') return null;
  const x = leesNumberFormat(context, m.get(N('X')));
  if (!x) return null;
  const area = leesNumberFormat(context, m.get(N('A')));
  const distance = leesNumberFormat(context, m.get(N('D')));
  // The whole chain (feet-inches, fractions): the external editor's text (ext-getalopmaak.js).
  const areaChain = leesGetalOpmaak(context, m.get(N('A')));
  const distanceChain = leesGetalOpmaak(context, m.get(N('D')));
  return {
    label: tekst(context.lookup(m.get(N('R')))) || '',
    xFactor: x.factor,
    xUnit: x.unit,
    ...(area ? { area } : {}),
    ...(distance ? { distance } : {}),
    ...(areaChain ? { areaChain } : {}),
    ...(distanceChain ? { distanceChain } : {}),
  };
}

/** Area of a polygon (PDF points) in the external editor's area unit. */
export function extOppervlak(puntenPdf, measure) {
  if (!measure || !Array.isArray(puntenPdf) || puntenPdf.length < 3) return null;
  let s = 0;
  for (let i = 0; i < puntenPdf.length; i++) {
    const a = puntenPdf[i];
    const b = puntenPdf[(i + 1) % puntenPdf.length];
    s += a.x * b.y - b.x * a.y;
  }
  const f = measure.xFactor * measure.xFactor * (measure.area?.factor ?? 1);
  return Math.abs(s) / 2 * f;
}

/** Length of an open (or closed) path (PDF points) in the external editor's distance unit. */
export function extLengte(puntenPdf, measure, { gesloten = false } = {}) {
  if (!measure || !Array.isArray(puntenPdf) || puntenPdf.length < 2) return null;
  let s = 0;
  const n = gesloten ? puntenPdf.length : puntenPdf.length - 1;
  for (let i = 0; i < n; i++) {
    const a = puntenPdf[i];
    const b = puntenPdf[(i + 1) % puntenPdf.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s * measure.xFactor;
}

/** Decimals that the external editor's denominator (/D 1000 = 0.001) stands for. */
export function extDecimalen(fmt) {
  const d = fmt?.denominator;
  if (!(d > 1)) return 2;
  return Math.max(0, Math.min(6, Math.round(Math.log10(d))));
}

/** the external editor's display: thousands separators, the external editor's decimals, the external editor's unit. */
export function formatExtWaarde(waarde, fmt) {
  if (!Number.isFinite(waarde)) return '';
  const dec = extDecimalen(fmt);
  const s = waarde.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dec });
  return fmt?.unit ? `${s} ${fmt.unit}` : s;
}

/**
 * What the loader needs from an external editor markup: identity (reference, /NM,
 * /Rect, subtype) and the private keys OcuDraw shows.
 * @param {import('pdf-lib').PDFDict} dict
 * @param {import('pdf-lib').PDFRef} ref
 * @param {import('pdf-lib').PDFContext} context
 */
export function leesExtExtra(dict, ref, context) {
  const extra = {
    ref: refTag(ref),
    nm: tekst(context.lookup(dict.get(N('NM')))) || '',
    subtype: dict.get(N('Subtype'))?.toString() || '',
    rect: rectTekst(context, dict),
    keys: sleutels(dict).filter((k) => EXT_PRIVATE_KEYS.includes(k)),
  };
  const it = dict.get(N('IT'));
  if (it instanceof PDFName) extra.intent = it.decodeText();
  // the external editor's eigen uiterlijk: een /AP /N en geen OcuDraw-sleutels (een door
  // OcuDraw herschreven markering draagt OcuDraw's appearance). Zie
  // ap-render-state.js.
  {
    const apDict = context.lookup(dict.get(N('AP')));
    const apN = apDict instanceof PDFDict ? context.lookup(apDict.get(N('N'))) : null;
    if ((apN instanceof PDFStream || apN instanceof PDFDict)
        && !sleutels(dict).some((k) => k.startsWith('OPS_'))) extra.eigenAp = true;
  }
  const subj = tekst(context.lookup(dict.get(N('Subj'))));
  if (subj) extra.subj = subj;
  if (!tekst(context.lookup(dict.get(N('Contents'))))) extra.zonderOpmerking = true;
  const fo = getal(context, dict.get(N('FillOpacity')));
  if (fo !== undefined && fo >= 0 && fo <= 1) extra.fillOpacity = fo;
  const bm = context.lookup(dict.get(N('BM')));
  if (bm instanceof PDFName) extra.blendMode = bm.decodeText();
  const rot = getal(context, dict.get(N('Rotation')));
  if (rot !== undefined && Number.isFinite(rot)) extra.rotation = rot;
  // Image markups: how the appearance maps its form onto /Rect (rotation and
  // scale of the picture, which /Rect alone does not tell).
  if (extra.intent === 'StampSnapshot' || extra.intent === 'SquareImage' || extra.subtype === '/Stamp') {
    const ap = context.lookup(dict.get(N('AP')));
    const n = ap instanceof PDFDict ? context.lookup(ap.get(N('N'))) : null;
    const nDict = n instanceof PDFStream ? n.dict : null;
    const getallen = (raw) => {
      const a = context.lookup(raw);
      if (!(a instanceof PDFArray)) return null;
      const v = a.asArray().map((x) => getal(context, x));
      return v.every(Number.isFinite) ? v : null;
    };
    const matrix = nDict ? getallen(nDict.get(N('Matrix'))) : null;
    const bbox = nDict ? getallen(nDict.get(N('BBox'))) : null;
    if (bbox && bbox.length === 4) {
      extra.apBBox = bbox;
      extra.apMatrix = matrix && matrix.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
    }
  }
  const measure = leesExtMeasure(context, dict.get(N('Measure')));
  if (measure) extra.measure = measure;
  // A the external editor measurement whose appearance draws no text shows no caption on
  // the drawing (the value is only in the Markups list): OcuDraw must not
  // add one, or the labels pile up over the drawing.
  if (dict.get(N('Measure')) !== undefined && apZonderTekst(context, dict)) extra.zonderBijschrift = true;
  const riseDrop = getal(context, dict.get(N('RiseDrop')));
  if (riseDrop !== undefined && riseDrop !== 0) extra.riseDrop = riseDrop;
  const naam = tekst(context.lookup(dict.get(N('Label'))));
  if (naam) extra.measureLabel = naam;
  const ds = tekst(context.lookup(dict.get(N('DS'))));
  if (ds) {
    const h = /text-align\s*:\s*(left|center|right)/i.exec(ds);
    if (h) extra.textAlign = h[1].toLowerCase();
    const v = /text-valign\s*:\s*(top|middle|bottom)/i.exec(ds);
    if (v) extra.textVAlign = v[1].toLowerCase();
  }
  return extra;
}

const TEKST_OPERATOR = /(?:^|[\s\])>])(?:Tj|TJ|'|")(?=[\s]|$)/;

/** Does a content stream show text (Tj, TJ, ' or ")? Null when it cannot be read. */
function toontTekst(stream) {
  if (!(stream instanceof PDFRawStream)) return stream instanceof PDFStream ? null : false;
  try {
    const bytes = decodePDFRawStream(stream).decode();
    let tekst = '';
    for (let i = 0; i < bytes.length; i += 8192) tekst += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return TEKST_OPERATOR.test(tekst);
  } catch {
    return null;
  }
}

/**
 * Is the normal appearance of this dictionary free of text, its form
 * XObjects (one level down) included? False when there is none or when a
 * stream cannot be read: then OcuDraw draws the markup as before.
 */
export function apZonderTekst(context, dict) {
  const ap = context.lookup(dict.get(N('AP')));
  const n = ap instanceof PDFDict ? context.lookup(ap.get(N('N'))) : null;
  if (!(n instanceof PDFStream)) return false;
  const eigen = toontTekst(n);
  if (eigen !== false) return false;
  const res = context.lookup(n.dict.get(N('Resources')));
  const xo = res instanceof PDFDict ? context.lookup(res.get(N('XObject'))) : null;
  if (xo instanceof PDFDict) {
    for (const [, ref] of xo.entries()) {
      const vorm = context.lookup(ref);
      if (vorm instanceof PDFStream && vorm.dict.get(N('Subtype'))?.toString() === '/Form' && toontTekst(vorm) !== false) return false;
    }
  }
  return true;
}

/**
 * the external editor stores a rotated polygon with its unrotated /Vertices and a clockwise
 * /Rotation in degrees about the centre of those vertices; /Rect and the
 * appearance show the rotated shape. Returns the vertices as displayed.
 * @param {Array<{x:number,y:number}>} punten  PDF points
 * @param {number} rotatie  the external editor /Rotation (degrees, clockwise)
 */
export function extGedraaidePunten(punten, rotatie) {
  if (!Array.isArray(punten) || punten.length === 0 || !Number.isFinite(rotatie)) return punten;
  if (Math.abs(((rotatie % 360) + 360) % 360) < 1e-9) return punten;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of punten) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rad = -rotatie * Math.PI / 180; // clockwise in the external editor = counter-clockwise negative
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return punten.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

// ── fingerprint ─────────────────────────────────────────────────────────────

/** Model keys that change without a user edit (render caches, load bookkeeping). */
const VLUCHTIG = new Set(['imageId', 'extBron']);

/**
 * A stable text of everything the user can change on a markup. Equal before
 * and after = the markup was not edited, so the saver may keep the external editor's object.
 */
export function vingerafdruk(model) {
  if (!model) return '';
  try {
    return JSON.stringify(model, (k, v) => {
      if (k && (k.startsWith('_') || VLUCHTIG.has(k))) return undefined;
      if (typeof v === 'function') return undefined;
      if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
      return v;
    });
  } catch {
    return '';
  }
}

/** What an image markup shows; equal = its appearance stream still fits. */
export function beeldVingerafdruk(model) {
  if (!model) return '';
  const { imageData, rotation, opacity, cropLeft, cropTop, cropRight, cropBottom, grayscale, brightness, contrast, flipH, flipV } = model;
  return JSON.stringify({ l: imageData?.length, h: typeof imageData === 'string' ? imageData.slice(-64) : null,
    rotation, opacity, cropLeft, cropTop, cropRight, cropBottom, grayscale, brightness, contrast, flipH, flipV });
}

/**
 * Remember, per loaded the external editor markup, how it looked when it was read. Called
 * by the loader once a page's models are final.
 * @param {object} doc
 * @param {object[]} modellen
 */
export function onthoudExtBron(doc, modellen) {
  if (!doc) return;
  if (!(doc._extBron instanceof Map)) doc._extBron = new Map();
  for (const m of modellen || []) {
    if (!m?.extBron?.ref) continue;
    doc._extBron.set(m.id, {
      ...m.extBron,
      sig: vingerafdruk(m),
      beeld: beeldVingerafdruk(m),
    });
  }
}

/**
 * Does the dictionary at `ref` still hold the markup the loader read?
 * Guards against reused object numbers after a structural rewrite.
 */
export function zelfdeBron(context, ref, bron) {
  const dict = context.lookup(ref);
  if (!(dict instanceof PDFDict) || !bron) return false;
  if ((dict.get(N('Subtype'))?.toString() || '') !== bron.subtype) return false;
  const nm = tekst(context.lookup(dict.get(N('NM')))) || '';
  if (nm !== (bron.nm || '')) return false;
  return true;
}

/**
 * Copy every key the app does not own from the external editor source dictionary into
 * the rewritten one. Keys already set by the app win. A copy (another markup
 * made from this one) does not take over identity and group keys.
 * @returns {string[]} the copied key names
 */
export function neemExtSleutelsOver(bron, doel, { kopie = false, overschrijf = [] } = {}) {
  if (!(bron instanceof PDFDict) || !(doel instanceof PDFDict)) return [];
  const gedaan = [];
  for (const [k, v] of bron.entries()) {
    const naam = k.asString().slice(1);
    if (kopie && IDENTITY_KEYS.has(naam)) continue;
    if (overschrijf.includes(naam)) { doel.set(k, v); gedaan.push(naam); continue; }
    if (APP_OWNED_KEYS.has(naam)) continue;
    if (doel.get(k) !== undefined) continue;
    doel.set(k, v);
    gedaan.push(naam);
  }
  doel.set(N('OPS_RevuOrigin'), PDFBool.True);
  return gedaan;
}

/** All indirect objects the source dictionary points at directly. */
export function directeVerwijzingen(dict) {
  const uit = [];
  const loop = (o) => {
    if (o instanceof PDFRef) uit.push(o);
    else if (o instanceof PDFArray) o.asArray().forEach(loop);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) loop(v);
    else if (o instanceof PDFStream) for (const [, v] of o.dict.entries()) loop(v);
  };
  if (dict instanceof PDFDict) for (const [, v] of dict.entries()) loop(v);
  return uit;
}

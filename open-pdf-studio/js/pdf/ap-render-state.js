// Ingelezen markeringen tonen met hun eigen uiterlijk (/AP) tot ze bewerkt
// worden.
//
// OcuDraw tekent markeringen zelf, uit zijn eigen model. Voor een markering
// die the external editor maakte is dat een benadering: een cirkel met een eigen symbool,
// hoekpuntbolletjes op een polylijn, een arcering of de opmaak van een
// tekstvak zien er in the external editor anders uit dan OcuDraw ze natekent. Het uiterlijk
// dat the external editor in het bestand schreef (/AP) is het echte beeld.
//
// Daarom tekent de pagina-render (PDF.js) zo'n markering uit haar /AP zolang
// de gebruiker haar niet veranderde, en slaat OcuDraw's eigen tekenlus haar
// over. Selecteren, aanklikken, de Markups List en opslaan werken gewoon op
// het model. Zodra het model afwijkt van wat er ingelezen werd (verplaatst,
// andere kleur, verwijderd, verborgen) tekent OcuDraw haar weer zelf en wordt
// de pagina één keer opnieuw getekend zonder haar /AP.
//
// Welke markeringen: externe markeringen (doc._extBron, zie ext-interop.js)
// waarvan het woordenboek een eigen /AP heeft en geen OcuDraw-sleutels
// (OPS_*): een door OcuDraw herschreven markering heeft OcuDraw's eigen
// appearance en blijft door OcuDraw getekend. "Onveranderd" is dezelfde
// vingerafdruk die de saver gebruikt om the external editor's object te bewaren.
//
// PDF.js: page.render() met annotationMode ENABLE tekent elke annotatie
// behalve die in annotationStorage.modifiedIds. Die getter vervangen we per
// document door "alle annotaties van de pagina's die we kennen, min de
// gedelegeerde". Links, formuliervelden, pop-ups en OcuDraw's eigen
// markeringen blijven zo buiten de pagina-render, precies als nu.
//
// PDFium (bureaublad): de weergave-renders (engine-router renderPdfPage en
// progressive-render invokeTileRegion) geven de gedelegeerde markeringen mee:
// op /NM (annotAppearance) als die uniek is, anders op hun plek in de
// /Annots-rij (annotAppearanceIndex). De worker (en de in-proc-terugval)
// rastert alleen die uit hun /AP en verbergt de rest. Een plek telt alleen
// zolang het bestand op schijf de versie is waaruit de markeringen gelezen
// zijn (na opslaan kan de rij anders liggen); zo'n markering zonder unieke
// /NM tekent OcuDraw dan weer zelf.
//
// PDF.js (browser en MultiView) herkent een markering aan haar object
// ('12R'); dat is altijd uniek, /NM is daar niet nodig. Miniaturen, schermafdruk
// en export geven niets mee en blijven zonder annotaties, want die tekenen de
// markeringen zelf.

import { unwrap } from 'solid-js/store';
import { state } from '../core/state.js';
import { undoStackOf, redoStackOf } from '../core/undo-stacks.js';
import { vingerafdruk } from './ext-interop.js';
import { isAnnotationHiddenInView, metWeergaveDoorloop } from '../annotations/view-filters.js';
import { sourceRenderRevision, sourceWriteActive } from './source-render-revision.js';
import { pageAnnotations } from './page-annotations.js';

const ANNOTATION_MODE_ENABLE = 1;

/** Per document: annotatie-id's per pagina, wat elke pagina-bitmap uit /AP tekent. */
const staat = new WeakMap();
/** pdfDoc -> doc, voor de pdf.js-getter. */
const getterGeinstalleerd = new WeakSet();

function st(doc) {
  let s = staat.get(doc);
  if (!s) {
    s = { idsPerPagina: new Map(), gerenderd: new Map(), lopend: new Map(), wacht: null, cache: null, native: false };
    staat.set(doc, s);
  }
  return s;
}

/** Staat de voorkeur "eigen uiterlijk van ingelezen markeringen" aan? (standaard ja) */
export function apWeergaveAan() {
  return state.preferences?.originalMarkupAppearance !== false;
}

/** pdf.js-id ('12R', '12R3') uit een bronverwijzing ('12 0 R'). */
export function pdfjsIdUitRef(ref) {
  const m = /^(\d+) (\d+) R$/.exec(String(ref || ''));
  if (!m) return null;
  return m[2] === '0' ? `${m[1]}R` : `${m[1]}R${m[2]}`;
}

/**
 * Welke modellen tekent de pagina-render nu uit hun /AP?
 * `nm`: unieke /NM of null; `index`: plek in de /Annots-rij als PDFium die
 * nu mag gebruiken, anders null; `native`: PDFium kan hem aanwijzen.
 * @returns {Map<string, {pdfId: string, page: number, nm: string|null, index: number|null, native: boolean}>}
 */
export function gedelegeerd(doc) {
  const uit = new Map();
  if (!doc || !apWeergaveAan() || !(doc._extBron instanceof Map) || !doc._extBron.size) return uit;
  const s = st(doc);
  // Eén berekening per tik is genoeg (de vingerafdruk is JSON van het model).
  const nu = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (s.cache && s.cache.annotations === doc.annotations && s.cache.lengte === doc.annotations?.length
      && nu - s.cache.tijd < 30) return s.cache.uit;
  // De ruwe objecten, niet via de reactieve store: elke eigenschap lezen via
  // de proxy kostte per hertekening ~800 × enkele lookups.
  const perId = new Map();
  for (const a of unwrap(doc.annotations) || []) if (a && a.id != null) perId.set(a.id, a);
  const volledig = volledigeControleNodig(doc, s, nu);
  // Weergavefilters één keer gelezen voor de hele doorloop (view-filters.js).
  metWeergaveDoorloop(() => { for (const [modelId, bron] of doc._extBron) {
    if (!bron?.eigenAp) continue;
    const model = perId.get(modelId);
    if (!model) continue; // verwijderd
    const pdfId = pdfjsIdUitRef(bron.ref);
    if (!pdfId) continue;
    if (isAnnotationHiddenInView(model)) continue;
    if (bewerkt(doc, s, modelId, model, bron, volledig)) continue;
    const nm = bron.nm && nmTelling(doc).get(bron.nm) === 1 ? bron.nm : null;
    const index = !nm && Number.isInteger(bron.annotsIndex) && plekkenGeldig(doc) ? bron.annotsIndex : null;
    uit.set(modelId, { pdfId, page: model.page, nm, index, native: !!nm || index !== null });
  } });
  s.cache = { annotations: doc.annotations, lengte: doc.annotations?.length, tijd: nu, uit };
  return uit;
}

// ── Bewerkt of niet? ─────────────────────────────────────────────────────
// De vingerafdruk (JSON van het hele model) van ~800 markeringen kost tientallen
// ms; per pointerbeweging was dat de grootste vertraging bij tekenen en slepen
// op een zware externe tekening. Daarom per model onthouden:
//  - alle markeringen opnieuw vergelijken zodra de ongedaan-maken-geschiedenis
//    of de markeringenlijst verandert (elke vastgelegde bewerking, toevoegen,
//    verwijderen) en verder hooguit eens per seconde zolang er niet gesleept
//    wordt (vangnet voor een bewerking die niet in de geschiedenis komt);
//  - de geselecteerde markeringen bij elke hertekening (die worden live
//    versleept of in het eigenschappenpaneel aangepast).

const VANGNET_MS = 1000;

function geschiedenisSleutel(doc) {
  const u = undoStackOf(doc), r = redoStackOf(doc);
  return [doc.annotations, doc.annotations?.length, u.length, u[u.length - 1], r.length, r[r.length - 1]];
}

function zelfdeSleutel(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

function volledigeControleNodig(doc, s, nu) {
  const sleutel = geschiedenisSleutel(doc);
  const bezig = !!(state.isDragging || state.isDrawing || state.isResizing || state.isPanning);
  const nodig = !s.bewerkt || !zelfdeSleutel(sleutel, s.bewerktSleutel)
    || (!bezig && nu - (s.bewerktTijd || 0) > VANGNET_MS);
  if (nodig) {
    s.bewerkt = new Map();
    s.bewerktSleutel = sleutel;
    s.bewerktTijd = nu;
  }
  return nodig;
}

function geselecteerd(doc, model) {
  if (doc.selectedAnnotation && unwrap(doc.selectedAnnotation) === model) return true;
  const sel = doc.selectedAnnotations;
  return Array.isArray(sel) && sel.length > 0 && sel.some((a) => a && unwrap(a) === model);
}

function bewerkt(doc, s, modelId, model, bron, volledig) {
  if (!volledig && !geselecteerd(doc, model) && s.bewerkt.has(modelId)) return s.bewerkt.get(modelId);
  const ja = vingerafdruk(model) !== bron.sig;
  s.bewerkt.set(modelId, ja);
  return ja;
}

// Kloppen de /Annots-plekken nog met het bestand op schijf?
function plekkenGeldig(doc) {
  const pad = doc.filePath;
  if (!pad || !Number.isInteger(doc._pdfLibBronRevisie) || doc._pdfLibBronRevisie < 0) return false;
  return !sourceWriteActive(pad) && sourceRenderRevision(pad) === doc._pdfLibBronRevisie;
}

const nmTellingen = new WeakMap();
function nmTelling(doc) {
  const bron = doc._extBron;
  let t = nmTellingen.get(bron);
  if (!t || t.grootte !== bron.size) {
    const m = new Map();
    for (const b of bron.values()) if (b?.nm) m.set(b.nm, (m.get(b.nm) || 0) + 1);
    t = { grootte: bron.size, m };
    nmTellingen.set(bron, t);
  }
  return t.m;
}

function gedelegeerdePdfIds(doc, pagina = null) {
  const ids = new Set();
  for (const { pdfId, page } of gedelegeerd(doc).values()) {
    if (pagina == null || page === pagina) ids.add(pdfId);
  }
  return ids;
}

function hashVan(ids) {
  // FNV-1a over de gesorteerde id's: pdf.js gebruikt hem in zijn cachesleutel.
  let h = 0x811c9dc5;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 44;
  }
  return ids.size ? `ap${h.toString(16)}` : '';
}

/** De set die pdf.js overslaat: alle bekende annotaties min de gedelegeerde. */
export function overTeSlaan(doc) {
  const s = st(doc);
  const gedeeld = gedelegeerdePdfIds(doc);
  const ids = new Set();
  for (const lijst of s.idsPerPagina.values()) for (const id of lijst) if (!gedeeld.has(id)) ids.add(id);
  return { ids, hash: hashVan(ids) };
}

function installeerGetter(doc) {
  const pdfDoc = doc.pdfDoc;
  const opslag = pdfDoc?.annotationStorage;
  if (!opslag || getterGeinstalleerd.has(opslag)) return;
  const origineel = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(opslag), 'modifiedIds');
  Object.defineProperty(opslag, 'modifiedIds', {
    configurable: true,
    get() {
      // Een ander document met dezelfde opslag bestaat niet; de pdfDoc kan
      // wel vervangen zijn (herladen na opslaan): dan geldt pdf.js zelf.
      if (doc.pdfDoc !== pdfDoc || !apWeergaveAan()) {
        return origineel?.get ? origineel.get.call(this) : { ids: new Set(), hash: '' };
      }
      return overTeSlaan(doc);
    },
  });
  getterGeinstalleerd.add(opslag);
}

function docVoorPagina(page) {
  const t = page?._transport;
  if (!t) return null;
  return (state.documents || []).find((d) => d?.pdfDoc?._transport === t) || null;
}

/** Hoe lang de eerste render op de markeringen van de pagina wacht (ms). */
const WACHT_OP_MARKERINGEN_MS = 1500;

async function wachtOpMarkeringen(doc, pagina) {
  if (doc._annotationPagesReady?.has?.(pagina)) return;
  try {
    const loader = await import('./loader.js');
    await Promise.race([
      loader.ensureAnnotationsForPage(pagina, doc, { mayDefer: true }),
      new Promise((r) => setTimeout(r, WACHT_OP_MARKERINGEN_MS)),
    ]);
  } catch { /* zonder markeringen: gewoon tekenen */ }
}

/**
 * page.render()-opties voor een PDF.js-render van `page`, zonder iets vast te
 * leggen: { renderParams, ids } met ids = de pdf.js-id's die de render uit
 * hun /AP tekent. Voor elke weergave die haar eigen bitmap bijhoudt
 * (MultiView); de hoofdweergave gebruikt apRenderOpties().
 * @param {object} page  PDFPageProxy
 * @returns {Promise<{renderParams: object, ids: Set<string>}>}
 */
export async function apRenderParams(page) {
  const leeg = { renderParams: {}, ids: new Set() };
  const doc = docVoorPagina(page);
  if (!doc || !apWeergaveAan()) return leeg;
  const s = st(doc);
  const pagina = page.pageNumber;
  // De markeringen laden naast de pagina-render. Even wachten voorkomt een
  // tweede render zodra blijkt dat er externe markeringen op de pagina staan.
  await wachtOpMarkeringen(doc, pagina);
  if (!(doc._extBron instanceof Map) || !doc._extBron.size) return leeg;
  if (!s.idsPerPagina.has(pagina)) {
    try {
      const annots = await pageAnnotations(page);
      s.idsPerPagina.set(pagina, annots.map((a) => a.id).filter(Boolean));
    } catch {
      return leeg;
    }
  }
  const ids = gedelegeerdePdfIds(doc, pagina);
  if (!ids.size) return leeg;
  installeerGetter(doc);
  return { renderParams: { annotationMode: ANNOTATION_MODE_ENABLE }, ids };
}

/**
 * Extra page.render()-opties voor de hoofdweergave (renderer.js
 * tekenPaginaMetPdfJs → renderPdfJsPageToCanvas({ renderParams })).
 * Leg na de render met apRenderKlaar() vast of de bitmap er staat.
 * @param {object} page  PDFPageProxy
 * @returns {Promise<object>}
 */
export async function apRenderOpties(page) {
  const doc = docVoorPagina(page);
  if (!doc) return {};
  const s = st(doc);
  const pagina = page.pageNumber;
  s.lopend.set(pagina, new Set());
  const { renderParams, ids } = await apRenderParams(page);
  s.lopend.set(pagina, ids);
  return renderParams;
}

/**
 * De render met de opties van apRenderOpties() staat (ok) of is vervallen.
 * Pas vanaf nu slaat de tekenlus de /AP-markeringen van deze pagina over.
 */
export function apRenderKlaar(page, ok) {
  const doc = docVoorPagina(page);
  if (!doc) return;
  const s = st(doc);
  const pagina = page.pageNumber;
  const lopend = s.lopend.get(pagina);
  s.lopend.delete(pagina);
  if (ok && lopend) s.gerenderd.set(pagina, lopend);
}

/**
 * Stukje voor een bitmap-cachesleutel: verandert zodra de set /AP-markeringen
 * verandert die een PDF.js-render van het document tekent.
 */
export function apRenderKeyPart(doc) {
  if (!doc || !apWeergaveAan() || !(doc._extBron instanceof Map) || !doc._extBron.size) return '';
  return overTeSlaan(doc).hash;
}

/** Is een id-verzameling gelijk aan een andere? */
function zelfde(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Voor de tekenlus van de weergave: welke modellen van `pagina` staan al als
 * /AP in de pagina-bitmap (en worden dus niet door OcuDraw getekend)? Wijkt
 * de bitmap af van wat nu gedelegeerd is (een markering bewerkt, verborgen,
 * verwijderd of terug naar het origineel), dan wordt de pagina opnieuw
 * getekend.
 * @returns {Set<string>} model-id's om over te slaan
 */
export function apInBitmap(doc, pagina) {
  if (!doc) return new Set();
  const s = staat.get(doc);
  const inBitmap = s?.gerenderd.get(pagina);
  if (!inBitmap) return new Set();
  // PDFium-bitmaps tonen alleen markeringen die PDFium kan aanwijzen.
  const { overslaan, klopt } = apOverslaan(doc, pagina, inBitmap, { alleenNative: s.native });
  if (!klopt) planHertekening(doc, pagina);
  return overslaan;
}

/**
 * Welke modellen van `pagina` niet natekenen, gegeven de pdf.js-id's die een
 * bitmap uit hun /AP toont (`inBitmap`)? `klopt` is onwaar zodra wat nu
 * gedelegeerd is daarvan afwijkt: dan moet die bitmap opnieuw.
 * @returns {{overslaan: Set<string>, klopt: boolean}}
 */
export function apOverslaan(doc, pagina, inBitmap, { alleenNative = false } = {}) {
  const overslaan = new Set();
  const nuHier = new Set();
  if (!doc || !inBitmap) return { overslaan, klopt: true };
  for (const [modelId, { pdfId, page, native }] of gedelegeerd(doc)) {
    if (page !== pagina || (alleenNative && !native)) continue;
    nuHier.add(pdfId);
    if (inBitmap.has(pdfId)) overslaan.add(modelId);
  }
  return { overslaan, klopt: zelfde(nuHier, inBitmap) };
}

function planHertekening(doc, pagina) {
  const s = st(doc);
  if (s.wacht) return;
  s.wacht = setTimeout(async () => {
    s.wacht = null;
    if (state.documents[state.activeDocumentIndex] !== doc) return;
    try {
      if (s.native) await wisNativeBitmaps(doc);
      const renderer = await import('./renderer.js');
      if (doc.viewMode === 'continuous') await renderer.reRenderVisibleContinuousPages();
      else if (doc.currentPage === pagina) await renderer.renderPage(doc.currentPage);
    } catch (e) {
      console.warn('[ap-weergave] pagina opnieuw tekenen mislukt:', e);
    }
  }, 150);
}

/**
 * Extra argumenten voor een PDFium-weergaverender van `pageIndex` (0-based):
 * { annotAppearance: /NM's, annotAppearanceIndex?: /Annots-plekken } van de
 * gedelegeerde markeringen op die pagina, of null (geen annotaties, het oude
 * gedrag). Legt vast wat de bitmap van die pagina toont.
 * @returns {{annotAppearance: string[], annotAppearanceIndex?: number[]}|null}
 */
export function nativeAnnotArgs(path, pageIndex) {
  const doc = (state.documents || []).find((d) => d?.filePath === path);
  if (!doc) return null;
  const s = st(doc);
  s.native = true;
  const pagina = pageIndex + 1;
  const nms = [];
  const plekken = [];
  const ids = new Set();
  for (const { pdfId, page, nm, index, native } of gedelegeerd(doc).values()) {
    if (page !== pagina || !native) continue;
    if (nm) nms.push(nm); else plekken.push(index);
    ids.add(pdfId);
  }
  s.gerenderd.set(pagina, ids);
  if (!ids.size) return null;
  return { annotAppearance: nms.sort(), ...(plekken.length ? { annotAppearanceIndex: plekken.sort((a, b) => a - b) } : {}) };
}

// Een andere set /AP-markeringen: de PDFium-bitmaps van het document kloppen
// niet meer (zelfde invalidatie als een andere OCG-keuze).
async function wisNativeBitmaps(doc) {
  const [bitmaps, tiles, progressive, orchestrator, renderer] = await Promise.all([
    import('./page-bitmap-cache.js'), import('./tile-cache.js'),
    import('./progressive-render.js'), import('./bitmap-orchestrator.js'),
    import('./renderer.js'),
  ]);
  bitmaps.invalidateDocumentBitmaps(doc.filePath);
  tiles.tileCacheClearForFile(doc.filePath);
  progressive.cancelProgressiveRenderForFile(doc.filePath);
  orchestrator.cancelBitmapRendersForFile(doc.filePath);
  renderer.clearBitmapJSCacheForFile(doc.filePath);
  renderer.clearLowResCache();
}

/** Na het omzetten van de voorkeur: alles opnieuw. */
export async function apVoorkeurGewijzigd() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc?.pdfDoc) return;
  if (st(doc).native) await wisNativeBitmaps(doc);
  const renderer = await import('./renderer.js');
  if (doc.viewMode === 'continuous') await renderer.reRenderVisibleContinuousPages();
  else await renderer.renderPage(doc.currentPage);
}

/**
 * /NM's van de markeringen die een PDFium-render van `pagina` (1-based) in de
 * webversie met hun eigen uiterlijk tekent (pdfium-web/), of null. Zelfde
 * keuze als de PDF.js-render met annotationMode ENABLE; wat de bitmap toont
 * legt apRenderKlaar() vast, net als bij PDF.js.
 * @returns {string[]|null}
 */
export function apNmsVoorPagina(doc, pagina) {
  const nms = [];
  for (const { page, nm } of gedelegeerd(doc).values()) if (page === pagina && nm) nms.push(nm);
  return nms.length ? nms.sort() : null;
}

/**
 * Wat een PDFium-render van `pagina` (1-based) in de webversie met eigen
 * uiterlijk tekent: /NM's, en voor markeringen zonder unieke /NM hun plek in
 * /Annots (zelfde regel als nativeAnnotArgs voor het bureaublad). null =
 * niets.
 * @returns {{nms: string[], plekken: number[]}|null}
 */
export function apToonVoorPagina(doc, pagina) {
  const nms = [];
  const plekken = [];
  for (const { page, nm, index } of gedelegeerd(doc).values()) {
    if (page !== pagina) continue;
    if (nm) nms.push(nm); else if (Number.isInteger(index)) plekken.push(index);
  }
  if (!nms.length && !plekken.length) return null;
  return { nms: nms.sort(), plekken: plekken.sort((a, b) => a - b) };
}

/** Alleen voor tests. */
export function _apStaat(doc) { return st(doc); }

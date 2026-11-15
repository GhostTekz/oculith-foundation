// PDFium-pixels voor de webversie: de kant van de hoofdthread.
//
// pdfjs-canvas-render.js en pdfjs-detail-layer.js hebben één inhaakpunt, een
// optioneel `rasterizer`-object. Deze module levert dat object zolang PDFium
// (WebAssembly, pdfium-web-worker.js) de pagina kan tekenen; anders null, en
// dan tekent PDF.js zoals voorheen. Wanneer niet:
//  - in de Tauri-schil (daar rastert de native PDFium; de PDF.js-route is daar
//    alleen voor lege documenten);
//  - de voorkeur "Pagina's tekenen met PDFium" staat uit;
//  - er zijn geen bytes van het document (leeg document, nog niet gecachet);
//  - de gebruiker zette PDF-lagen (OCG) anders dan het bestand: PDFium volgt
//    alleen de standaardstand van het bestand (/D), PDF.js kent de keuze;
//  - het laden of tekenen in PDFium mislukte (dan blijft het voor dat
//    document bij PDF.js, en na een fout in de module voor de hele sessie).

import { pdfiumMatrix, extraRotatie } from './pdfium-matrix.js';

/** Regels voor "mag PDFium deze pagina tekenen" (puur; zie pdfiumWebRasterizer). */
export function pdfiumWebToegestaan({ inTauri, voorkeur, heeftBytes, ocgAfwijkend, moduleKapot, docKapot }) {
  return !inTauri && voorkeur !== false && !!heeftBytes && !ocgAfwijkend && !moduleKapot && !docKapot;
}

let worker = null;
let volgnummer = 0;
const wachtend = new Map();
let moduleKapot = false;
const geopend = new WeakMap(); // bytes (Uint8Array) -> Promise<docKey>
const kapotteBytes = new WeakSet();
let docTeller = 0;

function zorgVoorWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./pdfium-web-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ...rest } = e.data || {};
    const w = wachtend.get(id);
    if (!w) return;
    wachtend.delete(id);
    if (rest.ok) w.resolve(rest); else w.reject(new Error(rest.error || 'PDFium-worker'));
  };
  worker.onerror = (e) => {
    console.warn('[pdfium-web] worker-fout:', e?.message, e?.filename, e?.lineno);
    moduleKapot = true;
    for (const w of wachtend.values()) w.reject(new Error(e?.message || 'PDFium-worker kapot'));
    wachtend.clear();
  };
  return worker;
}

function vraag(bericht, transfer = []) {
  const w = zorgVoorWorker();
  const id = ++volgnummer;
  return new Promise((resolve, reject) => {
    wachtend.set(id, { resolve, reject });
    w.postMessage({ id, ...bericht }, transfer);
  });
}

// Hoeveel documenten de worker open houdt (elk: de bytes plus PDFium's
// geparste pagina's). Na opslaan krijgt een document nieuwe bytes; het oude
// exemplaar valt er dan vanzelf uit.
export const MAX_OPEN_DOCS = 3;
const openLijst = []; // [{ bytes, docKey }] oudste eerst

function openBytes(bytes) {
  let p = geopend.get(bytes);
  const i = openLijst.findIndex((o) => o.bytes === bytes);
  if (i >= 0) openLijst.push(...openLijst.splice(i, 1));
  if (!p) {
    const docKey = `d${++docTeller}`;
    const kopie = bytes.slice().buffer; // de cache-bytes blijven van de saver
    p = vraag({ type: 'open', docKey, bytes: kopie }, [kopie]).then(() => docKey);
    p.catch(() => { kapotteBytes.add(bytes); geopend.delete(bytes); });
    geopend.set(bytes, p);
    openLijst.push({ bytes, docKey });
    while (openLijst.length > MAX_OPEN_DOCS) {
      const oud = openLijst.shift();
      geopend.delete(oud.bytes);
      vraag({ type: 'close', docKey: oud.docKey }).catch(() => {});
    }
  }
  return p;
}

function naarCanvas(antwoord) {
  const canvas = document.createElement('canvas');
  canvas.width = antwoord.width;
  canvas.height = antwoord.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(antwoord.rgba), antwoord.width, antwoord.height), 0, 0);
  return canvas;
}

/**
 * Het rasterizer-object voor dit document, of null (PDF.js tekent).
 * @param {object} o
 * @param {Uint8Array|null} o.bytes      de bytes van het document
 * @param {boolean} o.inTauri
 * @param {boolean} [o.voorkeur]         state.preferences.pdfiumWebRender
 * @param {boolean} o.ocgAfwijkend       PDF-lagen anders dan het bestand
 * @param {(page: object, renderParams: object|null) => string[]|null} o.toonNms
 *   /NM's van de markeringen die met hun eigen uiterlijk getekend worden, of
 *   null (geen annotaties)
 */
export function pdfiumWebRasterizer({ bytes, inTauri, voorkeur, ocgAfwijkend, toonNms }) {
  if (!pdfiumWebToegestaan({ inTauri, voorkeur, heeftBytes: !!bytes?.length, ocgAfwijkend, moduleKapot,
    docKapot: bytes ? kapotteBytes.has(bytes) : false })) return null;

  async function teken(page, viewport, k, uitsnede, breedte, hoogte, renderParams) {
    if (moduleKapot || kapotteBytes.has(bytes)) return null;
    try {
      // PDF.js levert ook voor een PDF zonder /UserUnit expliciet 1.
      // Ontbrekende of ongeldige metadata blijft bij de PDF.js-renderroute.
      const userUnit = page.userUnit;
      if (!Number.isFinite(userUnit) || userUnit <= 0) return null;
      const docKey = await openBytes(bytes);
      const basis = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      const matrix = pdfiumMatrix({
        W: basis.width, H: basis.height,
        rotatie: extraRotatie(viewport.rotation, page.rotate),
        schaal: viewport.scale, k, userUnit, minX: uitsnede.minX, minY: uitsnede.minY,
      });
      const t0 = performance.now();
      const antwoord = await vraag({ type: 'render', docKey, pageIndex: page.pageNumber - 1,
        width: breedte, height: hoogte, matrix, show: toonNms(page, renderParams) });
      const canvas = naarCanvas(antwoord);
      console.log(`[pdfium-web] render ${breedte}x${hoogte}: PDFium ${antwoord.ms} ms, totaal ${Math.round(performance.now() - t0)} ms`);
      return canvas;
    } catch (e) {
      console.warn('[pdfium-web] terug naar PDF.js:', e?.message || e);
      if (/LoadMemDocument|niet geopend/.test(String(e?.message))) kapotteBytes.add(bytes);
      return null;
    }
  }

  return {
    naam: 'pdfium',
    /** Hele pagina op k bitmap-px per CSS-px; canvas van breedte x hoogte, of null. */
    renderPagina: ({ page, viewport, k, breedte, hoogte, renderParams }) =>
      teken(page, viewport, k, { minX: 0, minY: 0 }, breedte, hoogte, renderParams),
    /** Uitsnede (viewport-CSS-px) op dpr; canvas, of null. */
    renderUitsnede: ({ page, viewport, uitsnede, dpr, breedte, hoogte, renderParams }) =>
      teken(page, viewport, dpr, uitsnede, breedte, hoogte, renderParams),
  };
}

/** Vroeg opstarten (wasm ophalen en compileren) zodra een document opent. */
export function warmPdfiumWebOp() {
  if (moduleKapot) return;
  vraag({ type: 'ping' }).catch(() => { moduleKapot = true; });
}

/** Alleen voor tests. */
export function _zetModuleKapot(v) { moduleKapot = !!v; }

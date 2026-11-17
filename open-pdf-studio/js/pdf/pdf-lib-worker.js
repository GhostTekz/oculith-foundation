// The open-time pdf-lib reads of one document, off the main thread. The
// loader (pdf-lib-source.js) sends the file once; this worker parses it with
// pdf-lib, answers with the catalog fields (pdf-lib-catalog.js) and then
// with each page's markup data (loader/color-extraction.js) on request.
// The parse lives here, not in the page heap, and goes when the loader
// terminates the worker.
//
// Messages in:  { op: 'begin', length }, then { op: 'chunk', begin, bytes }
//                 (a file sent in chunks, before an 'open' without bytes)
//               { id, op: 'open', bytes }   (bytes: an ArrayBuffer it owns)
//               { id, op: 'colors', page, withList }
//               { id, op: 'stampSheet', page, ids }
// Messages out: { id, result } or { id, error }
//   open   → { catalog, parseMs, catalogMs, ownCatalog }
//            ownCatalog: the file's own catalog entries as a small PDF
//            (own-catalog.js) { bytes, keys }, or null
//   colors → { colors: Map, snippets: Uint8Array[], imageSources, images, ms, imagesMs }
//            images: the page's stamp and image-markup pictures
//            (loader/image-extraction.js extractStampImages) as [key, entry]
//            pairs, or null when they could not be made here.
//            withList: also list, the page's markups as PDF.js lists them
//            (loader/own-markup-list.js), or null when the page holds other
//            markups; listMs its time.
//   stampSheet → { bytes, stamps } (loader/stamp-sheet.js) or null

import { PDFDocument } from 'pdf-lib';
import { PARSE_OBJECTS_PER_TICK } from './pdf-lib-tempo.js';
import { extractAnnotationColors } from './loader/color-extraction.js';
import { findImageAnnotationSources } from './loader/annotation-image-sources.mjs';
import { extractStampImages, imageDecodeAvailable } from './loader/image-extraction.js';
import { readCatalogFields } from './pdf-lib-catalog.js';
import { ownCatalogBytes } from './own-catalog.js';
import { toCloneable } from './pdf-lib-clone.js';
import { ownMarkupList } from './loader/own-markup-list.js';
import { buildStampSheet } from './loader/stamp-sheet.js';

let parsed = null; // Promise<PDFDocument>
let incoming = null; // Uint8Array a chunked file is assembled in

async function open(bytes) {
  const t0 = performance.now();
  // Straight through, as on the main thread (pdf-lib-tempo.js): a worker
  // has nothing to give the event loop to, and its timers can be stretched
  // as well while the window is out of view.
  const data = bytes ? new Uint8Array(bytes) : incoming;
  incoming = null;
  if (!data) throw new Error('No file bytes');
  parsed = PDFDocument.load(data, { ignoreEncryption: true, parseSpeed: PARSE_OBJECTS_PER_TICK });
  const pdf = await parsed;
  const parseMs = performance.now() - t0;
  const t1 = performance.now();
  const catalog = toCloneable(readCatalogFields(pdf), 'catalog');
  const catalogMs = performance.now() - t1;
  let ownCatalog = null;
  try { ownCatalog = await ownCatalogBytes(pdf); } catch { ownCatalog = null; }
  return { catalog, parseMs, catalogMs, ownCatalog };
}

async function colors(page, withList, annotationKeys) {
  if (!parsed) throw new Error('No document');
  const pdf = await parsed;
  let list = null;
  let listMs = 0;
  if (withList) {
    const t = performance.now();
    try { list = ownMarkupList(pdf, page); } catch { list = null; }
    listMs = performance.now() - t;
  }
  const t0 = performance.now();
  // Vector snippet source pages go back with the answer: the snippet store
  // is on the main thread. A copy each, so the file's buffer stays here.
  const snippets = [];
  const storeSnippet = (bytes) => { snippets.push(bytes.slice()); };
  const map = await extractAnnotationColors(page, pdf, { storeSnippet, deferRichText: true, annotationKeys });
  let imageSources = 0;
  try { imageSources = findImageAnnotationSources(page, pdf).length; } catch { /* no images */ }
  // The pictures too: otherwise the page parses the whole file a second
  // time on its own thread just to decode them.
  let images = null;
  let imagesMs = 0;
  if (imageSources > 0 && imageDecodeAvailable()) {
    const t1 = performance.now();
    try { images = [...(await extractStampImages(page, pdf))]; } catch { images = null; }
    imagesMs = performance.now() - t1;
  }
  return { colors: toCloneable(map, `page ${page}`), snippets, imageSources, images, ms: performance.now() - t0, imagesMs, list, listMs };
}

self.onmessage = async (e) => {
  const { id, op } = e.data || {};
  try {
    if (op === 'begin') {
      incoming = new Uint8Array(e.data.length);
    } else if (op === 'chunk') {
      incoming.set(new Uint8Array(e.data.bytes), e.data.begin);
    } else if (op === 'open') {
      self.postMessage({ id, result: await open(e.data.bytes) });
    } else if (op === 'stampSheet') {
      if (!parsed) throw new Error('No document');
      const sheet = await buildStampSheet(await parsed, e.data.page, e.data.ids);
      self.postMessage({ id, result: sheet }, sheet ? [sheet.bytes.buffer] : []);
    } else if (op === 'colors') {
      const result = await colors(e.data.page, !!e.data.withList, e.data.annotationKeys || []);
      self.postMessage({ id, result }, result.snippets.map((b) => b.buffer));
    } else {
      throw new Error(`Unknown request ${op}`);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

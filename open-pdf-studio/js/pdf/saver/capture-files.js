// Capture photos and File Attachment markups in the PDF (see docs/reference/editor/markup-tools.md).
//
// Photos on a markup: each photo is an embedded file (a /Filespec with an
// /EF /F /EmbeddedFile stream) marked with /OPS_CaptureFileV1 (JSON: id,
// width, height, date, markup id). The markup's own annotation lists them in
// /OPS_Capture [refs]. The same filespecs go into the document's
// /Names /EmbeddedFiles tree, so every PDF reader lists the photos as
// attachments. syncCaptureEmbeddedFiles() rebuilds the OcuDraw part of that
// tree from what the annotations still reference after a save, and frees
// the photo and file streams nothing references any more (a save would
// otherwise keep every old copy).
//
// File Attachment markup: a standard /FileAttachment annotation (/Name
// /PushPin, /FS to an embedded file, a vector appearance), so other readers
// show a push pin that opens the file.

import { PDFName, PDFArray, PDFDict, PDFRef, PDFHexString, PDFString } from 'pdf-lib';
import { decodePdfTextObject } from './pdf-text.js';
import { capturePhotos, hasAttachedFile, dataUrlToBytes, safeMimeType, safeFileName } from '../../annotations/capture.js';

export const CAPTURE_KEY = 'OPS_Capture';
export const CAPTURE_FILE_MARK = 'OPS_CaptureFileV1';
// Hex text strings: a file name or JSON may hold unbalanced parentheses or
// backslashes, which a literal string would have to escape.
const hexText = (text) => PDFHexString.fromText(String(text ?? ''));
const NO_FLATE = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/zip|video\/|audio\/mpeg)/u;

/** PDF date (D:YYYYMMDDHHmmSS) for a stored photo date: local EXIF text stays local. */
export function pdfDate(date) {
  const s = String(date || '');
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u.exec(s);
  if (local) return `D:${local.slice(1).join('')}`;
  const t = Date.parse(s);
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`
    + `${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function embeddedFileStream(context, bytes, mimeType, date) {
  const mime = safeMimeType(mimeType);
  const dict = {
    Type: 'EmbeddedFile',
    Subtype: PDFName.of(mime),
    Params: { Size: bytes.length, CreationDate: PDFString.of(pdfDate(date)), ModDate: PDFString.of(pdfDate(date)) },
  };
  const stream = NO_FLATE.test(mime) ? context.stream(bytes, dict) : context.flateStream(bytes, dict);
  return context.register(stream);
}

function fileSpec(context, name, streamRef, desc, extra = {}) {
  const safe = safeFileName(name);
  const dict = context.obj({ Type: 'Filespec', EF: { F: streamRef }, ...extra });
  // /F is a byte string (PDF 7.11.3): an ASCII stand-in; /UF has the real name.
  const ascii = safe.replace(/[^\x20-\x7e]/gu, '_');
  dict.set(PDFName.of('F'), PDFHexString.of([...ascii].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
  dict.set(PDFName.of('UF'), hexText(safe));
  if (desc) dict.set(PDFName.of('Desc'), hexText(desc));
  return dict;
}

/**
 * Writes the markup's photos as embedded files and lists them in
 * /OPS_Capture on its annotation. Returns the number written.
 */
export function writeCapturePhotos(context, annotDict, ann) {
  if (!annotDict || typeof annotDict.set !== 'function') return 0;
  const refs = [];
  for (const photo of capturePhotos(ann)) {
    const bytes = dataUrlToBytes(photo.dataUrl);
    if (!bytes?.length) continue;
    const streamRef = embeddedFileStream(context, bytes, photo.mimeType, photo.date);
    const meta = JSON.stringify({ v: 1, id: String(photo.id || ''), width: photo.width || 0,
      height: photo.height || 0, date: photo.date || '', markup: String(ann.id || '') });
    const spec = fileSpec(context, photo.name, streamRef, 'OcuDraw markup photo');
    spec.set(PDFName.of(CAPTURE_FILE_MARK), hexText(meta));
    refs.push(context.register(spec));
  }
  if (refs.length) annotDict.set(PDFName.of(CAPTURE_KEY), context.obj(refs));
  return refs.length;
}

/** Vector push pin for the File Attachment appearance (w × h box, y up). */
export function pushPinAppearance(w, h, rgb) {
  const s = Math.min(w, h);
  const cx = s * 0.62, cy = s * 0.62, r = s * 0.25, k = r * 0.5523;
  const f = (n) => Number(n.toFixed(3));
  const [cr, cg, cb] = rgb.map(f);
  return [
    'q 0.25 0.25 0.25 RG', `${f(s * 0.07)} w 1 J`,
    `${f(s * 0.46)} ${f(s * 0.46)} m ${f(s * 0.12)} ${f(s * 0.12)} l S Q`,
    `q ${cr} ${cg} ${cb} rg 0.2 0.2 0.2 RG ${f(s * 0.04)} w`,
    `${f(cx + r)} ${f(cy)} m`,
    `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
    `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
    `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
    `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c b Q`,
    `q 1 1 1 rg ${f(cx - r * 0.35)} ${f(cy + r * 0.2)} ${f(r * 0.3)} ${f(r * 0.3)} re f Q`,
  ].join('\n');
}

/**
 * The /FileAttachment annotation of a File Attachment markup, or null when
 * the markup carries no file. `rect` is [x1 y1 x2 y2] in PDF space.
 * `common`: { rgb, opacity, author, flags, contents }.
 */
export function buildFileAttachmentDict(context, ann, rect, common) {
  if (!hasAttachedFile(ann)) return null;
  const file = ann.attachedFile;
  const bytes = dataUrlToBytes(file.dataUrl);
  if (!bytes?.length) return null;
  const streamRef = embeddedFileStream(context, bytes, file.mimeType, file.date);
  const specRef = context.register(fileSpec(context, file.name, streamRef, file.name));
  const w = Math.abs(rect[2] - rect[0]) || 24;
  const h = Math.abs(rect[3] - rect[1]) || 24;
  const ap = context.register(context.stream(pushPinAppearance(w, h, common.rgb), {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h],
  }));
  const dict = context.obj({
    Type: 'Annot',
    Subtype: 'FileAttachment',
    Rect: rect,
    C: common.rgb,
    CA: common.opacity,
    T: hexText(common.author || 'User'),
    M: PDFString.of(pdfDate(new Date().toISOString())),
    Name: 'PushPin',
    FS: specRef,
    F: common.flags,
    AP: { N: ap },
    OPS_Subtype: PDFString.of('fileAttachment'),
  });
  dict.set(PDFName.of('Contents'), hexText(common.contents ?? file.name));
  return dict;
}

function lookupDict(context, raw) {
  const v = raw instanceof PDFRef ? context.lookup(raw) : raw;
  return v instanceof PDFDict ? v : null;
}

/** The /EF /F stream ref (or object) of a filespec, or null. */
function efStream(context, spec) {
  const ef = lookupDict(context, spec?.get(PDFName.of('EF')));
  return ef?.get(PDFName.of('F')) || ef?.get(PDFName.of('UF')) || null;
}

/** Does this /FileAttachment carry an embedded file (so OcuDraw models it)? */
export function isEmbeddedFileAttachment(dict, context) {
  try {
    const spec = lookupDict(context, dict?.get(PDFName.of('FS')));
    const stream = efStream(context, spec);
    return !!(stream && context.lookup(stream));
  } catch {
    return false;
  }
}

function textOf(context, raw) {
  const v = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (v instanceof PDFHexString || v instanceof PDFString) return v.decodeText();
  return decodePdfTextObject(v) ?? '';
}

function isCaptureSpec(context, spec) {
  return !!spec?.get?.(PDFName.of(CAPTURE_FILE_MARK));
}

/** Name-tree entries [{ key, value }] (leaves of /Names and /Kids, bounded). */
function flattenNameTree(context, node, out = [], depth = 0) {
  if (!node || depth > 16 || out.length > 100000) return out;
  const names = node.lookup?.(PDFName.of('Names'));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) out.push({ key: names.get(i), value: names.get(i + 1) });
  }
  const kids = node.lookup?.(PDFName.of('Kids'));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) flattenNameTree(context, lookupDict(context, kids.get(i)), out, depth + 1);
  }
  return out;
}

const refKey = (ref) => (ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber}` : null);

function captureKeyText(context, spec, ref) {
  let id = '';
  try { id = JSON.parse(textOf(context, spec.get(PDFName.of(CAPTURE_FILE_MARK))))?.id || ''; } catch { /* old or foreign mark */ }
  const name = textOf(context, spec.get(PDFName.of('UF')) || spec.get(PDFName.of('F'))) || 'photo';
  return `OcuDraw capture ${id || refKey(ref).replace(' ', '-')} ${name}`;
}

/**
 * After the annotations are written: make /Names /EmbeddedFiles list exactly
 * the capture photos the pages still reference (next to every other
 * embedded file, untouched), and delete photo and attachment streams that
 * nothing references any more. `removedAnnotRefs`: annotation dicts the
 * save took off its pages (rewritten from the model).
 * Returns { listed, freed } (counts); a document without capture data and
 * without removed attachments is not touched.
 */
export function syncCaptureEmbeddedFiles(pdfDoc, removedAnnotRefs = []) {
  const context = pdfDoc.context;
  const referenced = new Map(); // refKey -> ref of a capture filespec on a page
  const liveSpecs = new Set();  // refKeys of every filespec a kept annotation uses
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = lookupDict(context, annots.get(i));
      if (!dict) continue;
      const fs = dict.get(PDFName.of('FS'));
      if (fs instanceof PDFRef) liveSpecs.add(refKey(fs));
      const list = dict.lookup(PDFName.of(CAPTURE_KEY));
      if (!(list instanceof PDFArray)) continue;
      for (let j = 0; j < list.size(); j++) {
        const ref = list.get(j);
        if (!(ref instanceof PDFRef)) continue;
        if (isCaptureSpec(context, lookupDict(context, ref))) {
          referenced.set(refKey(ref), ref);
          liveSpecs.add(refKey(ref));
        }
      }
    }
  }

  const namesDict = pdfDoc.catalog.lookup(PDFName.of('Names'));
  const tree = namesDict instanceof PDFDict ? lookupDict(context, namesDict.get(PDFName.of('EmbeddedFiles'))) : null;
  const entries = tree ? flattenNameTree(context, tree) : [];
  const ours = [];
  const others = [];
  for (const entry of entries) {
    const spec = lookupDict(context, entry.value);
    (isCaptureSpec(context, spec) ? ours : others).push(entry);
  }

  // Streams of removed File Attachment markups that nothing else uses.
  const garbage = [];
  for (const ref of removedAnnotRefs) {
    const dict = lookupDict(context, ref);
    if (dict?.get(PDFName.of('Subtype'))?.toString() !== '/FileAttachment') continue;
    const fs = dict.get(PDFName.of('FS'));
    if (fs instanceof PDFRef) garbage.push(fs);
  }

  if (!referenced.size && !ours.length && !garbage.length) return { listed: 0, freed: 0 };

  const inTree = new Set(others.map(e => refKey(e.value)).filter(Boolean));
  let freed = 0;
  const free = (specRef) => {
    const key = refKey(specRef);
    if (!key || liveSpecs.has(key) || inTree.has(key)) return;
    const spec = lookupDict(context, specRef);
    const stream = efStream(context, spec);
    if (stream instanceof PDFRef) context.delete(stream);
    context.delete(specRef);
    liveSpecs.add(key); // once
    freed++;
  };
  for (const entry of ours) if (entry.value instanceof PDFRef && !referenced.has(refKey(entry.value))) free(entry.value);
  for (const ref of garbage) free(ref);

  if (!referenced.size && !ours.length) return { listed: 0, freed };

  const keyText = (k) => textOf(context, k);
  const next = [
    ...others.map(e => ({ text: keyText(e.key), key: e.key, value: e.value })),
    ...[...referenced.values()].map(ref => {
      const text = captureKeyText(context, lookupDict(context, ref), ref);
      return { text, key: hexText(text), value: ref };
    }),
  ].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  if (!next.length) {
    if (namesDict instanceof PDFDict) namesDict.delete(PDFName.of('EmbeddedFiles'));
    return { listed: 0, freed };
  }
  const flat = [];
  for (const e of next) flat.push(e.key, e.value);
  const newTree = context.obj({});
  newTree.set(PDFName.of('Names'), context.obj(flat));
  let names = namesDict instanceof PDFDict ? namesDict : null;
  if (!names) {
    names = context.obj({});
    pdfDoc.catalog.set(PDFName.of('Names'), context.register(names));
  }
  names.set(PDFName.of('EmbeddedFiles'), context.register(newTree));
  return { listed: referenced.size, freed };
}

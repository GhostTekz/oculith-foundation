// A PDF's own catalog entries (the keys the PDF standard does not define:
// what an application keeps with the drawing) copied into a small PDF of
// their own. The pdf-lib worker makes it from its parse when a document
// opens, so a reader that only looks up such an entry gets it without the
// whole file being read and parsed again on the main thread, where a large
// drawing's parse costs gigabytes of page memory.
//
// An entry is left out (and its readers parse the whole file as before) when
// it reaches a page or the page tree, or when it is larger than the limits
// below. The copy keeps every value as the file has it: strings as their
// bytes, streams with their filters, nothing decoded or re-encoded.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObjectCopier, PDFPageLeaf, PDFRef, PDFStream } from 'pdf-lib';

// The catalog entries of ISO 32000-2 (Table 29). Everything else is an
// application's own.
export const STANDARD_CATALOG_KEYS = Object.freeze(new Set([
  'Type', 'Version', 'Extensions', 'Pages', 'PageLabels', 'Names', 'Dests', 'ViewerPreferences',
  'PageLayout', 'PageMode', 'Outlines', 'Threads', 'OpenAction', 'AA', 'URI', 'AcroForm', 'Metadata',
  'StructTreeRoot', 'MarkInfo', 'Lang', 'SpiderInfo', 'OutputIntents', 'PieceInfo', 'OCProperties',
  'Perms', 'Legal', 'Requirements', 'Collection', 'NeedsRendering', 'DSS', 'AF', 'DPartRoot',
]));

// Limits of one entry and of the whole copy.
export const OWN_ENTRY_MAX_BYTES = 32 * 1024 * 1024;
export const OWN_CATALOG_MAX_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 50000;

const nameOf = (key) => (key instanceof PDFName ? key.asString() : String(key)).replace(/^\//, '');

function isPageNode(context, obj) {
  if (obj instanceof PDFPageLeaf) return true;
  if (!(obj instanceof PDFDict)) return false;
  const type = obj.get(PDFName.of('Type'));
  return type instanceof PDFName && (type.asString() === '/Page' || type.asString() === '/Pages');
}

// The rough size of `value` and what it reaches, or -1 when it reaches a page
// or goes past the limits.
function entrySize(context, value) {
  const seen = new Set();
  const stack = [value];
  let bytes = 0;
  let objects = 0;
  while (stack.length) {
    let v = stack.pop();
    if (v instanceof PDFRef) {
      if (seen.has(v.tag)) continue;
      seen.add(v.tag);
      v = context.lookup(v);
    }
    if (++objects > MAX_OBJECTS) return -1;
    if (v == null) continue;
    if (isPageNode(context, v)) return -1;
    if (v instanceof PDFStream) {
      bytes += v.getContentsSize?.() ?? 0;
      stack.push(v.dict);
    } else if (v instanceof PDFDict) {
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFArray) {
      for (const x of v.asArray()) stack.push(x);
    } else {
      bytes += v.sizeInBytes?.() ?? 0;
    }
    if (bytes > OWN_ENTRY_MAX_BYTES) return -1;
  }
  return bytes;
}

/**
 * The own catalog entries of `pdf` (a parsed pdf-lib document) as
 * { bytes: Uint8Array (a small PDF), keys: string[] } (the entries it holds),
 * or null when there are none to copy.
 */
export async function ownCatalogBytes(pdf) {
  const context = pdf.context;
  const catalog = context.lookup(context.trailerInfo.Root);
  if (!(catalog instanceof PDFDict)) return null;
  const out = await PDFDocument.create({ updateMetadata: false });
  const copier = PDFObjectCopier.for(context, out.context);
  const keys = [];
  let total = 0;
  for (const [key, value] of catalog.entries()) {
    const name = nameOf(key);
    if (STANDARD_CATALOG_KEYS.has(name)) continue;
    let size;
    try { size = entrySize(context, value); } catch { size = -1; }
    if (size < 0 || total + size > OWN_CATALOG_MAX_BYTES) continue;
    try {
      out.catalog.set(PDFName.of(name), copier.copy(value));
    } catch {
      continue;
    }
    total += size;
    keys.push(name);
  }
  if (!keys.length) return null;
  const bytes = await out.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, keys };
}

/** The pdf-lib document of ownCatalogBytes' `bytes`. */
export function loadOwnCatalog(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

/**
 * Can the own catalog (holding `ownKeys`) answer a reader of `keys` the way
 * the whole file would? Yes when each key is in it, or not in the file at
 * all (`catalogKeys`, the file's catalog entries): both then read nothing.
 */
export function ownCatalogAnswers(keys, ownKeys, catalogKeys) {
  if (!Array.isArray(keys) || !keys.length || !Array.isArray(ownKeys) || !Array.isArray(catalogKeys)) return false;
  return keys.every((key) => ownKeys.includes(key) || !catalogKeys.includes(key));
}

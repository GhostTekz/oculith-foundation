// PDF metadata contributions for independent add-ons. A v2 add-on receives
// strings and document models, never a mutable pdf-lib document or dictionary.
// Full-edition v1 hooks remain the base and run exactly as before.
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';

const BASE = Symbol('base PDF hooks');
const ADDONS = Symbol('PDF add-ons');
const FIELDS = new Set(['catalogKeys', 'legacyCatalogKeys', 'annotationKeys', 'legacyAnnotationKeys',
  'applyCatalog', 'catalogForSave',
  'decorateAnnotation', 'annotationForSave', 'extractAnnotationKeys', 'catalogForExtract']);
const MAX_CATALOG_TEXT = 256 * 1024;
const MAX_LEGACY_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_ANNOTATION_TEXT = 16 * 1024;
const MAX_EXTRACT_TAGS = 50_000;
const MAX_EXTRACT_TAG_BYTES = 2 * 1024 * 1024;
// These entries belong to the editor, even though they use a vendor-style
// name. Independent packages may claim only other, exact legacy names.
const EDITOR_CATALOG_KEYS = new Set(`OPS_AnnotLayers OPS_AssembliesV1 OPS_CaptionTemplateV1
  OPS_FormulaCaptionsV1 OPS_MarkupCheckmarkColumnV1 OPS_MarkupChoiceColumn2V1
  OPS_MarkupChoiceColumn2V2 OPS_MarkupChoiceColumnV1 OPS_MarkupChoiceColumnV2
  OPS_MarkupFormulaColumnV1 OPS_MarkupFormulaColumnV2 OPS_MarkupFormulaColumnV3
  OPS_MarkupNumberColumn2V1 OPS_MarkupNumberColumnV1 OPS_MarkupStatusSetV1
  OPS_MarkupTextColumn OPS_MarkupTextColumn2V1 OPS_Preview OPS_Spaces
  OPS_ToolSequences`.split(/\s+/));
const EDITOR_ANNOTATION_KEYS = new Set(`OPS_AssemblyIdV1 OPS_CaptureFileV1 OPS_CarriedFromV1
  OPS_GroupPathV1 OPS_MarkupChoiceValue2V1 OPS_MarkupIdV1 OPS_MarkupNumberValue2V1
  OPS_MarkupTextValue2V1`.split(/\s+/));
const encoder = new TextEncoder();
const LEGACY_CATALOG_NAME = /^[A-Z][A-Z0-9]{1,15}_[A-Za-z][A-Za-z0-9_]*V[1-9][0-9]*$/;

/** Unknown versioned vendor catalog fields may contain page-specific state. */
export function unclaimedLegacyCatalogKeys(pdfDoc, claimed = []) {
  const known = new Set([...EDITOR_CATALOG_KEYS, ...claimed]);
  return pdfDoc.catalog.keys().map((key) => key.decodeText())
    .filter((key) => LEGACY_CATALOG_NAME.test(key) && !known.has(key));
}

/** Add-on catalog fields need an owner before extracting selected pages. */
export function unclaimedAddonCatalogKeys(pdfDoc, claimed = []) {
  const known = new Set(claimed);
  return pdfDoc.catalog.keys().map((key) => key.decodeText())
    .filter((key) => key.startsWith('ODX_') && !known.has(key));
}

/** Reversible ASCII encoding prevents packages with punctuation in their IDs sharing a prefix. */
export function pdfKeyPrefix(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('PDF add-on id must be an ASCII package id');
  }
  return `ODX_${[...id].map((character) => /[A-Za-z0-9]/.test(character)
    ? character : `_${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}_`;
}

function declaredKeys(id, field, values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`PDF ${field} must be an array`);
  const prefix = pdfKeyPrefix(id);
  const keys = new Set();
  for (const key of values) {
    if (typeof key !== 'string' || key.length > 127 || !key.startsWith(prefix)
        || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key.slice(prefix.length)) || keys.has(key)) {
      throw new Error(`Invalid or duplicate PDF ${field} key: ${String(key)}`);
    }
    keys.add(key);
  }
  return [...keys];
}

function legacyCatalogKeys(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error('PDF legacyCatalogKeys must be an array');
  const seen = new Set();
  for (const key of values) {
    // Require an explicit vendor namespace and a versioned field. This rules
    // out PDF structural names and the editor's own catalog entries.
    if (typeof key !== 'string' || key.length > 127
        || !LEGACY_CATALOG_NAME.test(key)
        || EDITOR_CATALOG_KEYS.has(key) || seen.has(key)) {
      throw new Error(`Invalid or duplicate PDF legacy catalog key: ${String(key)}`);
    }
    seen.add(key);
  }
  return [...seen];
}

function extractionTagKeys(values) {
  const keys = legacyCatalogKeys(values);
  if (keys.some((key) => EDITOR_ANNOTATION_KEYS.has(key))) {
    throw new Error('Cannot claim an editor-owned PDF annotation key');
  }
  return keys;
}

export function validatePdfContribution(id, pdf) {
  if (!pdf || typeof pdf !== 'object' || Array.isArray(pdf)) throw new Error('PDF contribution must be an object');
  for (const field of Object.keys(pdf)) if (!FIELDS.has(field)) throw new Error(`Unsupported PDF operation: ${field}`);
  const catalogKeys = declaredKeys(id, 'catalogKeys', pdf.catalogKeys);
  const legacyKeys = legacyCatalogKeys(pdf.legacyCatalogKeys);
  if (legacyKeys.some((key) => catalogKeys.includes(key))) throw new Error('Duplicate PDF catalog key');
  const namespacedAnnotationKeys = declaredKeys(id, 'annotationKeys', pdf.annotationKeys);
  const legacyAnnotationKeys = extractionTagKeys(pdf.legacyAnnotationKeys);
  const annotationKeys = [...namespacedAnnotationKeys, ...legacyAnnotationKeys];
  // Extraction-only claims do not grant annotation load or save access.
  const extractAnnotationKeys = extractionTagKeys(pdf.extractAnnotationKeys);
  if (!catalogKeys.length && !legacyKeys.length && !annotationKeys.length) {
    throw new Error('PDF contribution must declare owned keys');
  }
  for (const name of ['applyCatalog', 'catalogForSave']) {
    if (pdf[name] != null && (!catalogKeys.length && !legacyKeys.length || typeof pdf[name] !== 'function')) {
      throw new Error(`PDF ${name} requires declared catalog keys and a function`);
    }
  }
  for (const name of ['decorateAnnotation', 'annotationForSave']) {
    if (pdf[name] != null && (!annotationKeys.length || typeof pdf[name] !== 'function')) {
      throw new Error(`PDF ${name} requires declared annotation keys and a function`);
    }
  }
  if (pdf.catalogForExtract != null && (!catalogKeys.length && !legacyKeys.length || typeof pdf.catalogForExtract !== 'function')) {
    throw new Error('PDF catalogForExtract requires owned catalog keys and a function');
  }
  if (extractAnnotationKeys.length && !pdf.catalogForExtract) {
    throw new Error('PDF extractAnnotationKeys requires catalogForExtract');
  }
  return { id, catalogKeys: [...catalogKeys, ...legacyKeys], legacyCatalogKeys: legacyKeys,
    annotationKeys, legacyAnnotationKeys, extractAnnotationKeys, ...Object.fromEntries(
    [...FIELDS].filter((name) => typeof pdf[name] === 'function').map((name) => [name, pdf[name]])) };
}

// Only exact, claimed annotation tags from the selected source pages are
// exposed to an extraction callback. A malformed/oversized claimed tag fails
// closed instead of letting the package silently discard an area or label.
function extractTags(pdfDoc, pageNumbers, keys) {
  let count = 0;
  let bytes = 0;
  const pages = pdfDoc.getPages();
  return Object.freeze(pageNumbers.map((sourcePage, index) => {
    const page = pages[sourcePage - 1];
    if (!page || !Number.isSafeInteger(sourcePage)) throw new Error('Invalid source page for PDF extraction');
    if (!keys.length) return Object.freeze({ sourcePage, targetPage: index + 1, fields: Object.freeze({}) });
    const rawAnnots = page.node.get(PDFName.of('Annots'));
    const annots = rawAnnots == null ? null : pdfDoc.context.lookup(rawAnnots);
    if (rawAnnots != null && !(annots instanceof PDFArray)) throw new Error('Unreadable PDF annotation list');
    const fields = Object.fromEntries(keys.map((key) => [key, []]));
    for (const ref of annots?.asArray() || []) {
      const dict = pdfDoc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) throw new Error('Unreadable PDF annotation');
      for (const key of keys) {
        const raw = dict.get(PDFName.of(key));
        if (raw == null) continue;
        const value = pdfDoc.context.lookup(raw);
        if (!(value instanceof PDFString || value instanceof PDFHexString)
            || value.value.length > (MAX_ANNOTATION_TEXT + 1) * 4) {
          throw new Error(`Unreadable PDF extraction tag: ${key}`);
        }
        let text;
        try { text = value.decodeText(); } catch { throw new Error(`Unreadable PDF extraction tag: ${key}`); }
        bytes += encoder.encode(text).length;
        if (bytes > MAX_EXTRACT_TAG_BYTES || ++count > MAX_EXTRACT_TAGS) {
          throw new Error('PDF extraction tags exceed the transport limit');
        }
        fields[key].push(text);
      }
    }
    return Object.freeze({ sourcePage, targetPage: index + 1,
      fields: Object.freeze(Object.fromEntries(Object.entries(fields)
        .map(([key, values]) => [key, Object.freeze(values)]))) });
  }));
}

function matchingExtractTags(sourcePages, targetPages, keys) {
  for (let i = 0; i < sourcePages.length; i += 1) {
    for (const key of keys) {
      const before = sourcePages[i].fields[key];
      const after = targetPages[i].fields[key];
      if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
        throw new Error(`Copied PDF page lost an owned extraction tag: ${key}`);
      }
    }
  }
}

function textFields(values, keys, limit, id, legacyKeys = [], allowDelete = false) {
  if (values == null) return {};
  if (typeof values !== 'object' || Array.isArray(values) || typeof values.then === 'function') {
    throw new Error(`PDF ${id} fields must be a synchronous object`);
  }
  const allowed = new Set(keys);
  const legacy = new Set(legacyKeys);
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || !(typeof value === 'string' || (allowDelete && value === null))
        || (typeof value === 'string' && (legacy.has(key)
          ? encoder.encode(value).length > MAX_LEGACY_CATALOG_BYTES : value.length > limit))) {
      throw new Error(`PDF ${id} returned an unowned or oversized field: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function readCatalog(pdfDoc, keys, legacyKeys = []) {
  const fields = {};
  const legacy = new Set(legacyKeys);
  for (const key of keys) {
    let value;
    try {
      const raw = pdfDoc.catalog.get(PDFName.of(key));
      value = raw === undefined ? null : pdfDoc.context.lookup(raw);
    } catch { continue; }
    // Hex UTF-16 and escaped literal strings can need four source characters
    // per decoded character. Bound the raw representation before decodeText.
    const max = legacy.has(key) ? MAX_LEGACY_CATALOG_BYTES : MAX_CATALOG_TEXT;
    if ((value instanceof PDFString || value instanceof PDFHexString)
        && value.value.length <= (max + 1) * 4) {
      let decoded;
      try {
        const bytes = value.asBytes();
        // pdf-lib's UTF-16 decoder spreads all code points into one call and
        // overflows for large fields. Keep its behavior for small strings;
        // reject malformed large UTF-16 rather than normalize source bytes.
        if (bytes.length <= 64 * 1024) decoded = value.decodeText();
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          decoded = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
        } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          decoded = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
        }
      } catch { continue; /* Unreadable source stays in the PDF. */ }
      if (decoded !== undefined
          && (legacy.has(key) ? encoder.encode(decoded).length <= max : decoded.length <= max)) {
        fields[key] = decoded;
      }
    }
  }
  return fields;
}

function annotationFields(extra, keys) {
  const fields = {};
  for (const key of keys) {
    const value = extra?.extensionFields?.[key];
    if (typeof value === 'string' && value.length <= MAX_ANNOTATION_TEXT
        && encoder.encode(value).length <= MAX_ANNOTATION_TEXT) fields[key] = value;
  }
  return fields;
}

// The saver supplies the original page's refs. A loaded annotation can keep
// or replace an owned legacy field only when its exact source still belongs
// to this page, has the same name, and has the same PDF subtype.
function verifiedAnnotationSource(model, target, tools) {
  const source = model?.pdfSource;
  if (!source) return null; // newly drawn markup
  if (source.modelId !== model.id) throw new Error('PDF annotation source changed: the markup no longer matches the annotation it was read from.');
  const context = tools.sourceContext;
  const refs = tools.sourceRefs;
  const ref = Array.isArray(refs)
    ? refs.find((item) => item instanceof PDFRef && item.toString() === source.ref) : null;
  if (!context || !ref) throw new Error('PDF annotation source changed: the markup no longer matches the annotation it was read from.');
  const original = context.lookup(ref);
  if (!(original instanceof PDFDict)) throw new Error('PDF annotation source is unreadable.');
  const name = original.get(PDFName.of('NM'));
  const decoded = name == null ? '' : context.lookup(name);
  if (decoded && (!(decoded instanceof PDFString || decoded instanceof PDFHexString)
      || decoded.value.length > 4096)) throw new Error('PDF annotation source is unreadable.');
  let originalName;
  try { originalName = decoded ? decoded.decodeText() : ''; }
  catch { throw new Error('PDF annotation source is unreadable.'); }
  if ((source.nm ?? '') !== originalName
      || original.get(PDFName.of('Subtype'))?.toString() !== target.get(PDFName.of('Subtype'))?.toString()) {
    throw new Error('PDF annotation source changed: the markup no longer matches the annotation it was read from.');
  }
  return original;
}

/** Append one package without changing the existing full-edition hook object. */
export function composePdfHooks(current, id, contribution) {
  const next = validatePdfContribution(id, contribution);
  const base = current && Object.hasOwn(current, BASE) ? current[BASE] : current;
  const addons = [...(current?.[ADDONS] || []), next];
  const catalogKeys = [...(base?.catalogKeys || [])];
  const annotationKeys = [...(base?.annotationKeys || [])];
  const owned = new Set([...catalogKeys, ...annotationKeys]);
  for (const addon of addons) {
    for (const key of new Set([...addon.catalogKeys, ...addon.annotationKeys, ...addon.extractAnnotationKeys])) {
      if (owned.has(key)) throw new Error(`PDF key ownership collision: ${key}`);
      owned.add(key);
    }
    catalogKeys.push(...addon.catalogKeys);
    annotationKeys.push(...addon.annotationKeys);
  }
  return {
    ...base,
    [BASE]: base,
    [ADDONS]: addons,
    catalogKeys,
    annotationKeys,
    // The saver carries original values of declared v2 keys when a callback
    // does not replace them. v1 hooks retain their original ownership rule.
    annotationKeysToSkipCarry: base?.annotationKeys || [],
    readWorkspace(pdfDoc) {
      return { base: base?.readWorkspace?.(pdfDoc),
        addons: Object.fromEntries(addons.map((addon) => [addon.id,
          readCatalog(pdfDoc, addon.catalogKeys, addon.legacyCatalogKeys)])) };
    },
    applyWorkspace(doc, data) {
      base?.applyWorkspace?.(doc, data ? data.base : null);
      for (const addon of addons) {
        const fields = data?.addons?.[addon.id] || {};
        if (!Object.keys(fields).length) continue;
        const result = addon.applyCatalog?.(doc, fields);
        if (result && typeof result.then === 'function') throw new Error(`PDF ${addon.id} applyCatalog must be synchronous`);
      }
    },
    workspaceForSave(doc, pdfDoc) {
      return { base: base?.workspaceForSave?.(doc, pdfDoc),
        addons: Object.fromEntries(addons.map((addon) => {
          const fields = Object.freeze(readCatalog(pdfDoc, addon.catalogKeys, addon.legacyCatalogKeys));
          const presentKeys = Object.freeze(addon.catalogKeys.filter((key) =>
            pdfDoc.catalog.get(PDFName.of(key)) !== undefined));
          const source = Object.freeze({ fields, presentKeys });
          return [addon.id, textFields(addon.catalogForSave?.(doc, source), addon.catalogKeys,
            MAX_CATALOG_TEXT, addon.id, addon.legacyCatalogKeys, true)];
        })) };
    },
    saveWorkspace(pdfDoc, data) {
      base?.saveWorkspace?.(pdfDoc, data?.base);
      for (const addon of addons) {
        const fields = textFields(data?.addons?.[addon.id], addon.catalogKeys, MAX_CATALOG_TEXT,
          addon.id, addon.legacyCatalogKeys, true);
        for (const [key, value] of Object.entries(fields)) {
          const name = PDFName.of(key);
          if ((value === null || addon.legacyCatalogKeys.includes(key))
              && pdfDoc.catalog.get(name) !== undefined
              && !Object.hasOwn(readCatalog(pdfDoc, [key], addon.legacyCatalogKeys), key)) {
            throw new Error(value === null
              ? `Cannot delete unreadable PDF catalog key: ${key}`
              : `Cannot replace unreadable PDF legacy catalog key: ${key}`);
          }
          if (value === null) pdfDoc.catalog.delete(name);
          else pdfDoc.catalog.set(name, PDFHexString.fromText(value));
        }
      }
    },
    decorateLoadedAnnotation(model, extra) {
      let result = base?.decorateLoadedAnnotation?.(model, extra) || model;
      for (const addon of addons) {
        result = addon.decorateAnnotation?.(result, annotationFields(extra, addon.annotationKeys)) || result;
        if (result && typeof result.then === 'function') {
          throw new Error(`PDF ${addon.id} decorateAnnotation must be synchronous`);
        }
      }
      return result;
    },
    writeAnnotation(model, dict, tools) {
      base?.writeAnnotation?.(model, dict, tools);
      for (const addon of addons) {
        const fields = textFields(addon.annotationForSave?.(model), addon.annotationKeys, MAX_ANNOTATION_TEXT, addon.id);
        const original = addon.legacyAnnotationKeys.some((key) => Object.hasOwn(fields, key))
          ? verifiedAnnotationSource(model, dict, tools) : null;
        for (const [key, value] of Object.entries(fields)) {
          if (addon.legacyAnnotationKeys.includes(key)) {
            if (encoder.encode(value).length > MAX_ANNOTATION_TEXT) {
              throw new Error(`PDF ${addon.id} returned an oversized legacy annotation field: ${key}`);
            }
            const raw = original?.get(PDFName.of(key));
            if (raw != null) {
              const prior = tools.sourceContext.lookup(raw);
              if (!(prior instanceof PDFString || prior instanceof PDFHexString)
                  || prior.value.length > (MAX_ANNOTATION_TEXT + 1) * 4) {
                throw new Error(`Cannot replace unreadable PDF legacy annotation key: ${key}`);
              }
              try {
                if (prior.decodeText().length > MAX_ANNOTATION_TEXT) throw new Error('oversized');
              } catch { throw new Error(`Cannot replace unreadable PDF legacy annotation key: ${key}`); }
            }
          }
          dict.set(tools.PDFName.of(key), tools.pdfTextString(value));
        }
      }
    },
    carryToExtract(source, target, pages) {
      if (target.getPageCount() !== pages.length) {
        throw new Error('Cannot extract pages: target count does not match source selection');
      }
      const writes = [];
      for (const addon of addons) {
        const present = addon.catalogKeys.filter((key) => source.catalog.get(PDFName.of(key)) !== undefined);
        if (!present.length) continue;
        if (!addon.catalogForExtract) {
          throw new Error(`Cannot extract pages with ${addon.id} PDF data; use the add-on that can remap its catalog.`);
        }
        const fields = readCatalog(source, present, addon.legacyCatalogKeys);
        if (present.some((key) => !Object.hasOwn(fields, key))) {
          throw new Error(`Cannot extract unreadable PDF data owned by ${addon.id}`);
        }
        const sourcePages = extractTags(source, pages, addon.extractAnnotationKeys);
        if (addon.extractAnnotationKeys.length) {
          const targetPages = extractTags(target, pages.map((_, index) => index + 1), addon.extractAnnotationKeys);
          matchingExtractTags(sourcePages, targetPages, addon.extractAnnotationKeys);
        }
        const sourceData = Object.freeze({ fields: Object.freeze(fields), presentKeys: Object.freeze(present),
          pages: sourcePages });
        const values = textFields(addon.catalogForExtract(sourceData), addon.catalogKeys,
          MAX_CATALOG_TEXT, addon.id, addon.legacyCatalogKeys);
        if (present.some((key) => !Object.hasOwn(values, key))) {
          throw new Error(`PDF ${addon.id} did not remap every owned catalog field`);
        }
        writes.push(values);
      }
      const baseResult = base?.carryToExtract?.(source, target, pages);
      for (const values of writes) {
        for (const [key, value] of Object.entries(values)) {
          target.catalog.set(PDFName.of(key), PDFHexString.fromText(value));
        }
      }
      return baseResult;
    },
  };
}

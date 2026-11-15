// Carry annotation dictionary entries owned by another PDF producer or add-on
// when a loaded markup is rewritten from the editor's model. The PDF object
// reference and annotation name must still identify the source on this page.
import { PDFDict, PDFName, PDFRef, PDFString, PDFHexString } from 'pdf-lib';
import { APP_OWNED_KEYS } from '../ext-interop.js';
import { EDITOR_OWNED_ANNOTATION_KEYS } from './editor-owned-annotation-keys.js';

const IDENTITY_KEYS = new Set(['NM', 'IRT', 'RT', 'Popup']);
const STANDARD_KEYS = new Set(['Subj', 'IT', 'CreationDate', 'Measure', 'ExData',
  'StructParent', 'Lang', 'A', 'AA', 'Dest', 'H', 'PA', 'FS', 'AF']);
const N = (name) => PDFName.of(name);

/** A field outside the editor's PDF vocabulary may belong to another producer. */
export function hasUnmodeledAnnotationKeys(dict) {
  if (!(dict instanceof PDFDict)) return false;
  return dict.keys().some((key) => {
    const name = key.asString().slice(1);
    return !APP_OWNED_KEYS.has(name) && !EDITOR_OWNED_ANNOTATION_KEYS.has(name)
      && !IDENTITY_KEYS.has(name) && !STANDARD_KEYS.has(name);
  });
}

function text(context, raw) {
  const value = raw === undefined ? null : context.lookup(raw);
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
}

/**
 * Copy unmodeled entries only from the exact annotation this model came from.
 * New/copy annotations have no valid source identity and cannot inherit private
 * fields by accident. Existing values written by the editor or add-on win.
 */
export function carryUnmodeledAnnotationKeys(context, annotationRefs, model, target, ownedKeys = []) {
  const source = model?.pdfSource;
  if (!source || source.modelId !== model.id || !(target instanceof PDFDict)) return [];
  const ref = annotationRefs.find((item) => item instanceof PDFRef && item.toString() === source.ref);
  if (!ref) return [];
  const original = context.lookup(ref);
  if (!(original instanceof PDFDict)) throw new Error('PDF annotation source is unreadable.');
  if (source.nm != null && text(context, original.get(N('NM'))) !== source.nm) {
    throw new Error('PDF annotation source changed: the markup no longer matches the annotation it was read from.');
  }
  if (original.get(N('Subtype'))?.toString() !== target.get(N('Subtype'))?.toString()) {
    // The external PDF interop writer handles image annotations that the
    // editor represents with a different PDF subtype. It copies the source
    // dictionary and appearance using this same verified reference.
    if (model.extBron?.ref === source.ref) return [];
    throw new Error('PDF annotation type changed; save with its add-on available.');
  }
  const copied = [];
  for (const [key, value] of original.entries()) {
    const name = key.asString().slice(1);
    if (APP_OWNED_KEYS.has(name) || EDITOR_OWNED_ANNOTATION_KEYS.has(name)
        || STANDARD_KEYS.has(name) || IDENTITY_KEYS.has(name) || ownedKeys?.includes(name)
        || target.get(key) !== undefined) continue;
    target.set(key, value);
    copied.push(name);
  }
  return copied;
}

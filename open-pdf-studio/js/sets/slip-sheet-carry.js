// Slip sheet carry-forward: copy the markups of an old sheet onto its new
// revision, and record the swap in the drawing set.
//
// A carried markup is a NEW markup: new model ID (a new durable ID for shapes
// that have one, K-005), moved with the slip sheet alignment, with a
// `carriedFrom` reference to its source and a "Carried from Rev X" reply in
// its Markups List thread. The old revision PDF is never written; it stays
// in the sheet's revision history with its original markups. No app imports.

import { hasDurableMarkupId, uniqueDurableMarkupId } from '../annotations/durable-markup-id.js';
import { replyId } from '../annotations/markup-replies.js';
import { normalizeCarriedFrom } from '../annotations/carried-from.js';
import { relinkPastedCorrections } from '../annotations/corrections/model.js';
import { relinkCopiedGroups } from '../annotations/markup-groups.js';
import { transformMarkupGeometry } from './slip-sheet-transform.js';
import { addSheet, replaceSheet } from './sheet-register.js';
import { baseName, sheetKey } from './slip-sheet-match.js';

const SKIPPED_TYPES = new Set(['__tool-defaults__']);

function plainClone(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(plainClone(item, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  // Images, typed arrays and other host objects are shared, not copied.
  if (proto !== Object.prototype && proto !== null) return value;
  if (seen.has(value)) return seen.get(value);
  const out = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'function') out[key] = plainClone(item, seen);
  }
  return out;
}

function freshId() {
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '')
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
}

export function carriedLabel(revision) {
  const rev = String(revision ?? '').trim();
  return rev ? `Carried from Rev ${rev}` : 'Carried from an earlier revision';
}

/** Markups of `page` that a slip sheet carries (flattened content stays behind). */
export function carryableMarkups(annotations, page) {
  return (annotations || []).filter(annotation => annotation
    && (annotation.page || 1) === page
    && !SKIPPED_TYPES.has(annotation.type)
    && !(annotation.type === 'vectorSnippet' && annotation.flattened));
}

/**
 * @param {Array<object>} sources  old-page markup models (not modified)
 * @param {object} options
 * @param {number[]} options.matrix  view-space similarity (slip-sheet-transform.js)
 * @param {number} options.targetPage
 * @param {{sheetId?: string, label?: string, revision?: string, filePath: string, page: number}} options.source
 * @param {Set<string>} [options.usedIds]  IDs already on the target document; extended in place
 * @returns {Array<object>} new markup models for the target page
 */
export function carryMarkups(sources, { matrix, targetPage, source, usedIds = new Set(), author = 'OcuDraw slip sheet', now = new Date() }) {
  if (!Number.isSafeInteger(targetPage) || targetPage < 1) throw new Error('A target page is required.');
  if (!source?.filePath || !Number.isSafeInteger(source.page)) throw new Error('The source sheet is required.');
  const createdAt = new Date(now).toISOString();
  const text = carriedLabel(source.revision);
  const carried = sources.map(original => {
    const annotation = plainClone(original);
    transformMarkupGeometry(annotation, matrix);
    const durable = hasDurableMarkupId(annotation.type);
    let id;
    if (durable) id = uniqueDurableMarkupId(null, usedIds);
    else {
      do { id = freshId(); } while (usedIds.has(id));
      usedIds.add(id);
    }
    annotation.id = id;
    annotation.page = targetPage;
    annotation.modifiedAt = createdAt;
    delete annotation.gebakkenIn;
    delete annotation.pdfCircleSubtypePresent;
    annotation.carriedFrom = normalizeCarriedFrom({
      sheetId: source.sheetId, sheet: source.label, revision: source.revision,
      file: source.filePath, page: source.page,
      ...(durable && typeof original.id === 'string' ? { markupId: original.id } : {}),
    });
    const replies = Array.isArray(annotation.replies) ? annotation.replies : [];
    annotation.replies = [...replies, { id: replyId(), author, text, createdAt }];
    return annotation;
  });
  // References between carried markups follow the new ids, as on a paste: a
  // Replace keeps its caret and strikeout together, a reply (/IRT) points at
  // the carried parent, and a reference to a markup that was not carried is
  // dropped instead of dangling. A group carried whole becomes a new group.
  relinkPastedCorrections(sources, carried);
  relinkCopiedGroups(sources, carried);
  return carried;
}

const COLUMN_SETTINGS = ['markupTextColumnName', 'markupTextColumn2Name', 'markupChoiceColumn', 'markupChoiceColumn2',
  'markupNumberColumn', 'markupNumberColumn2', 'markupCheckmarkColumn', 'markupFormulaColumn'];

/**
 * Give the target document what the carried markups need to save as they
 * were: custom column and status-set definitions it does not have yet, and
 * the markup layers the carried markups sit on. Existing target settings win.
 * Returns the names of the settings it copied.
 */
export function mergeCarriedSettings(target, source, carried) {
  const copied = [];
  for (const key of COLUMN_SETTINGS) {
    if (!target[key] && source?.[key]) { target[key] = plainClone(source[key]); copied.push(key); }
  }
  if ((target.markupStatusSet === undefined || target.markupStatusSet === null) && source?.markupStatusSet) {
    target.markupStatusSet = plainClone(source.markupStatusSet);
    copied.push('markupStatusSet');
  }
  const used = new Set(carried.map(annotation => annotation.layer).filter(layer => typeof layer === 'string' && layer));
  const sourceLayers = Array.isArray(source?.annotationLayers) ? source.annotationLayers : [];
  if (used.size && sourceLayers.length) {
    const targetLayers = Array.isArray(target.annotationLayers) ? target.annotationLayers : [];
    // A document without a layer list gets the source's whole list (its
    // default layer included); otherwise only the missing layers are added.
    const layers = targetLayers.length ? [...targetLayers] : [];
    const have = new Set(layers.map(layer => layer?.id));
    for (const layer of sourceLayers) {
      if (!layer || have.has(layer.id) || (targetLayers.length && !used.has(layer.id))) continue;
      layers.push(plainClone(layer));
      have.add(layer.id);
    }
    if (layers.length !== targetLayers.length) {
      target.annotationLayers = layers;
      copied.push('annotationLayers');
    }
  }
  return copied;
}

function unique(register, preferred) {
  const used = new Set(register.sheets.map(sheet => sheetKey(sheet.label)));
  if (!used.has(sheetKey(preferred))) return preferred;
  let suffix = 2;
  while (used.has(sheetKey(`${preferred}-${suffix}`))) suffix++;
  return `${preferred}-${suffix}`;
}

/** Sheet ID for an appended page: its page label, else the PDF name (plus page number). */
export function appendedSheetLabel(register, filePath, page, pageCount, pageLabel) {
  const label = String(pageLabel ?? '').trim();
  if (label && !/^\d+$/u.test(label)) return unique(register, label);
  const name = baseName(filePath) || 'Sheet';
  return unique(register, pageCount === 1 ? name : `${name}-${label || page}`);
}

/**
 * Record a confirmed slip sheet in the drawing set. Matched rows replace their
 * sheet (the current source moves to its history); unmatched rows are
 * appended. `outputs` maps each revised PDF to the file the set should point
 * at (the copy that holds carried markups) and its fingerprint. A row may
 * carry its own `revision` (read from its title block); the others get
 * `revision`.
 *
 * @returns {{register: object, replaced: string[], appended: string[]}}
 */
export function applySlipSheet(register, rows, { revision, changedAt = new Date().toISOString(), outputs, pageCounts = {} }) {
  const common = String(revision ?? '').trim();
  const revisionOf = row => String(row.revision ?? '').trim() || common;
  if (rows.some(row => row.include && !revisionOf(row))) throw new Error('Enter the new revision.');
  let next = register;
  const replaced = [];
  const appended = [];
  for (const row of rows) {
    if (!row.include) continue;
    const nextRevision = revisionOf(row);
    const output = outputs?.get?.(row.filePath) || { path: row.filePath };
    if (row.sheetId) {
      next = replaceSheet(next, row.sheetId, output.path, nextRevision, changedAt, row.page, output.fingerprint);
      replaced.push(row.sheetId);
    } else {
      const label = appendedSheetLabel(next, row.filePath, row.page, pageCounts[row.filePath] || 0, row.pageLabel);
      const result = addSheet(next, { filePath: output.path, page: row.page, label, revision: nextRevision,
        ...(output.fingerprint ? { sourceSha256: output.fingerprint } : {}) });
      next = result.register;
      if (result.added) appended.push(result.sheet.id);
    }
  }
  return { register: next, replaced, appended };
}

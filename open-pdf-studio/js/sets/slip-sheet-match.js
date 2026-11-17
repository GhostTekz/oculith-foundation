// Slip sheet matching: which registered sheet does each page of a new
// revision PDF replace?
//
// In order of trust: the page's embedded page label equals a sheet ID; the
// file name of a single-page PDF names one sheet ID; the title-block text of
// the page names exactly one sheet ID. A label, name or sheet that would
// match twice is left for the reviewer instead of guessed. Unmatched pages
// are appended to the set. Page index is never used as a fallback. No app
// imports.

export const MATCH_REASONS = ['label', 'fileName', 'titleBlock'];

export function sheetKey(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function usableLabel(value) {
  const key = sheetKey(value);
  // Plain page numbers ("1", "2") are not sheet IDs.
  return key && !/^\d+$/u.test(key) ? key : '';
}

export function baseName(path) {
  return String(path ?? '').replaceAll('\\', '/').split('/').pop().replace(/\.pdf$/iu, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** True when `label` appears in `text` as a whole token (no letter or digit on either side). */
export function containsSheetId(text, label) {
  const key = usableLabel(label);
  if (!key) return false;
  const haystack = sheetKey(text);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(key).replace(/ /gu, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'u');
  return pattern.test(haystack);
}

function uniqueSheetIn(text, sheets) {
  if (!text) return null;
  const found = sheets.filter(sheet => containsSheetId(text, sheet.label));
  if (found.length === 1) return found[0];
  if (found.length < 2) return null;
  // "A-101.1" also contains the token "A-101": the longer ID wins only when
  // every other hit is part of it. Two unrelated IDs stay unmatched.
  const longest = [...found].sort((a, b) => b.label.length - a.label.length)[0];
  return found.every(sheet => sheet === longest || sheetKey(longest.label).includes(sheetKey(sheet.label)))
    ? longest : null;
}

/**
 * Text items of a PDF.js page (scale-one viewport, items with
 * `transform`) that lie in the title-block region: the right 35 % or the
 * bottom 25 % of the visible sheet.
 */
export function titleBlockText(items, viewport) {
  if (!Array.isArray(items) || typeof viewport?.convertToViewportPoint !== 'function') return '';
  const parts = [];
  for (const item of items) {
    if (typeof item?.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) continue;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    if (x >= viewport.width * 0.65 || y >= viewport.height * 0.75) parts.push(item.str);
    if (parts.length > 2000) break;
  }
  return parts.join(' ');
}

/**
 * @param {{sheets: Array<{id: string, label: string}>}} register
 * @param {Array<{filePath: string, pageCount: number, pageLabels?: Array<string|null>|null, titleBlockTexts?: Array<string>}>} files
 * @returns {{rows: Array<{key: string, filePath: string, page: number, pageLabel: string, sheetId: string|null, reason: string|null, include: boolean}>, conflicts: Array<{sheetId: string, keys: string[]}>, collisions: Array<{key: string, sheetIds: string[], labels: string[]}>}}
 */
export function planSlipSheet(register, files) {
  if (!register || !Array.isArray(register.sheets)) throw new Error('A drawing set is required.');
  if (!Array.isArray(files) || !files.length) throw new Error('Choose at least one revised PDF.');
  const rows = [];
  for (const file of files) {
    if (!file?.filePath || !Number.isSafeInteger(file.pageCount) || file.pageCount < 1) {
      throw new Error('Every revised PDF needs a path and at least one page.');
    }
    for (let page = 1; page <= file.pageCount; page++) {
      rows.push({ key: `${file.filePath}#${page}`, filePath: file.filePath, page,
        pageLabel: String(file.pageLabels?.[page - 1] ?? '').trim(), sheetId: null, reason: null, include: true,
        _file: file });
    }
  }
  // The register tells sheets apart by their trimmed, lower-case ID; matching
  // also folds spacing and Unicode normalization. Sheets whose IDs differ only
  // there ("A 101" and "A  101") share one match key: none of them is matched
  // and the plan reports them, instead of the last one silently winning.
  const byKey = new Map();
  const sameKey = new Map(); // key -> sheets that share it
  for (const sheet of register.sheets) {
    const key = usableLabel(sheet.label);
    if (!key) continue;
    if (sameKey.has(key)) sameKey.get(key).push(sheet);
    else if (byKey.has(key)) { sameKey.set(key, [byKey.get(key), sheet]); byKey.delete(key); }
    else byKey.set(key, sheet);
  }
  const collisions = [...sameKey].map(([key, sheets]) => ({ key,
    sheetIds: sheets.map(sheet => sheet.id), labels: sheets.map(sheet => sheet.label) }));
  const ambiguous = new Set(collisions.flatMap(collision => collision.sheetIds));
  const claimed = new Map(); // sheetId -> row keys
  const conflicts = [];
  const claim = (candidates) => {
    const wanted = new Map();
    for (const { row, sheet } of candidates) {
      if (!wanted.has(sheet.id)) wanted.set(sheet.id, []);
      wanted.get(sheet.id).push(row);
    }
    for (const [sheetId, wanting] of wanted) {
      if (claimed.has(sheetId)) continue;
      if (wanting.length > 1) {
        conflicts.push({ sheetId, keys: wanting.map(row => row.key) });
        claimed.set(sheetId, []);
        continue;
      }
      claimed.set(sheetId, [wanting[0].key]);
      wanting[0].sheetId = sheetId;
    }
  };
  const open = () => rows.filter(row => !row.sheetId);
  const free = () => register.sheets.filter(sheet => !claimed.has(sheet.id) && !ambiguous.has(sheet.id));
  const already = (row, sheet) => sheetKey(sheet.filePath) === sheetKey(row.filePath) && sheet.page === row.page;

  // 1. Embedded page label.
  const labelled = [];
  for (const row of open()) {
    const sheet = byKey.get(usableLabel(row.pageLabel));
    if (sheet && !already(row, sheet)) labelled.push({ row, sheet });
  }
  claim(labelled);
  for (const { row } of labelled) if (row.sheetId) row.reason ??= 'label';

  // 2. File name of a single-page PDF.
  const named = [];
  for (const row of open()) {
    if (row._file.pageCount !== 1) continue;
    const sheet = uniqueSheetIn(baseName(row.filePath), free());
    if (sheet && !already(row, sheet)) named.push({ row, sheet });
  }
  claim(named);
  for (const { row } of named) if (row.sheetId) row.reason ??= 'fileName';

  // 3. Title-block text.
  const titled = [];
  for (const row of open()) {
    const sheet = uniqueSheetIn(row._file.titleBlockTexts?.[row.page - 1], free());
    if (sheet && !already(row, sheet)) titled.push({ row, sheet });
  }
  claim(titled);
  for (const { row } of titled) if (row.sheetId) row.reason ??= 'titleBlock';

  for (const row of rows) delete row._file;
  return { rows, conflicts, collisions };
}

/** A reviewer-facing line for sheet IDs that collapse to one match key, or ''. */
export function slipSheetCollisionText(collisions) {
  if (!Array.isArray(collisions) || !collisions.length) return '';
  const groups = collisions.map(c => c.labels.map(label => `"${label}"`).join(' / '));
  return `Sheet IDs that differ only in spacing or character form are not matched automatically: ${groups.join('; ')}. Assign these pages by hand.`;
}

/** Rows that would replace the same sheet twice, or replace a sheet that no longer exists. */
export function slipSheetRowErrors(register, rows) {
  const errors = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row.include || !row.sheetId) continue;
    if (!register.sheets.some(sheet => sheet.id === row.sheetId)) errors.push({ key: row.key, error: 'missingSheet' });
    else if (seen.has(row.sheetId)) errors.push({ key: row.key, error: 'duplicateSheet' });
    seen.add(row.sheetId);
  }
  return errors;
}

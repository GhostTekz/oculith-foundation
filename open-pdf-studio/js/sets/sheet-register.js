import { parseTitleBlockTemplates } from './title-block-template.js';

const VERSION = 1;

function clean(value) {
  return String(value ?? '').trim();
}

function key(value) {
  return clean(value).toLocaleLowerCase();
}

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/).at(-1);
}

function sourceSha256(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('The drawing set contains an invalid PDF fingerprint.');
  }
  return value;
}

function withSourceFingerprint(source, fingerprint) {
  const result = { ...source };
  if (fingerprint) result.sourceSha256 = fingerprint;
  else delete result.sourceSha256;
  return result;
}

function ownsSource(sheet, filePath, page) {
  const matches = item => key(item.filePath) === key(filePath) && Number(item.page) === page;
  return matches(sheet) || sheet.history.some(matches) || (sheet.sourceAliases || []).some(matches);
}

function sourceOwner(register, filePath, page, exceptId = null) {
  return register.sheets.find(sheet => sheet.id !== exceptId && ownsSource(sheet, filePath, page));
}

function sheetId() {
  return globalThis.crypto?.randomUUID?.() || `sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validPage(page) {
  const number = Number(page);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Page must be a positive whole number.');
  return number;
}

// The sheet's date as its title block prints it (a title block template reads it); kept only when set.
function withDate(value) {
  const date = clean(value);
  return date ? { date } : {};
}

function withoutDate(sheet) {
  const { date: _date, ...rest } = sheet;
  return rest;
}

// The id of the title block template that last read the sheet: its number
// and title come from its title block. A new revision is not read yet.
function withTemplateRead(value) {
  return typeof value === 'string' && value && value.length <= 200 ? { titleBlockTemplate: value } : {};
}

function withoutTitleBlockRead(sheet) {
  const { date: _date, titleBlockTemplate: _template, ...rest } = sheet;
  return rest;
}

function requireText(value, field) {
  const result = clean(value);
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

export function createSheetRegister(name = 'Drawing set') {
  return { version: VERSION, name: requireText(name, 'Set name'), sheets: [] };
}

export function addSheet(register, entry) {
  const filePath = requireText(entry.filePath, 'PDF path');
  const page = validPage(entry.page ?? 1);
  const existing = sourceOwner(register, filePath, page);
  if (existing) return { register, sheet: existing, added: false };
  const label = requireText(entry.label, 'Sheet ID');
  if (register.sheets.some(sheet => key(sheet.label) === key(label))) {
    throw new Error(`Sheet ID “${label}” is already in this set.`);
  }
  const sheet = {
    id: sheetId(), label, title: clean(entry.title), revision: clean(entry.revision),
    filePath, page, history: [], sourceAliases: [],
    ...(sourceSha256(entry.sourceSha256) ? { sourceSha256: entry.sourceSha256 } : {}),
  };
  return { register: { ...register, sheets: [...register.sheets, sheet] }, sheet, added: true };
}

export function updateSheet(register, id, changes) {
  const target = register.sheets.find(sheet => sheet.id === id);
  if (!target) throw new Error('Sheet is no longer in this set.');
  const label = 'label' in changes ? requireText(changes.label, 'Sheet ID') : target.label;
  if (register.sheets.some(sheet => sheet.id !== id && key(sheet.label) === key(label))) {
    throw new Error(`Sheet ID “${label}” is already in this set.`);
  }
  const page = 'page' in changes ? validPage(changes.page) : target.page;
  if (sourceOwner(register, target.filePath, page, id)) {
    throw new Error('That PDF page is already registered as another sheet.');
  }
  return {
    ...register,
    sheets: register.sheets.map(sheet => sheet.id === id
      ? { ...withoutDate(sheet), label, page, title: 'title' in changes ? clean(changes.title) : sheet.title,
          revision: 'revision' in changes ? clean(changes.revision) : sheet.revision,
          ...withDate('date' in changes ? changes.date : sheet.date) }
      : sheet),
  };
}

export function replaceSheet(register, id, filePath, revision, changedAt = new Date().toISOString(), page, fingerprint) {
  const path = requireText(filePath, 'PDF path');
  const nextRevision = requireText(revision, 'Revision');
  const target = register.sheets.find(sheet => sheet.id === id);
  if (!target) throw new Error('Sheet is no longer in this set.');
  const nextPage = page === undefined ? target.page : validPage(page);
  const nextFingerprint = sourceSha256(fingerprint);
  if (key(target.filePath) === key(path) && target.page === nextPage && target.revision === nextRevision) {
    if (target.sourceSha256 && nextFingerprint && target.sourceSha256 !== nextFingerprint) {
      throw new Error('The PDF changed at this path. Enter a new revision before recording it.');
    }
    return register;
  }
  if (sourceOwner(register, path, nextPage, id)) {
    throw new Error('That PDF page is already registered as another sheet.');
  }
  return {
    ...register,
    sheets: register.sheets.map(sheet => sheet.id === id
      ? withSourceFingerprint({ ...withoutTitleBlockRead(sheet), filePath: path, page: nextPage, revision: nextRevision,
          history: [...sheet.history, {
            filePath: sheet.filePath, page: sheet.page, revision: sheet.revision,
            replacedAt: changedAt,
            ...(sheet.sourceSha256 ? { sourceSha256: sheet.sourceSha256 } : {}),
          }] }, nextFingerprint)
      : sheet),
  };
}

export function relinkSheet(register, id, filePath, page, fingerprint) {
  const path = requireText(filePath, 'PDF path');
  const target = register.sheets.find(sheet => sheet.id === id);
  if (!target) throw new Error('Sheet is no longer in this set.');
  const nextPage = page === undefined ? target.page : validPage(page);
  const nextFingerprint = sourceSha256(fingerprint);
  if (target.sourceSha256 && nextFingerprint !== target.sourceSha256) {
    throw new Error('Selected PDF does not match the recorded sheet. Use Record revision for changed contents.');
  }
  if (key(target.filePath) === key(path) && target.page === nextPage) return register;
  if (sourceOwner(register, path, nextPage, id)) {
    throw new Error('That PDF page is already registered as another sheet.');
  }
  return { ...register, sheets: register.sheets.map(sheet => sheet.id === id
    ? withSourceFingerprint({ ...sheet, filePath: path, page: nextPage,
        sourceAliases: [...(sheet.sourceAliases || []), { filePath: sheet.filePath, page: sheet.page,
          ...(sheet.sourceSha256 ? { sourceSha256: sheet.sourceSha256 } : {}) }]
          .filter((item, index, aliases) => !(key(item.filePath) === key(path) && item.page === nextPage)
            && aliases.findIndex(other => key(other.filePath) === key(item.filePath) && other.page === item.page) === index) },
      nextFingerprint)
    : sheet) };
}

/** The register with its title block templates set (none removes them). */
export function setTitleBlockTemplates(register, templates) {
  const checked = parseTitleBlockTemplates(templates);
  const { titleBlockTemplates: _old, ...rest } = register;
  return checked.length ? { ...rest, titleBlockTemplates: checked } : rest;
}

/** Move one earlier revision to an identical PDF at a new path. */
export function relinkHistoricalSource(register, id, historyIndex, filePath, fingerprint, pageCount) {
  const path = requireText(filePath, 'PDF path');
  const target = register.sheets.find(sheet => sheet.id === id);
  if (!target) throw new Error('Sheet is no longer in this set.');
  const prior = target.history[historyIndex];
  if (!Number.isSafeInteger(historyIndex) || !prior) throw new Error('Earlier revision is no longer in this set.');
  const expected = sourceSha256(prior.sourceSha256);
  if (!expected) throw new Error('This earlier revision has no recorded PDF fingerprint. Reimport it at its recorded path before relinking.');
  if (sourceSha256(fingerprint) !== expected) throw new Error('Selected PDF does not match the recorded earlier revision.');
  if (!Number.isSafeInteger(pageCount) || prior.page > pageCount) {
    throw new Error(`The recorded page ${prior.page} is not in the selected PDF.`);
  }
  if (sourceOwner(register, path, prior.page, id)) {
    throw new Error('That PDF page is already registered as another sheet.');
  }
  const knownDifferent = register.sheets.some(sheet => [sheet, ...sheet.history, ...(sheet.sourceAliases || [])]
    .some(source => key(source.filePath) === key(path) && source.sourceSha256 && source.sourceSha256 !== expected));
  if (knownDifferent) throw new Error('That PDF path is recorded with different contents in this drawing set.');
  if (key(prior.filePath) === key(path)) return register;
  return { ...register, sheets: register.sheets.map(sheet => sheet.id === id
    ? { ...sheet, history: sheet.history.map((entry, index) => index === historyIndex ? { ...entry, filePath: path } : entry) }
    : sheet) };
}

export function removeSheet(register, id) {
  return { ...register, sheets: register.sheets.filter(sheet => sheet.id !== id) };
}

export function filterSheets(register, query = '', revision = '') {
  const terms = key(query).split(/\s+/u).filter(Boolean);
  const currentRevision = key(revision);
  return register.sheets.filter(sheet => {
    if (currentRevision && key(sheet.revision) !== currentRevision) return false;
    if (!terms.length) return true;
    const fields = [sheet.label, sheet.title, sheet.revision, fileName(sheet.filePath),
      ...sheet.history.flatMap(item => [item.revision, fileName(item.filePath)]),
      ...(sheet.sourceAliases || []).map(item => fileName(item.filePath))].map(key);
    return terms.every(term => fields.some(field => field.includes(term)));
  });
}

const sheetLabelOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function sortSheetsByLabel(sheets) {
  return [...sheets].sort((first, second) => sheetLabelOrder.compare(first.label, second.label)
    || first.label.localeCompare(second.label, 'en') || first.id.localeCompare(second.id, 'en'));
}

export function adjacentSheet(sheets, selectedId, direction) {
  if (direction !== 'previous' && direction !== 'next') throw new Error('Unknown sheet direction.');
  const index = sheets.findIndex(sheet => sheet.id === selectedId);
  return sheets[index + (direction === 'next' ? 1 : -1)] || null;
}

export function parseSheetRegister(json) {
  const value = typeof json === 'string' ? JSON.parse(json) : json;
  if (!value || value.version !== VERSION || typeof value.name !== 'string' || !Array.isArray(value.sheets)) {
    throw new Error('This is not a supported drawing set manifest.');
  }
  const register = createSheetRegister(value.name);
  const templates = parseTitleBlockTemplates(value.titleBlockTemplates);
  if (templates.length) register.titleBlockTemplates = templates;
  const ids = new Set();
  for (const source of value.sheets) {
    if (!source || typeof source.id !== 'string' || !source.id || ids.has(source.id)
      || typeof source.filePath !== 'string' || !source.filePath.trim()
      || typeof source.label !== 'string' || !source.label.trim()
      || !Array.isArray(source.history)) throw new Error('The drawing set contains an invalid sheet.');
    if (register.sheets.some(sheet => key(sheet.label) === key(source.label))) throw new Error('The drawing set contains duplicate sheet IDs.');
    ids.add(source.id);
    const history = source.history.map(item => {
      if (!item || typeof item.filePath !== 'string' || !item.filePath.trim()
        || typeof item.revision !== 'string' || typeof item.replacedAt !== 'string') {
        throw new Error('The drawing set contains invalid revision history.');
      }
      const fingerprint = sourceSha256(item.sourceSha256);
      return { filePath: item.filePath, page: validPage(item.page), revision: item.revision,
        replacedAt: item.replacedAt, ...(fingerprint ? { sourceSha256: fingerprint } : {}) };
    });
    if (source.sourceAliases !== undefined && !Array.isArray(source.sourceAliases)) {
      throw new Error('The drawing set contains invalid source links.');
    }
    const sourceAliases = (source.sourceAliases ?? []).map(item => {
      if (!item || typeof item.filePath !== 'string' || !item.filePath.trim()) {
        throw new Error('The drawing set contains invalid source links.');
      }
      const fingerprint = sourceSha256(item.sourceSha256);
      return { filePath: item.filePath, page: validPage(item.page),
        ...(fingerprint ? { sourceSha256: fingerprint } : {}) };
    });
    const fingerprint = sourceSha256(source.sourceSha256);
    const sheet = { id: source.id, label: clean(source.label), title: clean(source.title),
      revision: clean(source.revision), ...withDate(typeof source.date === 'string' ? source.date : ''),
      ...withTemplateRead(source.titleBlockTemplate),
      filePath: source.filePath, page: validPage(source.page), history, sourceAliases,
      ...(fingerprint ? { sourceSha256: fingerprint } : {}) };
    const lineage = [sheet, ...sheet.history, ...sheet.sourceAliases];
    if (lineage.some(item => sourceOwner(register, item.filePath, item.page))) {
      throw new Error('The drawing set assigns one PDF page to multiple sheet IDs.');
    }
    register.sheets.push(sheet);
  }
  return register;
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function drawingLogCsv(register, availability = {}) {
  const columns = ['Stable sheet ID', 'Sheet ID', 'Title', 'Source', 'Revision', 'Page', 'PDF file', 'File status', 'Replaced at', 'Recorded PDF SHA-256', 'Sheet date'];
  const rows = register.sheets.flatMap(sheet => [
    [sheet.id, sheet.label, sheet.title, 'Current', sheet.revision, sheet.page,
      sheet.filePath, availability[sheet.id] || 'Unknown', '', sheet.sourceSha256 || '', sheet.date || ''],
    ...[...sheet.history].reverse().map(item => [sheet.id, sheet.label, sheet.title, 'Prior',
      item.revision, item.page, item.filePath, '', item.replacedAt, item.sourceSha256 || '', '']),
  ]);
  return '\uFEFF' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

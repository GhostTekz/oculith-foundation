// Dynamic stamp templates (plan-review stamps, docs/reference/editor/markup-tools.md).
//
// A template describes a stamp: text lines (size, bold), a border, a colour,
// an optional image and dynamic fields in the text ({date}, {time}, {user},
// {pageLabel}, {fileName}, {status}). Placing a stamp evaluates the fields
// once and stores the result as plain text in a "design" (the external editor behaviour);
// the design keeps the template id it came from.
//
// Pure module: no DOM, no app state, so the node tests load it directly.

export const STAMP_TEMPLATE_VERSION = 1;
export const STAMP_FIELDS = Object.freeze(['date', 'time', 'user', 'pageLabel', 'fileName', 'status']);
export const STAMP_BORDERS = Object.freeze(['none', 'rectangle', 'rounded', 'double']);
export const STAMP_DATE_FORMATS = Object.freeze(['locale', 'iso', 'us', 'eu']);
export const STAMP_LIMITS = Object.freeze({
  lines: 6, text: 120, name: 60, status: 60, minSize: 4, maxSize: 72,
  // A data URL of at most ~300 kB keeps preferences and the saved PDF small.
  image: 300_000, stamps: 100, json: 4_000_000,
});
export const STAMP_EXPORT_FORMAT = 'ocudraw-stamps';
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const TEMPLATE_ID = /^(?:ct|user):[A-Za-z0-9._-]{1,80}$/u;
const IMAGE_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/gu;

const line = (text, size, bold = false) => ({ text, size, bold });
const builtIn = (key, name, color, border, lines) => Object.freeze({
  version: STAMP_TEMPLATE_VERSION, id: `ct:${key}`, name, color, border, dateFormat: 'locale',
  status: name, lines: Object.freeze(lines.map(item => Object.freeze(item))),
});
const SIGNED = '{user}  {date}';

/** The built-in contractor stamps, each with the usual date/user line. */
export const CONTRACTOR_STAMPS = Object.freeze([
  builtIn('reviewed', 'Reviewed', '#1d4ed8', 'rounded', [line('REVIEWED', 18, true), line(SIGNED, 8)]),
  builtIn('approved', 'Approved', '#15803d', 'rounded', [line('APPROVED', 18, true), line(SIGNED, 8)]),
  builtIn('approvedAsNoted', 'Approved as Noted', '#0f766e', 'rounded',
    [line('APPROVED AS NOTED', 16, true), line(SIGNED, 8)]),
  builtIn('reviseResubmit', 'Revise & Resubmit', '#b45309', 'rounded',
    [line('REVISE & RESUBMIT', 16, true), line(SIGNED, 8)]),
  builtIn('rejected', 'Rejected', '#b91c1c', 'rounded', [line('REJECTED', 18, true), line(SIGNED, 8)]),
  builtIn('fieldVerified', 'Field Verified', '#1d4ed8', 'double',
    [line('FIELD VERIFIED', 16, true), line('{user}  {date}  {time}', 8)]),
  builtIn('asBuilt', 'As-Built', '#6d28d9', 'double', [line('AS-BUILT', 18, true), line('{date}', 8)]),
  builtIn('forConstruction', 'For Construction', '#15803d', 'double',
    [line('FOR CONSTRUCTION', 16, true), line('{date}', 8)]),
  builtIn('notForConstruction', 'Not for Construction', '#b91c1c', 'double',
    [line('NOT FOR CONSTRUCTION', 16, true)]),
  builtIn('void', 'Void', '#4b5563', 'rectangle', [line('VOID', 22, true), line('{date}', 8)]),
]);

const clip = (value, max) => String(value ?? '').replace(CONTROL, ' ').slice(0, max);

function cleanLine(value) {
  if (!value || typeof value !== 'object') return null;
  const size = Number(value.size);
  if (!Number.isFinite(size)) return null;
  return {
    text: clip(value.text, STAMP_LIMITS.text),
    size: Math.min(STAMP_LIMITS.maxSize, Math.max(STAMP_LIMITS.minSize, Math.round(size * 10) / 10)),
    bold: value.bold === true,
  };
}

/** A validated { dataUrl, width, height } image, or null. */
export function cleanStampImage(value) {
  if (!value || typeof value !== 'object' || typeof value.dataUrl !== 'string' ||
      value.dataUrl.length > STAMP_LIMITS.image || !IMAGE_URL.test(value.dataUrl)) return null;
  const width = Number(value.width), height = Number(value.height);
  if (!(width > 0 && height > 0 && width <= 10000 && height <= 10000)) return null;
  return { dataUrl: value.dataUrl, width, height };
}

/**
 * Validate a template (built-in or user stamp, or one read from a JSON file).
 * Returns a plain copy with only known keys, or null.
 */
export function cleanStampTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== STAMP_TEMPLATE_VERSION) return null;
  if (typeof value.id !== 'string' || !TEMPLATE_ID.test(value.id)) return null;
  const name = clip(value.name, STAMP_LIMITS.name).trim();
  if (!name || !Array.isArray(value.lines) || value.lines.length > STAMP_LIMITS.lines) return null;
  const lines = value.lines.map(cleanLine);
  if (lines.some(item => !item) || !lines.some(item => item.text.trim())) return null;
  const template = {
    version: STAMP_TEMPLATE_VERSION, id: value.id, name,
    color: typeof value.color === 'string' && HEX_COLOR.test(value.color) ? value.color.toLowerCase() : '#b91c1c',
    border: STAMP_BORDERS.includes(value.border) ? value.border : 'rounded',
    dateFormat: STAMP_DATE_FORMATS.includes(value.dateFormat) ? value.dateFormat : 'locale',
    status: clip(value.status ?? name, STAMP_LIMITS.status),
    lines,
  };
  const image = cleanStampImage(value.image);
  if (image) template.image = image;
  return template;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** {date} text for a format; 'locale' uses Intl (the app's locale). */
export function formatStampDate(date, format = 'locale', locale) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
  if (format === 'iso') return `${y}-${m}-${day}`;
  if (format === 'us') return `${m}/${day}/${y}`;
  if (format === 'eu') return `${day}-${m}-${y}`;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** {time} text: 24 h except for the US format. */
export function formatStampTime(date, format = 'locale', locale) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  if (format === 'iso' || format === 'eu') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (format === 'us') {
    const h = d.getHours() % 12 || 12;
    return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
}

/** The file name of a path or URL, without folders. */
export function stampFileName(path) {
  const text = String(path ?? '');
  return text.split(/[\\/]/u).filter(Boolean).at(-1) || '';
}

/**
 * Replace the dynamic fields in one text. Unknown {names} stay as typed.
 * @param {string} text
 * @param {{ now?: Date, user?: string, pageLabel?: string, page?: number,
 *   fileName?: string, status?: string, dateFormat?: string, locale?: string }} context
 */
export function evaluateStampText(text, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const format = STAMP_DATE_FORMATS.includes(context.dateFormat) ? context.dateFormat : 'locale';
  const pageLabel = typeof context.pageLabel === 'string' && context.pageLabel.trim()
    ? context.pageLabel.trim() : (context.page ? String(context.page) : '');
  const values = {
    date: () => formatStampDate(now, format, context.locale),
    time: () => formatStampTime(now, format, context.locale),
    user: () => String(context.user || '').trim() || 'User',
    pageLabel: () => pageLabel,
    fileName: () => stampFileName(context.fileName),
    status: () => String(context.status ?? ''),
  };
  return String(text ?? '').replace(/\{([A-Za-z]+)\}/gu, (whole, name) =>
    (Object.hasOwn(values, name) ? clip(values[name](), STAMP_LIMITS.text) : whole));
}

/** Does a template use a dynamic field? */
export function stampUsesFields(template) {
  return !!template?.lines?.some(item => /\{(?:date|time|user|pageLabel|fileName|status)\}/u.test(item.text));
}

/**
 * The placed form of a template: its fields evaluated and stored as text.
 * The design keeps the template id and name; lines that end up empty go.
 */
export function instantiateStampTemplate(template, context = {}) {
  const clean = cleanStampTemplate(template);
  if (!clean) return null;
  const evaluated = clean.lines
    .map(item => ({ ...item, text: evaluateStampText(item.text, {
      ...context, dateFormat: clean.dateFormat, status: context.status ?? clean.status,
    }).trim() }))
    .filter(item => item.text);
  const design = {
    version: STAMP_TEMPLATE_VERSION, templateId: clean.id, name: clean.name, color: clean.color,
    border: clean.border, lines: evaluated.length ? evaluated : [{ ...clean.lines[0], text: clean.name }],
  };
  if (clean.image) design.image = clean.image;
  return design;
}

/** Validate a placed design (from the canvas model or a saved PDF). */
export function cleanStampDesign(value) {
  if (!value || typeof value !== 'object' || value.version !== STAMP_TEMPLATE_VERSION) return null;
  const template = cleanStampTemplate({ ...value, id: value.templateId, status: '' });
  if (!template) return null;
  const design = { version: STAMP_TEMPLATE_VERSION, templateId: template.id, name: template.name,
    color: template.color, border: template.border, lines: template.lines };
  if (template.image) design.image = template.image;
  return design;
}

/** The stamp's text as one string (search, Markups List, /OPS_StampText). */
export function stampDesignText(design) {
  return (design?.lines || []).map(item => item.text).join('\n');
}

export function findBuiltInStampTemplate(id) {
  return CONTRACTOR_STAMPS.find(template => template.id === id) || null;
}

/** A new user stamp id. */
export function newUserStampId(random = () => globalThis.crypto?.randomUUID?.() ||
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`) {
  return `user:${String(random()).replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 80) || Date.now().toString(36)}`;
}

/** Export user stamps as JSON text (`{ format, version, stamps }`). */
export function serializeUserStamps(templates) {
  const stamps = (Array.isArray(templates) ? templates : []).map(cleanStampTemplate).filter(Boolean)
    .filter(template => template.id.startsWith('user:'));
  return JSON.stringify({ format: STAMP_EXPORT_FORMAT, version: STAMP_TEMPLATE_VERSION, stamps }, null, 2);
}

/**
 * Read a stamps JSON file. Each valid stamp gets a user id; one that clashes
 * with `existingIds` gets a new id. Throws on a file that is not a stamps file.
 * @returns {{ stamps: object[], skipped: number }}
 */
export function parseUserStampsJson(text, existingIds = [], makeId = newUserStampId) {
  if (typeof text !== 'string' || text.length > STAMP_LIMITS.json) throw new Error('Stamp file is too large.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Stamp file is not valid JSON.'); }
  if (!data || data.format !== STAMP_EXPORT_FORMAT || data.version !== STAMP_TEMPLATE_VERSION ||
      !Array.isArray(data.stamps)) throw new Error('Not an OcuDraw stamps file.');
  const taken = new Set(existingIds);
  const stamps = [];
  let skipped = 0;
  for (const raw of data.stamps.slice(0, STAMP_LIMITS.stamps)) {
    const id = typeof raw?.id === 'string' && raw.id.startsWith('user:') && !taken.has(raw.id) ? raw.id : makeId();
    const template = cleanStampTemplate({ ...raw, id });
    if (!template) { skipped += 1; continue; }
    taken.add(template.id);
    stamps.push(template);
  }
  skipped += Math.max(0, data.stamps.length - STAMP_LIMITS.stamps);
  return { stamps, skipped };
}

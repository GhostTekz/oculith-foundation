// Title block templates of a drawing set: capture boxes drawn once on one
// sheet for the sheet number, title, revision and date, saved with the
// layout they belong to, and read on every sheet of that layout.
//
// A template recognises its layout by two things:
//   1. The page size in model space (scale 1, the page's /Rotate applied),
//      within 0.5 % or 2 pt. Width and height are not swapped: a landscape
//      sheet does not match a portrait one.
//   2. Anchors: the fixed words printed around the boxes on the sheet the
//      template was made from ("SHEET NO.", "PROJECT", the firm name). Text
//      with a digit is left out, as numbers and dates change from sheet to
//      sheet. Each anchor keeps its centre as fractions of the page; a page
//      matches when enough anchors appear with the same text at about the
//      same place.
// Page size alone would mix two title block layouts of one size (consultants,
// a cover sheet); the anchors tell them apart, while the values that differ
// from sheet to sheet do not disturb them.
//
// Pure: runs are `{ str, box: { x, y, width, height } }` in model space
// (region-text.js textRuns). No app imports.

import { regionFractions, regionOnPage, textOfRuns } from '../pdf/region-text.js';

export const TEMPLATE_FIELDS = Object.freeze(['label', 'title', 'revision', 'date']);
export const TEMPLATE_FIELD_NAMES = Object.freeze({
  label: 'Sheet number', title: 'Sheet title', revision: 'Revision', date: 'Date',
});

const MAX_ANCHORS = 12;
const ANCHOR_TOLERANCE = 0.02; // of the page width and height
const MAX_TEMPLATES = 50;

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const norm = (value) => clean(value).toLocaleUpperCase();
const round = (value) => Math.round(Number(value) * 10) / 10;
const cx = (box) => box.x + box.width / 2;
const cy = (box) => box.y + box.height / 2;

function within(box, rect, pad = 0) {
  return cx(box) >= rect.x - pad && cx(box) <= rect.x + rect.width + pad
    && cy(box) >= rect.y - pad && cy(box) <= rect.y + rect.height + pad;
}

function templateId() {
  return globalThis.crypto?.randomUUID?.() || `tbt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Whether two page sizes are the same sheet size (0.5 % or 2 pt). */
export function sameSheetSize(a, b) {
  const close = (x, y) => Math.abs(x - y) <= Math.max(2, 0.005 * Math.max(x, y));
  return a?.width > 0 && a?.height > 0 && b?.width > 0 && b?.height > 0
    && close(a.width, b.width) && close(a.height, b.height);
}

/**
 * The fixed words around the field boxes (`rects`, model space) on a page of
 * `width` x `height`: runs within the boxes' surroundings, outside every box,
 * with a letter and no digit, each text once (a text printed twice there is
 * left out), nearest first, at most 12. Centres as fractions of the page.
 */
export function templateAnchors(runs, width, height, rects) {
  if (!rects.length || !(width > 0) || !(height > 0)) return [];
  const left = Math.min(...rects.map(r => r.x));
  const top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width));
  const bottom = Math.max(...rects.map(r => r.y + r.height));
  const padX = Math.max((right - left) * 0.5, width * 0.05);
  const padY = Math.max((bottom - top) * 0.5, height * 0.05);
  const area = { x: left - padX, y: top - padY, width: right - left + 2 * padX, height: bottom - top + 2 * padY };
  const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const seen = new Map();
  for (const run of runs || []) {
    const text = norm(run?.str);
    if (!run?.box || text.length < 3 || !/\p{L}/u.test(text) || /\d/u.test(text)) continue;
    if (!within(run.box, area) || rects.some(rect => within(run.box, rect, 1))) continue;
    seen.set(text, seen.has(text) ? null : run.box);
  }
  return [...seen].filter(([, box]) => box)
    .map(([text, box]) => ({ text, x: cx(box) / width, y: cy(box) / height,
      distance: Math.hypot(cx(box) - centre.x, cy(box) - centre.y) }))
    .sort((a, b) => a.distance - b.distance || a.text.localeCompare(b.text))
    .slice(0, MAX_ANCHORS)
    .map(({ text, x, y }) => ({ text, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 }));
}

/**
 * A template from boxes drawn on one page. `fields` maps a field
 * (TEMPLATE_FIELDS) to its rectangle in model space; `runs` the page's text.
 */
export function createTitleBlockTemplate({ name, width, height, fields, runs, id = templateId() }) {
  const title = clean(name);
  if (!title) throw new Error('Template name is required.');
  if (!(width > 0) || !(height > 0)) throw new Error('The page size is unknown.');
  const boxes = {};
  for (const field of TEMPLATE_FIELDS) {
    const rect = fields?.[field];
    if (!rect) continue;
    const fractions = regionFractions(rect, width, height);
    if (!fractions) throw new Error(`The ${TEMPLATE_FIELD_NAMES[field].toLocaleLowerCase()} box is empty.`);
    boxes[field] = fractions;
  }
  if (!boxes.label && !boxes.title) throw new Error('Mark the sheet number or the sheet title.');
  const rects = Object.values(boxes).map(fr => regionOnPage(fr, width, height));
  return { id, name: title, size: { width: round(width), height: round(height) }, fields: boxes,
    anchors: templateAnchors(runs, width, height, rects) };
}

/**
 * Whether `page` ({ width, height, runs }) has the template's layout:
 * `{ matches, found, total, reason }`. A template without anchors matches
 * on the page size alone. With anchors, all are needed up to two, else
 * 60 % of them.
 */
export function matchTitleBlockTemplate(template, page) {
  const total = template.anchors.length;
  if (!sameSheetSize(template.size, page)) {
    return { matches: false, found: 0, total, reason: `Page size ${Math.round(page?.width || 0)} × ${Math.round(page?.height || 0)} pt is not the template's ${Math.round(template.size.width)} × ${Math.round(template.size.height)} pt.` };
  }
  const runs = (page.runs || []).filter(run => run?.box);
  let found = 0;
  for (const anchor of template.anchors) {
    const x = anchor.x * page.width;
    const y = anchor.y * page.height;
    const dx = ANCHOR_TOLERANCE * page.width;
    const dy = ANCHOR_TOLERANCE * page.height;
    const hit = runs.some(run => {
      const text = norm(run.str);
      if (text === anchor.text) return Math.abs(cx(run.box) - x) <= dx && Math.abs(cy(run.box) - y) <= dy;
      // The same words inside a longer run, or split over runs: the anchor's centre on the run.
      return (text.includes(anchor.text) || anchor.text.includes(text) && text.length >= 3)
        && x >= run.box.x - dx && x <= run.box.x + run.box.width + dx && Math.abs(cy(run.box) - y) <= dy;
    });
    if (hit) found++;
  }
  const need = total <= 2 ? total : Math.ceil(total * 0.6);
  const matches = found >= need;
  return { matches, found, total,
    reason: matches ? '' : `Title block text differs: ${found} of ${total} fixed words found.` };
}

// A field label caught in the box with its value.
const FIELD_LABEL = {
  label: /^(?:(?:sheet|drawing|dwg)\.?\s*(?:no\b\.?|number\b|#|id\b)|sheet\b)\s*[:#.-]?\s*/iu,
  // "TITLE SHEET" is a title: a bare TITLE is a label only with its colon.
  title: /^(?:(?:sheet|drawing|dwg)\s+title\b\s*[:#.-]?|title\s*[:#-])\s*/iu,
  revision: /^rev(?:ision\b|\b\.?|\.)\s*(?:no\b\.?|#)?\s*[:#.-]?\s*/iu,
  date: /^(?:(?:issue|plot|revision)\s+)?date\b\s*[:#.-]?\s*/iu,
};

/** The fields' text on `page` ({ width, height, runs }): `{ label, title, revision, date }` ('' when empty). */
export function readTitleBlockFields(template, page) {
  const out = {};
  for (const field of TEMPLATE_FIELDS) {
    const fractions = template.fields[field];
    if (!fractions) continue;
    let text = textOfRuns(page.runs, regionOnPage(fractions, page.width, page.height));
    const stripped = text.replace(FIELD_LABEL[field], '');
    if (stripped) text = stripped;
    if (field === 'label') text = text.replace(/\s*([-.])\s*/gu, '$1');
    out[field] = clean(text);
  }
  return out;
}

/**
 * The template for a page: of the templates that match it, the one with
 * the most anchors found (then the most anchors). `{ template, match }`, or
 * `{ template: null, reasons }` with each template's reason.
 */
export function chooseTitleBlockTemplate(templates, page) {
  let best = null;
  const reasons = [];
  for (const template of templates || []) {
    const match = matchTitleBlockTemplate(template, page);
    if (!match.matches) { reasons.push(`${template.name}: ${match.reason}`); continue; }
    if (!best || match.found > best.match.found || (match.found === best.match.found && match.total > best.match.total)) {
      best = { template, match };
    }
  }
  return best || { template: null, reasons };
}

const key = (value) => clean(value).toLocaleLowerCase();

/**
 * What the templates give each sheet of `register`. `pages` maps a sheet id
 * to its page ({ width, height, runs }) or `{ error }`. Returns
 * `{ rows, unmatched, conflicts }`: `rows` the sheets a template matched,
 * with the `changes` it makes (empty values change nothing); `unmatched`
 * the sheets left as they are, with the reason; `conflicts` the sheet
 * numbers not taken because another sheet has or gets the same one (the
 * row's other fields still apply).
 */
export function planTitleBlockApply(register, pages, templates) {
  const rows = [];
  const unmatched = [];
  for (const sheet of register.sheets) {
    const page = pages.get(sheet.id);
    if (!page || page.error) {
      unmatched.push({ sheetId: sheet.id, label: sheet.label, reason: page?.error || 'The page was not read.' });
      continue;
    }
    const { template, reasons } = chooseTitleBlockTemplate(templates, page);
    if (!template) {
      unmatched.push({ sheetId: sheet.id, label: sheet.label, reason: reasons.join(' ') || 'No template.' });
      continue;
    }
    const read = readTitleBlockFields(template, page);
    const changes = {};
    for (const [field, value] of Object.entries(read)) {
      if (value && value !== clean(sheet[field])) changes[field] = value;
    }
    rows.push({ sheetId: sheet.id, label: sheet.label, templateId: template.id, templateName: template.name, read, changes });
  }
  // Sheet numbers stay unique: a number another sheet keeps or two sheets
  // get is not taken. Dropping one leaves its old number in place, which can
  // collide in turn (a swap), so this repeats until nothing collides.
  const conflicts = [];
  const byId = new Map(rows.map(row => [row.sheetId, row]));
  for (let again = true; again;) {
    again = false;
    const owners = new Map();
    for (const sheet of register.sheets) {
      const label = key(byId.get(sheet.id)?.changes.label ?? sheet.label);
      owners.set(label, (owners.get(label) || 0) + 1);
    }
    for (const row of rows) {
      if (!row.changes.label || owners.get(key(row.changes.label)) < 2) continue;
      conflicts.push({ sheetId: row.sheetId, label: row.label,
        reason: `Sheet number “${row.changes.label}” is also on another sheet of this set; kept “${row.label}”.` });
      delete row.changes.label;
      again = true;
    }
  }
  return { rows, unmatched, conflicts };
}

/**
 * The register with the plan's changes made (sheet number, title, revision,
 * date). Every sheet a template matched records that template's id
 * (`titleBlockTemplate`): its values come from its title block.
 */
export function applyTitleBlockPlan(register, plan) {
  const rows = new Map(plan.rows.map(row => [row.sheetId, row]));
  if (![...rows.values()].some(row => Object.keys(row.changes).length
    || register.sheets.find(sheet => sheet.id === row.sheetId)?.titleBlockTemplate !== row.templateId)) return register;
  const next = { ...register, sheets: register.sheets.map(sheet => rows.has(sheet.id)
    ? { ...sheet, ...rows.get(sheet.id).changes, titleBlockTemplate: rows.get(sheet.id).templateId } : sheet) };
  const labels = new Set();
  for (const sheet of next.sheets) {
    if (labels.has(key(sheet.label))) throw new Error(`Sheet ID “${sheet.label}” is already in this set.`);
    labels.add(key(sheet.label));
  }
  return next;
}

function validFraction(box) {
  return box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1.0001 && box.y + box.height <= 1.0001;
}

/** Checked templates from saved data (a set manifest or the user defaults); throws on a bad one. */
export function parseTitleBlockTemplates(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TEMPLATES) throw new Error('The title block templates are invalid.');
  const ids = new Set();
  return value.map(item => {
    const bad = () => new Error('The drawing set contains an invalid title block template.');
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !clean(item.name)) throw bad();
    if (!(item.size?.width > 0) || !(item.size?.height > 0)) throw bad();
    const fields = {};
    for (const field of TEMPLATE_FIELDS) {
      if (item.fields?.[field] === undefined) continue;
      if (!validFraction(item.fields[field])) throw bad();
      const { x, y, width, height } = item.fields[field];
      fields[field] = { x, y, width, height };
    }
    if (!fields.label && !fields.title) throw bad();
    if (!Array.isArray(item.anchors) || item.anchors.length > MAX_ANCHORS) throw bad();
    const anchors = item.anchors.map(anchor => {
      if (!anchor || typeof anchor.text !== 'string' || !anchor.text || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) throw bad();
      return { text: anchor.text, x: anchor.x, y: anchor.y };
    });
    ids.add(item.id);
    return { id: item.id, name: clean(item.name), size: { width: item.size.width, height: item.size.height }, fields, anchors };
  });
}

/** `list` with `template` added, or replacing the one with its id. */
export function withTemplate(list, template) {
  const rest = (list || []).filter(item => item.id !== template.id);
  if (rest.length >= MAX_TEMPLATES) throw new Error(`At most ${MAX_TEMPLATES} title block templates can be kept.`);
  return [...rest, template];
}

/** The set's templates first, then the user's defaults the set does not hold. */
export function combinedTemplates(setTemplates, userTemplates) {
  const ids = new Set((setTemplates || []).map(item => item.id));
  return [...(setTemplates || []), ...(userTemplates || []).filter(item => !ids.has(item.id))];
}

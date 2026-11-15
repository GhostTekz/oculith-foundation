// Add to Tool Chest rules and group tools (the external editor "Create and save custom
// markups in Tool Chest"; docs/reference/editor/tool-chest.md).
//
// the external editor does not add notes, hyperlinks, file attachments, text markups
// (highlight, underline, squiggly, strikeout, review text) or symbols with a
// sequence or an action to the Tool Chest. addToToolChestBlockReason names
// the rule a markup breaks, so the menu can say why.
//
// A group (Shift-select ▸ Group, i.e. a shared groupId) saved to the Tool
// Chest becomes ONE tool: an exact copy of its members, always Drawing Mode.
// The members are stored relative to the group's bounds, without ids,
// page, author, dates, replies or group id; placing the tool centres a fresh
// copy (new ids, one new group) on the click.
//
// No app state: the move primitive is injected (annotations/transforms.js
// applyMoveGeneric in the app), so node tests cover it.

export const MAX_GROUP_MEMBERS = 256;
export const MAX_GROUP_BYTES = 512 * 1024;

const TEXT_MARKUP_TYPES = new Set(['textHighlight', 'textUnderline', 'textSquiggly', 'textStrikeout',
  'textStrikethrough', 'textStrike', 'textReplace', 'textInsert', 'caret', 'reviewText']);
const LINK_TYPES = new Set(['hyperlink', 'link']);
const ATTACHMENT_TYPES = new Set(['fileAttachment', 'attachment', 'sound']);
const FILE_ATTACHMENT_ICONS = new Set(['paperclip', 'pushpin', 'graph', 'tag', 'attachment']);
// Fields a group member never keeps: identity, place, people and threads.
const DROPPED_MEMBER_FIELDS = new Set(['id', 'page', 'groupId', 'groupPath', 'author', 'createdAt', 'modifiedAt',
  'inReplyTo', 'replies', 'replyTo', 'selected', 'nm', 'NM', 'pdfRef', 'objectNumber', 'sourceRef',
  'reviewStatus', 'stateHistory', 'capturePhotos', 'attachedFile',
  // A markup layer id belongs to one document; the tool's own `layer` name
  // decides where a placed group goes (docs/reference/editor/layers.md).
  'layer']);

/**
 * Why a markup cannot go into the Tool Chest, or null when the external editor allows it:
 * 'note' | 'hyperlink' | 'attachment' | 'textMarkup' | 'sequenceSymbol'.
 */
export function addToToolChestBlockReason(annotation) {
  if (!annotation || typeof annotation.type !== 'string') return 'unsupported';
  const type = annotation.type;
  if (ATTACHMENT_TYPES.has(type) || annotation.attachedFile ||
      (type === 'comment' && FILE_ATTACHMENT_ICONS.has(annotation.icon))) return 'attachment';
  if (type === 'comment' && annotation.icon !== 'flag') return 'note';
  if (LINK_TYPES.has(type)) return 'hyperlink';
  if (TEXT_MARKUP_TYPES.has(type) || (type === 'highlight' && Array.isArray(annotation.rects) && annotation.rects.length) ||
      (Array.isArray(annotation.quadPoints) && annotation.quadPoints.length)) return 'textMarkup';
  if ((type === 'stamp' || type === 'symbol' || type === 'parametricSymbol') &&
      (annotation.sequence || annotation.action || annotation.actions || annotation.linkAction ||
       annotation.linkTarget)) return 'sequenceSymbol';
  return null;
}

/** The members of the group a markup belongs to (itself alone when ungrouped). */
export function groupMembersOf(annotation, annotations) {
  if (!annotation?.groupId || !Array.isArray(annotations)) return annotation ? [annotation] : [];
  return annotations.filter(item => item && item.groupId === annotation.groupId && item.page === annotation.page);
}

/** Is the selection one whole group of two or more markups? */
export function selectionIsOneGroup(selection, annotations) {
  if (!Array.isArray(selection) || !selection.length) return false;
  const groupId = selection[0]?.groupId;
  if (!groupId || selection.some(item => item?.groupId !== groupId)) return false;
  return groupMembersOf(selection[0], annotations).length >= 2;
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

function memberCopy(annotation) {
  const copy = JSON.parse(JSON.stringify(annotation));
  for (const key of Object.keys(copy)) {
    if (DROPPED_MEMBER_FIELDS.has(key) || key.startsWith('_')) delete copy[key];
  }
  return copy;
}

/**
 * Capture a group as tool data: { members, geometry } or { error }.
 * `bounds(annotation)` → { x, y, width, height } (page space);
 * `move(annotation, dx, dy)` moves a copy in place.
 */
export function captureGroupTool(members, { bounds, move }) {
  if (!Array.isArray(members) || members.length < 2) return { error: 'notGroup' };
  if (members.length > MAX_GROUP_MEMBERS) return { error: 'tooMany' };
  for (const member of members) {
    if (addToToolChestBlockReason(member)) return { error: 'blockedMember', reason: addToToolChestBlockReason(member) };
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const member of members) {
    const box = bounds(member);
    if (!box || ![box.x, box.y, box.width, box.height].every(finite)) return { error: 'noBounds' };
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width); maxY = Math.max(maxY, box.y + box.height);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return { error: 'noBounds' };
  const copies = members.map((member) => {
    const copy = memberCopy(member);
    move(copy, -minX, -minY);
    return copy;
  });
  const result = cleanGroupMembers(copies);
  if (!result) return { error: 'tooLarge' };
  return { members: result, geometry: { kind: 'box', width, height, rotation: 0 } };
}

/** Validate stored members (untrusted when they come from a file). */
export function cleanGroupMembers(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_GROUP_MEMBERS) return null;
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { return null; }
  if (size > MAX_GROUP_BYTES) return null;
  const out = [];
  for (const member of value) {
    if (!member || typeof member !== 'object' || Array.isArray(member) ||
        typeof member.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(member.type) ||
        addToToolChestBlockReason(member)) return null;
    const copy = memberCopy(member);
    // Untrusted image or script payloads are not part of a tool.
    delete copy.script; delete copy.javascript; delete copy.js;
    out.push(copy);
  }
  return out;
}

/**
 * Fresh markups for one placement of a group tool, centred on (x, y).
 * opts: { move, makeId, now, author } — the copies share one new group id and
 * belong to the person placing them.
 */
export function placeGroupTool(preset, page, x, y, { move, makeId, now = () => new Date().toISOString(), author }) {
  const members = cleanGroupMembers(preset?.members);
  const geometry = preset?.geometry;
  if (!members || !geometry || !finite(x) || !finite(y)) return [];
  const dx = x - geometry.width / 2;
  const dy = y - geometry.height / 2;
  const groupId = `grp_${makeId()}`;
  return members.map((member) => {
    const copy = JSON.parse(JSON.stringify(member));
    move(copy, dx, dy);
    copy.id = makeId();
    copy.page = page;
    copy.groupId = groupId;
    if (typeof author === 'string' && author) copy.author = author;
    copy.createdAt = now();
    copy.modifiedAt = copy.createdAt;
    return copy;
  });
}

// OcuDraw tool set FILE (docs/reference/editor/tool-chest.md): the file a shared tool
// set lives in (Manage Tool Sets ▸ Add ▸ Add New / Add Existing) and the
// file Export writes. Unlike portable JSON (tool-set-portable.js, a strict
// interchange contract for a few tool types), the set file holds every
// Tool Chest tool type, in the same shape the Tool Chest keeps locally.
//
//   { "format": "ocudraw.tool-set-file", "version": 1, "name": "Doors",
//     "referenceScale"?: { pixelsPerUnit, unit },
//     "tools": [ { "id", "name", "tool", "style", "mode", … } ] }
//
// Reading is structural only: sizes, shapes and names. The Tool Chest then
// cleans every tool with the same validator as its own storage
// (tool-chest-presets.js cleanPreset), so a tool that does not validate is
// left out and counted, never trusted. Fields this version does not know
// (for example a newer app's tool field) are kept in the file when the set
// is written again (mergeUnknownToolFields).

export const TOOL_SET_FILE_FORMAT = 'ocudraw.tool-set-file';
export const TOOL_SET_FILE_VERSION = 1;
export const MAX_TOOL_SET_FILE_BYTES = 512 * 1024;
export const MAX_TOOL_SET_FILE_TOOLS = 200;
export const TOOL_SET_FILE_EXTENSION = 'ocudraw-toolset';

// Tool fields the Tool Chest itself writes. Anything else in a file's tool
// record is "unknown" and carried through a rewrite unchanged. `layer` is the
// markup-layer field (feat/ocudraw-markup-layers): the Tool Chest keeps it,
// so a layer removed locally is not brought back from the old file.
export const KNOWN_TOOL_FIELDS = Object.freeze(['id', 'name', 'tool', 'style', 'setId', 'mode',
  'geometry', 'text', 'sequence', 'subject', 'comment', 'members', 'layer']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON-safe deep copy without prototype keys (input may be untrusted). */
function plainCopy(value, depth = 0) {
  if (depth > 24) throw new Error('The tool set file is nested too deeply.');
  if (Array.isArray(value)) return value.map(item => plainCopy(item, depth + 1));
  if (record(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!FORBIDDEN_KEYS.has(key)) out[key] = plainCopy(item, depth + 1);
    }
    return out;
  }
  return value;
}

function cleanName(value, fallback) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim() : '';
  return (text || fallback).slice(0, 48);
}

/** Is this byte string an OcuDraw tool set file (by its format field)? */
export function looksLikeToolSetFile(bytes) {
  try {
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512));
    return head.includes(`"${TOOL_SET_FILE_FORMAT}"`);
  } catch {
    return false;
  }
}

/**
 * Parse a set file: { name, tools, referenceScale? }. Tool records are
 * plain copies; the caller validates each one. Throws on anything that is
 * not a set file of this version.
 */
export function parseToolSetFile(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_TOOL_SET_FILE_BYTES) {
    throw new Error(`A tool set file must be at most ${MAX_TOOL_SET_FILE_BYTES} bytes.`);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('The tool set file is not valid UTF-8 JSON.'); }
  if (!record(parsed) || parsed.format !== TOOL_SET_FILE_FORMAT) {
    throw new Error('This is not an OcuDraw tool set file.');
  }
  if (parsed.version !== TOOL_SET_FILE_VERSION) {
    throw new Error(`Tool set file version ${String(parsed.version).slice(0, 12)} is not supported.`);
  }
  if (!Array.isArray(parsed.tools) || parsed.tools.length > MAX_TOOL_SET_FILE_TOOLS) {
    throw new Error(`A tool set file holds at most ${MAX_TOOL_SET_FILE_TOOLS} tools.`);
  }
  const tools = [];
  let rejected = 0;
  for (const tool of parsed.tools) {
    if (!record(tool) || typeof tool.id !== 'string' || !tool.id || tool.id.length > 160 ||
        typeof tool.name !== 'string' || typeof tool.tool !== 'string' || tool.tool.length > 40 ||
        !record(tool.style)) {
      rejected++;
      continue;
    }
    const copy = plainCopy(tool);
    delete copy.setId;
    tools.push(copy);
  }
  return {
    name: cleanName(parsed.name, 'Tool set'),
    tools,
    rejected,
    ...(record(parsed.referenceScale) ? { referenceScale: plainCopy(parsed.referenceScale) } : {}),
  };
}

/** Bytes of a set file. `tools` are Tool Chest tools; their setId is not written. */
export function buildToolSetFile({ name, tools, referenceScale = null }) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_SET_FILE_TOOLS) {
    throw new Error(`A tool set file holds at most ${MAX_TOOL_SET_FILE_TOOLS} tools.`);
  }
  const document = {
    format: TOOL_SET_FILE_FORMAT,
    version: TOOL_SET_FILE_VERSION,
    name: cleanName(name, 'Tool set'),
    ...(referenceScale ? { referenceScale: plainCopy(referenceScale) } : {}),
    tools: tools.map((tool) => {
      const copy = plainCopy(tool);
      delete copy.setId;
      return copy;
    }),
  };
  const bytes = encoder.encode(`${JSON.stringify(document, null, 2)}\n`);
  if (bytes.byteLength > MAX_TOOL_SET_FILE_BYTES) throw new Error('The tool set is too large for a tool set file.');
  return bytes;
}

/**
 * Carry fields this app does not know from the previous file's tool (same
 * id) into the tool about to be written, so a rewrite never drops them.
 */
export function mergeUnknownToolFields(tools, previousTools) {
  const previous = new Map((previousTools || []).filter(record).map(tool => [tool.id, tool]));
  return (tools || []).map((tool) => {
    const old = previous.get(tool.id);
    if (!old) return tool;
    const extra = {};
    for (const [key, value] of Object.entries(old)) {
      if (!KNOWN_TOOL_FIELDS.includes(key) && !Object.hasOwn(tool, key) && !FORBIDDEN_KEYS.has(key)) {
        extra[key] = plainCopy(value);
      }
    }
    return Object.keys(extra).length ? { ...tool, ...extra } : tool;
  });
}

/** File name for Export / Add New: "<name>.ocudraw-toolset". */
export function suggestedToolSetFileName(setName) {
  const base = String(setName || 'tool-set').normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[_.]+|[_.]+$/gu, '').slice(0, 48) || 'tool-set';
  return `${base}.${TOOL_SET_FILE_EXTENSION}`;
}

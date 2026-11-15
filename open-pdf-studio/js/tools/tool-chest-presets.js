import { createSignal } from 'solid-js';
import {
  PORTABLE_TOOL_TYPES, PORTABLE_STYLE_KEYS, buildPortableToolSetBytes, parsePortableToolSetBytes,
} from './tool-set-portable.js';
import { applyDrawingGeometry, captureToolGeometry, cleanToolGeometry, scaleToolGeometry } from './tool-preset-geometry.js';
import { cleanSequence, takeSequenceLabel, stampSequenceLabel } from './tool-sequences.js';
import { BUILT_IN_STAMPS } from '../annotations/stamp-defaults.js';
import { presetLineStyle } from './tool-preset-line-style.js';
import { cleanCountStyle } from './tool-preset-count.js';
import { ensureLayerNamed, DEFAULT_LAYER_ID } from '../annotations/annotatie-lagen.js';
import { addToToolChestBlockReason, cleanGroupMembers, MAX_GROUP_MEMBERS } from './tool-chest-groups.js';

const STORAGE_KEY = 'oculith-tool-chest-presets-v1';
const SETS_STORAGE_KEY = 'oculith-tool-chest-sets-v1';
export const DEFAULT_TOOL_SET_ID = 'my-tools';
// Every tool of every set, shared sets included (docs/reference/editor/tool-chest.md).
export const MAX_TOOL_CHEST_TOOLS = 2000;
const MAX_PRESETS = MAX_TOOL_CHEST_TOOLS;
export const MAX_TOOL_SETS = 80;
const MAX_RECENT_TOOLS = 8;
// Local-only tool types (no portable JSON yet): counts and the Drawing Mode
// tools added for the external editor parity. A flag is a comment markup with the flag
// icon; a symbol is a stamp placed from the symbol palette.
export const LOCAL_ONLY_TOOL_TYPES = ['count', 'polyline', 'polygon', 'cloudPolyline',
  'typewriter', 'flag', 'stamp', 'symbol', 'group'];
// the external editor: groups and stamps are always placed as an exact copy (Drawing Mode).
export const ALWAYS_DRAWING_TOOL_TYPES = Object.freeze(['stamp', 'group']);
const TOOL_DETAIL_LIMIT = 200;
const TOOLS = new Set([...PORTABLE_TOOL_TYPES, 'callout', ...LOCAL_ONLY_TOOL_TYPES]);
// Tools whose Drawing Mode can replay saved display text.
const TEXT_TOOLS = new Set(['textbox', 'typewriter']);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const SYMBOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * The Tool Chest tool of a markup: its type, except a flag (comment with the
 * flag icon) and a palette symbol (stamp with a symbol id and SVG).
 */
export function presetToolOf(annotation) {
  if (!annotation || typeof annotation.type !== 'string') return null;
  if (annotation.type === 'comment') return annotation.icon === 'flag' ? 'flag' : 'comment';
  if (annotation.type === 'stamp' && typeof annotation.symbolId === 'string' && annotation.symbolId &&
      (annotation.stampSvg || annotation.stampBaseSvg)) return 'symbol';
  return annotation.type;
}

/** Does a placed markup belong to this saved tool? A symbol tool matches only its own symbol. */
function presetMatches(preset, annotation) {
  const tool = presetToolOf(annotation);
  return !!preset && preset.tool === tool &&
    (tool !== 'symbol' || preset.style?.symbolId === annotation.symbolId);
}

function opacityOf(source) {
  return typeof source.opacity === 'number' && Number.isFinite(source.opacity) &&
    source.opacity >= 0 && source.opacity <= 1 ? { opacity: source.opacity } : {};
}
const STYLE_KEYS = PORTABLE_STYLE_KEYS;
const NUMBER_KEYS = new Set(['opacity', 'lineWidth', 'headSize']);
const TEXTBOX_STYLE_KEYS = ['textColor', 'fontSize', 'fontFamily', 'fontBold', 'fontItalic',
  'fontUnderline', 'textAlign', 'lineSpacing'];
const TEXTBOX_TEXT_LIMIT = 2000;

const [presets, setPresets] = createSignal([]);
const [toolSets, setToolSets] = createSignal([]);
// Construction pack shipped with the app. Memory only: it is larger than
// localStorage, and a restart reads the files again.
const [bundledSets, setBundledSets] = createSignal([]);
const [bundledPresets, setBundledPresets] = createSignal([]);
// Intentionally memory-only: Recent Tools start empty on every app launch.
const [recentTools, setRecentTools] = createSignal([]);
const [activePreset, setActivePreset] = createSignal(null);
let loaded = false;

function cleanStyle(source, tool) {
  if (tool === 'group') {
    // A group tool's appearance is its members (preset.members).
    return Number.isInteger(source.memberCount) && source.memberCount >= 2 && source.memberCount <= MAX_GROUP_MEMBERS
      ? { memberCount: source.memberCount } : {};
  }
  if (tool === 'flag') {
    const style = {};
    for (const key of ['color', 'fillColor']) {
      if (typeof source[key] === 'string' && HEX_COLOR.test(source[key])) style[key] = source[key];
    }
    return Object.keys(style).length ? { ...style, ...opacityOf(source) } : {};
  }
  if (tool === 'stamp' && typeof source.stampTemplateId === 'string') {
    // A dynamic stamp (docs/reference/editor/markup-tools.md): the template id, looked up again at
    // placement, where its fields are evaluated. No design or image data.
    if (!/^(?:ct|user):[A-Za-z0-9._-]{1,80}$/u.test(source.stampTemplateId)) return {};
    const name = typeof source.stampName === 'string' ? source.stampName.slice(0, 80) : '';
    const color = typeof source.stampColor === 'string' && HEX_COLOR.test(source.stampColor) ? source.stampColor
      : typeof source.color === 'string' && HEX_COLOR.test(source.color) ? source.color : null;
    return { stampTemplateId: source.stampTemplateId, ...(name ? { stampName: name } : {}),
      ...(color ? { color } : {}), ...opacityOf(source) };
  }
  if (tool === 'stamp') {
    // Built-in text stamps only: name, text and colour come from the stamp
    // list, never image data or a custom stamp file.
    const builtIn = BUILT_IN_STAMPS.find(stamp => stamp.name === source.stampName);
    if (!builtIn || source.imageData || source.stampSvg) return {};
    const color = typeof source.stampColor === 'string' && HEX_COLOR.test(source.stampColor)
      ? source.stampColor : builtIn.color;
    return { stampName: builtIn.name, stampText: builtIn.text, stampColor: color, color, strokeColor: color,
      ...opacityOf(source) };
  }
  if (tool === 'symbol') {
    // The palette symbol id only; the SVG is looked up again in the palette.
    if (typeof source.symbolId !== 'string' || !SYMBOL_ID.test(source.symbolId)) return {};
    return { symbolId: source.symbolId, ...opacityOf(source) };
  }
  if (tool === 'count') {
    // Dot: colour and opacity. Symbol: also symbol, size, number display and
    // category name; the PDF saves the symbol as a vector appearance.
    return cleanCountStyle(source);
  }
  const style = {};
  for (const key of STYLE_KEYS) {
    if (!(key in source)) continue;
    // PDF FreeText callouts currently save an open 8pt arrowhead regardless
    // of these canvas-only fields, so do not promise a reusable head style.
    if (tool === 'callout' && (key === 'headSize' || key === 'startHead' || key === 'endHead')) continue;
    const value = source[key];
    if (key === 'fillColor' && value === null) style[key] = null;
    else if (NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) style[key] = value;
    else if (!NUMBER_KEYS.has(key) && typeof value === 'string' && value.length <= 128) style[key] = value;
  }
  if (tool === 'polygon' && Number.isInteger(source.sides) && source.sides >= 3 && source.sides <= 64) {
    style.sides = source.sides;
  }
  // Custom line style (the external editor line styles): id plus a copy of the definition.
  Object.assign(style, presetLineStyle(source, tool));
  if (tool === 'textbox' || tool === 'callout' || tool === 'typewriter') {
    for (const key of TEXTBOX_STYLE_KEYS) {
      if (!(key in source)) continue;
      const value = source[key];
      if (key === 'textColor' && typeof value === 'string' &&
          /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value)) style[key] = value;
      else if (key === 'fontSize' && typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 512) style[key] = value;
      else if (key === 'fontFamily' && typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value)) style[key] = value;
      else if (['fontBold', 'fontItalic', 'fontUnderline'].includes(key) && typeof value === 'boolean') style[key] = value;
      else if (key === 'textAlign' && ['left', 'center', 'right'].includes(value)) style[key] = value;
      else if (key === 'lineSpacing' && /^(?:[1-9]\d*(?:\.\d+)?|0\.\d+)$/u.test(String(value)) && Number(value) <= 10) style[key] = value;
    }
  }
  if (tool === 'callout') {
    if (typeof source.textPadding === 'number' && Number.isFinite(source.textPadding) &&
        source.textPadding >= 0 && source.textPadding <= 512) style.textPadding = source.textPadding;
    if (source.leaderStyle === 'curved') style.leaderStyle = 'curved';
    if (source.borderEffect === 'cloudy') {
      style.borderEffect = 'cloudy';
      if (typeof source.cloudIntensity === 'number' && Number.isFinite(source.cloudIntensity) &&
          source.cloudIntensity >= 0 && source.cloudIntensity <= 2) style.cloudIntensity = source.cloudIntensity;
    }
  }
  return style;
}

function reusableTextboxText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= TEXTBOX_TEXT_LIMIT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? value : null;
}

function cleanPreset(value) {
  if (!value || typeof value !== 'object' || !TOOLS.has(value.tool) ||
      typeof value.id !== 'string' || !value.id ||
      typeof value.name !== 'string' || !value.name.trim() ||
      !value.style || typeof value.style !== 'object' || Array.isArray(value.style)) return null;
  const style = cleanStyle(value.style, value.tool);
  if (!Object.keys(style).length) return null;
  const members = value.tool === 'group' ? cleanGroupMembers(value.members) : null;
  if (value.tool === 'group' && (!members || members.length !== style.memberCount)) return null;
  const setId = value.setId === DEFAULT_TOOL_SET_ID || toolSets().some(set => set.id === value.setId)
    || (typeof value.setId === 'string' && /^pack_[A-Za-z0-9._-]{1,80}$/u.test(value.setId))
    ? value.setId : DEFAULT_TOOL_SET_ID;
  const text = TEXT_TOOLS.has(value.tool) ? reusableTextboxText(value.text) : null;
  const geometry = TEXT_TOOLS.has(value.tool) && !text ? null : cleanToolGeometry(value.tool, value.geometry);
  const sequence = cleanSequence(value.sequence);
  const layer = cleanToolLayerName(value.layer);
  if (value.tool === 'group' && !geometry) return null;
  const alwaysDrawing = ALWAYS_DRAWING_TOOL_TYPES.includes(value.tool) && geometry;
  return { id: value.id, name: value.name.trim().slice(0, 80), tool: value.tool, style, setId,
    mode: (value.mode === 'drawing' || alwaysDrawing) && geometry ? 'drawing' : 'properties',
    ...(geometry ? { geometry } : {}), ...(text && geometry ? { text } : {}),
    ...(sequence ? { sequence } : {}), ...toolDetails(value),
    ...(members ? { members } : {}), ...(layer ? { layer } : {}) };
}

/** the external editor Detail view fields of a tool: Subject and Comment (the Label is its name). */
function detailText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim().slice(0, TOOL_DETAIL_LIMIT) : '';
}
function toolDetails(value) {
  const subject = detailText(value?.subject);
  const comment = detailText(value?.comment);
  return { ...(subject ? { subject } : {}), ...(comment ? { comment } : {}) };
}

// Tool layers (the external editor "Add tool sets to PDF layers", docs/reference/editor/layers.md):
// a saved tool can name a markup layer. Tools with the same name share one
// layer; it is created in the document when the first markup is placed.
export const TOOL_LAYER_NAME_LIMIT = 120;

/** A trimmed layer name without control characters, or null. */
export function cleanToolLayerName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= TOOL_LAYER_NAME_LIMIT && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)
    ? trimmed : null;
}

// Scale-aware sets (the external editor): a named set can carry the drawing scale its
// Drawing Mode tools were made for. Placing one of them where the page has
// another calibrated scale resizes the saved geometry proportionally.
export const REFERENCE_SCALE_UNITS = Object.freeze({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 });

/** A validated { pixelsPerUnit, unit } reference scale, or null. */
export function cleanReferenceScale(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'pixelsPerUnit' && key !== 'unit')) return null;
  const { pixelsPerUnit, unit } = value;
  if (typeof pixelsPerUnit !== 'number' || !Number.isFinite(pixelsPerUnit) ||
      pixelsPerUnit <= 0 || pixelsPerUnit > 1e6 || !Object.hasOwn(REFERENCE_SCALE_UNITS, unit)) return null;
  return { pixelsPerUnit, unit };
}

function pointsPerMm(scale) {
  const clean = scale ? cleanReferenceScale({ pixelsPerUnit: scale.pixelsPerUnit, unit: scale.unit }) : null;
  return clean ? clean.pixelsPerUnit / REFERENCE_SCALE_UNITS[clean.unit] : 0;
}

/** Drawing ratio 1:N of a scale (paper points per real unit), rounded. */
export function referenceScaleRatio(scale) {
  const perMm = pointsPerMm(scale);
  return perMm > 0 ? Math.round((72 / 25.4) / perMm * 100) / 100 : null;
}

// The app supplies the calibrated scale at a page point (annotation-creators
// registers getMeasureScale); without it, or on an uncalibrated page, the
// saved size is used unchanged.
let pageScaleResolver = null;
export function setToolChestScaleResolver(resolve) {
  pageScaleResolver = typeof resolve === 'function' ? resolve : null;
}

// Symbol count presets count in their own category (by name). The app
// supplies how a category name becomes a document category id and the next
// free number there (annotation-creators registers the count store).
let countCategoryResolver = null;
export function setToolChestCountCategoryResolver(resolve) {
  countCategoryResolver = typeof resolve === 'function' ? resolve : null;
}

function placeCountInPresetCategory(props) {
  if (!countCategoryResolver) return props;
  let placed = null;
  try { placed = countCategoryResolver(props.countCategory, props); } catch { return props; }
  return placed && typeof placed.categoryId === 'string' && Number.isSafeInteger(placed.number)
    ? { ...props, categoryId: placed.categoryId, number: placed.number } : props;
}

/** Save a symbol count tool from the Tool Chest form (no markup needed). */
export function saveSymbolCountPreset(fields, name, setId = DEFAULT_TOOL_SET_ID) {
  const color = fields?.color;
  return saveToolPreset({ type: 'count', markerStyle: 'symbol', symbolId: fields?.symbolId,
    symbolSize: fields?.symbolSize, showNumber: fields?.showNumber !== false,
    countCategory: fields?.countCategory, color, strokeColor: color,
    ...(fields?.opacity !== undefined ? { opacity: fields.opacity } : {}) }, name, setId);
}

/** Resize factor for a placement with a tool of a scale-aware set (1 = unchanged). */
export function toolScaleFactor(preset, page, x, y) {
  const set = preset?.setId ? toolSets().find(item => item.id === preset.setId) : null;
  const reference = pointsPerMm(set?.referenceScale);
  if (!reference || !pageScaleResolver || !Number.isFinite(x) || !Number.isFinite(y)) return 1;
  let local = null;
  try { local = pageScaleResolver(page, x, y); } catch { return 1; }
  if (!local?.calibrated) return 1;
  const factor = pointsPerMm(local) / reference;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function cleanSet(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' ||
      !/^set_[A-Za-z0-9._-]{1,128}$/u.test(value.id) ||
      typeof value.name !== 'string' || !value.name.trim()) return null;
  const referenceScale = cleanReferenceScale(value.referenceScale);
  // Manage Tool Sets: Display off hides the set; `profile` limits it to one
  // workspace profile (Show In All Profiles off).
  const profile = typeof value.profile === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value.profile)
    ? value.profile : null;
  return { id: value.id, name: value.name.trim().slice(0, 48), ...(referenceScale ? { referenceScale } : {}),
    ...(value.hidden === true ? { hidden: true } : {}), ...(profile ? { profile } : {}) };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(SETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      const seenIds = new Set();
      const seenNames = new Set(['my tools']);
      setToolSets(parsed.slice(0, MAX_TOOL_SETS).map(cleanSet).filter(set => {
        if (!set || seenIds.has(set.id) || seenNames.has(set.name.toLocaleLowerCase())) return false;
        seenIds.add(set.id);
        seenNames.add(set.name.toLocaleLowerCase());
        return true;
      }));
    }
  } catch { /* Invalid set storage does not hide existing My Tools. */ }
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) setPresets(parsed.slice(0, MAX_PRESETS).map(cleanPreset).filter(Boolean));
  } catch { /* Storage can be unavailable in private/embedded contexts. */ }
}

function persist(next) {
  setPresets(next);
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Session still works. */ }
}

function persistSets(next) {
  setToolSets(next);
  try { globalThis.localStorage?.setItem(SETS_STORAGE_KEY, JSON.stringify(next)); } catch { /* Session still works. */ }
}

function knownSet(id) {
  return id === DEFAULT_TOOL_SET_ID || toolSets().some(set => set.id === id)
    || bundledSets().some(set => set.id === id);
}

// Shared tool sets (tool-set-share.js) are read-only until checked out; the
// sharing store registers the guard. Every change to a set or its tools asks it.
let editGuard = null;
export function setToolSetEditGuard(guard) { editGuard = typeof guard === 'function' ? guard : null; }
export function canEditToolSet(setId) {
  if (typeof setId === 'string' && setId.startsWith('pack_')) return false;
  try { return !editGuard || editGuard(setId) !== false; } catch { return false; }
}
const editableTool = (id) => {
  const preset = presets().find(item => item.id === id);
  return preset && canEditToolSet(preset.setId) ? preset : null;
};

function uniqueName(base, usedNames, limit) {
  if (!usedNames.has(base.toLocaleLowerCase())) return base;
  for (let number = 2; number <= 999; number++) {
    const suffix = ` (${number})`;
    const candidate = `${base.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error('Too many tools or sets share the same name.');
}

export function getToolChestSets() {
  ensureLoaded();
  return [{ id: DEFAULT_TOOL_SET_ID, name: 'My tools', builtIn: true }, ...toolSets(), ...bundledSets()];
}

export function createToolSet(name) {
  ensureLoaded();
  const trimmed = String(name || '').trim().slice(0, 48);
  if (!trimmed || toolSets().length >= MAX_TOOL_SETS ||
      getToolChestSets().some(set => set.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) return null;
  const set = { id: `set_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`, name: trimmed };
  persistSets([...toolSets(), set]);
  return set;
}

/** Mark a named set scale-aware with a reference scale, or clear it with null. */
export function setToolSetReferenceScale(id, scale) {
  ensureLoaded();
  const set = toolSets().find(item => item.id === id);
  if (!set || !canEditToolSet(id)) return null;
  const clean = scale === null ? null : cleanReferenceScale(scale);
  if (scale !== null && !clean) return null;
  const { referenceScale: _old, ...rest } = set;
  const updated = clean ? { ...rest, referenceScale: clean } : rest;
  persistSets(toolSets().map(item => item.id === id ? updated : item));
  return updated;
}

export function exportToolSet(id) {
  ensureLoaded();
  const set = toolSets().find(item => item.id === id);
  if (!set) throw new Error('Select a named tool set to export.');
  const selected = presets().filter(preset => preset.setId === id);
  if (selected.some(preset => preset.tool === 'count')) {
    throw new Error('Count presets are local only; move them out of this set before exporting portable JSON.');
  }
  const localOnly = selected.find(preset => LOCAL_ONLY_TOOL_TYPES.includes(preset.tool));
  if (localOnly) {
    throw new Error(`${localOnly.tool} tools are local only; move them out of this set before exporting portable JSON.`);
  }
  return buildPortableToolSetBytes(set.name, selected, set.referenceScale);
}

/** Validate the entire file and capacity before mutating either local list. */
export function importToolSet(bytes) {
  const incoming = parsePortableToolSetBytes(bytes);
  ensureLoaded();
  if (toolSets().length >= MAX_TOOL_SETS) throw new Error('The Tool Chest already has the maximum number of named sets.');
  if (presets().length + incoming.tools.length > MAX_PRESETS) {
    throw new Error('There is not enough room for every tool in this set.');
  }
  const usedSets = new Set(getToolChestSets().map(set => set.name.toLocaleLowerCase()));
  const set = {
    id: `set_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`,
    name: uniqueName(incoming.name, usedSets, 48),
    ...(incoming.referenceScale ? { referenceScale: incoming.referenceScale } : {}),
  };
  const usedTools = new Set();
  const imported = incoming.tools.map(tool => {
    const toolName = uniqueName(tool.name, usedTools, 80);
    usedTools.add(toolName.toLocaleLowerCase());
    return {
      id: `tc_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`,
      name: toolName, tool: tool.tool, style: tool.style, setId: set.id,
      mode: tool.mode === 'drawing' ? 'drawing' : 'properties',
      ...(tool.geometry ? { geometry: tool.geometry } : {}),
      ...(tool.text ? { text: tool.text } : {}),
      ...(tool.sequence ? { sequence: tool.sequence } : {}),
      ...(tool.layer ? { layer: tool.layer } : {}),
    };
  });
  persistSets([...toolSets(), set]);
  persist([...presets(), ...imported]);
  return { set, tools: imported };
}

/** Removing a set keeps every saved style by moving it back to My Tools. */
export function deleteToolSet(id) {
  ensureLoaded();
  if (!toolSets().some(set => set.id === id)) return false;
  const moved = presets().map(preset => preset.setId === id ? { ...preset, setId: DEFAULT_TOOL_SET_ID } : preset);
  persist(moved);
  persistSets(toolSets().filter(set => set.id !== id));
  const active = activePreset();
  if (active?.setId === id) setActivePreset(moved.find(preset => preset.id === active.id) || null);
  return true;
}

export function moveToolPreset(id, setId) {
  ensureLoaded();
  if (!knownSet(setId) || !canEditToolSet(setId)) return null;
  const preset = editableTool(id);
  if (!preset) return null;
  if (preset.setId === setId) return preset;
  const moved = { ...preset, setId };
  // A moved tool goes to the end of its new set (and leaves its My Tools slot).
  persist([...presets().filter(item => item.id !== id), moved]);
  if (activePreset()?.id === id) setActivePreset(moved);
  return moved;
}

/** Rename a named set (Tool Chest gear menu). Names stay unique, at most 48 characters. */
export function renameToolSet(id, name) {
  ensureLoaded();
  const trimmed = String(name || '').trim().slice(0, 48);
  const set = toolSets().find(item => item.id === id);
  if (!set || !trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed) || !canEditToolSet(id)) return null;
  if (getToolChestSets().some(item => item.id !== id && item.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) return null;
  const updated = { ...set, name: trimmed };
  persistSets(toolSets().map(item => item.id === id ? updated : item));
  return updated;
}

/** Rename a saved tool (at most 80 characters). */
export function renameToolPreset(id, name) {
  ensureLoaded();
  const trimmed = String(name || '').trim().slice(0, 80);
  const preset = editableTool(id);
  if (!preset || !trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  const updated = { ...preset, name: trimmed };
  persist(presets().map(item => item.id === id ? updated : item));
  if (activePreset()?.id === id) setActivePreset(updated);
  return updated;
}

/** Copy a saved tool to the end of a set (Copy to ▸); null when the chest is full. */
export function copyToolPreset(id, setId) {
  ensureLoaded();
  const preset = presets().find(item => item.id === id);
  if (!preset || !knownSet(setId) || !canEditToolSet(setId) || presets().length >= MAX_PRESETS) return null;
  const copy = cleanPreset({ ...preset, id: `tc_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`, setId });
  if (!copy) return null;
  persist([...presets(), copy]);
  return copy;
}

/**
 * Put every tool of a set in Drawing Mode or Properties Mode (gear menu).
 * Tools without saved geometry stay in Properties Mode. Returns the number
 * of tools that changed.
 */
export function setToolSetMode(setId, mode) {
  ensureLoaded();
  if (!knownSet(setId) || (mode !== 'drawing' && mode !== 'properties') || !canEditToolSet(setId)) return 0;
  let changed = 0;
  const next = presets().map(preset => {
    if (preset.setId !== setId || preset.mode === mode || (mode === 'drawing' && !preset.geometry) ||
        ALWAYS_DRAWING_TOOL_TYPES.includes(preset.tool)) return preset;
    changed++;
    return { ...preset, mode };
  });
  if (!changed) return 0;
  persist(next);
  const active = activePreset();
  if (active) {
    const updated = next.find(preset => preset.id === active.id);
    if (updated) setActivePreset(updated);
  }
  return changed;
}

/** My Tools hot-key slots (the external editor): the first ten My Tools, in list order. */
export const MY_TOOLS_SLOT_COUNT = 10;

/** Slot (1-10) of a preset in My Tools, or null when it has none. */
export function myToolsSlotOf(id) {
  ensureLoaded();
  const index = presets().filter(preset => preset.setId === DEFAULT_TOOL_SET_ID)
    .findIndex(preset => preset.id === id);
  return index >= 0 && index < MY_TOOLS_SLOT_COUNT ? index + 1 : null;
}

/** The My Tools preset in slot 1-10, or null for an empty slot. */
export function myToolsSlotPreset(slot) {
  ensureLoaded();
  if (!Number.isInteger(slot) || slot < 1 || slot > MY_TOOLS_SLOT_COUNT) return null;
  return presets().filter(preset => preset.setId === DEFAULT_TOOL_SET_ID)[slot - 1] || null;
}

/**
 * Move a preset up (-1) or down (+1) among the tools of its own set. In My
 * Tools the order is the hot-key slot order (1-9, then 0).
 */
export function reorderToolPreset(id, delta) {
  ensureLoaded();
  const list = presets();
  const index = list.findIndex(item => item.id === id);
  if (index < 0 || (delta !== -1 && delta !== 1) || !canEditToolSet(list[index].setId)) return false;
  const setId = list[index].setId;
  let other = index + delta;
  while (other >= 0 && other < list.length && list[other].setId !== setId) other += delta;
  if (other < 0 || other >= list.length) return false;
  const next = [...list];
  [next[index], next[other]] = [next[other], next[index]];
  persist(next);
  return true;
}

/** Move a preset to a position (0-based) among the tools of its set (drag and drop). */
export function placeToolPresetAt(id, position) {
  ensureLoaded();
  const list = presets();
  const preset = list.find(item => item.id === id);
  if (!preset || !Number.isInteger(position) || position < 0 || !canEditToolSet(preset.setId)) return false;
  const sameSet = list.filter(item => item.setId === preset.setId && item.id !== id);
  const target = Math.min(position, sameSet.length);
  sameSet.splice(target, 0, preset);
  let cursor = 0;
  const next = list.map(item => item.setId === preset.setId ? sameSet[cursor++] : item);
  if (next.every((item, i) => item === list[i])) return false;
  persist(next);
  return true;
}

export function getToolChestPresets() {
  ensureLoaded();
  const extra = bundledPresets();
  return extra.length ? [...presets(), ...extra] : presets();
}

/**
 * Show tool sets that ship with the app. They are not written to localStorage.
 * `parsedSets` is the result of parseBtx: { name, tools }.
 * @returns {{ sets: number, tools: number }}
 */
export function installBundledToolSets(parsedSets) {
  ensureLoaded();
  const usedNames = new Set(['my tools', ...toolSets().map(set => set.name.toLocaleLowerCase())]);
  const sets = [];
  const tools = [];
  for (const [index, parsed] of (parsedSets || []).entries()) {
    let name = String(parsed?.name || 'Tools').trim().slice(0, 48) || 'Tools';
    try { name = uniqueName(name, usedNames, 48); } catch { continue; }
    usedNames.add(name.toLocaleLowerCase());
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40) || 'set';
    const id = `pack_${slug}_${index}`;
    const clean = [];
    for (const [toolIndex, tool] of (parsed?.tools || []).entries()) {
      const preset = cleanPreset({ ...tool, id: `pack_${index}_${toolIndex}`, setId: id });
      if (preset && preset.setId === id) clean.push(preset);
    }
    if (!clean.length) continue;
    sets.push({ id, name, builtIn: true, bundled: true });
    tools.push(...clean);
  }
  setBundledSets(sets);
  setBundledPresets(tools);
  return { sets: sets.length, tools: tools.length };
}

export function getRecentTools() { return recentTools(); }

export function canSaveToolPreset(annotation) {
  const tool = presetToolOf(annotation);
  return !!annotation && TOOLS.has(tool) && tool !== 'group' && !addToToolChestBlockReason(annotation) &&
    Object.keys(cleanStyle(annotation, tool)).length > 0;
}

export function saveToolPreset(annotation, name, setId = DEFAULT_TOOL_SET_ID, options = {}) {
  ensureLoaded();
  const trimmed = String(name || '').trim().slice(0, 80);
  if (!trimmed || !knownSet(setId) || !canEditToolSet(setId) || !canSaveToolPreset(annotation) ||
      presets().length >= MAX_PRESETS) return null;
  const tool = presetToolOf(annotation);
  const includeTextAndSize = TEXT_TOOLS.has(tool) && options.includeTextAndSize === true;
  const includeCalloutGeometry = tool === 'callout' && options.includeCalloutGeometry === true;
  const text = includeTextAndSize ? reusableTextboxText(annotation.text) : null;
  const geometry = (includeTextAndSize || includeCalloutGeometry ||
    (!TEXT_TOOLS.has(tool) && tool !== 'callout'))
    ? captureToolGeometry(annotation) : null;
  if ((includeTextAndSize && !text) || ((includeTextAndSize || includeCalloutGeometry) && !geometry)) return null;
  const preset = {
    id: `tc_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`,
    name: trimmed,
    tool,
    style: cleanStyle(annotation, tool),
    setId,
    mode: ALWAYS_DRAWING_TOOL_TYPES.includes(tool) && geometry ? 'drawing' : 'properties',
  };
  if (geometry) preset.geometry = geometry;
  if (text) preset.text = text;
  Object.assign(preset, toolDetails(options));
  persist([...presets(), preset]);
  return preset;
}

export function canUpdateToolPreset(id, annotation) {
  ensureLoaded();
  const preset = editableTool(id);
  return !!preset && !!annotation && !annotation.locked && !annotation.readOnly &&
    preset.tool === presetToolOf(annotation) && canSaveToolPreset(annotation) &&
    (!preset.geometry || !!captureToolGeometry(annotation)) &&
    (!preset.text || !!reusableTextboxText(annotation.text));
}

/** Replace only reusable appearance and relative geometry; keep tool identity and mode. */
export function updateToolPresetFromAnnotation(id, annotation) {
  if (!canUpdateToolPreset(id, annotation)) return null;
  const preset = presets().find(item => item.id === id);
  const geometry = ['textbox', 'typewriter', 'callout'].includes(preset.tool) && !preset.geometry
    ? null : captureToolGeometry(annotation);
  // A symbol count keeps the preset's category unless the markup names one.
  const source = preset.tool === 'count' && preset.style.countCategory
    ? { countCategory: preset.style.countCategory, ...annotation } : annotation;
  const updated = { id: preset.id, name: preset.name, tool: preset.tool,
    style: cleanStyle(source, preset.tool), setId: preset.setId, mode: preset.mode,
    ...(geometry ? { geometry } : {}),
    ...(preset.text ? { text: reusableTextboxText(annotation.text) } : {}),
    ...(preset.sequence ? { sequence: preset.sequence } : {}), ...toolDetails(preset),
    ...(preset.layer ? { layer: preset.layer } : {}) };
  persist(presets().map(item => item.id === id ? updated : item));
  if (activePreset()?.id === id) setActivePreset(updated);
  return updated;
}

export function toggleToolPresetMode(id) {
  ensureLoaded();
  const preset = editableTool(id);
  if (!preset?.geometry || ALWAYS_DRAWING_TOOL_TYPES.includes(preset.tool)) return null;
  const updated = { ...preset, mode: preset.mode === 'drawing' ? 'properties' : 'drawing' };
  persist(presets().map(item => item.id === id ? updated : item));
  if (activePreset()?.id === id) setActivePreset(updated);
  return updated;
}

/** Give a saved tool a sequence label pattern, or remove it with null. */
export function setToolPresetSequence(id, sequence) {
  ensureLoaded();
  const preset = editableTool(id);
  if (!preset) return null;
  const clean = sequence === null ? null : cleanSequence(sequence);
  if (sequence !== null && !clean) return null;
  const { sequence: _old, ...rest } = preset;
  const updated = clean ? { ...rest, sequence: clean } : rest;
  persist(presets().map(item => item.id === id ? updated : item));
  if (activePreset()?.id === id) setActivePreset(updated);
  return updated;
}

/** Give a saved tool a markup layer name ("Layer…"), or remove it with null/''. */
export function setToolPresetLayer(id, name) {
  ensureLoaded();
  const preset = editableTool(id);
  if (!preset) return null;
  const clean = cleanToolLayerName(name);
  if (name !== null && name !== '' && !clean) return null;
  const { layer: _old, ...rest } = preset;
  const updated = clean ? { ...rest, layer: clean } : rest;
  persist(presets().map(item => item.id === id ? updated : item));
  if (activePreset()?.id === id) setActivePreset(updated);
  return updated;
}

/**
 * Every tool of a set on one layer (gear menu: "Assign all tools to layer
 * <set name>"), or off any layer with null. Returns the number of changed tools.
 */
export function setToolSetLayer(setId, name) {
  ensureLoaded();
  const clean = name === null ? null : cleanToolLayerName(name);
  if (!knownSet(setId) || (name !== null && !clean) || !canEditToolSet(setId)) return 0;
  let changed = 0;
  const next = presets().map(preset => {
    if (preset.setId !== setId || (preset.layer || null) === clean) return preset;
    changed++;
    const { layer: _old, ...rest } = preset;
    return clean ? { ...rest, layer: clean } : rest;
  });
  if (!changed) return 0;
  persist(next);
  const active = activePreset();
  if (active) {
    const updated = next.find(preset => preset.id === active.id);
    if (updated) setActivePreset(updated);
  }
  return changed;
}

// The app refreshes the Layers panel when a tool layer is created or shown
// (annotation-creators registers it).
let toolLayerListener = null;
export function setToolChestLayerListener(listen) {
  toolLayerListener = typeof listen === 'function' ? listen : null;
}

/**
 * After a placement with the active saved tool: put the markup on the tool's
 * layer, creating that layer in the document on first use. Markups placed
 * before the tool got its layer are never moved. Returns the layer id or null.
 */
export function applyActiveToolLayer(annotation, doc) {
  const preset = activePreset();
  if (!annotation || !doc || !preset?.layer || !presetMatches(preset, annotation)) return null;
  return putOnToolLayer(preset, [annotation], doc);
}

/**
 * A placed group tool (Tool Chest group, always Drawing Mode): every member
 * of the new group goes on the tool's layer. Returns the layer id or null.
 */
export function applyActiveGroupToolLayer(members, doc) {
  const preset = activePreset();
  if (!Array.isArray(members) || !members.length || !doc || preset?.tool !== 'group' || !preset.layer) return null;
  return putOnToolLayer(preset, members, doc);
}

function putOnToolLayer(preset, annotations, doc) {
  const placed = ensureLayerNamed(doc, preset.layer);
  if (!placed) return null;
  for (const annotation of annotations) {
    if (placed.id === DEFAULT_LAYER_ID) delete annotation.layer;
    else annotation.layer = placed.id;
  }
  if (placed.created || placed.shown) {
    try { toolLayerListener?.(doc, placed); } catch { /* the panel refreshes on its next change */ }
  }
  return placed.id;
}

/**
 * After a placement with the active saved tool: stamp its next sequence
 * label into the new markup and advance the document counter. Never runs
 * for the live preview. Returns the label or null.
 */
export function stampActiveToolSequence(annotation, doc) {
  const preset = activePreset();
  if (!annotation || !preset?.sequence || !presetMatches(preset, annotation)) return null;
  const label = takeSequenceLabel(doc, preset.sequence);
  if (label) stampSequenceLabel(annotation, label);
  return label;
}

export function activeDrawingToolPreset(tool) {
  const preset = activePreset();
  return preset?.tool === tool && preset.mode === 'drawing' && preset.geometry ? preset : null;
}

/** Remember a style only after a drawing tool creates a supported markup. */
export function recordRecentTool(annotation) {
  if (!canSaveToolPreset(annotation)) return null;
  const tool = presetToolOf(annotation);
  const style = cleanStyle(annotation, tool);
  const signature = JSON.stringify([tool, style]);
  const existing = recentTools().find(item => JSON.stringify([item.tool, item.style]) === signature);
  const entry = existing || {
    id: `recent_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`,
    name: `${tool[0].toUpperCase()}${tool.slice(1)}`,
    tool, style,
  };
  setRecentTools([entry, ...recentTools().filter(item => item.id !== entry.id)].slice(0, MAX_RECENT_TOOLS));
  return entry;
}

export function clearRecentTools() {
  setRecentTools([]);
  if (activePreset()?.id?.startsWith('recent_')) setActivePreset(null);
}

export function activateRecentTool(id) {
  const preset = recentTools().find(item => item.id === id) || null;
  setActivePreset(preset);
  return preset;
}

export function deleteToolPreset(id) {
  ensureLoaded();
  if (!editableTool(id)) return false;
  persist(presets().filter(preset => preset.id !== id));
  if (activePreset()?.id === id) setActivePreset(null);
  return true;
}

export function activateToolPreset(id) {
  const preset = getToolChestPresets().find(item => item.id === id) || null;
  setActivePreset(preset);
  return preset;
}

export function clearActiveToolPreset() { setActivePreset(null); }
export { activePreset as activeToolPreset };

// Called by both the live preview and final tool creator. Geometry, page,
// text and identity always come from the new drawing, never from the sample.
export function applyActiveToolPreset(tool, props,
  anchorX = props?.arrowX ?? props?.startX ?? props?.x,
  anchorY = props?.arrowY ?? props?.startY ?? props?.y) {
  const preset = activePreset();
  if (!props || !preset || preset.tool !== tool || !presetMatches(preset, props)) return props;
  const styled = { ...props, ...preset.style, ...(preset.subject && !props.subject ? { subject: preset.subject } : {}) };
  if (tool === 'count' && styled.countCategory) return placeCountInPresetCategory(styled);
  if (preset.mode !== 'drawing' || !preset.geometry) return styled;
  // Scale-aware set: resize to the calibrated scale at the placement point.
  const factor = toolScaleFactor(preset, props.page, anchorX, anchorY);
  const geometry = factor === 1 ? preset.geometry
    : scaleToolGeometry(tool, preset.geometry, factor) || preset.geometry;
  return preset.mode === 'drawing' && geometry
    ? { ...applyDrawingGeometry(tool, styled, geometry, anchorX, anchorY),
      ...(TEXT_TOOLS.has(tool) && preset.text ? { text: preset.text } : {}) } : styled;
}

/**
 * After a placement outside annotation-creators (stamps, symbols, flags,
 * polylines): stamp the active tool's sequence label and remember the style
 * in Recent Tools.
 */
export function finishToolPresetPlacement(annotation, doc) {
  if (!annotation) return annotation;
  const preset = activePreset();
  if (preset?.subject && !annotation.subject && presetMatches(preset, annotation)) annotation.subject = preset.subject;
  applyActiveToolLayer(annotation, doc);
  stampActiveToolSequence(annotation, doc);
  recordRecentTool(annotation);
  return annotation;
}

// --- Manage Tool Sets (docs/reference/editor/tool-chest.md) ---

const newId = (prefix) => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`}`;

/** Display (show the set's section) on or off. */
export function setToolSetDisplay(id, display) {
  ensureLoaded();
  const set = toolSets().find(item => item.id === id);
  if (!set) return null;
  const { hidden: _old, ...rest } = set;
  const updated = display === false ? { ...rest, hidden: true } : rest;
  persistSets(toolSets().map(item => item.id === id ? updated : item));
  return updated;
}

/** Show In All Profiles: null shows the set everywhere, a profile id only there. */
export function setToolSetProfile(id, profile) {
  ensureLoaded();
  const set = toolSets().find(item => item.id === id);
  if (!set) return null;
  const { profile: _old, ...rest } = set;
  const updated = cleanSet(profile ? { ...rest, profile } : rest) || rest;
  persistSets(toolSets().map(item => item.id === id ? updated : item));
  return updated;
}

/** Move a named set up (-1) or down (+1) in the Tool Chest; My Tools stays first. */
export function reorderToolSet(id, delta) {
  ensureLoaded();
  const list = [...toolSets()];
  const index = list.findIndex(item => item.id === id);
  const other = index + delta;
  if (index < 0 || (delta !== -1 && delta !== 1) || other < 0 || other >= list.length) return false;
  [list[index], list[other]] = [list[other], list[index]];
  persistSets(list);
  return true;
}

/** Is the set shown in the panel for this workspace profile? */
export function toolSetVisible(set, profile) {
  return !!set && !set.hidden && (!set.profile || !profile || set.profile === profile);
}

/** A new empty named set with optional Manage Tool Sets options; null when the name is taken or full. */
export function addToolSet(name, { display = true, profile = null } = {}) {
  const set = createToolSet(name);
  if (!set) return null;
  if (display === false) setToolSetDisplay(set.id, false);
  if (profile) setToolSetProfile(set.id, profile);
  return toolSets().find(item => item.id === set.id) || set;
}

/** Remove a set together with its tools (a shared set: the file stays). */
export function dropToolSet(id) {
  ensureLoaded();
  if (!toolSets().some(set => set.id === id)) return false;
  persist(presets().filter(preset => preset.setId !== id));
  persistSets(toolSets().filter(set => set.id !== id));
  if (activePreset()?.setId === id) setActivePreset(null);
  return true;
}

/** The set as a tool set file document: { name, tools, referenceScale? }. */
export function readToolSetContent(setId) {
  ensureLoaded();
  const set = getToolChestSets().find(item => item.id === setId);
  if (!set) throw new Error('Unknown tool set.');
  return { name: set.builtIn && !set.bundled ? 'My Tools' : set.name,
    tools: getToolChestPresets().filter(preset => preset.setId === setId).map(({ setId: _set, ...tool }) => tool),
    ...(set.referenceScale ? { referenceScale: set.referenceScale } : {}) };
}

/**
 * Replace a set's tools with tools read from a file (shared set refresh,
 * check-out). Each tool is cleaned like local storage; ids are kept unless
 * another set already uses them. Bypasses the edit guard: this IS the
 * shared file. Returns { accepted, rejected }.
 */
export function replaceToolSetTools(setId, content) {
  ensureLoaded();
  if (!toolSets().some(set => set.id === setId)) throw new Error('Unknown tool set.');
  const others = presets().filter(preset => preset.setId !== setId);
  const usedIds = new Set(others.map(preset => preset.id));
  const room = MAX_PRESETS - others.length;
  const incoming = Array.isArray(content?.tools) ? content.tools : [];
  const clean = [];
  let rejected = 0;
  for (const tool of incoming) {
    const id = typeof tool?.id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(tool.id) && !usedIds.has(tool.id)
      ? tool.id : newId('tc');
    const preset = clean.length < room ? cleanPreset({ ...tool, id, setId }) : null;
    if (!preset || preset.setId !== setId) { rejected++; continue; }
    usedIds.add(id);
    clean.push(preset);
  }
  const referenceScale = cleanReferenceScale(content?.referenceScale);
  persistSets(toolSets().map(set => {
    if (set.id !== setId) return set;
    const { referenceScale: _old, ...rest } = set;
    return referenceScale ? { ...rest, referenceScale } : rest;
  }));
  persist([...others, ...clean]);
  const active = activePreset();
  if (active?.setId === setId) setActivePreset(clean.find(preset => preset.id === active.id) || null);
  return { accepted: clean.length, rejected };
}

/**
 * Import (the external editor): copy tools from a file into a NEW local set; later changes
 * are independent of the file. `content`: { name, tools, referenceScale? }
 * from a tool set file or a .btx. Returns { set, accepted, rejected }.
 */
export function importToolSetContent(content) {
  ensureLoaded();
  if (toolSets().length >= MAX_TOOL_SETS) throw new Error('The Tool Chest already has the maximum number of named sets.');
  const used = new Set(getToolChestSets().map(set => set.name.toLocaleLowerCase()));
  const set = createToolSet(uniqueName(String(content?.name || 'Imported tools').trim().slice(0, 48) || 'Imported tools', used, 48));
  if (!set) throw new Error('Could not create the tool set.');
  const tools = (content?.tools || []).map(tool => ({ ...tool, id: newId('tc') }));
  const result = replaceToolSetTools(set.id, { ...content, tools });
  return { set: toolSets().find(item => item.id === set.id) || set, ...result };
}

/** Edit… : the tool's Subject and Comment (Detail view; Subject goes to new markups). */
export function setToolPresetDetails(id, { subject, comment } = {}) {
  ensureLoaded();
  const preset = editableTool(id);
  if (!preset) return null;
  const { subject: _s, comment: _c, ...rest } = preset;
  const updated = { ...rest, ...toolDetails({ subject, comment }) };
  persist(presets().map(item => item.id === id ? updated : item));
  if (activePreset()?.id === id) setActivePreset(updated);
  return updated;
}

/**
 * Add to Tool Chest ▸ several sets at once. Returns the saved tools; sets
 * that are read-only or full are listed in `skipped`.
 */
export function saveToolPresetToSets(annotation, name, setIds, options = {}) {
  const saved = [];
  const skipped = [];
  for (const setId of [...new Set(setIds || [])]) {
    const preset = saveToolPreset(annotation, name, setId, options);
    if (preset) saved.push(preset); else skipped.push(setId);
  }
  return { saved, skipped };
}

/**
 * Save a captured group (tool-chest-groups.js captureGroupTool) as one
 * tool in each listed set. Always Drawing Mode.
 */
export function saveGroupToolPreset(capture, name, setIds, options = {}) {
  ensureLoaded();
  const saved = [];
  const skipped = [];
  const trimmed = String(name || '').trim().slice(0, 80);
  for (const setId of [...new Set(setIds || [])]) {
    const preset = trimmed && knownSet(setId) && canEditToolSet(setId) && presets().length < MAX_PRESETS
      ? cleanPreset({ id: newId('tc'), name: trimmed, tool: 'group', setId, mode: 'drawing',
        style: { memberCount: capture?.members?.length }, members: capture?.members, geometry: capture?.geometry,
        ...toolDetails(options) }) : null;
    if (!preset) { skipped.push(setId); continue; }
    persist([...presets(), preset]);
    saved.push(preset);
  }
  return { saved, skipped };
}

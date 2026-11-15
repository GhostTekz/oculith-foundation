// Version 1 stores shapes and textboxes. Version 2 adds callout appearance
// and explicitly captured relative box/leader geometry. Version 3 holds
// everything 1 and 2 hold plus a sequence label pattern per tool and an
// optional set reference scale (scale-aware sets), and an optional markup
// layer name per tool (docs/reference/editor/layers.md). Source
// identity, absolute coordinates, comments, scripts, paths, and document
// sequence counters are never exported.
import { cleanToolGeometry } from './tool-preset-geometry.js';
import { cleanSequence } from './tool-sequences.js';
import { presetLineStyle } from './tool-preset-line-style.js';
export const TOOL_SET_FORMAT = 'ocudraw.tool-set';
export const TOOL_SET_VERSION = 1;
export const TOOL_SET_CALLOUT_VERSION = 2;
export const TOOL_SET_SEQUENCE_VERSION = 3;
const VERSIONS = [TOOL_SET_VERSION, TOOL_SET_CALLOUT_VERSION, TOOL_SET_SEQUENCE_VERSION];
export const MAX_PORTABLE_SET_BYTES = 64 * 1024;
export const MAX_PORTABLE_TOOLS = 50;

export const PORTABLE_TOOL_TYPES = ['line', 'arrow', 'box', 'circle', 'highlight', 'cloud', 'textbox'];
export const PORTABLE_STYLE_KEYS = ['color', 'strokeColor', 'fillColor', 'opacity', 'lineWidth',
  'borderStyle', 'startHead', 'endHead', 'headSize'];
export const PORTABLE_TEXTBOX_STYLE_KEYS = ['textColor', 'fontSize', 'fontFamily', 'fontBold',
  'fontItalic', 'fontUnderline', 'textAlign', 'lineSpacing'];
export const PORTABLE_CALLOUT_STYLE_KEYS = [
  ...PORTABLE_STYLE_KEYS.filter(key => !['startHead', 'endHead', 'headSize'].includes(key)),
  ...PORTABLE_TEXTBOX_STYLE_KEYS, 'textPadding', 'leaderStyle', 'borderEffect', 'cloudIntensity',
];
const MAX_TEXTBOX_TEXT = 2000;

const colorKeys = new Set(['color', 'strokeColor', 'fillColor']);
const numberKeys = new Set(['opacity', 'lineWidth', 'headSize']);
const textKeys = new Set(['borderStyle', 'startHead', 'endHead']);
// Font family enters the PDF FreeText /DS CSS and /RC XHTML style attribute.
// Accept names, never CSS/XML delimiters or escape characters.
const fontFamilyName = /^[\p{L}\p{N}][\p{L}\p{N} ,._-]{0,127}$/u;
const encoder = new TextEncoder();

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, required, label) {
  if (!record(value) || Object.keys(value).length !== required.length ||
      required.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has invalid or extra fields.`);
  }
}

function name(value, limit, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > limit ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a trimmed name of at most ${limit} characters.`);
  }
  return value;
}

// Version 3 only: a line tool's custom line style (tool-preset-line-style.js).
export const PORTABLE_LINE_STYLE_KEYS = ['lineStyleId', 'lineStyleDef'];
const hasLineStyle = (value) => record(value) && PORTABLE_LINE_STYLE_KEYS.some(key => Object.hasOwn(value, key));

function style(value, tool) {
  if (!record(value)) throw new Error('A tool style must be an object.');
  const keys = Object.keys(value);
  const allowed = tool === 'callout' ? PORTABLE_CALLOUT_STYLE_KEYS
    : tool === 'textbox' ? [...PORTABLE_STYLE_KEYS, ...PORTABLE_TEXTBOX_STYLE_KEYS]
      : tool === 'line' ? [...PORTABLE_STYLE_KEYS, ...PORTABLE_LINE_STYLE_KEYS] : PORTABLE_STYLE_KEYS;
  if (!keys.length || keys.some(key => !allowed.includes(key))) {
    throw new Error('A tool style has invalid or extra fields.');
  }
  const clean = {};
  for (const key of PORTABLE_STYLE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (colorKeys.has(key)) {
      if (key === 'fillColor' && (item === null || item === 'transparent' || item === 'none')) clean[key] = item;
      else if (typeof item === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(item)) clean[key] = item;
      else throw new Error(`${key} must be a hex color${key === 'fillColor' ? ', none, transparent, or null' : ''}.`);
    } else if (numberKeys.has(key)) {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 ||
          (key === 'opacity' && item > 1) || (key !== 'opacity' && item > 100)) {
        throw new Error(`${key} is outside the allowed range.`);
      }
      clean[key] = item;
    } else if (textKeys.has(key)) {
      if (typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(item)) {
        throw new Error(`${key} must be a short style token.`);
      }
      clean[key] = item;
    }
  }
  if (tool === 'line' && hasLineStyle(value)) {
    const lineStyle = presetLineStyle(value, 'line');
    if (!lineStyle.lineStyleId || (Object.hasOwn(value, 'lineStyleDef') && !lineStyle.lineStyleDef)) {
      throw new Error('lineStyleId or lineStyleDef is invalid.');
    }
    Object.assign(clean, lineStyle);
  }
  if (tool === 'textbox' || tool === 'callout') {
    for (const key of PORTABLE_TEXTBOX_STYLE_KEYS) {
      if (!Object.hasOwn(value, key)) continue;
      const item = value[key];
      if (key === 'textColor') {
        if (typeof item !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(item)) {
          throw new Error('textColor must be a hex color.');
        }
      } else if (key === 'fontSize') {
        if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || item > 512) {
          throw new Error('fontSize is outside the allowed range.');
        }
      } else if (key === 'fontFamily') {
        if (typeof item !== 'string' || item !== item.trim() || !fontFamilyName.test(item)) {
          throw new Error('fontFamily must be a short plain font name.');
        }
      } else if (['fontBold', 'fontItalic', 'fontUnderline'].includes(key)) {
        if (typeof item !== 'boolean') throw new Error(`${key} must be a boolean.`);
      } else if (key === 'textAlign') {
        if (!['left', 'center', 'right'].includes(item)) throw new Error('textAlign is unsupported.');
      } else if (key === 'lineSpacing') {
        if (!/^(?:[1-9]\d*(?:\.\d+)?|0\.\d+)$/u.test(String(item)) || Number(item) > 10 ||
            (typeof item !== 'string' && typeof item !== 'number')) {
          throw new Error('lineSpacing is outside the allowed range.');
        }
      }
      clean[key] = item;
    }
  }
  if (tool === 'callout') {
    if (Object.hasOwn(value, 'textPadding')) {
      const padding = value.textPadding;
      if (typeof padding !== 'number' || !Number.isFinite(padding) || padding < 0 || padding > 512) {
        throw new Error('textPadding is outside the allowed range.');
      }
      clean.textPadding = padding;
    }
    if (Object.hasOwn(value, 'leaderStyle')) {
      if (value.leaderStyle !== 'curved') throw new Error('leaderStyle is unsupported.');
      clean.leaderStyle = 'curved';
    }
    if (Object.hasOwn(value, 'borderEffect')) {
      if (value.borderEffect !== 'cloudy') throw new Error('borderEffect is unsupported.');
      clean.borderEffect = 'cloudy';
    }
    if (Object.hasOwn(value, 'cloudIntensity')) {
      const intensity = value.cloudIntensity;
      if (clean.borderEffect !== 'cloudy' || typeof intensity !== 'number' ||
          !Number.isFinite(intensity) || intensity < 0 || intensity > 2) {
        throw new Error('cloudIntensity requires a cloudy border and a value from 0 to 2.');
      }
      clean.cloudIntensity = intensity;
    }
  }
  return clean;
}

function drawingTextbox(tool, index) {
  const geometry = cleanToolGeometry('textbox', tool.geometry);
  if (!geometry) throw new Error(`Tool ${index + 1} has invalid relative size.`);
  if (typeof tool.text !== 'string' || !tool.text || tool.text.length > MAX_TEXTBOX_TEXT ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(tool.text)) {
    throw new Error(`Tool ${index + 1} has invalid display text.`);
  }
  return { mode: 'drawing', geometry, text: tool.text };
}

function portableSequence(value, index) {
  exactKeys(value, ['prefix', 'suffix', 'start', 'step', 'digits'], `Tool ${index + 1} sequence`);
  const clean = cleanSequence(value);
  if (!clean) throw new Error(`Tool ${index + 1} has an invalid sequence.`);
  return clean;
}

function drawingCallout(tool, index) {
  const geometry = cleanToolGeometry('callout', tool.geometry);
  if (!geometry) throw new Error(`Tool ${index + 1} has invalid relative callout geometry.`);
  return { mode: 'drawing', geometry };
}

const SCALE_UNITS = ['mm', 'cm', 'm', 'in', 'ft'];

function portableReferenceScale(value) {
  exactKeys(value, ['pixelsPerUnit', 'unit'], 'Tool set reference scale');
  if (typeof value.pixelsPerUnit !== 'number' || !Number.isFinite(value.pixelsPerUnit) ||
      value.pixelsPerUnit <= 0 || value.pixelsPerUnit > 1e6 || !SCALE_UNITS.includes(value.unit)) {
    throw new Error('Tool set reference scale is invalid.');
  }
  return { pixelsPerUnit: value.pixelsPerUnit, unit: value.unit };
}

export function validatePortableToolSet(value) {
  const scaled = record(value) && value.version === TOOL_SET_SEQUENCE_VERSION && Object.hasOwn(value, 'referenceScale');
  exactKeys(value, scaled ? ['format', 'version', 'name', 'tools', 'referenceScale']
    : ['format', 'version', 'name', 'tools'], 'Tool set');
  if (value.format !== TOOL_SET_FORMAT || !VERSIONS.includes(value.version)) {
    throw new Error('Unsupported Tool Chest set format or version.');
  }
  const setName = name(value.name, 48, 'Tool set name');
  if (!Array.isArray(value.tools) || value.tools.length > MAX_PORTABLE_TOOLS) {
    throw new Error(`A tool set can contain at most ${MAX_PORTABLE_TOOLS} tools.`);
  }
  const tools = value.tools.map((tool, index) => {
    const textboxDrawing = value.version !== TOOL_SET_CALLOUT_VERSION &&
      tool?.tool === 'textbox' && tool?.mode === 'drawing';
    const calloutDrawing = tool?.tool === 'callout' && tool?.mode === 'drawing';
    const sequenced = value.version === TOOL_SET_SEQUENCE_VERSION && record(tool) && Object.hasOwn(tool, 'sequence');
    const layered = value.version === TOOL_SET_SEQUENCE_VERSION && record(tool) && Object.hasOwn(tool, 'layer');
    const keys = textboxDrawing ? ['name', 'tool', 'style', 'mode', 'geometry', 'text']
      : calloutDrawing ? ['name', 'tool', 'style', 'mode', 'geometry']
        : ['name', 'tool', 'style'];
    exactKeys(tool, [...keys, ...(sequenced ? ['sequence'] : []), ...(layered ? ['layer'] : [])], `Tool ${index + 1}`);
    if (!PORTABLE_TOOL_TYPES.includes(tool.tool) &&
        !(value.version !== TOOL_SET_VERSION && tool.tool === 'callout')) {
      throw new Error(`Tool ${index + 1} has an unsupported type.`);
    }
    if (value.version !== TOOL_SET_SEQUENCE_VERSION && hasLineStyle(tool.style)) {
      throw new Error(`Tool ${index + 1}: a line style needs portable version ${TOOL_SET_SEQUENCE_VERSION}.`);
    }
    return { name: name(tool.name, 80, `Tool ${index + 1} name`), tool: tool.tool,
      style: style(tool.style, tool.tool),
      ...(textboxDrawing ? drawingTextbox(tool, index) : {}),
      ...(calloutDrawing ? drawingCallout(tool, index) : {}),
      ...(sequenced ? { sequence: portableSequence(tool.sequence, index) } : {}),
      ...(layered ? { layer: name(tool.layer, 120, `Tool ${index + 1} layer`) } : {}) };
  });
  return { format: TOOL_SET_FORMAT, version: value.version, name: setName, tools,
    ...(scaled ? { referenceScale: portableReferenceScale(value.referenceScale) } : {}) };
}

export function parsePortableToolSetBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_PORTABLE_SET_BYTES) {
    throw new Error(`Tool set JSON must be at most ${MAX_PORTABLE_SET_BYTES} bytes.`);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Tool set JSON is invalid or is not UTF-8.'); }
  return validatePortableToolSet(parsed);
}

/** Lowest version that holds the set: its tools and an optional reference scale. */
export function portableVersionFor(presets, referenceScale = null) {
  const list = presets || [];
  if (referenceScale || list.some(preset => preset.sequence || preset.layer || hasLineStyle(preset.style))) {
    return TOOL_SET_SEQUENCE_VERSION;
  }
  return list.some(preset => preset.tool === 'callout') ? TOOL_SET_CALLOUT_VERSION : TOOL_SET_VERSION;
}

export function buildPortableToolSetBytes(setName, presets, referenceScale = null) {
  const version = portableVersionFor(presets, referenceScale);
  if (version === TOOL_SET_CALLOUT_VERSION && (presets || []).some(preset =>
    preset.tool === 'textbox' && preset.mode === 'drawing')) {
    throw new Error('Version 2 callout sets cannot include textbox display text. Move Drawing Mode textboxes to a separate named set.');
  }
  const document = validatePortableToolSet({
    format: TOOL_SET_FORMAT, version, name: setName,
    tools: (presets || []).map(preset => ({ name: preset.name, tool: preset.tool, style: preset.style,
      ...(preset.tool === 'textbox' && preset.mode === 'drawing' && preset.geometry && preset.text
        ? { mode: 'drawing', geometry: preset.geometry, text: preset.text } : {}),
      ...(preset.tool === 'callout' && preset.mode === 'drawing'
        ? { mode: 'drawing', geometry: preset.geometry } : {}),
      ...(preset.sequence ? { sequence: preset.sequence } : {}),
      ...(preset.layer ? { layer: preset.layer } : {}) })),
    ...(referenceScale ? { referenceScale } : {}),
  });
  const bytes = encoder.encode(`${JSON.stringify(document, null, 2)}\n`);
  if (bytes.byteLength > MAX_PORTABLE_SET_BYTES) throw new Error('The tool set is too large to export.');
  return bytes;
}

export function suggestedPortableToolSetName(setName) {
  const base = String(setName || 'tool-set').normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[_\.]+|[_\.]+$/gu, '').slice(0, 48) || 'tool-set';
  return `${base}.ocudraw-tools.json`;
}

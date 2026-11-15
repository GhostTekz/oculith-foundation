// Import an external plan-review program tool set (.btx) as a Tool Chest set
// (docs/reference/editor/tool-chest.md, "the external editor .btx").
//
// What is publicly known about .btx (no official specification exists):
// an XML file with a <BluebeamRevuToolSet> root, a <Title>, and one
// <ToolChestItem Version="1"> per tool with <Name> (an id), <Type> (the .NET
// annotation class, e.g. Bluebeam.PDF.Annotations.AnnotationSquare), <Raw>,
// <X>/<Y>, <Index> and <Mode> (drawing | properties). <Raw> and sometimes
// <Title> hold zlib-compressed data written as hexadecimal text (it starts
// with "789c"); inflated, <Raw> is the markup's PDF annotation dictionary
// (/Subtype, /Rect, /C, /IC, /BS, /CA, /DA, /Subj, /Contents, …).
//
// The file is untrusted. This parser never uses the platform XML parser
// (no DTD, no external entities: a DOCTYPE or ENTITY declaration rejects
// the file), bounds every size (file, element count, nesting, inflated
// size, PDF tokens) and maps only what OcuDraw supports. Every other item is
// listed in `unsupported` with a reason, never dropped silently.
//
// Exporting .btx is not offered: without a specification we cannot make a
// file the external editor is known to read. Export writes the OcuDraw tool set file.

import { cleanGroupMembers, MAX_GROUP_MEMBERS } from './tool-chest-groups.js';

export const MAX_BTX_BYTES = 8 * 1024 * 1024;
export const MAX_BTX_ITEMS = 200;
const MAX_XML_NODES = 250000;
const MAX_XML_DEPTH = 16;
const MAX_INFLATED_BYTES = 256 * 1024;
const MAX_PDF_TOKENS = 20000;
const MAX_PDF_DEPTH = 24;

// ---------------------------------------------------------------- text

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

/** Does this look like a .btx (by content)? */
export function looksLikeBtx(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) return false;
  try { return /<\s*BluebeamRevuToolSet\b/u.test(decodeText(bytes.subarray(0, 2048))); } catch { return false; }
}

// ---------------------------------------------------------------- XML

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gu, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return Object.hasOwn(XML_ENTITIES, body) ? XML_ENTITIES[body] : match;
  });
}

/** Minimal XML reader: elements, attributes, text, CDATA. No DTDs. */
export function parseXmlSafely(text) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('The .btx file declares a DTD or entities; it is not read.');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let index = 0;
  let nodes = 0;
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/uy;
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    const chunk = text.slice(index, lt < 0 ? text.length : lt);
    if (chunk) stack[stack.length - 1].text += unescapeXml(chunk);
    if (lt < 0) break;
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt);
      if (end < 0) throw new Error('Unterminated processing instruction.');
      index = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      if (end < 0) throw new Error('Unterminated comment.');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end < 0) throw new Error('Unterminated CDATA.');
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      index = end + 3;
      continue;
    }
    tag.lastIndex = lt;
    const match = tag.exec(text);
    if (!match) throw new Error('The .btx file is not well-formed XML.');
    index = tag.lastIndex;
    const [, closing, name, attrText, selfClosing] = match;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name || !stack.length) throw new Error('The .btx file is not well-formed XML.');
      continue;
    }
    if (++nodes > MAX_XML_NODES) throw new Error('The .btx file has too many elements.');
    const attrs = {};
    for (const attr of attrText.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      if (attr[1] !== '__proto__') attrs[attr[1]] = unescapeXml(attr[2] ?? attr[3] ?? '');
    }
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length > MAX_XML_DEPTH) throw new Error('The .btx file is nested too deeply.');
      stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error('The .btx file is not well-formed XML.');
  return root;
}

const localName = (name) => name.replace(/^.*:/u, '');
const child = (node, name) => node.children.find(item => localName(item.name) === name) || null;
const childText = (node, name) => (child(node, name)?.text || '').trim();

// ---------------------------------------------------------------- blobs

function hexToBytes(text) {
  const clean = text.replace(/\s+/gu, '');
  if (clean.length % 2 || !/^[0-9a-fA-F]*$/u.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function base64ToBytes(text) {
  const clean = text.replace(/\s+/gu, '');
  if (!clean || clean.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(clean)) return null;
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** zlib inflate with an output cap (DecompressionStream: browsers, WebView, Node 18+). */
export async function inflateLimited(bytes, limit = MAX_INFLATED_BYTES) {
  if (typeof DecompressionStream !== 'function') throw new Error('This platform cannot inflate .btx data.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error('A .btx item inflates beyond the size limit.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

/**
 * Text of an external editor blob: hex or base64 zlib data (starts with 0x78), or the
 * plain text itself.
 */
export async function decodeExtBlob(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const bytes = (/^78[0-9a-fA-F]/u.test(trimmed) && hexToBytes(trimmed)) ||
    (/^eN/u.test(trimmed) && base64ToBytes(trimmed)) || null;
  if (bytes && bytes[0] === 0x78) {
    const inflated = await inflateLimited(bytes);
    if (inflated[0] === 0xff && inflated[1] === 0xfe) return new TextDecoder('utf-16le').decode(inflated.subarray(2));
    if (inflated[0] === 0xfe && inflated[1] === 0xff) return new TextDecoder('utf-16be').decode(inflated.subarray(2));
    return new TextDecoder('latin1').decode(inflated);
  }
  return trimmed;
}

// ---------------------------------------------------------------- PDF objects

const PDF_DELIMITERS = '()<>[]{}/%';
const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';

function pdfString(bytes) {
  if (bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  return bytes;
}

/** Parse one PDF object (a dictionary for <Raw>). Names come back as { name }. */
export function parsePdfObject(text) {
  let i = 0;
  let tokens = 0;
  const peekSpace = () => { while (i < text.length) {
    if (isSpace(text[i])) i++;
    else if (text[i] === '%') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++; }
    else break;
  } };
  const value = (depth) => {
    if (depth > MAX_PDF_DEPTH) throw new Error('A .btx markup is nested too deeply.');
    if (++tokens > MAX_PDF_TOKENS) throw new Error('A .btx markup is too large.');
    peekSpace();
    const ch = text[i];
    if (ch === undefined) throw new Error('Unexpected end of a .btx markup.');
    if (ch === '<' && text[i + 1] === '<') {
      i += 2;
      const dict = Object.create(null);
      for (;;) {
        peekSpace();
        if (text[i] === '>' && text[i + 1] === '>') { i += 2; break; }
        const key = value(depth + 1);
        if (!key || typeof key.name !== 'string') throw new Error('A .btx markup has an invalid dictionary.');
        dict[key.name] = value(depth + 1);
      }
      // A stream after the dictionary is skipped (appearance data).
      peekSpace();
      if (text.startsWith('stream', i)) {
        const end = text.indexOf('endstream', i);
        i = end < 0 ? text.length : end + 9;
      }
      return dict;
    }
    if (ch === '[') {
      i++;
      const list = [];
      for (;;) {
        peekSpace();
        if (text[i] === ']') { i++; break; }
        if (i >= text.length) throw new Error('Unterminated array in a .btx markup.');
        list.push(value(depth + 1));
      }
      return list;
    }
    if (ch === '/') {
      i++;
      let name = '';
      while (i < text.length && !isSpace(text[i]) && !PDF_DELIMITERS.includes(text[i])) name += text[i++];
      return { name: name.replace(/#([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16))) };
    }
    if (ch === '(') {
      i++;
      let depthParen = 1;
      let out = '';
      while (i < text.length) {
        const c = text[i++];
        if (c === '\\') {
          const n = text[i++];
          if (n === 'n') out += '\n'; else if (n === 'r') out += '\r'; else if (n === 't') out += '\t';
          else if (n === 'b') out += '\b'; else if (n === 'f') out += '\f';
          else if (n === '\r') { if (text[i] === '\n') i++; }
          else if (n === '\n') { /* line continuation */ }
          else if (n >= '0' && n <= '7') {
            let oct = n;
            while (oct.length < 3 && text[i] >= '0' && text[i] <= '7') oct += text[i++];
            out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          } else if (n !== undefined) out += n;
        } else if (c === '(') { depthParen++; out += c; }
        else if (c === ')') { if (--depthParen === 0) return pdfString(out); out += c; }
        else out += c;
        if (out.length > MAX_INFLATED_BYTES) throw new Error('A .btx string is too long.');
      }
      throw new Error('Unterminated string in a .btx markup.');
    }
    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end < 0) throw new Error('Unterminated hex string in a .btx markup.');
      let hex = text.slice(i + 1, end).replace(/\s+/gu, '');
      i = end + 1;
      if (hex.length % 2) hex += '0';
      let out = '';
      for (let k = 0; k + 1 < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16) || 0);
      return pdfString(out);
    }
    let word = '';
    while (i < text.length && !isSpace(text[i]) && !PDF_DELIMITERS.includes(text[i])) word += text[i++];
    if (!word) { i++; return null; }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(word)) {
      // "12 0 R" is a reference; a tool item has no file to resolve it in.
      const save = i;
      const ref = /^\s+\d+\s+R(?=[\s/<>[\]()]|$)/u.exec(text.slice(i, i + 24));
      if (ref) { i = save + ref[0].length; return { ref: word }; }
      return Number(word);
    }
    return { keyword: word };
  };
  peekSpace();
  return value(0);
}

// ---------------------------------------------------------------- mapping

const HEADS = { OpenArrow: 'open', ClosedArrow: 'closed', Diamond: 'diamond', Circle: 'circle', Square: 'square',
  Slash: 'slash', Butt: 'butt', ROpenArrow: 'openReversed', RClosedArrow: 'closedReversed', None: 'none' };

const nameOf = (value) => (value && typeof value.name === 'string' ? value.name : null);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

function hexColor(value) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'number' && Number.isFinite(item))) return undefined;
  let rgb;
  if (value.length === 0) return null;
  if (value.length === 1) rgb = [value[0], value[0], value[0]];
  else if (value.length === 3) rgb = value;
  else if (value.length === 4) {
    const [c, m, y, k] = value.map(clamp01);
    rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  } else return undefined;
  return `#${rgb.map(part => Math.round(clamp01(part) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function rectSize(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(item => num(item) !== null)) return null;
  const width = Math.abs(rect[2] - rect[0]);
  const height = Math.abs(rect[3] - rect[1]);
  return width > 0 && height > 0 && width <= 100000 && height <= 100000 ? { width, height } : null;
}

function strokeStyle(dict) {
  const style = {};
  const stroke = hexColor(dict.C);
  if (typeof stroke === 'string') { style.strokeColor = stroke; style.color = stroke; }
  const bs = dict.BS && typeof dict.BS === 'object' ? dict.BS : null;
  const width = num(bs?.W) ?? (Array.isArray(dict.Border) ? num(dict.Border[2]) : null);
  if (width !== null && width >= 0 && width <= 100) style.lineWidth = width;
  const dash = nameOf(bs?.S);
  if (dash === 'D') style.borderStyle = 'dashed';
  else if (dash === 'S') style.borderStyle = 'solid';
  const opacity = num(dict.CA);
  if (opacity !== null && opacity >= 0 && opacity <= 1) style.opacity = opacity;
  return style;
}

function fillStyle(dict, style) {
  const fill = hexColor(dict.IC);
  if (fill === null) style.fillColor = null;
  else if (typeof fill === 'string') style.fillColor = fill;
  return style;
}

const isCloud = (dict) => nameOf(dict.BE?.S) === 'C';
const isMeasurement = (dict) => !!dict.Measure || /Dimension|Measure|Area|Perimeter|Volume|Count/u.test(nameOf(dict.IT) || '');

function textStyle(dict) {
  const style = strokeStyle(dict);
  delete style.strokeColor;
  delete style.color;
  const da = typeof dict.DA === 'string' ? dict.DA : '';
  const rg = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg/u.exec(da);
  if (rg) style.textColor = hexColor([Number(rg[1]), Number(rg[2]), Number(rg[3])]);
  const tf = /\/([\w#-]+)\s+([\d.]+)\s+Tf/u.exec(da);
  if (tf && Number(tf[2]) > 0 && Number(tf[2]) <= 512) style.fontSize = Number(tf[2]);
  const family = typeof dict.DS === 'string' ? /font-family\s*:\s*['"]?([\p{L}\p{N} ._-]{1,64})/u.exec(dict.DS) : null;
  if (family) style.fontFamily = family[1].trim();
  else if (tf) style.fontFamily = { Helv: 'Helvetica', Cour: 'Courier', TiRo: 'Times New Roman' }[tf[1]] || 'Helvetica';
  const background = hexColor(dict.C);
  if (typeof background === 'string') style.fillColor = background;
  if (style.textColor) { style.strokeColor = style.textColor; style.color = style.textColor; }
  return style;
}

function vertexPoints(list, maxNumbers = 256) {
  if (!Array.isArray(list) || list.length < 4 || list.length % 2 || list.length > maxNumbers ||
      !list.every(item => num(item) !== null)) return null;
  const points = [];
  for (let i = 0; i < list.length; i += 2) points.push({ x: list[i], y: 0 - list[i + 1] });
  return points;
}

// A tool item is often a group: the parent markup plus nested <Child> markups.
// Vector parts become one group tool. A stamp whose picture lives in a
// separate appearance object is not reconstructed.
const MAX_MEMBER_NUMBERS = 2048;

function rectBox(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some(item => num(item) === null)) return null;
  const width = Math.abs(rect[2] - rect[0]);
  const height = Math.abs(rect[3] - rect[1]);
  if (!(width > 0) || !(height > 0) || width > 100000 || height > 100000) return null;
  return { x: Math.min(rect[0], rect[2]), y: -Math.max(rect[1], rect[3]), width, height };
}

function appearanceOf(dict) {
  const style = fillStyle(dict, strokeStyle(dict));
  const ann = {};
  if (typeof style.strokeColor === 'string') { ann.strokeColor = style.strokeColor; ann.color = style.color; }
  if (typeof style.fillColor === 'string') ann.fillColor = style.fillColor;
  if (typeof style.lineWidth === 'number') ann.lineWidth = style.lineWidth;
  if (style.borderStyle) ann.borderStyle = style.borderStyle;
  if (typeof style.opacity === 'number') ann.opacity = style.opacity;
  return ann;
}

function pointBounds(points) {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(0.5, Math.max(...xs) - x), height: Math.max(0.5, Math.max(...ys) - y) };
}

/** Sample a partial ellipse (/Angle1 /Angle2 on a circle) as a polyline. */
function sampledArc(dict) {
  const a1 = num(dict.Angle1);
  const a2 = num(dict.Angle2);
  const box = rectBox(dict.Rect);
  if (a1 === null || a2 === null || !box) return null;
  const start = a1 * Math.PI / 180;
  let sweep = (a2 - a1) * Math.PI / 180;
  while (sweep <= 0.001) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2 - 0.05) return null;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  const steps = Math.max(8, Math.min(48, Math.ceil(sweep / (Math.PI / 12))));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + sweep * (i / steps);
    // PDF angles are counter-clockwise from +x in y-up space. Display y is down.
    points.push({ x: cx + rx * Math.cos(t), y: cy - ry * Math.sin(t) });
  }
  return points;
}

/**
 * One markup dictionary as an annotation the canvas already draws, in display
 * space (y down). Stamps and measurements return null.
 */
function annotationFromExt(dict) {
  if (!dict || typeof dict !== 'object' || isMeasurement(dict)) return null;
  const subtype = nameOf(dict.Subtype);
  const look = appearanceOf(dict);
  const box = rectBox(dict.Rect);
  if (subtype === 'Line') {
    const ends = Array.isArray(dict.L) && dict.L.length === 4 && dict.L.every(item => num(item) !== null) ? dict.L : null;
    if (!ends || Math.hypot(ends[2] - ends[0], ends[3] - ends[1]) < 0.01) return null;
    const le = Array.isArray(dict.LE) ? dict.LE.map(nameOf) : [];
    const startHead = HEADS[le[0]] || 'none';
    const endHead = HEADS[le[1]] || 'none';
    const arrow = startHead !== 'none' || endHead !== 'none';
    return { type: arrow ? 'arrow' : 'line', startX: ends[0], startY: -ends[1], endX: ends[2], endY: -ends[3],
      ...(arrow ? { startHead, endHead } : {}), ...look };
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') {
    const points = vertexPoints(dict.Vertices, MAX_MEMBER_NUMBERS);
    if (!points || points.length < (subtype === 'Polygon' ? 3 : 2)) return null;
    const closed = subtype === 'Polygon';
    const type = isCloud(dict) ? (closed ? 'cloud' : 'cloudPolyline') : (closed ? 'polygon' : 'polyline');
    return { type, points, ...pointBounds(points), ...look };
  }
  if (subtype === 'Square') {
    if (!box) return null;
    return { type: isCloud(dict) ? 'cloud' : 'box', ...box, ...look };
  }
  if (subtype === 'Circle') {
    const arc = sampledArc(dict);
    if (arc) return { type: 'polyline', points: arc, ...pointBounds(arc), ...look };
    if (!box) return null;
    return { type: 'circle', ...box, ...look };
  }
  if (subtype === 'Ink') {
    const points = vertexPoints(Array.isArray(dict.InkList) ? dict.InkList[0] : null, MAX_MEMBER_NUMBERS);
    if (!points || points.length < 2) return null;
    return { type: 'polyline', points, ...pointBounds(points), ...look };
  }
  if (subtype === 'FreeText') {
    if (!box) return null;
    const style = textStyle(dict);
    const text = typeof dict.Contents === 'string' ? dict.Contents.slice(0, 2000) : '';
    return { type: 'textbox', ...box, ...(text ? { text } : {}),
      ...(style.fontSize ? { fontSize: style.fontSize } : {}),
      ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
      ...(style.textColor ? { textColor: style.textColor, color: style.textColor, strokeColor: style.textColor } : {}),
      ...(typeof style.fillColor === 'string' ? { fillColor: style.fillColor } : {}) };
  }
  return null;
}

function toolTitle(dict, fallback) {
  const nest = dict?.TempGroupNesting;
  if (Array.isArray(nest)) {
    const title = nest.find(value => typeof value === 'string' && value.trim());
    if (title) return title.trim().slice(0, 80);
  }
  const subject = typeof dict?.Subj === 'string' ? dict.Subj.trim() : '';
  if (subject && !/^(polygon|line|square|circle|polyline|arc|stamp|ink|free ?text|callout)$/iu.test(subject)) {
    return subject.slice(0, 80);
  }
  return fallback;
}

function translateMember(ann, dx, dy) {
  const next = { ...ann };
  for (const [kx, ky] of [['x', 'y'], ['startX', 'startY'], ['endX', 'endY']]) {
    if (typeof next[kx] === 'number') next[kx] += dx;
    if (typeof next[ky] === 'number') next[ky] += dy;
  }
  if (Array.isArray(next.points)) next.points = next.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy }));
  return next;
}

function boundsOf(ann) {
  const xs = [];
  const ys = [];
  const add = (x, y) => { if (typeof x === 'number' && typeof y === 'number') { xs.push(x); ys.push(y); } };
  add(ann.x, ann.y);
  if (typeof ann.x === 'number' && typeof ann.width === 'number') add(ann.x + ann.width, ann.y + ann.height);
  add(ann.startX, ann.startY);
  add(ann.endX, ann.endY);
  for (const point of ann.points || []) add(point.x, point.y);
  if (!xs.length) return null;
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Several drawable parts of one tool item, origin at the group's top-left. */
function groupFromMembers(members, name) {
  if (!members || members.length < 2 || members.length > MAX_GROUP_MEMBERS) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const member of members) {
    const box = boundsOf(member);
    if (!box) return null;
    minX = Math.min(minX, box.minX); minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX); maxY = Math.max(maxY, box.maxY);
  }
  const shifted = members.map(member => translateMember(member, -minX, -minY));
  const cleaned = cleanGroupMembers(shifted);
  if (!cleaned) return null;
  return {
    name, tool: 'group', style: { memberCount: cleaned.length }, mode: 'drawing',
    geometry: { kind: 'box', width: Math.max(0.5, maxX - minX), height: Math.max(0.5, maxY - minY), rotation: 0 },
    members: cleaned,
  };
}

function markupNodes(item) {
  const out = [];
  const walk = (node) => {
    if (child(node, 'Raw')) out.push(node);
    for (const nested of node.children || []) {
      if (localName(nested.name) === 'Child') walk(nested);
    }
  };
  walk(item);
  return out;
}

/** Map one inflated markup dictionary to a Tool Chest tool, or { reason }. */
export function mapExtMarkup(dict, { name, mode }) {
  if (!dict || typeof dict !== 'object') return { reason: 'unreadable' };
  const subtype = nameOf(dict.Subtype);
  const intent = nameOf(dict.IT) || '';
  const details = {
    ...(typeof dict.Subj === 'string' && dict.Subj.trim() ? { subject: dict.Subj.trim().slice(0, 200) } : {}),
    ...(typeof dict.Contents === 'string' && dict.Contents.trim() ? { comment: dict.Contents.trim().slice(0, 200) } : {}),
    // Markup layer (docs/reference/editor/layers.md): only an inline /OC optional
    // content group carries its /Name; an indirect reference cannot be
    // resolved from the tool alone. The Tool Chest validates the name.
    ...(dict.OC && typeof dict.OC === 'object' && !dict.OC.ref && typeof dict.OC.Name === 'string' &&
      dict.OC.Name.trim() ? { layer: dict.OC.Name.trim().slice(0, 120) } : {}),
  };
  const drawing = mode === 'drawing';
  const base = (tool, style, geometry, extra = {}) => ({ name, tool, style,
    mode: drawing && geometry ? 'drawing' : 'properties', ...(geometry ? { geometry } : {}), ...details, ...extra });
  const size = rectSize(dict.Rect);
  const box = size ? { kind: 'box', width: size.width, height: size.height, rotation: 0 } : null;
  if (isMeasurement(dict)) return { reason: 'measurement', subtype: intent || subtype };
  switch (subtype) {
    case 'Line': {
      const style = strokeStyle(dict);
      const le = Array.isArray(dict.LE) ? dict.LE.map(nameOf) : [];
      const start = HEADS[le[0]] || 'none';
      const end = HEADS[le[1]] || 'none';
      const arrow = start !== 'none' || end !== 'none';
      if (arrow) { style.startHead = start; style.endHead = end; }
      const l = Array.isArray(dict.L) && dict.L.length === 4 && dict.L.every(item => num(item) !== null) ? dict.L : null;
      const geometry = l && Math.hypot(l[2] - l[0], l[3] - l[1]) >= 0.01
        ? { kind: 'line', dx: l[2] - l[0], dy: l[1] - l[3] } : null;
      return base(arrow ? 'arrow' : 'line', style, geometry);
    }
    case 'Square':
      return base(isCloud(dict) ? 'cloud' : 'box', fillStyle(dict, strokeStyle(dict)), isCloud(dict) ? null : box);
    case 'Circle': {
      const arc = sampledArc(dict);
      if (arc && arc.length >= 2 && arc.length <= 128) {
        const [first] = arc;
        return base('polyline', strokeStyle(dict), { kind: 'path',
          points: arc.map(point => ({ x: point.x - first.x, y: point.y - first.y })) });
      }
      return base('circle', fillStyle(dict, strokeStyle(dict)), box);
    }
    case 'Polygon': {
      const points = vertexPoints(dict.Vertices);
      let geometry = null;
      if (points && points.length >= 3 && points.length <= 128) {
        const minX = Math.min(...points.map(p => p.x));
        const minY = Math.min(...points.map(p => p.y));
        geometry = { kind: 'points', points: points.map(p => ({ x: p.x - minX, y: p.y - minY })) };
      }
      if (!isCloud(dict)) {
        return geometry ? base('polygon', fillStyle(dict, strokeStyle(dict)), geometry)
          : { reason: 'freePolygon', subtype };
      }
      return base('cloud', fillStyle(dict, strokeStyle(dict)), geometry);
    }
    case 'PolyLine': {
      const points = vertexPoints(dict.Vertices);
      const geometry = points ? { kind: 'path',
        points: points.map(p => ({ x: p.x - points[0].x, y: p.y - points[0].y })) } : null;
      return base('polyline', strokeStyle(dict), geometry);
    }
    case 'FreeText': {
      const style = textStyle(dict);
      if (/Callout/iu.test(intent)) return base('callout', style, null);
      if (/TypeWriter/iu.test(intent)) return base('typewriter', style, null);
      const text = typeof dict.Contents === 'string' ? dict.Contents.slice(0, 2000) : '';
      return text && box && drawing ? base('textbox', style, box, { text }) : base('textbox', style, null);
    }
    case 'Ink': return { reason: 'ink', subtype };
    case 'Stamp': return { reason: 'stamp', subtype };
    case 'Text': return { reason: 'note', subtype };
    case 'Link': return { reason: 'hyperlink', subtype };
    case 'FileAttachment': case 'Sound': return { reason: 'attachment', subtype };
    case 'Highlight': case 'Underline': case 'StrikeOut': case 'Squiggly': case 'Caret':
      return { reason: 'textMarkup', subtype };
    default:
      return { reason: 'unsupportedType', subtype: subtype || null };
  }
}

/**
 * Parse a .btx: { name, tools, unsupported: [{ index, name, type, reason }] }.
 * Tools have no id (the Tool Chest assigns one) and are cleaned again by
 * the Tool Chest before use.
 */
export async function parseBtx(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BTX_BYTES) {
    throw new Error(`A .btx file must be at most ${MAX_BTX_BYTES} bytes.`);
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new Error('This .btx is a ZIP package; only XML .btx files can be imported.');
  const root = parseXmlSafely(decodeText(bytes));
  const set = root.children.find(node => localName(node.name) === 'BluebeamRevuToolSet');
  if (!set) throw new Error('This is not a supported tool set (.btx) file.');
  let title = '';
  try { title = (await decodeExtBlob(childText(set, 'Title'))).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim(); }
  catch { title = ''; }
  const items = set.children.filter(node => localName(node.name) === 'ToolChestItem');
  if (items.length > MAX_BTX_ITEMS) throw new Error(`A .btx file can be imported with at most ${MAX_BTX_ITEMS} tools.`);
  const tools = [];
  const unsupported = [];
  for (const [index, item] of items.entries()) {
    const type = childText(item, 'Type').replace(/^.*\./u, '').slice(0, 80);
    const mode = /drawing/iu.test(childText(item, 'Mode')) ? 'drawing' : 'properties';
    const nodes = markupNodes(item);
    if (nodes.length > 1) {
      const parts = [];
      let parent = null;
      for (const node of nodes) {
        try {
          const raw = await decodeExtBlob(child(node, 'Raw')?.text || '');
          const dict = raw ? parsePdfObject(raw) : null;
          if (!parent) parent = dict;
          const ann = annotationFromExt(dict);
          if (ann) parts.push({ ann, dict });
        } catch { /* one unreadable part does not drop the rest of the tool */ }
      }
      const name = toolTitle(parent, (type.replace(/^Annotation/u, '') || `Tool ${index + 1}`).slice(0, 80));
      const layer = parent?.OC && typeof parent.OC === 'object' && !parent.OC.ref && typeof parent.OC.Name === 'string'
        ? parent.OC.Name.trim().slice(0, 120) : (typeof parent?.OC === 'string' ? parent.OC.trim().slice(0, 120) : '');
      const withLayer = (tool) => (layer && !tool.layer ? { ...tool, layer } : tool);
      if (parts.length >= 2) {
        const group = groupFromMembers(parts.map(part => part.ann), name);
        if (group) tools.push(withLayer(group));
        else unsupported.push({ index, name, type, reason: 'tooLarge' });
      } else if (parts.length === 1) {
        // The other parts are stamp pictures this reader does not reconstruct.
        const mapped = mapExtMarkup(parts[0].dict, { name, mode });
        if (mapped.reason) unsupported.push({ index, name, type, reason: mapped.reason });
        else tools.push(withLayer(mapped));
      } else {
        unsupported.push({ index, name, type, reason: 'stamp' });
      }
      continue;
    }
    let dict = null;
    try {
      const raw = await decodeExtBlob(child(item, 'Raw')?.text || '');
      dict = raw ? parsePdfObject(raw) : null;
    } catch (error) {
      unsupported.push({ index, name: type || `Tool ${index + 1}`, type, reason: 'unreadable', detail: error?.message });
      continue;
    }
    const subject = typeof dict?.Subj === 'string' && dict.Subj.trim() ? dict.Subj.trim() : '';
    const name = (subject || type.replace(/^Annotation/u, '') || `Tool ${index + 1}`).slice(0, 80);
    const mapped = mapExtMarkup(dict, { name, mode });
    if (mapped.reason) unsupported.push({ index, name, type, reason: mapped.reason });
    else tools.push(mapped);
  }
  return { name: (title || 'Imported tool set').slice(0, 48), tools, unsupported };
}

// Capture (the external editor: photos on a markup) and the File Attachment markup: the
// model and the pure helpers. No DOM, no app state, so node tests load it.
//
// Model (see docs/reference/editor/markup-tools.md):
//   ann.capturePhotos = [{ id, name, mimeType, date, width, height, size, dataUrl }]
//     on any markup. `date` is the EXIF capture date ('YYYY-MM-DDTHH:MM:SS',
//     camera local time) or the import time (ISO) when the file has none.
//   ann.attachedFile = { name, mimeType, size, date, dataUrl }
//     on a File Attachment markup: a note (type 'comment') with icon
//     'pushpin' that the saver writes as /FileAttachment.
// Both live in data URLs so that undo snapshots, copy and paste (JSON
// clones) keep them.

export const CAPTURE_DEFAULT_MAX_EDGE = 2048;
export const CAPTURE_MIN_EDGE = 256;
export const CAPTURE_MAX_EDGE_LIMIT = 8192;
/** Largest photo file read before decoding (the input, not the stored photo). */
export const CAPTURE_MAX_INPUT_BYTES = 40 * 1024 * 1024;
/** Photos per markup (also the loader's cap for untrusted PDFs). */
export const CAPTURE_MAX_PHOTOS = 50;
/** Default cap for a File Attachment's file. */
export const ATTACHMENT_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_ATTACHMENT_ICON = 'pushpin';
export const FILE_ATTACHMENT_SIZE = 24;

/** The configured longest photo edge in px (preference captureMaxEdge). */
export function captureMaxEdge(preferences) {
  const v = Math.round(Number(preferences?.captureMaxEdge));
  if (!Number.isFinite(v) || v <= 0) return CAPTURE_DEFAULT_MAX_EDGE;
  return Math.min(CAPTURE_MAX_EDGE_LIMIT, Math.max(CAPTURE_MIN_EDGE, v));
}

/** The configured File Attachment cap in bytes (preference attachmentMaxMb). */
export function attachmentMaxBytes(preferences) {
  const mb = Number(preferences?.attachmentMaxMb);
  if (!Number.isFinite(mb) || mb <= 0) return ATTACHMENT_DEFAULT_MAX_BYTES;
  return Math.round(Math.min(mb, 200) * 1024 * 1024);
}

/** Size that fits `maxEdge` on the longest side; never enlarges. */
export function fitWithinEdge(width, height, maxEdge) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (!(maxEdge > 0) || longest <= maxEdge) return { width: w, height: h, scaled: false };
  const f = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)), scaled: true };
}

/**
 * The image kind from the first bytes: 'jpeg', 'png', 'heic' or null.
 * The file name is only a fallback for HEIC containers that hide their brand.
 */
export function sniffImageType(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/u.test(brand)) return 'heic';
  }
  if (/\.(heic|heif)$/iu.test(String(name))) return 'heic';
  return null;
}

/** EXIF 'YYYY:MM:DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SS', or null. */
export function exifDateToIso(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(String(text || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === '0000' || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 60) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/**
 * DateTimeOriginal (else DateTime) from a JPEG's EXIF block, as
 * 'YYYY-MM-DDTHH:MM:SS', or null. Reads only the APP1 segment; every offset
 * is bounds-checked (the file is untrusted input).
 */
export function readExifDate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) return null; // image data: no EXIF before it
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) return null;
    if (marker === 0xe1 && len >= 16 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69
      && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
      return tiffDate(b, p + 10, p + 2 + len);
    }
    p += 2 + len;
  }
  return null;
}

function tiffDate(b, start, end) {
  if (start + 8 > end) return null;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return null;
  const u16 = (o) => (o + 2 > end ? -1 : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (o + 4 > end ? -1 : le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
    : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  if (u16(start + 2) !== 42) return null;
  const ascii = (entry) => {
    const count = u32(entry + 4);
    if (count < 19 || count > 64) return null;
    const at = start + u32(entry + 8);
    if (at < start || at + 19 > end) return null;
    let s = '';
    for (let i = 0; i < 19; i++) s += String.fromCharCode(b[at + i]);
    return exifDateToIso(s);
  };
  const readIfd = (offset) => {
    const at = start + offset;
    const n = u16(at);
    if (offset <= 0 || n < 0 || n > 512) return null;
    const tags = new Map();
    for (let i = 0; i < n; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > end) break;
      tags.set(u16(entry), entry);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(start + 4));
  if (!ifd0) return null;
  let original = null;
  if (ifd0.has(0x8769)) {
    const exif = readIfd(u32(ifd0.get(0x8769) + 8));
    if (exif?.has(0x9003)) original = ascii(exif.get(0x9003));
    if (!original && exif?.has(0x9004)) original = ascii(exif.get(0x9004));
  }
  return original || (ifd0.has(0x0132) ? ascii(ifd0.get(0x0132)) : null);
}

// --- base64 / data URLs (browser and node) ------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = '';
  const parts = [];
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    if (out.length >= 65536) { parts.push(out); out = ''; }
  }
  parts.push(out);
  return parts.join('');
}

const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function base64ToBytes(text) {
  const s = String(text || '').replace(/[^A-Za-z0-9+/\-_]/gu, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64_INDEX[s.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

export function bytesToDataUrl(bytes, mimeType = 'application/octet-stream') {
  return `data:${safeMimeType(mimeType)};base64,${bytesToBase64(bytes)}`;
}

/** Bytes of a base64 data URL, or null. */
export function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/su.exec(String(dataUrl || ''));
  if (!m || !/;base64/iu.test(m[2] || '')) return null;
  return base64ToBytes(m[3]);
}

export function dataUrlMimeType(dataUrl) {
  const m = /^data:([^;,]*)/u.exec(String(dataUrl || ''));
  return m ? safeMimeType(m[1]) : 'application/octet-stream';
}

/** A MIME type made of the safe characters only (`type/subtype`). */
export function safeMimeType(mime) {
  const m = String(mime || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(m) ? m : 'application/octet-stream';
}

const MIME_BY_EXT = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf', ifc: 'application/x-step',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
};

export function mimeTypeForName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * A file name safe to show and to write into a temp folder: the last path
 * segment, no control or reserved characters, at most 120 characters.
 */
export function safeFileName(name, fallback = 'attachment') {
  let s = String(name ?? '').split(/[\\/]/u).pop();
  s = s.replace(/[\x00-\x1f\x7f<>:"|?*]/gu, '_').replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '').trim();
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || fallback;
}

/** File types the app may hand to the system's default program. */
const OPENABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'json', 'xml',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'dwg', 'dxf', 'ifc', 'mp4', 'mov', 'mp3', 'wav',
  'tif', 'tiff', 'heic', 'heif', 'zip']);

/** May an attachment be opened directly (else it is only saved)? */
export function isOpenableAttachment(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return OPENABLE.has(ext);
}

// --- model ------------------------------------------------------------------

let photoSeq = 0;
export function newPhotoId() {
  photoSeq = (photoSeq + 1) % 1e6;
  return `ph_${Date.now().toString(36)}_${photoSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Valid photos of a markup (never throws on a malformed model). */
export function capturePhotos(ann) {
  const list = Array.isArray(ann?.capturePhotos) ? ann.capturePhotos : [];
  return list.filter(p => p && typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:'));
}

export function hasAttachedFile(ann) {
  return !!(ann?.attachedFile && typeof ann.attachedFile.dataUrl === 'string'
    && ann.attachedFile.dataUrl.startsWith('data:'));
}

/** Names of everything attached to a markup, photos first (CSV, list). */
export function attachmentNames(ann) {
  const names = capturePhotos(ann).map(p => safeFileName(p.name, 'photo.jpg'));
  if (hasAttachedFile(ann)) names.push(safeFileName(ann.attachedFile.name));
  return names;
}

export function attachmentCount(ann) {
  return capturePhotos(ann).length + (hasAttachedFile(ann) ? 1 : 0);
}

/** Bytes of a stored data URL (base64 length, without decoding). */
export function dataUrlByteLength(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return 0;
  const b64 = s.slice(comma + 1).replace(/=+$/u, '');
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Photo entry from prepared bytes (already downsized when needed).
 * `meta`: { name, mimeType, width, height, date }.
 */
export function makePhoto(bytes, meta = {}) {
  const mimeType = meta.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  let name = safeFileName(meta.name, `photo.${ext}`);
  // The stored bytes decide the extension (a re-encoded PNG photo is a JPEG).
  if (!new RegExp(`\\.${ext === 'jpg' ? 'jpe?g' : 'png'}$`, 'iu').test(name)) name = `${name.replace(/\.[^.]*$/u, '')}.${ext}`;
  return {
    id: meta.id || newPhotoId(),
    name,
    mimeType,
    date: meta.date || new Date().toISOString(),
    width: Math.round(Number(meta.width)) || 0,
    height: Math.round(Number(meta.height)) || 0,
    size: bytes.length,
    dataUrl: bytesToDataUrl(bytes, mimeType),
  };
}

/** The markup's photos with `photos` appended (cap CAPTURE_MAX_PHOTOS). */
export function withAddedPhotos(ann, photos) {
  const now = capturePhotos(ann);
  return [...now, ...(photos || [])].slice(0, CAPTURE_MAX_PHOTOS);
}

/** A File Attachment entry for any file. */
export function makeAttachedFile(bytes, name, date = new Date().toISOString()) {
  const safe = safeFileName(name);
  const mimeType = mimeTypeForName(safe);
  return { name: safe, mimeType, size: bytes.length, date, dataUrl: bytesToDataUrl(bytes, mimeType) };
}

/** Short display text for a size in bytes. */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** 'YYYY-MM-DD HH:MM' for a stored photo date (local EXIF text or ISO). */
export function photoDateText(date) {
  const s = String(date || '');
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/u.exec(s);
  if (local) return `${local[1]} ${local[2]}`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

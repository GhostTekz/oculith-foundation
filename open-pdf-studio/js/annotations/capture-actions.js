// Capture (photos on markups) and File Attachment: the app actions behind the
// context menu, the Properties section, the Markups List, the viewer and the
// File Attachment tool. Model and pure helpers: capture.js. PDF: saver/
// capture-files.js and loader/capture-load.js. See docs/reference/editor/markup-tools.md.

import { createSignal } from 'solid-js';
import i18next from '../i18n/config.js';
import { state, getActiveDocument } from '../core/state.js';
import { isTauri, readBinaryFile, saveFileDialog, writeBinaryFile } from '../core/platform.js';
import { commitAnnotationMutation } from './mutations.js';
import {
  CAPTURE_MAX_INPUT_BYTES, CAPTURE_MAX_PHOTOS, captureMaxEdge, attachmentMaxBytes, fitWithinEdge,
  sniffImageType, readExifDate, makePhoto, withAddedPhotos, capturePhotos, hasAttachedFile,
  makeAttachedFile, dataUrlToBytes, safeFileName, isOpenableAttachment, formatBytes,
} from './capture.js';

const tr = (key, options = {}) => i18next.t(`capture.${key}`, { ns: 'common', ...options });

// Bumped on every capture change, so panels that read photos re-render.
const [captureRev, setCaptureRev] = createSignal(0);
export { captureRev };
export const bumpCapture = () => setCaptureRev(v => v + 1);

function notify(message) {
  import('../ui/chrome/status-bar.js').then(m => m.updateStatusMessage(message, 5000)).catch(() => {});
}

function warn(message) {
  import('../bridge.js').then(m => m.showMessage(message, tr('title'))).catch(() => notify(message));
}

function refresh() {
  bumpCapture();
  import('./rendering.js').then(m => {
    if (getActiveDocument()?.viewMode === 'continuous') m.redrawContinuous(); else m.redrawAnnotations();
  }).catch(() => {});
  import('../ui/panels/annotations-list.js').then(m => m.updateAnnotationsList()).catch(() => {});
}

export function findAnnotation(id, doc = getActiveDocument()) {
  return doc?.annotations?.find(a => a.id === id) || null;
}

export function canEditCapture(ann) {
  return !!ann && !ann.locked && !ann.readOnly && ann.type !== 'scaleRegion';
}

/**
 * Pick files: Tauri dialog (paths) or a browser file input. Resolves to
 * [{ name, size, read: () => Promise<Uint8Array> }]; empty when cancelled.
 */
export async function pickFiles({ extensions = null, multiple = false } = {}) {
  if (isTauri() && window.__TAURI__?.dialog) {
    const result = await window.__TAURI__.dialog.open({
      multiple,
      filters: extensions ? [{ name: tr('photosFilter'), extensions }] : [{ name: tr('allFiles'), extensions: ['*'] }],
    });
    if (!result) return [];
    const paths = Array.isArray(result) ? result : [result];
    const out = [];
    for (const path of paths) {
      let size = 0;
      try { size = (await window.__TAURI__.fs?.stat?.(path))?.size || 0; } catch { size = 0; }
      out.push({ name: String(path).split(/[\\/]/u).pop(), size, read: async () => new Uint8Array(await readBinaryFile(path)) });
    }
    return out;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (extensions) input.accept = extensions.map(e => `.${e}`).join(',');
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files.map(file => ({ name: file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) })));
    });
    input.addEventListener('cancel', () => { input.remove(); resolve([]); });
    document.body.appendChild(input);
    input.click();
  });
}

async function canvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode'))), type, quality));
}

/**
 * One photo file → stored photo, downsized in a canvas to the configured
 * longest edge. JPEG files that already fit keep their bytes (and EXIF).
 * Throws an Error whose message is shown to the user.
 */
export async function preparePhoto(bytes, name, maxEdge = captureMaxEdge(state.preferences)) {
  const kind = sniffImageType(bytes, name);
  if (kind === 'heic') throw new Error(tr('heicRejected', { name: safeFileName(name) }));
  if (kind !== 'jpeg' && kind !== 'png') throw new Error(tr('notAnImage', { name: safeFileName(name) }));
  const date = kind === 'jpeg' ? readExifDate(bytes) : null;
  const mimeType = kind === 'png' ? 'image/png' : 'image/jpeg';
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }), { imageOrientation: 'from-image' });
  } catch {
    throw new Error(tr('unreadableImage', { name: safeFileName(name) }));
  }
  try {
    const fit = fitWithinEdge(bitmap.width, bitmap.height, maxEdge);
    if (!fit.scaled) {
      return makePhoto(bytes, { name, mimeType, width: fit.width, height: fit.height, date });
    }
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(fit.width, fit.height)
      : Object.assign(document.createElement('canvas'), { width: fit.width, height: fit.height });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    const blob = await canvasBlob(canvas, mimeType, kind === 'jpeg' ? 0.88 : undefined);
    const out = new Uint8Array(await blob.arrayBuffer());
    return makePhoto(out, { name, mimeType, width: fit.width, height: fit.height, date });
  } finally {
    bitmap.close?.();
  }
}

/** Adds prepared photos to a markup as one undo step. */
export function addPhotosToAnnotation(ann, photos) {
  if (!canEditCapture(ann) || !photos?.length) return 0;
  const before = capturePhotos(ann).length;
  commitAnnotationMutation(ann, a => { a.capturePhotos = withAddedPhotos(a, photos); });
  refresh();
  return capturePhotos(ann).length - before;
}

/** Context menu / Properties / command: "Attach photo…" for a markup. */
export async function attachPhotosTo(ann) {
  if (!ann) return 0;
  if (!canEditCapture(ann)) { notify(tr('locked')); return 0; }
  if (capturePhotos(ann).length >= CAPTURE_MAX_PHOTOS) { warn(tr('tooManyPhotos', { count: CAPTURE_MAX_PHOTOS })); return 0; }
  const files = await pickFiles({ extensions: ['jpg', 'jpeg', 'png', 'heic', 'heif'], multiple: true });
  if (!files.length) return 0;
  const photos = [];
  const problems = [];
  for (const file of files) {
    try {
      if (file.size > CAPTURE_MAX_INPUT_BYTES) throw new Error(tr('photoTooLarge', { name: safeFileName(file.name), size: formatBytes(CAPTURE_MAX_INPUT_BYTES) }));
      const bytes = await file.read();
      if (bytes.length > CAPTURE_MAX_INPUT_BYTES) throw new Error(tr('photoTooLarge', { name: safeFileName(file.name), size: formatBytes(CAPTURE_MAX_INPUT_BYTES) }));
      photos.push(await preparePhoto(bytes, file.name));
    } catch (error) {
      problems.push(error?.message || String(error));
    }
  }
  // The markup may have been deleted or locked while files were read.
  if (!getActiveDocument()?.annotations?.includes(ann)) return 0;
  const added = addPhotosToAnnotation(ann, photos);
  if (problems.length) warn(problems.join('\n'));
  if (added) notify(tr('photosAdded', { count: added }));
  return added;
}

export function removePhoto(ann, photoId) {
  if (!canEditCapture(ann)) return false;
  const list = capturePhotos(ann);
  if (!list.some(p => p.id === photoId)) return false;
  commitAnnotationMutation(ann, a => {
    a.capturePhotos = list.filter(p => p.id !== photoId);
    if (!a.capturePhotos.length) delete a.capturePhotos;
  });
  refresh();
  return true;
}

/** Opens the movable photo viewer on a markup's photos. */
export function openPhotoViewer(ann, index = 0) {
  if (!ann || !capturePhotos(ann).length) return false;
  import('../bridge.js').then(m => m.openDialog('capture-viewer', { annotationId: ann.id, index })).catch(() => {});
  return true;
}

async function saveBytesAs(bytes, name) {
  const path = await saveFileDialog(safeFileName(name), [{ name: tr('allFiles'), extensions: [String(name).split('.').pop() || '*'] }]);
  if (!path) return false;
  await writeBinaryFile(path, bytes);
  return true;
}

export async function savePhotoAs(photo) {
  const bytes = dataUrlToBytes(photo?.dataUrl);
  if (!bytes) return false;
  return saveBytesAs(bytes, photo.name);
}

/**
 * Double-click on a File Attachment: open its file with the system program
 * when the type is a document or image, else (or when that fails) save it.
 * Executables and scripts are never opened from a PDF.
 */
export async function openAttachedFile(ann) {
  if (!hasAttachedFile(ann)) return false;
  const file = ann.attachedFile;
  const bytes = dataUrlToBytes(file.dataUrl);
  if (!bytes) return false;
  const name = safeFileName(file.name);
  if (!isOpenableAttachment(name)) return saveBytesAs(bytes, name);
  if (isTauri() && window.__TAURI__?.path && window.__TAURI__?.shell) {
    try {
      // The temp folder, as the Attachments panel does; the name is sanitised.
      const target = await window.__TAURI__.path.join(await window.__TAURI__.path.tempDir(), `ocudraw-${name}`);
      await writeBinaryFile(target, bytes);
      await window.__TAURI__.shell.open(target);
      return true;
    } catch {
      return saveBytesAs(bytes, name);
    }
  }
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }
  return saveBytesAs(bytes, name);
}

export async function saveAttachedFileAs(ann) {
  if (!hasAttachedFile(ann)) return false;
  const bytes = dataUrlToBytes(ann.attachedFile.dataUrl);
  return bytes ? saveBytesAs(bytes, ann.attachedFile.name) : false;
}

/**
 * File Attachment tool: pick any file (size cap: preference attachmentMaxMb)
 * and return the attachedFile entry, or null (cancelled or too large).
 */
export async function pickAttachmentFile() {
  const [file] = await pickFiles();
  if (!file) return null;
  const cap = attachmentMaxBytes(state.preferences);
  if (file.size > cap) { warn(tr('fileTooLarge', { name: safeFileName(file.name), size: formatBytes(cap) })); return null; }
  const bytes = await file.read();
  if (bytes.length > cap) { warn(tr('fileTooLarge', { name: safeFileName(file.name), size: formatBytes(cap) })); return null; }
  return makeAttachedFile(bytes, file.name);
}

/** Replace a File Attachment's file (Properties ▸ Capture ▸ Replace file…). */
export async function replaceAttachedFile(ann) {
  if (!canEditCapture(ann) || !hasAttachedFile(ann)) return false;
  const file = await pickAttachmentFile();
  if (!file) return false;
  commitAnnotationMutation(ann, a => { a.attachedFile = file; });
  refresh();
  return true;
}

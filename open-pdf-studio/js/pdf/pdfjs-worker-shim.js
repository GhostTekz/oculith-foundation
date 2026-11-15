// The PDF.js worker, started through this module (pdfjs-worker-src.js).
//
// PDF.js builds the images of a page in its worker on an OffscreenCanvas and
// hands them to the window as ImageBitmaps (transferToImageBitmap). Every
// page that is drawn or read for its text layer does this. On WebKitGTK the
// worker's OffscreenCanvas is GPU-accelerated (Skia), and moving those
// bitmaps between threads crashes the web process:
//  - WebKitGTK 2.54.1: a segfault in the window thread while it receives a
//    bitmap from the worker (SerializedScriptValue::deserialize ->
//    Chrome::sinkIntoImageBuffer -> ~NativeImage -> ~SkImage_Ganesh ->
//    GrGLTextureRenderTarget::onRelease). Turning through the pages of a
//    large drawing set took the whole window down.
//  - WebKitGTK 2.52.6: the same worker pattern aborts inside Skia's GPU flush
//    (GrDirectContextPriv::flushSurfaces) in the worker thread.
// The window's own page canvases are CPU-backed on WebKitGTK for a related
// reason (page-canvas-context.js).
//
// Without OffscreenCanvas (and ImageDecoder, whose frames go through it)
// PDF.js sends the image pixels as plain buffers and the window draws them on
// its CPU canvas. On WebKitGTK the worker therefore loses both before PDF.js
// is loaded. Chromium (Windows) and the macOS webview keep them.
//
// This file is served as it is (not bundled): it imports nothing. The PDF.js
// worker to load is the `worker` parameter of this module's own URL (not the
// worker's location: under a custom scheme PDF.js starts the worker from a
// blob that imports this module).

/** Is this WebKitGTK (Linux WebKit, not Chromium)? Same test as page-canvas-context.js. */
export function isWebKitGtkAgent(userAgent) {
  const ua = String(userAgent || '');
  return /AppleWebKit\//.test(ua)
    && /\bLinux\b/.test(ua)
    && !/\bAndroid\b/.test(ua)
    && !/\b(?:Chrome|Chromium|CriOS|Edg|EdgA|OPR)\//.test(ua);
}

/** The worker globals PDF.js must not see on WebKitGTK. */
export const HIDDEN_WORKER_APIS = Object.freeze(['OffscreenCanvas', 'ImageDecoder']);

/**
 * Hide HIDDEN_WORKER_APIS from `scope` (typeof X === 'undefined' after).
 * @returns {string[]} the names that were present and are now hidden
 */
export function hideWorkerCanvasApis(scope) {
  const hidden = [];
  for (const name of HIDDEN_WORKER_APIS) {
    if (typeof scope?.[name] === 'undefined') continue;
    try {
      Object.defineProperty(scope, name, { value: undefined, configurable: true, writable: true });
    } catch {
      try { scope[name] = undefined; } catch { /* left as it is */ }
    }
    if (typeof scope[name] === 'undefined') hidden.push(name);
  }
  return hidden;
}

/**
 * The PDF.js worker URL named by `moduleUrl`'s `worker` parameter, or null
 * when it is missing or on another scheme or host than this module.
 */
export function pdfjsWorkerUrlFrom(moduleUrl) {
  let own;
  try { own = new URL(moduleUrl); } catch { return null; }
  const named = own.searchParams.get('worker');
  if (!named) return null;
  let target;
  try { target = new URL(named, own); } catch { return null; }
  if (target.protocol !== own.protocol || target.host !== own.host) return null;
  return target.href;
}

const WorkerScope = globalThis.WorkerGlobalScope;
const inWorker = typeof WorkerScope === 'function' && globalThis instanceof WorkerScope;
if (inWorker) {
  if (isWebKitGtkAgent(globalThis.navigator?.userAgent)) hideWorkerCanvasApis(globalThis);
  const worker = pdfjsWorkerUrlFrom(import.meta.url);
  if (!worker) throw new Error('pdfjs-worker-shim: no PDF.js worker URL');
  await import(worker);
}

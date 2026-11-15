// The worker URL every PDF.js document of the app uses
// (GlobalWorkerOptions.workerSrc): PDF.js's own worker, started through
// pdfjs-worker-shim.js, which keeps PDF.js's worker off the GPU canvas on
// WebKitGTK (see there).
//
// Dev: Vite rewrites the new URL(...) form of a dependency to a /@fs/ URL
// under server.fs.allow; a fresh webview (no cache) gets a 403 there, and
// PDF.js's fake-worker fallback then fails on the same 403 and getDocument
// never resolves. The plain /node_modules/ path is always served, so dev uses
// that; a build keeps the asset URL (rollup emits the worker as an asset, see
// assetFileNames in vite.config.js).

/**
 * The shim URL with the PDF.js worker as its `worker` parameter, both made
 * absolute against `base`.
 */
export function shimmedWorkerSrc(shimUrl, workerUrl, base) {
  const shim = new URL(shimUrl, base);
  shim.searchParams.set('worker', new URL(workerUrl, base).href);
  return shim.href;
}

function pageBase() {
  return typeof location !== 'undefined' && location?.href ? location.href : import.meta.url;
}

/** GlobalWorkerOptions.workerSrc for this app. */
export function pdfjsWorkerSrc() {
  const worker = import.meta.env?.DEV
    ? '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
    : new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
  return shimmedWorkerSrc(new URL('./pdfjs-worker-shim.js', import.meta.url).href, worker, pageBase());
}

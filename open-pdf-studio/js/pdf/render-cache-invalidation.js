// One place that forgets every rendered pixel of a file path.
//
// The page renders are cached per file path (page bitmaps, tiles, the
// continuous-view bitmaps) and the low-resolution previews by page; none of
// the keys carry a revision of the file. When the bytes behind a path change
// (a save rewrites it) or a tab on it closes (the file may be reissued and
// reopened under the same name), these caches must go together, or a reopened
// file shows tiles of the old bytes. The save path and closing a tab both use
// this helper. The modules load on demand, so importing it stays cheap.

/** The render cache modules, loaded once on demand. */
export async function loadRenderCacheModules() {
  const [bitmaps, tiles, progressive, orchestrator, renderer] = await Promise.all([
    import('./page-bitmap-cache.js'), import('./tile-cache.js'),
    import('./progressive-render.js'), import('./bitmap-orchestrator.js'),
    import('./renderer.js'),
  ]);
  return { bitmaps, tiles, progressive, orchestrator, renderer };
}

/**
 * Drop the cached renders of `path` and cancel renders in flight for it.
 * Synchronous once the modules are loaded (the save path calls it between its
 * own document checks).
 */
export function clearRenderCachesForPath(path, modules) {
  if (!path || !modules) return;
  const { bitmaps, tiles, progressive, orchestrator, renderer } = modules;
  bitmaps.invalidateDocumentBitmaps?.(path);
  tiles.tileCacheClearForFile?.(path);
  progressive.cancelProgressiveRenderForFile?.(path);
  orchestrator.cancelBitmapRendersForFile?.(path);
  renderer.clearBitmapJSCacheForFile?.(path);
  // Low-resolution previews are keyed by page, not by file: clear them all.
  renderer.clearLowResCache?.();
}

/** Load the cache modules and forget every cached render of `path`. */
export async function invalidateRenderCachesForPath(path) {
  if (!path) return;
  clearRenderCachesForPath(path, await loadRenderCacheModules());
}

// Pixel cap for raster exports (images, raster PDF).
//
// A page rendered for export is one canvas of width x height RGBA pixels. An
// A0 sheet at 600 dpi is about 28000 x 19900 pixels: 560 megapixels, over
// 2 GB, beyond what a webview canvas can allocate, so the export failed. The
// export resolution is lowered for such a page until it fits both limits
// below, and the export says so. Pure, so node tests the arithmetic.

/** At most this many pixels per exported page (about 400 MB of RGBA). */
export const MAX_EXPORT_PIXELS = 100_000_000;
/** At most this many pixels on one side (the webview canvas limit). */
export const MAX_EXPORT_SIDE = 16_384;

/**
 * The export scale for a page of `widthPt` x `heightPt` points, at most
 * `scale` (pixels per point), lowered to fit the pixel and side limits.
 * @returns {{scale:number, capped:boolean, dpi:number}}
 */
export function cappedExportScale(widthPt, heightPt, scale, { maxPixels = MAX_EXPORT_PIXELS, maxSide = MAX_EXPORT_SIDE } = {}) {
  if (!(widthPt > 0 && heightPt > 0 && scale > 0)) return { scale, capped: false, dpi: scale * 72 };
  let limit = scale;
  // Canvas sizes are rounded down to whole pixels; stay just inside.
  const byArea = Math.sqrt(maxPixels / (widthPt * heightPt));
  const bySide = maxSide / Math.max(widthPt, heightPt);
  limit = Math.min(limit, byArea, bySide);
  if (limit >= scale) return { scale, capped: false, dpi: scale * 72 };
  // A whole number of dots per inch, rounded down, keeps the metadata exact.
  const dpi = Math.max(1, Math.floor(limit * 72));
  return { scale: dpi / 72, capped: true, dpi };
}

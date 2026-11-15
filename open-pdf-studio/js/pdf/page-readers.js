// Further PDF.js documents of an open file that read its pages without
// drawing them (openPageReaders in loader.js): the options that keep their
// fonts out of the window, the bytes of a file read whole as a range
// source, and closing them.

/**
 * PDF.js options for a document that is never drawn when `fontFaces` is
 * false: its fonts are not installed in the window (font faces), which is
 * most of what reading a page's operator list costs the window's thread.
 * Its text and operator lists are the same.
 */
export const readerFonts = (fontFaces = true) => (fontFaces ? {} : { disableFontFace: true });

/**
 * PDF.js options for a document that reads line work and text only when
 * `images` is false: the images a page paints are left out of its
 * operator list before they are decoded (a page of scanned or pasted
 * tiles is decoded image by image otherwise, seconds on a large sheet).
 * Its paths and text are the same.
 */
export const readerImages = (images = true) => (images ? {} : { maxImageSize: 0 });

/**
 * Bytes in memory as a range source (FileRangeSource's length and read):
 * each read a copy of the range asked for, so a reader holds what it reads.
 */
export const memoryRangeSource = (bytes) => ({ length: bytes.length, read: async (begin, end) => bytes.slice(begin, end) });

/**
 * Close readers: each one's worker ends. A PDF.js document is destroyed
 * through its loading task (the document itself has no destroy()).
 */
export function closePageReaders(readers) {
  for (const reader of readers || []) {
    try { void reader?.loadingTask?.destroy()?.catch?.(() => {}); } catch { /* closed already */ }
  }
}

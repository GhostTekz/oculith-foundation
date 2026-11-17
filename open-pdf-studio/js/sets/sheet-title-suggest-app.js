import * as pdfjsLib from 'pdfjs-dist';
import { invoke, isTauri, readBinaryFile } from '../core/platform.js';
import { modelViewport } from '../pdf/region-text.js';
import { fingerprintPdfBytes } from './pdf-page-import.js';
import { suggestSheetDetails } from './sheet-title-suggest.js';

/** Read one registered source page without changing the PDF or drawing set. */
export async function suggestDetailsForSheet(sheet) {
  if (isTauri()) await invoke('allow_fs_scope', { path: sheet.filePath });
  const bytes = await readBinaryFile(sheet.filePath);
  if (!bytes?.length) throw new Error('The registered PDF could not be read.');
  if (sheet.sourceSha256 && await fingerprintPdfBytes(bytes) !== sheet.sourceSha256) {
    throw new Error('The registered PDF changed. Record or relink its source before reading suggestions.');
  }
  // PDF.js transfers the input buffer to a worker. Preserve the platform cache.
  const task = pdfjsLib.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/web/standard_fonts/',
    wasmUrl: '/pdfjs/web/wasm/', isEvalSupported: false, verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (sheet.page > document.numPages) throw new Error(`Page ${sheet.page} is no longer in the registered PDF.`);
    const page = await document.getPage(sheet.page);
    const content = await page.getTextContent();
    return suggestSheetDetails(content.items, modelViewport(page));
  } finally {
    await task.destroy();
  }
}

/**
 * Read current registered pages in groups so a multi-page PDF is loaded
 * once: `read(page)` gets each verified PDF.js page. Returns a Map of sheet
 * id to the result, or `{ error }` for a sheet whose PDF is missing,
 * changed, unverified or short of its page.
 */
export async function readRegisteredPages(sheets, read) {
  const groups = new Map();
  for (const sheet of sheets) {
    if (!groups.has(sheet.filePath)) groups.set(sheet.filePath, []);
    groups.get(sheet.filePath).push(sheet);
  }
  const results = new Map();
  for (const [path, group] of groups) {
    let task;
    try {
      if (group.some(sheet => !sheet.sourceSha256)) {
        // Legacy sources cannot be checked against the PDF used at registration.
        for (const sheet of group.filter(sheet => !sheet.sourceSha256)) {
          results.set(sheet.id, { error: 'No recorded PDF fingerprint. Relink or record this source before reviewing suggestions.' });
        }
      }
      const verified = group.filter(sheet => sheet.sourceSha256);
      if (!verified.length) continue;
      if (isTauri()) await invoke('allow_fs_scope', { path });
      const bytes = await readBinaryFile(path);
      if (!bytes?.length) throw new Error('The registered PDF could not be read.');
      const fingerprint = await fingerprintPdfBytes(bytes);
      const current = verified.filter(sheet => sheet.sourceSha256 === fingerprint);
      for (const sheet of verified.filter(sheet => sheet.sourceSha256 !== fingerprint)) {
        results.set(sheet.id, { error: 'The registered PDF changed. Record or relink its source before reviewing suggestions.' });
      }
      if (!current.length) continue;
      task = pdfjsLib.getDocument({
        data: Uint8Array.from(bytes), cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/pdfjs/web/standard_fonts/', wasmUrl: '/pdfjs/web/wasm/',
        isEvalSupported: false, verbosity: 0,
      });
      const document = await task.promise;
      const byPage = new Map();
      for (const sheet of current) {
        if (sheet.page > document.numPages) {
          results.set(sheet.id, { error: `Page ${sheet.page} is no longer in the registered PDF.` });
          continue;
        }
        if (!byPage.has(sheet.page)) byPage.set(sheet.page, await read(await document.getPage(sheet.page)));
        results.set(sheet.id, byPage.get(sheet.page));
      }
    } catch (error) {
      for (const sheet of group) if (!results.has(sheet.id)) results.set(sheet.id, { error: error.message });
    } finally { await task?.destroy(); }
  }
  return results;
}

/** Title block suggestions for the current registered pages. */
export function suggestDetailsForSheets(sheets) {
  return readRegisteredPages(sheets, async (page) =>
    suggestSheetDetails((await page.getTextContent()).items, modelViewport(page)));
}

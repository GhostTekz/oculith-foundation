// Slip sheet in the app: read revised PDFs, then carry markups and record the
// new revisions in the drawing set.
//
// Markups are read and written through the real document pipeline: the old
// and new revisions open as tabs (loader.js reads every markup type, reply
// and status), carried copies are added to the new revision, and the saver
// writes them to a COPY next to the revised PDF ("<name>-slip-sheet.pdf").
// Neither the revised PDF as received nor the old revision is overwritten;
// the old revision stays in the sheet's history with its own markups. A
// revised PDF that receives no markups is neither opened nor copied: the set
// records it as received.

import * as pdfjsLib from 'pdfjs-dist';
import { state } from '../core/state.js';
import { cacheWebFile, extractFileName, fileExists, invoke, isTauri, readBinaryFile } from '../core/platform.js';
import { createTab, updateTabBar, updateWindowTitle } from '../ui/chrome/tabs.js';
import { ensureAnnotationsForPage, getPdfBytes, loadPDFIfNeeded } from '../pdf/loader.js';
import { goToPage } from '../pdf/renderer.js';
import { savePDF, rotationsIntoSavedBase, unlockIfUnused } from '../pdf/saver.js';
import { documentPathChanged } from '../core/document-lifecycle.js';
import { outputPathMatchesSource } from '../compare/revision-markup-pdf.js';
import { fingerprintPdfBytes } from './pdf-page-import.js';
import { sheetKey, titleBlockText } from './slip-sheet-match.js';
import { pageAlignTransform, twoPointTransform } from './slip-sheet-transform.js';
import { applySlipSheet, carryableMarkups, carryMarkups, mergeCarriedSettings } from './slip-sheet-carry.js';

const TITLE_BLOCK_PAGE_LIMIT = 500;

/** Page count, page labels and title-block text of one revised PDF. */
export async function inspectRevisionPdf(bytes) {
  if (!bytes?.length) throw new Error('The PDF is empty or could not be read.');
  const task = pdfjsLib.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/web/standard_fonts/',
    wasmUrl: '/pdfjs/web/wasm/', isEvalSupported: false, verbosity: 0,
  });
  try {
    const document = await task.promise;
    let pageLabels = null;
    try { pageLabels = await document.getPageLabels(); } catch { /* a broken label tree hides no pages */ }
    const titleBlockTexts = [];
    for (let page = 1; page <= Math.min(document.numPages, TITLE_BLOCK_PAGE_LIMIT); page++) {
      const label = sheetKey(pageLabels?.[page - 1]);
      if (label && !/^\d+$/u.test(label)) { titleBlockTexts.push(''); continue; }
      try {
        const pdfPage = await document.getPage(page);
        const content = await pdfPage.getTextContent();
        titleBlockTexts.push(titleBlockText(content.items, pdfPage.getViewport({ scale: 1 })));
      } catch { titleBlockTexts.push(''); }
    }
    return { pageCount: document.numPages, pageLabels, titleBlockTexts };
  } finally {
    await task.destroy();
  }
}

export async function readRevisionFile(path) {
  if (isTauri()) await invoke('allow_fs_scope', { path });
  const bytes = await readBinaryFile(path);
  if (!bytes?.length) throw new Error(`${extractFileName(path)} could not be read.`);
  return bytes;
}

function registeredPaths(register) {
  return register.sheets.flatMap(sheet => [sheet, ...sheet.history, ...(sheet.sourceAliases || [])].map(item => item.filePath));
}

async function pathTaken(path, register) {
  if (registeredPaths(register).some(item => sheetKey(item) === sheetKey(path))) return true;
  if (state.documents.some(doc => doc?.filePath && sheetKey(doc.filePath) === sheetKey(path))) return true;
  if (!isTauri()) return !!(await readBinaryFile(path));
  try { await invoke('allow_fs_scope', { path }); } catch { /* the check below decides */ }
  return await fileExists(path) || await invoke('file_exists', { path }).catch(() => false);
}

/** "<dir>/<name>-slip-sheet.pdf", numbered when that file already exists. */
export async function slipSheetOutputPath(filePath, register) {
  const stem = String(filePath).replace(/\.pdf$/iu, '');
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem}-slip-sheet${n === 1 ? '' : `-${n}`}.pdf`;
    if (outputPathMatchesSource(candidate, filePath, ...registeredPaths(register))) continue;
    if (!(await pathTaken(candidate, register))) return candidate;
  }
  throw new Error(`No free output name next to ${extractFileName(filePath)}.`);
}

async function openDocument(path) {
  const { index } = createTab(path);
  await loadPDFIfNeeded(path, index);
  const doc = state.documents[index];
  if (!doc?.pdfDoc || doc.filePath !== path) throw new Error(`${extractFileName(path)} could not be opened.`);
  return doc;
}

async function pageReady(doc, page) {
  if (page > (doc.pdfDoc?.numPages || 0)) throw new Error(`Page ${page} is not in ${extractFileName(doc.filePath)}.`);
  await ensureAnnotationsForPage(page, doc);
  const started = Date.now();
  while (doc._annotationPagesReady && !doc._annotationPagesReady.has(page)) {
    if (!state.documents.includes(doc)) throw new Error(`${extractFileName(doc.filePath)} was closed.`);
    if (Date.now() - started > 30_000) throw new Error('Timed out waiting for page markups.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/**
 * @param {object} options
 * @param {object} options.register  the drawing set at confirmation time
 * @param {Array} options.rows  confirmed rows (slip-sheet-match.js)
 * @param {Record<string, number>} options.pageCounts  page count per revised PDF
 * @param {string} options.revision  revision of the new sheets
 * @param {Record<string, {oldA, oldB, newA, newB}>} [options.alignments]  two-point alignment per row key
 */
export async function runSlipSheet({ register, rows, pageCounts, revision, alignments = {}, onProgress }) {
  const included = rows.filter(row => row.include);
  if (!included.length) throw new Error('Select at least one sheet.');
  const files = [...new Set(included.map(row => row.filePath))];
  const outputs = new Map();
  let carried = 0;
  for (const filePath of files) {
    const matched = included.filter(row => row.filePath === filePath && row.sheetId);
    if (!matched.length) {
      outputs.set(filePath, { path: filePath, fingerprint: await fingerprintPdfBytes(await readRevisionFile(filePath)) });
      continue;
    }
    onProgress?.(`${extractFileName(filePath)}…`);
    // The old revisions' markups first: a revised PDF that receives none is
    // recorded as received, without opening it or writing a copy.
    const carries = [];
    for (const row of matched) {
      const sheet = register.sheets.find(item => item.id === row.sheetId);
      if (!sheet) throw new Error('A matched sheet is no longer in this set.');
      if (isTauri()) await invoke('allow_fs_scope', { path: sheet.filePath });
      else if (!(await readBinaryFile(sheet.filePath))) {
        throw new Error(`${sheet.label}: ${extractFileName(sheet.filePath)} is not available in this browser session. Add it again first.`);
      }
      const source = await openDocument(sheet.filePath);
      await pageReady(source, sheet.page);
      const markups = carryableMarkups(source.annotations, sheet.page);
      if (markups.length) carries.push({ row, sheet, source, markups });
    }
    if (!carries.length) {
      outputs.set(filePath, { path: filePath, fingerprint: await fingerprintPdfBytes(await readRevisionFile(filePath)) });
      continue;
    }
    const output = await slipSheetOutputPath(filePath, register);
    const target = await openDocument(filePath);
    const usedIds = new Set(target.annotations.map(annotation => annotation.id));
    const added = [];
    for (const { row, sheet, source, markups } of carries) {
      if (!state.documents.includes(source)) throw new Error(`${extractFileName(sheet.filePath)} was closed.`);
      await pageReady(target, row.page);
      const [oldPage, newPage] = await Promise.all([source.pdfDoc.getPage(sheet.page), target.pdfDoc.getPage(row.page)]);
      const align = alignments[row.key];
      const { matrix } = align
        ? twoPointTransform(align.oldA, align.oldB, align.newA, align.newB)
        : pageAlignTransform(oldPage.getViewport({ scale: 1 }), newPage.getViewport({ scale: 1 }));
      const copies = carryMarkups(markups, {
        matrix, targetPage: row.page, usedIds,
        source: { sheetId: sheet.id, label: sheet.label, revision: sheet.revision, filePath: sheet.filePath, page: sheet.page },
      });
      mergeCarriedSettings(target, source, copies);
      added.push(...copies);
    }
    const { index } = createTab(filePath);
    if (state.documents[index] !== target) throw new Error(`${extractFileName(filePath)} was closed.`);
    target.annotations.push(...added);
    const saved = await savePDF(output, { zonderHandtekeningVraag: true, becomesFile: true }, target);
    if (!saved) {
      target.annotations = target.annotations.filter(annotation => !added.includes(annotation));
      throw new Error(`Could not write ${extractFileName(output)}.`);
    }
    // As Save As does: the tab now shows the copy that holds the carried markups.
    const targetPath = target.filePath;
    const targetSaveTarget = target.saveTargetPath || null;
    target.filePath = output;
    target.fileName = extractFileName(output);
    target.saveTargetPath = null;
    documentPathChanged(target, targetPath, output);
    for (const old of new Set([targetPath, targetSaveTarget])) {
      if (old && old !== output) await unlockIfUnused(old);
    }
    await rotationsIntoSavedBase(target);
    updateTabBar();
    updateWindowTitle();
    const bytes = await getPdfBytes(output);
    if (!bytes?.length) throw new Error(`Could not read back ${extractFileName(output)}.`);
    if (!isTauri()) cacheWebFile(output, bytes);
    outputs.set(filePath, { path: output, fingerprint: await fingerprintPdfBytes(bytes) });
    carried += added.length;
    try { await goToPage(carries[0].row.page); } catch { /* the set is updated regardless */ }
  }
  const result = applySlipSheet(register, rows, { revision, outputs, pageCounts });
  return { ...result, carried, outputs };
}

// Set Batch Link (docs/reference/editor/sets-and-batch.md): Batch Link over the PDFs of a Set
// or a picked file list. The page labels of every file are the targets; a
// reference to a sheet in the same file becomes a /Link with a /Dest, one to
// a sheet in another file a /GoToR with the relative path from the referring
// file and the page index. Both carry the Batch Link marker (OPS_BatchLink),
// so Remove deletes exactly these. "Generate bookmarks from page labels"
// writes one outline item per page, in page order.
//
// Two runner jobs (runner.js): the scan reads labels, text and existing
// links of every file; the plan needs all of them; the write job then edits
// each file with pdf-lib and hands back the bytes. Sources are only read:
// the dialog writes the results into an output folder that mirrors the set's
// folder layout, so the relative links work there and keep working when that
// folder is moved as a whole.
//
// No UI and no platform imports; node tests run this on real PDF bytes.

import { PDFDocument, PDFName, PDFRef, PDFArray } from 'pdf-lib';
import { BATCH_LINK_DEFAULTS, referenceMatcher, batchLinkMarkup, overlapRatio } from '../pdf/batch-link.js';
import { modelViewport, textItemBox } from '../pdf/region-text.js';
import { cleanPageLabel, readPageLabelRanges, labelsFromRanges } from '../pdf/page-labels.js';
import { buildHyperlinkDict } from '../pdf/saver/hyperlink-dict.js';
import { saveBookmarksToOutline } from '../pdf/saver/bookmarks.js';
import { commonDirectory, pathInside, relativePdfPath } from '../pdf/remote-link.js';
import { throwIfCancelled, batchFileName, joinOutputPath } from './runner.js';
import { fingerprintPdfBytes } from '../sets/pdf-fingerprint.js';
import { indexSheetTitleSuggestions } from '../sets/index-sheet-titles.js';

const PRINT_FLAG = 4;
const keyOf = (path) => String(path ?? '').replace(/\\/gu, '/').toLocaleLowerCase();

function pdfRectOf(viewport, rect) {
  const corners = [
    viewport.convertToPdfPoint(rect.x, rect.y),
    viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function modelRectOf(viewport, pdfRect) {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(pdfRect);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/**
 * Read one file for the plan: its page count, page labels, text runs and
 * existing links. `pageNumbers` limits text and link extraction to selected
 * pages for index review; the ordinary Set Batch Link scan reads every page.
 * `measureFor(fontFamily)` may return a text width function (a canvas in the
 * app); without it the character share is used.
 */
export async function scanSetFile(bytes, { pdfjs, signal, measureFor, pageNumbers = null } = {}) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    throwIfCancelled(signal);
    let raw = null;
    if (!pageNumbers) {
      try { raw = await doc.getPageLabels(); } catch { raw = null; }
    }
    const labels = pageNumbers ? [] : Array.from({ length: doc.numPages }, (_, i) => cleanPageLabel(raw?.[i]));
    const pages = [];
    const existing = [];
    const selected = pageNumbers || Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const p of selected) {
      if (!Number.isSafeInteger(p) || p < 1 || p > doc.numPages) continue;
      const page = await doc.getPage(p);
      const viewport = modelViewport(page, 0);
      let content = { items: [], styles: {} };
      try { content = await page.getTextContent(); } catch { /* no text */ }
      let annots = [];
      try { annots = await page.getAnnotations(); } catch { annots = []; }
      throwIfCancelled(signal);
      for (const a of annots) {
        if (a.subtype === 'Link' && Array.isArray(a.rect)) existing.push({ page: p, ...modelRectOf(viewport, a.rect) });
      }
      const measure = (item) => measureFor?.(content.styles?.[item.fontName]?.fontFamily || 'sans-serif') || null;
      pages.push({
        page: p,
        toPdfRect: (rect) => pdfRectOf(viewport, rect),
        items: (content.items || []).filter((item) => typeof item.str === 'string')
          .map((item) => ({ str: item.str, box: (s, e) => textItemBox(item, viewport, s, e, measure(item)) })),
      });
    }
    return { pageCount: doc.numPages, labels, pages, existing };
  } finally {
    await task.destroy();
  }
}

/**
 * Sheet targets over the set: label -> { file, page } (file = index in the
 * list). Blank and purely numeric labels are left out; a label on more than
 * one page, in one file or across files, has no single target and is
 * reported as ambiguous.
 */
export function setLinkTargets(scans) {
  const placesOf = new Map();
  (scans || []).forEach((scan, file) => {
    (scan?.labels || []).forEach((raw, index) => {
      const label = cleanPageLabel(raw);
      if (!label || /^\d+$/u.test(label)) return;
      if (!placesOf.has(label)) placesOf.set(label, []);
      placesOf.get(label).push({ file, page: index + 1 });
    });
  });
  const targets = new Map();
  const ambiguous = [];
  for (const [label, places] of placesOf) {
    if (places.length === 1) targets.set(label, places[0]);
    else ambiguous.push({ label, places });
  }
  return { targets, ambiguous };
}

/**
 * Plan the links of every file of the set.
 * @param {Array<object|null>} scans  scanSetFile() results, null for a file that could not be read
 * @returns {{ links, skipped, ambiguous, pagesWithoutText }}
 *   links:   { file, page, text, label, target: { file, page }, rect, pdfRect }
 *   skipped: { file, page, text, label, target, reason: 'self' | 'existing' }
 *   pagesWithoutText: { file, page }
 */
export function planSetLinks(scans, options = {}) {
  const opts = { ...BATCH_LINK_DEFAULTS, ...options };
  const { targets, ambiguous } = setLinkTargets(scans);
  const matcher = referenceMatcher(targets, opts);
  const links = [];
  const skipped = [];
  const pagesWithoutText = [];
  (scans || []).forEach((scan, file) => {
    if (!scan) return;
    const placed = [];
    for (const { page, items, toPdfRect } of scan.pages) {
      if (!items.some((item) => item.str.trim())) { pagesWithoutText.push({ file, page }); continue; }
      for (const item of items) {
        for (const hit of matcher.find(item.str)) {
          const target = hit.page;
          const entry = { file, page, text: hit.text, label: hit.label, target };
          if (opts.excludeSelf && target.file === file && target.page === page) { skipped.push({ ...entry, reason: 'self' }); continue; }
          const rect = item.box(hit.start, hit.end);
          if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
          const taken = scan.existing.concat(placed).some((l) => l.page === page && overlapRatio(l.rect || l, rect) > 0.5);
          if (taken) { skipped.push({ ...entry, reason: 'existing' }); continue; }
          // The saved rectangle has the markup's 1 pt margin (batchLinkMarkup).
          const pdfRect = toPdfRect({ x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 });
          const link = { ...entry, rect, pdfRect };
          placed.push(link);
          links.push(link);
        }
      }
    }
  });
  return { links, skipped, ambiguous, pagesWithoutText };
}

/**
 * Review references against the current drawing-set register. A sheet's stable
 * ID, path and page are the authority; PDF page labels only expose references
 * whose target has not been registered. Nothing here changes a PDF or set.
 * `files` and `scans` have the same order as the batch runner.
 */
export function planRegisteredSetLinks(scans, files, register, options = {}) {
  const opts = { ...BATCH_LINK_DEFAULTS, ...options };
  const sheets = register?.sheets || [];
  const byPath = new Map((files || []).map((file, index) => [keyOf(file.path), index]));
  const registered = new Map();
  for (const sheet of sheets) {
    const label = cleanPageLabel(sheet.label);
    if (!label || /^\d+$/u.test(label)) continue;
    const key = label.toLocaleLowerCase();
    if (!registered.has(key)) registered.set(key, { label, sheets: [] });
    registered.get(key).sheets.push(sheet);
  }
  const pageLabels = new Map();
  (scans || []).forEach((scan, file) => (scan?.labels || []).forEach((raw, index) => {
    const label = cleanPageLabel(raw);
    if (!label || /^\d+$/u.test(label)) return;
    const key = label.toLocaleLowerCase();
    if (!pageLabels.has(key)) pageLabels.set(key, { label, places: [] });
    pageLabels.get(key).places.push({ file, page: index + 1 });
  }));
  const candidates = new Map();
  for (const [key, value] of registered) candidates.set(value.label, { kind: 'registered', ...value });
  for (const [key, value] of pageLabels) {
    if (!registered.has(key)) candidates.set(value.label, { kind: 'unregistered', ...value });
  }
  const matcher = referenceMatcher(candidates, opts);
  const sourceSheets = new Map();
  for (const sheet of sheets) {
    const file = byPath.get(keyOf(sheet.filePath));
    if (file === undefined) continue;
    const key = `${file}:${sheet.page}`;
    if (!sourceSheets.has(key)) sourceSheets.set(key, []);
    sourceSheets.get(key).push(sheet);
  }
  const links = [];
  const review = [];
  const pagesWithoutText = [];
  const changedFiles = new Set(sheets.filter(sheet => {
    const file = byPath.get(keyOf(sheet.filePath));
    return file !== undefined && sheet.sourceSha256 && sheet.sourceSha256 !== scans[file]?.fingerprint;
  }).map(sheet => byPath.get(keyOf(sheet.filePath))));
  (scans || []).forEach((scan, file) => {
    if (!scan) return;
    const placed = [];
    for (const { page, items, toPdfRect } of scan.pages) {
      if (!items.some(item => item.str.trim())) { pagesWithoutText.push({ file, page }); continue; }
      for (const item of items) {
        for (const hit of matcher.find(item.str)) {
          const candidate = hit.page;
          const sources = sourceSheets.get(`${file}:${page}`) || [];
          const row = { file, page, sourceSheetId: sources.length === 1 ? sources[0].id : null,
            text: hit.text, label: hit.label, status: '', targetSheetId: null, target: null };
          const sourceProblem = sources.length > 1 ? 'ambiguous-source'
            : !sources.length ? 'unregistered-source' : changedFiles.has(file) ? 'changed-source'
              : !sources[0].sourceSha256 ? 'unverified-source' : '';
          if (candidate.kind === 'unregistered') {
            row.status = candidate.places.length > 1 ? 'ambiguous-target' : 'unregistered-target';
            row.places = candidate.places;
          } else if (candidate.sheets.length !== 1) {
            row.status = 'ambiguous-target';
            row.candidates = candidate.sheets.map(sheet => ({ sheetId: sheet.id, path: sheet.filePath, page: sheet.page }));
          } else {
            const targetSheet = candidate.sheets[0];
            const targetFile = byPath.get(keyOf(targetSheet.filePath));
            row.targetSheetId = targetSheet.id;
            row.targetPath = targetSheet.filePath;
            row.targetPage = targetSheet.page;
            if (targetFile === undefined || !scans[targetFile]) row.status = 'missing-target';
            else if (!Number.isSafeInteger(targetSheet.page) || targetSheet.page < 1
              || targetSheet.page > scans[targetFile].pageCount) row.status = 'missing-page';
            else if (!targetSheet.sourceSha256) row.status = 'unverified-target';
            else if (targetSheet.sourceSha256 && targetSheet.sourceSha256 !== scans[targetFile].fingerprint) row.status = 'changed-target';
            else row.target = { file: targetFile, page: targetSheet.page };
          }
          row.status = sourceProblem || row.status;
          if (!row.status && opts.excludeSelf && row.target.file === file && row.target.page === page) row.status = 'self';
          let rect;
          if (!row.status) {
            rect = item.box(hit.start, hit.end);
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) row.status = 'no-location';
          }
          if (!row.status && scan.existing.concat(placed).some(l => l.page === page && overlapRatio(l.rect || l, rect) > 0.5)) {
            row.status = 'existing';
          }
          if (!row.status) {
            const pdfRect = toPdfRect({ x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 });
            const link = { file, page, text: hit.text, label: hit.label, target: row.target,
              targetSheetId: row.targetSheetId, rect, pdfRect };
            row.status = 'ready';
            row.linkIndex = links.length;
            links.push(link);
            placed.push(link);
          }
          review.push(row);
        }
      }
    }
  });
  return { links, review, pagesWithoutText };
}

/**
 * Plan links only on one verified drawing index page. The row parser anchors
 * each link to the exact sheet-ID glyphs; titles and unrelated references do
 * not become links. The writer and guarded preview are shared with Set Batch Link.
 */
export function planIndexSheetLinks(scans, files, register, indexSource, options = {}) {
  const opts = { ...BATCH_LINK_DEFAULTS, ...options };
  const sheets = register?.sheets || [];
  const pathVariants = new Map();
  for (const sheet of sheets) {
    const key = keyOf(sheet.filePath);
    if (pathVariants.has(key) && pathVariants.get(key) !== sheet.filePath) {
      throw new Error('Registered PDF paths differ only by case. Review the set before linking.');
    }
    pathVariants.set(key, sheet.filePath);
  }
  const source = sheets.find(sheet => sheet.id === indexSource?.id);
  if (!source || !source.sourceSha256 || source.filePath !== indexSource.filePath
    || source.page !== indexSource.page || source.sourceSha256 !== indexSource.sourceSha256) {
    throw new Error('The selected index sheet changed. Select and review it again.');
  }
  const byPath = new Map();
  (files || []).forEach((file, index) => {
    const key = keyOf(file.path);
    if (byPath.has(key)) throw new Error('Two selected PDFs have paths that differ only by case. Review the set before linking.');
    byPath.set(key, index);
  });
  const file = byPath.get(keyOf(source.filePath));
  const scan = scans?.[file];
  if (file === undefined || files[file].path !== source.filePath
    || !scan || scan.fingerprint !== source.sourceSha256
    || source.page < 1 || source.page > scan.pageCount) {
    throw new Error('The selected index PDF is missing or changed. Review its source first.');
  }
  if (sheets.filter(sheet => keyOf(sheet.filePath) === keyOf(source.filePath)
    && sheet.page === source.page).length !== 1) {
    throw new Error('More than one registered sheet uses the selected index page.');
  }
  const pages = scan.pages?.filter(item => item.page === source.page) || [];
  if (pages.length !== 1 || !Array.isArray(pages[0].items)
    || !pages[0].items.some(item => item.str?.trim())
    || typeof pages[0].toPdfRect !== 'function') {
    throw new Error('The selected index page has no complete selectable text scan. Review a vector PDF page.');
  }
  const page = pages[0];
  const parsed = indexSheetTitleSuggestions(page.items, null, sheets);
  const links = [];
  const review = [];
  const placed = [];
  for (const row of parsed.unmatched) {
    review.push({ file, page: source.page, sourceSheetId: source.id,
      text: row.text, label: row.text.split(/\s/u)[0], lineY: row.y,
      status: row.reason.startsWith('Sheet ID is not unique') ? 'ambiguous-target' : 'unregistered-target' });
  }
  for (const conflict of parsed.conflicts) {
    const target = sheets.find(sheet => sheet.id === conflict.sheetId);
    review.push({ file, page: source.page, sourceSheetId: source.id,
      text: conflict.lines.join(' / '), label: target?.label || '', lineY: conflict.y,
      status: 'ambiguous-target',
      candidates: target ? [{ sheetId: target.id, path: target.filePath, page: target.page }] : [] });
  }
  for (const [sheetId, match] of parsed.matched) {
    const targetSheet = sheets.find(sheet => sheet.id === sheetId);
    const targetFile = byPath.get(keyOf(targetSheet.filePath));
    const targetScan = scans?.[targetFile];
    const row = { file, page: source.page, sourceSheetId: source.id,
      text: match.evidence, label: targetSheet.label, lineY: match.y, targetSheetId: targetSheet.id,
      targetPath: targetSheet.filePath, targetPage: targetSheet.page, status: '' };
    if (targetFile === undefined || files[targetFile].path !== targetSheet.filePath
      || !targetScan) row.status = 'missing-target';
    else if (!Number.isSafeInteger(targetSheet.page) || targetSheet.page < 1
      || targetSheet.page > targetScan.pageCount) row.status = 'missing-page';
    else if (!targetSheet.sourceSha256) row.status = 'unverified-target';
    else if (targetScan.fingerprint !== targetSheet.sourceSha256) row.status = 'changed-target';
    else if (opts.excludeSelf && targetFile === file && targetSheet.page === source.page) row.status = 'self';
    else if (!match.rect || !(match.rect.width > 0) || !(match.rect.height > 0)) row.status = 'no-location';
    else if (scan.existing.concat(placed).some(item => item.page === source.page
      && overlapRatio(item.rect || item, match.rect) > 0.5)) row.status = 'existing';
    if (!row.status) {
      const rect = match.rect;
      const pdfRect = page.toPdfRect({ x: rect.x - 1, y: rect.y - 1,
        width: rect.width + 2, height: rect.height + 2 });
      const link = { file, page: source.page, text: targetSheet.label, label: targetSheet.label,
        target: { file: targetFile, page: targetSheet.page }, targetSheetId: targetSheet.id,
        rect, pdfRect };
      row.status = 'ready';
      row.linkIndex = links.length;
      links.push(link);
      placed.push(link);
    }
    review.push(row);
  }
  review.sort((first, second) => first.lineY - second.lineY);
  return { links, review, pagesWithoutText: parsed.selectableText ? [] : [{ file, page: source.page }] };
}

/** Stable identity and source state used by registered link resolution. */
export function registeredSetLinkSnapshot(register) {
  return JSON.stringify((register?.sheets || []).map(sheet => [
    sheet.id, sheet.label, sheet.filePath, sheet.page, sheet.sourceSha256 || null,
  ]));
}

/** Pin the exact bytes reviewed by Find for the later guarded output job. */
export async function verifySetLinkPreviewSources(files, scans, readFile) {
  const verified = new Map();
  for (let index = 0; index < (files || []).length; index++) {
    const file = files[index];
    const expected = scans?.[index]?.fingerprint;
    if (!expected) throw new Error(`${file.name} was not scanned. Run Find again.`);
    const bytes = await readFile(file.path);
    if (await fingerprintPdfBytes(bytes) !== expected) {
      throw new Error(`${file.name} changed since Find. Run Find again.`);
    }
    verified.set(keyOf(file.path), new Uint8Array(bytes).slice());
  }
  return verified;
}

/**
 * Where each file goes in the output: its path relative to the set folder
 * (the deepest folder holding every file), or its bare name when `flat`
 * (the browser, which downloads) or when the files share no folder. Two
 * files that would land on the same output name are an error.
 * @returns {{ root: string, rel: string[] }}
 */
export function setOutputLayout(paths, { flat = false } = {}) {
  const root = flat ? '' : commonDirectory(paths);
  const rel = (paths || []).map((path) => (root ? pathInside(path, root) : null) || batchFileName(path));
  const seen = new Map();
  rel.forEach((name, i) => {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`Two files would be written as ${name}: ${paths[seen.get(key)]} and ${paths[i]}.`);
    seen.set(key, i);
  });
  return { root, rel };
}

/**
 * Add the planned links of one file (`file` = its index) to a pdf-lib
 * document. `rel` holds every file's output path (setOutputLayout), from
 * which the /GoToR path is made. Returns the number of links added.
 */
export function addSetLinks(pdfDoc, links, { file, rel, options = {} } = {}) {
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const pageRefs = pages.map((p) => p.ref);
  let added = 0;
  for (const link of links || []) {
    if (link.file !== file || !pages[link.page - 1]) continue;
    const model = batchLinkMarkup({ page: link.page, rect: link.rect, text: link.text, label: link.label, targetPage: link.target.page }, options);
    if (link.target.file !== file) {
      const path = relativePdfPath(rel[file], rel[link.target.file]);
      if (!path) continue;
      model.linkFile = path;
    }
    const dict = buildHyperlinkDict(context, model, link.pdfRect, pageRefs, PRINT_FLAG);
    if (!dict) continue;
    pages[link.page - 1].node.addAnnot(context.register(dict));
    added++;
  }
  return added;
}

const isBatchLinkDict = (dict) => dict?.get?.(PDFName.of('Subtype'))?.toString() === '/Link'
  && String(dict.get(PDFName.of('OPS_BatchLink')) ?? '') === 'true';

/** Delete every link Batch Link made (the OPS_BatchLink marker) from a pdf-lib document; returns the count. */
export function removeBatchLinksFromPdf(pdfDoc) {
  const context = pdfDoc.context;
  let removed = 0;
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const raw = annots.get(i);
      if (!isBatchLinkDict(context.lookup(raw))) continue;
      annots.remove(i);
      if (raw instanceof PDFRef) context.delete(raw);
      removed++;
    }
  }
  return removed;
}

/** The page labels of a pdf-lib document, or null when it has none. */
export function pdfLibPageLabels(pdfDoc) {
  const ranges = readPageLabelRanges(pdfDoc);
  return ranges.length ? labelsFromRanges(ranges, pdfDoc.getPageCount()).map(cleanPageLabel) : null;
}

/** Bookmarks (the app's model) from labels: one per page, in page order. */
export function bookmarksFromLabels(labels) {
  return (labels || []).map((label, i) => ({
    id: `bm_label_${i + 1}`, title: cleanPageLabel(label) || String(i + 1), page: i + 1,
    top: null, left: null, zoom: null, parentId: null, expanded: true,
    bold: false, italic: false, color: null, sortOrder: i, fromPdf: false,
  }));
}

/**
 * Replace the outline of a pdf-lib document with one item per page label.
 * Returns the number of bookmarks, or 0 (outline untouched) without labels.
 */
export function writeLabelBookmarks(pdfDoc, labels = pdfLibPageLabels(pdfDoc)) {
  if (!labels?.length) return 0;
  const bookmarks = bookmarksFromLabels(labels);
  saveBookmarksToOutline(pdfDoc, { bookmarks });
  return bookmarks.length;
}

/** Runner job 1: read every file for the plan. */
export function setLinkScanJob({ pdfjs, measureFor, fingerprint = false, indexSource = null } = {}) {
  return {
    id: 'set-link-scan',
    async processFile(file, { signal }) {
      const pageNumbers = indexSource ? (file.path === indexSource.filePath ? [indexSource.page] : []) : null;
      const scan = await scanSetFile(file.bytes, { pdfjs, signal, measureFor, pageNumbers });
      if (fingerprint) scan.fingerprint = await fingerprintPdfBytes(file.bytes);
      return scan;
    },
    describe: (scan) => scan.labels.filter((l) => l && !/^\d+$/u.test(l)).length,
    async finish(successes) {
      const byPath = new Map(successes.map((s) => [keyOf(s.file.path), s.result]));
      return { byPath };
    },
  };
}

/**
 * Runner job 2: write the links (mode 'create') or remove the Batch Link
 * links (mode 'remove') in each file, and optionally replace its bookmarks
 * by its page labels. `files` is the list the plan was made for (same
 * order); `plan` the planSetLinks() result; `rel` from setOutputLayout().
 * Each result is { name (output path, relative), bytes, added, removed, bookmarks }.
 */
export function setLinkWriteJob({ files, plan, rel, mode = 'create', bookmarks = false, options = {} } = {}) {
  const indexOf = new Map((files || []).map((f, i) => [keyOf(f.path), i]));
  return {
    id: `set-link-${mode}`,
    async processFile(file, { signal }) {
      const index = indexOf.get(keyOf(file.path));
      if (index === undefined) throw new Error('The file is not in the planned set.');
      const pdf = await PDFDocument.load(file.bytes, { updateMetadata: false });
      throwIfCancelled(signal);
      const removed = mode === 'remove' ? removeBatchLinksFromPdf(pdf) : 0;
      const added = mode === 'create' ? addSetLinks(pdf, plan?.links, { file: index, rel, options }) : 0;
      const marks = bookmarks ? writeLabelBookmarks(pdf) : 0;
      const bytes = new Uint8Array(await pdf.save());
      throwIfCancelled(signal);
      return { name: rel[index], bytes, added, removed, bookmarks: marks };
    },
    describe: (r) => r,
    finish: async (successes) => successes.map((s) => ({ name: s.result.name, bytes: s.result.bytes })),
  };
}

/** Output path of a relative name in `dir`, with the separator `dir` uses. */
export function setOutputPath(dir, rel) {
  if (!dir) return batchFileName(rel);
  const backslash = /\\/u.test(dir) && !/\//u.test(dir);
  return joinOutputPath(dir, backslash ? rel.replace(/\//gu, '\\') : rel);
}

/**
 * Write the outputs ([{ name: relative path, bytes }]) into `dir`, keeping
 * the relative layout (the links depend on it). Nothing is written when any
 * output path is a source or already exists: choose an empty folder. With
 * no `dir` (browser) each file is written by its bare name: a download,
 * which never replaces a file.
 * Returns the written paths.
 */
export async function writeSetOutputs(outputs, { dir = '', sources = [], write, exists = async () => false, mkdir = async () => {} } = {}) {
  if (typeof write !== 'function') throw new Error('writeSetOutputs needs write.');
  const taken = new Set((sources || []).map((s) => keyOf(typeof s === 'string' ? s : s?.path)));
  const planned = (outputs || []).map((o) => ({ path: setOutputPath(dir, o.name), rel: o.name, bytes: o.bytes }));
  if (dir) {
    for (const { path } of planned) {
      if (taken.has(keyOf(path))) throw new Error(`${path} is one of the source files. Choose another output folder.`);
    }
    const present = [];
    for (const { path } of planned) if (await exists(path)) present.push(path);
    if (present.length) throw new Error(`The output folder already has ${present.length} of these files (${batchFileName(present[0])}). Choose an empty folder.`);
  }
  const written = [];
  const made = new Set();
  for (const { path, rel, bytes } of planned) {
    const sub = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (dir && sub && !made.has(sub)) {
      await mkdir(setOutputPath(dir, sub));
      made.add(sub);
    }
    await write(path, bytes);
    written.push(path);
  }
  return written;
}

// What the markup model knows about the file, carried across a page change
// (insert, delete, move, paste, merge, replace, and their undo and redo).
//
// Two things must follow the pages:
//
// 1. Which pages had their markups read. A large drawing reads its markups
//    lazily, per sheet. For a sheet not read yet the file is the truth: the
//    saver keeps that page's annotations as they are. A page change that
//    marked every page as read made the saver treat those sheets as read and
//    empty, and the next save dropped every markup on them.
// 2. The PDF object each loaded markup came from (`pdfSource`). Moving pages
//    copies them into a new document, which numbers its objects afresh: the
//    old reference then names another object (or none), and the saver
//    refuses to carry the markup's own fields over from the wrong annotation.
//    The annotation keeps its place in its page's /Annots, so the source is
//    re-pointed by that position.
import { PDFArray, PDFName, PDFRef } from 'pdf-lib';

/** Each page's /Annots entries as reference strings (null for a direct dictionary). */
export function annotationRefsByPage(pdfDoc) {
  return pdfDoc.getPages().map((page) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return annots ? annots.asArray().map((item) => (item instanceof PDFRef ? item.toString() : null)) : [];
  });
}

/**
 * The source of a markup that moved from `oldPage` to `newPage`, given each
 * page's /Annots before and after the change (annotationRefsByPage). Null when
 * the source cannot be matched: the markup is then written as a new one, and
 * its old dictionary on the page is replaced like any rewritten markup.
 */
export function movedSource(source, oldPage, newPage, refsBefore, refsAfter) {
  const before = refsBefore?.[oldPage - 1];
  const after = refsAfter?.[newPage - 1];
  if (!before || !after || before.length !== after.length) return null;
  const at = before.indexOf(source.ref);
  if (at < 0 || !after[at]) return null;
  return { ...source, ref: after[at] };
}

/**
 * Markups on their new pages (`pageMapping`: old page -> new page, null for a
 * page that went). With the /Annots of both documents, each loaded markup's
 * source follows its annotation; without them the sources stay as they are
 * (the change kept every object number).
 */
export function remapPageAnnotations(annotations, pageMapping, refsBefore = null, refsAfter = null) {
  const remapped = [];
  for (const ann of annotations) {
    const newPage = pageMapping[ann.page];
    if (newPage === undefined || newPage === null) continue;
    const copy = { ...ann, page: newPage };
    const source = ann.pdfSource;
    if (refsBefore && refsAfter && source && source.modelId === ann.id) {
      const moved = movedSource(source, ann.page, newPage, refsBefore, refsAfter);
      if (moved) copy.pdfSource = moved;
      else delete copy.pdfSource;
    }
    remapped.push(copy);
  }
  return remapped;
}

/** The pages of `doc` whose markups are in the model. */
export function readMarkupPages(doc) {
  const ready = doc?._annotationPagesReady || doc?._loadedAnnotationPages;
  return new Set(ready || []);
}

/**
 * The pages whose markups are in the model after a change to `numPages`
 * pages. `explicit` (undo and redo) is the set recorded with the restored
 * markups. Otherwise a read page stays read on its new number
 * (`pageMapping`), or on its own number when no page moved. A new page is
 * not read: its markups come from the new file when it is shown. A page that
 * holds a markup of the model is always read, or the saver would write that
 * markup next to the file's copy of it.
 */
export function readPagesAfterChange({ read, pageMapping = null, explicit = null, numPages, annotations = [] }) {
  const pages = new Set();
  const add = (p) => { if (Number.isInteger(p) && p >= 1 && p <= numPages) pages.add(p); };
  if (explicit) {
    for (const p of explicit) add(p);
  } else if (pageMapping) {
    for (const p of read) add(pageMapping[p] ?? null);
  } else {
    for (const p of read) add(p);
  }
  for (const ann of annotations) add(ann?.page);
  return pages;
}

// Is a thumbnail run that started for `doc` (with `pdfDoc`) still about the
// document on screen? False once another tab is active, the tab was closed,
// or the document was reloaded with a new pdfDoc.

/**
 * @param {object} doc  the document the run started for
 * @param {object} pdfDoc  its pdfDoc at that moment
 * @param {object|null|undefined} active  the active document now
 * @param {object[]|null|undefined} documents  the open documents now
 */
export function thumbnailDocStillCurrent(doc, pdfDoc, active, documents) {
  if (!doc || !pdfDoc) return false;
  return active === doc && Array.isArray(documents) && documents.includes(doc) && doc.pdfDoc === pdfDoc;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { thumbnailDocStillCurrent } from './thumbnail-doc-current.js';

test('a thumbnail run stops on a tab switch, a closed tab or a reload', () => {
  const pdfDoc = {};
  const doc = { pdfDoc };
  const other = { pdfDoc: {} };
  assert.equal(thumbnailDocStillCurrent(doc, pdfDoc, doc, [doc, other]), true);
  assert.equal(thumbnailDocStillCurrent(doc, pdfDoc, other, [doc, other]), false, 'other tab active');
  assert.equal(thumbnailDocStillCurrent(doc, pdfDoc, doc, [other]), false, 'tab closed');
  doc.pdfDoc = {};
  assert.equal(thumbnailDocStillCurrent(doc, pdfDoc, doc, [doc]), false, 'reloaded');
  assert.equal(thumbnailDocStillCurrent(null, pdfDoc, null, []), false);
});

test('generateThumbnails checks after loading page 1, before touching the strip', () => {
  const src = readFileSync(new URL('./left-panel.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function generateThumbnails'));
  const getPage = fn.indexOf('await pdfDoc.getPage(1);');
  const firstCheck = fn.indexOf('if (!stillCurrent()) return;', getPage);
  assert.ok(getPage > 0 && firstCheck > getPage);
  assert.ok(firstCheck < fn.indexOf('getPageRotation(1)'), 'before the rotation of the active doc is read');
  const afterCatch = fn.indexOf('if (!stillCurrent()) return;', fn.indexOf("Could not get first page dimensions"));
  assert.ok(afterCatch > 0 && afterCatch < fn.indexOf('documentState.set(docId'));
  assert.ok(afterCatch < fn.indexOf('setPageCount(numPages)'));
});

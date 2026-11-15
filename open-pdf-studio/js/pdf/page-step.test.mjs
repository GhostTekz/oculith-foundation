import assert from 'node:assert/strict';
import test from 'node:test';

import { pageStepTarget } from './page-step.js';

const docOf = (page, numPages = 1000) => ({ currentPage: page, pdfDoc: { numPages } });

test('steps before the page has moved build on each other', () => {
  const doc = docOf(85);
  const targets = [];
  for (let i = 0; i < 20; i++) targets.push(pageStepTarget(doc, 1));
  assert.deepEqual(targets, Array.from({ length: 20 }, (_, i) => 86 + i));
  // goToPage applies the targets one by one; the next click builds on the page.
  doc.currentPage = 105;
  assert.equal(pageStepTarget(doc, 1), 106);
});

test('steps applied one by one while more clicks arrive are not lost', () => {
  const doc = docOf(99);
  assert.equal(pageStepTarget(doc, 1), 100);
  assert.equal(pageStepTarget(doc, 1), 101);
  doc.currentPage = 100; // goToPage(100) ran, goToPage(101) not yet
  assert.equal(pageStepTarget(doc, 1), 102);
  doc.currentPage = 101;
  doc.currentPage = 102;
  assert.equal(pageStepTarget(doc, -1), 101);
});

test('a page set by another route starts the steps again', () => {
  const doc = docOf(10);
  assert.equal(pageStepTarget(doc, 1), 11);
  doc.currentPage = 400; // thumbnail, link, page field
  assert.equal(pageStepTarget(doc, -1), 399);
});

test('steps stop at the first and last page', () => {
  const doc = docOf(999);
  assert.equal(pageStepTarget(doc, 1), 1000);
  assert.equal(pageStepTarget(doc, 1), 1000);
  assert.equal(pageStepTarget(doc, -1), 999);
  const first = docOf(1);
  assert.equal(pageStepTarget(first, -1), 1);
});

test('facing view: goToPage turns spreads, so steps do not stack', () => {
  const doc = { ...docOf(4), facingSpread: true };
  assert.equal(pageStepTarget(doc, 1), 5);
  assert.equal(pageStepTarget(doc, 1), 5);
});

test('no document or no pages', () => {
  assert.equal(pageStepTarget(null, 1), null);
  assert.equal(pageStepTarget({ currentPage: 1, pdfDoc: { numPages: 0 } }, 1), null);
});

// Efficiency fixes found by profiling a large the external editor drawing (hundreds of
// markups, dozens of layers and groups). Behaviour where it can run under
// node; the wiring of the browser-only parts is guarded on the source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { createDateFormatter } = await import('../../utils/helpers.js');
const { memoizeMarkupSortValue, sortMarkupRows } = await import('./markup-column-sort.js');
const { partitionThumbnailInvalidations } = await import('../../pdf/thumbnail-schedule.js');
const bron = (pad) => readFileSync(new URL(pad, import.meta.url), 'utf8');

test('the date formatter formats each date text once per run, with the same result', () => {
  const fmt = createDateFormatter();
  const a = fmt('2026-10-01T12:34:00Z');
  assert.equal(fmt('2026-10-01T12:34:00Z'), a);
  assert.equal(fmt(''), '');
  assert.notEqual(fmt('2026-10-02T12:34:00Z'), a);
  assert.equal(typeof fmt('not a date'), 'string', 'an invalid date still gives text');
});

test('a list build looks up each layer name once, not per markup', () => {
  const lijst = bron('./annotations-list.js');
  assert.match(lijst, /layerNameMemo = \{ doc: state\.documents\[state\.activeDocumentIndex\], names: new Map\(\) \};/);
  assert.match(lijst, /\} finally \{\n\s*layerNameMemo = null;/, 'the memo never outlives the build');
  assert.match(lijst, /const perGroep = new Map\(\);/, 'group rows: one pass, not a filter per group');
  assert.match(lijst, /sortMarkupRows\([^;]+, sortValue\)/, 'list sorting uses the cached value');
  const rows = [
    { id: 'later', createdAt: '2026-10-02' },
    { id: 'first', createdAt: '2026-10-01' },
    { id: 'last', createdAt: '2026-10-03' },
  ];
  let parsed = 0;
  const value = memoizeMarkupSortValue((row) => { parsed++; return Date.parse(row.createdAt); });
  assert.deepEqual(sortMarkupRows(rows, { column: 'date', direction: 'ascending' }, value).map(row => row.id),
    ['first', 'later', 'last']);
  assert.equal(parsed, rows.length, 'each markup date is parsed once regardless of comparisons');
});

test('a page\'s markups load next to its render; a second caller waits for the same load', () => {
  const loader = bron('../../pdf/loader.js');
  const ensure = loader.slice(loader.indexOf('export async function ensureAnnotationsForPage'));
  // The same load, while the pages did not change (page-loads-after-change.test.mjs).
  assert.match(ensure, /const lopend = annotationPageLoads\.get\(doc\)\?\.get\(pageNum\);\n\s*if \(lopend\?\.epoch === epoch\) return lopend\.wait;/);
  const renderer = bron('../../pdf/renderer.js');
  const impl = renderer.slice(renderer.indexOf('async function _renderPageImpl'));
  assert.ok(impl.indexOf('ensureAnnotationsForPage(pageNum).catch(') < impl.indexOf('tekenPaginaMetPdfJs('),
    'started before the page is drawn');
});

test('a markup edit does not re-render thumbnails while the Thumbnails panel is hidden', () => {
  const links = bron('./left-panel.js');
  const inval = links.slice(links.indexOf('export function invalidateThumbnails'));
  assert.match(inval.slice(0, 900), /partitionThumbnailInvalidations\(pageNums, isPanelShown\('thumbnails'\), range\)/);
  assert.deepEqual(partitionThumbnailInvalidations([1, 2, 3], false, null),
    { immediate: [], deferred: [1, 2, 3] });
  assert.deepEqual(partitionThumbnailInvalidations([1, 2, 3], false, { start: 2, end: 2 }),
    { immediate: [2], deferred: [1, 3] });
  assert.deepEqual(partitionThumbnailInvalidations([1, 2, 3, 4], false, { pages: new Set([1, 4]) }),
    { immediate: [1, 4], deferred: [2, 3] });
  assert.deepEqual(partitionThumbnailInvalidations([1, 2, 3], true, null),
    { immediate: [1, 2, 3], deferred: [] });
  assert.match(links, /export function flushDeferredThumbnails\(\)/);
  assert.match(bron('../../solid/components/left-panel/panels/ThumbnailsPanel.jsx'), /m\.flushDeferredThumbnails\(\)/);
});

test('panel fields do not subscribe to every annotation, and compute once per change', () => {
  assert.match(bron('../../solid/stores/propertiesStore.js'), /return untrack\(\(\) => annotationsInDocument\(doc, \[currentAnnotation\]\)\);/);
  assert.match(bron('../../solid/components/left-panel/AnnotationLayersPanel.jsx'),
    /return untrack\(\(\) => layerRows\(getActiveDocument\(\), naam, \{ raw: true \}\)\);/);
  const veld = bron('../../solid/components/properties-panel/LayerField.jsx');
  assert.match(veld, /const waarde = createMemo\(/);
  assert.match(veld, /const doelen = createMemo\(/);
});

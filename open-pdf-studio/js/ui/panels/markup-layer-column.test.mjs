// Markups List Layer column: each markup's markup layer name (the default
// layer by its translated name, an unknown layer id falls back to it), sorted
// and searched like the other columns and exported by name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../../core/state.js');
const { list, store, showList } = await import('./annotations-list.testhulp.mjs');
const { addLayer } = await import('../../annotations/annotatie-lagen.js');
const { markupCsv } = await import('../../annotations/markup-csv.js');

function openDoc() {
  const doc = { id: `layers-${Math.random()}`, currentPage: 1, viewMode: 'single', annotations: [], selectedAnnotations: [] };
  const mep = addLayer(doc, { name: 'MEP review' }).layer;
  const arch = addLayer(doc, { name: 'Architect' }).layer;
  const box = (id, layer) => ({ id, type: 'box', page: 1, x: 0, y: 0, width: 5, height: 5, author: 'A',
    createdAt: '2026-10-01T00:00:00Z', ...(layer ? { layer } : {}) });
  doc.annotations.push(box('m', mep.id), box('d'), box('a', arch.id), box('gone', 'deleted-layer'));
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  store.setSearchQuery('');
  return doc;
}
const rows = () => store.items().filter(item => !item.isHeader);

test('rows carry the layer name, and the default label follows the translation', () => {
  showList();
  openDoc();
  list.setDefaultLayerLabel('Standaard');
  store.setColumnSort(null);
  list.updateAnnotationsList();
  assert.deepEqual(Object.fromEntries(rows().map(r => [r.id, r.layerName])),
    { m: 'MEP review', d: 'Standaard', a: 'Architect', gone: 'Standaard' });
  list.setDefaultLayerLabel('Default');
});

test('the Layer header sorts by name both ways', () => {
  showList();
  openDoc();
  store.setColumnSort({ column: 'layer', direction: 'ascending' });
  list.updateAnnotationsList();
  assert.deepEqual(rows().map(r => r.layerName), ['Architect', 'Default', 'Default', 'MEP review']);
  store.setColumnSort({ column: 'layer', direction: 'descending' });
  list.updateAnnotationsList();
  assert.deepEqual(rows().map(r => r.layerName)[0], 'MEP review');
  store.setColumnSort(null);
});

test('search matches the layer name', () => {
  showList();
  openDoc();
  store.setSearchQuery('mep');
  list.updateAnnotationsList();
  assert.deepEqual(rows().map(r => r.id), ['m']);
  store.setSearchQuery('');
});

test('CSV writes the layer name the list shows', () => {
  const doc = openDoc();
  const csv = markupCsv(doc.annotations, null, '', null, null, null, null, '', null, null,
    { layerName: annotation => list.markupLayerName(doc, annotation) });
  assert.match(csv, /"MEP review"/u);
  assert.match(csv, /"Default"/u);
  assert.doesNotMatch(csv, /deleted-layer/u);
});

test('selecting a markup layer highlights its rows and the layer header', async () => {
  showList();
  const doc = openDoc();
  list.setDefaultLayerLabel('Default');
  const vorige = store.sortMode();
  store.setColumnSort(null);
  store.setSortMode('layer');
  list.updateAnnotationsList();
  store.collapseAllGroups(['Architect', 'Default', 'MEP review']);
  const layers = await import('../../solid/stores/annotationLayersStore.js');
  const mepId = doc.annotations.find(a => a.id === 'm').layer;
  assert.equal(await layers.selectAnnotationsOnLayer(mepId), 1);
  list.updateAnnotationsList();
  const body = store.items().filter(item => !item.isHeader);
  assert.deepEqual(body.filter(row => row.selected).map(row => row.id), ['m']);
  const header = store.items().find(item => item.isHeader && item.headerLabel === 'MEP review');
  assert.equal(header.sectionSelected, true);
  assert.equal(header.layerId, mepId);
  assert.equal(store.items().find(item => item.isHeader && item.headerLabel === 'Architect').sectionSelected, false);
  // The list module pulls in dialog JSX, so node cannot load the copy the
  // store refreshes. Opening the group uses that module's layer name.
  store.expandGroup(list.markupLayerName(doc, doc.annotations.find(a => a.id === 'm')));
  assert.equal(store.collapsedGroups().has('MEP review'), false);
  store.setSortMode(vorige);
  store.expandAllGroups();
});

test('Group By Layer: one group per layer name, sorted by name (docs/reference/editor/layers.md)', () => {
  showList();
  openDoc();
  const vorige = store.sortMode();
  store.setColumnSort(null);
  store.setSortMode('layer');
  list.updateAnnotationsList();
  const headers = store.items().filter(item => item.isHeader);
  assert.deepEqual(headers.map(h => [h.headerLabel, h.count]), [['Architect', 1], ['Default', 2], ['MEP review', 1]]);
  const perGroup = Object.fromEntries(headers.map(h => [h.groupKey,
    rows().filter(r => r.groupKey === h.groupKey).map(r => r.id).sort()]));
  assert.deepEqual(perGroup, { Architect: ['a'], Default: ['d', 'gone'], 'MEP review': ['m'] });
  store.setSortMode(vorige);
});

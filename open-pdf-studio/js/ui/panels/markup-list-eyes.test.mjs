// Markups List eyes (docs/reference/editor/layers.md): with Group By Layer each group
// header has the layer's eye, the same switch as the Layers panel, and every
// row has an eye for that one markup. The list runs with the real list store
// (annotations-list.testhulp.mjs); the Layers panel rows come from the same
// model function the panel renders (layerRows). The Solid component itself
// does not run under node: its wiring is guarded on the source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../../core/state.js');
const { list, store, showList } = await import('./annotations-list.testhulp.mjs');
const { addLayer, layerRows, DEFAULT_LAYER_ID } = await import('../../annotations/annotatie-lagen.js');
const layersStore = await import('../../solid/stores/annotationLayersStore.js');
const { undo } = await import('../../core/undo-manager.js');

function openDoc() {
  const doc = { id: `eyes-${Math.random()}`, filePath: null, currentPage: 1, viewMode: 'single', annotations: [],
    selectedAnnotations: [], selectedAnnotation: null, undoStack: [], redoStack: [], savedUndoStackLength: 0,
    pdfDoc: { numPages: 1 }, pageRotations: {}, textEdits: [] };
  const mep = addLayer(doc, { name: 'MEP review' }).layer;
  const arch = addLayer(doc, { name: 'Architect' }).layer;
  const box = (id, layer) => ({ id, type: 'box', page: 1, x: 0, y: 0, width: 5, height: 5, author: 'A', subject: `Box ${id}`,
    createdAt: '2026-10-01T00:00:00Z', ...(layer ? { layer } : {}) });
  doc.annotations.push(box('m', mep.id), box('d'), box('a', arch.id), box('gone', 'deleted-layer'));
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  store.setSearchQuery('');
  store.setColumnSort(null);
  store.setSortMode('layer');
  showList();
  list.updateAnnotationsList();
  return { doc: state.documents[0], mep, arch };
}
const headers = () => store.items().filter(item => item.isHeader);
const header = (label) => headers().find(h => h.headerLabel === label);
const row = (id) => store.items().find(item => !item.isHeader && item.id === id);
const panelRow = (doc, name) => layerRows(doc, 'Default').find(r => r.name === name);

test('Group By Layer headers carry their layer; other groupings have no layer eye', () => {
  const vorige = store.sortMode();
  const { mep, arch } = openDoc();
  assert.deepEqual(headers().map(h => [h.headerLabel, h.layerId, h.layerHidden]),
    [['Architect', arch.id, false], ['Default', DEFAULT_LAYER_ID, false], ['MEP review', mep.id, false]]);
  store.setSortMode('author');
  list.updateAnnotationsList();
  assert.ok(headers().every(h => !('layerId' in h)));
  store.setSortMode(vorige);
});

test('group eye = Layers panel switch: hiding from the list shows in the panel, and back', () => {
  const { doc, mep } = openDoc();
  // The group eye calls the Layers panel's own action.
  layersStore.setAnnotationLayerFlag(header('MEP review').layerId, 'visible', false);
  assert.equal(panelRow(doc, 'MEP review').visible, false, 'Layers panel shows it off');
  list.updateAnnotationsList();
  assert.equal(header('MEP review').layerHidden, true);
  assert.equal(row('m').layerHidden, true, 'its rows show "hidden by layer"');
  assert.equal(row('d').layerHidden, false);
  // And the other way round: the Layers panel eye turns it on again.
  layersStore.setAnnotationLayerFlag(mep.id, 'visible', true);
  list.updateAnnotationsList();
  assert.equal(header('MEP review').layerHidden, false);
  assert.equal(row('m').layerHidden, false);
});

test('the Default group switches the default layer: markups without a layer, or on an unknown one', () => {
  const { doc } = openDoc();
  layersStore.setAnnotationLayerFlag(header('Default').layerId, 'visible', false);
  list.updateAnnotationsList();
  assert.equal(layerRows(doc, 'Default').find(r => r.id === DEFAULT_LAYER_ID).visible, false);
  assert.deepEqual(['m', 'd', 'a', 'gone'].map(id => row(id).layerHidden), [false, true, false, true]);
  layersStore.setAnnotationLayerFlag(DEFAULT_LAYER_ID, 'visible', true);
});

test('row eye hides one markup as one undo step, leaves the selection alone, and shows it again', async () => {
  const { doc } = openDoc();
  const a = doc.annotations.find(x => x.id === 'a');
  doc.selectedAnnotations = [a];
  doc.selectedAnnotation = a;
  const stappen = doc.undoStack.length;
  assert.equal(list.toggleMarkupHidden('a'), true);
  assert.equal(a.hidden, true);
  assert.equal(row('a').hidden, true);
  assert.equal(doc.undoStack.length, stappen + 1);
  assert.deepEqual(doc.selectedAnnotations.map(x => x.id), ['a'], 'still selected in the list');
  assert.equal(row('a').selected, true);
  await undo();
  assert.equal('hidden' in state.documents[0].annotations.find(x => x.id === 'a'), false);
  assert.equal(list.toggleMarkupHidden('a'), true);
  assert.equal(list.toggleMarkupHidden('a'), false);
  assert.equal('hidden' in a, false, 'shown again: no key left');
});

test('row eye on a markup whose layer is hidden: nothing changes, the row says why', () => {
  const { doc, mep } = openDoc();
  layersStore.setAnnotationLayerFlag(mep.id, 'visible', false);
  list.updateAnnotationsList();
  const stappen = doc.undoStack.length;
  assert.equal(list.toggleMarkupHidden('m'), null);
  assert.equal('hidden' in doc.annotations.find(x => x.id === 'm'), false);
  assert.equal(doc.undoStack.length, stappen);
  assert.equal(row('m').layerHidden, true);
  assert.equal(row('m').layerName, 'MEP review', 'the tooltip names this layer');
  layersStore.setAnnotationLayerFlag(mep.id, 'visible', true);
});

test('the component: real buttons at the left, labelled, pressed state, clicks stay on the eye', () => {
  const src = readFileSync(new URL('../../solid/components/left-panel/panels/AnnotationsPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /const eyeIcon = lucide\('eye'\);/);
  assert.match(src, /const eyeOffIcon = lucide\('eye-off'\);/);
  // Row eye in the gutter cell (the first, left column); group eye before the chevron.
  assert.match(src, /<div class="annotation-cell annotation-cell-gutter">\s*<Show when=\{item\.accentColor\}>[\s\S]*?<\/Show>\s*\{rowEye\(item\)\}\s*<\/div>/);
  // Every section has an eye now (docs/reference/editor/markups-list.md); Group By Layer's is the layer switch.
  assert.match(src, /\{headerEye\(item\)\}\s*<svg class="annotations-group-chevron"/);
  assert.match(src, /const headerEye = \(item\) => \(item\.sortMode === 'layer' && item\.layerId \? groupEye\(item\) : sectionEye\(item\)\)/);
  const rowEye = src.slice(src.indexOf('const rowEye = '), src.indexOf('const groupEye = '));
  const groupEye = src.slice(src.indexOf('const groupEye = '), src.indexOf('const categoryEye = '));
  for (const eye of [rowEye, groupEye]) {
    assert.match(eye, /<button type="button"/);
    assert.match(eye, /aria-pressed=/);
    assert.match(eye, /aria-label=/);
    assert.match(eye, /on:keydown=\{onEyeKeyDown\}/);
    assert.match(eye, /on:mousedown=\{stopEye\}/);
  }
  assert.match(groupEye, /event\.stopPropagation\(\);/);
  assert.match(groupEye, /m\.setAnnotationLayerFlag\(item\.layerId, 'visible', !!item\.layerHidden\)/);
  assert.match(src, /const toggleRowEye = \(item, event\) => \{\s*event\.stopPropagation\(\);/);
  assert.match(src, /if \(item\.layerHidden\) return;/);
  const css = readFileSync(new URL('../../../styles/oculith-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /#annotations-panel \.annotation-eye:focus-visible \{ outline: 2px solid var\(--ox-accent\)/);
  const en = JSON.parse(readFileSync(new URL('../../i18n/locales/en/properties.json', import.meta.url), 'utf8')).markupsList;
  assert.equal(en.hideMarkupFor, 'Hide {{markup}}');
  assert.equal(en.showLayerFor, 'Show layer {{layer}}');
  // A Layers panel switch refreshes the list, so both stay in step.
  const layers = readFileSync(new URL('../../solid/stores/annotationLayersStore.js', import.meta.url), 'utf8');
  const flag = layers.slice(layers.indexOf('export function setAnnotationLayerFlag'));
  assert.match(flag.slice(0, 500), /lijstBijwerken\(\);/);
});

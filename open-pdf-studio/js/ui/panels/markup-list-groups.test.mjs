// Markups List and markup groups (docs/reference/editor/markups-list.md): every section has
// an eye (tri-state, one undo step), a group is one Group row with its
// members under it, in the section of its dominant markup, with its own eye
// and totals; Group By Group; rows dropped on a section or a Group row go
// into that category. Runs the real list with the real store
// (annotations-list.testhulp.mjs). The Solid component does not run under
// node: its wiring is guarded on the source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../../core/state.js');
const { list, store, showList } = await import('./annotations-list.testhulp.mjs');
const { addLayer } = await import('../../annotations/annotatie-lagen.js');
const layersStore = await import('../../solid/stores/annotationLayersStore.js');
const { undo } = await import('../../core/undo-manager.js');
const G = await import('../../annotations/markup-groups.js');

function openDoc(sort = 'subject') {
  const doc = { id: `groups-${Math.random()}`, filePath: null, currentPage: 1, viewMode: 'single', annotations: [],
    selectedAnnotations: [], selectedAnnotation: null, undoStack: [], redoStack: [], savedUndoStackLength: 0,
    pdfDoc: { numPages: 1 }, pageRotations: {}, textEdits: [] };
  const temp = addLayer(doc, { name: 'Site Lighting' }).layer;
  const mk = (id, subject, extra = {}) => ({ id, type: 'measureDistance', page: 1, startX: 0, startY: 0, endX: 10, endY: 0,
    author: 'A', subject, createdAt: `2026-10-01T00:00:0${doc.annotations.length}Z`, measureValue: 10, measureUnit: 'ft', ...extra });
  doc.annotations.push(mk('a', 'Feeder'), mk('b', 'Feeder'), mk('c', 'Light', { layer: temp.id }), mk('d', 'Light'),
    { id: 'e', type: 'box', page: 1, x: 0, y: 0, width: 5, height: 5, author: 'B', subject: 'Box', createdAt: '2026-10-01T00:00:09Z' });
  // A group whose dominant (c) is a Light, with a Feeder member (a).
  G.groupMarkups(doc.annotations, [doc.annotations[2], doc.annotations[0]], { id: 'g1', name: 'Zone 1' });
  state.documents = [doc];
  state.activeDocumentIndex = 0;
  store.setSearchQuery('');
  store.setColumnSort(null);
  store.setSortMode(sort);
  // A canvas selection opens the section and group that hold it. The next
  // document starts closed, which is how a fresh list starts.
  store.expandAllGroups();
  store.setExpandedMarkupGroups(new Set());
  showList();
  list.updateAnnotationsList();
  return { doc: state.documents[0], temp };
}
const rows = () => store.items();
const header = (label) => rows().find(i => i.isHeader && i.headerLabel === label);
const groupRow = (id) => rows().find(i => i.isMarkupGroup && i.mgId === id);
const row = (id) => rows().find(i => !i.isHeader && !i.isMarkupGroup && i.id === id);
const ann = (doc, id) => doc.annotations.find(a => a.id === id);

test('shift-click selects the visible rows from one markup through the other', async () => {
  const { doc } = openDoc('subject');
  await list.selectMarkupRange(null, 'markup:e', 1);
  assert.deepEqual(doc.selectedAnnotations.map(a => a.id), ['e']);
  await list.selectMarkupRange('markup:e', 'markup:d', 1);
  assert.deepEqual(doc.selectedAnnotations.map(a => a.id), ['e', 'b', 'a', 'c', 'd']);
  store.setExpandedMarkupGroups(new Set(['g1']));
  list.updateAnnotationsList();
  await list.selectMarkupRange('markup:a', 'markup:d', 1);
  assert.deepEqual(doc.selectedAnnotations.map(a => a.id), ['a', 'c', 'd']);
  await list.selectMarkupRange('markup:d', 'markup:b', 1);
  assert.deepEqual(doc.selectedAnnotations.map(a => a.id), ['b', 'a', 'c', 'd']);
});

test('a group is one Group row in its dominant markup\'s section, members under it', () => {
  openDoc('subject');
  const order = rows().map(i => (i.isHeader ? `#${i.headerLabel}` : i.isMarkupGroup ? `G:${i.name}` : i.id));
  assert.deepEqual(order, ['#Box', 'e', '#Feeder', 'b', '#Light', 'G:Zone 1', 'a', 'c', 'd']);
  const g = groupRow('g1');
  assert.equal(g.count, 2);
  assert.equal(g.depth, 0);
  assert.equal(g.dominantId, 'c');
  assert.equal(g.totalsText, 'Length 20 ft', 'the external editor: the sum of the members');
  assert.deepEqual([row('c').depth, row('c').mgAncestors], [1, 'g1']);
  assert.equal(header('Feeder').count, 1, 'a is listed with its group');
  assert.equal(header('Light').count, 3);
});

test('every Group By has a section eye; tri-state; one undo step; layer-hidden markups keep their flag', async () => {
  for (const sort of ['page', 'type', 'author', 'color', 'subject', 'status', 'modifiedDate', 'space', 'markupGroup', 'layer']) {
    openDoc(sort);
    assert.ok(rows().filter(i => i.isHeader).every(h => ['shown', 'hidden', 'mixed', 'layer'].includes(h.eye)), sort);
  }
  const { doc } = openDoc('subject');
  assert.equal(header('Light').eye, 'shown');
  const stappen = doc.undoStack.length;
  assert.equal(list.toggleCategoryEye('section:Light'), true);
  assert.deepEqual(['c', 'a', 'd'].map(id => !!ann(doc, id).hidden), [true, true, true]);
  assert.equal(doc.undoStack.length, stappen + 1, 'one undo step');
  assert.equal(header('Light').eye, 'hidden');
  assert.equal(header('Feeder').eye, 'shown');
  delete ann(doc, 'd').hidden;
  list.updateAnnotationsList();
  assert.equal(header('Light').eye, 'mixed');
  assert.equal(list.toggleCategoryEye('section:Light'), false, 'mixed: a click shows all');
  assert.ok(['c', 'a', 'd'].every(id => !('hidden' in ann(doc, id))));
  await undo();
  assert.ok(['c', 'a'].every(id => ann(doc, id).hidden === true), 'undo puts the flags back');
});

test('the Group row eye hides the whole group, nested members included', () => {
  const { doc } = openDoc('subject');
  G.groupMarkups(doc.annotations, [ann(doc, 'c'), ann(doc, 'e')], { id: 'top', name: 'Outer' });
  list.updateAnnotationsList();
  assert.equal(groupRow('g1').depth, 1, 'a nested Group row');
  assert.equal(list.toggleCategoryEye('group:top'), true);
  assert.deepEqual(['a', 'c', 'e', 'b'].map(id => !!ann(doc, id).hidden), [true, true, true, false]);
  assert.equal(groupRow('top').eye, 'hidden');
  assert.equal(groupRow('g1').eye, 'hidden');
});

test('Group By Layer keeps the Layers panel switch; a layer-hidden markup is not shown by a section eye', () => {
  const { doc, temp } = openDoc('subject');
  layersStore.setAnnotationLayerFlag(temp.id, 'visible', false);
  list.updateAnnotationsList();
  list.toggleCategoryEye('section:Light'); // hides a and d (c is hidden by its layer)
  assert.equal('hidden' in ann(doc, 'c'), false, 'the layer decides for c');
  list.toggleCategoryEye('section:Light');
  assert.ok(['a', 'd'].every(id => !('hidden' in ann(doc, id))));
  store.setSortMode('layer');
  list.updateAnnotationsList();
  assert.equal(rows().find(i => i.isHeader && i.headerLabel === 'Site Lighting').layerHidden, true);
  layersStore.setAnnotationLayerFlag(temp.id, 'visible', true);
});

test('Group By Group: a section per group name, markups in no group last', () => {
  openDoc('markupGroup');
  assert.deepEqual(rows().filter(i => i.isHeader).map(i => i.headerLabel), ['Zone 1', '(No Group)']);
});

test('drop rows on a section or a Group row: subject, author, the group; one undo step', async () => {
  const { doc } = openDoc('subject');
  assert.equal(await list.dropMarkupsOnCategory(['e'], { sortMode: 'subject', groupKey: 'Feeder' }), 1);
  assert.equal(ann(doc, 'e').subject, 'Feeder');
  assert.equal(await list.dropMarkupsOnCategory(['b'], { groupId: 'g1' }), 3);
  assert.equal(ann(doc, 'b').groupId, 'g1');
  assert.equal(groupRow('g1').count, 3);
  assert.equal(await list.dropMarkupsOnCategory(['d'], { sortMode: 'page', groupKey: '1' }), 0, 'not a category');
  assert.equal(await list.dropMarkupsOnCategory(['d'], { sortMode: 'author', groupKey: 'B' }), 1);
  assert.equal(ann(doc, 'd').author, 'B');
  assert.equal(list.setMarkupsSubject([ann(doc, 'd'), ann(doc, 'b')], ' Branch Feed '), 2);
  assert.deepEqual([ann(doc, 'd').subject, ann(doc, 'b').subject], ['Branch Feed', 'Branch Feed']);
  await undo();
  assert.deepEqual([ann(doc, 'd').subject, ann(doc, 'b').subject], ['Light', 'Feeder'], 'one undo step');
});

test('selecting a Group row selects the whole group, the dominant first', async () => {
  const { doc } = openDoc('subject');
  await list.selectMarkupGroupItem('g1');
  assert.deepEqual(doc.selectedAnnotations.map(a => a.id).sort(), ['a', 'c']);
  assert.equal(doc.selectedAnnotation.id, 'c');
  assert.equal(groupRow('g1').groupSelected, true);
});

test('a canvas selection matches by id and opens the section and group that hold the row', () => {
  const { doc } = openDoc('subject');
  store.toggleGroup('Light');
  assert.equal(store.collapsedGroups().has('Light'), true);
  assert.equal(store.expandedMarkupGroups().has('g1'), false);
  doc.selectedAnnotations = [{ id: 'a' }];
  doc.selectedAnnotation = doc.selectedAnnotations[0];
  list.updateAnnotationsList();
  assert.equal(row('a').selected, true, 'a different object with the same id still selects the row');
  assert.equal(row('c').selected, false);
  assert.equal(store.collapsedGroups().has('Light'), false, 'the section opens');
  assert.equal(store.expandedMarkupGroups().has('g1'), true, 'the group above the row opens');
  const plan = list.revealPlan(rows(), ['a'], 'a');
  assert.deepEqual(plan.markupGroups, ['g1']);
  assert.equal(plan.rowId, 'a');
  assert.equal(plan.sectionKey, 'Light');
  store.toggleGroup('Light');
  list.updateAnnotationsList();
  assert.equal(store.collapsedGroups().has('Light'), true, 'a later redraw does not reopen a section the user closed');
});

test('wiring: section eyes in every Group By, Group rows, drops, list menus, Alt and marquee', () => {
  const paneel = readFileSync(new URL('../../solid/components/left-panel/panels/AnnotationsPanel.jsx', import.meta.url), 'utf8');
  assert.match(paneel, /const headerEye = \(item\) => \(item\.sortMode === 'layer' && item\.layerId \? groupEye\(item\) : sectionEye\(item\)\)/);
  assert.equal((paneel.match(/\{headerEye\(item\)\}/g) || []).length, 2, 'color headers and the others');
  assert.match(paneel, /item\.isMarkupGroup \? groupRow\(item\)/);
  assert.match(paneel, /selectMarkupRange\(anchorAtClick, key, item\.page\)/);
  assert.match(paneel, /const key = `markup:\$\{item\.id\}`/);
  assert.match(paneel, /const anchorAtClick = markupAnchorKey;/);
  assert.match(paneel, /m\.dropMarkupsOnCategory\(ids/);
  assert.match(paneel, /showMultiAnnotationMenu\(x, y, count, \{ annotation \}\)/);
  assert.match(paneel, /\{ key: 'markupGroup', common: 'markupGroups\.groupByGroup' \}/);
  const kies = readFileSync(new URL('../../tools/tools/select-tool.js', import.meta.url), 'utf8');
  assert.match(kies, /const groepLid = e\?\.altKey && !!clickedAnnotation\.groupId;/);
  assert.match(kies, /expandToGroups\(doc\.annotations, selected\)/);
  const menu = readFileSync(new URL('../../solid/components/ContextMenu.jsx', import.meta.url), 'utf8');
  assert.match(menu, /runCommand\('edit\.group', \{ dominant: targetAnnotation\(\) \}\)/);
  assert.match(menu, /edit\.removeGroupNesting/);
  assert.equal((menu.match(/<SubjectMenuItem /g) || []).length, 2, 'Subject… on one markup and on a selection');
});

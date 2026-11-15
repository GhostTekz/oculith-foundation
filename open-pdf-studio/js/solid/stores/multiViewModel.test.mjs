// MultiView pane model (docs/reference/editor/workspace.md): split duplicates the active tab,
// unsplit keeps the live pane, tabs move between splits, closed documents
// leave the panes, and Sync remembers its mode and page offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from './multiViewModel.js';

const view = (page, scale = 1, scrollLeft = 0, scrollTop = 0) => ({ page, scale, scrollLeft, scrollTop });
const splitAB = (orientation = 'vertical') => M.split(M.createMultiView(), orientation, {
  docIds: ['a', 'b'], activeDocId: 'b', view: view(2, 1.5, 10, 20),
});

test('unsplit by default; split duplicates the active tab into the second split', () => {
  const mv = M.createMultiView();
  assert.equal(M.isSplit(mv), false);
  assert.equal(M.otherPane(mv), -1);
  const s = splitAB();
  assert.equal(M.isSplit(s), true);
  assert.equal(s.orientation, 'vertical');
  assert.equal(s.activePane, 0, 'the first split keeps the live view');
  assert.equal(M.otherPane(s), 1);
  assert.deepEqual(s.panes[0].docIds, ['a', 'b']);
  assert.deepEqual(s.panes[1].docIds, ['b']);
  assert.equal(s.panes[0].activeDocId, 'b');
  assert.equal(s.panes[1].activeDocId, 'b');
  assert.deepEqual(M.paneView(s, 1, 'b'), view(2, 1.5, 10, 20), 'both splits start from the live view');
  assert.notEqual(s.panes[0].views, s.panes[1].views, 'views are per split');
});

test('split needs an open active document and a known orientation', () => {
  const mv = M.createMultiView();
  assert.equal(M.split(mv, 'vertical', { docIds: [], activeDocId: null }), mv);
  assert.equal(M.split(mv, 'diagonal', { docIds: ['a'], activeDocId: 'a' }), mv);
  assert.equal(M.split(mv, 'vertical', { docIds: ['a'], activeDocId: 'x' }), mv);
});

test('splitting again changes only the orientation; Toggle Split flips it', () => {
  const s = splitAB('vertical');
  const h = M.split(s, 'horizontal', { docIds: ['a', 'b', 'c'], activeDocId: 'a' });
  assert.equal(h.orientation, 'horizontal');
  assert.deepEqual(h.panes, s.panes);
  assert.equal(M.split(h, 'horizontal', {}), h, 'no change');
  assert.equal(M.toggleOrientation(h).orientation, 'vertical');
  assert.equal(M.toggleOrientation(M.createMultiView()).orientation, null);
});

test('unsplit drops the panes and turns Sync off', () => {
  let s = M.setSync(splitAB(), { enabled: true, mode: 'page', pageOffset: 1 });
  s = M.unsplit(s);
  assert.equal(M.isSplit(s), false);
  assert.deepEqual(s.panes, []);
  assert.equal(s.sync.enabled, false);
  assert.equal(s.sync.mode, 'page', 'the mode is remembered');
  assert.equal(M.unsplit(s), s);
});

test('active pane: only an existing split can become active', () => {
  const s = splitAB();
  assert.equal(M.setActivePane(s, 1).activePane, 1);
  assert.equal(M.setActivePane(s, 0), s);
  assert.equal(M.setActivePane(s, 2), s);
  assert.equal(M.setActivePane(M.createMultiView(), 1).activePane, 0);
});

test('pane views are stored per split and document, and sanitised', () => {
  let s = M.setPaneView(splitAB(), 1, 'b', { page: 3, scale: 2, scrollLeft: -5, scrollTop: 40 });
  assert.deepEqual(M.paneView(s, 1, 'b'), view(3, 2, 0, 40));
  assert.deepEqual(M.paneView(s, 0, 'b'), view(2, 1.5, 10, 20), 'the other split is untouched');
  s = M.setPaneView(s, 0, 'a', { page: 0, scale: -1 });
  assert.deepEqual(M.paneView(s, 0, 'a'), view(1, 1, 0, 0));
  assert.equal(M.setPaneView(s, 5, 'a', view(1)), s);
});

test('a tab click in a split shows that document there (adding the tab)', () => {
  const s = M.showInPane(splitAB(), 1, 'a');
  assert.deepEqual(s.panes[1].docIds, ['b', 'a']);
  assert.equal(s.panes[1].activeDocId, 'a');
  assert.equal(M.showInPane(s, 1, 'a').panes[1].docIds.length, 2, 'no duplicate tab');
});

test('move a tab to the other split: the target shows it and becomes active', () => {
  let s = M.setPaneView(splitAB(), 0, 'a', view(3));
  s = M.moveDocToPane(s, 'a', 0, 1);
  assert.deepEqual(s.panes[0].docIds, ['b']);
  assert.deepEqual(s.panes[1].docIds, ['b', 'a']);
  assert.equal(s.panes[1].activeDocId, 'a');
  assert.equal(s.activePane, 1);
  assert.deepEqual(M.paneView(s, 1, 'a'), view(3), 'its view travels with it');
  assert.equal(M.paneView(s, 0, 'a'), null);
  // Drop position.
  const t = M.moveDocToPane(splitAB(), 'a', 0, 1, { index: 0 });
  assert.deepEqual(t.panes[1].docIds, ['a', 'b']);
  // Not in the source, same split, or unsplit: no change.
  assert.equal(M.moveDocToPane(s, 'zzz', 0, 1), s);
  assert.equal(M.moveDocToPane(s, 'b', 0, 0), s);
  assert.equal(M.moveDocToPane(M.createMultiView(), 'a', 0, 1).panes.length, 0);
});

test('moving the only tab of a split leaves one pane', () => {
  const s = M.moveDocToPane(splitAB(), 'b', 1, 0);
  assert.equal(M.isSplit(s), false);
});

test('the active tab of a split moves to its neighbour when removed', () => {
  let s = M.split(M.createMultiView(), 'vertical', { docIds: ['a', 'b', 'c'], activeDocId: 'b' });
  s = M.removeFromPane(s, 0, 'b');
  assert.deepEqual(s.panes[0].docIds, ['a', 'c']);
  assert.equal(s.panes[0].activeDocId, 'c');
  s = M.removeFromPane(s, 0, 'a');
  assert.equal(s.panes[0].activeDocId, 'c', 'another tab: the active one stays');
});

test('reconcile: closed documents leave, new ones join the active split', () => {
  let s = M.setActivePane(splitAB(), 1);
  s = M.reconcile(s, ['a', 'b', 'c'], 'c');
  assert.deepEqual(s.panes[1].docIds, ['b', 'c'], 'opened in the active split');
  assert.equal(s.panes[1].activeDocId, 'c');
  assert.deepEqual(s.panes[0].docIds, ['a', 'b']);
  s = M.reconcile(s, ['b', 'c'], 'c');
  assert.deepEqual(s.panes[0].docIds, ['b'], 'a closed');
  // Closing the last document of a split unsplits.
  const u = M.reconcile(s, ['c'], 'c');
  assert.equal(M.isSplit(u), false);
  assert.equal(M.reconcile(M.createMultiView(), ['a'], 'a').orientation, null);
  // Nothing changed: same object.
  assert.equal(M.reconcile(s, ['b', 'c'], 'c'), s);
});

test('Sync: on/off, the external editor modes, page offset kept', () => {
  let s = splitAB();
  assert.deepEqual(s.sync, { enabled: false, mode: 'document', pageOffset: 0 });
  s = M.setSync(s, { enabled: true });
  assert.equal(s.sync.enabled, true);
  s = M.setSync(s, { mode: 'page', pageOffset: 2 });
  assert.deepEqual(s.sync, { enabled: true, mode: 'page', pageOffset: 2 });
  assert.equal(M.setSync(s, { mode: 'bogus' }).sync.mode, 'page');
  assert.equal(M.setSync(s, {}), s);
  assert.deepEqual(M.SYNC_MODES, ['document', 'page']);
  assert.equal(M.MAX_PANES, 2);
});

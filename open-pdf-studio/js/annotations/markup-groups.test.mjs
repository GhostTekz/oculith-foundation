// Markup groups (docs/reference/editor/markups-list.md): the external editor's Group, Ungroup, nesting,
// Remove Selected from Group, Remove Group Nesting, totals and category eyes
// on the plain model.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupMarkups, ungroupMarkups, removeFromGroup, removeGroupNesting, renameGroup, groupPathOf,
  membersOfGroup, expandToGroups, addToGroup, relinkCopiedGroups, groupTotals, groupTotalsText,
  categoryEyeState, toggleCategoryHidden, correctionGroupIds, DEFAULT_GROUP_NAME,
} from './markup-groups.js';

const box = (id, extra = {}) => ({ id, type: 'box', page: 1, ...extra });
const ids = (list) => list.map((a) => a.id).sort();
const pad = (a) => groupPathOf(a).map((g) => g.id);

test('Group: one level, named "Group", the first selected is dominant', () => {
  const [a, b, c] = [box('a'), box('b'), box('c')];
  const all = [a, b, c];
  const r = groupMarkups(all, [b, a], { id: 'g1' });
  assert.deepEqual(ids(r.changed), ['a', 'b']);
  assert.equal(a.groupId, 'g1');
  assert.deepEqual(a.groupPath, [{ id: 'g1', name: DEFAULT_GROUP_NAME, dominant: 'b' }]);
  assert.equal(c.groupId, undefined);
  assert.equal(groupMarkups(all, [c]), null, 'one unit is no group');
  // The dominant can be the right-clicked markup.
  const [d, e] = [box('d'), box('e')];
  groupMarkups([d, e], [d, e], { id: 'g2', dominant: e });
  assert.equal(d.groupPath[0].dominant, 'e');
});

test('locked markups are not grouped', () => {
  const [a, b] = [box('a'), box('b', { locked: true })];
  assert.equal(groupMarkups([a, b], [a, b]), null);
  assert.equal(a.groupId, undefined);
});

test('grouping groups nests them; ungroup removes one level at a time', () => {
  const m = ['a', 'b', 'c', 'd', 'e'].map((id) => box(id));
  const [a, b, c, d, e] = m;
  groupMarkups(m, [a, b], { id: 'g1' });
  groupMarkups(m, [c, d], { id: 'g2' });
  // Selecting one member of each group groups the whole groups.
  const r = groupMarkups(m, [a, c, e], { id: 'top' });
  assert.deepEqual(ids(r.changed), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pad(b), ['top', 'g1']);
  assert.deepEqual(pad(d), ['top', 'g2']);
  assert.deepEqual(pad(e), ['top']);
  assert.deepEqual(ids(membersOfGroup(m, 'g2')), ['c', 'd']);
  assert.deepEqual(ids(expandToGroups(m, [b])), ['a', 'b', 'c', 'd', 'e']);
  ungroupMarkups(m, [e]);
  assert.deepEqual([pad(a), pad(c), pad(e)], [['g1'], ['g2'], []]);
  assert.equal(e.groupId, undefined);
  assert.equal('groupPath' in e, false, 'no empty key left behind');
});

test('loose markups grouped with a nested group join its top level', () => {
  const m = ['a', 'b', 'c', 'd', 'x'].map((id) => box(id));
  const [a, b, c, d, x] = m;
  groupMarkups(m, [a, b], { id: 'g1' });
  groupMarkups(m, [a, c, d], { id: 'top' });
  const r = groupMarkups(m, [x, a]);
  assert.equal(r.groupId, 'top');
  assert.deepEqual(pad(x), ['top']);
  assert.deepEqual(pad(a), ['top', 'g1'], 'the nesting stays');
});

test('Remove Selected from Group, at any depth; a subgroup keeps its nesting', () => {
  const m = ['a', 'b', 'c', 'd', 'e'].map((id) => box(id));
  const [a, b, c, d, e] = m;
  groupMarkups(m, [a, b, c], { id: 'g1' });
  groupMarkups(m, [a, d, e], { id: 'top' });
  removeFromGroup(m, [b]);
  assert.deepEqual(pad(b), []);
  assert.deepEqual(pad(a), ['top', 'g1']);
  // The subgroup leaves the top group with its own level.
  removeFromGroup(m, [], { groupIds: ['g1'] });
  assert.deepEqual([pad(a), pad(c)], [['g1'], ['g1']]);
  assert.deepEqual([pad(d), pad(e)], [['top'], ['top']]);
  // A group left with one markup dissolves.
  removeFromGroup(m, [d]);
  assert.deepEqual([pad(d), pad(e)], [[], []]);
});

test('a group whose dominant leaves gets a new dominant', () => {
  const m = ['a', 'b', 'c'].map((id) => box(id));
  groupMarkups(m, m, { id: 'g' });
  removeFromGroup(m, [m[0]]);
  assert.equal(m[1].groupPath[0].dominant, 'b');
});

test('Remove Group Nesting flattens to one group; rename sets the Subject', () => {
  const m = ['a', 'b', 'c', 'd'].map((id) => box(id));
  groupMarkups(m, [m[0], m[1]], { id: 'g1' });
  groupMarkups(m, [m[0], m[2], m[3]], { id: 'top', name: 'Zone 1' });
  removeGroupNesting(m, 'top');
  assert.ok(m.every((a) => pad(a).join() === 'top'));
  assert.equal(removeGroupNesting(m, 'top'), null, 'nothing nested any more');
  // A nested group flattens below itself.
  const n = ['p', 'q', 'r', 's', 't'].map((id) => box(id));
  groupMarkups(n, [n[0], n[1]], { id: 'i1' });
  groupMarkups(n, [n[0], n[2]], { id: 'mid' });
  groupMarkups(n, [n[3], n[4]], { id: 'j' });
  groupMarkups(n, [n[0], n[3]], { id: 'out' });
  assert.deepEqual(pad(n[0]), ['out', 'mid', 'i1']);
  removeGroupNesting(n, 'mid');
  assert.deepEqual(n.map(pad), [['out', 'mid'], ['out', 'mid'], ['out', 'mid'], ['out', 'j'], ['out', 'j']]);
  renameGroup(m, 'top', '  Feeder A ');
  assert.ok(m.every((a) => a.groupPath[0].name === 'Feeder A'));
  assert.equal(renameGroup(m, 'top', '   '), null);
});

test('a collection without groupPath and a replacement pair', () => {
  const oud = [box('a', { groupId: 'old' }), box('b', { groupId: 'old' })];
  assert.deepEqual(groupPathOf(oud[0]), [{ id: 'old', name: '', dominant: null }]);
  const caret = { id: 'k', type: 'caret', intent: 'Replace', groupId: 'k' };
  const strike = { id: 's', type: 'textStrikethrough', inReplyTo: 'k', replyType: 'group', groupId: 'k' };
  const all = [...oud, caret, strike];
  const cg = correctionGroupIds(all);
  assert.deepEqual(groupPathOf(caret, cg), [], 'a correction is no markup group');
  // A replacement inside a group gets its own pair link back on ungroup.
  groupMarkups(all, [oud[0], caret], { id: 'g' });
  assert.equal(strike.groupId, 'k', 'the strike is not a separate member');
  ungroupMarkups(all, [caret]);
  assert.equal(caret.groupId, 'k');
  assert.equal(oud[0].groupId, 'old', 'the inner collection stays');
});

test('copies: a whole group gets a new id, a lone member leaves the group', () => {
  const m = ['a', 'b', 'c'].map((id) => box(id));
  groupMarkups(m, m, { id: 'g', name: 'Zone 2' });
  const kopie = m.map((a) => ({ ...structuredClone(a), id: `${a.id}2` }));
  relinkCopiedGroups(m, kopie, { newId: () => 'nieuw' });
  assert.ok(kopie.every((a) => a.groupId === 'nieuw' && a.groupPath[0].name === 'Zone 2'));
  assert.equal(kopie[1].groupPath[0].dominant, 'a2');
  const los = [{ ...structuredClone(m[1]), id: 'b3' }];
  relinkCopiedGroups([m[1]], los);
  assert.equal(los[0].groupId, undefined);
  assert.equal('groupPath' in los[0], false);
});

test('group totals: the sum when every member has the measure, else blank', () => {
  const len = (v) => ({ type: 'measureDistance', measureValue: v, measureUnit: 'ft' });
  assert.deepEqual(groupTotals([len(2), len(3.5)]).length, { value: 5.5, unit: 'ft' });
  assert.equal(groupTotals([len(2), box('x')]).length, null);
  assert.equal(groupTotals([len(2), { ...len(1), measureUnit: 'm' }]).length, null, 'mixed units');
  assert.equal(groupTotals([{ type: 'count' }, { type: 'count' }]).count, 2);
  assert.equal(groupTotalsText(groupTotals([len(2), len(3)])), 'Length 5 ft');
  assert.equal(groupTotalsText(groupTotals([box('x')])), '');
});

test('category eye: shown, hidden, mixed; a click shows all unless all are shown', () => {
  const m = ['a', 'b', 'c'].map((id) => box(id));
  assert.equal(categoryEyeState(m), 'shown');
  let r = toggleCategoryHidden(m);
  assert.equal(r.hidden, true);
  assert.ok(m.every((a) => a.hidden === true));
  assert.equal(categoryEyeState(m), 'hidden');
  delete m[0].hidden;
  assert.equal(categoryEyeState(m), 'mixed');
  r = toggleCategoryHidden(m);
  assert.equal(r.hidden, false, 'mixed: show all');
  assert.deepEqual(ids(r.changed), ['b', 'c']);
  assert.ok(m.every((a) => !('hidden' in a)));
  // A markup its layer hides keeps its own flag and does not count.
  const opLaag = (a) => a.id === 'c';
  m[2].hidden = true;
  assert.equal(categoryEyeState(m, opLaag), 'shown');
  toggleCategoryHidden(m, opLaag);
  assert.deepEqual(m.map((a) => !!a.hidden), [true, true, true]);
  toggleCategoryHidden(m, opLaag);
  assert.deepEqual(m.map((a) => !!a.hidden), [false, false, true], 'the layer-hidden flag is kept');
  assert.equal(categoryEyeState([m[2]], opLaag), 'layer');
});

test('add to a group: dropped markups join that level and leave their old group', () => {
  const m = ['a', 'b', 'c', 'd', 'x', 'y'].map((id) => box(id));
  const [a, b, c, d, x, y] = m;
  groupMarkups(m, [a, b], { id: 'g1' });
  groupMarkups(m, [a, c], { id: 'top' });
  groupMarkups(m, [d, y], { id: 'old' });
  addToGroup(m, [x, y], 'g1');
  assert.deepEqual([pad(x), pad(y)], [['top', 'g1'], ['top', 'g1']]);
  assert.deepEqual(pad(d), [], 'a group left with one markup dissolves');
  assert.equal(addToGroup(m, [a], 'g1'), null, 'already in it');
});

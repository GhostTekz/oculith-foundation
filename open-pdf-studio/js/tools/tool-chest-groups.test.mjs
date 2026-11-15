// Loose markups captured as one group tool (docs/reference/editor/tool-chest.md).
// Bounds and move stay local; do not import geometry.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureGroupTool, placeGroupTool } from './tool-chest-groups.js';

const bounds = (annotation) => ({ x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height });
const move = (annotation, dx, dy) => {
  annotation.x += dx;
  annotation.y += dy;
};
const gap = (left, right) => right.x - (left.x + left.width);

test('two loose markups 10pt apart place as one new group still 10pt apart', () => {
  const left = { id: 'old-left', type: 'box', page: 2, x: 100, y: 40, width: 20, height: 10, strokeColor: '#111111' };
  const right = { id: 'old-right', type: 'box', page: 2, x: 130, y: 40, width: 20, height: 10, strokeColor: '#222222' };
  assert.equal(left.groupId, undefined);
  assert.equal(right.groupId, undefined);
  assert.equal(gap(left, right), 10);

  const capture = captureGroupTool([left, right], { bounds, move });
  assert.equal(capture.error, undefined);
  assert.equal(gap(capture.members[0], capture.members[1]), 10);

  let n = 0;
  const placed = placeGroupTool(capture, 5, 400, 250, {
    move, makeId: () => `new-${++n}`, now: () => 'now',
  });
  assert.equal(placed.length, 2);
  assert.equal(gap(placed[0], placed[1]), 10);
  assert.equal(placed[0].y, placed[1].y);
  assert.notEqual(placed[0].id, placed[1].id);
  assert.notEqual(placed[0].id, 'old-left');
  assert.notEqual(placed[1].id, 'old-right');
  assert.equal(placed[0].groupId, placed[1].groupId);
  assert.ok(placed[0].groupId);
  assert.equal(left.groupId, undefined);
  assert.equal(right.id, 'old-right');
});

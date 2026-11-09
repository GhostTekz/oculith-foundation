// A popped-out panel's window opens where it was last (any screen), at the
// default size the first time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { popoutFeatures } from './panel-popout.js';

test('the window opens at its remembered place, or the default size', () => {
  assert.equal(popoutFeatures(null), 'popup,width=900,height=640');
  assert.equal(popoutFeatures({ width: 1210.4, height: 800, left: -1920, top: 40 }), 'popup,width=1210,height=800,left=-1920,top=40');
  assert.equal(popoutFeatures({ width: 700, height: 500 }), 'popup,width=700,height=500');
});

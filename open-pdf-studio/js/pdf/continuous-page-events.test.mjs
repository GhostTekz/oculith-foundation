import assert from 'node:assert/strict';
import test from 'node:test';
import { bindContinuousPageEvents, pagePointerTarget } from './continuous-page-events.js';

function classList(...names) { return { contains: (n) => names.includes(n) }; }

function fakeContainer() {
  const listeners = {};
  const cc = {
    canvas: null,
    querySelector: (sel) => (sel === '.annotation-canvas' ? cc.canvas : null),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type, e) => (listeners[type] || []).forEach((fn) => fn(e)),
    listeners,
  };
  return cc;
}

function newCanvas() { return { style: {}, classList: classList('annotation-canvas') }; }

const noop = () => {};

test('a page released and rendered again keeps one set of pointer listeners', () => {
  const cc = fakeContainer();
  let downs = 0;
  const handlers = { handlePointerDown: () => { downs++; }, handlePointerMove: noop, handlePointerUp: noop, handleDblClick: noop };
  cc.canvas = newCanvas();
  assert.equal(bindContinuousPageEvents(cc, handlers), true);
  // Release removes the canvases but keeps the container; the page returns.
  cc.canvas = null;
  cc.canvas = newCanvas();
  assert.equal(bindContinuousPageEvents(cc, handlers), false);
  assert.equal(cc.listeners.pointerdown.length, 1);
  cc.fire('pointerdown', { target: cc.canvas });
  assert.equal(downs, 1);
});

test('the filter reads the current canvas, not the one present at bind time', () => {
  const cc = fakeContainer();
  const first = newCanvas();
  cc.canvas = first;
  const seen = [];
  bindContinuousPageEvents(cc, { handlePointerDown: (e) => seen.push(e.target), handlePointerMove: noop, handlePointerUp: noop, handleDblClick: noop });
  const second = newCanvas();
  cc.canvas = second;
  first.style.pointerEvents = 'none';
  cc.fire('pointerdown', { target: second });
  assert.deepEqual(seen, [second]);
  second.style.pointerEvents = 'none';
  cc.fire('pointerdown', { target: second });
  assert.equal(seen.length, 1);
});

test('a released page (no canvas) and overlay layers are ignored', () => {
  const cc = fakeContainer();
  assert.equal(pagePointerTarget(cc, { target: cc }), false);
  cc.canvas = newCanvas();
  assert.equal(pagePointerTarget(cc, { target: cc }), true);
  assert.equal(pagePointerTarget(cc, { target: { classList: classList('pdf-canvas') } }), true);
  assert.equal(pagePointerTarget(cc, { target: { classList: classList('textLayer') } }), false);
});

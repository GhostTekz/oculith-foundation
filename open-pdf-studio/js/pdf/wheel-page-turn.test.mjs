import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeWheelPageTurn, wheelPageMode, clampWheelPan, WHEEL_GESTURE_GAP_MS,
} from './wheel-page-turn.js';
import { DEFAULT_PREFERENCES } from '../core/constants.ts';

const fit = { atTop: true, atBottom: true };
const at = (o) => ({ mode: 'edge', single: true, dx: 0, dy: 100, page: 5, numPages: 10, now: 0, ...fit, ...o });

test('the default is never: the wheel does not change the page', () => {
  assert.equal(DEFAULT_PREFERENCES.wheelChangesPage, 'never');
  assert.equal(wheelPageMode(DEFAULT_PREFERENCES), 'never');
  assert.equal(wheelPageMode({}), 'never');
  assert.equal(wheelPageMode(null), 'never');
  assert.equal(wheelPageMode({ wheelChangesPage: 'nonsense' }), 'never');
  assert.equal(wheelPageMode({ wheelChangesPage: 'edge' }), 'edge');
});

test('never: no notch, burst or touchpad stream at a page edge turns the page', () => {
  const turn = makeWheelPageTurn();
  let t = 0;
  for (const dy of [-100, 100, ...Array(20).fill(100), ...Array(60).fill(-3), ...Array(60).fill(4)]) {
    assert.equal(turn.decide(at({ mode: 'never', dy, now: t += 16 })), 0);
  }
  // Also after long pauses (every event a new gesture).
  for (const dy of [100, -100]) {
    t += 1000;
    assert.equal(turn.decide(at({ mode: 'never', dy, now: t })), 0);
  }
});

test('edge: one notch at the page edge turns one page each way', () => {
  const turn = makeWheelPageTurn();
  assert.equal(turn.decide(at({ dy: 100, now: 0 })), 1);
  assert.equal(turn.decide(at({ dy: -100, now: 1000 })), -1);
});

test('edge: a burst or a touchpad fling turns at most one page', () => {
  const turn = makeWheelPageTurn();
  let t = 0;
  const steps = [];
  for (let i = 0; i < 10; i++) steps.push(turn.decide(at({ dy: 100, now: t += 40 })));
  assert.deepEqual(steps.filter(Boolean), [1]);
  t += 1000;
  const fling = [];
  for (let v = 4; v < 40; v += 2) fling.push(turn.decide(at({ dy: -v, now: t += 8 })));
  for (let v = 40; v >= 1; v = Math.floor(v * 0.9)) fling.push(turn.decide(at({ dy: -v, now: t += 16 })));
  assert.deepEqual(fling.filter(Boolean), [-1]);
});

test('edge: scrolling to the bottom of a zoomed page stops there; the next gesture turns', () => {
  const turn = makeWheelPageTurn();
  let t = 0;
  // Scrolling down a tall page: the bottom comes into view mid-gesture.
  for (let i = 0; i < 5; i++) assert.equal(turn.decide(at({ atTop: false, atBottom: false, now: t += 16 })), 0);
  for (let i = 0; i < 20; i++) assert.equal(turn.decide(at({ atTop: false, atBottom: true, now: t += 16 })), 0);
  // A pause, then a new gesture at the bottom.
  t += WHEEL_GESTURE_GAP_MS + 1;
  assert.equal(turn.decide(at({ atTop: false, atBottom: true, now: t })), 1);
});

test('edge: scrolling up away from the bottom never turns back', () => {
  const turn = makeWheelPageTurn();
  assert.equal(turn.decide(at({ dy: -100, atTop: false, atBottom: true, now: 0 })), 0);
});

test('edge: no turn past the first or last page, sideways, or outside the single-page view', () => {
  const turn = makeWheelPageTurn();
  let t = 0;
  const next = () => (t += 1000);
  assert.equal(turn.decide(at({ dy: -100, page: 1, now: next() })), 0);
  assert.equal(turn.decide(at({ dy: 100, page: 10, now: next() })), 0);
  assert.equal(turn.decide(at({ dx: 120, dy: 100, now: next() })), 0);
  assert.equal(turn.decide(at({ dy: 0, now: next() })), 0);
  assert.equal(turn.decide(at({ single: false, now: next() })), 0);
});

test('edge: wheel events that waited behind the page render still belong to the turning gesture', () => {
  const turn = makeWheelPageTurn();
  assert.equal(turn.decide(at({ now: 0 })), 1);
  turn.turnDone(900); // a heavy page took 900 ms to draw
  assert.equal(turn.decide(at({ now: 950 })), 0);
  assert.equal(turn.decide(at({ now: 950 + WHEEL_GESTURE_GAP_MS + 1 })), 1, 'a new gesture after a pause turns');
});

test('reset forgets the gesture', () => {
  const turn = makeWheelPageTurn();
  assert.equal(turn.decide(at({ now: 0 })), 1);
  assert.equal(turn.decide(at({ now: 10 })), 0);
  turn.reset();
  assert.equal(turn.decide(at({ now: 20 })), 1);
});

test('clampWheelPan: a fitting page does not move', () => {
  const page = { pageLeft: 100, pageTop: 20, pageWidth: 600, pageHeight: 760, viewWidth: 800, viewHeight: 800 };
  assert.deepEqual(clampWheelPan({ dx: 50, dy: -100, ...page }), { dx: 0, dy: 0 });
});

test('clampWheelPan: a zoomed page scrolls inside and stops at its edges', () => {
  const view = { viewWidth: 800, viewHeight: 600 };
  // Page 2000 tall with its top at the window top.
  assert.deepEqual(clampWheelPan({ dx: 0, dy: 100, pageLeft: -100, pageTop: 0, pageWidth: 1000, pageHeight: 2000, ...view }),
    { dx: 0, dy: 100 });
  assert.deepEqual(clampWheelPan({ dx: 0, dy: -100, pageLeft: -100, pageTop: 0, pageWidth: 1000, pageHeight: 2000, ...view }),
    { dx: 0, dy: 0 });
  // 30 px from the top: a notch up moves only those 30 px.
  assert.deepEqual(clampWheelPan({ dx: 0, dy: -100, pageLeft: 0, pageTop: -30, pageWidth: 1000, pageHeight: 2000, ...view }),
    { dx: 0, dy: -30 });
  // 40 px above the bottom.
  assert.deepEqual(clampWheelPan({ dx: 0, dy: 100, pageLeft: 0, pageTop: -1360, pageWidth: 1000, pageHeight: 2000, ...view }),
    { dx: 0, dy: 40 });
  // Sideways: right edge 50 px out.
  assert.deepEqual(clampWheelPan({ dx: 120, dy: 0, pageLeft: -150, pageTop: 0, pageWidth: 1000, pageHeight: 2000, ...view }),
    { dx: 50, dy: 0 });
});

test('clampWheelPan: a page past an edge is not pulled back, only kept from going further', () => {
  const page = { pageLeft: 0, pageTop: 80, pageWidth: 1000, pageHeight: 2000, viewWidth: 800, viewHeight: 600 };
  assert.deepEqual(clampWheelPan({ dx: 0, dy: -100, ...page }), { dx: 0, dy: 0 });
  assert.deepEqual(clampWheelPan({ dx: 0, dy: 100, ...page }), { dx: 0, dy: 100 });
});

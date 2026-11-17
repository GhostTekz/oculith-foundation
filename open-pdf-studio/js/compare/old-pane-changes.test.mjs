import assert from 'node:assert/strict';
import test from 'node:test';
import { changesOnOldPane } from './old-pane-changes.js';

// The detector's canvas transform (compare-viewport.js runChangeDetection):
// OLD drawn at translate(dx, dy) · rotate about the NEW canvas centre, all in
// detection pixels, with dx/dy given at the 1.5 base scale.
function detectorPlacesOld(p, offset, canvas, detectScale) {
  const f = detectScale / 1.5;
  const rad = (offset.rotation || 0) * Math.PI / 180;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const x = p.x - cx;
  const y = p.y - cy;
  return {
    x: Math.cos(rad) * x - Math.sin(rad) * y + cx + (offset.dx || 0) * f,
    y: Math.sin(rad) * x + Math.cos(rad) * y + cy + (offset.dy || 0) * f,
  };
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('without an alignment the old pane shows the boxes as detected', () => {
  const changes = [{ type: 'removed', x: 10, y: 20, width: 5, height: 5, detectScale: 1 }];
  assert.equal(changesOnOldPane(changes, { dx: 0, dy: 0, rotation: 0 }, { width: 100, height: 50 }), changes);
});

test('a shifted and rotated alignment maps a box back onto the old content', () => {
  const detectScale = 0.8;
  const sizePt = { width: 400, height: 300 };
  const canvas = { width: sizePt.width * detectScale, height: sizePt.height * detectScale };
  for (const offset of [{ dx: 30, dy: -12, rotation: 0 }, { dx: 30, dy: -12, rotation: 90 }, { dx: -7, dy: 4, rotation: 17 }]) {
    const oldPoint = { x: 70, y: 40 };
    const onNew = detectorPlacesOld(oldPoint, offset, canvas, detectScale);
    const [box] = changesOnOldPane([{ type: 'modified', x: onNew.x, y: onNew.y, width: 0, height: 0, detectScale }],
      offset, sizePt);
    near(box.x, oldPoint.x);
    near(box.y, oldPoint.y);
    near(box.width, 0);
    near(box.height, 0);
    assert.equal(box.type, 'modified');
  }
});

test('a rotated box becomes the bounding box of its mapped corners', () => {
  const [box] = changesOnOldPane([{ x: 100, y: 100, width: 20, height: 10, detectScale: 1 }],
    { rotation: 90 }, { width: 400, height: 400 });
  near(box.width, 10);
  near(box.height, 20);
});

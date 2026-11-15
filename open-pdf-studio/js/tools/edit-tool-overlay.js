// Live overlay of the Lasso and Offset tools (docs/reference/editor/markup-tools.md): the lasso
// path while it is drawn and the offset preview before the side click.
// rendering.js draws it in the overlay pass (next to the rubber band), so a
// redraw never wipes it. No imports: rendering.js loads this module.
//
// Coordinates are page coordinates; the render context is already in page
// space, so line widths and dashes are divided by the effective scale.

let _overlay = null; // { kind: 'lasso' | 'offset', page, points, closed, touching? }

export function setEditToolOverlay(overlay) { _overlay = overlay || null; }
export function clearEditToolOverlay() { _overlay = null; }
export function editToolOverlay() { return _overlay; }

export function drawEditToolOverlay(ctx, pageNum, effectiveScale) {
  const o = _overlay;
  if (!o || !ctx || o.page !== pageNum || !Array.isArray(o.points) || o.points.length < 2) return;
  const s = effectiveScale > 0 ? effectiveScale : 1;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(o.points[0].x, o.points[0].y);
  for (let i = 1; i < o.points.length; i++) ctx.lineTo(o.points[i].x, o.points[i].y);
  if (o.closed) ctx.closePath();
  ctx.lineWidth = (o.kind === 'offset' ? 1.5 : 1) / s;
  if (o.kind === 'lasso') {
    // Same colours as the rubber band: blue = enclosed (window), green =
    // touching (crossing, Ctrl).
    ctx.strokeStyle = o.touching ? '#10b981' : '#3b82f6';
    ctx.fillStyle = o.touching ? 'rgba(16, 185, 129, 0.12)' : 'rgba(59, 130, 246, 0.12)';
    ctx.setLineDash(o.touching ? [4 / s, 4 / s] : []);
    ctx.fill();
  } else {
    ctx.strokeStyle = '#f97316';
    ctx.setLineDash([6 / s, 3 / s]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

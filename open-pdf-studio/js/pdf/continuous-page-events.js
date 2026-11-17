// Pointer binding for a continuous-view page container.
//
// A released page keeps its .canvas-container-cont while its canvases are
// removed; when the page comes back new canvases are created in the same
// container. Listeners are therefore bound once per container, and each event
// looks up the container's current annotation canvas instead of holding on to
// the canvas that existed when the listeners were added.

const bound = new WeakSet();

/** Whether this pointer event belongs to the page's drawing surface. */
export function pagePointerTarget(cc, e) {
  const canvas = cc.querySelector?.('.annotation-canvas');
  if (!canvas) return false;
  if ((canvas.style?.pointerEvents || '') === 'none') return false;
  const t = e.target;
  if (t === cc || t === canvas) return true;
  return !!(t?.classList && (t.classList.contains('pdf-canvas') || t.classList.contains('annotation-canvas')));
}

/**
 * Bind the pointer handlers to the container once. Returns true when the
 * listeners were added by this call, false when the container already had them.
 */
export function bindContinuousPageEvents(cc, { handlePointerDown, handlePointerMove, handlePointerUp, handleDblClick }) {
  if (!cc || bound.has(cc)) return false;
  bound.add(cc);
  const wrap = (fn) => (e) => { if (pagePointerTarget(cc, e)) fn(e); };
  cc.addEventListener('pointerdown', wrap(handlePointerDown));
  cc.addEventListener('pointermove', wrap(handlePointerMove));
  cc.addEventListener('pointerup', wrap(handlePointerUp));
  cc.addEventListener('dblclick', wrap(handleDblClick));
  return true;
}

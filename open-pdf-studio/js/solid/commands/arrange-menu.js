// Layout of the markup context menu's Arrange ▸ submenu, and how many selected
// markups each arrange command needs. Pure data (no Solid, no app state) so
// node tests can check it; commands/arrange.js registers the commands.
//
// Every command of the former ribbon Arrange tab is here:
// align, distribute, size, z-order, rotate and reflect.

export const ARRANGE_MENU = Object.freeze([
  Object.freeze({ submenu: 'align', label: 'ribbon:arrange.alignment', items: Object.freeze([
    'arrange.alignLeft', 'arrange.alignCenter', 'arrange.alignRight',
    null,
    'arrange.alignTop', 'arrange.alignMiddle', 'arrange.alignBottom',
  ]) }),
  Object.freeze({ submenu: 'distribute', label: 'ribbon:arrange.distribute', items: Object.freeze([
    'arrange.distributeSpaceH', 'arrange.distributeSpaceV',
    null,
    'arrange.distributeLeft', 'arrange.distributeCenter', 'arrange.distributeRight',
    null,
    'arrange.distributeTop', 'arrange.distributeMiddle', 'arrange.distributeBottom',
  ]) }),
  Object.freeze({ submenu: 'size', label: 'ribbon:arrange.size', items: Object.freeze([
    'arrange.sameSize', 'arrange.sameWidth', 'arrange.sameHeight',
  ]) }),
  null,
  'arrange.bringToFront', 'arrange.bringForward', 'arrange.sendBackward', 'arrange.sendToBack',
  null,
  Object.freeze({ submenu: 'rotate', label: 'ribbon:arrange.rotate', items: Object.freeze([
    'arrange.rotateCcw', 'arrange.rotateCw', 'arrange.rotate180',
  ]) }),
  'arrange.flipHorizontal', 'arrange.flipVertical',
]);

// Minimum number of markups a command acts on (alignment.js returns early
// below these counts: align/size need two, distribute needs three).
export const ARRANGE_MIN_SELECTION = Object.freeze({
  'arrange.alignLeft': 2, 'arrange.alignCenter': 2, 'arrange.alignRight': 2,
  'arrange.alignTop': 2, 'arrange.alignMiddle': 2, 'arrange.alignBottom': 2,
  'arrange.distributeSpaceH': 3, 'arrange.distributeSpaceV': 3,
  'arrange.distributeLeft': 3, 'arrange.distributeCenter': 3, 'arrange.distributeRight': 3,
  'arrange.distributeTop': 3, 'arrange.distributeMiddle': 3, 'arrange.distributeBottom': 3,
  'arrange.sameSize': 2, 'arrange.sameWidth': 2, 'arrange.sameHeight': 2,
  'arrange.bringToFront': 1, 'arrange.bringForward': 1, 'arrange.sendBackward': 1, 'arrange.sendToBack': 1,
  'arrange.rotateCcw': 1, 'arrange.rotateCw': 1, 'arrange.rotate180': 1,
  'arrange.flipHorizontal': 1, 'arrange.flipVertical': 1,
});

/** Every command id the Arrange ▸ submenu lists, in menu order. */
export function arrangeMenuIds(menu = ARRANGE_MENU) {
  const out = [];
  for (const entry of menu) {
    if (!entry) continue;
    if (typeof entry === 'string') out.push(entry);
    else out.push(...arrangeMenuIds(entry.items));
  }
  return out;
}

/** True when `count` selected markups are enough for the command. */
export function arrangeAllowed(id, count) {
  return (Number(count) || 0) >= (ARRANGE_MIN_SELECTION[id] ?? 1);
}

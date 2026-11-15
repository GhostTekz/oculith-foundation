// Edit > Undo History (docs/reference/editor/markup-tools.md): the action name of an undo
// entry. Pure: no app imports. The entry's own `label` (an i18n key under
// common:editTools.history, set by the tool that recorded it) wins; otherwise
// the name follows from the command type.
//
// Returns { action, annotationType, count }: `action` is the key under
// common:editTools.history.*, `annotationType` the markup type when there is
// exactly one kind (the dialog names it with quantities typeName), `count`
// the number of markups.

const ACTIONS = {
  addAnnotation: 'add', deleteAnnotation: 'delete', modifyAnnotation: 'modify',
  bulkAdd: 'add', bulkDelete: 'delete', bulkModify: 'modify',
  clearPage: 'clearPage', clearAll: 'clearAll', reorderAnnotations: 'reorder',
  rotatePage: 'rotatePage', pageStructure: 'pages',
  modifyMeasureScale: 'scale', modifyPageScales: 'scale',
  addTextEdit: 'text', removeTextEdit: 'text', modifyTextEdit: 'text',
  addWatermark: 'watermark', removeWatermark: 'watermark', modifyWatermark: 'watermark',
  addBookmark: 'bookmark', removeBookmark: 'bookmark', modifyBookmark: 'bookmark',
};

function annotationsOf(cmd) {
  if (!cmd) return [];
  if (cmd.annotation) return [cmd.annotation];
  if (cmd.newState && cmd.newState.type) return [cmd.newState];
  if (Array.isArray(cmd.items)) return cmd.items.map((i) => i.annotation || i.newState).filter(Boolean);
  if (Array.isArray(cmd.annotations)) return cmd.annotations;
  return [];
}

function oneType(anns) {
  const types = new Set(anns.map((a) => a && a.type).filter(Boolean));
  return types.size === 1 ? [...types][0] : null;
}

export function undoEntryInfo(cmd) {
  if (!cmd) return { action: 'other', annotationType: null, count: 0 };
  if (cmd.type === 'compound') {
    const inner = (cmd.commands || []).map(undoEntryInfo);
    const actions = new Set(inner.map((i) => i.action));
    const anns = (cmd.commands || []).flatMap(annotationsOf);
    const action = cmd.label || (actions.size === 1 ? [...actions][0] : 'edit');
    return { action, annotationType: oneType(anns), count: anns.length };
  }
  const anns = annotationsOf(cmd);
  return { action: cmd.label || ACTIONS[cmd.type] || 'other', annotationType: oneType(anns), count: anns.length };
}

/**
 * The history rows, oldest first: a start row (the state before the oldest
 * entry, cmd null), the undo stack (done) and the redo stack (undone, shown
 * greyed), each { cmd, done, steps }. `steps` is what clicking the row does:
 * for a done row, the number of undos that take the document back to just
 * after it (0 for the newest, the current state); for an undone row, the
 * number of redos that bring it back.
 */
export function historyRows(undoStack, redoStack) {
  const undo = undoStack || [];
  const redo = redoStack || [];
  const rows = [{ cmd: null, done: true, steps: undo.length, start: true }];
  undo.forEach((cmd, i) => rows.push({ cmd, done: true, steps: undo.length - 1 - i }));
  // The redo stack's top (last) is the next redo: it comes right after the
  // undo stack in time.
  for (let i = redo.length - 1, n = 1; i >= 0; i--, n++) rows.push({ cmd: redo[i], done: false, steps: n });
  return rows;
}

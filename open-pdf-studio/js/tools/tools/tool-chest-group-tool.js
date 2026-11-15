/**
 * Tool Chest group tool (docs/reference/editor/tool-chest.md): a saved group is placed
 * as an exact copy (the external editor: groups are always Drawing Mode), centred on the
 * click, as one new group. The tool stays active for the next placement.
 */
import { getActiveDocument } from '../../core/state.js';
import { recordBulkAdd } from '../../core/undo-manager.js';
import { applyMoveGeneric } from '../../annotations/transforms.js';
import { activeToolPreset, applyActiveGroupToolLayer } from '../tool-chest-presets.js';
import { placeGroupTool } from '../tool-chest-groups.js';
import { defaultIdGenerator } from '../../annotations/paste-in-place.js';

export const toolChestGroupTool = {
  name: 'toolChestGroup',
  cursor: 'copy',
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    ctx.state.isDrawing = true;
  },
  onPointerUp(ctx) {
    const { state } = ctx;
    if (!state.isDrawing) return false;
    state.isDrawing = false;
    const doc = getActiveDocument();
    const preset = activeToolPreset();
    if (!doc || preset?.tool !== 'group') return false;
    const page = ctx.pageNum || doc.currentPage || 1;
    const placed = placeGroupTool(preset, page, state.startX, state.startY,
      { move: applyMoveGeneric, makeId: defaultIdGenerator, author: state.defaultAuthor });
    if (!placed.length) return false;
    // The tool's layer (docs/reference/editor/layers.md) holds the whole new group.
    applyActiveGroupToolLayer(placed, doc);
    doc.annotations.push(...placed);
    recordBulkAdd(placed);
    doc.selectedAnnotations = placed;
    doc.selectedAnnotation = placed[0];
    ctx.redraw();
    return true;
  },
  onDeactivate(ctx) {
    ctx.state.isDrawing = false;
  },
};

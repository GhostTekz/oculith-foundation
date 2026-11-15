// Add to Tool Chest (markup right-click / Properties ▾): one markup, a
// whole group, or a same-page multi-selection, into one or several tool sets
// (docs/reference/editor/tool-chest.md). Rules: tools/tool-chest-groups.js; data:
// tools/tool-chest-presets.js.

import { getActiveDocument } from '../../core/state.js';
import { getAnnotationBounds } from '../../core/stores/selection-helpers.js';
import { applyMoveGeneric } from '../../annotations/transforms.js';
import {
  canSaveToolPreset, saveToolPresetToSets, saveGroupToolPreset, presetToolOf,
} from '../../tools/tool-chest-presets.js';
import {
  addToToolChestBlockReason, captureGroupTool, groupMembersOf,
} from '../../tools/tool-chest-groups.js';
import { countPresetSource } from './countStore.js';
import './toolSetLibrary.js';

/**
 * What Add to Tool Chest would save for this markup:
 * { kind: 'group', members } | { kind: 'markup', annotation } | { kind: 'blocked', reason }.
 */
export function toolChestAddTarget(annotation) {
  if (!annotation) return { kind: 'blocked', reason: 'unsupported' };
  const members = groupMembersOf(annotation, getActiveDocument()?.annotations || []);
  if (members.length >= 2) {
    const blocked = members.map(addToToolChestBlockReason).find(Boolean);
    return blocked ? { kind: 'blocked', reason: blocked } : { kind: 'group', members };
  }
  const reason = addToToolChestBlockReason(annotation);
  if (reason) return { kind: 'blocked', reason };
  return canSaveToolPreset(countPresetSource(annotation))
    ? { kind: 'markup', annotation } : { kind: 'blocked', reason: 'unsupported' };
}

/** The suggested tool name: the markup's subject, else its type. */
export function suggestedToolName(annotation, target = toolChestAddTarget(annotation)) {
  if (target.kind === 'group') return 'Group';
  const subject = typeof annotation?.subject === 'string' ? annotation.subject.trim() : '';
  const tool = presetToolOf(annotation) || 'Tool';
  return (subject || `${tool[0].toUpperCase()}${tool.slice(1)}`).slice(0, 80);
}

/**
 * Save into every set in `setIds`. options: { name, subject, comment,
 * includeTextAndSize, includeCalloutGeometry }. Returns { saved, skipped, error? }.
 */
export function addToToolChest(annotation, setIds, options = {}) {
  const target = toolChestAddTarget(annotation);
  const name = String(options.name || suggestedToolName(annotation, target)).trim();
  if (target.kind === 'blocked') return { saved: [], skipped: setIds || [], error: target.reason };
  if (target.kind === 'group') {
    const capture = captureGroupTool(target.members, { bounds: getAnnotationBounds, move: applyMoveGeneric });
    if (capture.error) return { saved: [], skipped: setIds || [], error: capture.reason || capture.error };
    return saveGroupToolPreset(capture, name, setIds, options);
  }
  return saveToolPresetToSets(countPresetSource(annotation), name, setIds, options);
}

/**
 * A loose multi-selection as one tool: 2+ markups, all on the same page,
 * none blocked. Not an existing group (that path stays addToToolChest).
 * { kind: 'group', members } | { kind: 'blocked', reason }.
 */
export function selectionToolChestTarget(selection) {
  if (!Array.isArray(selection) || selection.length < 2) return { kind: 'blocked', reason: 'unsupported' };
  const page = selection[0]?.page;
  if (selection.some(item => !item || item.page !== page)) return { kind: 'blocked', reason: 'unsupported' };
  const blocked = selection.map(addToToolChestBlockReason).find(Boolean);
  return blocked ? { kind: 'blocked', reason: blocked } : { kind: 'group', members: selection };
}

/**
 * Save the current selection as one group tool (new ids on place). Same
 * options and return shape as addToToolChest.
 */
export function addSelectionToToolChest(selection, setIds, options = {}) {
  const target = selectionToolChestTarget(selection);
  const name = String(options.name || suggestedToolName(selection?.[0], { kind: 'group' })).trim();
  if (target.kind !== 'group') return { saved: [], skipped: setIds || [], error: target.reason };
  const capture = captureGroupTool(target.members, { bounds: getAnnotationBounds, move: applyMoveGeneric });
  if (capture.error) return { saved: [], skipped: setIds || [], error: capture.reason || capture.error };
  return saveGroupToolPreset(capture, name, setIds, options);
}

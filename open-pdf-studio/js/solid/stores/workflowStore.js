// Which workflow tab the workflow toolbar shows (components/WorkflowBar.jsx).
// The tab chosen last is kept in preferences.activeWorkflow; switching
// profile clears it, so the profile's own workflow (workspaceLayout().workflow)
// shows. A contextual tab (Selection, Image) appears while its condition
// holds and is shown only when picked; when it goes away the bar returns to
// the workflow shown before.

import { createSignal } from 'solid-js';
import { state } from '../../core/state.js';
import { savePreferences } from '../../core/preferences.js';
import { workspaceLayout, profileShowsAddOnWorkflows } from './workspaceLayout.js';
import { imageSelected } from './imageEditStore.js';
import { WORKFLOWS, getWorkflow, visibleWorkflowIds } from '../commands/workflows.js';

const [contextualPick, setContextualPick] = createSignal(null);

const activeDoc = () => state.documents?.[state.activeDocumentIndex] || null;

/** Is a markup selected (the Selection contextual tab shows). */
export function hasMarkupSelection() {
  const doc = activeDoc();
  return !!(doc?.selectedAnnotations?.length || doc?.selectedAnnotation);
}

const CONDITIONS = {
  selection: hasMarkupSelection,
  image: () => imageSelected(),
};

/** The workflow tabs the current profile shows (ids, tab order). */
export function shownWorkflowIds() {
  const layout = workspaceLayout();
  return visibleWorkflowIds(layout.workflows, { addOns: profileShowsAddOnWorkflows(layout.profile) });
}

/** The contextual workflow ids whose condition holds now. */
export function contextualWorkflowIds() {
  return WORKFLOWS.filter((wf) => wf.contextual && CONDITIONS[wf.contextual]?.()).map((wf) => wf.id);
}

/** The non-contextual workflow shown (or shown again after a contextual one). */
export function baseWorkflow() {
  const shown = shownWorkflowIds();
  const pick = state.preferences?.activeWorkflow;
  if (pick && shown.includes(pick)) return pick;
  const def = workspaceLayout().workflow;
  if (def && shown.includes(def)) return def;
  return shown[0] || null;
}

/** The workflow id the bar shows now. */
export function activeWorkflow() {
  const ctx = contextualPick();
  if (ctx && contextualWorkflowIds().includes(ctx)) return ctx;
  return baseWorkflow();
}

/** Show a workflow tab; a regular one is remembered in preferences. */
export function setActiveWorkflow(id, { persist = true } = {}) {
  const wf = getWorkflow(id);
  if (!wf) return false;
  if (wf.contextual) {
    setContextualPick(id);
    return true;
  }
  setContextualPick(null);
  if (state.preferences && state.preferences.activeWorkflow !== id) {
    state.preferences.activeWorkflow = id;
    if (persist) savePreferences();
  }
  return true;
}

/** After a profile switch: the profile's own workflow shows. */
export function resetActiveWorkflow({ persist = true } = {}) {
  setContextualPick(null);
  if (state.preferences && state.preferences.activeWorkflow != null) {
    state.preferences.activeWorkflow = null;
    if (persist) savePreferences();
  }
}

/** The workflow tool row is folded away (only the tabs show). */
export function workflowBarCollapsed() {
  return state.preferences?.workflowBarCollapsed === true;
}

export function setWorkflowBarCollapsed(collapsed) {
  if (!state.preferences) return;
  state.preferences.workflowBarCollapsed = !!collapsed;
  savePreferences();
}

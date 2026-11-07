// The workflow toolbar's tabs (components/WorkflowBar.jsx): the commands
// grouped by the job at hand rather than by menu. Each workflow is a tab with
// groups of command-registry ids; a contextual workflow shows only while its
// condition holds (a markup or an image is selected). An edition or add-on
// adds its own workflows (edition.workflows), placed after the workflow its
// `after` names. Pure data plus helpers, so tests read it without the app.
//
// Workflow: { id, label: 'ns:key', icon: <svg>, groups: [{ id, label, items: [commandId…] }],
//             contextual?: 'selection' | 'image', after?: workflowId }
// Unknown ids are skipped when the bar renders (a later package may register
// them), and the coverage test (workflows.test.mjs) names every one.

import { edition } from '../../editions/active.js';
import { lucide } from '../data/lucideIcons.js';

const g = (id, items) => ({ id, label: `common:workflow.groups.${id}`, items });
const w = (id, icon, groups, extra = {}) => ({ id, label: `common:workflow.${id}`, icon: lucide(icon), groups, ...extra });

export const BUILTIN_WORKFLOWS = Object.freeze([
  // Tab order follows the job: open the set, review and mark it up, measure
  // and count, then compare revisions and send the result out.
  w('sheets', 'files', [
    g('set', ['file.open', 'file.openRecent', 'batch.combine', 'file.import', 'view.goToSheet']),
    g('navigate', ['window.panel.thumbnails', 'window.panel.sheets', 'window.panel.bookmarks']),
    g('pages', ['document.insertPages', 'document.extractPages', 'document.deletePages', 'document.reorderPages',
      'document.rotatePagesLeft', 'document.rotatePagesRight']),
    g('prepare', ['document.pageLabels', 'document.crop', 'document.pageSetup', 'document.shiftPage',
      'document.straighten', 'document.ocr']),
    g('links', ['batch.link', 'batch.setLink', 'document.bookmarksFromLabels']),
  ]),
  w('review', 'message-square-text', [
    g('select', ['edit.select', 'edit.pan', 'edit.lasso']),
    g('comment', ['tools.markup.note', 'tools.markup.textBox', 'tools.markup.callout',
      'tools.markup.highlight', 'tools.markup.cloud', 'tools.stamp', 'tools.markup.flag']),
    g('attach', ['edit.snapshot', 'tools.markup.hyperlink', 'tools.markup.attachPhoto', 'tools.markup.fileAttachment']),
    g('find', ['edit.find', 'window.panel.markupsList']),
  ]),
  w('markup', 'pen-tool', [
    g('shapes', ['tools.markup.line', 'tools.markup.arrow', 'tools.markup.polyline', 'tools.markup.rectangle',
      'tools.markup.ellipse', 'tools.markup.polygon', 'tools.markup.arc', 'tools.markup.cloudPolyline']),
    g('freehand', ['tools.markup.pen', 'tools.markup.eraser', 'tools.markup.spline', 'tools.markup.curvedArrow']),
    g('text', ['tools.markup.typewriter', 'tools.markup.textBox', 'tools.markup.callout']),
    g('style', ['edit.formatPainter', 'tools.lineStyles', 'tools.reuse', 'window.panel.toolChest']),
    g('sketch', ['tools.trim', 'tools.extend', 'tools.split', 'tools.break', 'tools.lengthen',
      'tools.array', 'tools.join', 'tools.explode']),
  ]),
  w('measure', 'ruler', [
    g('scale', ['tools.measure.calibrate', 'tools.measure.setScale', 'tools.measure.detectScales', 'tools.measure.addViewport']),
    g('linear', ['tools.measure.length', 'tools.measure.polylength', 'tools.measure.perimeter', 'tools.measure.arcLength']),
    g('area', ['tools.measure.area', 'tools.measure.volume', 'tools.measure.dynamicFill']),
    g('angles', ['tools.measure.angle', 'tools.measure.radius', 'tools.measure.radius3', 'tools.measure.diameter']),
    g('results', ['window.panel.measurements', 'window.panel.quantities', 'tools.quantities']),
  ]),
  // Measure and Takeoff share a few tools on purpose: a profile may show
  // only one of them.
  w('takeoff', 'list-checks', [
    g('count', ['tools.measure.count', 'tools.parametricSymbol', 'tools.visualSearch', 'window.panel.toolChest']),
    g('runs', ['tools.raceway.conduit', 'tools.raceway.cableTray', 'tools.measure.polylength']),
    g('areas', ['window.panel.spaces', 'tools.measure.area', 'tools.measure.dynamicFill']),
    g('results', ['window.panel.quantities', 'tools.quantities']),
  ]),
  // (An edition's workflows go here: after: 'takeoff'.)
  w('compare', 'git-compare-arrows', [
    g('compare', ['document.compare', 'batch.slipSheet', 'window.panel.layers']),
    g('split', ['view.splitVertical', 'view.splitHorizontal', 'view.syncDocument', 'view.syncPage', 'view.unsplit']),
  ]),
  w('output', 'file-output', [
    g('file', ['file.save', 'file.saveAs', 'file.print', 'batch.print']),
    g('export', ['file.export', 'file.exportRaster', 'file.exportCad', 'file.exportIfcReport', 'batch.summary', 'file.email']),
    g('finish', ['document.flatten', 'document.reduceFileSize', 'document.addWatermark', 'document.headerFooter']),
    g('redact', ['edit.redact', 'edit.applyRedactions']),
  ]),
  w('view', 'eye', [
    g('zoom', ['view.fitPage', 'view.fitWidth', 'view.actualSize', 'view.zoomIn', 'view.zoomOut']),
    g('layout', ['view.singlePage', 'view.continuous', 'view.sideBySide', 'view.rotateLeft', 'view.rotateRight']),
    g('display', ['view.darkMode', 'view.dimmer', 'view.thinLines', 'view.readerMode']),
    g('snap', ['view.showGrid', 'view.snapToGrid', 'view.snapToContent', 'view.snapToMarkup']),
    g('window', ['window.hidePanels', 'window.fullScreen']),
  ]),
  // Contextual: only while markups are selected (properties stay inline in
  // the Properties toolbar below).
  w('selection', 'square-dashed-mouse-pointer', [
    g('edit', ['edit.cut', 'edit.copy', 'edit.duplicate', 'edit.delete']),
    g('style', ['format.copyStyle', 'format.pasteStyle', 'edit.formatPainter', 'format.openProperties']),
    g('arrange', ['arrange.bringToFront', 'arrange.sendToBack', 'arrange.alignLeft', 'arrange.alignCenter',
      'arrange.alignTop', 'arrange.alignMiddle', 'arrange.distributeSpaceH', 'arrange.distributeSpaceV']),
    g('group', ['edit.group', 'edit.ungroup', 'arrange.rotateCw', 'arrange.flipHorizontal']),
  ], { contextual: 'selection' }),
  w('image', 'image', [
    g('image', ['format.imageCrop', 'format.imageGrayscale', 'format.imageReset']),
  ], { contextual: 'image' }),
]);

/**
 * The workflows in tab order: the built-in ones with each extra workflow
 * after the one its `after` names (else before the contextual ones). An
 * extra workflow with a taken id is ignored.
 */
export function composeWorkflows(base = BUILTIN_WORKFLOWS, extra = []) {
  const out = [...base];
  for (const wf of extra || []) {
    if (!wf || typeof wf.id !== 'string' || out.some((x) => x.id === wf.id)) continue;
    const after = out.findIndex((x) => x.id === wf.after);
    const firstContextual = out.findIndex((x) => x.contextual);
    const at = after >= 0 ? after + 1 : (firstContextual >= 0 ? firstContextual : out.length);
    out.splice(at, 0, wf);
  }
  return out;
}

export const WORKFLOWS = Object.freeze(composeWorkflows(BUILTIN_WORKFLOWS, edition.workflows || []));
export const WORKFLOW_IDS = Object.freeze(WORKFLOWS.filter((x) => !x.contextual).map((x) => x.id));

export function getWorkflow(id) {
  return WORKFLOWS.find((x) => x.id === id) || null;
}

/**
 * The (non-contextual) workflow tabs a profile shows: `allowed` lists ids,
 * null shows every workflow. An edition's workflows show too, unless the
 * list names workflows of that edition (then only those) or the profile
 * leaves them out (`addOns: false`).
 */
export function visibleWorkflowIds(allowed, { addOns = true } = {}) {
  const extra = WORKFLOW_IDS.filter((id) => !BUILTIN_WORKFLOWS.some((b) => b.id === id));
  if (!Array.isArray(allowed)) return addOns ? [...WORKFLOW_IDS] : WORKFLOW_IDS.filter((id) => !extra.includes(id));
  const namesExtra = allowed.some((id) => extra.includes(id));
  return WORKFLOW_IDS.filter((id) => allowed.includes(id) || (addOns && !namesExtra && extra.includes(id)));
}

/** Every command id a workflow tab can run. */
export function workflowCommandIds(workflows = WORKFLOWS) {
  const ids = new Set();
  for (const wf of workflows) for (const group of wf.groups) for (const id of group.items) ids.add(id);
  return ids;
}

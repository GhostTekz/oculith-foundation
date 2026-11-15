// Tools menu commands (the external editor Tools menu, spec §1.9 and §4.2): Markup ▸,
// Measure ▸, Sketch to Scale ▸ (our CAD drafting edits), Stamp ▸,
// Signature ▸, Quantities, Reuse and Toolbars ▸. Tool commands select a
// canvas tool (setTool); their shortcut text comes from the shortcut table,
// which still binds the single keys.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import {
  textboxIcon, typewriterIcon, noteIcon, calloutIcon, highlightIcon, drawIcon, eraserIcon, cloudIcon,
  cloudPolylineIcon, lineIcon, arrowIcon, splineArrowIcon, polylineIcon, splineIcon, rectIcon, ellipseIcon,
  circleIcon, polygonIcon, arcIcon, lShapeIcon, hatchIcon, flagIcon, hyperlinkIcon, imageIcon, removeImageIcon,
  calibrateIcon, setScaleIcon, detectScalesIcon, addViewportIcon, measureDistanceIcon, polylengthIcon, measureAreaIcon,
  measurePerimeterIcon, measureAngleIcon, volumeIcon, arcLengthIcon, radius3Icon, radiusIcon, diameterIcon,
  countIcon, dynamicFillIcon, conduitIcon, cableTrayIcon, quantitiesIcon, trimIcon, extendIcon, splitIcon, breakIcon, lengthenIcon, joinIcon, explodeIcon,
  arrayIcon, stampIcon, signatureIcon,
} from '../data/ribbonIcons.js';
import { SHORTCUTS, shortcutKeys } from '../../tools/shortcut-table.js';
import { state } from '../../core/state.js';
import { editable, hasPdf, isTool, useTool, lazyModule } from './util.js';
import { isSnapToggleOn, toggleSnapPreference } from '../../tools/snap-toggles.js';
import { isToolbarVisible, setToolbarVisible } from '../stores/workspaceLayout.js';

const scheduleStore = lazyModule(() => import('../stores/scheduleStore.js'));

/** First single binding of the shortcut-table entry that selects `tool`. */
export function toolShortcut(tool) {
  const entry = SHORTCUTS.find((e) => e.tool === tool && !e.builtin && !e.sequence);
  return entry ? shortcutKeys(entry)[0] : null;
}

/** Command id → canvas tool, for every command that only selects a tool. */
export const TOOL_OF_COMMAND = {};

function toolCommand(id, tool, key, icon, category, extra = {}) {
  TOOL_OF_COMMAND[id] = tool;
  registerCommand({
    id, label: `common:commands.tools.${key}`, icon, shortcut: toolShortcut(tool), category,
    enabled: editable, checked: () => isTool(tool), run: () => useTool(tool), ...extra,
  });
}

// --- Markup ▸ ----------------------------------------------------------------------
// [id suffix, tool, icon]; the label key is the id suffix.
const MARKUP_TOOLS = [
  ['textBox', 'textbox', textboxIcon], ['typewriter', 'typewriter', typewriterIcon],
  ['note', 'comment', noteIcon], ['callout', 'callout', calloutIcon], ['highlight', 'highlight', highlightIcon],
  ['pen', 'draw', drawIcon], ['eraser', 'eraser', eraserIcon], ['cloud', 'cloud', cloudIcon],
  ['cloudPolyline', 'cloudPolyline', cloudPolylineIcon], ['line', 'line', lineIcon], ['arrow', 'arrow', arrowIcon],
  ['curvedArrow', 'splineArrow', splineArrowIcon], ['polyline', 'polyline', polylineIcon], ['spline', 'spline', splineIcon],
  ['rectangle', 'box', rectIcon], ['ellipse', 'ellipse', ellipseIcon], ['circle', 'circle', circleIcon],
  ['polygon', 'polygon', polygonIcon], ['arc', 'arc', arcIcon], ['lShape', 'lshape', lShapeIcon],
  ['filledArea', 'filledArea', hatchIcon], ['flag', 'flag', flagIcon], ['hyperlink', 'hyperlink', hyperlinkIcon],
];
for (const [key, tool, icon] of MARKUP_TOOLS) toolCommand(`tools.markup.${key}`, tool, key, icon, 'tools.markup');

registerCommand({
  // The image tool asks for a file first (same as the I key).
  id: 'tools.markup.image', label: 'common:commands.tools.image', icon: imageIcon, shortcut: 'I', category: 'tools.markup',
  enabled: editable, keywords: ['picture', 'photo', 'png'],
  run: () => import('../../annotations/image-drop.js').then((m) => m.pickAndAddImage()),
});
registerCommand({
  id: 'tools.markup.removeImage', label: 'common:commands.tools.removeImage', icon: removeImageIcon, category: 'tools.markup',
  enabled: editable, checked: () => isTool('removeImage'), keywords: ['delete image', 'embedded'],
  run: () => import('../../tools/tools/remove-image-tool.js').then((m) => m.startRemoveImageTool()),
});

// --- Measure ▸ ---------------------------------------------------------------------

toolCommand('tools.measure.calibrate', 'calibrationPick', 'calibrate', calibrateIcon, 'tools.measure',
  { keywords: ['scale', 'known length'] });
registerCommand({
  id: 'tools.measure.setScale', label: 'common:commands.tools.setScale', icon: setScaleIcon, category: 'tools.measure',
  enabled: editable, keywords: ['scale', 'ratio', 'calibrate'],
  run: () => import('../../annotations/measurement.js').then((m) => m.showSetScaleDialog()),
});
registerCommand({
  id: 'tools.measure.detectScales', label: 'common:commands.tools.detectScales', icon: detectScalesIcon,
  category: 'tools.measure', enabled: editable, keywords: ['scale', 'title block', 'viewport', 'detect', 'auto'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('scaleReview', {})),
});
toolCommand('tools.measure.addViewport', 'scaleRegion', 'addViewport', addViewportIcon, 'tools.measure',
  { keywords: ['viewport', 'scale region', 'detail'] });
const MEASURE_TOOLS = [
  ['length', 'measureDistance', measureDistanceIcon], ['polylength', 'measurePolylength', polylengthIcon],
  ['area', 'measureArea', measureAreaIcon], ['perimeter', 'measurePerimeter', measurePerimeterIcon],
  ['angle', 'measureAngle', measureAngleIcon], ['volume', 'measureVolume', volumeIcon],
  ['arcLength', 'measureArc', arcLengthIcon], ['radius3', 'measureRadius3', radius3Icon],
  ['radius', 'radius', radiusIcon], ['diameter', 'diameter', diameterIcon], ['count', 'count', countIcon],
];
for (const [key, tool, icon] of MEASURE_TOOLS) {
  toolCommand(`tools.measure.${key}`, tool, key, icon, 'tools.measure', { keywords: ['measure', 'takeoff'] });
}
// Dynamic Fill (J): paint-bucket fill → Area / Perimeter / Polylength / Polygon.
toolCommand('tools.measure.dynamicFill', 'dynamicFill', 'dynamicFill', dynamicFillIcon, 'tools.measure', {
  keywords: ['measure', 'takeoff', 'paint bucket', 'flood', 'room', 'area', 'auto'],
  run: () => {
    import('../../tools/tools/dynamic-fill-tool.js').then((m) => m.ensureDynamicFillBar()).catch(() => {});
    return useTool('dynamicFill');
  },
});
// --- Raceway ▸ (conduit and cable tray runs, docs/reference/editor/raceways.md) ---------------------------

const racewaySession = lazyModule(() => import('../../tools/raceway/session.js'));
for (const [key, kind, icon, keywords] of [
  ['conduit', 'conduit', conduitIcon, ['emt', 'rmc', 'imc', 'pvc', 'raceway', 'run', 'as-built', 'electrical']],
  ['cableTray', 'tray', cableTrayIcon, ['ladder', 'basket', 'wire mesh', 'raceway', 'run', 'as-built', 'electrical']],
]) {
  registerCommand({
    id: `tools.raceway.${key}`, label: `common:commands.tools.${key}`, icon, category: 'tools',
    enabled: editable, keywords,
    checked: () => isTool('raceway') && racewaySession()?.settings().kind === kind,
    run: async () => {
      const [session, bar] = await Promise.all([
        import('../../tools/raceway/session.js'), import('../../tools/tools/raceway-tool.js'),
      ]);
      session.setSettings({ kind });
      bar.ensureRacewayBar();
      return useTool('raceway');
    },
  });
}

registerCommand({
  id: 'tools.quantities', label: 'common:commands.tools.quantities', icon: quantitiesIcon, category: 'tools',
  enabled: hasPdf, checked: () => !!scheduleStore()?.scheduleVisible(), keywords: ['schedule', 'takeoff', 'totals'],
  run: () => import('../stores/scheduleStore.js').then((m) => m.toggleSchedule()),
});

// --- Sketch to Scale ▸ (CAD drafting edits) ----------------------------------------------

for (const [key, tool, icon] of [
  ['trim', 'trim', trimIcon], ['extend', 'extend', extendIcon], ['split', 'split', splitIcon],
  ['break', 'break', breakIcon], ['lengthen', 'lengthen', lengthenIcon], ['array', 'array', arrayIcon],
]) {
  toolCommand(`tools.${key}`, tool, key, icon, 'tools', { keywords: ['cad', 'modify', 'sketch'] });
}
registerCommand({
  id: 'tools.join', label: 'common:commands.tools.join', icon: joinIcon, category: 'tools',
  enabled: editable, keywords: ['cad', 'modify', 'merge lines'],
  run: () => import('../../annotations/segment-ops.js').then((m) => m.joinSelection()),
});
registerCommand({
  id: 'tools.explode', label: 'common:commands.tools.explode', icon: explodeIcon, category: 'tools',
  enabled: editable, keywords: ['cad', 'modify', 'segments'],
  run: () => import('../../annotations/segment-ops.js').then((m) => m.explodeSelection()),
});

// --- Stamp ▸, Signature ▸ --------------------------------------------------------------

toolCommand('tools.stamp', 'stamp', 'stamp', stampIcon, 'tools');
registerCommand({
  // Stamp editor (docs/reference/editor/markup-tools.md): user stamps with dynamic fields.
  id: 'tools.stampEditor', label: 'common:stampEditor.command', icon: stampIcon, category: 'tools',
  keywords: ['stamp', 'dynamic', 'editor', 'approved'],
  run: () => import('../../annotations/stamps.js').then((m) => m.showStampEditor()),
});
registerCommand({
  id: 'tools.parametricSymbol', label: 'common:commands.tools.parametricSymbol', icon: stampIcon, category: 'tools',
  enabled: editable, checked: () => isTool('parametricSymbol'), keywords: ['symbol', 'block', 'parametric'],
  run: () => import('../stores/parametricSymbolStore.js').then((m) => m.setPickerOpen(true)),
});
toolCommand('tools.signature.place', 'signature', 'signature', signatureIcon, 'tools.signature',
  { keywords: ['sign', 'handwritten'] });

// --- Reuse and Toolbars ▸ --------------------------------------------------------------

registerCommand({
  // the external editor Reuse: keep the tool active after placing a markup (status bar).
  id: 'tools.reuse', label: 'common:commands.tools.reuse', icon: lucide('refresh-cw'), category: 'tools',
  checked: () => isSnapToggleOn(state.preferences, 'reuse'), keywords: ['keep tool', 'repeat'],
  run: () => toggleSnapPreference('reuse'),
});
// F4 / F8 (the external editor): Navigation Bar and Status Bar (shortcut-table.js).
const TOOLBAR_KEYS = { navigation: 'F4', status: 'F8' };
for (const toolbar of ['properties', 'navigation', 'status', 'standard', 'markup', 'measure']) {
  registerCommand({
    id: `tools.toolbar.${toolbar}`, label: `common:commands.toolbars.${toolbar}`, icon: null, category: 'tools',
    shortcut: TOOLBAR_KEYS[toolbar] || null,
    checked: () => isToolbarVisible(toolbar), keywords: ['toolbar', 'show', 'hide'],
    run: () => setToolbarVisible(toolbar, !isToolbarVisible(toolbar)),
  });
}

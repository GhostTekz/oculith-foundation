/**
 * Tool registration — imports all tools and registers them in the tool-registry
 */
import { registerTool } from '../tool-registry.js';
import { registerAddonBoxTools } from '../addon-box-tools.js';
import { edition } from '../../editions/active.js';
import { handTool } from './hand-tool.js';
import { selectTool } from './select-tool.js';
import { drawTool } from './draw-tool.js';
import { eraserTool } from './eraser-tool.js';
import { shapeTool } from './shape-tool.js';
import { lineTool } from './line-tool.js';
import { polylineTool, cloudPolylineTool } from './polyline-tool.js';
import { arcTool } from './arc-tool.js';
import { splineTool } from './spline-tool.js';
import { splineArrowTool } from './spline-arrow-tool.js';
import { measureDistanceTool, measureAreaTool, measurePerimeterTool, addHoleTool } from './measurement-tool.js';
import { filledAreaTool } from './filled-area-tool.js';
import { dynamicFillTool } from './dynamic-fill-tool.js';
import { racewayTool } from './raceway-tool.js';
import { systeemrasterTool, systeemplafondTool } from './systeemraster-tool.js';
import { measureAngleTool } from './angle-tool.js';
import { measurePolylengthTool, measureVolumeTool, measureArcTool, measureRadius3Tool } from './measure-extra-tools.js';
import { commentTool, textTool, stampTool, signatureTool, editTextTool } from './text-tool.js';
import { calibrationPickTool } from './calibration-pick-tool.js';
import { scaleMeasureTool } from './scale-measure-tool.js';
import { pluginClickTool } from './plugin-tool.js';
import { viewportTool } from './viewport-tool.js';
import { scaleRegionTool } from './scale-region-tool.js';
import { vectorSnippetTool } from './vector-snippet-tool.js';
import { scaleBarTool } from './scalebar-tool.js';
import { trimTool } from './trim-tool.js';
import { extendTool } from './extend-tool.js';
import { arrayTool } from './array-tool.js';
import { removeImageTool } from './remove-image-tool.js';
import { splitTool, breakTool } from './split-tool.js';
import { lengthenTool } from './lengthen-tool.js';
import { dimChainAddTool, dimChainRemoveTool } from './dimension-chain-tool.js';
import { radiusTool, diameterTool } from './dimension-radius-tool.js';
import { typewriterTool, hyperlinkTool, flagTool, snapshotTool } from './ext-tools.js';
import { formatPainterTool } from './format-painter-tool.js';
import { fileAttachmentTool } from './file-attachment-tool.js';
import { toolChestGroupTool } from './tool-chest-group-tool.js';
import { lassoTool, offsetTool } from './edit-tools.js';
import { spaceRectTool, spacePolygonTool } from './space-tool.js';

export function registerAllTools() {
  // Navigation / selection
  registerTool('hand', handTool);
  registerTool('select', selectTool);


  // Freehand
  registerTool('draw', drawTool);
  // Ink eraser: drag to remove whole freehand strokes (issue #329)
  registerTool('eraser', eraserTool);

  // Shapes (all use the same drag-to-create pattern)
  registerTool('box', shapeTool);
  registerTool('mask', shapeTool);
  registerTool('circle', shapeTool);
  registerTool('ellipse', shapeTool);
  registerTool('highlight', shapeTool);
  registerTool('cloud', shapeTool);
  registerTool('polygon', shapeTool);
  registerTool('redaction', shapeTool);
  registerTool('textbox', shapeTool);
  registerTool('callout', shapeTool);
  registerTool('parametricSymbol', shapeTool);
  registerTool('count', shapeTool);
  // Stavenreeks (wapeningsstaven-reeks): sleep begin→eind bepaalt de
  // reekslijn; een klik zonder sleep plaatst een standaardlengte.
  registerTool('stavenreeks', shapeTool);
  // L-shaped outline — drag-to-create like the other shapes (buildAnnotationProps
  // emits a closed polyline for the 'lshape' tool).
  registerTool('lshape', shapeTool);

  // Lines
  registerTool('line', lineTool);
  registerTool('arrow', lineTool);
  // Walls share the click-click line flow (incl. type-length + ortho); the
  // band rendering/joins live in annotations/rendering/walls.js.
  registerTool('wall', lineTool);
  // Betonbalk: één balk = één lijnstuk — zelfde klik-klik-flow als de wand
  // (type-length, Shift-hoeksnap, doortekenen); band + verstek-/T-joins in
  // annotations/betonbalk.js.
  registerTool('betonbalk', lineTool);
  registerTool('arc', arcTool);
  registerTool('spline', splineTool);
  registerTool('splineArrow', splineArrowTool);

  // Multi-click tools
  registerTool('polyline', polylineTool);
  registerTool('cloudPolyline', cloudPolylineTool);

  // Measurements
  registerTool('measureDistance', measureDistanceTool);
  registerTool('measureArea', measureAreaTool);
  registerTool('measurePerimeter', measurePerimeterTool);
  registerTool('measureAngle', measureAngleTool);
  // plan-review extras on the base measurements (measure-extra-tools.js).
  registerTool('measurePolylength', measurePolylengthTool);
  registerTool('measureVolume', measureVolumeTool);
  registerTool('measureArc', measureArcTool);
  registerTool('measureRadius3', measureRadius3Tool);
  registerTool('addHole', addHoleTool);
  // Maatketting verlengen / een hulplijn eruit halen (#477).
  registerTool('dimChainAdd', dimChainAddTool);
  registerTool('dimChainRemove', dimChainRemoveTool);

  // Filled area (contour with arcs and optional holes; solid or hatched fill)
  registerTool('filledArea', filledAreaTool);

  // Dynamic Fill (J): paint-bucket fill of a region bounded by the page's
  // vector linework → Area/Perimeter/Polylength measurement or Polygon.
  registerTool('dynamicFill', dynamicFillTool);
  // Conduit and cable tray runs (raceway-tool.js, docs/reference/editor/raceways.md).
  registerTool('raceway', racewayTool);

  // Systeemraster: klik-voor-klik contour, automatisch gevuld met een
  // platenraster (systeemplafond / stelconplaten); geometrie in
  // annotations/systeemraster.js.
  registerTool('systeemraster', systeemrasterTool);
  // Systeemplafond: zelfde contour-flow, celmaat 600×600 en het
  // system-datamodel (panelen + randprofiel) — zie systeemraster-tool.js.
  registerTool('systeemplafond', systeemplafondTool);

  // Calibration
  registerTool('calibrationPick', calibrationPickTool);

  // Temporary 2-click distance pick for scale regions ("Meet op tekening")
  registerTool('scaleMeasure', scaleMeasureTool);

  // Scale bar
  registerTool('scaleBar', scaleBarTool);

  // Single-click placement
  registerTool('comment', commentTool);
  registerTool('text', textTool);
  registerTool('stamp', stampTool);
  registerTool('signature', signatureTool);
  registerTool('editText', editTextTool);

  // Viewports
  registerTool('viewport', viewportTool);

  // Scale regions (per-region calibration)
  registerTool('scaleRegion', scaleRegionTool);
  registerTool('vectorSnippet', vectorSnippetTool);

  // Plugin fallback
  registerTool('_plugin_click', pluginClickTool);

  // Remove an image that is embedded in the PDF page content (issue #184)
  registerTool('removeImage', removeImageTool);

  // CAD tools
  registerTool('trim', trimTool);
  registerTool('extend', extendTool);
  registerTool('array', arrayTool);
  registerTool('split', splitTool);
  registerTool('break', breakTool);
  registerTool('lengthen', lengthenTool);

  // Radius / diameter dimensioning (measureDistance with a prefixed label)
  registerTool('radius', radiusTool);
  registerTool('diameter', diameterTool);

  // the external editor markup tools (ext-tools.js): Typewriter (W), Hyperlink (Shift+H),
  // Flag (Shift+F), Snapshot (G).
  registerTool('typewriter', typewriterTool);
  registerTool('hyperlink', hyperlinkTool);
  registerTool('flag', flagTool);
  registerTool('snapshot', snapshotTool);
  // Format Painter (Ctrl+Shift+C): paint one markup's appearance on others.
  registerTool('formatPainter', formatPainterTool);
  // File Attachment (F): a push pin with an embedded file (docs/reference/editor/markup-tools.md).
  registerTool('fileAttachment', fileAttachmentTool);
  // Tool Chest group tools: place a saved group (docs/reference/editor/tool-chest.md).
  registerTool('toolChestGroup', toolChestGroupTool);
  // Lasso (Shift+O) and Offset (O), Edit menu (edit-tools.js).
  registerTool('lasso', lassoTool);
  registerTool('offset', offsetTool);
  // Spaces panel: draw a space's outline (rectangle or polygon).
  registerTool('spaceRect', spaceRectTool);
  registerTool('spacePolygon', spacePolygonTool);
  for (const id of edition.tools?.shapeToolIds || []) registerTool(id, shapeTool);
  registerAddonBoxTools(edition.boxTools);
}

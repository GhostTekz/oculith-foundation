import { huidigeSymboolSchaal } from '../symbols/symbol-scale-store.js';
import { state, getActiveDocument, imageCache } from '../core/state.js';
import { createAnnotation } from './factory.js';
import { recordAdd } from '../core/undo-manager.js';
import { showProperties } from '../ui/panels/properties-panel.js';
import { redrawAnnotations, redrawContinuous } from './rendering.js';
import { updateStatusMessage } from '../ui/chrome/status-bar.js';
import { openDialog } from '../bridge.js';
import { BUILTIN_STAMP_DEFAULT_WIDTH, BUILTIN_STAMP_DEFAULT_HEIGHT, OVERRIDE_STAMP_DEFAULT_HEIGHT, BUILT_IN_STAMPS } from './stamp-defaults.js';
import { svgRealSizeMm, stampPlacementSize } from './svg-real-size.js';
import { stampPxPerMm } from './stamp-scale.js';
import { rasterizeSvg } from './svg-raster.js';
import { paginaMaat, rechtopRotatie } from '../pdf/weergave-ruimte.js';
import { activeToolPreset, applyActiveToolPreset, finishToolPresetPlacement, saveToolPreset } from '../tools/tool-chest-presets.js';
import { instantiateStampTemplate, stampDesignText } from './stamp-templates.js';
import { stampDesignSize, dynamicStampScale } from './stamp-layout.js';
import { findStampTemplate } from './user-stamps.js';

// Built-in stamp definitions
// (in stamp-defaults.js, zodat ook de loader ze kan lezen)
export { BUILT_IN_STAMPS };

// Show stamp picker dialog
export function showStampPicker(x, y) {
  openDialog('stamp-picker', {
    onSelect: (stamp) => placeStamp(stamp, x, y),
    onCustom: () => loadCustomStamp(x, y)
  });
}

/** Open the stamp editor; `template` edits a user stamp or starts from a copy. */
export function showStampEditor(template = null, onSaved = null) {
  openDialog('stamp-editor', { template, onSaved });
}

/** The built-in stamp of an active Tool Chest stamp tool, or null. */
export function activeStampPreset() {
  const preset = activeToolPreset();
  if (preset?.tool !== 'stamp') return null;
  if (preset.style?.stampTemplateId) return activeTemplatePreset(preset);
  return BUILT_IN_STAMPS.find(stamp => stamp.name === preset.style?.stampName) || null;
}

/** The built-in or user stamp of an active Tool Chest stamp tool, or null. */
function activeTemplatePreset(preset) {
  const id = preset?.style?.stampTemplateId;
  return typeof id === 'string' ? findStampTemplate(id) : null;
}

// Placement scale of a dynamic stamp (stamp-layout.js, shared with Batch ▸ Apply Stamp).
export { dynamicStampScale };

/** The values of the dynamic fields for a placement on a page. */
export async function stampFieldContext(doc, page) {
  let pageLabel = '';
  try {
    const labels = await doc?.pdfDoc?.getPageLabels?.();
    const label = Array.isArray(labels) ? labels[page - 1] : null;
    if (typeof label === 'string') pageLabel = label;
  } catch { /* no labels: the page number */ }
  return {
    now: new Date(),
    user: state.defaultAuthor || 'User',
    page, pageLabel,
    fileName: doc?.fileName || doc?.filePath || '',
  };
}

/** Field values for previews (picker, editor): no await for page labels. */
export function previewFieldContext() {
  const doc = getActiveDocument();
  return {
    now: new Date(),
    user: state.defaultAuthor || 'User',
    page: doc?.currentPage || 1, pageLabel: '',
    fileName: doc?.fileName || doc?.filePath || 'Drawing.pdf',
  };
}

/**
 * Save a stamp template as a Tool Chest stamp tool (Properties Mode at the
 * placement size; the tool keeps the template id). Returns the preset or null.
 */
export function saveStampTemplateToToolChest(template, setId) {
  const design = instantiateStampTemplate(template, previewFieldContext());
  if (!design) return null;
  const size = stampDesignSize(design);
  const sample = { type: 'stamp', x: 0, y: 0, width: size.width, height: size.height, rotation: 0,
    stampName: design.name, stampTemplateId: design.templateId, stampColor: design.color,
    color: design.color, opacity: 1 };
  return setId ? saveToolPreset(sample, design.name, setId) : saveToolPreset(sample, design.name);
}

/**
 * Place a dynamic stamp (docs/reference/editor/markup-tools.md): its fields are evaluated now and
 * stored as text; the stamp keeps its template id.
 */
export async function placeDynamicStamp(template, x, y) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return null;
  const page = doc.currentPage || 1;
  const design = instantiateStampTemplate(template, await stampFieldContext(doc, page));
  if (!design || getActiveDocument() !== doc) return null;
  const natural = stampDesignSize(design);
  const scale = dynamicStampScale(paginaMaat(page, doc));
  const width = natural.width * scale;
  const height = natural.height * scale;
  const ann = createAnnotation(applyActiveToolPreset('stamp', {
    type: 'stamp',
    page,
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    stampName: design.name,
    stampText: stampDesignText(design),
    stampTemplateId: design.templateId,
    stampDesign: design,
    stampColor: design.color,
    color: design.color,
    strokeColor: design.color,
    opacity: 1,
    lockAspectRatio: true,
    rotation: rechtopRotatie()
  }, x, y));
  // A Tool Chest preset carries the template id, never another design.
  ann.stampDesign = design;
  ann.stampTemplateId = design.templateId;
  finishToolPresetPlacement(ann, doc);
  doc.annotations.push(ann);
  recordAdd(ann);
  if (state.preferences.autoSelectAfterCreate) {
    doc.selectedAnnotation = ann; doc.selectedAnnotations = [ann];
    showProperties(ann);
  }
  if (doc.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
  updateStatusMessage(`Stamp "${design.name}" placed`);
  return ann;
}

// Place a built-in stamp. With an active Tool Chest stamp tool, its colour
// and opacity (and in Drawing Mode its size and rotation) apply.
// A dynamic stamp template (one with text lines) goes to placeDynamicStamp.
export function placeStamp(stamp, x, y) {
  if (!getActiveDocument()?.pdfDoc) return;
  if (Array.isArray(stamp?.lines)) { placeDynamicStamp(stamp, x, y); return; }

  const width = BUILTIN_STAMP_DEFAULT_WIDTH;
  const height = BUILTIN_STAMP_DEFAULT_HEIGHT;

  const ann = createAnnotation(applyActiveToolPreset('stamp', {
    type: 'stamp',
    page: getActiveDocument()?.currentPage || 1,
    x: x - width / 2,
    y: y - height / 2,
    width: width,
    height: height,
    stampName: stamp.name,
    stampText: stamp.text,
    stampColor: stamp.color,
    color: stamp.color,
    strokeColor: stamp.color,
    opacity: 0.85,
    // Rechtop op het scherm, ook in een gedraaide weergave (#200).
    rotation: rechtopRotatie()
  }, x, y));

  const _doc = getActiveDocument();
  finishToolPresetPlacement(ann, _doc);
  if (_doc) _doc.annotations.push(ann);
  recordAdd(ann);

  if (state.preferences.autoSelectAfterCreate) {
    if (_doc) { _doc.selectedAnnotation = ann; _doc.selectedAnnotations = [ann]; }
    showProperties(ann);
  }

  if (getActiveDocument()?.viewMode === 'continuous') {
    redrawContinuous();
  } else {
    redrawAnnotations();
  }

  updateStatusMessage(`Stamp "${stamp.name}" placed`);
}



// Place a preconfigured image stamp from tool overrides (used by extensions).
// Supports stampSvg (SVG string) or stampImage (data URL) in state.toolOverrides.
export async function placeOverrideStamp(x, y) {
  if (!getActiveDocument()?.pdfDoc) return;

  const overrides = state.toolOverrides;
  if (!overrides?.stampSvg && !overrides?.stampImage) {
    updateStatusMessage('No stamp data provided');
    return;
  }

  let img, dataUrl;

  if (overrides.stampSvg) {
    const result = await rasterizeSvg(overrides.stampSvg);
    if (!result) {
      updateStatusMessage('Failed to render stamp SVG');
      return;
    }
    img = result.img;
    dataUrl = result.dataUrl;
  } else {
    // stampImage is already a data URL (PNG/JPG)
    img = new Image();
    img.src = overrides.stampImage;
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    dataUrl = overrides.stampImage;
  }

  const aspect = img.naturalWidth / img.naturalHeight;
  let stampHeight, stampWidth, stampX, stampY;

  if (overrides.stampFillPage) {
    // Fill the page with margin
    const canvas = document.getElementById('annotation-canvas') || document.getElementById('pdf-canvas');
    const doc = getActiveDocument();
    const stampScale = doc?.scale || 1.5;
    const dpr = window.devicePixelRatio || 1;
    // Paginamaat in de paginaruimte; het canvas is in de viewport-weergave het
    // venster en kan gedraaid zijn (#200) — alleen nog als terugval.
    const maat = paginaMaat(doc?.currentPage || 1, doc);
    const pageW = maat ? maat.breedte : (canvas ? canvas.width / (stampScale * dpr) : 600);
    const pageH = maat ? maat.hoogte : (canvas ? canvas.height / (stampScale * dpr) : 800);
    const margin = overrides.stampPageMargin || 20;
    stampWidth = Math.round(pageW - margin * 2);
    stampHeight = Math.round(pageH - margin * 2);
    stampX = margin;
    stampY = margin;
  } else {
    // Declareert de SVG-root een echte eenheid (bv. width="65mm"), dan telt
    // die maat, omgerekend met de plaatselijke tekeningschaal. Zonder echte
    // maat (alle meegeleverde symbolen) blijft het bestaande gedrag gelden:
    // de standaardhoogte, met de breedte uit de beeldverhouding.
    const page = getActiveDocument()?.currentPage || 1;
    const size = stampPlacementSize({
      mm: svgRealSizeMm(overrides.stampSvg),
      pxPerMm: stampPxPerMm(page, x, y),
      aspect,
      defaultWidth: overrides.stampWidth,
      defaultHeight: overrides.stampHeight || OVERRIDE_STAMP_DEFAULT_HEIGHT,
      schaal: huidigeSymboolSchaal(),
    });
    stampWidth = size.width;
    stampHeight = size.height;
    stampX = x - stampWidth / 2;
    stampY = y - stampHeight / 2;
  }

  const imageId = 'stamp_' + Date.now();
  imageCache.set(imageId, img);

  // Also store on a non-reactive property for rendering perf
  const _imgRef = img;

  // A Tool Chest symbol tool for this symbol supplies opacity (and in
  // Drawing Mode its saved size and rotation, centred on the click).
  const ann = createAnnotation(applyActiveToolPreset('symbol', {
    type: 'stamp',
    page: getActiveDocument()?.currentPage || 1,
    x: stampX,
    y: stampY,
    width: stampWidth,
    height: stampHeight,
    stampName: overrides.stampName || 'Custom',
    stampText: '',
    stampSvg: overrides.stampSvg || null,
    // Original (unedited) source SVG for this symbol type. Kept so the
    // "Edit Type" editor can resolve/update the correct type override even
    // after the stamp's rendered geometry has been replaced.
    stampBaseSvg: overrides.stampBaseSvg || overrides.stampSvg || null,
    stampSvgBuilder: overrides.stampSvgBuilder || null,
    imageId: imageId,
    imageData: dataUrl,
    originalWidth: img.naturalWidth,
    originalHeight: img.naturalHeight,
    color: '#000000',
    opacity: 1,
    // Rechtop op het scherm in een gedraaide weergave (#200); een stempel die
    // de pagina vult, volgt de pagina.
    rotation: overrides.stampFillPage ? 0 : rechtopRotatie(),
    lockAspectRatio: overrides.lockAspectRatio !== false,
    // IFC-categorie uit de symbool-metadata (mapping-laag) → hoeveelheden.
    ifcCategory: overrides.ifcCategory || undefined,
    // Palette-symbool-id (bv. 'nen1414-Tb1.003') + IFC PredefinedType,
    // zodat saver/loader en het IFC-report de herkomst behouden.
    symbolId: overrides.symbolId || undefined,
    ifcPredefinedType: overrides.ifcPredefinedType || undefined,
  }, x, y));

  // Store image reference directly on annotation for rendering
  ann._cachedImg = _imgRef;

  // Copy custom fields (e.g., tb* for title blocks)
  for (const key of Object.keys(overrides)) {
    if (key.startsWith('tb')) ann[key] = overrides[key];
  }

  const _doc2 = getActiveDocument();
  finishToolPresetPlacement(ann, _doc2);
  if (_doc2) _doc2.annotations.push(ann);
  recordAdd(ann);

  if (state.preferences.autoSelectAfterCreate) {
    if (_doc2) { _doc2.selectedAnnotation = ann; _doc2.selectedAnnotations = [ann]; }
    showProperties(ann);
  }

  if (getActiveDocument()?.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();

  updateStatusMessage(`${overrides.stampName || 'Stamp'} placed`);
}

/**
 * Re-rasterize a stamp annotation from a new SVG string and update its image.
 */
export async function updateStampImage(ann, svgString) {
  const result = await rasterizeSvg(svgString);
  if (!result) return;
  const imageId = 'stamp_' + Date.now();
  imageCache.set(imageId, result.img);
  ann.imageId = imageId;
  ann.imageData = result.dataUrl;
  ann.originalWidth = result.img.naturalWidth;
  ann.originalHeight = result.img.naturalHeight;
  ann.modifiedAt = new Date().toISOString();
  if (getActiveDocument()?.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
}

// Load custom stamp from image file
async function loadCustomStamp(x, y) {
  try {
    const { openFileDialog } = await import('../core/platform.js');
    const filePath = await openFileDialog(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'svg']);
    if (!filePath) return;

    const { readBinaryFile } = await import('../core/platform.js');
    const data = await readBinaryFile(filePath);
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);

    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });

    const { generateImageId } = await import('../utils/helpers.js');
    const imageId = generateImageId();
    imageCache.set(imageId, img);

    let width = img.naturalWidth;
    let height = img.naturalHeight;
    const maxSize = 200;
    if (width > maxSize || height > maxSize) {
      const ratio = Math.min(maxSize / width, maxSize / height);
      width *= ratio;
      height *= ratio;
    }

    const ann = createAnnotation({
      type: 'stamp',
      page: getActiveDocument()?.currentPage || 1,
      x: x - width / 2,
      y: y - height / 2,
      width: width,
      height: height,
      stampName: 'Custom',
      stampText: '',
      imageId: imageId,
      imageData: url,
      originalWidth: img.naturalWidth,
      originalHeight: img.naturalHeight,
      color: '#000000',
      opacity: 1,
      // Rechtop op het scherm, ook in een gedraaide weergave (#200).
      rotation: rechtopRotatie()
    });

    const _doc3 = getActiveDocument();
    if (_doc3) _doc3.annotations.push(ann);
    recordAdd(ann);

    if (state.preferences.autoSelectAfterCreate) {
      if (_doc3) { _doc3.selectedAnnotation = ann; _doc3.selectedAnnotations = [ann]; }
      showProperties(ann);
    }

    if (getActiveDocument()?.viewMode === 'continuous') {
      redrawContinuous();
    } else {
      redrawAnnotations();
    }

    updateStatusMessage('Custom stamp placed');
  } catch (err) {
    console.error('Failed to load custom stamp:', err);
  }
}

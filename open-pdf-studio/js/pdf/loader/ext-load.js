// the external editor markups into the OcuDraw model (docs/reference/editor/markup-interop.md). The converter
// has already turned the annotation into a model as for any PDF; this adds
// what only an external editor markup says: where it came from (for the saver), its
// blend mode, text alignment, the rotation the external editor keeps out of /Vertices and
// the scale of an external editor measurement.

import { SOORTEN_MET_EIGEN_TEKST } from './annotatie-opmerking.js';

// Measurements whose value label OcuDraw draws on the page (measureShowLabel).
const MAAT_MET_LABEL = new Set(['measurePerimeter', 'measureArea', 'measureDistance']);
import {
  extGedraaidePunten, extOppervlak, extLengte, extDecimalen, formatExtWaarde,
} from '../ext-interop.js';

const PUNT_SOORTEN = new Set(['polygon', 'measureArea', 'cloud', 'cloudPolyline', 'filledArea', 'polyline', 'measurePerimeter']);

function pdfPunten(vertices) {
  const uit = [];
  if (!Array.isArray(vertices) && !(vertices && typeof vertices.length === 'number')) return uit;
  for (let i = 0; i + 1 < vertices.length; i += 2) uit.push({ x: vertices[i], y: vertices[i + 1] });
  return uit;
}

function viewportRechthoek(viewport, rect) {
  const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

function zetPunten(model, punten, viewport) {
  const vp = punten.map((p) => {
    const [x, y] = viewport.convertToViewportPoint(p.x, p.y);
    return { x, y };
  });
  model.points = vp;
  const xs = vp.map((p) => p.x);
  const ys = vp.map((p) => p.y);
  model.x = Math.min(...xs);
  model.y = Math.min(...ys);
  model.width = Math.max(...xs) - model.x;
  model.height = Math.max(...ys) - model.y;
}

/**
 * Size and rotation of the picture of an image markup from its appearance
 * /Matrix and /BBox: the form is turned by the matrix angle (PDF space,
 * counter-clockwise) and scaled per axis. The model rotation is clockwise on
 * screen, relative to the page as displayed.
 * @returns {{ width: number, height: number, rotation: number }|null}
 */
export function extBeeldVorm(matrix, bbox, paginaRotatie = 0) {
  if (!Array.isArray(matrix) || !Array.isArray(bbox)) return null;
  const [a, b, c, d] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const bw = Math.abs(bbox[2] - bbox[0]);
  const bh = Math.abs(bbox[3] - bbox[1]);
  if (!(sx > 0 && sy > 0 && bw > 0 && bh > 0)) return null;
  const hoek = Math.round(Math.atan2(b, a) * 180 / Math.PI);
  let rotatie = -(hoek - paginaRotatie);
  while (rotatie > 180) rotatie -= 360;
  while (rotatie <= -180) rotatie += 360;
  if (Math.abs(rotatie) <= 1) rotatie = 0;
  return { width: bw * sx, height: bh * sy, rotation: rotatie };
}

/** Number in the external editor's own text ("22,633.77 sf" -> 22633.77), if any. */
export function getalUitExtTekst(tekst) {
  const m = /-?[\d,]*\.?\d+/.exec(String(tekst || ''));
  if (!m) return null;
  const v = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/**
 * The scale of an external editor measurement on the model: value, unit and the label
 * "from the file scale". A /Measure dictionary is an explicit calibration source
 * (K-004), but it is the external editor's, so the UI names it as such.
 */
function metExtMaat(model, ext, annot) {
  const m = ext.measure;
  if (!m) return;
  let waarde = null;
  let fmt = null;
  if (model.type === 'measureArea') {
    waarde = extOppervlak(extGedraaidePunten(pdfPunten(annot.vertices), ext.rotation), m);
    fmt = m.area || { unit: `${m.xUnit}²` };
  } else if (model.type === 'measurePerimeter') {
    waarde = extLengte(pdfPunten(annot.vertices), m, { gesloten: annot.subtype === 'Polygon' });
    fmt = m.distance || { unit: m.xUnit };
  } else if (model.type === 'measureDistance' && Array.isArray(annot.lineCoordinates)) {
    const [x1, y1, x2, y2] = annot.lineCoordinates;
    waarde = extLengte([{ x: x1, y: y1 }, { x: x2, y: y2 }], m);
    fmt = m.distance || { unit: m.xUnit };
  }
  if (!Number.isFinite(waarde)) return;
  // the external editor's length of a run with a rise/drop is the plan length plus it.
  if (model.type !== 'measureArea' && Number.isFinite(ext.riseDrop)) waarde += Math.abs(ext.riseDrop);
  model.extMeasure = {
    label: m.label,
    xFactor: m.xFactor,
    xUnit: m.xUnit,
    ...(m.area ? { area: m.area } : {}),
    ...(m.distance ? { distance: m.distance } : {}),
    ...(m.areaChain ? { areaChain: m.areaChain } : {}),
    ...(m.distanceChain ? { distanceChain: m.distanceChain } : {}),
    ...(Number.isFinite(ext.riseDrop) && ext.riseDrop !== 0 ? { riseDrop: ext.riseDrop } : {}),
    ...(ext.measureLabel ? { labelText: ext.measureLabel } : {}),
  };
  model.measureScaleSource = 'revu';
  model.measureValue = waarde;
  model.measureUnit = fmt.unit || model.measureUnit;
  model.measurePrecision = extDecimalen(fmt);
  // the external editor's own text stays as the external editor wrote it; without one, the external editor's format.
  if (!model.measureText) model.measureText = formatExtWaarde(waarde, fmt);
}

/**
 * @param {object|null} model  the converted annotation
 * @param {object|undefined} the external editor  leesExtExtra() of its dictionary
 * @param {object} annot  the pdf.js annotation
 * @param {object} viewport  pdf.js page viewport (scale 1)
 */
export function metExt(model, ext, annot, viewport) {
  if (!model || !ext?.ref || model.__textboxLeader) return model;
  model.extBron = { ref: ext.ref, nm: ext.nm, subtype: ext.subtype, rect: ext.rect,
    ...(ext.intent ? { intent: ext.intent } : {}), ...(ext.eigenAp ? { eigenAp: true } : {}),
    ...(Number.isInteger(ext.annotsIndex) ? { annotsIndex: ext.annotsIndex } : {}) };
  // the external editor's Subject column is /Subj; OcuDraw's subject of a shape is its
  // comment (/Contents). A the external editor shape without a comment is listed under its
  // the external editor subject; the saver then writes no /Contents for it.
  if (ext.subj && ext.zonderOpmerking && !model.subject && !SOORTEN_MET_EIGEN_TEKST.has(model.type)) {
    model.subject = ext.subj;
    model.extBron.subj = ext.subj;
  }
  if (ext.blendMode === 'Multiply') model.blendMode = 'multiply';
  if (ext.fillOpacity !== undefined && model.fillOpacity === undefined) model.fillOpacity = ext.fillOpacity;

  // A rotated the external editor polygon keeps unrotated /Vertices plus /Rotation.
  if (Number.isFinite(ext.rotation) && annot?.vertices && Array.isArray(model.points) && PUNT_SOORTEN.has(model.type)) {
    const punten = pdfPunten(annot.vertices);
    if (punten.length === model.points.length) zetPunten(model, extGedraaidePunten(punten, ext.rotation), viewport);
  }

  // An image markup whose appearance turns or scales its picture: the model
  // holds the picture unrotated, with its rotation, around the /Rect centre.
  if (ext.intent === 'StampSnapshot' && model.type === 'stamp' && Array.isArray(annot?.rect)) {
    // Its picture is the rendered appearance (image-extraction.js), already
    // turned as displayed: the /Rect box, unrotated.
    const vr = viewportRechthoek(viewport, annot.rect);
    Object.assign(model, vr, { rotation: 0 });
    if (model.originalWidth !== undefined) { model.originalWidth = vr.width; model.originalHeight = vr.height; }
  } else if ((model.type === 'image' || model.type === 'stamp') && ext.apBBox && Array.isArray(annot?.rect)) {
    const vorm = extBeeldVorm(ext.apMatrix, ext.apBBox, viewport.rotation || 0);
    if (vorm) {
      const [x1, y1, x2, y2] = annot.rect;
      const [cx, cy] = viewport.convertToViewportPoint((x1 + x2) / 2, (y1 + y2) / 2);
      model.x = cx - vorm.width / 2;
      model.y = cy - vorm.height / 2;
      model.width = vorm.width;
      model.height = vorm.height;
      model.rotation = vorm.rotation;
      if (model.originalWidth !== undefined) { model.originalWidth = vorm.width; model.originalHeight = vorm.height; }
    }
  }

  if (model.type === 'textbox' || model.type === 'callout') {
    if (ext.textAlign && !model.textAlign && ext.textAlign !== 'left') model.textAlign = ext.textAlign;
    if (ext.textVAlign === 'middle' || ext.textVAlign === 'bottom') model.textVAlign = ext.textVAlign;
    // the external editor's typewriter text wraps once its box is made narrower than the
    // text: a box taller than one line holds wrapped lines.
    if (model.noWrap && /^FreeTextTypeWriter$/i.test(ext.intent || '')) {
      const regel = (model.fontSize || 12) * (model.lineSpacing || 1.15);
      const regels = String(model.text || '').split('\n').length;
      if (model.height > regel * (regels + 0.5)) delete model.noWrap;
    }
  }

  metExtMaat(model, ext, annot);
  // No caption in the external editor's appearance: none on the drawing here either.
  if (ext.zonderBijschrift && MAAT_MET_LABEL.has(model.type)) model.measureShowLabel = false;
  return model;
}

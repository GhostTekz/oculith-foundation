// Batch ▸ Apply Stamp, the PDF side (docs/reference/editor/sets-and-batch.md): put a dynamic stamp
// (docs/reference/editor/markup-tools.md) on pages of a file that is not open. Per page the fields
// are evaluated with that file and page ({fileName}, {pageLabel}, {page},
// {date}, {time}, {user}), the stamp gets the size Tools ▸ Stamp gives it on
// that sheet, and it is written with the saver's own pieces: the /Stamp
// dictionary (saver/stamp-annot.js), the /Rect (stampDesignRect), the vector
// appearance and /OPS_StampDesign (writeStampDesignAppearance), and the
// rotated-page remap (saver/rotatie-mapper.js). Existing annotations are
// left exactly as they are; the new stamps are appended to /Annots.

import { PDFArray, PDFName } from 'pdf-lib';
import { instantiateStampTemplate, stampDesignText } from '../annotations/stamp-templates.js';
import { stampDesignSize, dynamicStampScale } from '../annotations/stamp-layout.js';
import { createAnnotation } from '../annotations/factory.js';
import { stampDesignRect, writeStampDesignAppearance } from '../pdf/saver/stamp-design-ap.js';
import { stampAnnotObject } from '../pdf/saver/stamp-annot.js';
import { zetDoorzichtigheidInAp } from '../pdf/saver/utils.js';
import { _rotVisualMapper, _remapRect } from '../pdf/saver/rotatie-mapper.js';
import { hexToColorArray } from '../utils/colors.js';

export const STAMP_POSITIONS = Object.freeze([
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]);

const quarter = (deg) => ((Math.round((Number(deg) || 0) / 90) * 90) % 360 + 360) % 360;

/** The page as displayed: CropBox, /Rotate and the visual width/height. */
export function displayedPage(page) {
  const crop = page.getCropBox();
  const rot = quarter(page.getRotation().angle);
  const swaps = rot === 90 || rot === 270;
  return { crop, rot, width: swaps ? crop.height : crop.width, height: swaps ? crop.width : crop.height };
}

/**
 * Top-left of a `w` × `h` box at `position` on a `pageW` × `pageH` page
 * (display space, y down), `margin` points from the edges it touches.
 */
export function stampPosition(position, pageW, pageH, w, h, margin = 36) {
  const [row, col] = position === 'center' ? ['middle', 'center'] : String(position || 'top-right').split('-');
  const x = col === 'left' ? margin : col === 'center' ? (pageW - w) / 2 : pageW - w - margin;
  const y = row === 'top' ? margin : row === 'middle' ? (pageH - h) / 2 : pageH - h - margin;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/**
 * The stamp markup model a placement on this page would make (as
 * placeDynamicStamp in annotations/stamps.js): display coordinates, design
 * evaluated now, the sheet-size scale.
 */
export function batchStampModel(template, { pageNum, pageW, pageH, position, margin, fields }) {
  const design = instantiateStampTemplate(template, { ...fields, page: pageNum });
  if (!design) return null;
  const natural = stampDesignSize(design);
  const scale = dynamicStampScale({ breedte: pageW, hoogte: pageH });
  const width = natural.width * scale;
  const height = natural.height * scale;
  const { x, y } = stampPosition(position, pageW, pageH, width, height, margin);
  return createAnnotation({
    type: 'stamp', page: pageNum, x, y, width, height, layer: undefined,
    stampName: design.name, stampText: stampDesignText(design), stampTemplateId: design.templateId,
    stampDesign: design, stampColor: design.color, color: design.color, strokeColor: design.color,
    opacity: 1, lockAspectRatio: true, rotation: 0, author: fields.user,
  });
}

/**
 * Write one stamp model onto its pdf-lib page, the way the saver writes a
 * dynamic stamp. Returns the new annotation's ref.
 */
export async function writeBatchStamp(pdfDocLib, page, ann, { now } = {}) {
  const context = pdfDocLib.context;
  const { crop, rot } = displayedPage(page);
  const saved = rot ? { ...ann, ..._remapRect(ann, _rotVisualMapper(rot, crop.width, crop.height)) } : ann;
  const convertX = (canvasX) => canvasX + crop.x;
  const convertY = (canvasY) => crop.y + crop.height - canvasY;
  const design = ann.stampDesign;
  const rect = stampDesignRect(saved, convertX, convertY);
  const opacity = saved.opacity !== undefined ? saved.opacity : 1;
  const annotDict = context.obj(stampAnnotObject(saved, { rect, colorArr: hexToColorArray(saved.color || '#000000'), opacity, now }));
  annotDict.set(PDFName.of('C'), context.obj(hexToColorArray(design.color)));
  await writeStampDesignAppearance(pdfDocLib, annotDict, saved, design, { rect, pageRot: rot });
  zetDoorzichtigheidInAp(context, annotDict, opacity);
  const ref = context.register(annotDict);
  const existing = page.node.get(PDFName.of('Annots'));
  const annots = existing ? context.lookup(existing) : null;
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), context.obj([ref]));
  return ref;
}

/**
 * Stamp `pages` (1-based) of a loaded file.
 * @param {import('pdf-lib').PDFDocument} pdfDocLib
 * @param {object} template  a built-in or user stamp template
 * @param {{ pages:number[], position?:string, margin?:number, now:Date, user:string,
 *           fileName:string, pageLabels?:(string|null)[] }} options
 * @returns {Promise<object[]>} the placed models
 */
export async function placeBatchStamps(pdfDocLib, template, { pages, position = 'top-right', margin = 36, now, user, fileName, pageLabels = [] }) {
  const placed = [];
  for (const pageNum of pages) {
    const page = pdfDocLib.getPage(pageNum - 1);
    const shown = displayedPage(page);
    const label = pageLabels?.[pageNum - 1];
    const ann = batchStampModel(template, {
      pageNum, pageW: shown.width, pageH: shown.height, position, margin,
      fields: { now, user, pageLabel: typeof label === 'string' ? label : '', fileName },
    });
    if (!ann) throw new Error('The stamp template is not valid.');
    await writeBatchStamp(pdfDocLib, page, ann, { now });
    placed.push(ann);
  }
  return placed;
}

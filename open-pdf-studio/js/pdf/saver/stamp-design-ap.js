// PDF appearance of a dynamic stamp (docs/reference/editor/markup-tools.md): vector borders, text in
// the standard Helvetica fonts and an optional embedded image, drawn from the
// same layout as the canvas (annotations/stamp-layout.js), so another viewer
// shows what OcuDraw shows. The design itself goes in /OPS_StampDesign, so
// the app restores the stamp (and its template id) on reopen.

import { PDFHexString, PDFName } from 'pdf-lib';
import { layoutStampDesign } from '../../annotations/stamp-layout.js';
import { winAnsiLiteral } from './pdf-text.js';

export const STAMP_DESIGN_KEY = 'OPS_StampDesign';
const n = (v) => {
  const r = Number(Number(v).toFixed(4));
  return Object.is(r, -0) ? '0' : String(r);
};

function rgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(String(hex || ''));
  return m ? [1, 2, 3].map(i => n(parseInt(m[i], 16) / 255)) : ['0', '0', '0'];
}

/** The page-/Rotate compensation of the saver (saver.js pageCompensationForAp). */
export function pageCompensation(w, h, pageRot) {
  const rot = ((pageRot % 360) + 360) % 360;
  const swaps = rot === 90 || rot === 270;
  const visW = swaps ? h : w, visH = swaps ? w : h;
  const apRotation = (((-rot) % 360) + 360) % 360;
  if (apRotation === 0) return { prefix: '', visW, visH, swaps };
  const rad = -apRotation * Math.PI / 180;
  const c = Math.round(Math.cos(rad) * 1e6) / 1e6, s = Math.round(Math.sin(rad) * 1e6) / 1e6;
  const prefix = `1 0 0 1 ${n(w / 2)} ${n(h / 2)} cm\n${n(c)} ${n(s)} ${n(-s)} ${n(c)} 0 0 cm\n` +
    `1 0 0 1 ${n(-visW / 2)} ${n(-visH / 2)} cm\n`;
  return { prefix, visW, visH, swaps };
}

/**
 * The /Rect of a stamp box (saver coordinates: x/y/width/height already in
 * the unrotated page frame), widened to hold the box at its rotation.
 */
export function stampDesignRect(ann, convertX, convertY) {
  const x1 = convertX(ann.x), y1 = convertY(ann.y + ann.height);
  const x2 = convertX(ann.x + ann.width), y2 = convertY(ann.y);
  const rad = (ann.rotation || 0) * Math.PI / 180;
  if (!rad) return [x1, y1, x2, y2];
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const w = ann.width * c + ann.height * s, h = ann.width * s + ann.height * c;
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

function pathFor(b, H) {
  const y = H - b.y - b.h; // bottom in y-up
  if (!b.r) return `${n(b.x)} ${n(y)} ${n(b.w)} ${n(b.h)} re\n`;
  const k = 0.5522847498 * b.r, r = b.r, x0 = b.x, x1 = b.x + b.w, y0 = y, y1 = y + b.h;
  return `${n(x0 + r)} ${n(y0)} m ${n(x1 - r)} ${n(y0)} l ${n(x1 - r + k)} ${n(y0)} ${n(x1)} ${n(y0 + r - k)} ${n(x1)} ${n(y0 + r)} c\n` +
    `${n(x1)} ${n(y1 - r)} l ${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} c\n` +
    `${n(x0 + r)} ${n(y1)} l ${n(x0 + r - k)} ${n(y1)} ${n(x0)} ${n(y1 - r + k)} ${n(x0)} ${n(y1 - r)} c\n` +
    `${n(x0)} ${n(y0 + r)} l ${n(x0)} ${n(y0 + r - k)} ${n(x0 + r - k)} ${n(y0)} ${n(x0 + r)} ${n(y0)} c h\n`;
}

/**
 * The appearance content stream for a design in a /BBox of rectW × rectH.
 * boxW/boxH: the stamp box (unrotated page frame, as the saver has them);
 * rotation: the stamp rotation in degrees (clockwise on screen).
 * @returns {{ content: string, fonts: Set<'F1'|'F2'>, image: boolean, opacity: number }}
 */
export function stampDesignContent(design, { rectW, rectH, boxW, boxH, pageRot = 0, rotation = 0, opacity = 1 }) {
  const layout = layoutStampDesign(design);
  const { prefix, visW, visH, swaps } = pageCompensation(rectW, rectH, pageRot);
  const bw = swaps ? boxH : boxW, bh = swaps ? boxW : boxH;
  const [r, g, b] = rgb(design.color);
  const fonts = new Set();
  let s = `q\n${prefix}`;
  if (opacity < 1) s += '/GS0 gs\n';
  const rad = -(rotation || 0) * Math.PI / 180;
  const c = Math.round(Math.cos(rad) * 1e6) / 1e6, sn = Math.round(Math.sin(rad) * 1e6) / 1e6;
  s += `1 0 0 1 ${n(visW / 2)} ${n(visH / 2)} cm\n${n(c)} ${n(sn)} ${n(-sn)} ${n(c)} 0 0 cm\n` +
    `1 0 0 1 ${n(-bw / 2)} ${n(-bh / 2)} cm\n` +
    `${n(bw / layout.width)} 0 0 ${n(bh / layout.height)} 0 0 cm\n`;
  const H = layout.height;
  if (layout.borders.length) {
    s += `${r} ${g} ${b} RG\n[] 0 d\n1 j\n`;
    for (const border of layout.borders) s += `${n(border.lw)} w\n${pathFor(border, H)}S\n`;
  }
  const image = !!(layout.image && design.image);
  if (image) {
    const im = layout.image;
    s += `q\n${n(im.w)} 0 0 ${n(im.h)} ${n(im.x)} ${n(H - im.y - im.h)} cm\n/Im0 Do\nQ\n`;
  }
  if (layout.texts.length) {
    s += `${r} ${g} ${b} rg\n`;
    for (const text of layout.texts) {
      const f = text.bold ? 'F2' : 'F1';
      fonts.add(f);
      s += `BT\n/${f} ${n(text.size)} Tf\n${n(text.x)} ${n(H - text.baseline)} Td\n(${winAnsiLiteral(text.text)}) Tj\nET\n`;
    }
  }
  s += 'Q\n';
  return { content: s, fonts, image, opacity };
}

async function embedImage(pdfDocLib, dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = typeof Buffer !== 'undefined'
    ? Uint8Array.from(Buffer.from(base64, 'base64'))
    : Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
  return /^data:image\/jpeg/u.test(dataUrl) ? pdfDocLib.embedJpg(bytes) : pdfDocLib.embedPng(bytes);
}

/**
 * Write /AP /N, /OPS_StampDesign and /OPS_StampText on a stamp dict.
 * @param {{ rect: number[], pageRot: number }} where  rect: the /Rect written
 */
export async function writeStampDesignAppearance(pdfDocLib, annotDict, ann, design, { rect, pageRot = 0 }) {
  const context = pdfDocLib.context;
  const rectW = Math.abs(rect[2] - rect[0]), rectH = Math.abs(rect[3] - rect[1]);
  const opacity = typeof ann.opacity === 'number' && ann.opacity >= 0 && ann.opacity < 1 ? ann.opacity : 1;
  const ap = stampDesignContent(design, { rectW, rectH, boxW: ann.width, boxH: ann.height,
    pageRot, rotation: ann.rotation || 0, opacity });
  const resources = {};
  if (ap.fonts.size) {
    const fontDicts = {};
    for (const f of ap.fonts) {
      fontDicts[f] = context.obj({ Type: 'Font', Subtype: 'Type1',
        BaseFont: f === 'F2' ? 'Helvetica-Bold' : 'Helvetica', Encoding: 'WinAnsiEncoding' });
    }
    resources.Font = context.obj(fontDicts);
  }
  let content = ap.content;
  if (ap.image) {
    try {
      const embedded = await embedImage(pdfDocLib, design.image.dataUrl);
      resources.XObject = context.obj({ Im0: embedded.ref });
    } catch {
      content = content.replace(/q\n[^\n]*cm\n\/Im0 Do\nQ\n/u, '');
    }
  }
  if (opacity < 1) {
    resources.ExtGState = context.obj({ GS0: context.register(context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity })) });
  }
  const stream = context.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rectW, rectH], Resources: context.obj(resources),
  });
  annotDict.set(PDFName.of('AP'), context.obj({ N: context.register(stream) }));
  // The box as the screen shows it (the saver's width/height are swapped on
  // a /Rotate 90/270 page), so the loader restores it inside the /Rect.
  const swaps = [90, 270].includes(((pageRot % 360) + 360) % 360);
  const stored = { ...design, box: swaps ? [ann.height, ann.width] : [ann.width, ann.height] };
  annotDict.set(PDFName.of(STAMP_DESIGN_KEY), PDFHexString.fromText(JSON.stringify(stored)));
  annotDict.set(PDFName.of('OPS_StampText'), PDFHexString.fromText(design.lines.map(item => item.text).join('\n')));
}

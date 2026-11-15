// A synthetic externally marked sheet (docs/reference/editor/markup-interop.md). Built with pdf-lib
// to reproduce the dictionary shapes external plan-review files writes — keys, /IT values,
// /Measure, nested appearance forms, /Image, groups — with made-up text and
// geometry. No real drawing is copied.

import { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFBool, PDFRawStream, PDFArray } from 'pdf-lib';

const N = (s) => PDFName.of(s);
const S = (s) => PDFString.of(s);
const DATUM = "D:20260311143527-05'00'";
const RC_KOP = '<?xml version="1.0"?><body xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:contentType="text/html" xfa:APIVersion="BluebeamPDFRevu:2018" xfa:spec="2.2.0"';

let nmTeller = 0;
const nm = () => S(`QQQQQQQQQQQQ${String.fromCharCode(65 + Math.floor(nmTeller / 26) % 26)}${String.fromCharCode(65 + (nmTeller++ % 26))}AA`);

function stroom(context, inhoud, dict) {
  const bytes = new TextEncoder().encode(inhoud);
  return context.register(PDFRawStream.of(context.obj({ ...dict, Length: bytes.length }), bytes));
}

function formAp(context, bbox, inhoud, resources = {}, matrix = [1, 0, 0, 1, -bbox[0], -bbox[1]]) {
  return context.obj({ N: stroom(context, inhoud, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox, Matrix: matrix,
    Resources: context.obj({ ProcSet: [N('PDF')], ...resources }),
  }) });
}

function basis(context, page, subtype, subj, rect) {
  return {
    Type: 'Annot', Subtype: subtype, P: page.ref, F: 4, Rect: rect,
    T: S('Tester'), Subj: S(subj), NM: nm(), CreationDate: S(DATUM), M: S(DATUM),
  };
}

/** 4x2 RGB test picture (Flate-free raw samples). */
function plaatje(context) {
  const px = new Uint8Array(4 * 2 * 3);
  for (let i = 0; i < px.length; i += 3) { px[i] = (i * 37) % 256; px[i + 1] = 90; px[i + 2] = 200; }
  return context.register(PDFRawStream.of(context.obj({
    Type: 'XObject', Subtype: 'Image', Width: 4, Height: 2, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Length: px.length,
  }), px));
}

/**
 * @returns {Promise<{ bytes: Uint8Array, refs: Record<string, string> }>}
 *   refs: name -> "n 0 R" of each markup
 */
export async function bouwExtBlad() {
  nmTeller = 0;
  const doc = await PDFDocument.create();
  doc.setProducer('Bluebeam PDF Library 21');
  doc.setCreator('an external plan-review program x64');
  const page = doc.addPage([1224, 792]);
  const ctx = doc.context;
  const refs = {};
  const annots = [];
  const voeg = (naam, dict) => {
    const ref = ctx.register(dict);
    refs[naam] = ref.tag;
    annots.push(ref);
    return ref;
  };

  // Rectangle, 50% fill, Multiply: the external editor nests the fill in a form XObject.
  const binnen = stroom(ctx, '/R1 gs 1 0.5 0 rg 0 0 200 100 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 100],
    Resources: ctx.obj({ ExtGState: ctx.obj({ R1: ctx.obj({ ca: 0.5, CA: 0.5 }) }) }),
  });
  const rechthoek = ctx.obj({
    ...basis(ctx, page, 'Square', 'Rectangle', [100, 500, 300, 600]),
    C: [1, 0.5, 0], IC: [1, 0.5, 0], BS: ctx.obj({ W: 0, S: N('S'), Type: N('Border') }), RD: [0, 0, 0, 0],
  });
  rechthoek.set(N('FillOpacity'), PDFNumber.of(0.5));
  rechthoek.set(N('BM'), N('Multiply'));
  rechthoek.set(N('AP'), formAp(ctx, [100, 500, 300, 600], 'q /R0 gs 1 0 0 1 100 500 cm /MWFOForm Do Q',
    { ExtGState: ctx.obj({ R0: ctx.obj({ BM: N('Multiply') }) }), XObject: ctx.obj({ MWFOForm: binnen }) }));
  const rechthoekRef = voeg('rechthoek', rechthoek);

  // A group: a text box that belongs to the rectangle (/IRT + /RT /Group).
  const groepTekst = ctx.obj({
    ...basis(ctx, page, 'FreeText', 'Text Box', [120, 540, 280, 560]),
    C: [], DA: S('1 0 0 rg /Helv 12 Tf'), Contents: S('Zone A'),
    DS: S('font: Helvetica 12pt; text-align:center; margin:3pt; line-height:13.8pt; color:#FF0000'),
    RC: S(`${RC_KOP} style="font:Helvetica 12pt; text-align:center; line-height:13.8pt; color:#FF0000" xmlns="http://www.w3.org/1999/xhtml"><p>Zone A</p></body>`),
    BS: ctx.obj({ W: 0, S: N('S'), Type: N('Border') }),
    IRT: rechthoekRef, RT: N('Group'),
  });
  groepTekst.set(N('AP'), formAp(ctx, [120, 540, 280, 560], 'BT 1 0 0 rg /Helv 12 Tf 180 545 Td (Zone A) Tj ET',
    { Font: ctx.obj({ Helv: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) }) }));
  voeg('groepTekst', groepTekst);
  rechthoek.set(N('GroupNesting'), ctx.obj([S('Group'), N(groepTekst.lookup(N('NM')).decodeText())]));

  // Typewriter text.
  const typ = ctx.obj({
    ...basis(ctx, page, 'FreeText', 'Typewritten Text', [400, 700, 520, 722]),
    C: [1, 1, 1], DA: S('0 0 0 rg /Helv 14 Tf'), IT: N('FreeTextTypeWriter'), Contents: S('Level 2'),
    DS: S('font: Helvetica 14pt; text-align:left; margin:3pt; line-height:16.1pt; color:#000000'),
    RC: S(`${RC_KOP} style="font:Helvetica 14pt; text-align:left; margin:3pt; line-height:16.1pt; color:#000000" xmlns="http://www.w3.org/1999/xhtml"><p>Level 2</p></body>`),
    BS: ctx.obj({ W: 0, S: N('S'), Type: N('Border') }), LEIC: [1, 1, 0],
  });
  typ.set(N('AP'), formAp(ctx, [400, 700, 520, 722], 'BT 0 0 0 rg /Helv 14 Tf 403 705 Td (Level 2) Tj ET'));
  voeg('typemachine', typ);

  // Callout with a closed arrow, leader interior colour and rich text.
  const callout = ctx.obj({
    ...basis(ctx, page, 'FreeText', 'Callout', [600, 400, 900, 520]),
    C: [1, 1, 1], DA: S('0 0.5019608 0 rg /Helv 12 Tf'), IT: N('FreeTextCallout'), Contents: S('See detail 4'),
    DS: S('font: Helvetica 12pt; text-align:center; text-valign:middle; margin:3pt; line-height:13.8pt; color:#008000'),
    RC: S(`${RC_KOP} style="font:Helvetica 12pt; text-align:center; text-valign:middle; line-height:13.8pt; color:#008000" xmlns="http://www.w3.org/1999/xhtml"><p>See detail 4</p></body>`),
    BS: ctx.obj({ W: 0.75, S: N('S'), Type: N('Border') }), LE: N('ClosedArrow'), LEIC: [0, 0.5, 0],
    RD: [100, 4, 4, 60], CL: [605, 405, 650, 480, 700, 480],
  });
  callout.set(N('LES'), PDFNumber.of(0.5));
  callout.set(N('AP'), formAp(ctx, [600, 400, 900, 520], '0 0.5 0 RG 0.75 w 700 404 196 52 re S 605 405 m 650 480 l 700 480 l S'));
  voeg('callout', callout);

  // Area measurement, 0.1370578 in = 3 ft: one point is 0.304008 ft.
  const meetPunten = [100, 100, 400, 100, 400, 300, 100, 300];
  const measure = ctx.register(ctx.obj({
    Type: 'Measure', Subtype: 'RL', R: S("0.1370578 in = 3 ft' in\""),
    X: [ctx.obj({ Type: 'NumberFormat', U: S("'"), C: 0.304008, F: N('F'), D: 8, FD: PDFBool.True, SS: S('') })],
    D: [ctx.obj({ Type: 'NumberFormat', U: S("'"), C: 1, F: N('F'), D: 8, FD: PDFBool.True, SS: S('-') }),
      ctx.obj({ Type: 'NumberFormat', U: S('"'), C: 12, F: N('F'), D: 8, FD: PDFBool.True, SS: S('') })],
    A: [ctx.obj({ Type: 'NumberFormat', U: S('sf'), C: 1, D: 1000, FD: PDFBool.True, SS: S('') })],
    TargetUnitConversion: 0.001157407,
  }));
  const vlakWaarde = 300 * 200 * 0.304008 * 0.304008;
  const meting = ctx.obj({
    ...basis(ctx, page, 'Polygon', 'Area Measurement', [95, 95, 405, 305]),
    C: [0, 0, 1], IC: [0.78, 0.78, 0.78], Vertices: meetPunten, IT: N('PolygonDimension'),
    Contents: S(`${vlakWaarde.toLocaleString('en-US', { maximumFractionDigits: 2 })} sf`),
    BS: ctx.obj({ W: 5, S: N('S'), Type: N('Border') }), Measure: measure,
    DS: S('font: Helvetica 12pt; text-align:center; color:#0000FF'),
  });
  for (const [k, v] of [['FillOpacity', PDFNumber.of(0.3)], ['AlignOnSegment', PDFBool.True], ['MeasurementTypes', PDFNumber.of(129)],
    ['SlopeType', PDFNumber.of(0)], ['PitchRun', PDFNumber.of(12)], ['Label', S('')]]) meting.set(N(k), v);
  meting.set(N('DepthUnit'), ctx.obj([ctx.obj({ Type: 'NumberFormat', U: S("'"), C: 0.001157407, D: 100, FD: PDFBool.True, SS: S('') })]));
  meting.set(N('AP'), formAp(ctx, [95, 95, 405, 305], '0 0 1 RG 5 w 100 100 m 400 100 l 400 300 l 100 300 l h S'));
  voeg('meting', meting);

  // A polygon the external editor rotated: unrotated /Vertices (tall), /Rotation 270 (wide on the sheet).
  const draai = ctx.obj({
    ...basis(ctx, page, 'Polygon', 'Polygon', [850, 150, 1050, 250]),
    C: [1, 0.5, 0], IC: [0.78, 0.78, 0.78], Vertices: [900, 100, 1000, 100, 1000, 300, 900, 300],
    BS: ctx.obj({ W: 2, S: N('S'), Type: N('Border') }),
  });
  draai.set(N('FillOpacity'), PDFNumber.of(0.5));
  draai.set(N('Rotation'), PDFNumber.of(270));
  draai.set(N('AP'), formAp(ctx, [900, 100, 1000, 300], '1 0.5 0 RG 2 w 900 100 100 200 re S', {}, [0, 1, -1, 0, 1150, -750]));
  voeg('gedraaid', draai);

  // Image rectangle (SquareImage) with /Image shared by the appearance.
  const beeld = plaatje(ctx);
  const vierkantBeeld = ctx.obj({
    ...basis(ctx, page, 'Square', 'Image', [100, 650, 300, 750]),
    C: [1, 0, 0], RD: [0, 0, 0, 0], IT: N('SquareImage'), Image: beeld,
    BS: ctx.obj({ W: 0, S: N('S'), Type: N('Border') }),
  });
  vierkantBeeld.set(N('AP'), formAp(ctx, [100, 650, 300, 750], 'q 200 0 0 100 100 650 cm /Image Do Q', { XObject: ctx.obj({ Image: beeld }) }));
  voeg('beeld', vierkantBeeld);

  // Snapshot stamp, turned a quarter.
  const snap = ctx.obj({
    ...basis(ctx, page, 'Stamp', 'Snapshot', [1000, 600, 1080, 760]),
    C: [1, 0, 0], IT: N('StampSnapshot'), BS: ctx.obj({ W: 0, S: N('S'), Type: N('Border') }), Rotation: 90,
  });
  snap.set(N('SetOpacityFromStampFile'), PDFHexString.fromText('false'));
  snap.set(N('AP'), formAp(ctx, [0, 0, 160, 80], 'q 160 0 0 80 0 0 cm /Im Do Q', { XObject: ctx.obj({ Im: beeld }) }, [0, -1, 1, 0, 1000, 760]));
  voeg('snapshot', snap);

  // A plain the external editor line without private keys, and a popup on the rectangle.
  const lijn = ctx.obj({
    ...basis(ctx, page, 'Line', 'Line', [95, 395, 405, 405]), C: [0, 0, 0], L: [100, 400, 400, 400],
    BS: ctx.obj({ W: 1, S: N('S'), Type: N('Border') }),
  });
  lijn.set(N('SlopeType'), PDFNumber.of(0));
  lijn.set(N('PitchRun'), PDFNumber.of(12));
  lijn.set(N('AP'), formAp(ctx, [95, 395, 405, 405], '0 0 0 RG 1 w 100 400 m 400 400 l S'));
  voeg('lijn', lijn);
  const popup = ctx.obj({ Type: 'Annot', Subtype: 'Popup', P: page.ref, F: 4, Rect: [300, 600, 480, 720], Parent: rechthoekRef, NM: nm(), M: S(DATUM) });
  const popupRef = voeg('popup', popup);
  rechthoek.set(N('Popup'), popupRef);

  page.node.set(N('Annots'), ctx.obj(annots));
  return { bytes: await doc.save({ useObjectStreams: false }), refs, vlakWaarde };
}

/** Every key and value of a dictionary, references resolved (one level of
 * nesting deep enough for the external editor markups), for byte-level dict comparison. */
export function dictTekst(context, dict, diepte = 0, gezien = new Set()) {
  let verwijzing = false;
  const waarde = (v) => {
    if (v instanceof PDFArray) return `[${v.asArray().map(waarde).join(' ')}]`;
    if (v && typeof v.objectNumber === 'number') {
      if (gezien.has(v.tag) || diepte > 4 || verwijzing) return `@${v.objectNumber}`;
      gezien.add(v.tag);
      const doel = context.lookup(v);
      if (doel?.dict && typeof doel.getContents === 'function') {
        return `@${v.objectNumber}=stream(${Buffer.from(doel.getContents()).toString('base64')})${dictTekst(context, doel.dict, diepte + 1, gezien)}`;
      }
      return `@${v.objectNumber}=${doel?.entries ? dictTekst(context, doel, diepte + 1, gezien) : String(doel)}`;
    }
    if (v?.entries) return dictTekst(context, v, diepte + 1, gezien);
    return String(v);
  };
  return `<<${dict.entries().filter(([k]) => k.asString() !== '/P' && k.asString() !== '/Parent')
    .map(([k, v]) => {
      // Links to other markups compare by object number, not by content.
      verwijzing = ['/IRT', '/Popup'].includes(k.asString());
      const t = `${k.asString()} ${waarde(v)}`;
      verwijzing = false;
      return t;
    }).sort().join(' ')}>>`;
}

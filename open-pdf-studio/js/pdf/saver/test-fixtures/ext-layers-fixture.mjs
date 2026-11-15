// A synthetic externally marked sheet WITH markup layers (docs/reference/editor/layers.md).
// Built with pdf-lib to mimic what the external editor writes for Layers-panel layers:
// /OCProperties with plain OCGs (only /Type /Name, optional /Intent and
// /Usage), a /D configuration with /Order, /ON, /OFF, /Locked and /RBGroups,
// and markups that point at an OCG with /OC. A drawing layer ("A-WALL") is
// also an OCG, but switched by marked content in the page itself: that one
// stays a native drawing layer (K-001). Made-up text and geometry.

import { PDFDocument, PDFName, PDFString, PDFRawStream } from 'pdf-lib';

const N = (s) => PDFName.of(s);
const S = (s) => PDFString.of(s);
const DATUM = "D:20260914101500-05'00'";

let teller = 0;
const nm = () => S(`LAYRQQQQQQQQQQ${String.fromCharCode(65 + Math.floor(teller / 26) % 26)}${String.fromCharCode(65 + (teller++ % 26))}`);

function stroom(context, inhoud, dict = {}) {
  const bytes = new TextEncoder().encode(inhoud);
  return context.register(PDFRawStream.of(context.obj({ ...dict, Length: bytes.length }), bytes));
}

function ap(context, bbox, inhoud) {
  return context.obj({ N: stroom(context, inhoud, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox, Matrix: [1, 0, 0, 1, -bbox[0], -bbox[1]],
    Resources: context.obj({ ProcSet: [N('PDF')] }),
  }) });
}

/**
 * @returns {Promise<{bytes: Uint8Array, refs: Record<string,string>, ocg: Record<string,string>}>}
 *   refs: markup name -> "n 0 R"; ocg: layer name -> "n 0 R"
 */
export async function bouwExtLagenBlad() {
  teller = 0;
  const doc = await PDFDocument.create();
  doc.setProducer('Bluebeam PDF Library 21');
  doc.setCreator('an external plan-review program x64');
  const page = doc.addPage([1224, 792]);
  const ctx = doc.context;

  const wand = ctx.register(ctx.obj({ Type: 'OCG', Name: S('A-WALL') }));
  const elektra = ctx.register(ctx.obj({ Type: 'OCG', Name: S('Electrical'), Intent: N('View') }));
  const loodgieter = ctx.register(ctx.obj({ Type: 'OCG', Name: S('Plumbing'),
    Usage: { Print: { PrintState: N('OFF') } } }));
  doc.catalog.set(N('OCProperties'), ctx.obj({
    OCGs: [wand, elektra, loodgieter],
    D: { Name: S('Default'), BaseState: N('ON'), Order: [wand, elektra, loodgieter],
      ON: [wand, elektra], OFF: [loodgieter], Locked: [], RBGroups: [] },
  }));

  // The drawing: a wall on the A-WALL layer (marked content /OC /MC0).
  page.node.set(N('Resources'), ctx.obj({ Properties: { MC0: wand } }));
  page.node.set(N('Contents'), stroom(ctx, '/OC /MC0 BDC 0 0 0 RG 4 w 100 100 m 1100 100 l S EMC\n'));

  const refs = {};
  const annots = [];
  const voeg = (naam, dict) => {
    const ref = ctx.register(ctx.obj(dict));
    refs[naam] = ref.tag;
    annots.push(ref);
    return ref;
  };
  const basis = (subtype, subj, rect, oc) => ({
    Type: 'Annot', Subtype: subtype, P: page.ref, F: 4, Rect: rect, T: S('the external editor tester'), Subj: S(subj),
    NM: nm(), CreationDate: S(DATUM), M: S(DATUM), ...(oc ? { OC: oc } : {}),
  });
  voeg('stopcontact', { ...basis('Square', 'Rectangle', [200, 300, 260, 340], elektra),
    C: [1, 0, 0], BS: { W: 2 }, FillOpacity: 0.5,
    AP: ap(ctx, [200, 300, 260, 340], '1 0 0 RG 2 w 201 301 58 38 re S\n') });
  voeg('kabel', { ...basis('Line', 'Line', [300, 300, 500, 360], elektra),
    L: [300, 310, 500, 350], C: [1, 0, 0], BS: { W: 2 },
    AP: ap(ctx, [300, 300, 500, 360], '1 0 0 RG 2 w 300 310 m 500 350 l S\n') });
  voeg('afvoer', { ...basis('Circle', 'Ellipse', [600, 300, 660, 360], loodgieter),
    C: [0, 0, 1], BS: { W: 2 },
    AP: ap(ctx, [600, 300, 660, 360], '0 0 1 RG 2 w 630 301 m 660 330 l 630 359 l 600 330 l h S\n') });
  voeg('los', { ...basis('Square', 'Rectangle', [800, 300, 860, 340]),
    C: [0, 0.5, 0], BS: { W: 2 },
    AP: ap(ctx, [800, 300, 860, 340], '0 0.5 0 RG 2 w 801 301 58 38 re S\n') });
  page.node.set(N('Annots'), ctx.obj(annots));

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, refs, ocg: { 'A-WALL': wand.tag, Electrical: elektra.tag, Plumbing: loodgieter.tag } };
}

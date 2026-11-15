// Annotatielagen in de PDF (#468) — schrijven en lezen, zonder app-state.
//
// Per laag een optional content group (OCG). Daarmee zijn de lagen ook in
// andere PDF-lezers aan en uit te zetten (hetzelfde mechanisme als de lagen
// van een tekening, #377):
//
//   /Root
//     /OCProperties <<
//       /OCGs [ …lagen van de tekening…  ocgStandaard ocgA ocgB ]
//       /D << /Order [ …tekening…  ocgStandaard ocgA ocgB ]
//             /OFF   [ …tekening…  uitgezette annotatielagen ]
//             /AS    [ << /Event /Print /OCGs [niet-afdrukbare lagen]
//                         /Category [/Print] /OPS_AnnotLayers true >> ] >>
//     >>
//     /OPS_AnnotLayers << /Layers [ocgStandaard ocgA ocgB] /Current (id) >>
//
//   OCG: << /Type /OCG /Name (Constructie) /OPS_LayerId (l…)
//           /OPS_Color (#ff0000) /OPS_Locked true /OPS_Printable false
//           /Usage << /Print << /PrintState /OFF >> >> >>
//
//   annotatie: /OC ocgA
//
// Naam en zichtbaarheid zijn gewone PDF (/Name, /D /OFF). Niet afdrukbaar
// staat er in twee vormen: /Usage + /AS voor andere lezers, /OPS_Printable
// voor deze app. Wat een OCG niet kent — kleur, vergrendeld, de volgorde van
// het paneel en de huidige laag — staat in eigen OPS_-sleutels.
//
// Lagen van de tekening zelf (een CAD-PDF) blijven staan: alleen de eigen
// OCG's (herkenbaar aan /OPS_LayerId) worden toegevoegd, bijgewerkt of
// verwijderd. Een document zonder lagen raakt het bestand niet aan.
//
// Markeringslagen van een ander programma (the external editor, docs/reference/editor/layers.md): een
// OCG zonder /OPS_LayerId waar markeringen met /OC naar wijzen en die de
// pagina-inhoud nergens gebruikt, is een markeringslaag. De app neemt hem
// over met het id "ocg-<object>-<generatie>" en schrijft bij het opslaan
// hetzelfde OCG-object bij (dan pas met /OPS_LayerId). Een OCG die ook
// tekeninhoud schakelt, blijft een laag van de tekening (K-001).

import { PDFName, PDFArray, PDFDict, PDFRef, PDFBool, PDFStream } from 'pdf-lib';
import { pdfTextString, decodePdfTextObject } from './pdf-text.js';
import {
  DEFAULT_LAYER_ID, layerIdOf, getLayers, layersInUse,
} from '../../annotations/annotatie-lagen.js';

export const LAGEN_CATALOGUS_SLEUTEL = 'OPS_AnnotLayers';

const N = (s) => PDFName.of(s);

function opgezocht(context, raw) {
  return raw instanceof PDFRef ? context.lookup(raw) : raw;
}

function tekst(context, raw) {
  const v = opgezocht(context, raw);
  if (!v) return undefined;
  const t = decodePdfTextObject(v);
  if (t !== undefined) return t;
  return typeof v.decodeText === 'function' ? v.decodeText() : undefined;
}

function isWaar(context, raw) {
  const v = opgezocht(context, raw);
  return v === PDFBool.True || String(v) === 'true';
}

function isOnwaar(context, raw) {
  const v = opgezocht(context, raw);
  return v === PDFBool.False || String(v) === 'false';
}

/** Het laag-id van een eigen OCG (ref of dict), anders undefined. */
function eigenId(context, raw) {
  const dict = opgezocht(context, raw);
  if (!(dict instanceof PDFDict)) return undefined;
  const id = tekst(context, dict.get(N('OPS_LayerId')));
  return typeof id === 'string' && id ? id : undefined;
}

function arrayVan(context, dict, sleutel) {
  if (!(dict instanceof PDFDict)) return null;
  const v = opgezocht(context, dict.get(N(sleutel)));
  return v instanceof PDFArray ? v : null;
}

function isOcg(dict) {
  return dict instanceof PDFDict && String(dict.get(N('Type'))) === '/OCG';
}

// ── Markeringslagen van andere programma's ────────────────────────────────

const VREEMD_ID = /^ocg-(\d+)-(\d+)$/;

/** Het laag-id van een overgenomen OCG: "ocg-12-0". */
export function vreemdLaagId(ref) {
  return `ocg-${ref.objectNumber}-${ref.generationNumber}`;
}

/** De OCG achter een overgenomen laag-id, als die er (nog) een is. */
function refVanVreemdId(context, id) {
  const m = VREEMD_ID.exec(String(id || ''));
  if (!m) return null;
  const ref = PDFRef.of(Number(m[1]), Number(m[2]));
  return isOcg(context.lookup(ref)) ? ref : null;
}

/** De bladen van de paginaboom, met de geërfde /Resources. */
function paginas(context) {
  const catalog = opgezocht(context, context.trailerInfo?.Root);
  const uit = [];
  const gezien = new Set();
  const loop = (raw, resources, diepte) => {
    if (diepte > 64) return;
    if (raw instanceof PDFRef) {
      if (gezien.has(raw.tag)) return;
      gezien.add(raw.tag);
    }
    const node = opgezocht(context, raw);
    if (!(node instanceof PDFDict)) return;
    const eigen = node.get(N('Resources')) ?? resources;
    const kids = opgezocht(context, node.get(N('Kids')));
    if (kids instanceof PDFArray) {
      for (const k of kids.asArray()) loop(k, eigen, diepte + 1);
    } else {
      uit.push({ node, resources: eigen });
    }
  };
  if (catalog instanceof PDFDict) loop(catalog.get(N('Pages')), undefined, 0);
  return uit;
}

/** De OCG's die de pagina-inhoud gebruikt (/Properties, /OC op XObjects, OCMD's), als tags. */
function inhoudOcgTags(context, bladen) {
  const tags = new Set();
  const gezien = new Set();
  const loop = (raw, diepte) => {
    if (diepte > 64 || raw === undefined || raw === null) return;
    let v = raw;
    if (raw instanceof PDFRef) {
      if (gezien.has(raw.tag)) return;
      gezien.add(raw.tag);
      v = context.lookup(raw);
      if (isOcg(v)) { tags.add(raw.tag); return; }
    }
    if (v instanceof PDFStream) v = v.dict;
    if (v instanceof PDFDict) {
      for (const [k, w] of v.entries()) {
        // Een /Parent of /P leidt terug naar de paginaboom, niet naar inhoud.
        const naam = k.asString();
        if (naam === '/Parent' || naam === '/P') continue;
        loop(w, diepte + 1);
      }
    } else if (v instanceof PDFArray) {
      for (const w of v.asArray()) loop(w, diepte + 1);
    }
  };
  for (const { resources } of bladen) loop(resources, 0);
  return tags;
}

const vreemdeCache = new WeakMap();

/**
 * De markeringslagen van andere programma's in een document: id → OCG-ref.
 * Alleen OCG's uit /OCProperties /OCGs, zonder /OPS_LayerId, waar een
 * annotatie met /OC (direct, geen OCMD) naar wijst en die de pagina-inhoud
 * niet gebruikt. Leest alleen; per context één keer berekend.
 * @param {import('pdf-lib').PDFContext} context
 * @returns {Map<string, PDFRef>}
 */
export function vreemdeMarkeringOcgs(context) {
  if (!context) return new Map();
  const bewaard = vreemdeCache.get(context);
  if (bewaard) return bewaard;
  const uit = new Map();
  try {
    const catalog = opgezocht(context, context.trailerInfo?.Root);
    const oc = catalog instanceof PDFDict ? opgezocht(context, catalog.get(N('OCProperties'))) : null;
    const ocgs = arrayVan(context, oc, 'OCGs');
    const vreemd = new Map();
    for (const r of ocgs?.asArray() || []) {
      if (r instanceof PDFRef && isOcg(context.lookup(r)) && !eigenId(context, r)) vreemd.set(r.tag, r);
    }
    if (vreemd.size) {
      const bladen = paginas(context);
      const opAnnotaties = new Set();
      for (const { node } of bladen) {
        const annots = opgezocht(context, node.get(N('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (const a of annots.asArray()) {
          const dict = opgezocht(context, a);
          const ocRef = dict instanceof PDFDict ? dict.get(N('OC')) : undefined;
          if (ocRef instanceof PDFRef && vreemd.has(ocRef.tag)) opAnnotaties.add(ocRef.tag);
        }
      }
      if (opAnnotaties.size) {
        const inhoud = inhoudOcgTags(context, bladen);
        // In de volgorde van /OCGs.
        for (const [tag, ref] of vreemd) {
          if (opAnnotaties.has(tag) && !inhoud.has(tag)) uit.set(vreemdLaagId(ref), ref);
        }
      }
    }
  } catch {
    uit.clear();
  }
  vreemdeCache.set(context, uit);
  return uit;
}

/** Een array in place vullen, zodat een indirect object indirect blijft. */
function vervangInhoud(array, elementen) {
  while (array.size() > 0) array.remove(0);
  for (const e of elementen) array.push(e);
}

/** Eigen refs uit een (mogelijk geneste, zoals /Order) array halen. */
function zonderEigen(context, array, eigen) {
  if (!array) return;
  const over = [];
  for (const e of array.asArray()) {
    if (e instanceof PDFRef && eigen.has(e)) continue;
    const genest = opgezocht(context, e);
    if (genest instanceof PDFArray) zonderEigen(context, genest, eigen);
    over.push(e);
  }
  if (over.length !== array.size()) vervangInhoud(array, over);
}

function ocProperties(pdfDoc) {
  const oc = pdfDoc.catalog.lookup(N('OCProperties'));
  return oc instanceof PDFDict ? oc : null;
}

/** De eigen OCG's in het bestand: id → ref. Leest alleen. */
function eigenOcgs(pdfDoc) {
  const context = pdfDoc.context;
  const uit = new Map();
  const kandidaten = [];
  const eigenLijst = arrayVan(context, opgezocht(context, pdfDoc.catalog.get(N(LAGEN_CATALOGUS_SLEUTEL))), 'Layers');
  if (eigenLijst) kandidaten.push(...eigenLijst.asArray());
  const ocgs = arrayVan(context, ocProperties(pdfDoc), 'OCGs');
  if (ocgs) kandidaten.push(...ocgs.asArray());
  for (const ref of kandidaten) {
    if (!(ref instanceof PDFRef)) continue;
    const id = eigenId(context, ref);
    if (id && !uit.has(id)) uit.set(id, ref);
  }
  return uit;
}

// Onze /AS-regel voor het afdrukken herkennen we aan /OPS_AnnotLayers.
function isEigenAsRegel(context, raw) {
  const d = opgezocht(context, raw);
  return d instanceof PDFDict && d.get(N(LAGEN_CATALOGUS_SLEUTEL)) !== undefined;
}

function zetOfWis(dict, sleutel, waarde) {
  if (waarde === null || waarde === undefined) dict.delete(N(sleutel));
  else dict.set(N(sleutel), waarde);
}

/** Alle sporen van de eigen OCG's uit /OCProperties halen. */
function verwijderEigen(pdfDoc, eigen) {
  const context = pdfDoc.context;
  const oc = ocProperties(pdfDoc);
  if (!oc) return;
  zonderEigen(context, arrayVan(context, oc, 'OCGs'), eigen);
  const d = opgezocht(context, oc.get(N('D')));
  if (d instanceof PDFDict) {
    for (const sleutel of ['Order', 'ON', 'OFF', 'Locked', 'RBGroups']) {
      zonderEigen(context, arrayVan(context, d, sleutel), eigen);
    }
    const as = arrayVan(context, d, 'AS');
    if (as) {
      const over = as.asArray().filter((r) => !isEigenAsRegel(context, r));
      if (over.length !== as.size()) {
        if (over.length === 0) d.delete(N('AS'));
        else vervangInhoud(as, over);
      }
    }
  }
  const ocgs = arrayVan(context, oc, 'OCGs');
  // Zonder één OCG heeft /OCProperties geen betekenis meer.
  if (!ocgs || ocgs.size() === 0) pdfDoc.catalog.delete(N('OCProperties'));
}

/**
 * Schrijf de annotatielagen in het document.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {object[]|null} lagen  de lagen van het model (layersForSave), of null
 *   als het document geen lagen heeft: dan blijft een bestand zonder eigen
 *   lagen byte-voor-byte gelijk, en worden eerder geschreven lagen opgeruimd.
 * @param {{standaardNaam?:string, huidigeLaag?:string|null}} [opties]
 *   standaardNaam: de /Name van de standaardlaag voor andere lezers.
 * @returns {Map<string, PDFRef>|null} laag-id → OCG, voor /OC op de annotaties
 */
export function schrijfAnnotatieLagen(pdfDoc, lagen, { standaardNaam = 'Default', huidigeLaag = null, annotaties = null } = {}) {
  const context = pdfDoc.context;
  const catalog = pdfDoc.catalog;
  const bestaand = eigenOcgs(pdfDoc);
  // Markeringslagen van een ander programma die het bestand al had (vóór
  // deze save: de annotaties staan nog in het bestand).
  const eerderVreemd = new Set(vreemdeMarkeringOcgs(context).values());
  for (const r of arrayVan(context, opgezocht(context, catalog.get(N(LAGEN_CATALOGUS_SLEUTEL))), 'Layers')?.asArray() || []) {
    if (r instanceof PDFRef && isOcg(context.lookup(r)) && !eigenId(context, r)) eerderVreemd.add(r);
  }

  if (!Array.isArray(lagen) || lagen.length === 0) {
    if (bestaand.size === 0 && catalog.get(N(LAGEN_CATALOGUS_SLEUTEL)) === undefined) return null;
    verwijderEigen(pdfDoc, new Set(bestaand.values()));
    catalog.delete(N(LAGEN_CATALOGUS_SLEUTEL));
    return null;
  }

  // De OCG per laag: bestaande hergebruiken (zelfde object, geen groei per save).
  const refs = new Map();
  // Overgenomen markeringslagen (the external editor): hun OCG blijft van dat programma. Die
  // wordt alleen bijgewerkt waar de gebruiker iets veranderde (naam, afdrukken)
  // en blijft op haar plek in /OCGs en /Order.
  const overgenomen = new Set();
  // A file with markup layers of another program (the external editor): its markups without
  // a layer have no /OC there. A plain default layer then stays without an
  // OCG, else every save added an empty "Default" layer to the external editor's list.
  const heeftVreemdeLagen = lagen.some((l) => l && !bestaand.has(l.id) && refVanVreemdId(context, l.id));
  for (const laag of lagen) {
    if (!laag || typeof laag.id !== 'string' || refs.has(laag.id)) continue;
    if (laag.id === DEFAULT_LAYER_ID && heeftVreemdeLagen && !bestaand.has(laag.id)
        && laag.visible !== false && laag.printable !== false && !laag.locked && !laag.color) continue;
    const vreemd = !bestaand.has(laag.id) ? refVanVreemdId(context, laag.id) : null;
    if (vreemd) {
      werkVreemdeOcgBij(context, context.lookup(vreemd), laag);
      overgenomen.add(vreemd);
      refs.set(laag.id, vreemd);
      continue;
    }
    let ref = bestaand.get(laag.id);
    let dict = ref ? context.lookup(ref) : null;
    if (!(dict instanceof PDFDict)) {
      dict = context.obj({});
      ref = context.register(dict);
    }
    const naam = laag.id === DEFAULT_LAYER_ID ? standaardNaam : laag.name;
    dict.set(N('Type'), N('OCG'));
    dict.set(N('Name'), pdfTextString(naam || laag.id));
    dict.set(N('OPS_LayerId'), pdfTextString(laag.id));
    zetOfWis(dict, 'OPS_Color', laag.color ? pdfTextString(laag.color) : null);
    zetOfWis(dict, 'OPS_Locked', laag.locked ? PDFBool.True : null);
    zetOfWis(dict, 'OPS_Printable', laag.printable === false ? PDFBool.False : null);
    zetOfWis(dict, 'Usage', laag.printable === false
      ? context.obj({ Print: { PrintState: 'OFF' } }) : null);
    refs.set(laag.id, ref);
  }
  const eigenRefs = [...refs.values()];
  // Wat verplaatst mag worden (/OCGs, /Order, /Locked): alleen de eigen OCG's.
  const alleEigen = new Set([...bestaand.values(), ...eigenRefs.filter((r) => !overgenomen.has(r))]);
  const nieuwEigen = eigenRefs.filter((r) => !overgenomen.has(r));
  // Zichtbaarheid en afdrukken gelden voor alle markeringslagen.
  const alleLagen = new Set([...alleEigen, ...overgenomen]);

  // /OCProperties: aanvullen, niet overschrijven.
  let oc = ocProperties(pdfDoc);
  if (!oc) {
    oc = context.obj({});
    catalog.set(N('OCProperties'), oc);
  }
  let ocgs = arrayVan(context, oc, 'OCGs');
  if (!ocgs) {
    ocgs = context.obj([]);
    oc.set(N('OCGs'), ocgs);
  }
  const vreemdeOcgs = ocgs.asArray().filter((r) => !(r instanceof PDFRef && alleEigen.has(r)));
  for (const r of overgenomen) if (!vreemdeOcgs.includes(r)) vreemdeOcgs.push(r);
  vervangInhoud(ocgs, [...vreemdeOcgs, ...nieuwEigen]);

  let d = opgezocht(context, oc.get(N('D')));
  if (!(d instanceof PDFDict)) {
    d = context.obj({});
    oc.set(N('D'), d);
  }
  for (const sleutel of ['Locked', 'RBGroups']) zonderEigen(context, arrayVan(context, d, sleutel), alleEigen);

  // Volgorde in het lagenpaneel van andere lezers: de tekening eerst, dan de
  // annotatielagen in de volgorde van ons paneel.
  let order = arrayVan(context, d, 'Order');
  if (order) {
    zonderEigen(context, order, alleEigen);
    for (const r of nieuwEigen) order.push(r);
  } else {
    order = context.obj([...vreemdeOcgs, ...nieuwEigen]);
    d.set(N('Order'), order);
  }

  // Zichtbaarheid: /OFF bij een basisstand AAN (standaard), /ON bij /OFF.
  const basisUit = String(d.get(N('BaseState'))) === '/OFF';
  const verborgen = lagen.filter((l) => l && l.visible === false).map((l) => refs.get(l.id)).filter(Boolean);
  const zichtbaar = eigenRefs.filter((r) => !verborgen.includes(r));
  let uit = arrayVan(context, d, 'OFF');
  let aan = arrayVan(context, d, 'ON');
  // Een overgenomen laag die al goed staat, blijft op haar plek in /ON en /OFF.
  const alGoed = new Set([...overgenomen].filter((r) => {
    const inUit = !!uit?.asArray().includes(r);
    const inAan = !!aan?.asArray().includes(r);
    return basisUit ? (verborgen.includes(r) ? !inAan : inAan && !inUit) : (verborgen.includes(r) ? inUit : !inUit);
  }));
  const teZetten = new Set([...alleLagen].filter((r) => !alGoed.has(r)));
  zonderEigen(context, uit, teZetten);
  zonderEigen(context, aan, teZetten);
  if (basisUit) {
    const erbij = zichtbaar.filter((r) => !alGoed.has(r));
    if (!aan && erbij.length) { aan = context.obj([]); d.set(N('ON'), aan); }
    for (const r of erbij) aan.push(r);
  } else {
    const erbij = verborgen.filter((r) => !alGoed.has(r));
    if (!uit && erbij.length) { uit = context.obj([]); d.set(N('OFF'), uit); }
    for (const r of erbij) uit.push(r);
  }

  // Niet afdrukbaar voor andere lezers: /AS met de gebeurtenis Print. Een
  // overgenomen laag draagt dat al in haar eigen /Usage.
  const nietAfdrukbaar = lagen.filter((l) => l && l.printable === false).map((l) => refs.get(l.id))
    .filter((r) => r && !overgenomen.has(r));
  let as = arrayVan(context, d, 'AS');
  const vreemdeAs = as ? as.asArray().filter((r) => !isEigenAsRegel(context, r)) : [];
  const eigenAs = nietAfdrukbaar.length
    ? [context.obj({ Event: 'Print', OCGs: nietAfdrukbaar, Category: ['Print'], [LAGEN_CATALOGUS_SLEUTEL]: true })]
    : [];
  if (as) {
    if (vreemdeAs.length + eigenAs.length === 0) d.delete(N('AS'));
    else vervangInhoud(as, [...vreemdeAs, ...eigenAs]);
  } else if (eigenAs.length) {
    d.set(N('AS'), context.obj(eigenAs));
  }

  // De volgorde van ons paneel en de huidige laag.
  const eigen = context.obj({ Layers: eigenRefs });
  if (huidigeLaag && huidigeLaag !== DEFAULT_LAYER_ID && refs.has(huidigeLaag)) {
    eigen.set(N('Current'), pdfTextString(huidigeLaag));
  }
  catalog.set(N(LAGEN_CATALOGUS_SLEUTEL), eigen);

  // Lagen die uit het model verdwenen zijn: nergens meer genoemd.
  const weg = new Set([...bestaand].filter(([id]) => !refs.has(id)).map(([, r]) => r));
  // Een overgenomen laag die de gebruiker verwijderde: alleen als geen
  // markering van het model er nog op staat (de aanroeper geeft ze mee).
  if (Array.isArray(annotaties)) {
    const inGebruik = new Set(annotaties.map((a) => a && a.layer).filter(Boolean));
    for (const r of eerderVreemd) {
      if (!overgenomen.has(r) && !inGebruik.has(vreemdLaagId(r))) weg.add(r);
    }
  }
  if (weg.size) verwijderEigen(pdfDoc, weg);

  return refs;
}

/**
 * Een OCG van een ander programma bijwerken naar de laag in het model, maar
 * alleen wat afwijkt: een ongewijzigde laag laat het object zoals het was.
 * Kleur en vergrendeld zijn eigen sleutels (alleen als ze aan staan).
 */
function werkVreemdeOcgBij(context, dict, laag) {
  if (!(dict instanceof PDFDict)) return;
  const naam = laag.name || '';
  if (naam && (tekst(context, dict.get(N('Name'))) || '').trim() !== naam) dict.set(N('Name'), pdfTextString(naam));
  if (laag.color || dict.get(N('OPS_Color'))) zetOfWis(dict, 'OPS_Color', laag.color ? pdfTextString(laag.color) : null);
  if (laag.locked || dict.get(N('OPS_Locked'))) zetOfWis(dict, 'OPS_Locked', laag.locked ? PDFBool.True : null);
  let usage = opgezocht(context, dict.get(N('Usage')));
  const print = usage instanceof PDFDict ? opgezocht(context, usage.get(N('Print'))) : null;
  const nuUit = print instanceof PDFDict && String(print.get(N('PrintState'))) === '/OFF';
  if (laag.printable === false && !nuUit) {
    if (!(usage instanceof PDFDict)) { usage = context.obj({}); dict.set(N('Usage'), usage); }
    usage.set(N('Print'), context.obj({ PrintState: 'OFF' }));
  } else if (laag.printable !== false && nuUit) {
    usage.delete(N('Print'));
    if (usage.keys().length === 0) dict.delete(N('Usage'));
  }
}

/** De OCG voor /OC op een annotatie; een onbekende laag krijgt die van de standaardlaag. */
export function ocVoorAnnotatie(refs, ann) {
  if (!refs) return null;
  return refs.get(layerIdOf(ann)) || refs.get(DEFAULT_LAYER_ID) || null;
}

/** Het laag-id achter /OC van een annotatie, alleen als het een eigen OCG is. */
export function laagVanOc(context, ocRaw) {
  if (!ocRaw) return undefined;
  const eigen = eigenId(context, ocRaw);
  if (eigen || !(ocRaw instanceof PDFRef)) return eigen;
  // Een markeringslaag van een ander programma (the external editor).
  const id = vreemdLaagId(ocRaw);
  return vreemdeMarkeringOcgs(context).get(id)?.tag === ocRaw.tag ? id : undefined;
}

/** Het id dat pdf.js aan een OCG geeft (Ref.toString): "12R", of "12R3". */
function pdfjsId(ref) {
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

/**
 * Lees de annotatielagen uit een document.
 * @returns {{lagen:object[], huidigeLaag:string|null, refs:Map<string,PDFRef>, ocgIds:Set<string>}|null}
 */
export function leesAnnotatieLagen(pdfDoc) {
  try {
    const context = pdfDoc.context;
    const eigen = opgezocht(context, pdfDoc.catalog.get(N(LAGEN_CATALOGUS_SLEUTEL)));
    const vreemd = vreemdeMarkeringOcgs(context);
    const isVreemdeLaag = (r) => r instanceof PDFRef && !eigenId(context, r) && isOcg(context.lookup(r));
    let refs = [];
    const lijst = arrayVan(context, eigen, 'Layers');
    // Onze lijst: eigen OCG's en overgenomen (the external editor) OCG's, in paneelvolgorde.
    if (lijst) refs = lijst.asArray().filter((r) => r instanceof PDFRef && (eigenId(context, r) || isVreemdeLaag(r)));
    if (!refs.some((r) => eigenId(context, r))) refs = [...refs, ...eigenOcgs(pdfDoc).values()];
    refs = [...refs, ...vreemd.values()];
    if (refs.length === 0) return null;

    const d = opgezocht(context, ocProperties(pdfDoc)?.get(N('D')));
    const inLijst = (sleutel) => new Set((arrayVan(context, d, sleutel)?.asArray() || []).filter((r) => r instanceof PDFRef));
    const uit = inLijst('OFF');
    const aan = inLijst('ON');
    const basisUit = d instanceof PDFDict && String(d.get(N('BaseState'))) === '/OFF';

    const lagen = [];
    const perId = new Map();
    for (const ref of refs) {
      const eigenLaag = eigenId(context, ref);
      const id = eigenLaag || vreemdLaagId(ref);
      if (perId.has(id)) continue;
      const dict = context.lookup(ref);
      const kleur = tekst(context, dict.get(N('OPS_Color')));
      // Afdrukken: onze eigen sleutel, of bij een overgenomen laag /Usage /Print.
      let printable = !isOnwaar(context, dict.get(N('OPS_Printable')));
      if (!eigenLaag) {
        const usage = opgezocht(context, dict.get(N('Usage')));
        const print = usage instanceof PDFDict ? opgezocht(context, usage.get(N('Print'))) : null;
        printable = !(print instanceof PDFDict && String(print.get(N('PrintState'))) === '/OFF');
      }
      lagen.push({
        id,
        name: id === DEFAULT_LAYER_ID ? '' : ((tekst(context, dict.get(N('Name'))) || '').trim() || id),
        color: typeof kleur === 'string' && /^#[0-9a-f]{6}$/i.test(kleur) ? kleur.toLowerCase() : null,
        visible: basisUit ? aan.has(ref) : !uit.has(ref),
        printable,
        locked: isWaar(context, dict.get(N('OPS_Locked'))),
      });
      perId.set(id, ref);
    }
    const huidig = eigen instanceof PDFDict ? tekst(context, eigen.get(N('Current'))) : undefined;
    return {
      lagen,
      huidigeLaag: typeof huidig === 'string' && perId.has(huidig) ? huidig : null,
      refs: perId,
      ocgIds: new Set([...perId.values()].map(pdfjsId)),
    };
  } catch {
    return null;
  }
}

/**
 * Gelezen lagen op het document zetten — één keer per document. Een tweede
 * lezing (na het herladen van de bytes) of een document waarop de gebruiker
 * al lagen maakte, blijft ongemoeid: het model is dan de waarheid.
 * @returns {boolean} of het model veranderd is
 */
export function pasGelezenLagenToe(doc, gelezen) {
  if (!doc || doc._annotatieLagenGelezen) return false;
  doc._annotatieLagenGelezen = true;
  if (!gelezen || !Array.isArray(gelezen.lagen) || gelezen.lagen.length === 0) return false;
  if (layersInUse(doc)) return false;
  // Eerst lokaal opschonen, dan één keer toewijzen en teruglezen: het document
  // in de app bewaart bij toewijzen een kopie (zie de schrijfregel in
  // annotations/annotatie-lagen.js).
  const lagen = getLayers({ annotationLayers: gelezen.lagen });
  doc.annotationLayers = lagen;
  doc.currentLayerId = gelezen.huidigeLaag && lagen.some((l) => l.id === gelezen.huidigeLaag)
    ? gelezen.huidigeLaag : null;
  doc._annotatieLaagOcgIds = new Set(gelezen.ocgIds || []);
  const terug = getLayers(doc);
  return terug.length === lagen.length && lagen.every((l, i) => terug[i].id === l.id);
}

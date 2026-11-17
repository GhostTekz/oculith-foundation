import polygonClipping from 'polygon-clipping';
import { expandArcPoints, hasArcPoints } from './arc-points.js';
import { vlakRingen, ringenIndelen, ringOppervlak, vlakOmhullende } from './vlak-ringen.js';

const coordinates = ring => (hasArcPoints(ring) ? expandArcPoints(ring) : ring)
  .map(point => [point.x, point.y]);
const points = ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }));

// Existing extra rings can be holes or additive parts. Give each hole to
// its nearest containing part; islands inside holes remain separate parts.
function polygonsOf(rings) {
  const additive = ringenIndelen(rings);
  const parts = rings.map((ring, index) => ({ ring, index }))
    .filter(({ index }) => additive[index])
    .sort((a, b) => Math.abs(ringOppervlak(a.ring)) - Math.abs(ringOppervlak(b.ring)))
    .map(({ ring }) => ({ shell: coordinates(ring), polygon: [coordinates(ring)] }));
  const stray = [];
  rings.forEach((ring, index) => {
    if (additive[index]) return;
    const hole = coordinates(ring);
    const owner = parts.find(part => polygonClipping.difference([hole], [part.shell]).length === 0);
    // A hole saved partly outside its part (corners inside, an edge across
    // a notch) is still a hole: it is subtracted from the parts below.
    if (owner) owner.polygon.push(hole);
    else stray.push([hole]);
  });
  const polygons = parts.map(part => part.polygon);
  return stray.length && polygons.length ? polygonClipping.difference(polygons, ...stray) : polygons;
}

/**
 * Whether a cutout lies entirely within the area: inside a part and clear of
 * every existing hole. Such a cutout needs no clipping, so the area's rings
 * (and their arcs) can stay exactly as they are.
 */
export function cutoutInsideArea(outer, holes, cutout) {
  const rings = vlakRingen(outer, holes);
  if (!rings.length || !Array.isArray(cutout) || cutout.length < 3) return false;
  // Inside the area is not enough where parts overlap: appended there, the
  // ring would count as one more part (inside an even number of rings).
  const withCutout = vlakRingen(outer, [...(holes || []), cutout]);
  if (withCutout.length !== rings.length + 1 || ringenIndelen(withCutout).at(-1) !== false) return false;
  return polygonClipping.difference([coordinates(cutout)], polygonsOf(rings)).length === 0;
}

/** Subtract a drawn cutout without changing the annotation. Null is a no-op. */
export function subtractAreaCutout(outer, holes, cutout) {
  const rings = vlakRingen(outer, holes);
  if (!rings.length || !Array.isArray(cutout) || cutout.length < 3) return null;
  const shape = polygonsOf(rings);
  const cut = [coordinates(cutout)];
  const intersection = polygonClipping.intersection(shape, cut);
  if (!intersection.length) return null;
  const remaining = polygonClipping.difference(shape, cut);
  if (!remaining.length) return { empty: true };

  // A first cutout keeps the original contour and its arc metadata. Clip
  // the new hole to it so crossing the boundary cannot create an extra part.
  if (rings.length === 1) {
    const clipped = intersection.flatMap(polygon => polygon.map(points));
    return { points: outer, holes: clipped };
  }

  // Subsequent cuts may merge holes or split the area. Canonical rings keep
  // every remaining part and count overlapping cutouts only once.
  const ordered = [...remaining].sort((a, b) =>
    Math.abs(ringOppervlak(points(b[0]))) - Math.abs(ringOppervlak(points(a[0]))));
  const [first, ...others] = ordered;
  return {
    points: points(first[0]),
    holes: [...first.slice(1), ...others.flat()].map(points),
  };
}

/** Keep an existing geometry cache in step with the remaining area. */
export function applyAreaCutout(annotation, result) {
  annotation.points = result.points;
  annotation.holes = result.holes;
  if (Number.isFinite(annotation.x) && Number.isFinite(annotation.y)) {
    const bounds = vlakOmhullende(result.points, result.holes);
    if (bounds) {
      annotation.x = bounds.minX;
      annotation.y = bounds.minY;
      annotation.width = bounds.maxX - bounds.minX;
      annotation.height = bounds.maxY - bounds.minY;
    }
  }
  delete annotation.enginePixels;
}

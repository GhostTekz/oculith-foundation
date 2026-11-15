// A measurement read from an external editor markup keeps the external editor's scale (/Measure on the
// markup, docs/reference/editor/markup-interop.md). Editing its shape recomputes the value with
// that scale, not with the page scale, and the text keeps the external editor's format.
// The scale is labelled "from the file scale": an explicit source, but the external editor's.

import { extOppervlak, extLengte, formatExtWaarde } from '../pdf/ext-interop.js';
import { formatGetalOpmaak } from '../pdf/ext-getalopmaak.js';

/** Label for the scale of an external editor measurement, or '' for any other markup. */
export function extSchaalLabel(ann) {
  const m = ann?.extMeasure;
  if (!m) return '';
  return m.label ? `from the file scale (${m.label})` : 'from the file scale';
}

/**
 * Recompute value and text of an external editor measurement from its current geometry.
 * Model points are page points (scale 1), so lengths and areas need no
 * further conversion. Returns false for any other annotation.
 */
export function herrekenExtMaat(ann) {
  const m = ann?.extMeasure;
  if (!m) return false;
  let waarde = null;
  let fmt = null;
  let keten = null;
  if (ann.type === 'measureArea' && Array.isArray(ann.points)) {
    waarde = extOppervlak(ann.points, m);
    fmt = m.area || { unit: `${m.xUnit}²` };
    keten = m.areaChain;
  } else if (ann.type === 'measurePerimeter' && Array.isArray(ann.points)) {
    waarde = extLengte(ann.points, m);
    fmt = m.distance || { unit: m.xUnit };
    keten = m.distanceChain;
  } else if (ann.type === 'measureDistance') {
    waarde = extLengte([{ x: ann.startX, y: ann.startY }, { x: ann.endX, y: ann.endY }], m);
    fmt = m.distance || { unit: m.xUnit };
    keten = m.distanceChain;
  }
  if (!Number.isFinite(waarde)) return false;
  // A run with a rise/drop (the external editor /RiseDrop): the external editor's L is the plan length
  // plus the rise/drop, and its text names both.
  const riseDrop = ann.type !== 'measureArea' && Number.isFinite(m.riseDrop) ? m.riseDrop : 0;
  waarde += Math.abs(riseDrop);
  ann.measureValue = waarde;
  ann.measureUnit = fmt.unit || ann.measureUnit;
  // the external editor's own format (feet-inches, fractions) when the file gives it. The
  // chain converts from the /X unit; extOppervlak already applied the first
  // area factor, extLengte did not.
  const basis = ann.type === 'measureArea' ? waarde / (keten?.[0]?.c || 1) : waarde;
  const ketenTekst = keten ? formatGetalOpmaak(basis, keten) : '';
  ann.measureText = ketenTekst || formatExtWaarde(waarde, fmt);
  if (riseDrop) {
    const rd = keten ? formatGetalOpmaak(riseDrop, keten) : formatExtWaarde(riseDrop, fmt);
    ann.measureText = `L = ${ann.measureText}\rRise/Drop = ${rd}`;
  }
  // the external editor puts the markup's /Label on a line above the value.
  if (m.labelText) ann.measureText = `${m.labelText}\r${ann.measureText}`;
  return true;
}

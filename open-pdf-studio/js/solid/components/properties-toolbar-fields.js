// Which controls the Properties toolbar shows for a selection (external plan-review files
// "Properties toolbar", docs/reference/editor/workspace.md and WP4).
//
// Pure: no Solid, no state. The toolbar passes the annotation types of the
// selection (one type for a single markup or for the active tool's defaults,
// several for a multi-selection) and renders the returned fields in order.
// Edits go through propertiesStore.updateAnnotProp, which writes every selected
// markup; a multi-selection therefore shows only the fields that every
// selected type has (and the same property key for each), so an edit never
// lands on a markup that has no use for it.
//
// Order (the external editor): type menu · Line: colour, opacity, style, width · Start/End
// heads · Fill colour · Hatch · Font: family, size, colour, B I U, alignment.
// Subject and Status are not toolbar fields; they live in the Properties
// panel and the Markups List.

export const TOOLBAR_FIELD_ORDER = Object.freeze([
  'typeMenu',
  'lineColor', 'opacity', 'lineStyle', 'lineWidth',
  'startHead', 'endHead',
  'fillColor', 'hatch',
  'fontFamily', 'fontSize', 'textColor', 'fontStyle', 'textAlign',
]);

// Types whose outline colour is `strokeColor` (the rest use `color`). Same
// list as propertiesStore's strokeColorGroup.
const STROKE_COLOR_TYPES = new Set(['line', 'arrow', 'box', 'circle', 'draw', 'textbox', 'callout',
  'polygon', 'cloud', 'measureDistance', 'measureArea', 'measurePerimeter', 'filledArea']);
// No outline colour on the toolbar: pictures, the scale bar, and typewriter
// text (its colour is the Font colour).
const NO_LINE_COLOR_TYPES = new Set(['image', 'signature', 'scaleBar', 'text', 'vectorSnippet']);
// Same list as propertiesStore's borderStyleGroup.
const LINE_STYLE_TYPES = new Set(['textbox', 'callout', 'arrow', 'line', 'box', 'circle', 'polygon', 'cloud',
  'draw', 'polyline', 'splineArrow', 'measureDistance', 'measureArea', 'measurePerimeter', 'filledArea']);
// propertiesStore hides the width for these; typewriter text has no line.
const NO_LINE_WIDTH_TYPES = new Set(['highlight', 'comment', 'image', 'textHighlight', 'caret', 'text',
  'scaleBar', 'signature', 'vectorSnippet']);
const NO_OPACITY_TYPES = new Set(['scaleBar']);
// Types that draw start/end heads (rendering.js). A plain `line` has none:
// OcuDraw's Arrow tool is the external editor's line with ends.
const LINE_END_TYPES = new Set(['arrow', 'splineArrow', 'measureDistance', 'measurePerimeter']);
const FILL_TYPES = new Set(['box', 'circle', 'polygon', 'cloud', 'textbox', 'callout', 'measureArea', 'filledArea']);
// Same list as propertiesStore's hatchPatternGroup.
const HATCH_TYPES = new Set(['box', 'circle', 'polygon', 'cloud', 'measureArea', 'filledArea']);
// Text box, callout and typewriter (`text`).
const FONT_TYPES = new Set(['textbox', 'callout', 'text']);
const PARAGRAPH_TYPES = new Set(['textbox', 'callout']);
// Measurement labels draw annotation.fontSize (default 11), the same property
// the properties panel writes. Font size on the toolbar is where it is found.
const MEASURE_LABEL_TYPES = new Set(['measureDistance', 'measureArea', 'measurePerimeter']);

/** Fields for one annotation type, as { id, prop } in toolbar order. */
export function fieldsForType(type) {
  if (!type) return [];
  const out = [{ id: 'typeMenu', prop: null }];
  if (!NO_LINE_COLOR_TYPES.has(type)) {
    out.push({ id: 'lineColor', prop: STROKE_COLOR_TYPES.has(type) ? 'strokeColor' : 'color' });
  }
  if (!NO_OPACITY_TYPES.has(type)) out.push({ id: 'opacity', prop: 'opacity' });
  if (LINE_STYLE_TYPES.has(type)) out.push({ id: 'lineStyle', prop: 'borderStyle' });
  if (!NO_LINE_WIDTH_TYPES.has(type)) out.push({ id: 'lineWidth', prop: 'lineWidth' });
  if (LINE_END_TYPES.has(type)) {
    out.push({ id: 'startHead', prop: 'startHead' }, { id: 'endHead', prop: 'endHead' });
  }
  if (FILL_TYPES.has(type)) out.push({ id: 'fillColor', prop: 'fillColor' });
  if (HATCH_TYPES.has(type)) out.push({ id: 'hatch', prop: 'hatchPattern' });
  if (FONT_TYPES.has(type)) {
    out.push(
      { id: 'fontFamily', prop: 'fontFamily' },
      // Text box/callout edit `textFontSize`, typewriter text `fontSize`;
      // both write annotation.fontSize (propertiesStore).
      { id: 'fontSize', prop: PARAGRAPH_TYPES.has(type) ? 'textFontSize' : 'fontSize' },
      { id: 'textColor', prop: 'textColor' },
      { id: 'fontStyle', prop: null },
    );
    if (PARAGRAPH_TYPES.has(type)) out.push({ id: 'textAlign', prop: 'textAlign' });
  } else if (MEASURE_LABEL_TYPES.has(type)) {
    out.push({ id: 'fontSize', prop: 'fontSize' });
  }
  return out;
}

/**
 * Fields for a selection: the fields of a single type, or for several types
 * those every type has with the same property key. Unknown or empty input
 * gives [] (the toolbar then shows the document state).
 */
export function toolbarFields(types) {
  const list = (Array.isArray(types) ? types : [types]).filter(Boolean);
  if (list.length === 0) return [];
  const [first, ...rest] = [...new Set(list)].map(fieldsForType);
  return first.filter((field) => rest.every((other) =>
    other.some((f) => f.id === field.id && f.prop === field.prop)));
}

/** Just the ids, handy for tests and `has()` checks. */
export function toolbarFieldIds(types) {
  return toolbarFields(types).map((f) => f.id);
}

// Line end choices shown in the Start/End dropdowns (LineEndingsSection).
export const LINE_END_STYLES = Object.freeze(['none', 'open', 'closed', 'square', 'circle', 'diamond',
  'butt', 'openReversed', 'closedReversed', 'slash']);

// Dash patterns for the line-style dropdown (AppearanceSection).
export const LINE_STYLES = Object.freeze(['solid', 'dashed', 'dotted', 'dash-dot', 'dash-dot-dot',
  'long-dash', 'long-dash-dot', 'long-dash-dot-dot']);

// SVG dash arrays that draw each line style as a preview in the dropdown.
export const LINE_STYLE_DASH = Object.freeze({
  solid: '', dashed: '6 3', dotted: '1.5 2.5', 'dash-dot': '6 2.5 1.5 2.5',
  'dash-dot-dot': '6 2 1.5 2 1.5 2', 'long-dash': '11 3', 'long-dash-dot': '11 2.5 1.5 2.5',
  'long-dash-dot-dot': '11 2 1.5 2 1.5 2',
});

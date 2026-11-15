import { Show, For, createMemo } from 'solid-js';
import { state } from '../../core/state.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { lineStylesVersion } from '../stores/lineStylesStore.js';
import { annotProps, panelMode, updateAnnotProp, panelTargets, selectionRev } from '../stores/propertiesStore.js';
import LayerField from './properties-panel/LayerField.jsx';
import PrefComboBox from './preferences/PrefComboBox.jsx';
import { selectionMeasureTotal } from '../../quantities/measurement-summary.js';
import { formatMeasurement } from '../../annotations/measurement.js';
import { systemFontList } from '../stores/fontStore.js';
import { ensureFontInStore } from '../../utils/fonts.js';
import { HATCH_CATEGORIES, listHatchPatternsByCategory, getHatchSwatchDataUrl } from '../../annotations/rendering/hatch-patterns.js';
import { showDocumentMenu, showMarkupStyleMenu } from '../stores/contextMenuStore.js';
import { toolbarFields, LINE_END_STYLES, LINE_STYLES, LINE_STYLE_DASH } from './properties-toolbar-fields.js';
import { lucide } from '../data/lucideIcons.js';
import * as icons from '../data/ribbonIcons.js';
import { edition } from '../../editions/active.js';

// external plan-review files Properties toolbar (docs/reference/editor/workspace.md, WP4): 36 px,
// directly under the menu row, no caption. Nothing selected: the document
// (doc ▾ · Name · Pages · Insert Blank Page). A markup selected, or a drawing
// tool active (its defaults): the fields from properties-toolbar-fields.js.
// Edits go through updateAnnotProp, the same setter and undo path as the
// Properties panel.

const FONT_SIZE_OPTIONS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const MEASURE_FONT_SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const MEASURE_LABEL_TYPES = new Set(['measureDistance', 'measureArea', 'measurePerimeter']);
const OPACITY_OPTIONS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
const LINE_WIDTH_OPTIONS = [0, 0.5, 1, 2, 3, 4, 6, 8, 10, 12];
const ALIGNS = ['left', 'center', 'right'];
const ALIGN_ICON = { left: 'text-align-start', center: 'text-align-center', right: 'text-align-end' };
const FONT_TOGGLES = [['fontBold', 'bold'], ['fontItalic', 'italic'], ['fontUnderline', 'underline']];

const TYPE_ICONS = {
  line: icons.lineIcon, arrow: icons.arrowIcon, polyline: icons.polylineIcon, box: icons.rectIcon,
  circle: icons.ellipseIcon, polygon: icons.polygonIcon, cloud: icons.cloudIcon, cloudPolyline: icons.cloudPolylineIcon,
  textbox: icons.textboxIcon, callout: icons.calloutIcon, text: icons.textAnnotIcon, comment: icons.noteIcon,
  highlight: icons.highlightIcon, textHighlight: icons.highlightIcon, draw: icons.freehandIcon, stamp: icons.stampIcon,
  signature: icons.signatureIcon, image: icons.imageIcon, arc: icons.arcIcon, spline: icons.splineIcon,
  splineArrow: icons.splineArrowIcon, filledArea: icons.hatchIcon, measureDistance: icons.measureDistanceIcon,
  measureArea: icons.measureAreaIcon, measurePerimeter: icons.measurePerimeterIcon, measureAngle: icons.measureAngleIcon,
  measureVolume: icons.volumeIcon, count: icons.countIcon, scaleBar: icons.scaleBarIcon,
};
const typeIcon = (type) => TYPE_ICONS[type] || lucide('square-dashed');

function validColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000';
}

// A small line preview with the head at one end (Start/End dropdowns).
function headSvg(style, side) {
  const flip = side === 'start' ? ' transform="translate(30 0) scale(-1 1)"' : '';
  const shapes = {
    none: '',
    open: '<path d="M21 2.5 27 7l-6 4.5"/>',
    closed: '<path d="M20 2.5 27 7l-7 4.5Z" fill="currentColor"/>',
    openReversed: '<path d="M27 2.5 21 7l6 4.5"/>',
    closedReversed: '<path d="M27 2.5 20 7l7 4.5Z" fill="currentColor"/>',
    square: '<rect x="22" y="3.5" width="7" height="7" fill="currentColor"/>',
    circle: '<circle cx="25" cy="7" r="3.5" fill="currentColor"/>',
    openCircle: '<circle cx="25" cy="7" r="3.2"/>',
    diamond: '<path d="M25 2.5 29 7l-4 4.5L21 7Z" fill="currentColor"/>',
    butt: '<path d="M27 2v10"/>',
    slash: '<path d="M23 12 29 2"/>',
  };
  const lineEnd = ['closed', 'square', 'circle', 'diamond', 'openCircle'].includes(style) ? 21 : 27;
  return `<svg viewBox="0 0 30 14" width="30" height="14" stroke="currentColor" stroke-width="1.4" fill="none" aria-hidden="true"><g${flip}><path d="M2 7H${lineEnd}"/>${shapes[style] ?? ''}</g></svg>`;
}

function lineStyleSvg(style) {
  const dash = LINE_STYLE_DASH[style] || '';
  return `<svg viewBox="0 0 96 8" width="96" height="8" aria-hidden="true"><path d="M2 4H94" stroke="currentColor" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''}/></svg>`;
}

// A preview button with a native <select> stretched over it: the preview
// draws the current value, the browser draws the list.
function PreviewSelect(props) {
  return (
    <span class={`ptb-select ${props.class || ''}`} classList={{ disabled: props.disabled }} title={props.title}>
      <span class="ptb-select-preview" innerHTML={props.preview} />
      <span class="ptb-caret" innerHTML={lucide('chevron-down')} />
      <select aria-label={props.title} value={props.value} disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}>
        {props.children}
      </select>
    </span>
  );
}

function ColorSwatch(props) {
  return (
    <label class="ptb-swatch" classList={{ none: !props.color, mixed: props.color === 'mixed', disabled: props.disabled }}
      title={props.title}>
      <span class="ptb-swatch-chip" style={{ 'background-color': props.color && props.color !== 'mixed' ? props.color : undefined }} />
      <input type="color" aria-label={props.title} value={validColor(props.color)} disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)} />
    </label>
  );
}

export default function PropertiesToolbar() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const selected = () => panelMode() === 'annotation' || panelMode() === 'multi';
  const locked = () => annotProps.locked === true || annotProps.locked === 'mixed';
  const doc = () => state.documents[state.activeDocumentIndex];

  // Types of what the toolbar edits: the selection, or the active tool's
  // defaults (propertiesStore shows those as a synthetic single selection).
  const selectionTypes = () => {
    selectionRev();
    if (panelMode() === 'multi') return (doc()?.selectedAnnotations || []).map((a) => a?.type);
    if (panelMode() === 'annotation') return [annotProps.type];
    return [];
  };
  const fields = createMemo(() => toolbarFields(selectionTypes()));
  const has = (id) => fields().some((f) => f.id === id);
  const propOf = (id) => fields().find((f) => f.id === id)?.prop;
  // A selection of only measurements: the label size is annotation.fontSize,
  // default 11, about 6–72. Other text keeps the wider font-size combo.
  const measureLabelSize = () => {
    const types = selectionTypes().filter(Boolean);
    return types.length > 0 && types.every((type) => MEASURE_LABEL_TYPES.has(type));
  };

  // Σ of the selected measurements: 2+ of one kind in one unit, else hidden.
  const measureTotal = () => panelMode() === 'multi'
    ? selectionMeasureTotal(doc()?.selectedAnnotations) : null;
  const measureTotalText = () => {
    const total = measureTotal();
    return total ? `${t(`measureTotal.${total.kind}`)}: ${formatMeasurement(total)}` : '';
  };

  const fonts = createMemo(() => {
    if (!has('fontFamily')) return [];
    const current = annotProps.fontFamily;
    if (current && current !== 'mixed') ensureFontInStore(current);
    return systemFontList();
  });
  const hatchGroups = createMemo(() => (lineStylesVersion(), has('hatch') ? listHatchPatternsByCategory() : {}));
  const hatchLabel = (id) => {
    if (String(id).startsWith('pat:')) return id.slice(4); // imported .PAT pattern
    const key = `appearance.hatchPatterns.${id}`;
    const label = t(key);
    return label && label !== key ? label : id;
  };
  const hatchPreview = () => {
    const id = annotProps.hatchPattern;
    if (!id || id === 'none' || id === 'mixed') return icons.hatchIcon;
    const color = annotProps.hatchColor && annotProps.hatchColor !== 'mixed' ? annotProps.hatchColor : '#000000';
    return `<img src="${getHatchSwatchDataUrl(id, color, 16, '#ffffff')}" width="16" height="16" alt="">`;
  };
  const headLabel = (style) => (style === 'none' ? tCommon('none') : ({
    open: t('lineEndings.openArrow'), closed: t('lineEndings.closedArrow'), square: t('lineEndings.square'),
    circle: t('lineEndings.circle'), diamond: t('lineEndings.diamond'), butt: t('lineEndings.butt'),
    openReversed: t('lineEndings.openArrowReversed'), closedReversed: t('lineEndings.closedArrowReversed'),
    slash: t('lineEndings.slash'),
  })[style] || style);
  const styleLabel = (style) => tCommon({
    solid: 'solid', dashed: 'dashed', dotted: 'dotted', 'dash-dot': 'dashDot', 'dash-dot-dot': 'dashDotDot',
    'long-dash': 'longDash', 'long-dash-dot': 'longDashDot', 'long-dash-dot-dot': 'longDashDotDot',
  }[style] || style);
  const toggleStyle = (key) => updateAnnotProp(key, annotProps[key] === 'mixed' ? true : !annotProps[key]);
  const openMenuBelow = (open) => (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    open(Math.round(r.left), Math.round(r.bottom + 2));
  };
  const insertBlankPage = () => import('../../ui/chrome/dialogs.js').then((m) => m.showInsertPageDialog());
  const lineColor = () => {
    const c = annotProps[propOf('lineColor')];
    return c === 'none' || c === 'transparent' ? null : (c || annotProps.color);
  };

  // A head value outside the list (e.g. a measurement's 'openCircle') still
  // shows as the current option.
  const HeadSelect = (p) => (
    <PreviewSelect class="ptb-head" title={p.title} value={annotProps[p.prop]} disabled={locked()}
      preview={headSvg(annotProps[p.prop] === 'mixed' ? 'none' : annotProps[p.prop], p.side)}
      onChange={(v) => updateAnnotProp(p.prop, v)}>
      <Show when={annotProps[p.prop] === 'mixed'}><option value="mixed" disabled hidden>{tCommon('mixed')}</option></Show>
      <Show when={annotProps[p.prop] !== 'mixed' && !LINE_END_STYLES.includes(annotProps[p.prop])}>
        <option value={annotProps[p.prop]}>{annotProps[p.prop]}</option>
      </Show>
      <For each={LINE_END_STYLES}>{(s) => <option value={s}>{headLabel(s)}</option>}</For>
    </PreviewSelect>
  );

  return (
    <div class="properties-toolbar" role="toolbar" aria-label={t('title')}>
      <Show when={selected()} fallback={
        <Show when={doc()}>
          <div class="properties-toolbar-document">
            <button type="button" class="ptb-menu-btn" id="properties-toolbar-doc-menu"
              title={t('toolbar.documentMenu')} aria-label={t('toolbar.documentMenu')} aria-haspopup="menu"
              onClick={openMenuBelow(showDocumentMenu)}>
              <span class="ptb-icon" innerHTML={lucide('file-text')} />
              <span class="ptb-caret" innerHTML={lucide('chevron-down')} />
            </button>
            <span class="ptb-label">{t('toolbar.name')}:</span>
            <strong class="ptb-doc-name" title={doc()?.filePath || doc()?.fileName}>{doc()?.fileName || edition.productName}</strong>
            <Show when={doc()?.pdfDoc}>
              <span class="ptb-label">{t('toolbar.pages')}:</span>
              <strong class="ptb-doc-pages">{doc().pdfDoc.numPages}</strong>
              <button type="button" class="ptb-icon-btn" id="properties-toolbar-insert-page"
                title={t('toolbar.insertBlankPage')} aria-label={t('toolbar.insertBlankPage')}
                onClick={insertBlankPage}>
                <span class="ptb-icon" innerHTML={lucide('file-plus')} />
              </button>
            </Show>
          </div>
        </Show>
      }>
        <button type="button" class="ptb-menu-btn" id="properties-toolbar-type-menu"
          title={`${annotProps.typeDisplay} · ${t('toolbar.typeMenu')}`} aria-label={t('toolbar.typeMenu')} aria-haspopup="menu"
          onClick={openMenuBelow(showMarkupStyleMenu)}>
          <span class="ptb-icon" innerHTML={typeIcon(annotProps.type || selectionTypes()[0])} />
          <Show when={annotProps.multiCount > 0}><span class="ptb-count">{annotProps.multiCount}</span></Show>
          <span class="ptb-caret" innerHTML={lucide('chevron-down')} />
        </button>

        <Show when={has('lineColor')}>
          <span class="ptb-group" data-field="line">
            <span class="ptb-label">{propOf('lineColor') === 'strokeColor' ? t('toolbar.line') : t('toolbar.color')}:</span>
            <ColorSwatch title={t('appearance.strokeColor')} disabled={locked()} color={lineColor()}
              onChange={(c) => updateAnnotProp(propOf('lineColor'), c)} />
          </span>
        </Show>
        <Show when={has('opacity')}>
          <span class="ptb-combo ptb-opacity" title={t('appearance.opacity')}>
            <PrefComboBox value={() => annotProps.opacity} setValue={(v) => updateAnnotProp('opacity', v)}
              options={OPACITY_OPTIONS} min={0} max={100} fallback={100} suffix="%" disabled={locked} />
          </span>
        </Show>
        <Show when={has('lineStyle')}>
          <PreviewSelect class="ptb-linestyle" title={t('appearance.borderStyle')} value={annotProps.borderStyle}
            disabled={locked()} preview={lineStyleSvg(annotProps.borderStyle)}
            onChange={(v) => updateAnnotProp('borderStyle', v)}>
            <Show when={annotProps.borderStyle === 'mixed'}><option value="mixed" disabled hidden>{tCommon('mixed')}</option></Show>
            <For each={LINE_STYLES}>{(s) => <option value={s}>{styleLabel(s)}</option>}</For>
          </PreviewSelect>
        </Show>
        <Show when={has('lineWidth')}>
          <span class="ptb-combo ptb-width" title={t('appearance.lineWidth')}>
            <PrefComboBox value={() => annotProps.lineWidth} setValue={(v) => updateAnnotProp('lineWidth', v)}
              options={LINE_WIDTH_OPTIONS} min={0} max={20} fallback={1} suffix="pt" disabled={locked} />
          </span>
        </Show>

        <Show when={has('startHead')}>
          <span class="ptb-group" data-field="start">
            <span class="ptb-label">{t('toolbar.start')}:</span>
            <HeadSelect prop="startHead" side="start" title={t('lineEndings.start')} />
          </span>
        </Show>
        <Show when={has('endHead')}>
          <span class="ptb-group" data-field="end">
            <span class="ptb-label">{t('toolbar.end')}:</span>
            <HeadSelect prop="endHead" side="end" title={t('lineEndings.end')} />
          </span>
        </Show>

        <Show when={has('fillColor')}>
          <span class="ptb-group" data-field="fill">
            <span class="ptb-label">{t('toolbar.fill')}:</span>
            <ColorSwatch title={t('appearance.fillColor')} disabled={locked()} color={annotProps.fillColor}
              onChange={(c) => updateAnnotProp('fillColor', c)} />
            <button type="button" class="ptb-icon-btn ptb-nofill" title={t('toolbar.noFill')} aria-label={t('toolbar.noFill')}
              aria-pressed={!annotProps.fillColor} disabled={locked()}
              onClick={() => updateAnnotProp('fillColor', null)}>
              <span class="ptb-icon" innerHTML={lucide('square-x')} />
            </button>
          </span>
        </Show>
        <Show when={has('hatch')}>
          <PreviewSelect class="ptb-hatch" title={t('appearance.hatchPattern')} value={annotProps.hatchPattern || 'none'}
            disabled={locked()} preview={hatchPreview()} onChange={(v) => updateAnnotProp('hatchPattern', v)}>
            <Show when={annotProps.hatchPattern === 'mixed'}><option value="mixed" disabled hidden>{tCommon('mixed')}</option></Show>
            <option value="none">{tCommon('none')}</option>
            <For each={HATCH_CATEGORIES}>{(cat) => (
              <Show when={hatchGroups()[cat]?.length}>
                <optgroup label={cat === 'imported' ? tCommon('lineStyles.importedCategory') : t(`appearance.hatchCategories.${cat}`)}>
                  <For each={hatchGroups()[cat]}>{(p) => <option value={p.id}>{hatchLabel(p.id)}</option>}</For>
                </optgroup>
              </Show>
            )}</For>
          </PreviewSelect>
        </Show>

        <Show when={has('fontFamily')}>
          <span class="ptb-group" data-field="font">
            <span class="ptb-label">{t('toolbar.font')}:</span>
            <select class="ptb-font" aria-label={t('textFormat.font')} title={t('textFormat.font')}
              value={annotProps.fontFamily} disabled={locked()}
              onChange={(e) => updateAnnotProp('fontFamily', e.target.value)}>
              <Show when={annotProps.fontFamily === 'mixed'}><option value="mixed" disabled hidden>{tCommon('mixed')}</option></Show>
              <Show when={annotProps.fontFamily && annotProps.fontFamily !== 'mixed' && !fonts().includes(annotProps.fontFamily)}>
                <option value={annotProps.fontFamily}>{annotProps.fontFamily}</option>
              </Show>
              <For each={fonts()}>{(font) => <option value={font}>{font}</option>}</For>
            </select>
          </span>
        </Show>
        <Show when={has('fontSize')}>
          <span class="ptb-combo ptb-fontsize" classList={{ 'ptb-group': !has('fontFamily') }} title={t('textFormat.fontSize')}>
            <Show when={!has('fontFamily')}>
              <span class="ptb-label">{t('textFormat.fontSize')}</span>
            </Show>
            <PrefComboBox value={() => annotProps[propOf('fontSize')]} setValue={(v) => updateAnnotProp(propOf('fontSize'), v)}
              options={measureLabelSize() ? MEASURE_FONT_SIZES : FONT_SIZE_OPTIONS}
              min={measureLabelSize() ? 6 : 1} max={measureLabelSize() ? 72 : 999}
              fallback={measureLabelSize() ? 11 : 12} suffix="" disabled={locked} />
          </span>
        </Show>
        <Show when={has('textColor')}>
          <ColorSwatch title={t('textFormat.textColor')} disabled={locked()}
            color={annotProps.textColor === 'mixed' ? 'mixed' : (annotProps.textColor || annotProps.color)}
            onChange={(c) => updateAnnotProp('textColor', c)} />
        </Show>
        <Show when={has('fontStyle')}>
          <span class="ptb-toggles" role="group" aria-label={t('textFormat.style')}>
            <For each={FONT_TOGGLES}>{([key, name]) => (
              <button type="button" class="ptb-icon-btn" aria-pressed={annotProps[key] === true}
                title={t(`toolbar.${name}`)} aria-label={t(`toolbar.${name}`)} disabled={locked()}
                onClick={() => toggleStyle(key)}>
                <span class="ptb-icon" innerHTML={lucide(name)} />
              </button>
            )}</For>
          </span>
        </Show>
        <Show when={has('textAlign')}>
          <PreviewSelect class="ptb-align" title={t('toolbar.align')} value={annotProps.textAlign} disabled={locked()}
            preview={lucide(ALIGN_ICON[annotProps.textAlign] || 'text-align-start')}
            onChange={(v) => updateAnnotProp('textAlign', v)}>
            <Show when={annotProps.textAlign === 'mixed'}><option value="mixed" disabled hidden>{tCommon('mixed')}</option></Show>
            <For each={ALIGNS}>{(a) => (
              <option value={a}>{t(`paragraph.align${a[0].toUpperCase()}${a.slice(1)}`)}</option>
            )}</For>
          </PreviewSelect>
        </Show>

        {/* Right end: Layer (an Oculith addition; the file's toolbar has none)
            and the Σ of a multi-selection of measurements. */}
        <span class="ptb-right">
          <Show when={(selectionRev(), panelTargets().length > 0)}>
            <label class="ptb-group properties-toolbar-layer" title={t('toolbar.layer')}>
              <span class="ptb-label">{t('general.layer')}:</span>
              <LayerField id="properties-toolbar-layer" />
            </label>
          </Show>
          <Show when={measureTotal()}>
            <span class="properties-toolbar-total" id="properties-toolbar-measure-total"
              title={t('measureTotal.title', { count: measureTotal()?.count })}>
              {measureTotalText()}
            </span>
          </Show>
        </span>
      </Show>
    </div>
  );
}

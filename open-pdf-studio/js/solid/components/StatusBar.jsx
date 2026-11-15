import { Show, For, createEffect, createMemo, createResource, onMount } from 'solid-js';
import { state } from '../../core/state.js';
import { useTranslation, localizeNumber } from '../../i18n/useTranslation.js';
import { pageScaleStatus } from '../../annotations/scale-entry.js';
import { SNAP_TOGGLES, isSnapToggleOn, toggleSnapPreference } from '../../tools/snap-toggles.js';
import { measureReadout, measureReadoutText } from '../../tools/measure-readout.js';
import { typedLengthMeasurement } from '../../tools/type-length-input.js';
import { formatMeasurement, getMeasureScale } from '../../annotations/measurement.js';
import { cursorPoint, installCursorTracker } from '../../tools/cursor-readout.js';
import {
  formatCursorCoords, formatPageSize, paperUnitFor, pageScaleOf, scaleLabel,
} from '../../ui/chrome/navigation-format.js';
import { isToolbarVisible } from '../stores/workspaceLayout.js';
import { lucide } from '../data/lucideIcons.js';
import { scaleChip, openScaleChip } from '../../ui/chrome/scale-chip.js';
import { ensurePageScanned } from '../../annotations/scale-proposals.js';

// the external editor status bar (F8, workspaceLayout.toolbars.status). Left: the command
// hint ("Ready", the active tool, or a passing status message) and the live
// measurement readout. Right: the drawing-aid toggles as icon buttons in
// the external editor's order (Ortho is our addition), Sync (with a split view),
// the rendering engine, the page scale (click: Set Scale), the page size and
// the cursor position. Page navigation and zoom live in the Navigation bar.

const SB = {
  rotation: lucide('rotate-cw'),
  sync: lucide('refresh-cw'),
  caret: lucide('chevron-down'),
};

// the external editor order: Show Grid, Snap to Grid, Snap to Content, Snap to Markup, then
// Ortho and Reuse. Each is still the SNAP_TOGGLES preference binding.
const TOGGLE_ORDER = ['showGrid', 'grid', 'content', 'markup', 'ortho', 'reuse'];
export const STATUS_TOGGLES = TOGGLE_ORDER.map((id) => SNAP_TOGGLES.find((toggle) => toggle.id === id)).filter(Boolean);
export const TOGGLE_ICONS = {
  showGrid: lucide('grid-3x3'),
  grid: lucide('grid-2x2-check'),
  content: lucide('magnet'),
  markup: lucide('spline-pointer'),
  ortho: lucide('corner-down-right'),
  reuse: lucide('repeat-2'),
};

// Weergave draaien (#200): de statusbalk toont het zolang de weergave
// gedraaid staat; een klik zet hem terug. Alleen de weergave, niet het document.
async function resetViewRotation() {
  const { zetWeergaveRotatie } = await import('../../pdf/weergave-draaien.js');
  await zetWeergaveRotatie(0);
}


import { engineFor } from '../stores/engineStatusStore.js';
import { isSplitView, syncState, setSync, toggleSync } from '../stores/multiViewStore.js';
import { openPanelMenu } from './panels/PanelMenu.jsx';
import { DISPLAY_UNIT_LABELS, measureDisplay, setMeasureDisplay } from '../../annotations/measure-display-setting.js';
import { createSignal as createUnitsSignal } from 'solid-js';

// Sync ▾: the external editor's two modes. Choosing one also turns Sync on.
function openSyncMenu(e, t) {
  const r = e.currentTarget.getBoundingClientRect();
  const items = ['document', 'page'].map((mode) => ({
    label: t(mode === 'page' ? 'syncPage' : 'syncDocument'),
    checked: syncState().enabled && syncState().mode === mode,
    run: () => setSync({ enabled: true, mode }),
  }));
  openPanelMenu(Math.max(4, r.right - 260), Math.max(4, r.top - items.length * 26 - 10), items);
}

export default function StatusBar() {
  const { t, language } = useTranslation('statusbar');
  const { t: tRibbon } = useTranslation('ribbon');
  // Display units for measurements: the scale's own unit, or one chosen here.
  const [unitsShown, setUnitsShown] = createUnitsSignal(measureDisplay());
  const SHORT = { auto: '', 'ft-in': `ft-in`, in: 'in', ft: 'ft', mm: 'mm', cm: 'cm', m: 'm' };
  const unitsLabel = () => {
    const u = unitsShown();
    const main = SHORT[u.unit] || tRibbon('measure.unitAuto');
    return u.dual ? `${main} + ${['mm', 'cm', 'm'].includes(u.unit) ? 'ft-in' : 'mm'}` : main;
  };
  onMount(installCursorTracker);

  const doc = () => state.documents[state.activeDocumentIndex];
  const toolName = () => {
    const key = `tools.${state.currentTool}`;
    const translated = t(key);
    return translated !== key ? translated : state.currentTool;
  };
  // the external editor's command hint: a passing status message, else the active tool,
  // else "Ready".
  const hintText = () => {
    if (state.statusMessageVisible && state.statusMessage) return state.statusMessage;
    if (!state.currentTool || state.currentTool === 'select') return t('ready');
    return toolName();
  };
  const viewRotation = () => {
    const r = Number(doc()?.viewRotation) || 0;
    return ((r % 360) + 360) % 360;
  };
  const activeEngine = () => engineFor(doc()?.filePath, doc()?.currentPage);
  // Page-wide scale of the current page (document scale or a page scale
  // bar); scale regions and viewports are point-specific and only noted.
  const scaleStatus = () => {
    const d = doc();
    if (!d?.pdfDoc) return null;
    return pageScaleStatus(d, d.currentPage || 1, state.preferences?.measureScale);
  };
  const pageScale = createMemo(() => {
    const d = doc();
    return d?.pdfDoc ? pageScaleOf(d, d.currentPage || 1, state.preferences?.measureScale) : null;
  });
  // Scale chip: green confirmed, amber read from the sheet (click to
  // review), red not set (click to set or calibrate).
  const chip = () => {
    const s = scaleStatus();
    return s ? scaleChip(s, t, s.kind === 'set' ? scaleLabel(pageScale()) : '') : null;
  };
  // Read the scale notes of each page that is shown (once per page; the
  // text comes from the text layer's PDF.js request).
  createEffect(() => {
    const d = doc();
    const page = d?.currentPage || 1;
    if (d?.pdfDoc && !d.scaleProposals?.[page]) ensurePageScanned(d, page);
  });
  const paperUnit = () => paperUnitFor(pageScale()?.unit, language());
  const [pageInfo] = createResource(
    () => (doc()?.pdfDoc ? { pdfDoc: doc().pdfDoc, page: doc().currentPage || 1 } : null),
    async ({ pdfDoc, page }) => {
      const p = await pdfDoc.getPage(page);
      const [x0, y0, x1, y1] = p.view;
      return { widthPt: x1 - x0, heightPt: y1 - y0, rotation: p.rotate || 0 };
    });
  const pageSizeText = () => {
    const info = pageInfo();
    return info ? formatPageSize(info.widthPt, info.heightPt, paperUnit(), info.rotation) : '';
  };
  // Cursor position: real lengths at the scale under the cursor (scale
  // regions and viewports included), paper lengths when uncalibrated.
  const cursor = createMemo(() => {
    const p = cursorPoint();
    if (!p || !doc()?.pdfDoc) return null;
    return formatCursorCoords(p, getMeasureScale(p.page, p.x, p.y), paperUnit());
  });
  // Live value of the measurement being placed (measure tools report it).
  const readoutText = () => {
    const r = measureReadout();
    // Sketch to Scale: the length typed for the next segment follows the value.
    return r ? measureReadoutText(r, formatMeasurement, t(`readout.${r.kind}`),
      typedLengthMeasurement(), t('readout.typed')) : '';
  };
  const toggleTitle = (toggle) => toggle.shortcut
    ? `${t(`snapToggles.${toggle.id}Title`)} (${toggle.shortcut})`
    : t(`snapToggles.${toggle.id}Title`);

  return (
    <Show when={isToolbarVisible('status')}>
      <div class="status-bar">
        <div class="status-bar-left">
          <div class="status-item status-hint" id="status-hint" role="status" aria-live="polite">{hintText()}</div>
          <Show when={readoutText()}>
            <div class="status-item status-measure-readout" id="status-measure-readout"
              role="status" aria-live="off" title={t('readout.title')}>
              {readoutText()}
            </div>
          </Show>
        </div>

        <div class="status-bar-right">
          {/* Drawing aids: each button is a persisted preference
              (tools/snap-toggles.js), also in Preferences and via shortcuts. */}
          <div class="status-snap-toggles" role="group" aria-label={t('snapToggles.group')}>
            <For each={STATUS_TOGGLES}>
              {(toggle) => (
                <button
                  type="button"
                  class="status-snap-toggle"
                  id={`status-snap-${toggle.id}`}
                  classList={{ active: isSnapToggleOn(state.preferences, toggle.id) }}
                  aria-pressed={isSnapToggleOn(state.preferences, toggle.id) ? 'true' : 'false'}
                  aria-label={t(`snapToggles.${toggle.id}`)}
                  title={toggleTitle(toggle)}
                  onClick={() => toggleSnapPreference(toggle.id)}
                >
                  <span class="status-icon" innerHTML={TOGGLE_ICONS[toggle.id]} />
                </button>
              )}
            </For>
            {/* Sync (the external editor): on/off, and ▾ for Synchronize Document / Page.
                Needs a split view (MultiView, docs/reference/editor/workspace.md). */}
            <button type="button" class="status-snap-toggle status-sync" id="status-sync"
              classList={{ active: syncState().enabled }}
              aria-pressed={syncState().enabled ? 'true' : 'false'}
              title={isSplitView() ? `${t('syncTitle')} (${t(syncState().mode === 'page' ? 'syncPage' : 'syncDocument')})` : t('syncNeedsSplit')}
              aria-label={t('sync')} disabled={!isSplitView()}
              onClick={toggleSync}>
              <span class="status-icon" innerHTML={SB.sync} />
            </button>
            <button type="button" class="status-snap-toggle status-sync-mode" id="status-sync-mode"
              title={t('syncMode')} aria-label={t('syncMode')} aria-haspopup="menu" disabled={!isSplitView()}
              onClick={(e) => openSyncMenu(e, t)}>
              <span class="status-icon status-caret" innerHTML={SB.caret} />
            </button>
          </div>

          <Show when={viewRotation() !== 0}>
            <button class="status-view-rotation" id="status-view-rotation"
              title={t('viewRotatedTitle', { degrees: localizeNumber(viewRotation()) })}
              onClick={resetViewRotation}>
              <span class="status-icon" innerHTML={SB.rotation} />
              <span>{localizeNumber(viewRotation())}°</span>
            </button>
          </Show>
          {/* Passieve weergave-engine-indicator: de render-paden melden welke
              engine de huidige weergave levert (PDFium / eigen tegel-engine /
              vector-replay). Alleen zichtbaarheid, geen keuze. */}
          <Show when={activeEngine()}>
            <div
              class="status-item status-engine"
              classList={{
                'status-engine--scene': activeEngine() === 'scene',
                'status-engine--vector': activeEngine() === 'vector',
              }}
              title={t('engineTitle')}
            >
              {t(`engine.${activeEngine()}`)}
            </div>
          </Show>
          <Show when={scaleStatus()}>
            <button class="status-scale status-units" id="status-units" data-measure-units
              title={tRibbon('measure.showUnitTitle')}
              onClick={(event) => {
                const r = event.currentTarget.getBoundingClientRect();
                const current = measureDisplay();
                const pick = (unit) => { setMeasureDisplay({ unit }); setUnitsShown(measureDisplay()); };
                openPanelMenu(r.left, r.top - 4, [
                  ...Object.entries(DISPLAY_UNIT_LABELS).map(([unit, key]) => ({
                    label: tRibbon(`measure.${key}`), checked: current.unit === unit, run: () => pick(unit),
                  })),
                  { separator: true },
                  { label: tRibbon('measure.dualUnits'), checked: current.dual,
                    run: () => { setMeasureDisplay({ dual: !current.dual }); setUnitsShown(measureDisplay()); } },
                ]);
              }}>
              {unitsLabel()}
            </button>
            <button
              class="status-scale"
              id="status-scale"
              classList={{
                'status-scale--ok': chip()?.tone === 'ok',
                'status-scale--detected': chip()?.tone === 'detected',
                'status-scale--unset': chip()?.tone === 'unset',
              }}
              data-scale-tone={chip()?.tone}
              title={chip()?.title}
              onClick={() => openScaleChip(chip(), doc()?.currentPage || 1)}
            >
              {chip()?.text}
            </button>
          </Show>
          <Show when={pageSizeText()}>
            <div class="status-item status-readout" id="status-page-size" title={t('pageSizeTitle')}>{pageSizeText()}</div>
          </Show>
          <div class="status-item status-readout status-cursor" id="status-cursor"
            classList={{ 'status-cursor--paper': cursor() && !cursor().calibrated }}
            title={cursor() ? t(cursor().calibrated ? 'cursorTitle' : 'cursorPaperTitle', { unit: cursor().unit }) : ''}>
            {cursor()?.text || ''}
          </div>
        </div>
      </div>
    </Show>
  );
}

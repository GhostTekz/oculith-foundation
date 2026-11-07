import { isMobile } from '../core/platform.js';
import MobileApp from './MobileApp.jsx';
import MenuBar from './components/menubar/MenuBar.jsx';
import DocumentTabs from './components/DocumentTabs.jsx';
import CanvasScrollbars from './components/CanvasScrollbars.jsx';
import FindBar from './components/FindBar.jsx';
import FormFieldsBar from './components/FormFieldsBar.jsx';
import PdfABar from './components/PdfABar.jsx';
import HandtekeningBar from './components/HandtekeningBar.jsx';
import NotificationBar from './components/NotificationBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import NavigationBar from './components/NavigationBar.jsx';
import MarkupsDock from './components/MarkupsDock.jsx';
import PropertiesToolbar from './components/PropertiesToolbar.jsx';
import WorkflowBar from './components/WorkflowBar.jsx';
import TooltipLayer from './components/TooltipLayer.jsx';
import MultiViewPanes from './components/MultiViewPanes.jsx';
import { isSplitView, splitOrientation, activePaneIndex } from './stores/multiViewStore.js';
import AppMenu from './components/app-menu/AppMenu.jsx';
import DialogHost from './components/DialogHost.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import LoadingOverlay from './components/LoadingOverlay.jsx';
import TypeLengthHUD from './components/TypeLengthHUD.jsx';
import KeystrokeOverlay from './components/KeystrokeOverlay.jsx';
import BoxSizeOverlay from './components/BoxSizeOverlay.jsx';
import SketchModeBar from './components/SketchModeBar.jsx';
import TourCoach from './components/TourCoach.jsx';
import { startTour } from '../tour/tours.js';
import { DockedToolPalette, FloatingToolPalette, DockTargets, PaletteContextMenu } from './components/ToolPalette.jsx';
import { DockedExtPalette, FloatingExtPalette, ExtDockTargets } from './components/ExtensionToolPalette.jsx';
import { DockedSymbolPalette, FloatingSymbolPalette, SymbolSettingsDialog } from './components/SymbolPalette.jsx';
import SchedulePanel from './components/SchedulePanel.jsx';
import PanelHost from './components/panels/PanelHost.jsx';
import VerticalToolbar from './components/panels/VerticalToolbar.jsx';
import SymbolTypeEditor from './components/symbol-edit/SymbolTypeEditor.jsx';
import { getRegisteredPalettes } from '../plugins/palette-registry.js';
import { leftOrder, rightOrder } from './stores/paletteOrder.js';
import { useTranslation } from '../i18n/useTranslation.js';
import { isTauri } from '../core/platform.js';
import { state } from '../core/state.js';
import { edition } from '../editions/active.js';
import { meldLegeStart, WEB_SESSIE_SLEUTEL } from '../core/sessie-herstel.js';
import { For, ErrorBoundary, Show, createEffect, createSignal, lazy } from 'solid-js';
import { compareActive } from '../compare/compare-store.js';

// Compare mode is rare: its view (and the compare engine it pulls in) loads
// the first time a comparison starts, then stays mounted.
const CompareView = lazy(() => import('./components/compare/CompareView.jsx'));
const [compareUsed, setCompareUsed] = createSignal(false);

function OrderedDockedPalettes(props) {
  const order = () => props.side === 'left' ? leftOrder() : rightOrder();
  const extPalettes = () => getRegisteredPalettes();

  // Build list of all palette ids: 'tool' (built-in) + extension palette ids
  const allIds = () => {
    const o = order();
    const extIds = extPalettes().map(p => p.id);
    const all = ['tool', 'symbols', ...extIds];
    // Ordered ones first, then any remaining (for palettes not yet in the order list)
    const ordered = [...o.filter(id => all.includes(id)), ...all.filter(id => !o.includes(id))];
    // Right side: first docked should be closest to the edge (rightmost in DOM), so reverse
    return props.side === 'right' ? ordered.slice().reverse() : ordered;
  };

  return (
    <For each={allIds()}>
      {(id) => {
        if (id === 'tool') {
          return <DockedToolPalette side={props.side} />;
        }
        if (id === 'symbols') {
          return <DockedSymbolPalette side={props.side} />;
        }
        const descriptor = extPalettes().find(p => p.id === id);
        return descriptor ? <DockedExtPalette side={props.side} descriptor={descriptor} /> : null;
      }}
    </For>
  );
}

function DesktopApp() {
  const { t } = useTranslation('common');
  const extPalettes = () => getRegisteredPalettes();
  createEffect(() => { if (compareActive()) setCompareUsed(true); });

  return (
    <>
      <MenuBar />

      {/* Workflow tabs, their tools and Quick Access (the 'standard' toolbar). */}
      <WorkflowBar />
      <PropertiesToolbar />

      <NotificationBar />
      <DocumentTabs />

      <div class="content">
        <PanelHost host="left" />
        <OrderedDockedPalettes side="left" />

        <div class="main-view">
          <DockTargets />
          <For each={extPalettes()}>
            {(p) => <ExtDockTargets descriptor={p} />}
          </For>
          <FindBar />

          <div id="placeholder" class="draw-empty-state">
            <div class="draw-empty-inner">
              <img class="draw-empty-mark" src={edition.logoPath} alt="" />
              <span class="draw-empty-eyebrow">OCULITH DRAW / DRAWING WORKSPACE</span>
              <h2>{edition.home?.title?.() || 'Start a drawing review'}</h2>
              <p>{edition.home?.description?.() || 'Open a plan set to place symbols, mark up details, and measure the work.'}</p>
              <div class="draw-empty-actions">
                <button class="draw-open-button" type="button"
                  onClick={() => import('../pdf/loader.js').then(m => m.openPDFFile())}>
                  Open PDF drawing
                </button>
                <For each={edition.home?.actions || []}>{(action) =>
                  <button class="draw-extension-button" type="button" onClick={() => action.run()}>{action.label()}</button>
                }</For>
                <button class="draw-extension-button" type="button" data-tour-start onClick={() => startTour()}>Take the tour</button>
                <span class="draw-empty-shortcut">Ctrl+O</span>
              </div>
              <span class="draw-empty-note">Tool Chest · Markup · Measurements · Layers</span>
              {/* De webversie bewaart geen sessie. Dat zeggen is eerlijker dan
                  een voorkeur die daar nooit iets doet (#456). */}
              <Show when={meldLegeStart({ inTauri: isTauri() })}>
                <p class="placeholder-note">{t(WEB_SESSIE_SLEUTEL)}</p>
              </Show>
            </div>
          </div>

          <FormFieldsBar />

          <PdfABar />

          <HandtekeningBar />

          {/* MultiView (docs/MULTIVIEW.md): display: contents while unsplit,
              a grid of split tab rows + views when split. #pdf-container is
              the live view and never moves in the DOM. */}
          <div class="mv-panes" data-split={splitOrientation() || 'none'} data-live={activePaneIndex()}>
            <Show when={isSplitView()}>
              <MultiViewPanes />
            </Show>
            <div id="pdf-container">
              <div id="canvas-wrapper">
                <div id="canvas-container" class="single-page-container">
                  <canvas id="pdf-canvas"></canvas>
                  <canvas id="text-highlight-canvas"></canvas>
                  <canvas id="annotation-canvas"></canvas>
                </div>
                <div id="continuous-container" class="continuous-container"></div>
              </div>
              <CanvasScrollbars />
              <Show when={compareUsed()}><CompareView /></Show>
            </div>
          </div>
          <NavigationBar />
        </div>

        <OrderedDockedPalettes side="right" />
        <VerticalToolbar />
        <PanelHost host="right" />
      </div>

      <MarkupsDock />
      <StatusBar />

      <AppMenu />
      <DialogHost />
      <ContextMenu />
      <FloatingToolPalette />
      <FloatingSymbolPalette />
      <For each={extPalettes()}>
        {(p) => <FloatingExtPalette descriptor={p} />}
      </For>
      <PaletteContextMenu />
      <SymbolSettingsDialog />
      <SymbolTypeEditor />
      <SchedulePanel />
      <LoadingOverlay />
      <TypeLengthHUD />
      <KeystrokeOverlay />
      <BoxSizeOverlay />
      <SketchModeBar />
      <TourCoach />
      <TooltipLayer />
    </>
  );
}

export default function App() {
  if (isMobile()) {
    return <MobileApp />;
  }
  return <DesktopApp />;
}

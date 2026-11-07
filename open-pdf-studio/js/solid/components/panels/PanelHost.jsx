// Panel host (the external editor pull-out): <PanelHost host="left|right|bottom" />.
// Driven entirely by workspaceLayout.js: the host shows its access bar, the
// active panel (header + body) at the stored size, and an inner edge strip
// that resizes on drag and collapses/expands on click.
//
//   left:   [access bar][panel][edge]      (access bar on the window edge)
//   right:  [edge][panel][access bar]      (access bar only while it has tabs)
//   bottom: [edge] over [access bar][panel] (» toggle at the top of its bar)
//
// Every panel in a host stays mounted (switching tabs keeps scroll positions
// and the thumbnail container); a panel moved to another host remounts there.
// Start-up mounts only each host's active panel; the others (and the code
// files of their bodies) follow once the editor is ready and idle, or as
// soon as one is shown.

import { For, Show, createEffect, createSignal, on, onMount, untrack } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import {
  workspaceLayout, getHost, getPanelHost, setHostSize, saveWorkspaceLayout, showPanel, hidePanel,
} from '../../stores/workspaceLayout.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { lucide } from '../../data/lucideIcons.js';
import {
  isHostOpen, isAccessBarVisible, resizedHostSize, keyResizedHostSize, isEdgeClick, PANEL_ZOOM_RANGE, clampPanelZoom,
} from './panelHostLogic.js';
import { state } from '../../../core/state.js';
import { savePreferences } from '../../../core/preferences.js';
import { getPanelEntry } from './panelRegistry.js';
import { installPanelShortcuts, toggleHost } from './panelActions.js';
import AccessBar from './AccessBar.jsx';
import PanelHeader from './PanelHeader.jsx';
import { PanelMenuLayer } from './PanelMenu.jsx';
import {
  panelVisible as elementVisibilityShown, setPanelVisible as setElementVisibilityShown, refreshElementTypes,
} from '../../stores/elementVisibilityStore.js';

const isRtl = () => document.documentElement.dir === 'rtl';

// Whether the inactive panels may mount: after `ocudraw:ready` and an idle
// moment (at most 2 s later), so their bodies do not load on the way to ready.
const [inactivePanelsMount, setInactivePanelsMount] = createSignal(typeof window === 'undefined');
if (typeof window !== 'undefined') {
  window.addEventListener('ocudraw:ready', () => {
    const go = () => setInactivePanelsMount(true);
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 2000 });
    else setTimeout(go, 200);
  }, { once: true });
}

function HostEdge(props) {
  const { t } = useTranslation('common');
  let start = null;

  const down = (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, size: getHost(props.host).size, moved: false, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.classList.add('dragging');
    e.preventDefault();
  };
  const move = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved && isEdgeClick(dx, dy)) return;
    start.moved = true;
    if (!isHostOpen(workspaceLayout(), props.host)) return;
    const delta = props.host === 'bottom' ? dy : dx;
    setHostSize(props.host, resizedHostSize(props.host, start.size, delta, { rtl: isRtl() }), { persist: false });
  };
  const up = (e) => {
    if (!start || (e.pointerId !== undefined && e.pointerId !== start.id)) return;
    const wasClick = !start.moved;
    start = null;
    e.currentTarget.classList.remove('dragging');
    if (wasClick) toggleHost(props.host);
    else saveWorkspaceLayout();
  };
  const key = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleHost(props.host);
      return;
    }
    const next = keyResizedHostSize(props.host, getHost(props.host).size, e.key, { rtl: isRtl() });
    if (next === null) return;
    e.preventDefault();
    setHostSize(props.host, next);
  };

  return (
    <div class={`ws-host-edge ws-host-edge-${props.host}`} role="separator" tabindex="0"
      aria-orientation={props.host === 'bottom' ? 'horizontal' : 'vertical'}
      aria-label={t('panelHost.resizeHost', { host: t(`panelHost.${props.host}`) })}
      title={t('panelHost.collapseHost')}
      aria-valuenow={getHost(props.host)?.size}
      aria-valuemin={props.host === 'bottom' ? 140 : 200} aria-valuemax={520}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onKeyDown={key} />
  );
}

// Panel-specific header buttons (the ▾ menu holds the rest).
// The Tool Chest and Markups List draw their own header (ownHeader).
function headerActions(panelId, t) {
  if (panelId === 'thumbnails' && window.__TAURI__?.webviewWindow?.WebviewWindow) {
    return [{
      title: t('panelHost.detachThumbnails'), icon: lucide('external-link'),
      run: () => import('../../../ui/panels/detached-thumbnails.js')
        .then(({ openDetachedThumbnails }) => openDetachedThumbnails())
        .catch((error) => console.warn('[thumbnails] could not open separate view:', error)),
    }];
  }
  return [];
}

// the external editor size slider under Thumbnails and the Tool Chest: zooms the tiles,
// remembered per panel in the preferences (panelZoom).
function SizeSlider(props) {
  const { t } = useTranslation('common');
  return (
    <div class="ws-panel-footer">
      <span class="ws-panel-footer-icon small" innerHTML={lucide('minus')} />
      <input type="range" min={PANEL_ZOOM_RANGE.min} max={PANEL_ZOOM_RANGE.max} step={PANEL_ZOOM_RANGE.step}
        value={props.zoom} aria-label={t('panelHost.size')}
        onInput={(e) => props.onInput(clampPanelZoom(e.currentTarget.value))}
        onChange={() => savePreferences()} />
      <span class="ws-panel-footer-icon" innerHTML={lucide('plus')} />
    </div>
  );
}

function PanelSlot(props) {
  const { t } = useTranslation('common');
  const entry = () => getPanelEntry(props.panelId);
  // Once mounted a body stays mounted (as before); see the note at the top.
  const [mounted, setMounted] = createSignal(false);
  createEffect(() => { if (props.active || inactivePanelsMount()) setMounted(true); });
  const zoom = () => clampPanelZoom(state.preferences?.panelZoom?.[props.panelId] ?? 1);
  const setZoom = (value) => {
    if (!state.preferences) return;
    state.preferences.panelZoom = { ...(state.preferences.panelZoom || {}), [props.panelId]: value };
  };
  return (
    <section class={`ws-panel-slot${props.active ? ' active' : ''}`} data-panel={props.panelId}
      aria-hidden={props.active ? undefined : 'true'} style={{ '--ws-panel-zoom': String(zoom()) }}>
      <Show when={!entry()?.ownHeader}>
        <PanelHeader panelId={props.panelId} actions={headerActions(props.panelId, t)} />
      </Show>
      <div class="ws-panel-body">
        <Show when={mounted() && entry()?.component}>
          <Dynamic component={entry().component} />
        </Show>
      </div>
      <Show when={entry()?.sizeSlider}>
        <SizeSlider zoom={zoom()} onInput={setZoom} />
      </Show>
    </section>
  );
}

function PanelArea(props) {
  const host = () => workspaceLayout().hosts[props.host];
  const sizeStyle = () => (props.host === 'bottom'
    ? { height: `${host().size}px` }
    : { width: `${host().size}px` });
  return (
    <div class="ws-host-panel" style={sizeStyle()}>
      <For each={host().tabs}>{(id) => (
        <PanelSlot panelId={id} active={host().active === id} />
      )}</For>
    </div>
  );
}

// App-wide wiring that belongs to the hosts: keyboard shortcuts, the popup
// menu, and the Element Visibility panel's own open/closed signal.
function HostServices() {
  onMount(() => installPanelShortcuts());
  createEffect(on(elementVisibilityShown, (visible) => {
    const where = untrack(() => getPanelHost('elementVisibility'));
    if (visible && !where) showPanel('elementVisibility');
    else if (!visible && where) hidePanel('elementVisibility');
  }, { defer: true }));
  createEffect(on(() => getPanelHost('elementVisibility'), (where) => {
    if (!where && untrack(elementVisibilityShown)) setElementVisibilityShown(false);
    else if (where && !untrack(elementVisibilityShown)) {
      setElementVisibilityShown(true);
      refreshElementTypes();
    }
  }));
  return <PanelMenuLayer />;
}

export default function PanelHost(props) {
  const layout = workspaceLayout;
  const open = () => isHostOpen(layout(), props.host);
  const hasTabs = () => (layout().hosts[props.host]?.tabs.length || 0) > 0;
  const barVisible = () => isAccessBarVisible(layout(), props.host);
  const cls = () => `ws-host ws-host-${props.host}${open() ? ' open' : ' collapsed'}${hasTabs() ? '' : ' empty'}`
    + (props.host === 'bottom' ? ' markups-dock' : '');

  if (props.host === 'bottom') {
    return (
      <Show when={hasTabs()}>
        <section class={cls()} data-host="bottom" aria-label="Bottom panel">
          <Show when={open()}><HostEdge host="bottom" /></Show>
          <div class="ws-host-row">
            <AccessBar host="bottom" />
            <div class="ws-host-panel-wrap" hidden={!open()}>
              <PanelArea host="bottom" />
            </div>
          </div>
        </section>
      </Show>
    );
  }

  return (
    <div class={cls()} data-host={props.host}>
      <Show when={props.host === 'left'}><HostServices /></Show>
      <Show when={props.host === 'left' && barVisible()}><AccessBar host="left" /></Show>
      <Show when={props.host === 'right' && hasTabs()}><HostEdge host="right" /></Show>
      <div class="ws-host-panel-wrap" hidden={!open()}>
        <PanelArea host={props.host} />
      </div>
      <Show when={props.host === 'left' && hasTabs()}><HostEdge host="left" /></Show>
      <Show when={props.host === 'right' && barVisible()}><AccessBar host="right" /></Show>
    </div>
  );
}

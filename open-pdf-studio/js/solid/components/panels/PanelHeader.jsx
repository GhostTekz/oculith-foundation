// Panel header (the external editor): 36 px row with the bold panel title and a ▾ that opens
// the panel menu (panel items, Hide, Attach ▸), then panel-specific actions.
// Panels with `ownHeader` in the registry (Tool Chest, Markups List) render
// it themselves, with their search and buttons as children.

import { For, Show } from 'solid-js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { lucide } from '../../data/lucideIcons.js';
import { panelTitle } from './panelRegistry.js';
import { panelMenuItems } from './panelActions.js';
import { openPanelMenu } from './PanelMenu.jsx';
import { canPopOut, popOutPanel } from '../../../ui/panels/panel-popout.js';

export default function PanelHeader(props) {
  const { t } = useTranslation('common');
  // Thumbnails open their own separate view; any other panel is taken off
  // the app into a window of its own (panel-popout.js).
  const thumbnails = () => props.panelId === 'thumbnails';
  const detachable = () => (thumbnails() ? !!window.__TAURI__?.webviewWindow?.WebviewWindow : canPopOut());
  const openView = () => import('../../../ui/panels/detached-thumbnails.js')
    .then(({ openDetachedThumbnails }) => openDetachedThumbnails())
    .catch((error) => console.warn('[thumbnails] could not open separate view:', error));
  const outsideDrawing = async () => {
    const { cursorPosition, getCurrentWindow } = window.__TAURI__.window;
    const source = getCurrentWindow();
    const [cursor, position, size] = await Promise.all([
      cursorPosition(), source.outerPosition(), source.outerSize(),
    ]);
    // Some WebViews report a zero native outer size until a window manager
    // gives the window its final geometry. Browser outer dimensions remain
    // usable in that case.
    const width = size.width > 0 ? size.width : window.outerWidth;
    const height = size.height > 0 ? size.height : window.outerHeight;
    if (!(width > 0 && height > 0)) return false;
    return cursor.x < position.x || cursor.x > position.x + width
      || cursor.y < position.y || cursor.y > position.y + height;
  };
  const dragStart = (event) => {
    if (!detachable() || event.target.closest?.('.ws-panel-action')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', thumbnails() ? t('panelHost.detachThumbnails') : t('panelHost.popOut'));
  };
  const dragEnd = async (event) => {
    if (!detachable()) return;
    let outside = false;
    try {
      outside = await outsideDrawing();
    } catch {
      // Some WebViews provide usable screen coordinates when native cursor
      // lookup is unavailable.
      if ((event.screenX || event.screenY) && window.outerWidth > 0 && window.outerHeight > 0) {
        outside = event.screenX < window.screenX || event.screenX > window.screenX + window.outerWidth
          || event.screenY < window.screenY || event.screenY > window.screenY + window.outerHeight;
      }
    }
    if (!outside) return;
    if (thumbnails()) { void openView(); return; }
    // Where it was dropped, when the WebView reports it.
    const at = event.screenX || event.screenY ? { left: event.screenX - 40, top: event.screenY - 18 } : null;
    void popOutPanel(props.panelId, panelTitle(props.panelId, t), { at });
  };
  const openMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openPanelMenu(r.left, r.bottom + 2, panelMenuItems(props.panelId, t, { header: true }));
  };
  return (
    <div class={`ws-panel-header${props.class ? ` ${props.class}` : ''}`} data-panel={props.panelId}
      draggable={detachable()} onDragStart={dragStart} onDragEnd={dragEnd}
      title={detachable() ? t(thumbnails() ? 'panelHost.dragThumbnails' : 'panelHost.dragPanel') : undefined}>
      <button type="button" class="ws-panel-title" aria-haspopup="menu"
        title={t('panelHost.panelMenu', { panel: panelTitle(props.panelId, t) })}
        onClick={openMenu}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e); }}>
        <span class="ws-panel-title-text">{panelTitle(props.panelId, t)}</span>
        <span class="ws-panel-title-chevron" innerHTML={lucide('chevron-down')} />
      </button>
      <div class="ws-panel-header-actions">
        <For each={props.actions || []}>{(action) => (
          <button type="button" class="ws-panel-action" title={action.title}
            aria-label={action.title} onClick={action.run} innerHTML={action.icon} />
        )}</For>
        <Show when={props.children}>{props.children}</Show>
      </div>
    </div>
  );
}

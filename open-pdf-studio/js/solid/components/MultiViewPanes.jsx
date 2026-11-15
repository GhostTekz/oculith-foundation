// MultiView split panes (docs/reference/editor/workspace.md): one tab row per split and the
// passive view. Mounted inside .mv-panes only while the workspace is split;
// #pdf-container (the live view) is a sibling and the CSS grid places it in
// the active split (styles/multiview.css). Unsplit renders nothing here.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import { state } from '../../core/state.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { lucide } from '../data/lucideIcons.js';
import { showDocTabMenu, showDocListMenu } from '../stores/contextMenuStore.js';
import { createPassivePane } from '../../pdf/multiview-pane.js';
import { setAnnotationsRedrawnHook } from '../../annotations/rendering.js';
import {
  activePaneIndex, passivePaneIndex, paneDocIds, paneActiveDocId, activatePane, closePaneTab,
  moveTabToPane, reconcileWithDocuments, registerPassivePane, unregisterPassivePane,
  storedPassiveView, scheduleSyncFromLive, syncFromPassive, setTabMenuPane, isSwapping,
} from '../stores/multiViewStore.js';

const docById = (id) => state.documents.find((d) => d.id === id) || null;

// ── Tab drag between splits ───────────────────────────────────────────────
const DRAG_THRESHOLD = 5;
const [dragging, setDragging] = createSignal(null); // { docId, from, over, index }
let drag = null;

function tabRowAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.('.mv-tabs') || null;
}

function dropIndex(row, x) {
  const tabs = [...row.querySelectorAll('.mv-tab')];
  const i = tabs.findIndex((t) => { const r = t.getBoundingClientRect(); return x < r.left + r.width / 2; });
  return i < 0 ? tabs.length : i;
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.started) {
    if (Math.abs(e.clientX - drag.x) < DRAG_THRESHOLD && Math.abs(e.clientY - drag.y) < DRAG_THRESHOLD) return;
    drag.started = true;
    document.body.style.userSelect = 'none';
  }
  const row = tabRowAt(e.clientX, e.clientY);
  const over = row ? Number(row.dataset.pane) : null;
  setDragging({ docId: drag.docId, from: drag.from, over, index: row ? dropIndex(row, e.clientX) : null });
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  document.body.style.userSelect = '';
  const d = dragging();
  const started = drag?.started;
  drag = null;
  setDragging(null);
  if (started && d && d.over !== null && d.over !== d.from) {
    moveTabToPane(d.docId, d.from, d.over, { index: d.index });
  }
}

function startTabDrag(e, docId, pane) {
  if (e.button !== 0 || e.target.closest('.mv-tab-close')) return;
  drag = { docId, from: pane, x: e.clientX, y: e.clientY, started: false };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

/** The tab row of one split. */
export function MultiViewTabs(props) {
  const { t } = useTranslation('statusbar');
  const { t: tCtx } = useTranslation('context');
  const docs = () => paneDocIds(props.pane).map(docById).filter(Boolean);
  const isActivePane = () => activePaneIndex() === props.pane;
  const dropHere = () => { const d = dragging(); return !!d && d.over === props.pane && d.from !== props.pane; };

  return (
    <div class="mv-tabs" data-pane={props.pane}
      classList={{ 'mv-active': isActivePane(), 'mv-drop': dropHere() }}
      role="tablist" aria-label={t('multiView.pane', { n: props.pane + 1 })}>
      <div class="mv-tabs-strip">
        <For each={docs()}>
          {(doc) => {
            const selected = () => paneActiveDocId(props.pane) === doc.id;
            return (
              <div class="mv-tab document-tab" data-doc-id={doc.id}
                classList={{ active: selected(), 'mv-live': selected() && isActivePane() }}
                onMouseDown={(e) => startTabDrag(e, doc.id, props.pane)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closePaneTab(props.pane, doc.id); } }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTabMenuPane(props.pane);
                  const index = state.documents.indexOf(doc);
                  if (index >= 0) showDocTabMenu(e.clientX, e.clientY, index);
                }}>
                <button type="button" class="document-tab-select" role="tab"
                  aria-selected={selected() ? 'true' : 'false'}
                  onClick={() => activatePane(props.pane, doc.id)}>
                  <span class="document-tab-modified" aria-hidden="true">{doc.modified ? '*' : ''}</span>
                  <span class="document-tab-title" title={doc.filePath || doc.fileName}>{doc.fileName}</span>
                </button>
                <button type="button" class="document-tab-close mv-tab-close" title={t('closeTab')}
                  aria-label={`${t('closeTab')}: ${doc.fileName}`}
                  onClick={(e) => { e.stopPropagation(); closePaneTab(props.pane, doc.id); }}>&times;</button>
              </div>
            );
          }}
        </For>
      </div>
      <button type="button" class="document-tabs-list mv-tabs-list"
        title={tCtx('docTab.openDocuments')} aria-label={tCtx('docTab.openDocuments')} aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showDocListMenu(Math.round(r.left), Math.round(r.bottom));
        }}>
        <span innerHTML={lucide('chevron-down')} />
      </button>
    </div>
  );
}

/** The passive split: a read-only second view (js/pdf/multiview-pane.js). */
export function PassivePane() {
  let host;
  let pane = null;
  const [pageText, setPageText] = createSignal('');

  const updateBadge = () => {
    const doc = pane?.doc;
    setPageText(doc?.pdfDoc ? `${pane.page} / ${doc.pdfDoc.numPages}` : '');
  };

  // Re-open the passive view only when what it shows changes: the active
  // split swapped, its tab changed, or the document was reloaded.
  const key = createMemo(() => {
    const p = passivePaneIndex();
    const id = paneActiveDocId(p);
    const doc = docById(id);
    return `${activePaneIndex()}|${id}|${doc?.pdfDoc ? 'pdf' : 'none'}|${doc?.pdfDoc?.numPages || 0}`;
  });

  const showStored = async () => {
    if (!pane) return;
    const target = untrack(storedPassiveView);
    if (!target) { pane.clear(); return; }
    await pane.show(target.doc, target.view);
  };

  onMount(() => {
    pane = createPassivePane(host, { onShow: () => updateBadge() });
    registerPassivePane(pane);
    setAnnotationsRedrawnHook(() => pane?.scheduleAnnotations());
    showStored();
  });

  createEffect(on(key, () => { showStored(); }, { defer: true }));

  onCleanup(() => {
    setAnnotationsRedrawnHook(null);
    unregisterPassivePane(pane);
    pane?.destroy();
    pane = null;
  });

  const activate = () => activatePane(passivePaneIndex());

  // The live view's wheel handler sits on .main-view; this view scrolls
  // natively and zooms itself.
  const onWheel = async (e) => {
    e.stopPropagation();
    if (!(e.ctrlKey || e.metaKey || state.preferences.wheelZoomWithoutCtrl) || !pane?.doc) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const scale = Math.min(10, Math.max(0.1, (pane.scale || 1) * factor));
    const b = pane.box();
    const cx = (b.scrollLeft + b.clientWidth / 2) / Math.max(1, b.scrollWidth);
    const cy = (b.scrollTop + b.clientHeight / 2) / Math.max(1, b.scrollHeight);
    const doc = pane.doc;
    await pane.show(doc, { page: pane.page, scale });
    const nb = pane.box();
    await pane.show(doc, {
      page: pane.page, scale,
      scrollLeft: Math.max(0, cx * nb.scrollWidth - nb.clientWidth / 2),
      scrollTop: Math.max(0, cy * nb.scrollHeight - nb.clientHeight / 2),
    });
    syncFromPassive({ zoomed: true });
  };

  return (
    <div class="mv-passive" data-pane={passivePaneIndex()}>
      <div class="mv-pane-view" ref={host}
        onPointerDown={activate}
        onWheel={onWheel}
        onScroll={() => syncFromPassive()} />
      <Show when={pageText()}>
        <div class="mv-page-badge" aria-hidden="true">{pageText()}</div>
      </Show>
    </div>
  );
}

/**
 * Everything the split workspace needs while it exists: two tab rows, the
 * passive view, and the listeners that keep panes and Sync in step.
 */
export default function MultiViewPanes() {
  // Opened / closed / switched documents.
  createEffect(() => {
    state.documents.map((d) => d.id);
    void state.activeDocumentIndex;
    untrack(reconcileWithDocuments);
  });

  // Live page and zoom changes drive Sync.
  createEffect(() => {
    const doc = state.documents[state.activeDocumentIndex];
    void doc?.currentPage;
    void doc?.scale;
    if (!untrack(isSwapping)) scheduleSyncFromLive();
  });

  const onLiveScroll = () => scheduleSyncFromLive();
  onMount(() => document.getElementById('pdf-container')?.addEventListener('scroll', onLiveScroll, { passive: true }));
  onCleanup(() => document.getElementById('pdf-container')?.removeEventListener('scroll', onLiveScroll));

  return (
    <>
      <MultiViewTabs pane={0} />
      <MultiViewTabs pane={1} />
      <PassivePane />
    </>
  );
}

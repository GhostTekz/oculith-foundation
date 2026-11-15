// Navigation bar (the external editor: F4), along the bottom of the canvas column only.
// Left: split view (MultiView: Unsplit / Split Vertical / Split Horizontal),
// page layout, pan / select.
// Centre: first / previous / page field / next / last, Previous / Next View.
// The page field, zoom, page size and scale have fixed widths, so the page
// buttons stay put while their text changes from page to page
// (navigation-bar.css).
// Right: zoom (our addition), page size, page scale (click: Set Scale),
// document properties, dimmer, workspace profile (Oculith ▸ Profiles).
// Visibility: workspaceLayout.toolbars.navigation (F4). The component stays
// mounted while hidden so the content filter, keys and cursor tracking
// keep working.

import { Show, For, createMemo, createResource, createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { state } from '../../core/state.js';
import { useTranslation, localizeNumber } from '../../i18n/useTranslation.js';
import { lucide } from '../data/lucideIcons.js';
import { edition } from '../../editions/active.js';
import { isToolbarVisible, PROFILE_IDS, activeProfile } from '../stores/workspaceLayout.js';
import { getCommand, commandLabel, runCommand, isCommandEnabled } from '../commands/index.js';
import { splitOrientation } from '../stores/multiViewStore.js';
import { openPanelMenu } from './panels/PanelMenu.jsx';
import { pageScaleStatus } from '../../annotations/scale-entry.js';
import { scaleChip, openScaleChip } from '../../ui/chrome/scale-chip.js';
import {
  formatPageField, parsePageInput, formatPageSize, paperUnitFor, pageScaleOf, scaleLabel, DIMMER_MAX,
} from '../../ui/chrome/navigation-format.js';
import { pageStepTarget } from '../../pdf/page-step.js';
import { canGoBackView, canGoForwardView, goBackView, goForwardView } from '../../core/view-history.js';
import {
  applyContentFilter, isDimmerOn, toggleDimmer, dimmerLevel, setDimmerLevel, isDarkContentOn, toggleDarkContent,
} from '../stores/contentDisplay.js';
import { installNavigationKeys } from '../../ui/chrome/navigation-commands.js';
import { installCursorTracker } from '../../tools/cursor-readout.js';

const ICON = {
  unsplit: lucide('square'),
  splitV: lucide('columns-2'),
  splitH: lucide('rows-2'),
  single: lucide('file'),
  continuous: lucide('gallery-vertical'),
  book: lucide('book-open'),
  facing: lucide('columns-2'),
  pan: lucide('hand'),
  select: lucide('mouse-pointer-2'),
  selectText: lucide('text-cursor'),
  first: lucide('chevron-first'),
  prev: lucide('chevron-left'),
  next: lucide('chevron-right'),
  last: lucide('chevron-last'),
  prevView: lucide('circle-arrow-left'),
  nextView: lucide('circle-arrow-right'),
  zoomOut: lucide('minus'),
  zoomIn: lucide('plus'),
  info: lucide('info'),
  sun: lucide('sun'),
  moon: lucide('sun-moon'),
  caret: lucide('chevron-down'),
  profile: lucide('circle-user'),
};

const renderer = () => import('../../pdf/renderer.js');

// PDF page labels (/PageLabels), read once per PDF.
const labelCache = new WeakMap();
function readPageLabels(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc.getPageLabels !== 'function') return Promise.resolve(null);
  if (!labelCache.has(pdfDoc)) {
    labelCache.set(pdfDoc, Promise.resolve().then(() => pdfDoc.getPageLabels())
      .then((labels) => (Array.isArray(labels) && labels.some(Boolean) ? labels : null))
      .catch(() => null));
  }
  return labelCache.get(pdfDoc);
}

function Btn(props) {
  return (
    <button type="button" class="nav-btn" id={props.id}
      classList={{ active: !!props.active }}
      disabled={props.disabled}
      title={props.title} aria-label={props.title}
      aria-pressed={props.active === undefined ? undefined : (props.active ? 'true' : 'false')}
      onClick={() => props.onClick?.()}>
      <span class="nav-icon" innerHTML={props.icon} />
    </button>
  );
}

export default function NavigationBar() {
  const { t, language } = useTranslation('statusbar');
  const doc = () => state.documents[state.activeDocumentIndex];
  const hasPdf = () => !!doc()?.pdfDoc;
  const page = () => doc()?.currentPage || 1;
  const numPages = () => doc()?.pdfDoc?.numPages || 0;

  onMount(() => {
    installNavigationKeys();
    installCursorTracker();
  });
  // Reapply when the preferences load or change (dimmer / dark mode).
  createEffect(() => {
    isDimmerOn(); dimmerLevel(); isDarkContentOn();
    applyContentFilter();
  });

  const [labels] = createResource(() => doc()?.pdfDoc, readPageLabels);
  // The page field has a fixed width (the Previous / Next buttons never move
  // with its text); a long page label is shortened to what fits, the full
  // text is the tooltip.
  const [fieldChars, setFieldChars] = createSignal(0);
  const pageOf = (p, n) => t('navbar.pageOf', { page: localizeNumber(p), total: localizeNumber(n) });
  const pageText = () => formatPageField(page(), numPages(), labels() || null, pageOf, fieldChars());
  const pageFullText = () => formatPageField(page(), numPages(), labels() || null, pageOf);

  const [pageInfo] = createResource(
    () => (hasPdf() ? { pdfDoc: doc().pdfDoc, page: page() } : null),
    async ({ pdfDoc, page: n }) => {
      const p = await pdfDoc.getPage(n);
      const [x0, y0, x1, y1] = p.view;
      return { widthPt: x1 - x0, heightPt: y1 - y0, rotation: p.rotate || 0 };
    });

  const scale = createMemo(() => (hasPdf() ? pageScaleOf(doc(), page(), state.preferences?.measureScale) : null));
  const scaleStatus = createMemo(() => (hasPdf() ? pageScaleStatus(doc(), page(), state.preferences?.measureScale) : null));
  const paperUnit = () => paperUnitFor(scale()?.unit, language());
  const pageSizeText = () => {
    const info = pageInfo();
    return info ? formatPageSize(info.widthPt, info.heightPt, paperUnit(), info.rotation) : '';
  };
  const chip = () => {
    const s = scaleStatus();
    return s ? scaleChip(s, t, s.kind === 'set' ? scaleLabel(scale()) : '') : null;
  };
  const scaleText = () => chip()?.text || '';
  const scaleUnset = () => chip()?.tone !== 'ok';

  // ── Page navigation ──
  const go = async (n) => {
    if (!hasPdf()) return;
    const target = Math.min(Math.max(n, 1), numPages());
    if (target !== page()) await (await renderer()).goToPage(target);
  };
  // Previous / Next: quick clicks queue up to the latest target (page-step.js).
  const step = async (delta) => {
    if (!hasPdf()) return;
    const target = pageStepTarget(doc(), delta);
    if (target != null) await (await renderer()).goToPage(target);
  };
  let pageInput;
  const resetPageInput = () => { if (pageInput) pageInput.value = pageText(); };
  // Characters that fit the page field (monospaced digits): on mount and
  // whenever the bar's width steps change the field width.
  let measure;
  const measureField = () => {
    if (!pageInput || !pageInput.clientWidth) return;
    const cs = getComputedStyle(pageInput);
    measure ||= document.createElement('canvas').getContext('2d');
    if (!measure) return;
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const glyph = measure.measureText('0').width || 7;
    const inner = pageInput.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    setFieldChars(Math.max(4, Math.floor(inner / glyph)));
  };
  let fieldObserver;
  onCleanup(() => fieldObserver?.disconnect());
  const commitPage = async () => {
    const target = parsePageInput(pageInput?.value, numPages(), labels() || null);
    if (target == null) {
      pageInput?.classList.add('invalid');
      setTimeout(() => pageInput?.classList.remove('invalid'), 600);
      resetPageInput();
      return;
    }
    pageInput.blur();
    await go(target);
    resetPageInput();
  };

  // ── Page layout and tools ──
  const viewMode = () => doc()?.viewMode || 'single';
  const book = () => !!doc()?.bookSpread;
  const facing = () => !!doc()?.facingSpread;
  const layoutActive = (mode) => {
    if (mode === 'single') return viewMode() === 'single';
    if (viewMode() !== 'continuous') return false;
    if (mode === 'facing') return facing();
    if (mode === 'book') return book() && !facing();
    return !book() && !facing();
  };
  const setLayout = async (mode) => { if (hasPdf()) await (await renderer()).setViewMode(mode); };
  const setTool = (tool) => import('../../tools/manager.js').then((m) => m.setTool(tool));

  // ── Zoom (accepted deviation: the external editor has the Zoom tool only) ──
  const zoomText = () => `${localizeNumber(Math.round((doc()?.scale || 1.5) * 100))}%`;
  const commitZoom = async (input) => {
    const pct = parseInt(String(input.value).replace('%', '').trim(), 10);
    if (Number.isFinite(pct) && pct >= 10 && pct <= 500 && hasPdf()) await (await renderer()).setZoom(pct / 100);
    input.value = zoomText();
    input.blur();
  };

  // ── Dimmer popover ──
  const [dimmerOpen, setDimmerOpen] = createSignal(false);
  const [popoverAt, setPopoverAt] = createSignal({ right: 8, bottom: 40 });
  let dimmerWrap;
  const onDocPointer = (e) => { if (dimmerOpen() && dimmerWrap && !dimmerWrap.contains(e.target)) setDimmerOpen(false); };
  const onDocKey = (e) => { if (e.key === 'Escape' && dimmerOpen()) setDimmerOpen(false); };
  onMount(() => {
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
  });
  onCleanup(() => {
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
  });
  const dimmerPercent = () => Math.round(dimmerLevel() * 100);

  const openSetScale = () => openScaleChip(chip(), page());
  const openDocProperties = () => import('../../ui/chrome/dialogs.js').then((m) => m.showDocPropertiesDialog());

  // MultiView: the same commands as View > Split Vertical / Horizontal / Unsplit.
  const SPLIT_BUTTONS = [
    ['unsplit', ICON.unsplit, 'view.unsplit', null],
    ['splitVertical', ICON.splitV, 'view.splitVertical', 'vertical'],
    ['splitHorizontal', ICON.splitH, 'view.splitHorizontal', 'horizontal'],
  ];
  const splitTitle = (key, id) => {
    const cmd = getCommand(id);
    return cmd?.shortcut ? `${t(`navbar.${key}`)} (${cmd.shortcut})` : t(`navbar.${key}`);
  };
  const splitActive = (orientation) => (splitOrientation() || null) === orientation;

  // ── Profile menu (opens upwards; the bar sits at the bottom) ──
  const profileCommand = (id) => getCommand(`oculith.profile.${id}`);
  const profileTitle = () => {
    const cmd = profileCommand(activeProfile());
    return cmd ? `${t('navbar.profile')}: ${commandLabel(cmd, t)}` : t('navbar.profile');
  };
  const openProfileMenu = (e) => {
    const r = e.currentTarget.closest('.nav-profile').getBoundingClientRect();
    const items = PROFILE_IDS.filter((id) => profileCommand(id)).map((id) => ({
      label: commandLabel(profileCommand(id), t),
      checked: activeProfile() === id,
      run: () => runCommand(`oculith.profile.${id}`),
    }));
    openPanelMenu(Math.max(4, r.right - 220), Math.max(4, r.top - items.length * 26 - 10), items);
  };

  return (
    <Show when={isToolbarVisible('navigation') && hasPdf()}>
      <div class="nav-bar" id="navigation-bar" role="toolbar" aria-label={t('navbar.label')}>
        <div class="nav-bar-section nav-bar-left">
          <For each={SPLIT_BUTTONS}>
            {([key, icon, id, orientation]) => (
              <Btn id={`nav-${key}`} icon={icon} title={splitTitle(key, id)}
                active={splitActive(orientation)}
                disabled={!isCommandEnabled(id) && !splitActive(orientation)}
                onClick={() => { if (!splitActive(orientation)) runCommand(id); }} />
            )}
          </For>
          <span class="nav-sep nav-sep-split" />
          <Btn id="nav-layout-single" icon={ICON.single} title={t('viewSingle')} active={layoutActive('single')} onClick={() => setLayout('single')} />
          <Btn id="nav-layout-continuous" icon={ICON.continuous} title={t('viewContinuous')} active={layoutActive('continuous')} onClick={() => setLayout('continuous')} />
          <Btn id="nav-layout-book" icon={ICON.book} title={t('viewBook')} active={layoutActive('book')} onClick={() => setLayout('book')} />
          <Btn id="nav-layout-facing" icon={ICON.facing} title={t('viewFacing')} active={layoutActive('facing')} onClick={() => setLayout('facing')} />
          <span class="nav-sep" />
          <Btn id="nav-tool-pan" icon={ICON.pan} title={t('navbar.pan')} active={state.currentTool === 'hand'} onClick={() => setTool('hand')} />
          <Btn id="nav-tool-select" icon={ICON.select} title={t('navbar.select')} active={state.currentTool === 'select'} onClick={() => setTool('select')} />
          <Btn id="nav-tool-select-text" icon={ICON.selectText} title={t('navbar.selectText')} onClick={() => setTool('select')} />
        </div>

        <div class="nav-bar-section nav-bar-center">
          <Btn id="nav-first" icon={ICON.first} title={t('firstPage')} disabled={page() <= 1} onClick={() => go(1)} />
          <Btn id="nav-prev" icon={ICON.prev} title={`${t('previousPage')} (PageUp)`} disabled={page() <= 1} onClick={() => step(-1)} />
          <input ref={(el) => {
              pageInput = el;
              if (typeof ResizeObserver === 'function') {
                fieldObserver?.disconnect();
                fieldObserver = new ResizeObserver(measureField);
                fieldObserver.observe(el);
              }
            }} type="text" class="nav-page-input" id="nav-page-input"
            value={pageText()} title={`${pageFullText()}\n${t('navbar.pageField')}`} aria-label={t('navbar.pageField')}
            spellcheck={false} autocomplete="off"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitPage(); }
              else if (e.key === 'Escape') { e.preventDefault(); resetPageInput(); e.currentTarget.blur(); }
            }}
            onBlur={resetPageInput} />
          <Btn id="nav-next" icon={ICON.next} title={`${t('nextPage')} (PageDown)`} disabled={page() >= numPages()} onClick={() => step(1)} />
          <Btn id="nav-last" icon={ICON.last} title={t('lastPage')} disabled={page() >= numPages()} onClick={() => go(numPages())} />
          <span class="nav-sep" />
          <Btn id="nav-previous-view" icon={ICON.prevView} title={`${t('navbar.previousView')} (Alt+Left)`} disabled={!canGoBackView()} onClick={() => goBackView()} />
          <Btn id="nav-next-view" icon={ICON.nextView} title={`${t('navbar.nextView')} (Alt+Right)`} disabled={!canGoForwardView()} onClick={() => goForwardView()} />
        </div>

        <div class="nav-bar-section nav-bar-right">
          <div class="nav-zoom">
            <Btn id="nav-zoom-out" icon={ICON.zoomOut} title={t('zoomOut')} onClick={() => renderer().then((m) => m.zoomOut())} />
            <input type="text" class="nav-zoom-input" id="nav-zoom-input" value={zoomText()}
              title={t('navbar.zoomField')} aria-label={t('navbar.zoomField')} spellcheck={false} autocomplete="off"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitZoom(e.currentTarget); } }}
              onBlur={(e) => { e.currentTarget.value = zoomText(); }} />
            <Btn id="nav-zoom-in" icon={ICON.zoomIn} title={t('zoomIn')} onClick={() => renderer().then((m) => m.zoomIn())} />
          </div>
          <span class="nav-sep nav-sep-zoom" />
          <span class="nav-readout" id="nav-page-size" title={`${t('pageSizeTitle')}: ${pageSizeText()}`}>{pageSizeText()}</span>
          <button type="button" class="nav-scale" id="nav-scale" classList={{ 'nav-scale--unset': scaleUnset() }}
            data-scale-tone={chip()?.tone} title={chip()?.title} onClick={openSetScale}>{scaleText()}</button>
          <Btn id="nav-doc-properties" icon={ICON.info} title={t('navbar.documentProperties')} onClick={openDocProperties} />
          <div class="nav-split-btn" ref={dimmerWrap}>
            <Btn id="nav-dimmer" icon={ICON.sun} title={t('navbar.dimmerTitle')} active={isDimmerOn()} onClick={() => toggleDimmer()} />
            <button type="button" class="nav-caret" id="nav-dimmer-menu" title={t('navbar.dimmerOptions')}
              aria-label={t('navbar.dimmerOptions')} aria-haspopup="true" aria-expanded={dimmerOpen() ? 'true' : 'false'}
              onClick={(e) => {
                // Fixed position: the bar clips its overflow.
                const r = e.currentTarget.getBoundingClientRect();
                setPopoverAt({ right: Math.max(4, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 });
                setDimmerOpen(!dimmerOpen());
              }}>
              <span class="nav-icon" innerHTML={ICON.caret} />
            </button>
            <Show when={dimmerOpen()}>
              <div class="nav-popover" id="nav-dimmer-popover" role="dialog" aria-label={t('navbar.dimmerOptions')}
                style={{ right: `${popoverAt().right}px`, bottom: `${popoverAt().bottom}px` }}>
                <label class="nav-popover-row">
                  <span>{t('navbar.dimmerLevel', { percent: localizeNumber(dimmerPercent()) })}</span>
                  <input type="range" id="nav-dimmer-level" min="0" max={Math.round(DIMMER_MAX * 100)} step="5"
                    value={dimmerPercent()}
                    onInput={(e) => setDimmerLevel(Number(e.currentTarget.value) / 100, { persist: false })}
                    onChange={(e) => setDimmerLevel(Number(e.currentTarget.value) / 100)} />
                </label>
                <label class="nav-popover-row nav-popover-check">
                  <input type="checkbox" id="nav-dark-mode" checked={isDarkContentOn()} onChange={() => toggleDarkContent()} />
                  <span class="nav-icon" innerHTML={ICON.moon} />
                  <span title={t('navbar.darkModeTitle')}>{t('navbar.darkMode')}</span>
                </label>
              </div>
            </Show>
          </div>
          {/* An edition's own buttons. */}
          <For each={edition.toolbarItems || []}>{(item) => (
            <Btn id={`nav-${item.id}`} icon={item.icon} title={item.title} onClick={() => item.run()} />
          )}</For>
          {/* Profile switcher (the external editor): the Oculith ▸ Profiles commands. */}
          <div class="nav-split-btn nav-profile">
            <Btn id="nav-profile" icon={ICON.profile} title={profileTitle()} onClick={openProfileMenu} />
            <button type="button" class="nav-caret" id="nav-profile-menu" title={profileTitle()}
              aria-label={profileTitle()} aria-haspopup="menu" onClick={openProfileMenu}>
              <span class="nav-icon" innerHTML={ICON.caret} />
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

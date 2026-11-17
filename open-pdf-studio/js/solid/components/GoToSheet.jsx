// Go to Sheet (Ctrl+J, View ▸ Go To, the command
// palette): a quick box over the sheets of every open document, by sheet
// number, page label or title ("E2" → E-201). Matching lives in
// commands/go-to-sheet.js. Arrow keys move, Enter goes, Esc or a click
// outside closes: a transient picker like the command palette, which it
// shares its look with.

import { For, Show, createSignal, createMemo, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { OPEN_GO_TO_SHEET, sheetCandidates, rankSheets } from '../commands/go-to-sheet.js';
import { sheetRegister } from '../stores/sheetRegisterStore.js';
import { state } from '../../core/state.js';
import { lucide } from '../data/lucideIcons.js';
import { useTranslation } from '../../i18n/useTranslation.js';

const [open, setOpen] = createSignal(false);
export const goToSheetOpen = open;

const SHEET_ICON = lucide('file-text');

async function pageLabels(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc.getPageLabels !== 'function') return null;
  try {
    const labels = await pdfDoc.getPageLabels();
    return Array.isArray(labels) ? labels : null;
  } catch {
    return null;
  }
}

export default function GoToSheet() {
  const { t } = useTranslation('common');
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  const [docs, setDocs] = createSignal([]);
  let inputEl;
  let listEl;

  const sheets = createMemo(() => (open()
    ? sheetCandidates(docs(), { register: sheetRegister().sheets || [], activeIndex: state.activeDocumentIndex })
    : []));
  const rows = createMemo(() => rankSheets(sheets(), query()));
  const showDocName = createMemo(() => docs().length > 1);

  const collect = async () => {
    const list = state.documents.map((doc, index) => ({ doc, index })).filter(({ doc }) => doc?.pdfDoc);
    const out = await Promise.all(list.map(async ({ doc, index }) => ({
      index,
      name: doc.fileName || doc.filePath?.split(/[\\/]/).pop() || `#${index + 1}`,
      filePath: doc.filePath || '',
      numPages: doc.pdfDoc.numPages || 0,
      labels: await pageLabels(doc.pdfDoc),
    })));
    if (open()) setDocs(out);
  };

  const onOpen = () => {
    setQuery('');
    setActive(0);
    setDocs([]);
    setOpen(true);
    collect();
    queueMicrotask(() => inputEl?.focus());
  };
  onMount(() => window.addEventListener(OPEN_GO_TO_SHEET, onOpen));
  onCleanup(() => window.removeEventListener(OPEN_GO_TO_SHEET, onOpen));

  const close = () => setOpen(false);
  const go = async (sheet) => {
    if (!sheet) return;
    close();
    const doc = state.documents[sheet.docIndex];
    if (!doc?.pdfDoc) return;
    // Like a tab click: leave the comparison (it stays on its own tab), also
    // for a sheet of the drawing already shown, which would move behind it.
    (await import('../../compare/compare-store.js')).blurCompareTab();
    if (sheet.docIndex !== state.activeDocumentIndex) {
      const { switchToTab } = await import('../../ui/chrome/tabs.js');
      switchToTab(sheet.docIndex);
      // Let the switched document render before moving its page.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (state.documents[sheet.docIndex] !== doc || state.activeDocumentIndex !== sheet.docIndex) return;
    }
    const { goToPage } = await import('../../pdf/renderer.js');
    goToPage(sheet.page);
  };
  const move = (delta) => {
    const n = rows().length;
    if (!n) return;
    const next = (active() + delta + n) % n;
    setActive(next);
    listEl?.querySelector(`#go-to-sheet-row-${next}`)?.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(8); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-8); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows()[active()]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return (
    <Show when={open()}>
      <Portal>
        <div class="command-palette-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div class="command-palette go-to-sheet" role="dialog" aria-label={t('menu.goToSheet.title')}>
            <div class="command-palette-search">
              <span class="command-palette-search-icon" innerHTML={lucide('file-search')} aria-hidden="true" />
              <input
                ref={inputEl}
                class="command-palette-input"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder={t('menu.goToSheet.placeholder')}
                value={query()}
                role="combobox"
                aria-expanded="true"
                aria-controls="go-to-sheet-list"
                aria-activedescendant={rows().length ? `go-to-sheet-row-${active()}` : undefined}
                onInput={(e) => { setQuery(e.currentTarget.value); setActive(0); }}
                onKeyDown={onKeyDown}
              />
            </div>
            <div class="command-palette-list" id="go-to-sheet-list" role="listbox" ref={listEl}>
              <Show when={rows().length} fallback={<div class="command-palette-empty">{t('menu.goToSheet.empty')}</div>}>
                <For each={rows()}>
                  {(sheet, i) => (
                    <div
                      id={`go-to-sheet-row-${i()}`}
                      class="command-palette-row"
                      classList={{ active: active() === i() }}
                      role="option"
                      aria-selected={active() === i()}
                      data-sheet={sheet.key}
                      onPointerMove={() => { if (active() !== i()) setActive(i()); }}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => go(sheet)}
                    >
                      <span class="command-palette-icon" innerHTML={SHEET_ICON} />
                      <span class="command-palette-text">
                        <span class="command-palette-label">{sheet.number || t('menu.goToSheet.page', { page: sheet.page })}</span>
                        <Show when={sheet.title}><span class="command-palette-detail">{sheet.title}</span></Show>
                      </span>
                      <span class="command-palette-path">
                        {[showDocName() ? sheet.docName : '', sheet.number ? t('menu.goToSheet.page', { page: sheet.page }) : '']
                          .filter(Boolean).join(' › ')}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <div class="command-palette-footer" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> {t('menu.goToSheet.hintMove')}</span>
              <span><kbd>↵</kbd> {t('menu.goToSheet.hintGo')}</span>
              <span><kbd>Esc</kbd> {t('menu.goToSheet.hintClose')}</span>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

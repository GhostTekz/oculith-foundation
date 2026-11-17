// Find Tools + Commands (Ctrl+K / Cmd+K, Ctrl+Shift+P, Help menu): one
// search box over every command, tool, panel and workflow tab in the
// registry (an edition's and add-ons' commands too), the pages of the open
// drawing, the open documents, recent files and add-on tool palettes.
// Ranking and sources live in commands/palette.js. Arrow keys move, Enter
// runs, Alt+Enter pins a command to Quick Access, Esc or a click outside
// closes. It is a transient picker like a menu, not a modal dialog.

import { For, Show, createSignal, createMemo, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { getCommand, isCommandEnabled, runCommand } from '../commands/index.js';
import { OPEN_COMMAND_PALETTE } from '../commands/oculith.js';
import { commandEntries, pageEntries, paletteSections } from '../commands/palette.js';
import { shortcutParts } from '../commands/shortcut-display.js';
import { commandUsage } from '../stores/commandUsage.js';
import { isPinned, togglePinned } from '../stores/quickAccess.js';
import { getRegisteredPalettes } from '../../plugins/palette-registry.js';
import { state } from '../../core/state.js';
import { lucide } from '../data/lucideIcons.js';
import { useTranslation } from '../../i18n/useTranslation.js';

// Opened by runCommand('help.findCommands'), which fires OPEN_COMMAND_PALETTE.
const [open, setOpen] = createSignal(false);
export const commandPaletteOpen = open;

const PIN = lucide('pin');
const PIN_OFF = lucide('pin-off');

function Keys(props) {
  return (
    <span class="command-palette-keys" aria-hidden="true">
      <For each={shortcutParts(props.shortcut)}>{(part) => <kbd>{part}</kbd>}</For>
    </span>
  );
}

// Page labels of a PDF (/PageLabels), read once per PDF.
const labelCache = new WeakMap();
function readPageLabels(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc.getPageLabels !== 'function') return Promise.resolve(null);
  if (!labelCache.has(pdfDoc)) {
    labelCache.set(pdfDoc, Promise.resolve().then(() => pdfDoc.getPageLabels()).catch(() => null));
  }
  return labelCache.get(pdfDoc);
}

export default function CommandPalette() {
  const { t } = useTranslation('common');
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  const [extra, setExtra] = createSignal([]);
  const [labels, setLabels] = createSignal(null);
  let inputEl;
  let listEl;

  const entries = createMemo(() => {
    if (!open()) return [];
    const doc = state.documents[state.activeDocumentIndex];
    const pages = doc?.pdfDoc ? pageEntries({
      numPages: doc.pdfDoc.numPages || 0, labels: labels(), t,
      goTo: (page) => import('../../pdf/renderer.js').then((m) => m.goToPage(page)),
    }) : [];
    return [...commandEntries(t), ...extra(), ...pages];
  });
  const sections = createMemo(() => (open()
    ? paletteSections(query(), { t, entries: entries(), usage: commandUsage() })
    : []));
  const rows = createMemo(() => sections().flatMap((s) => s.entries));

  // Open documents, recent files and add-on tools, read as the palette opens.
  const collectExtra = async () => {
    const out = [];
    state.documents.forEach((doc, index) => {
      if (index === state.activeDocumentIndex || !doc) return;
      const name = doc.fileName || doc.filePath?.split(/[\\/]/).pop() || `#${index + 1}`;
      out.push({
        key: `doc:${index}`, kind: 'document', section: 'documents', label: name, id: name,
        path: [t('menu.palette.switchTo')], keywords: ['tab', 'document'], icon: lucide('file-text'),
        // Like a tab click: leave the comparison (it stays on its own tab).
        run: () => Promise.all([import('../../compare/compare-store.js'), import('../../ui/chrome/tabs.js')])
          .then(([compare, m]) => { compare.blurCompareTab(); m.switchToTab(index); }),
      });
    });
    try {
      const { getRecentFiles } = await import('../../mobile/recent-files.js');
      const openPaths = new Set(state.documents.map((d) => d?.filePath).filter(Boolean));
      for (const file of getRecentFiles().slice(0, 20)) {
        if (!file?.path || openPaths.has(file.path)) continue;
        out.push({
          key: `file:${file.path}`, kind: 'file', section: 'files', label: file.name || file.path, id: file.path,
          detail: file.path, path: [t('menu.palette.open')], keywords: ['recent', 'file', 'open'],
          icon: lucide('history'),
          run: async () => {
            const [{ createTab }, { loadPDFIfNeeded }] = await Promise.all([
              import('../../ui/chrome/tabs.js'), import('../../pdf/loader.js')]);
            const { index } = createTab(file.path);
            await loadPDFIfNeeded(file.path, index);
          },
        });
      }
    } catch { /* no recent files */ }
    for (const palette of getRegisteredPalettes()) {
      const tools = (palette.tools || []).flatMap((tool) => (tool.subTools?.length ? tool.subTools : [tool]));
      for (const tool of tools) {
        out.push({
          key: `addon:${palette.id}:${tool.id}`, kind: 'addon', section: 'addons',
          label: tool.translationKey ? t(tool.translationKey, { defaultValue: tool.label }) : tool.label,
          id: tool.id, path: [palette.label], keywords: ['add-on', 'tool', palette.label], icon: tool.icon,
          run: () => import('../../tools/manager.js').then((m) => {
            m.setTool(tool.tool);
            if (tool.overrides) state.toolOverrides = tool.overrides;
          }),
        });
      }
    }
    setExtra(out);
  };

  const onOpen = () => {
    setQuery('');
    setActive(0);
    setExtra([]);
    setLabels(null);
    setOpen(true);
    collectExtra();
    const doc = state.documents[state.activeDocumentIndex];
    readPageLabels(doc?.pdfDoc).then((l) => { if (open()) setLabels(Array.isArray(l) ? l : null); });
    queueMicrotask(() => inputEl?.focus());
  };
  onMount(() => window.addEventListener(OPEN_COMMAND_PALETTE, onOpen));
  onCleanup(() => window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen));

  const close = () => setOpen(false);
  const enabled = (entry) => (entry.kind === 'command' ? isCommandEnabled(entry.commandId) : true);
  const run = (entry) => {
    if (!entry || !enabled(entry)) return;
    close();
    if (entry.kind === 'command') runCommand(entry.commandId);
    else entry.run?.();
  };
  const pin = (entry) => { if (entry?.kind === 'command') togglePinned(entry.commandId); };
  const move = (delta) => {
    const n = rows().length;
    if (!n) return;
    const next = (active() + delta + n) % n;
    setActive(next);
    listEl?.querySelector(`#command-palette-row-${next}`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e) => {
    // Keep the app's shortcuts out while typing here.
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(8); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-8); }
    else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); pin(rows()[active()]); }
    else if (e.key === 'Enter') { e.preventDefault(); run(rows()[active()]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  // Flat row index of each entry, for the active row and aria ids.
  const indexOf = (entry) => rows().indexOf(entry);

  return (
    <Show when={open()}>
      <Portal>
        <div class="command-palette-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div class="command-palette" role="dialog" aria-label={t('menu.palette.title')}>
            <div class="command-palette-search">
              <span class="command-palette-search-icon" innerHTML={lucide('search')} aria-hidden="true" />
              <input
                ref={inputEl}
                class="command-palette-input"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder={t('menu.palette.placeholder')}
                value={query()}
                role="combobox"
                aria-expanded="true"
                aria-controls="command-palette-list"
                aria-activedescendant={rows().length ? `command-palette-row-${active()}` : undefined}
                onInput={(e) => { setQuery(e.currentTarget.value); setActive(0); }}
                onKeyDown={onKeyDown}
              />
              <Keys shortcut="Esc" />
            </div>
            <div class="command-palette-list" id="command-palette-list" role="listbox" ref={listEl}>
              <Show when={rows().length} fallback={<div class="command-palette-empty">{t('menu.palette.empty')}</div>}>
                <For each={sections()}>
                  {(section) => (
                    <div class="command-palette-section" role="group" aria-label={t(`menu.palette.${section.section}`)}>
                      <div class="command-palette-heading" aria-hidden="true">{t(`menu.palette.${section.section}`)}</div>
                      <For each={section.entries}>
                        {(entry) => {
                          const i = () => indexOf(entry);
                          const disabled = () => !enabled(entry);
                          const where = () => (entry.path?.length ? entry.path : (entry.altPath || []).slice(0, 1));
                          return (
                            <div
                              id={`command-palette-row-${i()}`}
                              class="command-palette-row"
                              classList={{ active: active() === i(), disabled: disabled() }}
                              role="option"
                              aria-selected={active() === i()}
                              aria-disabled={disabled() ? 'true' : undefined}
                              data-command={entry.commandId || undefined}
                              data-kind={entry.kind}
                              onPointerMove={() => { if (active() !== i()) setActive(i()); }}
                              onPointerDown={(e) => e.preventDefault()}
                              onClick={() => run(entry)}
                            >
                              <span class="command-palette-icon" innerHTML={entry.icon || ''} />
                              <span class="command-palette-text">
                                <span class="command-palette-label">{entry.label}</span>
                                <Show when={entry.detail}><span class="command-palette-detail">{entry.detail}</span></Show>
                              </span>
                              <span class="command-palette-path">{where().join(' › ')}</span>
                              <Show when={entry.shortcut}><Keys shortcut={entry.shortcut} /></Show>
                              <Show when={entry.kind === 'command' && getCommand(entry.commandId)}>
                                <button type="button" class="command-palette-pin" tabIndex="-1"
                                  classList={{ pinned: isPinned(entry.commandId) }}
                                  title={isPinned(entry.commandId) ? t('workflow.unpin') : t('workflow.pin')}
                                  aria-label={isPinned(entry.commandId) ? t('workflow.unpin') : t('workflow.pin')}
                                  onClick={(e) => { e.stopPropagation(); pin(entry); }}
                                  innerHTML={isPinned(entry.commandId) ? PIN_OFF : PIN} />
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <div class="command-palette-footer" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> {t('menu.palette.hintMove')}</span>
              <span><kbd>↵</kbd> {t('menu.palette.hintRun')}</span>
              <span><Keys shortcut="Alt+Enter" /> {t('menu.palette.hintPin')}</span>
              <span><kbd>Esc</kbd> {t('menu.palette.hintClose')}</span>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

import { createSignal, createMemo, For, Show } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { state } from '../../../core/state.js';
import { undoSteps, redoSteps } from '../../../core/undo-manager.js';
import { undoStackOf, redoStackOf, trackUndoHistory } from '../../../core/undo-stacks.js';
import { historyRows, undoEntryInfo } from '../../../core/undo-history.js';
import { typeName } from '../../../quantities/categories.js';

/**
 * Edit > Undo History (docs/reference/editor/markup-tools.md): the undo steps of the active
 * document with their action names, oldest first. Clicking a step undoes
 * back to just after it (the same as that many Ctrl+Z); the greyed steps
 * below the current one were undone and a click redoes up to them.
 */
export default function UndoHistoryDialog() {
  const { t } = useTranslation('common');
  const [busy, setBusy] = createSignal(false);
  const [tick, setTick] = createSignal(0);
  const doc = () => state.documents[state.activeDocumentIndex];
  const rows = createMemo(() => {
    tick();
    trackUndoHistory();
    const d = doc();
    return historyRows([...undoStackOf(d)], [...redoStackOf(d)]);
  });

  const label = (row) => {
    if (row.start) return t('editTools.history.start');
    const info = undoEntryInfo(row.cmd);
    let text = t(`editTools.history.${info.action}`, { defaultValue: info.action });
    if (info.annotationType) text += ` ${typeName(info.annotationType)}`;
    if (info.count > 1) text += ` (${t('editTools.history.count', { count: info.count })})`;
    return text;
  };

  const jump = async (row) => {
    if (busy() || row.steps === 0) return;
    setBusy(true);
    try {
      if (row.done) await undoSteps(row.steps);
      else await redoSteps(row.steps);
    } finally {
      setBusy(false);
      setTick(tick() + 1);
    }
  };

  const close = () => closeDialog('undoHistory');

  return (
    <Dialog
      title={t('editTools.history.title')}
      dialogClass="undo-history-dialog"
      onClose={close}
      footer={
        <div style="display:flex;justify-content:flex-end;width:100%">
          <button class="ai-plan-btn" style="width:auto;padding:5px 16px" onClick={close}>{t('close')}</button>
        </div>
      }
    >
      <div style="min-width:300px;max-width:380px">
        <div style="opacity:0.8;padding-bottom:6px">{t('editTools.history.hint')}</div>
        <Show when={rows().length > 1} fallback={<div style="opacity:0.7">{t('editTools.history.empty')}</div>}>
          <ol class="undo-history-list" aria-busy={busy()}
            style="list-style:none;margin:0;padding:0;max-height:320px;overflow:auto;border:1px solid var(--ox-line);border-radius:var(--ox-r-xs)">
            <For each={rows()}>
              {(row) => (
                <li>
                  <button type="button"
                    class={`undo-history-row${row.done ? '' : ' undone'}${row.done && row.steps === 0 ? ' current' : ''}`}
                    data-steps={row.steps} data-done={row.done ? '1' : '0'}
                    aria-current={row.done && row.steps === 0 ? 'step' : undefined}
                    disabled={busy()}
                    onClick={() => jump(row)}
                    style={`display:block;width:100%;text-align:left;padding:4px 8px;border:0;cursor:default;font:inherit;`
                      + `background:${row.done && row.steps === 0 ? 'var(--ox-accent-soft)' : 'transparent'};`
                      + `color:${row.done ? 'var(--ox-text)' : 'var(--ox-text-disabled)'}`}>
                    {label(row)}
                  </button>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
    </Dialog>
  );
}

import { createSignal, createMemo, Show } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { confirmOffsetDistance, cancelOffsetDistance } from '../../../tools/tools/edit-tools.js';

const num = (v) => Number(String(v ?? '').trim().replace(',', '.'));

/**
 * Offset (the external editor O, docs/reference/editor/markup-tools.md): the distance of the parallel copy, in
 * the page's calibrated unit, or in page points (labelled uncalibrated) on a
 * page without a scale. The side is picked on the sheet after OK.
 */
export default function OffsetDialog(props) {
  const { t } = useTranslation('common');
  const data = props.data || {};
  const unitLabel = data.calibrated ? data.unit : t('editTools.offset.uncalibratedUnit');
  const [value, setValue] = createSignal(data.value != null ? String(data.value) : '');
  const valid = createMemo(() => Number.isFinite(num(value())) && num(value()) > 0);

  let done = false;
  const cancel = () => { if (!done) { done = true; cancelOffsetDistance(); } closeDialog('offset'); };
  const ok = () => {
    if (!valid()) return;
    done = true;
    closeDialog('offset');
    confirmOffsetDistance(num(value()));
  };

  return (
    <Dialog
      title={t('editTools.offset.title')}
      dialogClass="offset-dialog"
      onClose={cancel}
      footer={
        <div style="display:flex;gap:6px;justify-content:flex-end;width:100%">
          <button class="ai-plan-btn" style="width:auto;padding:5px 16px;background:var(--theme-bg,#e0e0e0);color:var(--theme-text,#333);border-color:var(--theme-border,#ccc)"
            onClick={cancel}>{t('cancel')}</button>
          <button class="ai-plan-btn" id="offset-ok" style="width:auto;padding:5px 16px"
            disabled={!valid()} onClick={ok}>{t('ok')}</button>
        </div>
      }
    >
      <form style="min-width:280px" onSubmit={(e) => { e.preventDefault(); ok(); }}>
        <div class="ai-form-field">
          <label for="offset-distance">{t('editTools.offset.distance')}</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="number" class="ribbon-input" id="offset-distance" min="0" step="any" value={value()}
              onInput={(e) => setValue(e.currentTarget.value)} style="flex:1" autofocus />
            <span class="offset-unit">{unitLabel}</span>
          </div>
        </div>
        <Show when={!data.calibrated}>
          <div style="opacity:0.75;padding-top:2px;max-width:320px">{t('editTools.offset.uncalibrated')}</div>
        </Show>
      </form>
    </Dialog>
  );
}

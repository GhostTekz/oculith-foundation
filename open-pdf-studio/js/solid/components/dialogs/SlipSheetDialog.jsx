import { For, Show, createMemo, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { sheetRegister, saveSheetRegister } from '../../stores/sheetRegisterStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { extractFileName } from '../../../core/platform.js';
import { slipSheetRowErrors } from '../../../sets/slip-sheet-match.js';

const POINTS = ['oldA', 'oldB', 'newA', 'newB'];

// Batch Slip Sheet confirmation (docs/reference/editor/sets-and-batch.md). Opened by the Sets
// panel, or by another workflow through openDialog('slipSheet', data), with
// the revised PDFs already read and matched. `data.revision` fills in the new
// revision; a row with its own `revision` keeps it. `data.onDone(text,
// result)` gets the summary and runSlipSheet's result; `data.onCancel()` runs
// when the dialog closes without a slip sheet.
export default function SlipSheetDialog(props) {
  const { t } = useTranslation('common');
  const files = props.data?.files || [];
  const pageCounts = Object.fromEntries(files.map(file => [file.filePath, file.pageCount]));
  const [rows, setRows] = createStore((props.data?.rows || []).map(row => ({ ...row, manual: false })));
  const [revision, setRevision] = createSignal(String(props.data?.revision ?? ''));
  const [aligning, setAligning] = createStore({});
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const close = () => {
    if (busy()) return;
    closeDialog('slipSheet');
    props.data?.onCancel?.();
  };
  const sheets = createMemo(() => [...sheetRegister().sheets].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })));
  const sheetLabel = id => sheetRegister().sheets.find(sheet => sheet.id === id);
  const errors = createMemo(() => new Map(slipSheetRowErrors(sheetRegister(), rows).map(item => [item.key, item.error])));
  const counts = createMemo(() => ({
    replace: rows.filter(row => row.include && row.sheetId).length,
    append: rows.filter(row => row.include && !row.sheetId).length,
  }));
  const ownRevision = row => String(row.revision ?? '').trim();
  const needsRevision = createMemo(() => rows.some(row => row.include && !ownRevision(row)));

  const reasonText = row => row.manual ? t('slipSheet.reason.manual')
    : row.reason ? t(`slipSheet.reason.${row.reason}`) : t('slipSheet.reason.none');

  function setPoint(key, point, axis, value) {
    setAligning(key, current => ({ ...(current || {}), [point]: { ...(current?.[point] || {}), [axis]: value } }));
  }

  function alignments() {
    const result = {};
    for (const row of rows) {
      const entry = aligning[row.key];
      if (!entry?.on || !row.include || !row.sheetId) continue;
      const parsed = {};
      for (const name of POINTS) {
        const x = Number(entry[name]?.x);
        const y = Number(entry[name]?.y);
        if (entry[name]?.x === undefined || entry[name]?.y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error(t('slipSheet.error.points', { sheet: sheetLabel(row.sheetId)?.label || '' }));
        }
        parsed[name] = { x, y };
      }
      result[row.key] = parsed;
    }
    return result;
  }

  async function apply() {
    if (busy()) return;
    setMessage('');
    if (needsRevision() && !revision().trim()) { setMessage(t('slipSheet.error.revision')); return; }
    if (!counts().replace && !counts().append) { setMessage(t('slipSheet.error.noRows')); return; }
    if (errors().size) { setMessage(t('slipSheet.error.duplicate')); return; }
    let align;
    try { align = alignments(); } catch (error) { setMessage(error.message); return; }
    setBusy(true);
    const register = sheetRegister();
    try {
      const { runSlipSheet } = await import('../../../sets/slip-sheet-run.js');
      const plain = rows.map(row => ({ key: row.key, filePath: row.filePath, page: row.page, pageLabel: row.pageLabel,
        sheetId: row.sheetId, reason: row.reason, include: row.include,
        ...(ownRevision(row) ? { revision: ownRevision(row) } : {}) }));
      const result = await runSlipSheet({ register, rows: plain, pageCounts, revision: revision().trim(), alignments: align,
        onProgress: text => setMessage(t('slipSheet.running', { file: text })) });
      if (sheetRegister() !== register) throw new Error(t('slipSheet.error.setChanged'));
      saveSheetRegister(result.register);
      props.data?.onDone?.(t('slipSheet.done', { replaced: result.replaced.length, appended: result.appended.length,
        carried: result.carried }), result);
      setBusy(false);
      closeDialog('slipSheet');
    } catch (error) {
      setMessage(t('slipSheet.error.failed', { error: error?.message || String(error) }));
      setBusy(false);
    }
  }

  const footer = (
    <>
      <div class="slip-sheet-summary">{t('slipSheet.summary', { replaceCount: counts().replace, appendCount: counts().append })}</div>
      <div class="crop-margins-footer-right">
        <button class="pref-btn pref-btn-primary" onClick={apply} disabled={busy()}>{busy() ? t('slipSheet.applying') : t('slipSheet.apply')}</button>
        <button class="pref-btn pref-btn-secondary" onClick={close} disabled={busy()}>{t('cancel')}</button>
      </div>
    </>
  );

  return (
    <Dialog title={t('slipSheet.title')} overlayClass="slip-sheet-overlay" dialogClass="slip-sheet-dialog"
      bodyClass="slip-sheet-body" footerClass="crop-margins-footer" onClose={close} footer={footer}>
      <p class="slip-sheet-intro">{t('slipSheet.intro')}</p>
      <label class="slip-sheet-revision">{t('slipSheet.revision')}
        <input aria-label={t('slipSheet.revision')} value={revision()} onInput={event => setRevision(event.currentTarget.value)} />
      </label>
      <div class="slip-sheet-table" role="table" aria-label={t('slipSheet.title')}>
        <div class="slip-sheet-row slip-sheet-head" role="row">
          <span role="columnheader">{t('slipSheet.column.include')}</span>
          <span role="columnheader">{t('slipSheet.column.newSheet')}</span>
          <span role="columnheader">{t('slipSheet.column.oldSheet')}</span>
          <span role="columnheader">{t('slipSheet.column.reason')}</span>
          <span role="columnheader">{t('slipSheet.column.align')}</span>
        </div>
        <For each={rows}>{(row, index) => <div class={`slip-sheet-row${errors().has(row.key) ? ' invalid' : ''}`} role="row">
          <span role="cell"><input type="checkbox" checked={row.include} aria-label={t('slipSheet.column.include')}
            onChange={event => setRows(index(), 'include', event.currentTarget.checked)} /></span>
          <span role="cell" class="slip-sheet-new" title={row.filePath}>
            <strong>{row.pageLabel || t('slipSheet.page', { page: row.page })}</strong>
            <small>{extractFileName(row.filePath)} · {t('slipSheet.page', { page: row.page })}{ownRevision(row) ? ` · ${t('slipSheet.rev', { rev: ownRevision(row) })}` : ''}</small>
          </span>
          <span role="cell">
            <select aria-label={t('slipSheet.column.oldSheet')} value={row.sheetId || ''}
              onChange={event => { setRows(index(), { sheetId: event.currentTarget.value || null, manual: true }); }}>
              <option value="">{t('slipSheet.append')}</option>
              <For each={sheets()}>{sheet => <option value={sheet.id}>{sheet.label}{sheet.revision ? ` · ${t('slipSheet.rev', { rev: sheet.revision })}` : ''}</option>}</For>
            </select>
          </span>
          <span role="cell" class="slip-sheet-reason">{reasonText(row)}</span>
          <span role="cell">
            <Show when={row.sheetId} fallback={<small>—</small>}>
              <select aria-label={t('slipSheet.column.align')} value={aligning[row.key]?.on ? 'twoPoint' : 'page'}
                onChange={event => setAligning(row.key, current => ({ ...(current || {}), on: event.currentTarget.value === 'twoPoint' }))}>
                <option value="page">{t('slipSheet.alignPage')}</option>
                <option value="twoPoint">{t('slipSheet.alignTwoPoint')}</option>
              </select>
            </Show>
          </span>
          <Show when={row.sheetId && aligning[row.key]?.on}>
            <div class="slip-sheet-points" role="cell">
              <small>{t('slipSheet.pointsHint')}</small>
              <For each={POINTS}>{name => <label>{t(`slipSheet.point.${name}`)}
                <input type="number" step="0.1" aria-label={`${t(`slipSheet.point.${name}`)} X`} placeholder="X"
                  value={aligning[row.key]?.[name]?.x ?? ''} onInput={event => setPoint(row.key, name, 'x', event.currentTarget.value)} />
                <input type="number" step="0.1" aria-label={`${t(`slipSheet.point.${name}`)} Y`} placeholder="Y"
                  value={aligning[row.key]?.[name]?.y ?? ''} onInput={event => setPoint(row.key, name, 'y', event.currentTarget.value)} />
              </label>}</For>
            </div>
          </Show>
        </div>}</For>
      </div>
      <Show when={message()}><div class="slip-sheet-message" role="status">{message()}</div></Show>
    </Dialog>
  );
}

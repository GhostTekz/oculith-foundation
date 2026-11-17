import { createSignal, For, Show } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog, openDialog } from '../../stores/dialogStore.js';
import { sheetRegister, saveSheetRegister, userTitleBlockTemplates, saveUserTitleBlockTemplates } from '../../stores/sheetRegisterStore.js';
import { setTitleBlockTemplates } from '../../../sets/sheet-register.js';
import { TEMPLATE_FIELDS, TEMPLATE_FIELD_NAMES, createTitleBlockTemplate, withTemplate } from '../../../sets/title-block-template.js';
import { textOfRuns } from '../../../pdf/region-text.js';
import { updateStatusMessage } from '../../../ui/chrome/status-bar.js';

const NAME = 'title-block-template';

/**
 * Drawing Set > New title block template: mark the boxes of the sheet
 * number, title, revision and date on the page on screen, then save the
 * template with the drawing set (and the user's defaults). The dialog closes
 * while a box is dragged on the page and opens again with what was marked.
 *
 * props.data: { name, keepDefault, page, docId, fields: { field: rect }, texts: { field: text }, error }
 */
export default function TitleBlockTemplateDialog(props) {
  const data = props.data || {};
  const [name, setName] = createSignal(data.name || '');
  const [keepDefault, setKeepDefault] = createSignal(data.keepDefault !== false);
  const [error, setError] = createSignal(data.error || '');
  const [busy, setBusy] = createSignal(false);
  const fields = data.fields || {};
  const texts = data.texts || {};
  const close = () => closeDialog(NAME);
  const state = () => ({ name: name(), keepDefault: keepDefault(), page: data.page, docId: data.docId, fields, texts });

  async function mark(field) {
    const keep = state();
    close();
    let next = keep;
    try {
      const [{ pickPageRegion }, { currentTemplatePage }] = await Promise.all([
        import('../../../tools/region-pick.js'), import('../../../sets/title-block-template-app.js'),
      ]);
      const page = await currentTemplatePage();
      if (keep.docId && (keep.docId !== page.doc.id || keep.page !== page.page)) {
        throw new Error(`Mark every box on the same page (page ${keep.page} of the first drawing).`);
      }
      updateStatusMessage(`Drag a box around the ${TEMPLATE_FIELD_NAMES[field].toLocaleLowerCase()}. Esc cancels.`, 8000);
      const region = await pickPageRegion();
      if (region && region.page !== page.page) throw new Error('The box was drawn on another page.');
      if (region) {
        next = { ...keep, docId: page.doc.id, page: page.page,
          fields: { ...keep.fields, [field]: region.rect },
          texts: { ...keep.texts, [field]: textOfRuns(page.runs, region.rect) } };
      }
      next = { ...next, error: '' };
    } catch (failure) {
      next = { ...keep, error: failure.message };
    }
    openDialog(NAME, next);
  }

  async function save() {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      const { currentTemplatePage } = await import('../../../sets/title-block-template-app.js');
      const page = await currentTemplatePage();
      if (page.doc.id !== data.docId || page.page !== data.page) {
        throw new Error(`Show page ${data.page} of the drawing the boxes were marked on, then save.`);
      }
      const template = createTitleBlockTemplate({ name: name(), width: page.width, height: page.height, fields, runs: page.runs });
      const register = sheetRegister();
      saveSheetRegister(setTitleBlockTemplates(register, withTemplate(register.titleBlockTemplates, template)));
      if (keepDefault()) saveUserTitleBlockTemplates(withTemplate(userTitleBlockTemplates(), template));
      updateStatusMessage(`Title block template “${template.name}” saved with ${template.anchors.length} fixed word${template.anchors.length === 1 ? '' : 's'} to recognise its layout.`);
      close();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog
      title="New title block template"
      dialogClass="sheet-links-dialog title-block-template-dialog"
      bodyClass="sheet-links-body"
      onClose={close}
      footer={
        <div class="sheet-links-footer">
          <div />
          <div>
            <button class="sheet-links-btn" onClick={close}>Cancel</button>
            <button class="sheet-links-btn primary" id="title-block-template-save"
              disabled={busy() || !name().trim() || !(fields.label || fields.title)} onClick={save}>Save template</button>
          </div>
        </div>
      }
    >
      <p class="sheet-links-muted">Show one sheet of the layout, then mark a box around each value. The page size and the fixed words around the boxes identify the layout; the template applies to every sheet that has both.</p>
      <div class="sheet-links-row">
        <label>Name
          <input type="text" id="title-block-template-name" value={name()} placeholder="e.g. Architect A1 title block"
            onInput={(e) => setName(e.currentTarget.value)} />
        </label>
      </div>
      <Show when={data.page}>
        <div class="sheet-links-muted">Marked on page {data.page}.</div>
      </Show>
      <div class="sheet-links-table-wrap">
        <table class="sheet-links-table" id="title-block-template-fields">
          <thead><tr><th>Field</th><th>Text in the box</th><th /></tr></thead>
          <tbody>
            <For each={TEMPLATE_FIELDS}>
              {(field) => (
                <tr>
                  <td>{TEMPLATE_FIELD_NAMES[field]}{field === 'label' || field === 'title' ? '' : ' (optional)'}</td>
                  <td class={fields[field] ? '' : 'sheet-links-muted'}>
                    {fields[field] ? (texts[field] || 'No selectable text in this box') : 'Not marked'}
                  </td>
                  <td><button class="sheet-links-btn" onClick={() => mark(field)}>{fields[field] ? 'Mark again' : 'Mark'}</button></td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <label class="sheet-links-row">
        <input type="checkbox" checked={keepDefault()} onChange={(e) => setKeepDefault(e.currentTarget.checked)} />
        Also keep in my default templates for other drawing sets
      </label>
      <Show when={error()}><div class="sheet-links-note" role="alert">{error()}</div></Show>
    </Dialog>
  );
}

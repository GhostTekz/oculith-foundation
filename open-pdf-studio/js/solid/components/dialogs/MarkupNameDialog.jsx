import { createSignal, For } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { getActiveDocument } from '../../../core/state.js';

// Put markups in a category by name (docs/reference/editor/markups-list.md):
// - mode 'subject': "Subject…" on the canvas or Markups List menu sets the
//   subject of the selected markups (the subjects in the document are offered);
// - mode 'groupName': renames a group (its Subject in the Markups List).
export default function MarkupNameDialog(props) {
  const data = props.data || {};
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const [naam, setNaam] = createSignal(data.value || '');
  const isGroep = data.mode === 'groupName';
  const subjects = () => {
    if (isGroep) return [];
    const set = new Set();
    for (const a of getActiveDocument()?.annotations || []) if (a.subject) set.add(a.subject);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  };
  const sluit = () => closeDialog('markup-name');
  const ok = async () => {
    const waarde = naam().trim();
    if (!waarde) return;
    sluit();
    if (isGroep) {
      const m = await import('../../../annotations/segment-ops.js');
      m.renameMarkupGroup(data.groupId, waarde);
    } else {
      const doc = getActiveDocument();
      const m = await import('../../../ui/panels/annotations-list.js');
      m.setMarkupsSubject([...(doc?.selectedAnnotations || [])], waarde);
    }
  };

  const footer = (
    <div class="message-dialog-footer">
      <button class="pref-btn pref-btn-primary" id="markup-name-ok" disabled={!naam().trim()} onClick={ok}>{tCommon('ok') || 'OK'}</button>
      <button class="pref-btn pref-btn-secondary" onClick={sluit}>{tCommon('cancel') || 'Cancel'}</button>
    </div>
  );
  return (
    <Dialog title={t(isGroep ? 'markupsList.groupNameTitle' : 'markupsList.subjectTitle')}
      dialogClass="markup-name-dialog" onClose={sluit} footer={footer}>
      <form style="min-width:300px" onSubmit={(e) => { e.preventDefault(); ok(); }}>
        <div class="ai-form-field">
          <label for="markup-name-input">{t(isGroep ? 'markupsList.groupNameLabel' : 'general.subject')}</label>
          <input id="markup-name-input" type="text" class="ribbon-input" list="markup-name-subjects" maxLength={256}
            value={naam()} onInput={(e) => setNaam(e.currentTarget.value)} style="width:100%;box-sizing:border-box" autofocus />
          <datalist id="markup-name-subjects">
            <For each={subjects()}>{(s) => <option value={s} />}</For>
          </datalist>
        </div>
      </form>
    </Dialog>
  );
}

import { Show, untrack, createMemo } from 'solid-js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { getActiveDocument } from '../../../core/state.js';
import { panelTargets, selectionRev } from '../../stores/propertiesStore.js';
import { groupPathOf, correctionGroupIds } from '../../../annotations/markup-groups.js';
import { openDialog } from '../../stores/dialogStore.js';
import { runCommand } from '../../commands/index.js';

// Group in the Properties panel (the external editor: Options ▸ Group / Ungroup), see
// docs/reference/editor/markups-list.md. Group when the selection holds two or more markups
// or groups, Ungroup when it holds a group; the name of a selected group is
// its Subject in the Markups List and opens the rename dialog.
export default function GroupField() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const stand = createMemo(() => {
    selectionRev();
    const doc = getActiveDocument();
    const doelen = panelTargets();
    const cg = untrack(() => correctionGroupIds(doc?.annotations || []));
    const paden = doelen.map((a) => groupPathOf(a, cg));
    const units = new Set(doelen.map((a, i) => paden[i][0]?.id || `m:${a.id}`));
    const tops = new Set(paden.map((p) => p[0]?.id).filter(Boolean));
    const top = tops.size === 1 && units.size === 1 ? paden.find((p) => p.length)[0] : null;
    return { kanGroeperen: units.size >= 2 && !doelen.some((a) => a.locked), kanOntbinden: tops.size > 0, top };
  });
  const ververs = async () => {
    const doc = getActiveDocument();
    const m = await import('../../../ui/panels/properties-panel.js');
    if ((doc?.selectedAnnotations?.length || 0) > 1) m.showMultiSelectionProperties();
    else if (doc?.selectedAnnotation) m.showProperties(doc.selectedAnnotation);
  };
  const doe = async (id) => { await runCommand(id); await ververs(); };
  return (
    <Show when={(selectionRev(), panelTargets().length > 0)}>
      <div class="property-group property-group-markup-group">
        <label>{tCommon('markupGroups.group')}</label>
        <div style="display:flex;gap:4px;align-items:center;min-width:0">
          <Show when={stand().top}>
            <button type="button" class="property-group-name" title={t('markupsList.groupNameTitle')}
              style="flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              onClick={() => openDialog('markup-name', { mode: 'groupName', groupId: stand().top.id, value: stand().top.name })}>
              {stand().top.name || tCommon('markupGroups.group')}</button>
          </Show>
          <button type="button" id="prop-group" disabled={!stand().kanGroeperen} title="Ctrl+G"
            onClick={() => doe('edit.group')}>{tCommon('commands.group')}</button>
          <button type="button" id="prop-ungroup" disabled={!stand().kanOntbinden} title="Ctrl+Shift+G"
            onClick={() => doe('edit.ungroup')}>{tCommon('commands.ungroup')}</button>
        </div>
      </div>
    </Show>
  );
}

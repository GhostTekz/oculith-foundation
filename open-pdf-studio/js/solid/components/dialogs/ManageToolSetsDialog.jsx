import { createSignal, createMemo, For, Show, onMount } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { getToolChestSets, getToolChestPresets, DEFAULT_TOOL_SET_ID } from '../../../tools/tool-chest-presets.js';
import { activeProfile } from '../../stores/workspaceLayout.js';
import { lucide } from '../../data/lucideIcons.js';
import {
  sharingAvailable, startToolSetSharing, toolSetShareRevision, toolSetShareStatus,
  addNewToolSet, pickNewSetLocation, addExistingToolSet, importToolSetFile, exportToolSetFile,
  removeToolSet, moveToolSet, showToolSet, showToolSetInAllProfiles,
  checkOutToolSet, checkInToolSet, cancelToolSetCheckOut,
} from '../../stores/toolSetLibrary.js';
import { shareMessage } from './tool-set-share-messages.js';

const icon = (name, size = 14) => lucide(name).replace('<svg ', `<svg width="${size}" height="${size}" `);

/**
 * Manage Tool Sets (the external editor): every set with its Display box, location and
 * share status; Add ▸ Add New / Add Existing, Import, Export, Remove,
 * Move Up / Move Down, and Check Out / Check In for shared sets.
 * docs/reference/editor/tool-chest.md.
 */
export default function ManageToolSetsDialog() {
  const { t } = useTranslation('common');
  const tt = (key, params) => t(`toolSetSharing.${key}`, params);
  const close = () => closeDialog('manage-tool-sets');
  const [selected, setSelected] = createSignal(null);
  const [form, setForm] = createSignal(null); // 'new' | 'existing' | null
  const [title, setTitle] = createSignal('');
  const [location, setLocation] = createSignal(null);
  const [display, setDisplay] = createSignal(true);
  const [allProfiles, setAllProfiles] = createSignal(true);
  const [relative, setRelative] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal(null); // { text, error, list? }
  const [revision, setRevision] = createSignal(0);
  const desktop = sharingAvailable();

  onMount(() => { startToolSetSharing(); });

  const sets = createMemo(() => {
    revision();
    toolSetShareRevision();
    const tools = getToolChestPresets();
    return getToolChestSets().map(set => ({ ...set,
      count: tools.filter(tool => tool.setId === set.id).length,
      share: set.builtIn ? { shared: false, editable: true } : toolSetShareStatus(set.id) }));
  });
  const current = () => sets().find(set => set.id === selected()) || null;
  const named = () => sets().filter(set => !set.builtIn);
  const refresh = () => setRevision(v => v + 1);

  const run = async (action) => {
    if (busy()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      if (result) setMessage(result);
    } catch (error) {
      setMessage({ text: error?.message || String(error), error: true });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const openForm = (kind) => {
    setForm(kind);
    setTitle('');
    setLocation(null);
    setDisplay(true);
    setAllProfiles(true);
    setRelative(false);
    setMessage(null);
  };

  const createNew = () => run(async () => {
    const set = await addNewToolSet({ title: title(), display: display(), allProfiles: allProfiles(),
      profile: activeProfile(), saveLocation: location(), relativePath: relative() });
    setForm(null);
    setSelected(set.id);
    return { text: tt('added', { name: set.name }) };
  });

  const addExisting = () => run(async () => {
    const result = await addExistingToolSet({ display: display(), allProfiles: allProfiles(),
      profile: activeProfile(), relativePath: relative() });
    if (!result) return null;
    setForm(null);
    setSelected(result.set.id);
    return { text: [tt('imported', { name: result.set.name, count: result.accepted }),
      result.rejected ? tt('rejected', { count: result.rejected }) : ''].filter(Boolean).join(' ') };
  });

  const importFile = () => run(async () => {
    const result = await importToolSetFile();
    if (!result) return null;
    if (result.pack) {
      if (result.set) setSelected(result.set.id);
      const unsupported = (result.unsupported || []).slice(0, 30);
      return {
        text: [tt('importedPack', { sets: result.acceptedSets, tools: result.accepted }),
          result.skipped ? tt('packSkipped', { count: result.skipped }) : ''].filter(Boolean).join(' '),
        error: result.acceptedSets === 0,
        list: unsupported.length ? unsupported.map(item =>
          `${item.name}: ${tt(`reason_${item.reason}`)}`) : null,
      };
    }
    setSelected(result.set.id);
    return {
      text: [tt('imported', { name: result.set.name, count: result.accepted }),
        result.rejected ? tt('rejected', { count: result.rejected }) : ''].filter(Boolean).join(' '),
      list: result.unsupported?.length ? result.unsupported.map(item =>
        `${item.name}: ${tt(`reason_${item.reason}`)}`) : null,
    };
  });

  const exportSet = () => run(async () => {
    const set = current();
    if (!set) return null;
    const result = await exportToolSetFile(set.id);
    return result ? { text: `${tt('exported', { name: result.name })} ${tt('btxExportNote')}` } : null;
  });

  const share = (action, kind) => run(async () => {
    const set = current();
    if (!set) return null;
    return shareMessage(tt, set.name, await action(set.id), kind);
  });

  const statusText = (set) => {
    const s = set.share;
    if (!s.shared) return tt('statusLocal');
    if (s.offline) return tt('statusOffline');
    if (s.editable) return tt('statusEditable');
    return s.lockedBy ? tt('lockedByTitle', { user: s.lockedBy }) : tt('statusReadOnly');
  };
  const statusIcon = (set) => {
    const s = set.share;
    if (!s.shared) return '';
    if (s.offline) return icon('unlink');
    return s.editable ? icon('circle-check') : icon('lock');
  };

  const index = () => named().findIndex(set => set.id === selected());

  return (
    <Dialog title={tt('manageTitle')} dialogClass="manage-tool-sets-dialog" onClose={close}
      footer={<div class="mts-footer"><button type="button" class="mts-btn" onClick={close}>{tt('close')}</button></div>}>
      <div class="mts-body">
        <div class="mts-toolbar" role="toolbar" aria-label={tt('manageTitle')}>
          <button type="button" class="mts-btn" id="mts-add-new" disabled={busy()} onClick={() => openForm('new')}
            innerHTML={`${icon('plus')}<span>${tt('addNew')}</span>`} />
          <button type="button" class="mts-btn" id="mts-add-existing" disabled={busy() || !desktop}
            title={desktop ? tt('existingNote') : tt('browserNote')} onClick={() => openForm('existing')}
            innerHTML={`${icon('folder-open')}<span>${tt('addExisting')}</span>`} />
          <button type="button" class="mts-btn" id="mts-import" disabled={busy()} onClick={importFile}
            innerHTML={`${icon('download')}<span>${tt('import')}</span>`} />
          <button type="button" class="mts-btn" id="mts-export" disabled={busy() || !current()} onClick={exportSet}
            innerHTML={`${icon('share')}<span>${tt('export')}</span>`} />
          <button type="button" class="mts-btn" id="mts-remove" disabled={busy() || !current() || current()?.builtIn}
            onClick={() => run(async () => { const set = current(); await removeToolSet(set.id); setSelected(null); return null; })}
            innerHTML={`${icon('trash-2')}<span>${tt('remove')}</span>`} />
          <button type="button" class="mts-btn mts-icon" id="mts-up" aria-label={tt('moveUp')} title={tt('moveUp')}
            disabled={busy() || index() <= 0} onClick={() => { moveToolSet(selected(), -1); refresh(); }} innerHTML={icon('chevron-up')} />
          <button type="button" class="mts-btn mts-icon" id="mts-down" aria-label={tt('moveDown')} title={tt('moveDown')}
            disabled={busy() || index() < 0 || index() >= named().length - 1}
            onClick={() => { moveToolSet(selected(), 1); refresh(); }} innerHTML={icon('chevron-down')} />
        </div>
        <Show when={!desktop}><p class="mts-note">{tt('browserNote')}</p></Show>

        <Show when={form()}>
          <form class="mts-form" onSubmit={(e) => { e.preventDefault(); if (form() === 'new') createNew(); else addExisting(); }}>
            <Show when={form() === 'new'}>
              <label class="mts-field">{tt('title')}
                <input id="mts-title" maxLength="48" value={title()} onInput={(e) => setTitle(e.currentTarget.value)}
                  ref={(el) => queueMicrotask(() => el.focus())} />
              </label>
              <div class="mts-field">{tt('saveLocation')}
                <div class="mts-location">
                  <span class="mts-path" title={location() || ''}>{location() || tt('onThisDevice')}</span>
                  <Show when={desktop}>
                    <button type="button" class="mts-btn" disabled={!title().trim()}
                      onClick={async () => setLocation((await pickNewSetLocation(title())) || null)}>{tt('chooseLocation')}</button>
                    <Show when={location()}>
                      <button type="button" class="mts-btn" onClick={() => setLocation(null)}>{tt('onThisDevice')}</button>
                    </Show>
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={form() === 'existing'}><p class="mts-note">{tt('existingNote')}</p></Show>
            <label class="mts-check"><input type="checkbox" checked={display()} onChange={(e) => setDisplay(e.currentTarget.checked)} />{tt('display')}</label>
            <label class="mts-check"><input type="checkbox" checked={allProfiles()} onChange={(e) => setAllProfiles(e.currentTarget.checked)} />{tt('showInAllProfiles')}</label>
            <Show when={desktop && (form() === 'existing' || location())}>
              <label class="mts-check"><input type="checkbox" checked={relative()} onChange={(e) => setRelative(e.currentTarget.checked)} />{tt('relativePath')}</label>
            </Show>
            <div class="mts-form-actions">
              <button type="submit" class="mts-btn mts-primary" id="mts-form-ok" disabled={busy() || (form() === 'new' && !title().trim())}>
                {form() === 'new' ? tt('create') : tt('chooseFile')}</button>
              <button type="button" class="mts-btn" onClick={() => setForm(null)}>{tt('cancel')}</button>
            </div>
          </form>
        </Show>

        <table class="mts-table" role="grid" aria-label={tt('manageTitle')}>
          <thead><tr><th>{tt('display')}</th><th>{tt('columnSet')}</th><th>{tt('columnLocation')}</th><th>{tt('columnStatus')}</th></tr></thead>
          <tbody>
            <For each={sets()}>{(set) => (
              <tr class={selected() === set.id ? 'selected' : ''} data-set-id={set.id} aria-selected={selected() === set.id}
                onClick={() => setSelected(set.id)}>
                <td><input type="checkbox" aria-label={`${tt('display')} ${set.name}`} checked={!set.hidden} disabled={set.builtIn}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { showToolSet(set.id, e.currentTarget.checked); refresh(); }} /></td>
                <td class="mts-name">{set.id === DEFAULT_TOOL_SET_ID ? tt('myTools') : set.name}
                  <span class="mts-count">({set.count})</span>
                  <Show when={set.profile}>
                    <button type="button" class="mts-profile" title={tt('showInAllProfiles')}
                      onClick={(e) => { e.stopPropagation(); showToolSetInAllProfiles(set.id, true); refresh(); }}>{set.profile}</button>
                  </Show>
                </td>
                <td class="mts-location-cell" title={set.share.path || ''}>{set.share.shared ? (set.share.path || '…') : tt('local')}</td>
                <td class="mts-status"><span class="mts-status-icon" innerHTML={statusIcon(set)} />{statusText(set)}</td>
              </tr>
            )}</For>
          </tbody>
        </table>

        <Show when={current()?.share?.shared}>
          <div class="mts-share-actions">
            <Show when={!current().share.editable} fallback={
              <>
                <button type="button" class="mts-btn mts-primary" id="mts-check-in" disabled={busy()}
                  onClick={() => share(checkInToolSet, 'checkIn')} innerHTML={`${icon('circle-check')}<span>${tt('checkIn')}</span>`} />
                <button type="button" class="mts-btn" disabled={busy()} onClick={() => share(cancelToolSetCheckOut, 'cancel')}>{tt('cancelCheckOut')}</button>
              </>}>
              <button type="button" class="mts-btn mts-primary" id="mts-check-out" disabled={busy() || current().share.offline}
                onClick={() => share(checkOutToolSet, 'checkOut')} innerHTML={`${icon('lock-open')}<span>${tt('checkOut')}</span>`} />
              <Show when={current().share.stale}>
                <button type="button" class="mts-btn" disabled={busy()}
                  onClick={() => share((id) => checkOutToolSet(id, { breakStale: true }), 'checkOut')}>{tt('breakLock')}</button>
              </Show>
            </Show>
          </div>
        </Show>

        <Show when={message()}>
          <div class={`mts-message${message().error ? ' error' : ''}`} role={message().error ? 'alert' : 'status'}>
            <p>{message().text}</p>
            <Show when={message().list}>
              <p class="mts-list-title">{tt('unsupportedTitle')}</p>
              <ul class="mts-list"><For each={message().list}>{(line) => <li>{line}</li>}</For></ul>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}

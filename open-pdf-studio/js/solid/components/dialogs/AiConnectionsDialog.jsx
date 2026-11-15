// AI connections: link AI clients (Claude Desktop, Claude Code, VS Code,
// Cursor, Codex, OpenCode) to the app's AI link, test the link and copy
// settings for other clients. An edition can add its own sections below
// (js/mcp/ai-connections-sections.js). Plans come from js/mcp/ai-connections.js;
// reading and writing the clients' settings files is native
// (src-tauri/src/ai_connections.rs). Every change is shown as a diff and
// written only after Apply. Loaded on demand (DialogHost lazy import).
import { createMemo, createSignal, For, lazy, onCleanup, onMount, Show } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { invoke, isTauri } from '../../../core/platform.js';
import { state } from '../../../core/state.js';
import { mcpStatus } from '../../../core/mcp-koppeling.js';
import {
  CLIENTS, DEFAULT_PORT, clientStatus, mcpUrl, planConnect, planDisconnect, snippets,
} from '../../../mcp/ai-connections.js';
import { aiConnectionsSections, subscribe as onSectionsChange } from '../../../mcp/ai-connections-sections.js';

// One lazy component per registered section, made once.
const sectionComponents = new WeakMap();
const sectionComponent = (section) => {
  if (!sectionComponents.has(section)) sectionComponents.set(section, lazy(section.load));
  return sectionComponents.get(section);
};

export default function AiConnectionsDialog() {
  const { t } = useTranslation('dialogs');
  const k = (key, opts) => t(`aiConnections.${key}`, opts);
  const [scan, setScan] = createSignal(null);
  const [scanError, setScanError] = createSignal('');
  const [runningPort, setRunningPort] = createSignal(null);
  const [plan, setPlan] = createSignal(null);
  const [notice, setNotice] = createSignal(null); // { ok, text }
  const [busy, setBusy] = createSignal(false);
  const [test, setTest] = createSignal(null);
  const [showOther, setShowOther] = createSignal(false);
  const [sections, setSections] = createSignal(aiConnectionsSections());
  onCleanup(onSectionsChange(() => setSections(aiConnectionsSections())));

  const port = () => runningPort() || Number(state.preferences?.mcpPort) || DEFAULT_PORT;
  const ctx = () => ({ port: port(), bridge: scan()?.bridge || null });
  const scanOf = (id) => scan()?.clients?.find((c) => c.id === id) || null;
  const rows = createMemo(() => CLIENTS.map((client) => {
    const s = scanOf(client.id);
    return { client, scan: s, status: s ? clientStatus(client, s, ctx()) : null };
  }));
  const staleCount = () => rows().filter((r) => r.status?.state === 'stale').length;

  async function refresh() {
    setScanError('');
    const st = await mcpStatus();
    setRunningPort(st?.actief && st.poort ? st.poort : null);
    try {
      setScan(await invoke('ai_connections_scan'));
    } catch (e) {
      setScanError(String(e?.message || e));
    }
  }
  onMount(() => { if (isTauri()) refresh(); });

  const close = () => closeDialog('ai-connections');

  function propose(p, label, note = '') {
    setNotice(null);
    if (!p.ok) { setPlan(null); setNotice({ ok: false, text: p.error }); return; }
    if (!p.changed) { setPlan(null); setNotice({ ok: true, text: k('nothingToChange') }); return; }
    setPlan({ ...p, label, note });
    queueMicrotask(() => document.getElementById('ai-conn-preview')?.scrollIntoView?.({ block: 'nearest' }));
  }

  async function apply() {
    const p = plan();
    if (!p) return;
    setBusy(true);
    try {
      const r = await invoke('ai_connection_write', { client: p.client, text: p.after, expected: p.expected });
      setPlan(null);
      const written = r?.backup ? k('writtenWithBackup', { path: r.path, backup: r.backup }) : k('written', { path: r?.path || p.path });
      setNotice({ ok: true, text: p.note ? `${written} ${p.note}` : written });
      await refresh();
    } catch (e) {
      setNotice({ ok: false, text: String(e?.message || e) });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTest({ pending: true });
    try {
      setTest(await invoke('ai_link_test', { port: port() }));
    } catch (e) {
      setTest({ ok: false, error: String(e?.message || e) });
    }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); setNotice({ ok: true, text: k('copied') }); } catch (e) { setNotice({ ok: false, text: String(e?.message || e) }); }
  }

  // What an edition's section may use (ai-connections-sections.js).
  const sectionApi = Object.freeze({ scanOf, propose, busy, port });

  const statusText = (r) => {
    if (!r.status) return '';
    if (r.status.state === 'error') return k('stateError');
    if (r.status.state === 'linked') return k('stateLinked', { port: port() });
    if (r.status.state === 'stale') return k('stateStale');
    return r.scan?.installed ? k('stateNotLinked') : k('stateNotDetected');
  };

  return (
    <Dialog title={k('title')} dialogClass="ai-connections-dialog" onClose={close}
      footer={
        <div style="display:flex;gap:6px;justify-content:flex-end;width:100%">
          <button class="pref-btn pref-btn-secondary" onClick={refresh} disabled={busy()}>{k('refresh')}</button>
          <button class="pref-btn pref-btn-primary" onClick={close}>{k('close')}</button>
        </div>
      }>
      <div class="ai-conn">
        <div class="ai-conn-hint">{k('hint', { url: mcpUrl(port()) })}</div>
        <Show when={!isTauri()}><div class="ai-conn-msg ai-conn-err">{k('desktopOnly')}</div></Show>
        <Show when={scanError()}><div class="ai-conn-msg ai-conn-err">{scanError()}</div></Show>

        <div class="ai-conn-row">
          <button class="pref-btn pref-btn-secondary" id="ai-conn-test" onClick={runTest} disabled={!isTauri() || test()?.pending}>{k('test')}</button>
          <span class="ai-conn-test" data-ok={test()?.ok ? 'true' : test() && !test().pending ? 'false' : ''}>
            <Show when={test() && !test().pending}>
              {test().ok ? k('testOk', { tools: test().tools, url: test().url }) : k('testFailed', { error: test().error })}
            </Show>
          </span>
        </div>

        <Show when={staleCount() > 0}>
          <div class="ai-conn-msg ai-conn-warn" id="ai-conn-stale">{k('staleNotice', { count: staleCount(), port: port() })}</div>
        </Show>

        <table class="ai-conn-table">
          <thead><tr><th>{k('client')}</th><th>{k('status')}</th><th>{k('settingsFile')}</th><th /></tr></thead>
          <tbody>
            <For each={rows()}>{(r) => (
              <tr data-client={r.client.id} data-state={r.status?.state || ''}>
                <td>{r.client.label}</td>
                <td class={`ai-conn-state ai-conn-state-${r.status?.state || 'none'}`} title={r.status?.message || ''}>
                  {statusText(r)}
                  <Show when={r.status?.state === 'error'}><div class="ai-conn-sub">{r.status.message}</div></Show>
                </td>
                <td class="ai-conn-path" title={r.scan?.path || ''}>{r.scan?.path || ''}</td>
                <td class="ai-conn-actions">
                  <Show when={r.status?.state === 'unlinked'}>
                    <button class="pref-btn pref-btn-secondary" data-action="connect" disabled={busy()}
                      onClick={() => propose(planConnect(r.client.id, r.scan, ctx()), k('connectTitle', { client: r.client.label }))}>{k('connect')}</button>
                  </Show>
                  <Show when={r.status?.state === 'stale'}>
                    <button class="pref-btn pref-btn-primary" data-action="repair" disabled={busy()}
                      onClick={() => propose(planConnect(r.client.id, r.scan, ctx()), k('repairTitle', { client: r.client.label }))}>{k('repair')}</button>
                  </Show>
                  <Show when={r.status?.state === 'linked' || r.status?.state === 'stale'}>
                    <button class="pref-btn pref-btn-secondary" data-action="disconnect" disabled={busy()}
                      onClick={() => propose(planDisconnect(r.client.id, r.scan), k('disconnectTitle', { client: r.client.label }))}>{k('disconnect')}</button>
                  </Show>
                </td>
              </tr>
            )}</For>
          </tbody>
        </table>

        <Show when={notice()}>
          <div class={`ai-conn-msg ${notice().ok ? 'ai-conn-ok' : 'ai-conn-err'}`} id="ai-conn-notice">{notice().text}</div>
        </Show>

        <Show when={plan()}>
          <div class="ai-conn-preview" id="ai-conn-preview">
            <div class="ai-conn-preview-head">{plan().label}</div>
            <div class="ai-conn-sub">{k('previewHint', { path: plan().path })}</div>
            <pre class="ai-conn-diff">
              <For each={plan().diff.split('\n')}>{(line) => (
                <div class={line.startsWith('+') && !line.startsWith('+++') ? 'ai-conn-add' : line.startsWith('-') && !line.startsWith('---') ? 'ai-conn-del' : line.startsWith('@@') ? 'ai-conn-hunk' : ''}>{line || ' '}</div>
              )}</For>
            </pre>
            <div class="ai-conn-row" style="justify-content:flex-end">
              <button class="pref-btn pref-btn-secondary" onClick={() => setPlan(null)} disabled={busy()}>{k('cancel')}</button>
              <button class="pref-btn pref-btn-primary" id="ai-conn-apply" onClick={apply} disabled={busy()}>{k('apply')}</button>
            </div>
          </div>
        </Show>

        <details class="ai-conn-section" open={showOther()} onToggle={(e) => setShowOther(e.currentTarget.open)}>
          <summary>{k('otherClients')}</summary>
          <div class="ai-conn-sub">{k('otherHint')}</div>
          <For each={[
            ['url', k('snippetUrl')], ['http', k('snippetHttp')], ['stdio', k('snippetStdio')],
            ['claudeCli', k('snippetClaudeCli')], ['codexCli', k('snippetCodexCli')],
          ]}>{([key, label]) => (
            <div class="ai-conn-snippet">
              <div class="ai-conn-row"><span>{label}</span>
                <button class="pref-btn pref-btn-secondary" data-copy={key} onClick={() => copy(snippets(ctx())[key])}>{k('copy')}</button></div>
              <pre>{snippets(ctx())[key]}</pre>
            </div>
          )}</For>
        </details>

        <For each={sections()}>{(section) => {
          const Section = sectionComponent(section);
          return <div class="ai-conn-edition-section" data-section={section.id}><Section api={sectionApi} /></div>;
        }}</For>
      </div>
    </Dialog>
  );
}

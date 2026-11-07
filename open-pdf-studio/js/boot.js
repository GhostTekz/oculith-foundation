// Start-up. An optional add-on is loaded through js/plugin/host.js before
// the editor starts; without one, the editor runs as Foundation.
import { EARLY, HOST_API_VERSION, installHost, loadHostModules, provides } from './plugin/host.js';
import { finish, rememberIdentity, setEdition, setStatus, showLaunchActions, side, startLaunchScreen } from './launch-screen.js';
import { edition as foundation } from './editions/community.js';
import { composeAddons, resolvePluginEntries } from './editions/compose-addons.js';
import { bootMark, bootMarkFrame } from './core/boot-timeline.js';
import { linkModules } from './plugin/module-link.js';

// The edition's word under the monolith: the last word of its product name.
const editionWord = (edition) => edition.launchWord || String(edition.productName || '').split(' ').pop();
const view = new URLSearchParams(location.search).get('view');
const secondaryWindow = view === 'printqueue';

async function findPlugins() {
  const tauri = window.__TAURI__?.core;
  if (!tauri?.invoke) return [];
  return resolvePluginEntries((command, options) => tauri.invoke(command, options));
}

// A release build serves the plug-in beside the editor's files: the web view
// fetches and parses it (and caches it like the editor's chunks) while the
// editor's own modules load; it runs only once the interface is ready. Its
// further module files (`modules`, chunks/*.js) are served beside it and load
// when the plug-in imports them. A development build hands over the program
// text, imported from a Blob (a split program is linked by module-link.js).
function preloadPlugin(found) {
  if (!found.url) return null;
  const link = document.createElement('link');
  link.rel = 'modulepreload';
  link.href = found.url;
  document.head.append(link);
  return link;
}

async function importPlugin(found) {
  if (found.url) return import(/* @vite-ignore */ new URL(found.url, location.href).href);
  if (found.modules && Object.keys(found.modules).length) {
    return import(/* @vite-ignore */ linkModules(found.js, found.modules));
  }
  const url = URL.createObjectURL(new Blob([found.js], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url); } finally { URL.revokeObjectURL(url); }
}

async function importEntry(found) {
  const preload = preloadPlugin(found);
  let plugin;
  try {
    plugin = await importPlugin(found);
  } catch (error) {
    // A served file can fail to load while the verified inline copy is usable.
    const tauri = window.__TAURI__?.core;
    let inline = null;
    if (found.url && tauri?.invoke) {
      try {
        const entries = await tauri.invoke('edition_plugins', { inline: true });
        inline = entries?.find((entry) => entry.id === found.id && entry.kind === found.kind);
      } catch { /* old native build */ }
      if (!inline && found.kind === 'edition') {
        try { inline = await tauri.invoke('edition_plugin', { inline: true }); } catch { /* unavailable */ }
      }
    }
    preload?.remove();
    if (!inline?.js) throw error;
    console.warn('[edition] the plug-in could not load from its URL; loading its text.', error);
    plugin = await importPlugin(inline);
  }
  return { plugin, preload };
}

function addStyle(found) {
  if (!found.css) return null;
  const style = document.createElement('style');
  style.dataset.editionPlugin = found.id;
  style.textContent = found.css;
  document.head.append(style);
  return style;
}

async function installEdition(found) {
  const { plugin, preload } = await importEntry(found);
  if (plugin.hostApiVersion !== HOST_API_VERSION) {
    preload?.remove();
    throw new Error(`The edition plug-in needs plug-in interface ${plugin.hostApiVersion}; this editor provides ${HOST_API_VERSION}.`);
  }
  const required = plugin.requires || [];
  if (!Array.isArray(required) || required.some((id) => typeof id !== 'string' || !provides(id))) {
    preload?.remove();
    throw new Error('The edition plug-in requests an unsupported editor module.');
  }
  let style;
  try {
    const edition = plugin.createEdition();
    globalThis.__ocudrawEdition = edition;
    setEdition(editionWord(edition));
    setStatus(`Loading ${editionWord(edition)}`);
    style = addStyle(found);
    return { plugin, edition };
  } catch (error) {
    style?.remove();
    preload?.remove();
    delete globalThis.__ocudrawEdition;
    throw error;
  }
}

(async () => {
  if (view === 'thumbnails') {
    document.getElementById('launch-screen')?.remove();
    // A thumbnail view only receives images and navigation from its drawing
    // window; loading the editor here would start unused PDF and UI modules.
    const [, { render }, { default: DetachedThumbnailsWindow }] = await Promise.all([
      import('./i18n/config.js'),
      import('solid-js/web'),
      import('./solid/components/DetachedThumbnailsWindow.jsx'),
    ]);
    render(() => DetachedThumbnailsWindow(), document.getElementById('app-root'));
    return;
  }
  bootMark('start');
  if (secondaryWindow) document.getElementById('launch-screen')?.remove();
  else {
    startLaunchScreen();
    bootMarkFrame('launch-screen');
  }
  const ready = new Promise((resolve) => {
    window.addEventListener('ocudraw:ready', () => { bootMark('ready'); resolve(); }, { once: true });
    setTimeout(resolve, 30000); // never kept behind the screen
  });
  setStatus('Loading');
  let found = await findPlugins();
  bootMark('add-ons-found');
  let plugin = null;
  let base = foundation;
  if (found.length) {
    try {
      installHost();
      await loadHostModules(EARLY, { parallel: true });
      bootMark('host-early');
    } catch (error) {
      console.error('[edition] add-on host could not start; starting Foundation.', error);
      found = [];
    }
  }
  const editionEntry = found.find((entry) => entry.kind === 'edition' && (entry.url || entry.js));
  if (editionEntry) {
    try {
      ({ plugin, edition: base } = await installEdition(editionEntry));
      bootMark('edition-installed');
    } catch (error) {
      console.error('[edition] the plug-in could not load; starting without it.', error);
      delete globalThis.__ocudrawEdition;
    }
  }
  let contributions = found.filter((item) => item.kind === 'contribution');
  let reservedTemplateIds = [];
  if (contributions.length) {
    try {
      reservedTemplateIds = (await import('./symbols/registry.js')).listTemplates().map((template) => template.id);
    } catch (error) {
      console.error('[edition] add-on registry could not load; skipping independent add-ons.', error);
      contributions = [];
    }
  }
  let composed = base;
  const acceptedIds = new Set();
  const addonModules = [];
  for (const entry of contributions) {
    let preload;
    let style;
    try {
      if (!entry.url && !entry.js) throw new Error('Add-on has no program');
      const imported = await importEntry(entry);
      preload = imported.preload;
      if (typeof imported.plugin.createAddon !== 'function') throw new Error('Add-on must export createAddon()');
      const required = imported.plugin.requires || [];
      if (!Array.isArray(required) || required.some((id) => typeof id !== 'string' || !provides(id))) {
        throw new Error('Add-on requests an unsupported editor module');
      }
      // Give descriptor construction only the already claimed PDF names, not
      // the mutable edition. A package may omit an optional PDF contribution
      // while keeping its panel; composeAddons still rejects any collision.
      const pdfKeys = Object.freeze([...new Set([
        ...(composed.pdf?.catalogKeys || []), ...(composed.pdf?.annotationKeys || []),
      ])]);
      const addon = await imported.plugin.createAddon(Object.freeze({ pdfKeys }));
      if (acceptedIds.has(entry.id)) throw new Error(`Duplicate add-on id: ${entry.id}`);
      const result = composeAddons(composed, [{ id: entry.id, addon }], { reservedTemplateIds });
      if (result.rejected.length) throw result.rejected[0].error;
      style = addStyle(entry);
      composed = result.edition;
      acceptedIds.add(entry.id);
      addonModules.push(...required);
    } catch (error) {
      style?.remove();
      preload?.remove();
      console.error(`[edition] add-on ${entry.id || '(unknown)'} could not load; skipping it.`, error);
    }
  }
  if (acceptedIds.size) globalThis.__ocudrawEdition = composed;
  if (!plugin) setEdition(editionWord(foundation));
  if (!secondaryWindow) rememberIdentity(editionWord(composed), composed.productName);
  setStatus('Starting');
  // The active edition must be composed before a host import evaluates
  // editions/active.js. Full editions and independent add-ons share this order.
  // The modules load at once: each one imports what its own start-up needs
  // (the editor's module graph orders their evaluation), and none of them
  // relies on another host module having run first.
  try {
    await loadHostModules([...new Set([...(plugin?.requires || []), ...addonModules])], { parallel: true });
    bootMark('host-modules');
  } catch (error) {
    // Some host modules import active.js, which selects the edition once.
    // After a failed import, switching editions could leave those modules
    // using a different edition from main.js.
    console.error('[edition] add-on host module failed; editor startup stopped.', error);
    setStatus('The add-on could not start. Restart after disabling it.');
    return;
  }
  try { await plugin?.start?.(); }
  catch (error) { console.error('[edition] edition start failed; continuing editor startup.', error); }
  bootMark('edition-started');
  await import('./main.js');
  bootMark('editor-imported');
  if (secondaryWindow) return;
  await ready;
  if (plugin?.launch) {
    try { await plugin.launch({ side, setStatus, showActions: showLaunchActions }); } catch (error) { console.error('[edition] launch step failed', error); }
  } else if (composed.launchActions?.length) {
    // File-association opens and restored sessions should proceed directly
    // to the document. Empty workspaces can offer an optional launch action.
    const { state } = await import('./core/state.js');
    if (!state.documents.length && !state.preferences.restoreLastSession) {
      await showLaunchActions(composed.launchActions);
    }
  }
  bootMark('launch-step-done');
  await finish();
  bootMark('launch-screen-gone');
})();

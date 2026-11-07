// The published interface between the editor (LGPL-3.0-or-later) and an
// edition plug-in. The plug-in is installed beside the editor and loaded at
// start (boot.js). It contains no editor code and reaches the editor through
// the modules listed here at run time. Removing or replacing the plug-in
// leaves a complete editor (Oculith Draw Foundation).
//
// The list is the interface: a module the plug-in needs must be added here
// on purpose (the plug-in build refuses any other import of editor code).

import { linkedModule } from './module-link.js';

export const HOST_API_VERSION = 1;

// Shared runtime packages: one copy, the editor's, for editor and plug-in.
const PACKAGES = {
  'solid-js': () => import('solid-js'),
  'solid-js/web': () => import('solid-js/web'),
  'solid-js/store': () => import('solid-js/store'),
  'pdf-lib': () => import('pdf-lib'),
};

// Editor modules a plug-in may use.
const MODULES = {
  'js/annotations/annotatie-lagen.js': () => import('../annotations/annotatie-lagen.js'),
  'js/annotations/clipboard.js': () => import('../annotations/clipboard.js'),
  'js/annotations/conduit-fill.js': () => import('../annotations/conduit-fill.js'),
  'js/annotations/extension-overlay.js': () => import('../annotations/extension-overlay.js'),
  'js/annotations/factory.js': () => import('../annotations/factory.js'),
  'js/annotations/geometry.js': () => import('../annotations/geometry.js'),
  'js/annotations/markup-fields.js': () => import('../annotations/markup-fields.js'),
  'js/annotations/markup-status.js': () => import('../annotations/markup-status.js'),
  'js/annotations/measure-extras.js': () => import('../annotations/measure-extras.js'),
  'js/annotations/measurement.js': () => import('../annotations/measurement.js'),
  'js/annotations/rendering.js': () => import('../annotations/rendering.js'),
  'js/annotations/stamp-layout.js': () => import('../annotations/stamp-layout.js'),
  'js/annotations/stamp-templates.js': () => import('../annotations/stamp-templates.js'),
  'js/compare/compare-store.js': () => import('../compare/compare-store.js'),
  'js/compare/page-label-matches.js': () => import('../compare/page-label-matches.js'),
  'js/core/platform.js': () => import('../core/platform.js'),
  'js/core/edition-helper.js': () => import('../core/edition-helper.js'),
  'js/core/perf.js': () => import('../core/perf.js'),
  'js/core/default-author.js': () => import('../core/default-author.js'),
  'js/core/state.js': () => import('../core/state.js'),
  'js/core/stores/selection-helpers.js': () => import('../core/stores/selection-helpers.js'),
  'js/core/undo-manager.js': () => import('../core/undo-manager.js'),
  'js/editions/active.js': () => import('../editions/active.js'),
  'js/i18n/useTranslation.js': () => import('../i18n/useTranslation.js'),
  'js/mcp/addon-tools.js': () => import('../mcp/addon-tools.js'),
  'js/pdf/brand-mark-pdf.js': () => import('../pdf/brand-mark-pdf.js'),
  'js/pdf/exporter.js': () => import('../pdf/exporter.js'),
  'js/pdf/loader.js': () => import('../pdf/loader.js'),
  'js/pdf/markup-columns.js': () => import('../pdf/markup-columns.js'),
  'js/pdf/page-bitmap-cache.js': () => import('../pdf/page-bitmap-cache.js'),
  'js/pdf/pdf-inspect.js': () => import('../pdf/pdf-inspect.js'),
  'js/pdf/pdf-viewports.js': () => import('../pdf/pdf-viewports.js'),
  'js/pdf/region-text.js': () => import('../pdf/region-text.js'),
  'js/pdf/renderer.js': () => import('../pdf/renderer.js'),
  'js/pdf/saver.js': () => import('../pdf/saver.js'),
  'js/pdf/saver/pdf-text.js': () => import('../pdf/saver/pdf-text.js'),
  'js/pdf/vector-renderer.js': () => import('../pdf/vector-renderer.js'),
  'js/pdf/viewports-vp.js': () => import('../pdf/viewports-vp.js'),
  'js/pdf/weergave-ruimte.js': () => import('../pdf/weergave-ruimte.js'),
  'js/pdf/xlsx-read.js': () => import('../pdf/xlsx-read.js'),
  'js/pdf/xlsx-workbook.js': () => import('../pdf/xlsx-workbook.js'),
  'js/quantities/schedule-csv.js': () => import('../quantities/schedule-csv.js'),
  'js/quantities/schedule-templates.js': () => import('../quantities/schedule-templates.js'),
  'js/sets/register-context.js': () => import('../sets/register-context.js'),
  'js/sets/sheet-title-suggest.js': () => import('../sets/sheet-title-suggest.js'),
  'js/sets/slip-sheet-carry.js': () => import('../sets/slip-sheet-carry.js'),
  'js/sets/slip-sheet-match.js': () => import('../sets/slip-sheet-match.js'),
  'js/sets/slip-sheet-transform.js': () => import('../sets/slip-sheet-transform.js'),
  'js/solid/commands/util.js': () => import('../solid/commands/util.js'),
  'js/solid/components/Dialog.jsx': () => import('../solid/components/Dialog.jsx'),
  'js/solid/components/panels/panelActions.js': () => import('../solid/components/panels/panelActions.js'),
  'js/solid/data/lucideIcons.js': () => import('../solid/data/lucideIcons.js'),
  'js/solid/stores/annotationLayersStore.js': () => import('../solid/stores/annotationLayersStore.js'),
  'js/solid/stores/dialogStore.js': () => import('../solid/stores/dialogStore.js'),
  'js/spaces/model.js': () => import('../spaces/model.js'),
  'js/text/text-layer.js': () => import('../text/text-layer.js'),
  'js/tour/tours.js': () => import('../tour/tours.js'),
  'js/tools/manager.js': () => import('../tools/manager.js'),
  'js/tools/pdf-snap-extractor.js': () => import('../tools/pdf-snap-extractor.js'),
  'js/tools/region-pick.js': () => import('../tools/region-pick.js'),
  'js/tools/tool-registry.js': () => import('../tools/tool-registry.js'),
  'js/ui/chrome/tabs.js': () => import('../ui/chrome/tabs.js'),
  'js/ui/panels/annotations-list.js': () => import('../ui/panels/annotations-list.js'),
  'js/ui/panels/markup-columns.js': () => import('../ui/panels/markup-columns.js'),
};

/** What a plug-in may use before the edition is installed (no module here reads the edition). */
export const EARLY = Object.freeze(['solid-js', 'solid-js/web', 'solid-js/store', 'pdf-lib', 'js/solid/data/lucideIcons.js']);

const loaded = new Map();
const loaders = { ...PACKAGES, ...MODULES };
const capabilities = new Map();

/** Named, versioned functions that installed plug-ins intentionally share. */
export function publishCapability(id, provider) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9.-]*\/[1-9][0-9]*$/.test(id) ||
      typeof provider !== 'function' || capabilities.has(id)) {
    throw new Error(`Invalid or duplicate plug-in capability: ${String(id)}`);
  }
  capabilities.set(id, provider);
}

export function capability(id) { return capabilities.get(id) || null; }

/** Whether `id` is part of the interface. */
export function provides(id) { return Object.hasOwn(loaders, id); }

/**
 * Load interface modules: one after another in the given order, or all at
 * once with `parallel` (start-up uses this for EARLY and for a plug-in's
 * modules). Every module imports what its own start-up needs, so the
 * editor's module graph, not this list, orders their evaluation; their
 * files are already preloaded with main.js (index.html).
 */
export async function loadHostModules(ids, { parallel = false } = {}) {
  const missing = ids.filter((id) => !loaded.has(id));
  for (const id of missing) {
    if (!provides(id)) throw new Error(`Not part of the editor's plug-in interface: ${id}`);
  }
  if (parallel) {
    const modules = await Promise.all(missing.map((id) => loaders[id]()));
    missing.forEach((id, i) => loaded.set(id, modules[i]));
    return;
  }
  for (const id of missing) {
    if (!loaded.has(id)) loaded.set(id, await loaders[id]());
  }
}

/**
 * A module of the interface, for the plug-in. Before it is loaded the plug-in
 * gets a stand-in that reaches the module once it is (the plug-in's own
 * start-up may name a module it only uses later); using it earlier is an error.
 */
export function hostModule(id) {
  if (!provides(id)) throw new Error(`Not part of the editor's plug-in interface: ${id}`);
  if (loaded.has(id)) return loaded.get(id);
  return new Proxy({}, {
    get(_, key) {
      if (key === Symbol.toStringTag) return 'Module';
      const ns = loaded.get(id);
      if (!ns) throw new Error(`The plug-in used ${id} (${String(key)}) before the editor loaded it.`);
      return ns[key];
    },
    has(_, key) { return key in (loaded.get(id) || {}); },
    ownKeys() { return Reflect.ownKeys(loaded.get(id) || {}); },
    getOwnPropertyDescriptor(_, key) {
      const ns = loaded.get(id);
      return ns && key in ns ? { value: ns[key], enumerable: true, configurable: true, writable: false } : undefined;
    },
  });
}

/** The interface object a plug-in finds at globalThis.__ocudrawHost. */
export function installHost() {
  globalThis.__ocudrawHost = Object.freeze({
    apiVersion: HOST_API_VERSION, module: hostModule, provides, publishCapability, capability,
    // A split plug-in loaded from its text reaches its own module files here.
    linkedModule,
  });
}

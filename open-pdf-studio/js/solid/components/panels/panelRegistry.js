// Panel registry for the plan-review panel hosts (docs/reference/editor/workspace.md
// §1.4, §5, WP2). One entry per workspaceLayout PANEL_IDS id:
//
//   { id,
//     title:    'ns:key'      i18n key shown in the panel header and tooltips
//     icon:     '<svg …>'     20 px access-bar icon (Lucide / Oculith drawings)
//     shortcut: 'Alt+X'|null  display text; panelActions binds it (until WP1
//                             routes the Alt keys through the command registry)
//     component              the panel body, loaded lazily so this module stays
//                             importable under node (the body components are
//                             the existing left-panel bodies, unchanged)
//     menu?:   [{ label, run }]  extra items in the header ▾ panel menu
//     sizeSlider?: true       the external editor size slider in the footer (Thumbnails, Tool Chest)
//     ownHeader?: true        the body renders <PanelHeader> itself, with its
//                             own search and buttons in the header row
//   }
//
// Order of the entries = Window ▸ Panels order (= the default left access-bar
// order, then the bottom tabs, then the two panels that start hidden).

import { lazy } from 'solid-js';
import { PANEL_IDS } from '../../stores/workspaceLayout.js';
import { lucide } from '../../data/lucideIcons.js';
import { toolIcon } from '../../data/oculithToolIcons.js';
import { edition } from '../../../editions/active.js';

const body = (load, name = 'default') => lazy(() => load().then((m) => ({ default: m[name] })));

const ENTRIES = [
  { id: 'thumbnails', title: 'properties:leftPanel.thumbnails', icon: lucide('layout-grid'), shortcut: 'Alt+T', sizeSlider: true,
    component: body(() => import('../left-panel/panels/ThumbnailsPanel.jsx')) },
  { id: 'sheets', title: 'common:panelHost.sheets', icon: lucide('files'), shortcut: 'Alt+2',
    component: body(() => import('../left-panel/panels/SheetsPanel.jsx')) },
  { id: 'bookmarks', title: 'properties:leftPanel.bookmarks', icon: lucide('bookmark'), shortcut: 'Alt+B',
    component: body(() => import('../left-panel/panels/BookmarksPanel.jsx')) },
  { id: 'layers', title: 'properties:leftPanel.layersTab', icon: lucide('layers'), shortcut: 'Alt+Y',
    component: body(() => import('../left-panel/panels/LayersPanel.jsx')) },
  { id: 'toolChest', title: 'common:panelHost.toolChest', icon: lucide('toolbox'), shortcut: 'Alt+X', sizeSlider: true,
    component: body(() => import('../SymbolPalette.jsx'), 'ToolChestPanel'), ownHeader: true,
    menu: [
      { label: 'common:panelHost.toolChestNewSet', run: () => import('../../stores/toolChestUi.js').then((m) => m.setNewSetFormOpen(true)) },
      { label: 'common:panelHost.toolChestImportSet', run: () => import('../../stores/toolChestUi.js').then((m) => m.importToolSetFromFile()) },
      { label: 'common:toolSetSharing.manage', run: () => import('../../stores/dialogStore.js').then((m) => m.openDialog('manage-tool-sets')) },
      { label: 'common:panelHost.expandAll', run: () => import('../../stores/toolChestUi.js').then((m) => m.setAllSectionsOpen(true)) },
      { label: 'common:panelHost.collapseAll', run: () => import('../../stores/toolChestUi.js').then((m) => m.setAllSectionsOpen(false)) },
      { label: 'common:panelHost.toolChestSettings', run: () => import('../../stores/symbolStore.js').then((m) => m.setSettingsOpen(true)) },
      { label: 'common:panelHost.float', run: () => import('../SymbolPalette.jsx').then((m) => m.floatToolChest()) },
    ] },
  // Links = named destinations + link annotations (spec R5 "Links (destinations+links)").
  { id: 'links', title: 'properties:leftPanel.links', icon: lucide('link'), shortcut: 'Alt+N',
    component: body(() => import('./LinksPanels.jsx')) },
  { id: 'measurements', title: 'properties:leftPanel.measurements', icon: toolIcon('dimension'), shortcut: 'Alt+U',
    component: body(() => import('../left-panel/panels/MeasurementsPanel.jsx')) },
  { id: 'properties', title: 'properties:title', icon: lucide('sliders-horizontal'), shortcut: 'Alt+P',
    component: body(() => import('../properties-panel/PropertiesPanel.jsx')) },
  { id: 'formFields', title: 'properties:leftPanel.formFields', icon: lucide('text-cursor-input'), shortcut: 'Alt+Q',
    component: body(() => import('../left-panel/panels/FormFieldsPanel.jsx')) },
  { id: 'signatures', title: 'properties:leftPanel.signatures', icon: lucide('signature'), shortcut: 'Alt+4',
    component: body(() => import('../left-panel/panels/SignaturesPanel.jsx')) },
  { id: 'attachments', title: 'properties:leftPanel.attachments', icon: lucide('paperclip'), shortcut: null,
    component: body(() => import('../left-panel/panels/AttachmentsPanel.jsx')) },
  { id: 'search', title: 'common:search', icon: lucide('search'), shortcut: 'Alt+1',
    component: body(() => import('./SearchPanel.jsx')) },
  { id: 'tags', title: 'properties:leftPanel.tags', icon: lucide('list-tree'), shortcut: null,
    component: body(() => import('../left-panel/panels/TagsPanel.jsx')) },
  // Spaces (the external editor Alt+S): named, nested regions; markups get a Space column.
  { id: 'spaces', title: 'common:spaces.title', commandLabel: 'common:spaces.title', icon: lucide('square-dashed'), shortcut: 'Alt+S',
    component: body(() => import('./SpacesPanel.jsx')) },
  ...edition.panels,
  { id: 'quantities', title: 'common:panelHost.quantities', icon: lucide('sheet'), shortcut: null,
    component: body(() => import('../left-panel/panels/SchedulesPanel.jsx')) },
  { id: 'markupsList', title: 'common:panelHost.markupsList', icon: lucide('list'), shortcut: 'Alt+L',
    component: body(() => import('../left-panel/panels/AnnotationsPanel.jsx')), ownHeader: true },
  { id: 'elementVisibility', title: 'ribbon:elementVisibility.title', icon: lucide('eye'), shortcut: null,
    component: body(() => import('./ElementVisibilityHostPanel.jsx')) },
  { id: 'annotationLayers', title: 'ribbon:annotationLayers.title', icon: lucide('layers'), shortcut: null,
    component: body(() => import('../left-panel/AnnotationLayersPanel.jsx')) },
];

export const PANEL_REGISTRY = Object.freeze(Object.fromEntries(ENTRIES.map((e) => [e.id, Object.freeze(e)])));

/** Panel ids in Window ▸ Panels order. */
export const PANEL_ORDER = Object.freeze(ENTRIES.map((e) => e.id));

/** The registry entry of a panel id, or null. */
export function getPanelEntry(id) {
  return PANEL_REGISTRY[id] || null;
}

/** The translated panel title (t = useTranslation().t; keys carry their namespace). */
export function panelTitle(id, t) {
  const entry = getPanelEntry(id);
  if (!entry) return String(id ?? '');
  if (typeof t !== 'function') return entry.title.split(/[:.]/).pop();
  return t(entry.title);
}

/** Tooltip text: "Title (Alt+X)". */
export function panelTooltip(id, t) {
  const entry = getPanelEntry(id);
  const title = panelTitle(id, t);
  return entry?.shortcut ? `${title} (${entry.shortcut})` : title;
}

/** The panel whose shortcut matches a keydown (Alt+letter/digit), or null. */
export function panelForShortcut(event) {
  if (!event?.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const code = String(event.code || '');
  const key = code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : '';
  if (!key) return null;
  const combo = `Alt+${key.toUpperCase()}`;
  return ENTRIES.find((e) => e.shortcut === combo)?.id || null;
}

// Every layout panel id must have an entry (the node test checks this too).
for (const id of PANEL_IDS) {
  if (!PANEL_REGISTRY[id]) throw new Error(`panelRegistry: no entry for panel '${id}'`);
}

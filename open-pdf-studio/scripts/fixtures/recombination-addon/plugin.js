// A neutral, deliberately small add-on for the public host contract smoke.
// It is loaded through the public host interface, like a packaged add-on.
export const hostApiVersion = 1;
export const requires = [];

const KEY = 'OPS_SampleAddonV1';
const PANEL = 'sample-addon-panel';
const DIALOG = 'sample-addon-dialog';
const MARKER = 'Sample add-on loaded';

function samplePanel() {
  const element = document.createElement('div');
  element.dataset.sampleAddonPanel = '';
  element.textContent = 'Sample add-on panel';
  return element;
}

function sampleDialog() {
  const element = document.createElement('div');
  element.dataset.sampleAddonDialog = '';
  element.textContent = 'Sample add-on dialog';
  return element;
}

export function createEdition() {
  const host = globalThis.__ocudrawHost;
  if (host?.apiVersion !== hostApiVersion) throw new Error('Sample add-on needs host API 1.');
  const { PDFName, PDFHexString } = host.module('pdf-lib');
  return {
    apiVersion: 1,
    id: 'sample-addon',
    electricalSymbols: [],
    constructionSymbols: [],
    productName: 'Oculith Draw Sample',
    logoPath: '/community-icon.svg',
    faviconPath: 'community-icon.svg',
    appleIconPath: 'community-icon.svg',
    about: {
      description: MARKER,
      companyName: 'Oculith Draw Sample',
      companyDescription: 'A neutral host interface fixture.',
      copyright: 'Sample fixture',
      license: 'Sample fixture in the Foundation source.',
      sourceLabel: 'Foundation source',
      sourceNote: 'This fixture ships with the public source.',
    },
    panels: [{ id: PANEL, title: 'Sample add-on panel', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"/></svg>', component: samplePanel }],
    panelIds: [PANEL],
    dialogs: { [DIALOG]: sampleDialog },
    fileCommands: [],
    fileMenuItems: [],
    symbolCategories: [],
    symbolTemplates: [],
    pdf: {
      catalogKeys: [KEY],
      readWorkspace(pdf) {
        const value = pdf.context.lookup(pdf.catalog.get(PDFName.of(KEY)));
        return value?.decodeText ? JSON.parse(value.decodeText()) : null;
      },
      applyWorkspace(doc, workspace) { doc.sampleAddonWorkspace = workspace; },
      workspaceForSave(doc) { return doc.sampleAddonWorkspace ?? null; },
      saveWorkspace(pdf, workspace) {
        if (workspace) pdf.catalog.set(PDFName.of(KEY), PDFHexString.fromText(JSON.stringify(workspace)));
      },
    },
  };
}

export function start() {
  // The browser smoke supplies only edition_plugin; after boot it returns to
  // the browser file APIs for the actual PDF round trip.
  if (globalThis.__sampleAddonBrowserSmoke) delete globalThis.__TAURI__;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { clearRenderCachesForPath } from './render-cache-invalidation.js';

// Execute the production save functions with controlled I/O. The app imports
// require a webview; only those dependencies and dynamic imports are replaced.
const source = readFileSync(new URL('./saver.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('let _saveBezig = null;'))
  .replaceAll('export async function', 'async function')
  .replaceAll('import(', 'loadModule(');
const tabs = readFileSync(new URL('../ui/chrome/tabs.js', import.meta.url), 'utf8');
const saved = tabs.slice(tabs.indexOf('export function markDocumentSaved'), tabs.indexOf('\n/**', tabs.indexOf('export function markDocumentSaved')))
  .replace('export function', 'function');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness() {
  const a = { id: 'a', pdfDoc: {}, filePath: 'a.pdf', annotations: [], modified: true, undoStack: [] };
  const b = { id: 'b', pdfDoc: {}, filePath: 'b.pdf', annotations: [], modified: true, undoStack: [] };
  let active = a;
  const writes = [], owners = [];
  const deps = {
    state: { documents: [a, b] }, getActiveDocument: () => active,
    undoStackOf: doc => doc.undoStack,
    showLoading() {}, hideLoading() {}, updateTabBar() {}, updateWindowTitle() {},
    getCachedPdfBytes: path => new TextEncoder().encode(path), setCachedPdfBytes() {},
    PDFDocument: { load: async bytes => ({ context: { largestObjectNumber: 1 }, getPages: () => [], catalog: { get: () => null, lookup: () => null }, save: async () => bytes, flush: async () => {} }) },
    PDFName: { of: x => x }, KNIPSEL_CATALOGUS: 'snippets',
    getAnnotationStorage: doc => { owners.push(doc); return null; },
    getAnnotIdToFieldName: doc => { owners.push(doc); return new Map(); },
    schrijfAnnotatieLagen() {}, layersForSave: doc => { owners.push(doc); return []; }, currentLayerId() {},
    saveTextEditsToPages: async (_pdf, _pages, doc) => owners.push(doc),
    saveWatermarksToPages: async (_pdf, _pages, doc) => owners.push(doc),
    saveBookmarksToOutline: (_pdf, doc) => owners.push(doc), saveStylePresetsToCatalog() {},
    markupTextColumnForSave: doc => doc.markupTextColumnName || '',
    saveMarkupTextColumn: (_pdf, name) => { assert.equal(name, ''); },
    markupChoiceColumnForSave: () => null,
    saveMarkupChoiceColumn: (_pdf, definition) => { assert.equal(definition, null); },
    markupNumberColumnForSave: () => null,
    saveMarkupNumberColumn: (_pdf, definition) => { assert.equal(definition, null); },
    markupCheckmarkColumnForSave: () => null,
    saveMarkupCheckmarkColumn: (_pdf, definition) => { assert.equal(definition, null); },
    unlockFile: async () => {}, lockFile: async () => {},
    writeBinaryFileAtomic: async (path, bytes) => { writes.push({ path, source: new TextDecoder().decode(bytes) }); },
    isTauri: () => false, markeerGebakken() {}, hidePdfABar() {}, stripPdfAMetadata() {},
    i18next: { t: x => x }, showMessage() {}, window: {},
    console: { error() {}, warn() {} },
    saveFileDialog: async () => 'copy.pdf',
    clearRenderCachesForPath,
    loadModule: async path => {
      if (path.includes('verificatie')) return { bevestigOpslaanMetHandtekeningen: async () => true, verifieerHandtekeningen: async () => {} };
      if (path.includes('opslaan')) return { moetOpnieuwVerifieren: () => false, opslaanAlsStandaardPad: doc => doc.filePath };
      if (path.includes('cad-import')) return { isVoorbeeldPdf: () => false };
      if (path.includes('document-release')) return { losgelatenWerkbestanden: () => [], ruimWerkbestandenOp: async () => {} };
      // Later save steps (page scale, status columns) are not what these tests
      // check. A module must not be thenable, or await never settles.
      return new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => null });
    },
  };
  // Names the saver gained after this harness was written no-op. Builtins such
  // as Set stay on the real global. The tests still check which document is written.
  const loose = new Proxy(deps, {
    has(target, prop) {
      if (typeof prop === 'symbol') return prop in target;
      if (prop in target || prop in globalThis) return prop in target;
      return true;
    },
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target || prop in globalThis) return target[prop];
      return () => null;
    },
  });
  // A with scope keeps the injected dependencies mutable across awaits.
  const api = new Function('deps', `with (deps) { ${saved}\n${functions}\n return {savePDF, savePDFAs}; }`)(loose);
  return { a, b, deps, api, writes, owners, switchToB: () => { active = b; } };
}

test('tab switch during signature verification still saves A to the requested path', async () => {
  const h = harness(), gate = deferred(), entered = deferred();
  const original = h.deps.loadModule;
  h.deps.loadModule = async path => path.includes('verificatie')
    ? { bevestigOpslaanMetHandtekeningen: async () => { entered.resolve(); return gate.promise; } }
    : original(path);
  const saving = h.api.savePDF('copy-of-a.pdf');
  await entered.promise;
  h.switchToB(); gate.resolve(true);
  assert.equal(await saving, true);
  assert.deepEqual(h.writes, [{ path: 'copy-of-a.pdf', source: 'a.pdf' }]);
  assert.ok(h.owners.every(doc => doc === h.a));
  assert.equal(h.a.modified, false);
  assert.equal(h.b.modified, true);
});

test('tab switch during parsing keeps all serialization helpers and clean state on A', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  const load = h.deps.PDFDocument.load;
  h.deps.PDFDocument.load = async bytes => { entered.resolve(); await gate.promise; return load(bytes); };
  const saving = h.api.savePDF(null, { zonderHandtekeningVraag: true });
  await entered.promise; h.switchToB(); gate.resolve();
  assert.equal(await saving, true);
  assert.ok(h.owners.every(doc => doc === h.a));
  assert.equal(h.b.modified, true);
});

test('queued save remains bound to A after switching to B', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  const write = h.deps.writeBinaryFileAtomic;
  let calls = 0;
  h.deps.writeBinaryFileAtomic = async (...args) => {
    if (++calls === 1) { entered.resolve(); await gate.promise; }
    return write(...args);
  };
  const first = h.api.savePDF(null, { zonderHandtekeningVraag: true });
  await entered.promise;
  const second = h.api.savePDF('second.pdf', { zonderHandtekeningVraag: true });
  h.switchToB(); gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(h.writes.map(w => w.source), ['a.pdf', 'a.pdf']);
});

test('Save As dialog keeps source and resulting path on A', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  h.deps.saveFileDialog = async () => { entered.resolve(); return gate.promise; };
  const saving = h.api.savePDFAs();
  await entered.promise; h.switchToB(); gate.resolve('copy-of-a.pdf');
  assert.equal(await saving, true);
  assert.deepEqual(h.writes, [{ path: 'copy-of-a.pdf', source: 'a.pdf' }]);
  assert.equal(h.a.filePath, 'copy-of-a.pdf');
  assert.equal(h.b.filePath, 'b.pdf');
});

test('closed document is not saved after the confirmation wait', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  h.deps.loadModule = async () => ({ bevestigOpslaanMetHandtekeningen: async () => { entered.resolve(); return gate.promise; } });
  const saving = h.api.savePDF();
  await entered.promise; h.deps.state.documents = [h.b]; gate.resolve(true);
  assert.equal(await saving, false);
  assert.deepEqual(h.writes, []);
});

test('write failure preserves modified and PDF/A state and re-locks the file', async () => {
  const h = harness(); let locks = 0;
  h.a.pdfaCompliance = 'PDF/A-2b';
  h.deps.writeBinaryFileAtomic = async () => { throw new Error('full disk'); };
  h.deps.lockFile = async () => { locks++; };
  assert.equal(await h.api.savePDF(null, { zonderHandtekeningVraag: true }), false);
  assert.equal(h.a.modified, true);
  assert.equal(h.a.pdfaCompliance, 'PDF/A-2b');
  assert.equal(locks, 1);
});

test('a rejected text edit aborts before disk write and stays pending', async () => {
  const h = harness();
  h.a.textEdits = [{ id: 'moved', newText: 'still pending' }];
  h.deps.saveTextEditsToPages = async () => { throw new Error('source text could not be located'); };
  assert.equal(await h.api.savePDF(null, { zonderHandtekeningVraag: true }), false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.a.modified, true);
  assert.equal(h.a.textEdits[0].baked, undefined);
});

test('same-path save blocks old paint before write and releases after native invalidation', async () => {
  const h = harness();
  const phases = [];
  let writeActive = false;
  h.deps.isTauri = () => true;
  h.deps.beginSourceWrite = path => {
    assert.equal(path, 'a.pdf');
    writeActive = true;
    phases.push('begin');
    return () => { writeActive = false; phases.push('finish'); };
  };
  h.deps.invoke = async command => {
    assert.equal(command, 'invalidate_pdf_cache');
    assert.equal(writeActive, true);
    phases.push('native-invalidate');
  };
  h.deps.writeBinaryFileAtomic = async () => {
    assert.equal(writeActive, true);
    phases.push('write');
  };
  const original = h.deps.loadModule;
  h.deps.loadModule = async path => {
    if (path.includes('page-bitmap-cache')) return { invalidateDocumentBitmaps: () => phases.push('bitmap-clear') };
    if (path.includes('tile-cache')) return { tileCacheClearForFile: () => phases.push('tile-clear') };
    if (path.includes('progressive-render')) return { cancelProgressiveRenderForFile: () => phases.push('progressive-cancel') };
    if (path.includes('bitmap-orchestrator')) return { cancelBitmapRendersForFile: () => phases.push('orchestrator-cancel') };
    if (path.includes('renderer.js')) return {
      clearBitmapJSCacheForFile: () => phases.push('js-cache-clear'),
      clearLowResCache: () => phases.push('preview-clear'),
      renderPage: () => phases.push('fresh-render'),
    };
    return original(path);
  };
  assert.equal(await h.api.savePDF(null, { zonderHandtekeningVraag: true }), true);
  assert.ok(phases.indexOf('begin') < phases.indexOf('write'));
  assert.ok(phases.indexOf('write') < phases.indexOf('native-invalidate'));
  assert.ok(phases.indexOf('native-invalidate') < phases.indexOf('finish'));
  assert.ok(phases.indexOf('finish') < phases.indexOf('fresh-render'));
  for (const clear of ['bitmap-clear', 'tile-clear', 'progressive-cancel', 'orchestrator-cancel', 'js-cache-clear', 'preview-clear']) {
    assert.ok(phases.indexOf('begin') < phases.indexOf(clear) && phases.indexOf(clear) < phases.indexOf('write'), clear);
  }
});

test('native invalidation failure is reported after disk save and releases the paint gate', async () => {
  const h = harness();
  const messages = [];
  let active = false;
  h.deps.isTauri = () => true;
  h.deps.beginSourceWrite = () => { active = true; return () => { active = false; }; };
  h.deps.invoke = async () => { throw new Error('worker invalidation failed'); };
  h.deps.showMessage = message => messages.push(message);
  const original = h.deps.loadModule;
  h.deps.loadModule = async path => {
    if (path.includes('page-bitmap-cache')) return { invalidateDocumentBitmaps() {} };
    if (path.includes('tile-cache')) return { tileCacheClearForFile() {} };
    if (path.includes('progressive-render')) return { cancelProgressiveRenderForFile() {} };
    if (path.includes('bitmap-orchestrator')) return { cancelBitmapRendersForFile() {} };
    if (path.includes('renderer.js')) return { clearBitmapJSCacheForFile() {}, clearLowResCache() {}, renderPage() {} };
    return original(path);
  };
  assert.equal(await h.api.savePDF(null, { zonderHandtekeningVraag: true }), true);
  assert.equal(active, false);
  assert.equal(h.a.modified, false);
  assert.deepEqual(messages, ['savedViewRefreshFailed']);
});

test('a structural reload during serialization cannot overwrite the prior document', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  const load = h.deps.PDFDocument.load;
  h.deps.PDFDocument.load = async bytes => { entered.resolve(); await gate.promise; return load(bytes); };
  const saving = h.api.savePDF(null, { zonderHandtekeningVraag: true });
  await entered.promise;
  h.a.pdfDoc = { newer: true };
  h.a.filePath = 'a-working-copy.pdf';
  gate.resolve();
  assert.equal(await saving, false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.a.modified, true);
});

test('a reload during the disk write never marks the newer document clean', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  const write = h.deps.writeBinaryFileAtomic;
  h.deps.writeBinaryFileAtomic = async (...args) => { entered.resolve(); await gate.promise; return write(...args); };
  const saving = h.api.savePDF(null, { zonderHandtekeningVraag: true });
  await entered.promise;
  h.a.pdfDoc = { newer: true };
  gate.resolve();
  assert.equal(await saving, false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.a.modified, true);
});

test('a markup edit during PDF serialization aborts before replacing the file', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  h.a.annotations = [{ id: 'note', page: 1, type: 'textbox', text: 'old' }];
  const load = h.deps.PDFDocument.load;
  h.deps.PDFDocument.load = async bytes => ({ ...(await load(bytes)),
    save: async () => { entered.resolve(); await gate.promise; return bytes; } });
  const saving = h.api.savePDF(null, { zonderHandtekeningVraag: true });
  await entered.promise;
  h.a.annotations[0].text = 'new';
  gate.resolve();
  assert.equal(await saving, false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.a.modified, true);
});

test('a markup edit during the disk write leaves the newer revision dirty', async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  h.a.annotations = [{ id: 'note', page: 1, type: 'textbox', text: 'old' }];
  const write = h.deps.writeBinaryFileAtomic;
  h.deps.writeBinaryFileAtomic = async (...args) => {
    entered.resolve(); await gate.promise; return write(...args);
  };
  const saving = h.api.savePDF(null, { zonderHandtekeningVraag: true });
  await entered.promise;
  h.a.annotations[0].text = 'new';
  gate.resolve();
  assert.equal(await saving, false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.a.modified, true);
});

test('saving aborts before writing when a page has model annotations but is not ready', async () => {
  const h = harness();
  h.a.annotations = [{ page: 1, type: 'highlight' }];
  h.a._annotationPagesReady = new Set();
  const load = h.deps.PDFDocument.load;
  h.deps.PDFDocument.load = async bytes => ({ ...(await load(bytes)),
    getPages: () => [{ getRotation: () => ({ angle: 0 }) }] });
  assert.equal(await h.api.savePDF(null, { zonderHandtekeningVraag: true }), false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.a.modified, true);
});

// File locks: one per path in the shell, not per tab.
function trackLocks(h, held = ['a.pdf', 'b.pdf']) {
  const locked = new Set(held);
  h.deps.lockFile = async path => { locked.add(path); };
  h.deps.unlockFile = async path => { locked.delete(path); };
  return locked;
}

test('Save As releases the lock on the file the tab left', async () => {
  const h = harness(); const locked = trackLocks(h);
  assert.equal(await h.api.savePDFAs(h.a), true);
  assert.equal(h.a.filePath, 'copy.pdf');
  assert.deepEqual([...locked].sort(), ['b.pdf', 'copy.pdf']);
});

test('Save As keeps the old file locked while another tab shows it', async () => {
  const h = harness(); const locked = trackLocks(h, ['a.pdf']);
  h.b.filePath = 'a.pdf';
  assert.equal(await h.api.savePDFAs(h.a), true);
  assert.deepEqual([...locked].sort(), ['a.pdf', 'copy.pdf']);
});

test('Save As from a working copy releases the original it saved to before', async () => {
  const h = harness(); const locked = trackLocks(h, ['real-a.pdf', 'b.pdf']);
  h.a.saveTargetPath = 'real-a.pdf';
  assert.equal(await h.api.savePDFAs(h.a), true);
  assert.deepEqual([...locked].sort(), ['b.pdf', 'copy.pdf']);
});

test('a tab closed during the disk write does not get its lock back', async () => {
  const h = harness(); const locked = trackLocks(h);
  h.deps.writeBinaryFileAtomic = async () => { h.deps.state.documents = [h.b]; };
  await h.api.savePDF(null, { zonderHandtekeningVraag: true });
  assert.equal(locked.has('a.pdf'), false);
});

test('a copy written to another path (no tab goes by it) is not left locked', async () => {
  const h = harness(); const locked = trackLocks(h);
  assert.equal(await h.api.savePDF('export.pdf', { zonderHandtekeningVraag: true }), true);
  assert.deepEqual([...locked].sort(), ['a.pdf', 'b.pdf']);
});

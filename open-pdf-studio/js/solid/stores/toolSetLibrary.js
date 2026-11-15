// Manage Tool Sets and shared tool sets in the app (docs/reference/editor/tool-chest.md).
//
// The logic lives in tools/tool-set-share.js (locks, check-out/in, offline
// cache), tools/tool-set-file.js (the set file) and tools/btx-import.js
// (the external editor .btx). This store wires them to the desktop file system (Tauri fs
// plugin + the atomic write command), the Tool Chest data and the UI:
//
//   - desktop: Add New with a save location, Add Existing (shared sets with
//     lock / check-out / check-in), refresh on window focus and every 30 s;
//   - browser build: no file system and no folder to watch, so sharing is
//     not available; Import and Export still work (file picker / download).

import { createSignal } from 'solid-js';
import {
  getToolChestSets, readToolSetContent, replaceToolSetTools, importToolSetContent, importToolSet,
  setToolSetEditGuard, addToolSet, setToolSetDisplay, setToolSetProfile, reorderToolSet, dropToolSet,
  deleteToolSet, MAX_TOOL_SETS,
} from '../../tools/tool-chest-presets.js';
import { ToolSetShareManager } from '../../tools/tool-set-share.js';
import {
  buildToolSetFile, parseToolSetFile, looksLikeToolSetFile, suggestedToolSetFileName,
  MAX_TOOL_SET_FILE_BYTES, TOOL_SET_FILE_EXTENSION,
} from '../../tools/tool-set-file.js';
import { parseBtx, looksLikeBtx } from '../../tools/btx-import.js';
import { listBtxInZip, MAX_TOOL_PACK_BYTES } from '../../tools/tool-pack.js';
import {
  isTauri, openFileDialog, saveFileDialog, readBinaryFile, writeBinaryFile, writeBinaryFileAtomic,
  getUsername, getAppDataDir, extractFileName,
} from '../../core/platform.js';

const LINKS_KEY = 'ocudraw.toolSets.shared.v1';
const INSTANCE_KEY = 'ocudraw.toolSets.instance.v1';
const POLL_MS = 30000;

const [version, setVersion] = createSignal(0);
const bump = () => setVersion(v => v + 1);
/** Reactive revision of the sharing state (read it in a memo to track changes). */
export const toolSetShareRevision = version;

let manager = null;
let starting = null;
let pollTimer = null;

/** Sharing needs the desktop app's file system. */
export const sharingAvailable = () => isTauri() && !!globalThis.window?.__TAURI__?.fs;

function instanceId() {
  try {
    const stored = globalThis.localStorage?.getItem(INSTANCE_KEY);
    if (stored && /^[A-Za-z0-9-]{8,64}$/u.test(stored)) return stored;
    const id = globalThis.crypto?.randomUUID?.() || `i${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    globalThis.localStorage?.setItem(INSTANCE_KEY, id);
    return id;
  } catch {
    return `i${Date.now().toString(36)}`;
  }
}

const allowed = new Set();
async function allowPath(path) {
  if (allowed.has(path)) return;
  try { await globalThis.window.__TAURI__.core.invoke('allow_fs_scope', { path }); allowed.add(path); }
  catch { /* the dialog may already have granted it */ }
}

/** The Tauri file system as tool-set-share.js wants it. */
function tauriFs() {
  const fs = () => globalThis.window.__TAURI__.fs;
  const base = (path) => path.replace(/\.lock$/u, '');
  return {
    readFile: async (path) => { await allowPath(base(path)); return new Uint8Array(await fs().readFile(path)); },
    stat: async (path) => {
      await allowPath(base(path));
      const info = await fs().stat(path);
      const mtime = info.mtime instanceof Date ? info.mtime.getTime() : Number(new Date(info.mtime));
      return { mtimeMs: Number.isFinite(mtime) ? mtime : 0, size: Number(info.size) || 0 };
    },
    writeFileAtomic: async (path, bytes) => { await allowPath(base(path)); await writeBinaryFileAtomic(path, bytes); },
    createExclusive: async (path, bytes) => {
      await allowPath(base(path));
      try { await fs().stat(path); return false; } catch { /* does not exist yet */ }
      try { await fs().writeFile(path, bytes, { createNew: true }); return true; }
      catch (error) { if (/exist/iu.test(String(error?.message || error))) return false; throw error; }
    },
    remove: async (path) => { await allowPath(base(path)); await fs().remove(path); },
  };
}

function linkStore() {
  return {
    load: () => { try { return JSON.parse(globalThis.localStorage?.getItem(LINKS_KEY) || '[]'); } catch { return []; } },
    save: (links) => { try { globalThis.localStorage?.setItem(LINKS_KEY, JSON.stringify(links)); } catch { /* session only */ } },
  };
}

const toolsAdapter = {
  read: (setId) => readToolSetContent(setId),
  write: (setId, content) => replaceToolSetTools(setId, content),
};

// Until the desktop manager is up, shared sets (known from storage) stay read-only.
setToolSetEditGuard((setId) => {
  if (manager) return manager.canEdit(setId);
  return !linkStore().load().some(link => link?.setId === setId);
});

/** Start sharing (desktop): manager, polling, focus refresh. Safe to call often. */
export function startToolSetSharing() {
  if (manager || starting || !sharingAvailable()) return starting;
  starting = (async () => {
    let user = 'User';
    try { user = (await getUsername()) || 'User'; } catch { /* default */ }
    let baseDir = null;
    try { baseDir = await getAppDataDir(); } catch { /* no relative paths */ }
    manager = new ToolSetShareManager({ fs: tauriFs(), identity: { user, instance: instanceId() },
      store: linkStore(), tools: toolsAdapter, baseDir });
    // Links whose set no longer exists are dropped.
    const sets = new Set(getToolChestSets().map(set => set.id));
    for (const link of manager.links()) if (!sets.has(link.setId)) await manager.unlink(link.setId);
    await refreshSharedSets();
    pollTimer = setInterval(() => { refreshSharedSets(); }, POLL_MS);
    globalThis.window?.addEventListener('focus', () => { refreshSharedSets(); });
    bump();
    return manager;
  })();
  return starting;
}

let refreshing = false;
export async function refreshSharedSets() {
  if (!manager || refreshing) return;
  refreshing = true;
  try { await manager.refreshAll(); } catch { /* next round */ }
  finally { refreshing = false; bump(); }
}

/** { shared, editable, checkedOut, offline, lockedBy, stale, lockLost, path } (reactive). */
export function toolSetShareStatus(setId) {
  version();
  if (manager) return manager.status(setId);
  const shared = linkStore().load().some(link => link?.setId === setId);
  return shared ? { shared: true, editable: false, offline: !sharingAvailable() } : { shared: false, editable: true };
}

// ---------------------------------------------------------------- actions

function setName(base) {
  const used = new Set(getToolChestSets().map(set => set.name.toLocaleLowerCase()));
  let name = String(base || 'Tool set').trim().slice(0, 48) || 'Tool set';
  for (let n = 2; used.has(name.toLocaleLowerCase()) && n < 999; n++) name = `${String(base).slice(0, 42)} (${n})`;
  return name;
}

const profileOf = (allProfiles, profile) => (allProfiles === false && profile ? profile : null);

/**
 * Add ▸ Add New: a new set. With `saveLocation` (desktop) the set is also
 * written to that file and shared from there.
 */
export async function addNewToolSet({ title, display = true, allProfiles = true, profile = null,
  saveLocation = null, relativePath = false }) {
  const set = addToolSet(title, { display, profile: profileOf(allProfiles, profile) });
  if (!set) throw new Error('That name is already used, or the Tool Chest has the maximum number of sets.');
  if (saveLocation) {
    await startToolSetSharing();
    if (!manager) { dropToolSet(set.id); throw new Error('Shared tool sets need the desktop app.'); }
    try { await manager.createShared(set.id, saveLocation, { relativePath }); }
    catch (error) { dropToolSet(set.id); throw error; }
  }
  bump();
  return set;
}

/** Ask where a new set file goes (Add New ▸ Save location). */
export async function pickNewSetLocation(title) {
  if (!sharingAvailable()) return null;
  return saveFileDialog(suggestedToolSetFileName(title),
    [{ name: 'OcuDraw tool set', extensions: [TOOL_SET_FILE_EXTENSION] }]);
}

async function pickFile(extensions, maxBytes) {
  const picked = await openFileDialog(extensions, { maxBytes });
  if (!picked) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (isTauri() && globalThis.window?.__TAURI__?.fs?.stat) {
    const info = await globalThis.window.__TAURI__.fs.stat(path);
    if (Number(info.size) > maxBytes) throw new Error(`The file is larger than ${maxBytes} bytes.`);
  }
  const bytes = await readBinaryFile(path);
  if (!bytes) return null;
  return { path, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
}

/** Add ▸ Add Existing (desktop): use a set file in place, shared with everyone who adds it. */
export async function addExistingToolSet({ display = true, allProfiles = true, profile = null, relativePath = false } = {}) {
  if (!sharingAvailable()) throw new Error('Add Existing needs the desktop app; in the browser use Import.');
  await startToolSetSharing();
  if (getToolChestSets().length > MAX_TOOL_SETS) throw new Error('The Tool Chest has the maximum number of sets.');
  const file = await pickFile([TOOL_SET_FILE_EXTENSION, 'json'], MAX_TOOL_SET_FILE_BYTES);
  if (!file) return null;
  const parsed = parseToolSetFile(file.bytes);
  if (manager.links().some(link => manager.pathOf(link.setId) === file.path)) {
    throw new Error('That tool set file is already in the Tool Chest.');
  }
  const set = addToolSet(setName(parsed.name), { display, profile: profileOf(allProfiles, profile) });
  if (!set) throw new Error('Could not add the tool set.');
  try {
    const result = await manager.addExisting(set.id, file.path, { relativePath });
    bump();
    return { set, ...result };
  } catch (error) {
    dropToolSet(set.id);
    throw error;
  }
}

/**
 * Import: copy a set file, portable JSON or the external editor .btx into a new local set.
 * Returns { set, accepted, rejected, unsupported }.
 */
export async function importToolSetFile() {
  const file = await pickFile([TOOL_SET_FILE_EXTENSION, 'json', 'btx', 'zip'], MAX_TOOL_PACK_BYTES);
  if (!file) return null;
  return importToolSetBytes(file.bytes, file.path);
}

function isZipPack(bytes) {
  return bytes?.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && !looksLikeBtx(bytes);
}

async function importToolPackBytes(bytes) {
  const entries = await listBtxInZip(bytes);
  if (!entries.length) throw new Error('The zip has no tool set (.btx) files.');
  const imported = [];
  const skipped = [];
  let accepted = 0;
  for (const entry of entries) {
    if (getToolChestSets().filter(set => !set.builtIn && !set.bundled).length >= MAX_TOOL_SETS) {
      skipped.push({ name: entry.name, error: 'The Tool Chest already has the maximum number of named sets.' });
      continue;
    }
    try {
      const one = await importToolSetBytes(entry.bytes, entry.name);
      imported.push(one);
      accepted += one.accepted || 0;
    } catch (error) {
      skipped.push({ name: entry.name, error: error?.message || String(error) });
    }
  }
  return {
    pack: true,
    set: imported.at(-1)?.set || null,
    acceptedSets: imported.length,
    accepted,
    skipped: skipped.length,
    unsupported: imported.flatMap(item => item.unsupported || []),
  };
}

export async function importToolSetBytes(bytes, name = '') {
  if (isZipPack(bytes)) return importToolPackBytes(bytes);
  let result;
  if (looksLikeBtx(bytes) || /\.btx$/iu.test(name)) {
    const parsed = await parseBtx(bytes);
    result = { ...importToolSetContent(parsed), unsupported: parsed.unsupported, source: 'btx' };
  } else if (looksLikeToolSetFile(bytes)) {
    const parsed = parseToolSetFile(bytes);
    const imported = importToolSetContent(parsed);
    result = { ...imported, rejected: imported.rejected + parsed.rejected, unsupported: [], source: 'file' };
  } else {
    const imported = importToolSet(bytes);
    result = { set: imported.set, accepted: imported.tools.length, rejected: 0, unsupported: [], source: 'portable' };
  }
  bump();
  return result;
}

/** Export: save the set as an OcuDraw tool set file anywhere. */
export async function exportToolSetFile(setId) {
  const content = readToolSetContent(setId);
  const bytes = buildToolSetFile(content);
  const path = await saveFileDialog(suggestedToolSetFileName(content.name),
    [{ name: 'OcuDraw tool set', extensions: [TOOL_SET_FILE_EXTENSION] }]);
  if (!path) return null;
  await writeBinaryFile(path, bytes);
  return { path, name: extractFileName(path) || path };
}

/** Remove: a shared set leaves the Tool Chest (the file stays); a local set's tools go to My Tools. */
export async function removeToolSet(setId) {
  if (manager?.isShared(setId)) {
    await manager.unlink(setId);
    dropToolSet(setId);
  } else if (linkStore().load().some(link => link?.setId === setId)) {
    const store = linkStore();
    store.save(store.load().filter(link => link?.setId !== setId));
    dropToolSet(setId);
  } else {
    deleteToolSet(setId);
  }
  bump();
  return true;
}

export function moveToolSet(setId, delta) { const ok = reorderToolSet(setId, delta); bump(); return ok; }
export function showToolSet(setId, display) { const set = setToolSetDisplay(setId, display); bump(); return set; }
export function showToolSetInAllProfiles(setId, all, profile) {
  const set = setToolSetProfile(setId, all ? null : profile);
  bump();
  return set;
}

async function withManager(run) {
  await startToolSetSharing();
  if (!manager) return { ok: false, reason: 'unavailable' };
  try { return await run(manager); }
  catch (error) { return { ok: false, reason: 'error', error: error?.message || String(error) }; }
  finally { bump(); }
}

export const checkOutToolSet = (setId, options) => withManager(m => m.checkOut(setId, options));
export const checkInToolSet = (setId, options) => withManager(m => m.checkIn(setId, options));
export const cancelToolSetCheckOut = (setId) => withManager(m => m.cancelCheckOut(setId));

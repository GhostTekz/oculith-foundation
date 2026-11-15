// Shared tool sets (the external editor "Share tool sets"; docs/reference/editor/tool-chest.md).
//
// A shared set is a tool set file (tool-set-file.js) in a folder several
// people can reach, for example a network share. Everyone who added it
// with Add Existing uses the same file:
//
//   - the Tool Chest keeps a copy of its tools (the offline cache), so the
//     set still works when the folder cannot be reached; offline it is
//     read-only;
//   - the set is read-only (lock icon) until you check it out; checking out
//     re-reads the file and creates a lock file next to it,
//     "<set file>.lock", with your user name, app instance and time. The
//     lock is created exclusively, so two people cannot both get it;
//   - check-in writes the file atomically (temporary file + rename) and
//     removes the lock; everyone else picks the change up on their next
//     refresh (window focus or the periodic check of the file's size and
//     modification time);
//   - a lock older than the stale age (8 hours) can be broken by someone
//     else; the former owner then cannot check in (the lock is gone), and a
//     check-in also refuses when the file changed since the check-out.
//
// No UI and no app state: the file system, the user identity, the clock,
// the link storage and the Tool Chest are all injected, so node tests can
// run two "users" against one temporary folder.

import {
  buildToolSetFile, parseToolSetFile, mergeUnknownToolFields, MAX_TOOL_SET_FILE_BYTES,
} from './tool-set-file.js';

export const LOCK_SUFFIX = '.lock';
export const LOCK_FORMAT = 'ocudraw.tool-set-lock';
export const DEFAULT_STALE_LOCK_MS = 8 * 60 * 60 * 1000;
const MAX_LOCK_BYTES = 4096;
const MAX_LINKS = 24;
const encoder = new TextEncoder();

export const lockPathFor = (path) => `${path}${LOCK_SUFFIX}`;

function shortText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, limit) : '';
}

/** A lock record: { user, instance, time (ms) }, or null. */
export function parseLock(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_LOCK_BYTES) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || value.format !== LOCK_FORMAT) return null;
    const time = Date.parse(value.time);
    const user = shortText(value.user, 80);
    const instance = shortText(value.instance, 80);
    return user && instance && Number.isFinite(time) ? { user, instance, time } : null;
  } catch {
    return null;
  }
}

export function buildLock(identity, time) {
  return encoder.encode(`${JSON.stringify({ format: LOCK_FORMAT, user: identity.user,
    instance: identity.instance, time: new Date(time).toISOString() })}\n`);
}

const sameOwner = (lock, identity) => !!lock && lock.user === identity.user && lock.instance === identity.instance;

/** Path of a link as stored: relative to `baseDir` when asked and possible. */
export function storedLinkPath(path, baseDir, relative) {
  if (!relative || !baseDir) return { path, relativePath: false };
  const base = baseDir.replace(/[\\/]+$/u, '');
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  if (path.startsWith(base + sep)) return { path: path.slice(base.length + 1), relativePath: true };
  return { path, relativePath: false };
}

/** Absolute path of a link. */
export function resolveLinkPath(link, baseDir) {
  if (!link?.relativePath || !baseDir) return link?.path;
  const base = baseDir.replace(/[\\/]+$/u, '');
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base}${sep}${link.path}`;
}

function cleanLink(value) {
  if (!value || typeof value !== 'object' || typeof value.setId !== 'string' ||
      typeof value.path !== 'string' || !value.path || value.path.length > 4096) return null;
  const stamp = value.stamp && Number.isFinite(value.stamp.mtimeMs) && Number.isFinite(value.stamp.size)
    ? { mtimeMs: value.stamp.mtimeMs, size: value.stamp.size } : null;
  return {
    setId: value.setId, path: value.path, relativePath: value.relativePath === true,
    stamp, checkedOut: value.checkedOut === true, offline: value.offline === true,
    lock: value.lock && typeof value.lock.user === 'string' ? {
      user: shortText(value.lock.user, 80), instance: shortText(value.lock.instance, 80),
      time: Number.isFinite(value.lock.time) ? value.lock.time : 0 } : null,
    lockLost: value.lockLost === true,
    syncedAt: Number.isFinite(value.syncedAt) ? value.syncedAt : 0,
  };
}

const sameStamp = (a, b) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

/**
 * fs: { readFile(path) → Uint8Array, stat(path) → { mtimeMs, size },
 *       writeFileAtomic(path, bytes), createExclusive(path, bytes) → boolean
 *       (false when the file exists), remove(path) }
 * identity: { user, instance }
 * store: { load() → links[], save(links) }
 * tools: { read(setId) → { name, tools, referenceScale? },
 *          write(setId, { name, tools, referenceScale? }) → { accepted, rejected } }
 */
export class ToolSetShareManager {
  constructor({ fs, identity, store, tools, now = () => Date.now(), staleMs = DEFAULT_STALE_LOCK_MS,
    baseDir = null }) {
    if (!fs || !identity?.user || !identity?.instance || !store || !tools) {
      throw new Error('ToolSetShareManager needs fs, identity, store and tools.');
    }
    this.files = fs;
    this.identity = { user: shortText(identity.user, 80), instance: shortText(identity.instance, 80) };
    this.store = store;
    this.tools = tools;
    this.now = now;
    this.staleMs = staleMs;
    this.baseDir = baseDir;
    let loaded = [];
    try { loaded = store.load() || []; } catch { loaded = []; }
    this.linkMap = new Map();
    for (const item of Array.isArray(loaded) ? loaded.slice(0, MAX_LINKS) : []) {
      const link = cleanLink(item);
      if (link) this.linkMap.set(link.setId, link);
    }
  }

  links() { return [...this.linkMap.values()].map(link => ({ ...link })); }
  link(setId) { const link = this.linkMap.get(setId); return link ? { ...link } : null; }
  isShared(setId) { return this.linkMap.has(setId); }
  pathOf(setId) { const link = this.linkMap.get(setId); return link ? resolveLinkPath(link, this.baseDir) : null; }

  /** Can this user change the set's tools now? Local (unshared) sets always can. */
  canEdit(setId) {
    const link = this.linkMap.get(setId);
    return !link || (link.checkedOut && !link.offline && !link.lockLost);
  }

  /** { shared, editable, checkedOut, offline, lockedBy, lockLost, stale } for the panel. */
  status(setId) {
    const link = this.linkMap.get(setId);
    if (!link) return { shared: false, editable: true };
    const other = link.lock && !sameOwner(link.lock, this.identity) ? link.lock : null;
    return { shared: true, editable: this.canEdit(setId), checkedOut: link.checkedOut,
      offline: link.offline, lockLost: link.lockLost, lockedBy: other ? other.user : null,
      lockedAt: other ? other.time : null,
      stale: !!other && this.now() - other.time > this.staleMs, path: this.pathOf(setId) };
  }

  persist() {
    try { this.store.save(this.links()); } catch { /* the session still works */ }
  }

  async readSetFile(path) {
    const info = await this.files.stat(path);
    if (info.size > MAX_TOOL_SET_FILE_BYTES) throw new Error('The tool set file is too large.');
    const bytes = await this.files.readFile(path);
    return { parsed: parseToolSetFile(bytes), stamp: { mtimeMs: info.mtimeMs, size: bytes.byteLength } };
  }

  async readLock(path) {
    try {
      const bytes = await this.files.readFile(lockPathFor(path));
      const lock = parseLock(bytes);
      // An unreadable lock still holds the set; it counts as stale from now.
      return lock || { user: '?', instance: '?', time: 0 };
    } catch {
      return null;
    }
  }

  /** Add Existing: link a set file, read it into the Tool Chest. */
  async addExisting(setId, path, { relativePath = false } = {}) {
    if (this.linkMap.size >= MAX_LINKS) throw new Error('Too many shared tool sets.');
    const { parsed, stamp } = await this.readSetFile(path);
    const result = this.tools.write(setId, parsed);
    const stored = storedLinkPath(path, this.baseDir, relativePath);
    const link = cleanLink({ setId, ...stored, stamp, syncedAt: this.now() });
    link.lock = await this.readLock(path);
    this.linkMap.set(setId, link);
    this.persist();
    return { name: parsed.name, ...result, rejected: (result?.rejected || 0) + parsed.rejected };
  }

  /** Add New with a save location: write the set's tools to a new file and share it. */
  async createShared(setId, path, { relativePath = false } = {}) {
    const bytes = buildToolSetFile(this.tools.read(setId));
    if (!(await this.files.createExclusive(path, bytes))) throw new Error('A file with that name already exists.');
    const info = await this.files.stat(path);
    const stored = storedLinkPath(path, this.baseDir, relativePath);
    this.linkMap.set(setId, cleanLink({ setId, ...stored, stamp: { mtimeMs: info.mtimeMs, size: info.size },
      syncedAt: this.now() }));
    this.persist();
    return this.link(setId);
  }

  /**
   * Re-read a shared set when its file changed (size or modification
   * time), and its lock. 'offline' keeps the cached tools read-only.
   */
  async refresh(setId, { force = false } = {}) {
    const link = this.linkMap.get(setId);
    if (!link) return { status: 'local' };
    const path = resolveLinkPath(link, this.baseDir);
    let info;
    try {
      info = await this.files.stat(path);
    } catch {
      link.offline = true;
      this.persist();
      return { status: 'offline' };
    }
    link.offline = false;
    link.lock = await this.readLock(path);
    if (link.checkedOut && !sameOwner(link.lock, this.identity)) link.lockLost = true;
    let status = 'unchanged';
    // While checked out the local tools are the working copy: no reload.
    if (!link.checkedOut && (force || !sameStamp(link.stamp, { mtimeMs: info.mtimeMs, size: info.size }))) {
      try {
        const { parsed, stamp } = await this.readSetFile(path);
        this.tools.write(setId, parsed);
        link.stamp = stamp;
        link.syncedAt = this.now();
        status = 'updated';
      } catch (error) {
        this.persist();
        return { status: 'error', error: error?.message || String(error) };
      }
    }
    this.persist();
    return { status };
  }

  async refreshAll() {
    const out = {};
    for (const setId of this.linkMap.keys()) out[setId] = await this.refresh(setId);
    return out;
  }

  /**
   * Check out for editing: reload the latest file, then take the lock.
   * `breakStale` removes a lock older than the stale age first.
   */
  async checkOut(setId, { breakStale = false } = {}) {
    const link = this.linkMap.get(setId);
    if (!link) return { ok: true, local: true };
    if (link.checkedOut && !link.lockLost) return { ok: true };
    const path = resolveLinkPath(link, this.baseDir);
    let existing;
    try {
      await this.files.stat(path);
      existing = await this.readLock(path);
    } catch {
      link.offline = true;
      this.persist();
      return { ok: false, reason: 'offline' };
    }
    if (existing && !sameOwner(existing, this.identity)) {
      const stale = this.now() - existing.time > this.staleMs;
      if (!stale || !breakStale) {
        link.lock = existing;
        this.persist();
        return { ok: false, reason: stale ? 'stale' : 'locked', lockedBy: existing.user, lockedAt: existing.time };
      }
      try { await this.files.remove(lockPathFor(path)); } catch { /* someone else removed it */ }
    }
    if (!existing || !sameOwner(existing, this.identity)) {
      const created = await this.files.createExclusive(lockPathFor(path), buildLock(this.identity, this.now()));
      if (!created) {
        link.lock = await this.readLock(path);
        this.persist();
        return { ok: false, reason: 'locked', lockedBy: link.lock?.user || '?' };
      }
    }
    // Start from the newest file, then work on the local copy.
    try {
      const { parsed, stamp } = await this.readSetFile(path);
      this.tools.write(setId, parsed);
      link.stamp = stamp;
    } catch (error) {
      try { await this.files.remove(lockPathFor(path)); } catch { /* best effort */ }
      return { ok: false, reason: 'unreadable', error: error?.message || String(error) };
    }
    link.lock = await this.readLock(path);
    link.checkedOut = true;
    link.lockLost = false;
    link.offline = false;
    link.syncedAt = this.now();
    this.persist();
    return { ok: true };
  }

  /** Check in: write the local tools to the file atomically and release the lock. */
  async checkIn(setId, { force = false } = {}) {
    const link = this.linkMap.get(setId);
    if (!link) return { ok: true, local: true };
    if (!link.checkedOut) return { ok: false, reason: 'notCheckedOut' };
    const path = resolveLinkPath(link, this.baseDir);
    let lock;
    let previous;
    try {
      lock = await this.readLock(path);
      previous = await this.readSetFile(path);
    } catch {
      link.offline = true;
      this.persist();
      return { ok: false, reason: 'offline' };
    }
    if (!sameOwner(lock, this.identity)) {
      link.lockLost = true;
      this.persist();
      return { ok: false, reason: 'lockLost', lockedBy: lock?.user || null };
    }
    if (!force && link.stamp && !sameStamp(link.stamp, previous.stamp)) {
      return { ok: false, reason: 'conflict' };
    }
    const local = this.tools.read(setId);
    const bytes = buildToolSetFile({ ...local, tools: mergeUnknownToolFields(local.tools, previous.parsed.tools) });
    await this.files.writeFileAtomic(path, bytes);
    const info = await this.files.stat(path);
    try { await this.files.remove(lockPathFor(path)); } catch { /* already gone */ }
    link.stamp = { mtimeMs: info.mtimeMs, size: info.size };
    link.checkedOut = false;
    link.lockLost = false;
    link.lock = null;
    link.syncedAt = this.now();
    this.persist();
    return { ok: true };
  }

  /** Undo a check-out: drop local edits (reload the file) and release the lock. */
  async cancelCheckOut(setId) {
    const link = this.linkMap.get(setId);
    if (!link || !link.checkedOut) return { ok: true };
    const path = resolveLinkPath(link, this.baseDir);
    try {
      const lock = await this.readLock(path);
      if (sameOwner(lock, this.identity)) await this.files.remove(lockPathFor(path));
    } catch { /* offline: the lock stays until it is stale */ }
    link.checkedOut = false;
    link.lockLost = false;
    this.persist();
    return this.refresh(setId, { force: true });
  }

  /** Remove the link (the file stays). Releases our lock when we hold it. */
  async unlink(setId) {
    const link = this.linkMap.get(setId);
    if (!link) return false;
    if (link.checkedOut) {
      const path = resolveLinkPath(link, this.baseDir);
      try {
        const lock = await this.readLock(path);
        if (sameOwner(lock, this.identity)) await this.files.remove(lockPathFor(path));
      } catch { /* offline */ }
    }
    this.linkMap.delete(setId);
    this.persist();
    return true;
  }
}

/** Node file system adapter (tests; the desktop app uses Tauri's). */
export function nodeToolSetFs(fsPromises) {
  return {
    readFile: async (path) => new Uint8Array(await fsPromises.readFile(path)),
    stat: async (path) => { const s = await fsPromises.stat(path); return { mtimeMs: s.mtimeMs, size: s.size }; },
    writeFileAtomic: async (path, bytes) => {
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await fsPromises.writeFile(temp, bytes);
      await fsPromises.rename(temp, path);
    },
    createExclusive: async (path, bytes) => {
      try { await fsPromises.writeFile(path, bytes, { flag: 'wx' }); return true; }
      catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
    },
    remove: (path) => fsPromises.unlink(path),
  };
}

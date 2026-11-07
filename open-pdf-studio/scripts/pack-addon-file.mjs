// Build one add-on file (a zip archive, `.ocaddon`) from verified package folders.
// Usage: node scripts/pack-addon-file.mjs --package DIR [--package DIR ...] --output FILE.ocaddon
//        [--editor-version VERSION]
// One package is stored at the archive root; several are stored as one folder
// per package ID. The archive is deterministic: sorted entries, a fixed
// timestamp, and Unix permissions that keep executables executable.
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { verifyAddonPackage } from './addon-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorVersion = JSON.parse(await readFile(path.join(here, '../package.json'), 'utf8')).version;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const HASH = /^[0-9a-fA-F]{64}$/;
const MODULE = /^chunks\/(?!\.)[A-Za-z0-9_.-]{1,128}\.js$/;
const MAX_MANIFEST = 1024 * 1024;
const MAX_EDITION_FILES = 64;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_PACKAGES = 16;
const MAX_ENTRIES = 512;
// 1980-01-01 00:00, the earliest DOS date, for byte-identical output.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || name.includes('\\') || name.includes(':') ||
      name.startsWith('/') || /[\u0000-\u001f]/.test(name) || name.split('/').length > 7 ||
      name.split('/').some((part) => !part || part === '.' || part === '..' || part.length > 255)) {
    throw new Error(`Invalid add-on path: ${name}`);
  }
  return name;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function treeFiles(root, relative = '') {
  const found = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = safeName(relative ? `${relative}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Add-on contains a symbolic link: ${name}`);
    if (entry.isDirectory()) found.push(...await treeFiles(root, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`Add-on contains a special file: ${name}`);
  }
  return found;
}

function targetMatchesFormat(target) {
  return target && typeof target === 'object' && !Array.isArray(target) &&
    Object.keys(target).sort().join(',') === 'arch,os' &&
    ['linux', 'windows', 'macos'].includes(target.os) &&
    (['x64', 'arm64'].includes(target.arch) || (target.os === 'macos' && target.arch === 'universal'));
}

/**
 * Check a full edition package (schema 1) against the editor's loader rules:
 * manifest fields, file list, digests, and no unlisted files. The target is
 * checked for form only, so a package for another platform can be packed here.
 */
export async function verifyEditionPackage(root, expectedEditorVersion = editorVersion) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real directory: ${root}`);
  const manifestInfo = await lstat(path.join(root, 'manifest.json'));
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || !manifestInfo.size || manifestInfo.size > MAX_MANIFEST) {
    throw new Error('Invalid add-on manifest file.');
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.hostApiVersion !== 1 ||
      typeof manifest.id !== 'string' || !ID.test(manifest.id) ||
      typeof manifest.version !== 'string' || !VERSION.test(manifest.version) ||
      manifest.editorVersion !== expectedEditorVersion ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error(`Edition package manifest is incompatible with editor ${expectedEditorVersion}.`);
  }
  const names = Object.keys(manifest.files);
  if (!names.length || names.length > MAX_EDITION_FILES || !Object.hasOwn(manifest.files, 'plugin.js') ||
      (manifest.helper !== undefined && (typeof manifest.helper !== 'string' || !Object.hasOwn(manifest.files, manifest.helper)))) {
    throw new Error('Invalid edition package file list.');
  }
  // An edition plug-in's further module files: listed, hashed chunks/<name>.js files.
  if (manifest.modules !== undefined && (!Array.isArray(manifest.modules) || manifest.modules.length > 48 ||
      new Set(manifest.modules).size !== manifest.modules.length ||
      manifest.modules.some((name) => typeof name !== 'string' || !MODULE.test(name) || !Object.hasOwn(manifest.files, name)))) {
    throw new Error('Invalid edition package module file list.');
  }
  const native = manifest.helper !== undefined || names.some((name) => name.startsWith('bin/'));
  if (manifest.target === undefined ? native : !targetMatchesFormat(manifest.target)) {
    throw new Error('A native edition package needs a valid target OS and architecture.');
  }
  for (const name of names) {
    safeName(name);
    if (name === 'manifest.json' || !HASH.test(manifest.files[name])) throw new Error(`Invalid file entry: ${name}`);
    const file = await lstat(path.join(root, name));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Expected a regular add-on file: ${name}`);
    if (name === 'plugin.js' && (!file.size || file.size > 64 * 1024 * 1024)) throw new Error('Invalid plugin.js size.');
    if (name === 'plugin.css' && file.size > 16 * 1024 * 1024) throw new Error('Invalid plugin.css size.');
    if (manifest.modules?.includes(name) && (!file.size || file.size > 64 * 1024 * 1024)) throw new Error(`Invalid module file size: ${name}`);
    if (file.size > MAX_FILE) throw new Error(`${name} is larger than 128 MiB.`);
    if (await sha256(path.join(root, name)) !== manifest.files[name].toLowerCase()) throw new Error(`Add-on hash mismatch: ${name}`);
    if (name === manifest.helper && manifest.target?.os !== 'windows' && process.platform !== 'win32' && !(file.mode & 0o111)) {
      throw new Error(`Add-on helper is not executable: ${name}`);
    }
  }
  const listed = new Set(['manifest.json', ...names]);
  const actual = await treeFiles(root);
  if (actual.length !== listed.size || actual.some((name) => !listed.has(name))) {
    throw new Error('Edition package has unlisted files.');
  }
  return manifest;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(bytes) >>> 0;
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal zip writer (stored or deflated entries, no zip64). */
export function zipEntries(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so permissions are kept
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > 0xfffffff0) throw new Error('The add-on file is too large.');
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Verify each package folder and write them into one add-on file. */
export async function packAddonFile({ packages, output, expectedEditorVersion = editorVersion }) {
  if (!Array.isArray(packages) || !packages.length || packages.length > MAX_PACKAGES) {
    throw new Error(`Give one to ${MAX_PACKAGES} package folders.`);
  }
  if (typeof output !== 'string' || !output) throw new Error('--output is required.');
  const destination = path.resolve(output);
  if (await lstat(destination).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error('Output already exists.');
  }
  const verified = [];
  const ids = new Set();
  let editions = 0;
  for (const folder of packages) {
    const root = path.resolve(folder);
    const head = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    const manifest = head?.schemaVersion === 1
      ? await verifyEditionPackage(root, expectedEditorVersion)
      : await verifyAddonPackage(root, expectedEditorVersion);
    if (ids.has(manifest.id)) throw new Error(`Package ${manifest.id} is given twice.`);
    ids.add(manifest.id);
    if (manifest.schemaVersion === 1 && ++editions > 1) throw new Error('Only one edition package fits in an add-on file.');
    if (destination.startsWith(`${root}${path.sep}`)) throw new Error('Output must be outside the package folders.');
    verified.push({ root, manifest });
  }
  const entries = [];
  let total = 0;
  for (const { root, manifest } of verified) {
    const prefix = verified.length === 1 ? '' : `${manifest.id}/`;
    for (const name of ['manifest.json', ...Object.keys(manifest.files)]) {
      const file = path.join(root, name);
      const info = await lstat(file);
      const data = await readFile(file);
      total += data.length;
      if (total > MAX_TOTAL) throw new Error('The packages are larger than 512 MiB together.');
      const executable = process.platform === 'win32' ? name.endsWith('.exe') || name === manifest.helper : (info.mode & 0o111) !== 0;
      entries.push({ name: `${prefix}${name}`, data, mode: executable ? 0o755 : 0o644 });
    }
  }
  if (entries.length > MAX_ENTRIES) throw new Error('Too many files for one add-on file.');
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const bytes = zipEntries(entries);
  const partial = `${destination}.partial-${process.pid}`;
  const handle = await open(partial, 'wx', 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(partial, destination); }
  catch (error) { await rm(partial, { force: true }); throw error; }
  return verified.map(({ manifest }) => ({
    id: manifest.id, version: manifest.version, kind: manifest.schemaVersion === 1 ? 'edition' : 'package',
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const packages = [];
    const options = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${flag}`);
      if (flag === '--package') packages.push(value);
      else if (flag === '--output') options.output = value;
      else if (flag === '--editor-version') options.expectedEditorVersion = value;
      else throw new Error(`Unknown option: ${flag}`);
    }
    const summary = await packAddonFile({ packages, ...options });
    for (const item of summary) console.log(`Packed ${item.kind} ${item.id} ${item.version}`);
    console.log(`Wrote ${path.resolve(options.output)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

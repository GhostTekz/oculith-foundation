import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { packAddonFile, verifyEditionPackage } from './pack-addon-file.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorVersion = JSON.parse(await readFile(path.join(here, '../package.json'), 'utf8')).version;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hostTarget = { os: { win32: 'windows', darwin: 'macos' }[process.platform] || 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' };

async function independent(root) {
  const folder = path.join(root, 'tools');
  const script = 'export function createAddon() { return {}; }';
  await mkdir(folder);
  await writeFile(path.join(folder, 'plugin.js'), script);
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, hostApiVersion: 1, id: 'example.tools', version: '1.0.0', editorVersion,
    files: { 'plugin.js': hash(script) },
  }));
  return folder;
}

async function edition(root) {
  const folder = path.join(root, 'edition');
  const files = { 'plugin.js': 'export const edition = {};', 'bin/helper': 'helper', 'notices/LICENSE-ADDON.txt': 'licence' };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), text);
  }
  await chmod(path.join(folder, 'bin/helper'), 0o755);
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, hostApiVersion: 1, id: 'example.edition', version: '2.0.0', editorVersion,
    target: hostTarget, helper: 'bin/helper',
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])),
  }));
  return folder;
}

/** Read a zip's central directory and inflate each entry. */
function readZip(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const body = bytes.subarray(start, start + size);
    entries.push({ name, mode, data: method === 8 ? zlib.inflateRawSync(body) : body });
    at += 46 + nameLength;
  }
  return entries;
}

test('add-on file holds verified packages in sorted folders and keeps executables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-addon-file-test-'));
  try {
    const packages = [await edition(root), await independent(root)];
    const summary = await packAddonFile({ packages, output: path.join(root, 'both.ocaddon') });
    assert.deepEqual(summary.map((item) => [item.id, item.kind]), [['example.edition', 'edition'], ['example.tools', 'package']]);
    const bytes = await readFile(path.join(root, 'both.ocaddon'));
    const entries = readZip(bytes);
    assert.deepEqual(entries.map((entry) => entry.name), [
      'example.edition/bin/helper', 'example.edition/manifest.json', 'example.edition/notices/LICENSE-ADDON.txt',
      'example.edition/plugin.js', 'example.tools/manifest.json', 'example.tools/plugin.js',
    ]);
    assert.equal(entries[0].data.toString(), 'helper');
    if (process.platform !== 'win32') assert.equal(entries[0].mode & 0o777, 0o755);
    assert.equal(entries[3].mode & 0o777, 0o644);

    await packAddonFile({ packages, output: path.join(root, 'again.ocaddon') });
    assert.deepEqual(await readFile(path.join(root, 'again.ocaddon')), bytes, 'output is deterministic');

    await packAddonFile({ packages: [packages[1]], output: path.join(root, 'one.ocaddon') });
    assert.deepEqual(readZip(await readFile(path.join(root, 'one.ocaddon'))).map((entry) => entry.name), ['manifest.json', 'plugin.js']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('add-on file refuses unlisted files, duplicates and existing output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-addon-file-test-'));
  try {
    const folder = await edition(root);
    await assert.rejects(packAddonFile({ packages: [folder, folder], output: path.join(root, 'twice.ocaddon') }), /given twice/);
    await writeFile(path.join(root, 'exists.ocaddon'), '');
    await assert.rejects(packAddonFile({ packages: [folder], output: path.join(root, 'exists.ocaddon') }), /already exists/);
    await writeFile(path.join(folder, 'notices', 'extra.txt'), 'not listed');
    await assert.rejects(packAddonFile({ packages: [folder], output: path.join(root, 'extra.ocaddon') }), /unlisted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an edition package may carry module files: listed, hashed chunks/<name>.js files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-addon-file-test-'));
  try {
    const folder = await edition(root);
    const manifestPath = path.join(folder, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await mkdir(path.join(folder, 'chunks'));
    const chunk = 'export const panel = 1;';
    await writeFile(path.join(folder, 'chunks/Panel-a1.js'), chunk);
    manifest.files['chunks/Panel-a1.js'] = hash(chunk);
    manifest.modules = ['chunks/Panel-a1.js'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual((await verifyEditionPackage(folder)).modules, ['chunks/Panel-a1.js']);
    for (const modules of [['chunks/missing.js'], ['bin/helper'], ['chunks/.hidden.js'], 'chunks/Panel-a1.js']) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, modules }));
      await assert.rejects(verifyEditionPackage(folder), /module file list/, JSON.stringify(modules));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

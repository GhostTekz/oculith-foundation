// Verify the published Community source inventory and private-code boundary.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoots = ['.cargo/', '.github/', 'open-pdf-studio/', 'open-pdf-render/', 'pdfium-worker/',
  'open-pdf-cad/', 'ocg-render-copy/', 'open-pdf-geos/', 'mcp-stdio/', 'mcpb/', 'docs/',
  'scripts/rust-spdx-texts/', 'scripts/rust-upstream-notices/'];
const rootFiles = new Set(['Cargo.toml', 'Cargo.lock', 'LICENSE.md', '.gitignore', '.gitattributes',
  'README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'SOURCE-STATE.json', 'SBOM.cdx.json',
  'scripts/rust-license-inventory.py', 'scripts/rust-notice-bundle.py']);
const generatedFiles = new Set(['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'SOURCE-STATE.json', 'SBOM.cdx.json']);
const traceExempt = /(?:^|\/)(?:LICENSE[^/]*|LGPL[^/]*|[^/]*notices?[^/]*\.txt)$/i;
// The names the public tree may not contain (private paths, product and
// service names, bundle markers) are kept here as fingerprints, not as
// text, so this file names nothing it guards. A fingerprint is two 32-bit
// polynomial hashes of the term, its length and how it is bounded; a term is
// found by hashing every stretch of that length. The terms themselves live
// in the private source, which checks these tables against them.
const NOT_AFTER_LETTER = 1; // the term may not follow a letter
const WORD_END = 2; // a non-word character or the end follows the term

export function fingerprint(text) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = (Math.imul(a, 257) + c) >>> 0;
    b = (Math.imul(b, 65599) + c) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

// The two hashes as one exact number (32 + 21 bits) for the finder's lookups.
const key = (a, b) => a * 0x200000 + (b & 0x1fffff);
const keyOf = (print) => key(parseInt(print.slice(0, 8), 16), parseInt(print.slice(8), 16));
const power = (base, n) => { let p = 1; for (let i = 0; i < n; i++) p = Math.imul(p, base) >>> 0; return p; };

/** A finder for fingerprinted terms ([fingerprint, length, bounds]); true when `text` holds one. */
export function termFinder(table, { caseSensitive = false } = {}) {
  const byLength = new Map();
  for (const [print, length, bounds = 0] of table) {
    if (!byLength.has(length)) byLength.set(length, new Map());
    byLength.get(length).set(keyOf(print), bounds);
  }
  const lengths = [...byLength].map(([length, prints]) => ({ length, prints, pa: power(257, length - 1), pb: power(65599, length - 1) }));
  return (input) => {
    const text = caseSensitive ? String(input) : String(input).toLowerCase();
    for (const { length, prints, pa, pb } of lengths) {
      if (text.length < length) continue;
      let a = 0;
      let b = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (i >= length) {
          const out = text.charCodeAt(i - length);
          a = (a - Math.imul(out, pa)) >>> 0;
          b = (b - Math.imul(out, pb)) >>> 0;
        }
        a = (Math.imul(a, 257) + c) >>> 0;
        b = (Math.imul(b, 65599) + c) >>> 0;
        if (i < length - 1) continue;
        const bounds = prints.get(key(a, b));
        if (bounds === undefined) continue;
        const at = i - length + 1;
        if ((bounds & NOT_AFTER_LETTER) && at > 0 && /[a-z]/i.test(text[at - 1])) continue;
        if ((bounds & WORD_END) && i + 1 < text.length && /\w/.test(text[i + 1])) continue;
        return true;
      }
    }
    return false;
  };
}

export const TRACE_TERMS = [
  ['cc912041929c36e1', 10],
  ['629569aed8a0fa22', 4, 1],
  ['b547840ed27dd136', 15],
  ['4c846321df7ec0bf', 5],
  ['21363f214ea37cb7', 5, 1],
  ['70b8849f608cf7b9', 4, 1],
  ['8399617fe66bd9c5', 6],
  ['919d5f88c0b46742', 6, 3],
  ['2ec06ab5b616c635', 7, 3],
  ['2eb350a8afaffca8', 7, 3],
  ['f63e737172401129', 9, 3],
  ['23403619074dee69', 5, 3],
  ['632cb839969f3f41', 6, 3],
  ['5c93db6983c69101', 8],
  ['dd6f279d971b3d17', 11],
  ['248cf30548f6b9ff', 15],
  ['79f95cf9630f73af', 10],
  ['35a34e7d301f0ad3', 14],
  ['1461c776f130941a', 14],
  ['d7d9473775dd35cb', 18],
  ['e266d05408a2793e', 8],
  ['956e7e22e75d6452', 15],
  ['494e55cac0345e5e', 15],
  ['6917c19dadbd0d8b', 17],
  ['1678df21e8057ea1', 18],
];
export const PATH_SEGMENTS = [
  ['cc912041929c36e1'],
  ['629569aed8a0fa22'],
  ['d0c3d0f5dffbfb25'],
  ['4ab66645c311eddb'],
  ['6c0632c38a663065'],
  ['6fbf9abd36f7c34f'],
];
export const PATH_TERMS = [
  ['4c846321df7ec0bf', 5],
];
export const PRIVATE_PATHS = [
  ['8983ee5afa26676c'],
  ['8fe2540eb140425a'],
  ['90ce3352514b27f6'],
  ['041d208a2126d5a8'],
  ['1ee5aefed30aea3c'],
  ['0267486c5ea12756'],
  ['b9f87ef74824f893'],
  ['19a5e7ccc2fa9436'],
  ['04e3b85f5a736c67'],
  ['0ca29756e4a7102e'],
  ['6f18d8087a280ab4'],
  ['d11175861752f718'],
  ['1ed1d199370011d1'],
  ['a0f405f22a982126'],
  ['388caf939dd28ce3'],
  ['a17212729936740a'],
  ['4c9d87239cc592fd'],
  ['28df9324694daffe'],
  ['f34c3d76025cc6b2'],
  ['067aa5867c04934e'],
  ['c11bdf022ff7ea82'],
  ['04dd9c829f02a334'],
  ['3d383b408587ddea'],
  ['65e8390f2873f8b1'],
  ['13af858e6f4f281e'],
  ['c13322f1823904a1'],
  ['4078f97757499649'],
  ['413f20546743d9a0'],
  ['56ae73d7babf6cff'],
  ['56b181e2bc419d7a'],
  ['40eba20ad5894830'],
];
export const BUNDLE_MARKERS = [
  ['1e2228027bd67024', 14],
  ['f01a31577b21c2f5', 12],
  ['ca95537dceb1f12f', 16],
  ['e215a511b476016d', 13],
  ['fb4aa54364da67f1', 20],
  ['edd900d62fc91ac6', 12],
];

const productTrace = termFinder(TRACE_TERMS);
const pathTrace = termFinder(PATH_TERMS);
const segments = new Set(PATH_SEGMENTS.map(([print]) => print));
const privatePaths = new Set(PRIVATE_PATHS.map(([print]) => print));
const bundleMarker = termFinder(BUNDLE_MARKERS, { caseSensitive: true });

/** Whether a source path is outside what Foundation may publish. */
export function unapprovedPath(relative) {
  if (pathTrace(relative)) return true;
  return relative.toLowerCase().split('/').some((part) => segments.has(fingerprint(part.split('.')[0])) && part.split('.')[0].length > 0);
}

/** Whether `text` (a line or a file name) holds a private product trace. */
export const hasProductTrace = (text) => productTrace(text);

const generatedDirs = new Set([
  'open-pdf-studio/node_modules',
  'open-pdf-studio/dist',
  'open-pdf-studio/src-tauri/gen',
  'open-pdf-studio/src-tauri/target',
  'open-pdf-studio/src-tauri/resources/tessdata',
  'open-pdf-studio/src-tauri/resources/fonts',
  'target',
]);

// No private file or folder may be present (generated folders and .git aside).
async function checkPrivatePaths(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, item.name);
    const relative = path.relative(root, name).replaceAll(path.sep, '/');
    if (relative === '.git' || generatedDirs.has(relative)) continue;
    if (privatePaths.has(fingerprint(relative))) throw new Error(`Private source present: ${relative}`);
    if (item.isDirectory()) await checkPrivatePaths(name);
  }
}

async function exists(name) {
  return access(path.isAbsolute(name) ? name : path.join(root, name)).then(() => true, () => false);
}

async function scanBundle(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, item.name);
    if (item.isDirectory()) { await scanBundle(name); continue; }
    if (!item.isFile() || !/\.(?:js|css|html)$/i.test(item.name)) continue;
    const body = await readFile(name, 'utf8');
    if (bundleMarker(body)) throw new Error(`Private marker found in ${path.relative(root, name)}`);
  }
}

async function verifyPublicTree(expected) {
  const hits = [];
  for (const relative of expected) {
    if (traceExempt.test(relative)) continue;
    if (productTrace(relative)) hits.push(`${relative}: file name`);
    const bytes = await readFile(path.join(root, relative));
    if (bytes.includes(0)) continue;
    for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
      if (productTrace(line)) hits.push(`${relative}:${index + 1}`);
    }
  }
  if (hits.length) throw new Error(`Private product traces in public source:\n${hits.slice(0, 100).join('\n')}`);
}

async function verifyPublicSbom(state, pkg) {
  const sbom = JSON.parse(await readFile(path.join(root, 'SBOM.cdx.json'), 'utf8'));
  if (sbom.bomFormat !== 'CycloneDX' || sbom.metadata?.component?.name !== 'Oculith Draw Foundation'
    || sbom.metadata.component.version !== pkg.version || !Array.isArray(sbom.components)) {
    throw new Error('Invalid Foundation SBOM.');
  }
  const properties = Object.fromEntries((sbom.metadata.properties || []).map((item) => [item.name, item.value]));
  const hash = async (relative) => createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
  if ((state && properties['ocudraw:sourceCommit'] !== state.commit)
    || (!state && properties['ocudraw:sourceCommit'])
    || properties['ocudraw:cargoLockSha256'] !== await hash('Cargo.lock')
    || properties['ocudraw:npmLockSha256'] !== await hash('open-pdf-studio/package-lock.json')) {
    throw new Error('Foundation SBOM does not match its source and lockfiles.');
  }
  const app = path.join(root, 'open-pdf-studio');
  const notices = path.join(app, 'src-tauri', 'package-notices');
  const [lock, npmInventory, rustInventory, rustNotices] = await Promise.all([
    readFile(path.join(app, 'package-lock.json'), 'utf8'),
    readFile(path.join(notices, 'npm-inventory.json'), 'utf8'),
    readFile(path.join(notices, 'rust-inventory.json'), 'utf8'),
    readFile(path.join(notices, 'rust-notice-manifest.json'), 'utf8'),
  ]).then((items) => items.map((item) => JSON.parse(item)));
  const npmLocked = Object.entries(lock.packages)
    .filter(([name, item]) => name && !item.dev)
    .map(([name, item]) => [name.slice('node_modules/'.length), item.version, item.license ?? null]);
  if (JSON.stringify(npmInventory.packages.map((item) =>
    [item.name, item.version, item.licenseFromLockfile])) !== JSON.stringify(npmLocked)) {
    throw new Error('Foundation npm inventory differs from the lockfile.');
  }
  const rustExternal = rustInventory.packages.filter((item) => !item.workspace);
  if (rustInventory.cargoLockSha256 !== properties['ocudraw:cargoLockSha256']
    || rustNotices.cargoLockSha256 !== properties['ocudraw:cargoLockSha256']
    || rustNotices.externalPackageCount !== rustExternal.length
    || JSON.stringify(rustNotices.packages.map((item) => [item.name, item.version, item.source]))
      !== JSON.stringify(rustExternal.map((item) => [item.name, item.version, item.source]))) {
    throw new Error('Foundation Rust inventory differs from the lockfile or notices.');
  }
  if (sbom.components.length !== npmInventory.packages.length + rustExternal.length) {
    throw new Error('Foundation SBOM component count differs from the inventories.');
  }
  const refs = sbom.components.map((item) => item['bom-ref']);
  if (new Set(refs).size !== refs.length) throw new Error('Duplicate Foundation SBOM component.');
}

async function checkSourceTree(dir, expected) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, item.name);
    const relative = path.relative(root, name).replaceAll(path.sep, '/');
    if (generatedDirs.has(relative)) continue;
    if (item.isDirectory()) { await checkSourceTree(name, expected); continue; }
    if (relative === 'SOURCE-MANIFEST.json') continue;
    if (/^open-pdf-studio\/src-tauri\/binaries\/(?:pdfium-worker|ocudraw-community-pdfium-worker)-[a-zA-Z0-9_-]+$/.test(relative)) continue;
    if (!item.isFile() || !expected.has(relative)) {
      throw new Error(`Unlisted or non-regular source entry: ${relative}`);
    }
  }
}

export async function verifyCommunityExport({ bundle = false, published = false } = {}) {
  if (published) {
    if (await exists('SOURCE-STATE.json') || await exists('SOURCE-MANIFEST.json')) {
      throw new Error('Published Foundation source retains private source provenance.');
    }
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root })
      .toString('utf8').split('\0').filter(Boolean);
    const expected = new Set(files);
    for (const relative of expected) {
      if ((!rootFiles.has(relative) && !sourceRoots.some((dir) => relative.startsWith(dir)))
        || unapprovedPath(relative)) throw new Error(`Unapproved public source path: ${relative}`);
    }
    const pkg = JSON.parse(await readFile(path.join(root, 'open-pdf-studio/package.json'), 'utf8'));
    await verifyPublicSbom(null, pkg);
    await verifyPublicTree(expected);
    await checkPrivatePaths(root);
    if (bundle) await scanBundle(path.join(root, 'open-pdf-studio/dist'));
    return expected.size;
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
  if (manifest.edition !== 'community' || !Array.isArray(manifest.files)) {
    throw new Error('Invalid Community source manifest.');
  }
  const state = JSON.parse(await readFile(path.join(root, 'SOURCE-STATE.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'open-pdf-studio/package.json'), 'utf8'));
  const tauri = JSON.parse(await readFile(path.join(root, 'open-pdf-studio/src-tauri/tauri.conf.json'), 'utf8'));
  const linux = JSON.parse(await readFile(path.join(root, 'open-pdf-studio/src-tauri/tauri.linux.conf.json'), 'utf8'));
  const cargo = await readFile(path.join(root, 'open-pdf-studio/src-tauri/Cargo.toml'), 'utf8');
  if (state.edition !== 'community' || state.commit !== manifest.commit
    || state.version !== pkg.version || manifest.version !== pkg.version
    || state.files !== manifest.files.filter((item) =>
      !item.path.startsWith('docs/') && !['.github/workflows/ci.yml',
        '.github/workflows/installers.yml'].includes(item.path)
      && !generatedFiles.has(item.path)).length) {
    throw new Error('Invalid Community source identity.');
  }
  if (!cargo.includes('description = "Oculith Draw Foundation, an open source PDF workspace"')
    || cargo.includes('description = "Oculith Draw,')) {
    throw new Error('Community native package description is not neutral.');
  }
  if (tauri.mainBinaryName !== 'ocudraw-community'
    || tauri.bundle?.externalBin?.[0] !== 'binaries/ocudraw-community-pdfium-worker'
    || linux.bundle?.externalBin?.[0] !== 'binaries/ocudraw-community-pdfium-worker') {
    throw new Error('Community native package binary names collide with the edition package.');
  }
  let previous = '';
  const expected = new Set();
  for (const item of manifest.files) {
    if (item.path <= previous) throw new Error(`Unsorted or duplicate source path: ${item.path}`);
    previous = item.path;
    expected.add(item.path);
    if (path.isAbsolute(item.path) || item.path.split('/').includes('..')) {
      throw new Error(`Unsafe source path: ${item.path}`);
    }
    if ((!rootFiles.has(item.path) && !sourceRoots.some((dir) => item.path.startsWith(dir)))
      || unapprovedPath(item.path)) {
      throw new Error(`Unapproved source path: ${item.path}`);
    }
    const digest = createHash('sha256').update(await readFile(path.join(root, item.path))).digest('hex');
    if (digest !== item.sha256) throw new Error(`Source hash mismatch: ${item.path}`);
  }
  await checkSourceTree(root, expected);
  if (!expected.has('SBOM.cdx.json')) throw new Error('Community SBOM is missing.');
  await verifyPublicSbom(state, pkg);
  await verifyPublicTree(expected);
  await checkPrivatePaths(root);
  if (bundle) {
    const dist = path.join(root, 'open-pdf-studio', 'dist');
    if (!await exists(path.join(dist, 'index.html'))) throw new Error('Community bundle is missing.');
    await scanBundle(dist);
  }
  return manifest.files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--bundle', '--published'].includes(arg))) throw new Error('Usage: node scripts/community-export-verify.mjs [--bundle] [--published]');
  const count = await verifyCommunityExport({ bundle: args.includes('--bundle'), published: args.includes('--published') });
  process.stdout.write(`Verified ${count} Foundation source files${args.includes('--bundle') ? ' and bundle' : ''}.\n`);
}

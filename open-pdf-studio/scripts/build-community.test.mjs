import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { communityBuildCommand, releaseBuildOptions, foundationSourceRoute, verifyBuiltFoundationSourceRoute, writeFoundationSourceRoute } from './build-community.mjs';
import { parseFoundationSourceRoute, readBundledFoundationSource } from '../js/core/foundation-source.js';

test('Foundation Tauri build selects the public config', () => {
  const build = communityBuildCommand(['--no-bundle']);
  assert.equal(build.args[0].endsWith('/@tauri-apps/cli/tauri.js') || build.args[0].endsWith('\\@tauri-apps\\cli\\tauri.js'), true);
  assert.deepEqual(build.args.slice(1), [
    'build', '--config', 'src-tauri/tauri.community.conf.json', '--no-bundle',
  ]);
  assert.equal(build.env.OCUDRAW_EDITION, 'community');
  assert.match(build.env.CARGO_TARGET_DIR, /[\\/]community$/);
  assert.throws(() => communityBuildCommand(['--config', 'src-tauri/tauri.conf.json']));
  assert.throws(() => communityBuildCommand(['--runner', 'other']));
  assert.deepEqual(communityBuildCommand(['--bundles', 'appimage']).args.slice(1, 5),
    ['build', '--config', 'src-tauri/tauri.community.conf.json', '--bundles']);
});

test('a Foundation release build stamps its version and signs updater artefacts', () => {
  assert.deepEqual(releaseBuildOptions({}), { args: [], env: {} });
  const build = communityBuildCommand(['--bundles', 'nsis'],
    { OCUDRAW_RELEASE_VERSION: '2026.68.12', TAURI_SIGNING_PRIVATE_KEY: 'key' });
  assert.deepEqual(build.args.slice(1), [
    'build', '--config', 'src-tauri/tauri.community.conf.json',
    '--config', '{"version":"2026.68.12"}',
    '--config', '{"bundle":{"createUpdaterArtifacts":true}}',
    '--bundles', 'nsis',
  ]);
  assert.equal(build.env.VITE_OCULITH_UPDATER_ENABLED, 'true');
  assert.throws(() => releaseBuildOptions({ OCUDRAW_RELEASE_VERSION: '2026.68' }));
  assert.throws(() => releaseBuildOptions({ OCUDRAW_RELEASE_VERSION: '1.0.0 --debug' }));
});

test('Community frontend build selects the existing prepared build path', () => {
  const build = communityBuildCommand(['--frontend-only']);
  assert.deepEqual(build.args, ['run', 'build']);
  assert.equal(build.env.OCUDRAW_EDITION, 'community');
});

test('Foundation package uses the public executable and worker names', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.community.conf.json', import.meta.url)));
  assert.equal(config.mainBinaryName, 'ocudraw-community');
  assert.deepEqual(config.bundle.externalBin, ['binaries/ocudraw-community-pdfium-worker']);
  assert.equal(config.bundle.resources['../public/foundation-source.json'], 'source/foundation-source.json');
});

test('public build embeds the exact clean source route and refuses a dirty revision', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'foundation-source-route-'));
  const runGit = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    mkdirSync(path.join(root, 'open-pdf-studio', 'public'), { recursive: true });
    writeFileSync(path.join(root, '.gitignore'), 'open-pdf-studio/public/foundation-source.json\n');
    const pkg = path.join(root, 'open-pdf-studio', 'package.json');
    writeFileSync(pkg, JSON.stringify({ version: '2026.68.0' }));
    runGit('init', '-q');
    runGit('remote', 'add', 'origin', 'https://github.com/GhostTekz/oculith-foundation.git');
    runGit('add', '.');
    runGit('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');

    const route = writeFoundationSourceRoute(root);
    assert.equal(route.commit, runGit('rev-parse', 'HEAD'));
    assert.equal(route.tree, runGit('rev-parse', 'HEAD^{tree}'));
    assert.equal(route.version, '2026.68.0');
    assert.deepEqual(parseFoundationSourceRoute(route), {
      version: route.version,
      commit: route.commit,
      tree: route.tree,
      sourceArchive: route.sourceArchive,
      buildInstructions: route.buildInstructions,
    });
    const generated = path.join(root, 'open-pdf-studio', 'public', 'foundation-source.json');
    assert.deepEqual(JSON.parse(readFileSync(generated, 'utf8')), route);
    assert.equal(runGit('status', '--porcelain'), '');
    assert.throws(() => verifyBuiltFoundationSourceRoute(route, root), /did not bundle/);
    mkdirSync(path.join(root, 'open-pdf-studio', 'dist'));
    const built = path.join(root, 'open-pdf-studio', 'dist', 'foundation-source.json');
    writeFileSync(built, readFileSync(generated));
    verifyBuiltFoundationSourceRoute(route, root);
    writeFileSync(built, '{}');
    assert.throws(() => verifyBuiltFoundationSourceRoute(route, root), /differs/);

    writeFileSync(pkg, JSON.stringify({ version: '2026.69.0' }));
    assert.throws(() => foundationSourceRoute(root), /modified public checkout/);
    runGit('checkout', '--', 'open-pdf-studio/package.json');
    runGit('remote', 'set-url', 'origin', 'https://github.com/example/another.git');
    assert.equal(writeFoundationSourceRoute(root), null);
    assert.deepEqual(JSON.parse(readFileSync(generated, 'utf8')), {});
    assert.equal(parseFoundationSourceRoute(JSON.parse(readFileSync(generated, 'utf8'))), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a downloaded source archive without Git metadata remains buildable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'foundation-source-archive-'));
  try {
    mkdirSync(path.join(root, 'open-pdf-studio', 'public'), { recursive: true });
    assert.equal(writeFoundationSourceRoute(root), null);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'open-pdf-studio', 'public', 'foundation-source.json'), 'utf8')), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('About only accepts the pinned public source route bundled with the app', async () => {
  const base = 'https://github.com/GhostTekz/oculith-foundation';
  const commit = 'a'.repeat(40);
  const route = {
    schemaVersion: 1, version: '2026.68.0', repository: base, commit, tree: 'b'.repeat(40),
    sourceArchive: `${base}/archive/${commit}.tar.gz`,
    buildInstructions: `${base}/blob/${commit}/docs/BUILDING.md`,
  };
  const loaded = await readBundledFoundationSource(async (url) => {
    assert.equal(url, '/foundation-source.json');
    return { ok: true, json: async () => route };
  });
  assert.equal(loaded.commit, commit);
  assert.equal(parseFoundationSourceRoute({ ...route, sourceArchive: 'https://example.invalid/' }), null);
  assert.equal(parseFoundationSourceRoute({ ...route, repository: 'https://example.invalid/' }), null);
  assert.equal(await readBundledFoundationSource(async () => ({ ok: false })), null);
});

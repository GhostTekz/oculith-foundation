import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRepository = 'https://github.com/GhostTekz/oculith-foundation';
const publicRemote = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)GhostTekz\/oculith-foundation(?:\.git)?$/i;

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot identify Foundation source: git ${args[0]} failed.`);
  return result.stdout.trim();
}

export function foundationSourceRoute(root = path.resolve(project, '..')) {
  // A downloaded source archive has no Git metadata; it remains buildable,
  // but it cannot claim the revision of an installed release.
  const remote = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status !== 0) return null;
  const origin = remote.stdout.trim();
  if (!publicRemote.test(origin)) return null;
  if (git(root, 'status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Cannot record a Foundation source revision from a modified public checkout.');
  }
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) {
    throw new Error('Cannot record a valid Foundation source revision.');
  }
  const { version } = JSON.parse(readFileSync(path.join(root, 'open-pdf-studio', 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !version) throw new Error('Foundation version is missing.');
  return {
    schemaVersion: 1,
    version,
    repository: publicRepository,
    commit,
    tree,
    sourceArchive: `${publicRepository}/archive/${commit}.tar.gz`,
    buildInstructions: `${publicRepository}/blob/${commit}/docs/BUILDING.md`,
  };
}

export function writeFoundationSourceRoute(root = path.resolve(project, '..')) {
  const destination = path.join(root, 'open-pdf-studio', 'public', 'foundation-source.json');
  const route = foundationSourceRoute(root);
  // The bundle always needs this resource, including builds from source
  // archives without Git metadata. An empty object makes About show its
  // unrecorded-source fallback and cannot pass the installed release audit.
  writeFileSync(destination, route ? `${JSON.stringify(route, null, 2)}\n` : '{}\n');
  return route;
}

export function verifyBuiltFoundationSourceRoute(route, root = path.resolve(project, '..')) {
  if (!route) return;
  const built = path.join(root, 'open-pdf-studio', 'dist', 'foundation-source.json');
  let actual;
  try { actual = JSON.parse(readFileSync(built, 'utf8')); }
  catch { throw new Error('Foundation frontend did not bundle its source route.'); }
  if (JSON.stringify(actual) !== JSON.stringify(route)) {
    throw new Error('Foundation frontend source route differs from the build checkout.');
  }
}
const editionTargetDir = (env = process.env) => path.join(path.resolve(project,
  env.OCUDRAW_TARGET_BASE || env.CARGO_TARGET_DIR || path.resolve(project, '..', 'target')), 'community');

// A published Foundation release (the public repository's release workflow)
// sets OCUDRAW_RELEASE_VERSION to its build version and provides the update
// signing key. Then the build stamps that version, signs the updater
// artefacts and enables the update check. Other builds are unchanged.
export function releaseBuildOptions(env = process.env) {
  const config = [];
  const extraEnv = {};
  const version = env.OCUDRAW_RELEASE_VERSION;
  if (version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Foundation release version.');
    config.push({ version });
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    config.push({ bundle: { createUpdaterArtifacts: true } });
    extraEnv.VITE_OCULITH_UPDATER_ENABLED = 'true';
  }
  return { args: config.flatMap((c) => ['--config', JSON.stringify(c)]), env: extraEnv };
}

export function communityBuildCommand(args = [], env = process.env) {
  const frontendOnly = args.includes('--frontend-only');
  const forwarded = args.filter((arg) => arg !== '--frontend-only');
  if (frontendOnly && forwarded.length) throw new Error('Frontend-only build takes no Tauri arguments.');
  const switches = new Set(['--no-bundle', '--debug', '--ci', '--no-sign', '--skip-stapling', '--verbose']);
  const bundles = new Set(['deb', 'rpm', 'appimage', 'nsis', 'app', 'dmg']);
  for (let i = 0; i < forwarded.length; i++) {
    const arg = forwarded[i];
    if (switches.has(arg)) continue;
    if (arg === '--bundles') {
      const value = forwarded[++i] || '';
      if (!value.split(',').every((part) => bundles.has(part))) throw new Error('Invalid Community bundle type.');
      continue;
    }
    if (arg === '--target') {
      if (!/^[a-zA-Z0-9_-]+$/.test(forwarded[++i] || '')) throw new Error('Invalid Community build target.');
      continue;
    }
    throw new Error(`Unsupported Community build option: ${arg}`);
  }
  return frontendOnly
    ? { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', 'build'],
      env: { OCUDRAW_EDITION: 'community', CARGO_TARGET_DIR: editionTargetDir() } }
    : {
      command: process.execPath,
      args: [path.join(project, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
        'build', '--config', 'src-tauri/tauri.community.conf.json',
        ...releaseBuildOptions(env).args, ...forwarded],
      env: { OCUDRAW_EDITION: 'community', CARGO_TARGET_DIR: editionTargetDir(env),
        ...releaseBuildOptions(env).env },
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const route = writeFoundationSourceRoute();
  const spec = communityBuildCommand(process.argv.slice(2));
  if (!process.argv.includes('--frontend-only')) {
    const { readFileSync } = await import('node:fs');
    const base = JSON.parse(readFileSync(path.join(project, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    if (base.productName !== 'Oculith Draw Foundation'
      || base.identifier !== 'com.ghosttekz.ocudraw.community'
      || base.bundle?.windows?.nsis?.installerHooks
      || base.bundle?.windows?.nsis?.template) {
      throw new Error('Foundation identity or installer configuration is invalid.');
    }
  }
  const result = spawnSync(spec.command, spec.args, {
    cwd: project,
    env: { ...process.env, ...spec.env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status === 0) verifyBuiltFoundationSourceRoute(route);
  process.exit(result.status ?? 1);
}

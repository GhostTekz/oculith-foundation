// UI proof for the AI connections panel (Settings ▸ General ▸ AI link and
// the command palette) in the editor alone. The browser runs the real panel;
// the native commands are played by ai-connections-smoke-native.mjs against a
// scratch home folder (never the real one). Native path and parse rules are
// covered by the Rust tests in src-tauri/src/ai_connections.rs.
//
// AI_CONN_SHOTS=<dir> also saves screenshots there.
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { parseJsonc, SERVER_NAME } from '../js/mcp/ai-connections.js';
import { scratchClients } from './ai-connections-smoke-native.mjs';

process.env.OCUDRAW_EDITION = 'community';
const temp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'ai-connections-smoke-'));
const shots = process.env.AI_CONN_SHOTS ? resolve(process.env.AI_CONN_SHOTS) : null;
if (shots) await mkdir(shots, { recursive: true });

const freePort = async () => {
  const tcp = createTcpServer();
  await new Promise((ok, fail) => tcp.once('error', fail).listen(0, '127.0.0.1', ok));
  const { port } = tcp.address();
  await new Promise((ok) => tcp.close(ok));
  return port;
};
const { home, paths: P, bridgeScript, mcpPort, native, writes, close } = await scratchClients(temp);

const vitePort = await freePort();
const server = await createServer({ cacheDir: join(temp, 'vite-cache'),
  server: { host: '127.0.0.1', port: vitePort, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-proxy-server'] });

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.exposeFunction('__aiNative', async (name, args) => native[name](args || {}));
  await context.addInitScript(() => {
    window.__TAURI__ = {
      core: { invoke: async (name, args) => {
        if (name === 'edition_plugins') return [];
        if (name === 'mcp_status' || name.startsWith('ai_')) return window.__aiNative(name, args);
        return null;
      } },
      event: { listen: async () => () => {} },
      dialog: { ask: async () => true },
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.title === 'Oculith Draw Foundation', null, { timeout: 60_000 });
  const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

  // Settings ▸ General ▸ AI link (MCP) ▸ AI connections...
  await page.evaluate(() => import('/js/core/preferences.js').then((m) => m.showPreferencesDialog('general')));
  await page.locator('#prefs-mcp-connections').click();
  const panel = page.locator('.ai-connections-dialog');
  await panel.locator('tr[data-client="cursor"][data-state="stale"]').waitFor();
  const state = async () => Object.fromEntries(await panel.locator('tr[data-client]').evaluateAll((rows) => rows.map((r) => [r.dataset.client, r.dataset.state])));
  assert.deepEqual(await state(), {
    'claude-desktop': 'unlinked', 'claude-code': 'unlinked', vscode: 'error', cursor: 'stale', codex: 'unlinked', opencode: 'unlinked',
  });
  assert.match(await panel.locator('#ai-conn-stale').textContent(), new RegExp(`port ${mcpPort}`));
  assert.equal(await panel.locator('tr[data-client="vscode"] button').count(), 0, 'a malformed file offers no change');
  assert.match(await panel.locator('tr[data-client="vscode"]').textContent(), /Cannot edit/);
  await shot('1-clients');

  // Test connection.
  await panel.locator('#ai-conn-test').click();
  await panel.locator('.ai-conn-test[data-ok="true"]').waitFor();
  assert.match(await panel.locator('.ai-conn-test').textContent(), /3 tools/);

  const applyOn = async (client, action, expectDiff) => {
    await panel.locator(`tr[data-client="${client}"] button[data-action="${action}"]`).click();
    const preview = panel.locator('#ai-conn-preview');
    await preview.waitFor();
    const diff = await preview.locator('.ai-conn-diff').textContent();
    if (expectDiff) assert.match(diff, expectDiff, diff);
    await panel.locator('#ai-conn-apply').click();
    await preview.waitFor({ state: 'detached' });
    await panel.locator('#ai-conn-notice').waitFor();
    return diff;
  };

  // Claude Code: other servers kept, a one-time backup.
  const before = await readFile(P['claude-code'], 'utf8');
  await applyOn('claude-code', 'connect', new RegExp(`\\+.*"url": "http://127.0.0.1:${mcpPort}/mcp"`));
  await panel.locator('tr[data-client="claude-code"][data-state="linked"]').waitFor();
  const cc = JSON.parse(await readFile(P['claude-code'], 'utf8'));
  assert.deepEqual(cc.mcpServers.other, { type: 'http', url: 'http://127.0.0.1:7000/mcp' });
  assert.deepEqual(cc.mcpServers[SERVER_NAME], { type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp` });
  assert.equal(cc.numStartups, 3);
  assert.equal(await readFile(`${P['claude-code']}.bak`, 'utf8'), before);
  assert.match(await panel.locator('#ai-conn-notice').textContent(), /\.bak/);
  await shot('2-claude-code-linked');

  // Cursor: Repair to the running port, then Disconnect removes only our entry.
  await applyOn('cursor', 'repair', /^-.*9223/m);
  await panel.locator('tr[data-client="cursor"][data-state="linked"]').waitFor();
  await panel.locator('#ai-conn-stale').waitFor({ state: 'detached' });
  await applyOn('cursor', 'disconnect');
  await panel.locator('tr[data-client="cursor"][data-state="unlinked"]').waitFor();
  assert.deepEqual(JSON.parse(await readFile(P.cursor, 'utf8')), { mcpServers: {} });

  // Claude Desktop: the bundled bridge with Node.js, file created.
  await applyOn('claude-desktop', 'connect');
  const cd = JSON.parse(await readFile(P['claude-desktop'], 'utf8'));
  assert.deepEqual(cd.mcpServers[SERVER_NAME], { command: '/usr/bin/node', args: [bridgeScript], env: { OPS_MCP_PORT: String(mcpPort) } });
  assert.equal(existsSync(`${P['claude-desktop']}.bak`), false, 'no backup of a file that did not exist');

  // Codex (TOML) and OpenCode (JSONC: the comment survives).
  await applyOn('codex', 'connect', /\+\[mcp_servers\.oculith-draw\]/);
  assert.equal(await readFile(P.codex, 'utf8'), `# my codex\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.oculith-draw]\nurl = "http://127.0.0.1:${mcpPort}/mcp"\n`);
  await applyOn('opencode', 'connect');
  const oc = await readFile(P.opencode, 'utf8');
  assert.ok(oc.includes('// keep this comment'), oc);
  assert.deepEqual(parseJsonc(oc).root && JSON.parse(oc.replace(/\/\/.*\n/, '\n').replace(/,(\s*[}\]])/g, '$1')).mcp.servers[SERVER_NAME],
    { type: 'remote', url: `http://127.0.0.1:${mcpPort}/mcp` });
  await panel.locator('tr[data-client="opencode"][data-state="linked"]').waitFor();

  // A file changed behind the panel's back is refused, not overwritten.
  await writeFile(P.cursor, '{ "mcpServers": { "someone-else": { "url": "x" } } }\n');
  await panel.locator('tr[data-client="cursor"] button[data-action="connect"]').click();
  await panel.locator('#ai-conn-apply').click();
  await panel.locator('#ai-conn-notice.ai-conn-err').waitFor();
  assert.match(await panel.locator('#ai-conn-notice').textContent(), /changed since it was read/);
  assert.equal(await readFile(P.cursor, 'utf8'), '{ "mcpServers": { "someone-else": { "url": "x" } } }\n');

  // Other clients: copyable settings.
  await panel.locator('summary', { hasText: 'Other clients' }).click();
  assert.match(await panel.locator('.ai-conn-snippet pre').first().textContent(), new RegExp(`http://127.0.0.1:${mcpPort}/mcp`));

  // Foundation has no Local models section; an edition adds its own.
  assert.equal(await panel.locator('#ai-conn-models').count(), 0);
  assert.equal(await panel.locator('[data-section]').count(), 0);

  // The command palette opens the same single panel.
  await page.evaluate(() => import('/js/solid/stores/dialogStore.js').then((m) => m.closeDialog('ai-connections')));
  await panel.waitFor({ state: 'detached' });
  await page.evaluate(() => import('/js/solid/commands/index.js').then((m) => m.getCommand('help.aiConnections').run()));
  await panel.locator('tr[data-client="claude-code"][data-state="linked"]').waitFor();

  assert.deepEqual(writes, ['claude-code', 'cursor', 'cursor', 'claude-desktop', 'codex', 'opencode']);
  assert.ok(existsSync(home));
  assert.deepEqual(errors, []);
  await context.close();
  console.log('AI connections panel: detect, connect, repair, disconnect, refusal of malformed and changed files, test and snippets passed.');
} finally {
  await browser.close();
  await server.close();
  close();
  await rm(temp, { recursive: true, force: true });
}

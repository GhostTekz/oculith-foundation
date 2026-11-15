// The desktop side of the AI connections panel, played in Node for the
// browser smokes: a scratch home folder (never the real one) with one
// synthetic settings file per case, the panel's native commands working on
// it with the rules of src-tauri/src/ai_connections.rs (expected-text check,
// one-time .bak, refusal of files that do not parse), and a fake AI link on
// loopback that answers tools/list.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonc, SERVER_NAME } from '../js/mcp/ai-connections.js';

export const listen = async (handler) => {
  const s = createHttpServer(handler);
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return s;
};

const put = async (file, text) => { await mkdir(dirname(file), { recursive: true }); if (text !== null) await writeFile(file, text); };

// Stand-in for the native TOML check: table headers, comments, blank lines
// and key = value lines only.
const tomlError = (text) => (text.split('\n').some((l) => l.trim() && !/^\s*(#.*|\[[^\]]+\]\s*|[A-Za-z0-9_."-]+\s*=\s*\S.*)$/.test(l)) ? 'invalid TOML' : null);

export async function scratchClients(temp) {
  const home = join(temp, 'home');
  const paths = {
    'claude-desktop': join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    'claude-code': join(home, '.claude.json'),
    vscode: join(home, '.config', 'Code', 'User', 'mcp.json'),
    cursor: join(home, '.cursor', 'mcp.json'),
    codex: join(home, '.codex', 'config.toml'),
    opencode: join(home, '.config', 'opencode', 'opencode.jsonc'),
  };
  await put(paths['claude-desktop'], null); // installed (folder), no settings yet
  await put(paths['claude-code'], '{\n  "numStartups": 3,\n  "mcpServers": {\n    "other": {\n      "type": "http",\n      "url": "http://127.0.0.1:7000/mcp"\n    }\n  }\n}\n');
  await put(paths.vscode, '{ "servers": { "x": { "type": "http", "url": "u" } \n'); // malformed
  await put(paths.cursor, `{\n  "mcpServers": {\n    "${SERVER_NAME}": { "url": "http://127.0.0.1:9223/mcp" }\n  }\n}\n`); // older port
  await put(paths.codex, '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  await put(paths.opencode, '{\n  // keep this comment\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "system",\n}\n');
  const bridgeScript = join(temp, 'app', 'mcp-stdio', 'server.mjs');
  await put(bridgeScript, '// bridge\n');

  const mcp = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } }));
    });
  });
  const mcpPort = mcp.address().port;

  const parseError = (id, text) => {
    if (!text.trim()) return null;
    if (id === 'codex') return tomlError(text);
    try { parseJsonc(text); return null; } catch (e) { return e.message; }
  };
  const writes = [];
  const native = {
    async mcp_status() { return { actief: true, poort: mcpPort, bron: 'instelling', fout: null }; },
    async ai_connections_scan() {
      const clients = [];
      for (const [id, path] of Object.entries(paths)) {
        let file;
        if (!existsSync(path)) file = { exists: false, text: null, error: null };
        else { const text = await readFile(path, 'utf8'); file = { exists: true, text, error: null, readOnly: false, parseError: parseError(id, text) }; }
        clients.push({ id, format: id === 'codex' ? 'toml' : 'json', path, installed: existsSync(dirname(path)), cli: null, file });
      }
      return { os: 'linux', clients, bridge: { script: bridgeScript, node: '/usr/bin/node' } };
    },
    async ai_connection_write({ client, text, expected }) {
      const path = paths[client];
      assert.ok(path && path.startsWith(home), 'writes stay in the scratch home');
      const err = parseError(client, text);
      if (err) throw new Error(`The planned change does not parse, nothing was written: ${err}`);
      const current = existsSync(path) ? await readFile(path, 'utf8') : null;
      if (current !== (expected ?? null)) throw new Error('The file changed since it was read. Review the change again.');
      let backup = null;
      if (current !== null && !existsSync(`${path}.bak`)) { await copyFile(path, `${path}.bak`); backup = `${path}.bak`; }
      await put(path, text);
      writes.push(client);
      return { path, backup };
    },
    async ai_link_test({ port }) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      const v = await res.json();
      return { ok: true, url: `http://127.0.0.1:${port}/mcp`, tools: v.result.tools.length };
    },
  };
  return { home, paths, bridgeScript, mcpPort, native, writes, close: () => mcp.close() };
}

// AI connections planning (ai-connections.js): synthetic settings files per
// client — none, empty, other servers, comments, already linked, another
// port, malformed — and the local-model provider plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENTS, SERVER_NAME, clientById, clientStatus, jsonGet, jsonRemove, jsonSet, mcpUrl,
  parseJsonc, planConnect, planDisconnect, planEdit, snippets,
  tomlForeignDefinition, tomlRemoveTable, tomlSetRootKey, tomlSetTable, tomlTableValues, unifiedDiff,
} from './ai-connections.js';
import {
  AI_CONNECTIONS_SECTIONS_API_VERSION, aiConnectionsSections, registerAiConnectionsSection, subscribe,
} from './ai-connections-sections.js';

const BRIDGE = { script: '/opt/app/mcp-stdio/server.mjs', node: '/usr/bin/node' };
const ctx = (port = 9223, bridge = BRIDGE) => ({ port, bridge });
const scan = (text, extra = {}) => ({
  path: '/home/u/settings',
  file: text === null ? { exists: false, text: null, error: null } : { exists: true, text, error: null, ...extra },
});
const assertJson = (text) => assert.doesNotThrow(() => parseJsonc(text), text);

test('every client has an id, label and a container or table', () => {
  assert.deepEqual(CLIENTS.map((c) => c.id), ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'codex', 'opencode']);
  for (const c of CLIENTS) assert.ok(c.label && (c.container || c.table));
});

test('connect on a missing or empty file creates the minimal settings', () => {
  for (const text of [null, '', '  \n']) {
    const p = planConnect('vscode', scan(text), ctx());
    assert.equal(p.ok, true);
    assert.deepEqual(JSON.parse(p.after), { servers: { [SERVER_NAME]: { type: 'http', url: 'http://127.0.0.1:9223/mcp' } } });
    assert.equal(p.expected, text === null ? null : text);
  }
  const codex = planConnect('codex', scan(null), ctx(9300));
  assert.equal(codex.after, '[mcp_servers.oculith-draw]\nurl = "http://127.0.0.1:9300/mcp"\n');
  const oc = planConnect('opencode', scan(null), ctx());
  assert.deepEqual(JSON.parse(oc.after), { mcp: { servers: { [SERVER_NAME]: { type: 'remote', url: mcpUrl(9223) } } } });
});

test('connect keeps other servers, keys, comments and indentation', () => {
  const text = [
    '{',
    '    // my servers',
    '    "mcpServers": {',
    '        "other": { "command": "x" } /* keep */',
    '    },',
    '    "theme": "dark",',
    '}',
    '',
  ].join('\n');
  const p = planConnect('cursor', scan(text), ctx());
  assert.equal(p.ok, true);
  assert.ok(p.after.includes('// my servers') && p.after.includes('/* keep */') && p.after.includes('"theme": "dark",'));
  assert.ok(p.after.includes(`        "${SERVER_NAME}": {\n            "url": "http://127.0.0.1:9223/mcp"\n        }`), p.after);
  assert.deepEqual(jsonGet(p.after, ['mcpServers'], 'other'), { command: 'x' });
  assert.match(p.diff, /^\+\s+"oculith-draw"/m);
  // Only the comma after the last member is added to an existing line.
  assert.deepEqual(p.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')), ['-        "other": { "command": "x" } /* keep */']);
  assert.ok(p.after.includes('"other": { "command": "x" }, /* keep */\n'));
});

test('connect adds the container when the file has other keys only', () => {
  const text = '{\n  "numStartups": 4,\n  "projects": {}\n}\n';
  const p = planConnect('claude-code', scan(text), ctx());
  assert.deepEqual(JSON.parse(p.after), { numStartups: 4, projects: {}, mcpServers: { [SERVER_NAME]: { type: 'http', url: mcpUrl(9223) } } });
  assert.ok(p.after.startsWith('{\n  "numStartups": 4,\n  "projects": {},\n  "mcpServers": {'));
});

test('a one-line file stays valid and keeps its members', () => {
  const p = planConnect('claude-code', scan('{"mcpServers":{"a":{"type":"http","url":"u"}},"x":1}'), ctx());
  const v = JSON.parse(p.after);
  assert.deepEqual(Object.keys(v.mcpServers), ['a', SERVER_NAME]);
  assert.equal(v.x, 1);
});

test('status: unlinked, linked, stale after a port change, then Repair and Disconnect', () => {
  const vs = clientById('vscode');
  assert.equal(clientStatus(vs, scan(null), ctx()).state, 'unlinked');
  const linked = planConnect('vscode', scan('{ "servers": { "a": { "type": "stdio", "command": "a" } }, "inputs": [] }'), ctx()).after;
  assert.equal(clientStatus(vs, scan(linked), ctx()).state, 'linked');
  assert.equal(clientStatus(vs, scan(linked), ctx(9300)).state, 'stale');
  const repaired = planConnect('vscode', scan(linked), ctx(9300));
  assert.equal(clientStatus(vs, scan(repaired.after), ctx(9300)).state, 'linked');
  assert.match(repaired.diff, /^-.*9223/m);
  assert.match(repaired.diff, /^\+.*9300/m);
  const off = planDisconnect('vscode', scan(repaired.after));
  assert.deepEqual(JSON.parse(off.after), { servers: { a: { type: 'stdio', command: 'a' } }, inputs: [] });
  assert.equal(clientStatus(vs, scan(off.after), ctx()).state, 'unlinked');
  // Connect twice changes nothing the second time.
  const again = planConnect('vscode', scan(linked), ctx());
  assert.equal(again.changed, false);
  assert.equal(again.diff, '');
});

test('malformed, unreadable and read-only files are refused and not planned', () => {
  for (const id of ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'opencode']) {
    const s = scan('{ "mcpServers": { ', { parseError: 'EOF while parsing' });
    assert.equal(clientStatus(clientById(id), s, ctx()).state, 'error');
    assert.equal(planConnect(id, s, ctx()).ok, false);
    assert.equal(planDisconnect(id, s).ok, false);
  }
  // The planner refuses on its own when no parse error was reported.
  const p = planConnect('cursor', scan('{ "mcpServers": { "a": 1 '), ctx());
  assert.equal(p.ok, false);
  assert.match(p.error, /line 1/);
  assert.equal(planConnect('cursor', scan('{}', { readOnly: true }), ctx()).ok, false);
  assert.equal(planConnect('cursor', { path: 'x', file: { exists: true, text: null, error: 'Permission denied' } }, ctx()).ok, false);
  assert.equal(planConnect('codex', scan('[x', { parseError: 'bad' }), ctx()).ok, false);
  // A container that is not an object is not overwritten.
  assert.equal(planConnect('cursor', scan('{ "mcpServers": [] }'), ctx()).ok, false);
  assert.equal(planConnect('cursor', scan('[1, 2]'), ctx()).ok, false);
});

test('Claude Desktop runs the bundled bridge with Node.js on the chosen port', () => {
  const p = planConnect('claude-desktop', scan('{"mcpServers": {}}'), ctx(9555));
  assert.deepEqual(JSON.parse(p.after).mcpServers[SERVER_NAME], { command: '/usr/bin/node', args: [BRIDGE.script], env: { OPS_MCP_PORT: '9555' } });
  const cd = clientById('claude-desktop');
  assert.equal(clientStatus(cd, scan(p.after), ctx(9555)).state, 'linked');
  assert.equal(clientStatus(cd, scan(p.after), ctx(9223)).state, 'stale');
  // The app moved (new install path): stale too.
  assert.equal(clientStatus(cd, scan(p.after), ctx(9555, { ...BRIDGE, script: '/new/server.mjs' })).state, 'stale');
  assert.match(planConnect('claude-desktop', scan(null), ctx(9223, { script: BRIDGE.script, node: null })).error, /Node\.js/);
  assert.match(planConnect('claude-desktop', scan(null), ctx(9223, { script: null, node: '/n' })).error, /bridge/);
});

test('Windows paths are written as escaped JSON and TOML strings', () => {
  const win = { script: 'C:\\Program Files\\Oculith Draw\\mcp-stdio\\server.mjs', node: 'C:\\Program Files\\nodejs\\node.exe' };
  const p = planConnect('claude-desktop', scan(null), ctx(9223, win));
  assert.ok(p.after.includes('"C:\\\\Program Files\\\\nodejs\\\\node.exe"'));
  assert.equal(JSON.parse(p.after).mcpServers[SERVER_NAME].args[0], win.script);
  assert.equal(clientStatus(clientById('claude-desktop'), scan(p.after), ctx(9223, win)).state, 'linked');
  // CRLF files stay CRLF.
  const crlf = planConnect('codex', scan('model = "m"\r\n'), ctx());
  assert.equal(crlf.after, 'model = "m"\r\n\r\n[mcp_servers.oculith-draw]\r\nurl = "http://127.0.0.1:9223/mcp"\r\n');
  assert.ok(snippets(ctx(9223, win)).stdio.includes('C:\\\\Program Files'));
});

test('Codex TOML: other tables kept, our table replaced with its sub-tables, foreign forms refused', () => {
  const text = [
    '# Codex settings',
    'model = "gpt-5"',
    '',
    '[mcp_servers.other]',
    'command = "x"',
    '',
    '[mcp_servers."oculith-draw"]',
    'command = "node"',
    'args = ["/old/server.mjs"]',
    '',
    '[mcp_servers."oculith-draw".env]',
    'OPS_MCP_PORT = "9223"',
    '',
    '[profiles.local]',
    'model = "m"',
    '',
  ].join('\n');
  const codex = clientById('codex');
  assert.equal(clientStatus(codex, scan(text), ctx()).state, 'stale');
  const p = planConnect('codex', scan(text), ctx());
  assert.equal(p.after, [
    '# Codex settings', 'model = "gpt-5"', '', '[mcp_servers.other]', 'command = "x"', '',
    '[mcp_servers.oculith-draw]', 'url = "http://127.0.0.1:9223/mcp"', '', '[profiles.local]', 'model = "m"', '',
  ].join('\n'));
  assert.equal(clientStatus(codex, scan(p.after), ctx()).state, 'linked');
  assert.equal(clientStatus(codex, scan(p.after), ctx(9300)).state, 'stale');
  const off = planDisconnect('codex', scan(p.after));
  assert.equal(off.after, ['# Codex settings', 'model = "gpt-5"', '', '[mcp_servers.other]', 'command = "x"', '', '[profiles.local]', 'model = "m"', ''].join('\n'));
  // Disconnect of the only table leaves an empty file (valid TOML).
  const only = planConnect('codex', scan(null), ctx()).after;
  assert.equal(planDisconnect('codex', scan(only)).after, '');
  // Disconnect when not linked changes nothing.
  assert.equal(planDisconnect('codex', scan(text.replace(/\[mcp_servers\."oculith-draw"\][\s\S]*?(?=\[profiles)/, ''))).changed, false);
  // Dotted keys and inline tables are left to the user.
  for (const foreign of [
    'mcp_servers.oculith-draw.url = "u"\n',
    '[mcp_servers]\noculith-draw = { url = "u" }\n',
    'mcp_servers = { oculith-draw = { url = "u" } }\n',
  ]) {
    assert.equal(tomlForeignDefinition(foreign, ['mcp_servers'], SERVER_NAME), true, foreign);
    assert.equal(planConnect('codex', scan(foreign), ctx()).ok, false, foreign);
  }
  // A header-like line inside a multi-line string is not a table.
  const multi = 'notes = """\n[mcp_servers.oculith-draw]\n"""\n';
  assert.equal(tomlTableValues(multi, ['mcp_servers', SERVER_NAME]), null);
});

test('OpenCode: an older entry directly under "mcp" is stale and moved on Repair', () => {
  const text = '{\n  "$schema": "https://opencode.ai/config.json",\n  // local\n  "mcp": {\n    "oculith-draw": { "type": "remote", "url": "http://127.0.0.1:9223/mcp", "enabled": true },\n    "other": { "type": "local", "command": ["x"] }\n  }\n}\n';
  const oc = clientById('opencode');
  assert.equal(clientStatus(oc, scan(text), ctx()).state, 'stale');
  const p = planConnect('opencode', scan(text), ctx());
  assertJson(p.after);
  assert.ok(p.after.includes('// local'));
  assert.equal(jsonGet(p.after, ['mcp'], 'oculith-draw'), undefined);
  assert.deepEqual(jsonGet(p.after, ['mcp'], 'other'), { type: 'local', command: ['x'] });
  assert.equal(clientStatus(oc, scan(p.after), ctx()).state, 'linked');
  const off = planDisconnect('opencode', scan(p.after));
  assertJson(off.after);
  assert.equal(jsonGet(off.after, ['mcp', 'servers'], SERVER_NAME), undefined);
  assert.deepEqual(jsonGet(off.after, ['mcp'], 'other'), { type: 'local', command: ['x'] });
});

test('jsonRemove handles first, middle, last and only members, with trailing commas', () => {
  const base = '{\n  "s": {\n    "a": 1,\n    "b": 2,\n    "c": 3\n  }\n}';
  assert.deepEqual(JSON.parse(jsonRemove(base, ['s'], 'a')).s, { b: 2, c: 3 });
  assert.deepEqual(JSON.parse(jsonRemove(base, ['s'], 'b')).s, { a: 1, c: 3 });
  assert.deepEqual(JSON.parse(jsonRemove(base, ['s'], 'c')).s, { a: 1, b: 2 });
  assert.equal(jsonRemove('{\n  "s": {\n    "a": 1\n  }\n}', ['s'], 'a'), '{\n  "s": {}\n}');
  assertJson(jsonRemove('{ "s": { "a": 1, "b": 2, } }', ['s'], 'b'));
  assert.equal(jsonRemove(base, ['s'], 'zz'), base);
  assert.equal(jsonRemove(base, ['nope'], 'a'), base);
  // A comment between members does not confuse the comma search.
  assert.deepEqual(nodeOf(jsonRemove('{"s": {"a": 1 /* , */, "b": 2}}', ['s'], 'b')), { s: { a: 1 } });
});
const nodeOf = (t) => JSON.parse(t.replace(/\/\*[\s\S]*?\*\//g, ''));

test('CRLF files stay CRLF and one-line members come back out cleanly', () => {
  const crlf = '{\r\n  "mcpServers": {\r\n    "x": {"url": "u"}\r\n  }\r\n}\r\n';
  const p = planConnect('cursor', scan(crlf), ctx());
  assert.doesNotMatch(p.after, /(^|[^\r])\n/);
  assert.equal(planDisconnect('cursor', scan(p.after)).after, crlf);
  const one = '{"mcpServers": {"x": 1} /* end */}';
  assert.equal(planDisconnect('cursor', scan(planConnect('cursor', scan(one), ctx()).after)).after, one);
  // A comment that ends the last line stays on that line.
  assert.ok(planConnect('cursor', scan('{\n  "a": 1 // c\n}\n'), ctx()).after.startsWith('{\n  "a": 1, // c\n  "mcpServers"'));
});

test('jsonSet keeps a BOM and refuses non-object containers', () => {
  assert.ok(jsonSet('\ufeff{}', ['servers'], 'x', 1).startsWith('\ufeff{'));
  assert.throws(() => jsonSet('{"servers": 3}', ['servers'], 'x', 1), /not an object/);
  // A comment-only empty object keeps its comment.
  const t = jsonSet('{\n  "servers": { // none yet\n  }\n}', ['servers'], 'x', 1);
  assert.ok(t.includes('// none yet'));
  assertJson(t);
});

test('the diff shows only the changed lines with context', () => {
  const d = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nd\nX\nf\ng\nh\n', 'f');
  assert.match(d, /^@@ -2,7 \+2,7 @@$/m);
  assert.match(d, /^-e$/m);
  assert.match(d, /^\+X$/m);
  assert.equal(unifiedDiff('same', 'same'), '');
  assert.match(unifiedDiff('', '{}\n'), /^\+\{\}$/m);
});

test('snippets for other clients', () => {
  const s = snippets(ctx(9400));
  assert.equal(s.url, 'http://127.0.0.1:9400/mcp');
  assert.equal(s.claudeCli, 'claude mcp add --transport http --scope user oculith-draw http://127.0.0.1:9400/mcp');
  assert.equal(JSON.parse(s.stdio).mcpServers[SERVER_NAME].env.OPS_MCP_PORT, '9400');
});

test('TOML helpers on a file that starts with a table', () => {
  const t = tomlSetRootKey('[a]\nx = 1\n', 'model', 'm');
  assert.equal(t, 'model = "m"\n\n[a]\nx = 1\n');
  assert.equal(tomlRemoveTable('[a]\nx = 1\n\n[b]\ny = 2\n', ['b']), '[a]\nx = 1\n');
  assert.equal(tomlSetTable('', ['a', 'b'], { k: 'v', n: 2, on: true, list: ['x'] }), '[a.b]\nk = "v"\nn = 2\non = true\nlist = ["x"]\n');
});

test('planEdit: any edit with the same refusals and preview', () => {
  const p = planEdit('opencode', scan('{\n  // c\n}\n'), (t) => jsonSet(t, [], 'theme', 'system'));
  assert.equal(p.ok, true);
  assert.ok(p.after.includes('// c') && p.after.includes('"theme": "system"'));
  assert.match(p.diff, /^\+\s+"theme"/m);
  assert.equal(planEdit('opencode', scan('{', { parseError: 'x' }), (t) => t).ok, false);
  assert.equal(planEdit('cursor', scan('{}', { readOnly: true }), (t) => t).ok, false);
  assert.match(planEdit('codex', scan(''), () => { throw new Error('nope'); }).error, /nope/);
  assert.equal(planEdit('nothing', scan(''), (t) => t).ok, false);
});

test('edition sections: versioned, ordered, replaceable, removable', () => {
  const seen = [];
  const stop = subscribe(() => seen.push(aiConnectionsSections().map((x) => x.id)));
  const load = async () => ({ default: () => null });
  assert.throws(() => registerAiConnectionsSection({ id: 'x', load }, { apiVersion: 99 }), /not supported/);
  assert.throws(() => registerAiConnectionsSection({ id: 'Bad Id', load }, { apiVersion: AI_CONNECTIONS_SECTIONS_API_VERSION }));
  assert.throws(() => registerAiConnectionsSection({ id: 'x' }, { apiVersion: AI_CONNECTIONS_SECTIONS_API_VERSION }));
  const v = { apiVersion: AI_CONNECTIONS_SECTIONS_API_VERSION };
  const offB = registerAiConnectionsSection({ id: 'b', order: 2, load }, v);
  const offA = registerAiConnectionsSection({ id: 'a', order: 1, load }, v);
  assert.deepEqual(aiConnectionsSections().map((x) => x.id), ['a', 'b']);
  const offA2 = registerAiConnectionsSection({ id: 'a', order: 3, load }, v);
  assert.deepEqual(aiConnectionsSections().map((x) => x.id), ['b', 'a']);
  offA(); // the replaced registration no longer removes the new one
  assert.deepEqual(aiConnectionsSections().map((x) => x.id), ['b', 'a']);
  offA2(); offB();
  assert.deepEqual(aiConnectionsSections(), []);
  stop();
  assert.equal(seen.length, 5);
});

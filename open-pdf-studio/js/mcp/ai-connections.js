// AI connections: link AI clients to the app's AI link (MCP) without
// hand-editing their settings files. This module plans every change as text
// (pure, no I/O, unit tested in ai-connections.test.mjs); the native side
// (src-tauri/src/ai_connections.rs) only reads and writes the fixed settings
// file of each client, re-checks that the result parses and keeps a one-time
// backup. The panel is components/dialogs/AiConnectionsDialog.jsx.
//
// Edits are made in the text, not by re-serialising the file: every other
// entry, comment and the indentation stay as they were. A file that does not
// parse is never changed.

/** The name every client lists the app under. */
export const SERVER_NAME = 'oculith-draw';
export const DEFAULT_PORT = 9223;

export const mcpUrl = (port) => `http://127.0.0.1:${Number(port) || DEFAULT_PORT}/mcp`;

/**
 * The clients the panel links. `container` is the JSON object path that
 * holds MCP servers; `table` the TOML table path. `entry(ctx)` is the value
 * written for this app.
 * - stdio: the client starts the bundled bridge (mcp-stdio/server.mjs) with
 *   Node.js; the bridge forwards to the running app on OPS_MCP_PORT.
 * - http: the client talks to the app's endpoint directly.
 */
export const CLIENTS = [
  {
    id: 'claude-desktop', label: 'Claude Desktop', format: 'json', container: ['mcpServers'], transport: 'stdio',
    entry: ({ port, bridge }) => ({
      command: bridge?.node || 'node',
      args: [bridge?.script || '<app>/mcp-stdio/server.mjs'],
      env: { OPS_MCP_PORT: String(Number(port) || DEFAULT_PORT) },
    }),
  },
  {
    id: 'claude-code', label: 'Claude Code', format: 'json', container: ['mcpServers'], transport: 'http',
    entry: ({ port }) => ({ type: 'http', url: mcpUrl(port) }),
  },
  {
    id: 'vscode', label: 'VS Code (GitHub Copilot)', format: 'json', container: ['servers'], transport: 'http',
    entry: ({ port }) => ({ type: 'http', url: mcpUrl(port) }),
  },
  {
    id: 'cursor', label: 'Cursor', format: 'json', container: ['mcpServers'], transport: 'http',
    entry: ({ port }) => ({ url: mcpUrl(port) }),
  },
  {
    id: 'codex', label: 'OpenAI Codex CLI', format: 'toml', table: ['mcp_servers'], transport: 'http',
    entry: ({ port }) => ({ url: mcpUrl(port) }),
  },
  {
    // OpenCode 2 keeps servers under mcp.servers; an older entry directly
    // under "mcp" (deprecated) is recognised, and replaced on Repair.
    id: 'opencode', label: 'OpenCode', format: 'json', container: ['mcp', 'servers'], legacyContainer: ['mcp'], transport: 'http',
    entry: ({ port }) => ({ type: 'remote', url: mcpUrl(port) }),
  },
];

export const clientById = (id) => CLIENTS.find((c) => c.id === id) || null;

// ── JSON with comments: a parser that keeps offsets ─────────────────────────

class ParseError extends Error {
  constructor(message, offset, text) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    super(`${message} at line ${line}, column ${column}`);
    this.offset = offset;
  }
}

/**
 * Parse JSON with comments and trailing commas. Nodes carry `start`/`end`
 * offsets; object members carry `start` (key) and `end` (value end).
 */
export function parseJsonc(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg, at = i) => { throw new ParseError(msg, at, text); };
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
      if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) fail('Unclosed comment');
        i = close + 2; continue;
      }
      return;
    }
  };
  const string = () => {
    const start = i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') fail('Line break in a string');
      i++;
    }
    if (i >= n) fail('Unclosed string', start);
    i++;
    let value;
    try { value = JSON.parse(text.slice(start, i)); } catch { fail('Invalid string', start); }
    return { type: 'string', start, end: i, value };
  };
  const value = () => {
    skip();
    if (i >= n) fail('Unexpected end of file');
    const c = text[i];
    if (c === '{') {
      const start = i++;
      const members = [];
      for (;;) {
        skip();
        if (text[i] === '}') { i++; break; }
        if (text[i] !== '"') fail('Expected a property name');
        const key = string();
        skip();
        if (text[i] !== ':') fail('Expected ":"');
        i++;
        const val = value();
        members.push({ key: key.value, start: key.start, end: val.end, value: val });
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('Expected "," or "}"');
      }
      return { type: 'object', start, end: i, members };
    }
    if (c === '[') {
      const start = i++;
      const items = [];
      for (;;) {
        skip();
        if (text[i] === ']') { i++; break; }
        items.push(value());
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('Expected "," or "]"');
      }
      return { type: 'array', start, end: i, items };
    }
    if (c === '"') return string();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) fail('Unexpected character');
    const start = i;
    i += m[0].length;
    return { type: 'literal', start, end: i, value: JSON.parse(m[0]) };
  };
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  i = bom;
  skip();
  if (i >= n) return { root: null, bom };
  const root = value();
  skip();
  if (i < n) fail('Unexpected content after the end');
  if (root.type !== 'object') throw new ParseError('The file does not hold a JSON object', root.start, text);
  return { root, bom };
}

/** The plain value of a node. */
export function nodeValue(node) {
  if (!node) return undefined;
  if (node.type === 'object') return Object.fromEntries(node.members.map((m) => [m.key, nodeValue(m.value)]));
  if (node.type === 'array') return node.items.map(nodeValue);
  return node.value;
}

const memberOf = (obj, key) => (obj?.type === 'object' ? obj.members.filter((m) => m.key === key).pop() : undefined);

function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
}

/** The indentation unit of a file (default two spaces). */
export function indentUnit(text) {
  const m = /\n([ \t]+)["}\]]/.exec(text);
  return m ? m[1] : '  ';
}

function formatValue(value, unit, baseIndent) {
  return JSON.stringify(value, null, unit).split('\n').join(`\n${baseIndent}`);
}

const maskComments = (s) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const onOwnLine = (text, offset) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset));

/**
 * Set `path` + `key` to `value` in the JSON text, creating the containing
 * objects when needed. Every other byte stays as it was.
 */
export function jsonSet(text, path, key, value) {
  const out = jsonSetLf(text, path, key, value);
  // A file with CRLF line ends throughout keeps them.
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text) ? out.replace(/\r?\n/g, '\r\n') : out;
}

function jsonSetLf(text, path, key, value) {
  const { root } = parseJsonc(text);
  const unit = indentUnit(text);
  if (!root) {
    const built = path.reduceRight((acc, p) => ({ [p]: acc }), { [key]: value });
    const prefix = text.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
    return `${prefix}${JSON.stringify(built, null, unit)}\n`;
  }
  // Walk down; create the first missing level with the rest inside it.
  let obj = root;
  for (let k = 0; k < path.length; k++) {
    const m = memberOf(obj, path[k]);
    if (!m) {
      const rest = path.slice(k + 1).reduceRight((acc, p) => ({ [p]: acc }), { [key]: value });
      return insertMember(text, obj, path[k], rest, unit);
    }
    if (m.value.type !== 'object') {
      throw new Error(`"${path.slice(0, k + 1).join('.')}" is not an object in this file; edit it by hand.`);
    }
    obj = m.value;
  }
  const existing = memberOf(obj, key);
  if (existing) {
    if (sameValue(nodeValue(existing.value), value)) return text;
    const indent = lineIndent(text, existing.start);
    const oneLine = !text.slice(existing.value.start, existing.value.end).includes('\n') && !onOwnLine(text, existing.start);
    const formatted = oneLine ? JSON.stringify(value) : formatValue(value, unit, indent);
    return text.slice(0, existing.value.start) + formatted + text.slice(existing.value.end);
  }
  return insertMember(text, obj, key, value, unit);
}

function insertMember(text, obj, key, value, unit) {
  const last = obj.members[obj.members.length - 1];
  if (last) {
    const indent = onOwnLine(text, last.start) ? lineIndent(text, last.start) : null;
    // A trailing comma after the last member is reused.
    let after = last.end;
    const rest = text.slice(after, obj.end - 1);
    const comma = /^\s*,/.exec(rest.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (s) => ' '.repeat(s.length)));
    if (comma) after += comma[0].length;
    if (indent === null) {
      // Members on one line: keep it on one line.
      const piece = `${comma ? ' ' : ', '}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
      return text.slice(0, after) + piece + text.slice(after);
    }
    const piece = `\n${indent}${JSON.stringify(key)}: ${formatValue(value, unit, indent)}`;
    // After a comment that ends the last member's line, not before it.
    const lineEnd = text.indexOf('\n', after);
    const restOfLine = lineEnd < 0 || lineEnd >= obj.end - 1 ? null : text.slice(after, lineEnd);
    const at = restOfLine !== null && !maskComments(restOfLine).trim() ? lineEnd : after;
    const withComma = comma ? text : `${text.slice(0, last.end)},${text.slice(last.end)}`;
    const shift = comma ? 0 : 1;
    return withComma.slice(0, at + shift) + piece + withComma.slice(at + shift);
  }
  // Empty object: put the member on its own line inside the braces.
  const outer = lineIndent(text, obj.start);
  const indent = outer + unit;
  const inner = text.slice(obj.start + 1, obj.end - 1);
  const keep = inner.trim() ? `${inner.replace(/\s+$/, '')}` : '';
  return `${text.slice(0, obj.start + 1)}${keep}\n${indent}${JSON.stringify(key)}: ${formatValue(value, unit, indent)}\n${outer}}${text.slice(obj.end)}`;
}

/** Remove `path` + `key` from the JSON text (unchanged when absent). */
export function jsonRemove(text, path, key) {
  const { root } = parseJsonc(text);
  let obj = root;
  for (const p of path) {
    const m = memberOf(obj, p);
    if (!m || m.value.type !== 'object') return text;
    obj = m.value;
  }
  const idx = obj?.type === 'object' ? obj.members.map((m) => m.key).lastIndexOf(key) : -1;
  if (idx < 0) return text;
  const member = obj.members[idx];
  const masked = (s) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const next = obj.members[idx + 1];
  const tail = masked(text.slice(member.end, next ? next.start : obj.end - 1));
  const comma = /^\s*,/.exec(tail);
  // Start at the beginning of the member's line when it is on its own line.
  let start = member.start;
  if (onOwnLine(text, start)) start = text.lastIndexOf('\n', start - 1);
  if (comma) {
    return text.slice(0, start) + text.slice(member.end + comma[0].length);
  }
  if (idx > 0) {
    // Last member: drop the comma after the previous member instead.
    const prev = obj.members[idx - 1];
    const between = masked(text.slice(prev.end, member.start));
    const c = between.indexOf(',');
    const from = prev.end + c;
    const gap = text.slice(from + 1, start);
    return text.slice(0, from) + (gap.trim() ? gap : '') + text.slice(member.end);
  }
  // The only member: leave an empty object ("{}" when nothing else is inside).
  const head = text.slice(obj.start + 1, member.start);
  const rest = text.slice(member.end, obj.end - 1);
  if (!head.trim() && !rest.trim()) return text.slice(0, obj.start + 1) + text.slice(obj.end - 1);
  return text.slice(0, start) + text.slice(member.end);
}

/** The plain value at path + key, or undefined. */
export function jsonGet(text, path, key) {
  const { root } = parseJsonc(text);
  let obj = root;
  for (const p of path) {
    const m = memberOf(obj, p);
    if (!m) return undefined;
    obj = m.value;
  }
  return nodeValue(memberOf(obj, key)?.value);
}

// ── TOML: table-level edits ─────────────────────────────────────────────────

/** Split a dotted TOML key into parts ("a."b.c".d" → [a, b.c, d]). */
export function tomlKeyParts(key) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') { cur += key[++i]; }
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '.') { parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/** Lines of a TOML text with the table each belongs to. */
function tomlLines(text) {
  const lines = text.split('\n');
  const out = [];
  let table = [];
  let inMulti = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let header = null;
    if (!inMulti) {
      const m = /^\s*\[(\[?)\s*([^\[\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line.replace(/\r$/, ''));
      if (m) { header = { array: !!m[1], path: tomlKeyParts(m[2]) }; table = header.path; }
    }
    out.push({ index: i, line, header, table, multi: !!inMulti });
    // Track multi-line strings so a "[x]" line inside one is not a header.
    for (const q of ['"""', "'''"]) {
      const count = line.split(q).length - 1;
      if (count % 2 === 1) inMulti = inMulti === q ? null : (inMulti || q);
    }
  }
  return out;
}

const samePath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (a, prefix) => prefix.every((x, i) => a[i] === x);

/** Line range [from, to) of table `path` and its sub-tables, or null. */
export function tomlTableRange(text, path) {
  const lines = tomlLines(text);
  const first = lines.find((l) => l.header && !l.header.array && samePath(l.header.path, path));
  if (!first) return null;
  let to = lines.length;
  for (let i = first.index + 1; i < lines.length; i++) {
    const h = lines[i].header;
    if (h && !startsWith(h.path, path)) { to = i; break; }
  }
  // Leave trailing blank lines to the next table.
  while (to > first.index + 1 && lines[to - 1].line.trim() === '') to--;
  return { from: first.index, to };
}

/** Plain key = value pairs of one table (strings, numbers, booleans only). */
export function tomlTableValues(text, path) {
  const range = tomlTableRange(text, path);
  if (!range) return null;
  const out = {};
  const lines = text.split('\n').slice(range.from + 1, range.to);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break; // a sub-table
    const m = /^\s*([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/^"|"$/g, '');
    try { out[key] = JSON.parse(m[2].replace(/^'(.*)'$/, (_, s) => JSON.stringify(s))); } catch { out[key] = m[2]; }
  }
  return out;
}

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlValue = (v) => (Array.isArray(v) ? `[${v.map(tomlValue).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v));

function tomlBlock(path, values) {
  const head = `[${path.map(tomlKey).join('.')}]`;
  return [head, ...Object.entries(values).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)];
}

/**
 * True when the key `name` of `parent` is written in a form other than its
 * own `[parent.name]` table (a dotted key, an inline table), which this
 * panel does not edit.
 */
export function tomlForeignDefinition(text, parent, name) {
  const lines = tomlLines(text);
  for (const l of lines) {
    if (l.header || l.multi) continue;
    const m = /^\s*([^=#\s][^=]*?)\s*=/.exec(l.line);
    if (!m) continue;
    const full = [...l.table, ...tomlKeyParts(m[1])];
    if (startsWith(full, [...parent, name]) && !startsWith(l.table, [...parent, name])) return true;
    if (samePath(l.table, []) && samePath(tomlKeyParts(m[1]), parent)) return true; // parent = { ... } inline
  }
  return false;
}

/** Write table `path` with `values` (replacing it and its sub-tables). */
export function tomlSetTable(text, path, values) {
  const block = tomlBlock(path, values);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const range = tomlTableRange(text, path);
  if (range) {
    lines.splice(range.from, range.to - range.from, ...block);
    return lines.join(nl);
  }
  let body = text.replace(/\s+$/, '');
  if (!body) return block.join(nl) + nl;
  return body + nl + nl + block.join(nl) + nl;
}

/** Remove table `path` and its sub-tables (unchanged when absent). */
export function tomlRemoveTable(text, path) {
  const range = tomlTableRange(text, path);
  if (!range) return text;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let { from, to } = range;
  // Take one blank line before the table along.
  if (from > 0 && lines[from - 1].trim() === '') from--;
  else if (to < lines.length && lines[to].trim() === '') to++;
  lines.splice(from, to - from);
  return lines.join(nl);
}

/** Set top-level `key = value` (before the first table). */
export function tomlSetRootKey(text, key, value) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const info = tomlLines(text);
  const firstHeader = info.find((l) => l.header);
  const end = firstHeader ? firstHeader.index : lines.length;
  const re = new RegExp(`^\\s*${key.replace(/[-]/g, '\\-')}\\s*=`);
  const line = `${tomlKey(key)} = ${tomlValue(value)}`;
  for (let i = 0; i < end; i++) {
    if (!info[i].multi && re.test(lines[i])) { lines[i] = line; return lines.join(nl); }
  }
  let at = end;
  while (at > 0 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, line);
  if (at === 0 && firstHeader) lines.splice(1, 0, '');
  return lines.join(nl);
}

// ── Diff ────────────────────────────────────────────────────────────────────

/** A unified diff of two texts (3 lines of context). Empty when equal. */
export function unifiedDiff(before, after, name = 'settings') {
  if (before === after) return '';
  const a = before ? before.replace(/\r\n/g, '\n').split('\n') : [];
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  let ops = [];
  if (am.length * bm.length <= 4_000_000) {
    // LCS on the changed middle.
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) { ops.push([' ', am[i]]); i++; j++; }
      else if (j < bm.length && (i >= am.length || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { ops.push(['+', bm[j]]); j++; }
      else { ops.push(['-', am[i]]); i++; }
    }
  } else {
    ops = [...am.map((l) => ['-', l]), ...bm.map((l) => ['+', l])];
  }
  const ctxBefore = a.slice(Math.max(0, pre - 3), pre).map((l) => [' ', l]);
  const ctxAfter = a.slice(a.length - suf, a.length - suf + 3).map((l) => [' ', l]);
  const all = [...ctxBefore, ...ops, ...ctxAfter];
  const startA = pre - ctxBefore.length + 1;
  const countA = all.filter(([k]) => k !== '+').length;
  const countB = all.filter(([k]) => k !== '-').length;
  return [`--- ${name}`, `+++ ${name}`, `@@ -${a.length ? startA : 0},${countA} +${startA},${countB} @@`, ...all.map(([k, l]) => k + l)].join('\n');
}

// ── Status and plans ────────────────────────────────────────────────────────

/** Read the current entry of this app from a scanned client. */
export function readEntry(client, text) {
  if (client.format === 'toml') {
    const values = tomlTableValues(text, [...client.table, SERVER_NAME]);
    return { entry: values || undefined, legacy: false };
  }
  const entry = jsonGet(text, client.container, SERVER_NAME);
  if (entry !== undefined) return { entry, legacy: false };
  if (client.legacyContainer) {
    const old = jsonGet(text, client.legacyContainer, SERVER_NAME);
    if (old && typeof old === 'object' && !Array.isArray(old)) return { entry: old, legacy: true };
  }
  return { entry: undefined, legacy: false };
}

function entryMatches(client, entry, ctx) {
  const want = client.entry(ctx);
  if (!entry || typeof entry !== 'object') return false;
  if (client.transport === 'stdio') {
    const port = entry.env?.OPS_MCP_PORT ?? entry.env?.MCP_PORT ?? String(DEFAULT_PORT);
    if (String(port) !== want.env.OPS_MCP_PORT) return false;
    if (ctx.bridge?.script) {
      const script = Array.isArray(entry.args) ? entry.args[entry.args.length - 1] : null;
      return script === ctx.bridge.script;
    }
    return true;
  }
  return entry.url === want.url && (want.type === undefined || entry.type === want.type);
}

/**
 * The state of one client for the panel:
 * { state: 'error' | 'unlinked' | 'linked' | 'stale', message?, entry? }.
 * 'stale': our entry is there but points at another port (or bridge path),
 * so Repair is offered.
 */
export function clientStatus(client, scan, ctx) {
  const file = scan?.file || {};
  if (file.error) return { state: 'error', message: file.error };
  if (file.parseError) return { state: 'error', message: file.parseError };
  if (!file.exists || !file.text?.trim()) return { state: 'unlinked' };
  let read;
  try { read = readEntry(client, file.text); } catch (e) { return { state: 'error', message: e.message }; }
  if (read.entry === undefined) return { state: 'unlinked' };
  if (read.legacy) return { state: 'stale', entry: read.entry, legacy: true };
  return { state: entryMatches(client, read.entry, ctx) ? 'linked' : 'stale', entry: read.entry };
}

function baseText(scan) {
  return scan?.file?.exists ? (scan.file.text ?? '') : '';
}

function guard(scan) {
  const file = scan?.file || {};
  if (file.error) return `The settings file cannot be read: ${file.error}`;
  if (file.parseError) return `The settings file does not parse, so it is left as it is. Fix it first: ${file.parseError}`;
  if (file.readOnly) return 'The settings file is read-only.';
  return null;
}

function plan(client, scan, after) {
  const before = baseText(scan);
  return {
    ok: true,
    client: client.id,
    path: scan.path,
    before,
    expected: scan.file?.exists ? before : null,
    after,
    changed: after !== before,
    diff: unifiedDiff(before, after, scan.path),
  };
}

/** Plan Connect (and Repair): write this app's entry. */
export function planConnect(clientId, scan, ctx) {
  const client = clientById(clientId);
  if (!client) return { ok: false, error: `Unknown client ${clientId}` };
  const refused = guard(scan);
  if (refused) return { ok: false, error: refused };
  if (client.transport === 'stdio') {
    if (!ctx.bridge?.script) return { ok: false, error: 'The bundled bridge (mcp-stdio/server.mjs) was not found in this installation.' };
    if (!ctx.bridge?.node) return { ok: false, error: 'Node.js 18 or later is needed on PATH for this client. Install it, then press Connect again.' };
  }
  const entry = client.entry(ctx);
  const before = baseText(scan);
  try {
    let after;
    if (client.format === 'toml') {
      if (tomlForeignDefinition(before, client.table, SERVER_NAME)) {
        return { ok: false, error: `"${SERVER_NAME}" is written in a form this panel does not edit. Change it by hand.` };
      }
      after = tomlSetTable(before, [...client.table, SERVER_NAME], entry);
    } else {
      after = before;
      if (client.legacyContainer && readEntry(client, before).legacy) after = jsonRemove(after, client.legacyContainer, SERVER_NAME);
      after = jsonSet(after, client.container, SERVER_NAME, entry);
    }
    return plan(client, scan, after);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Plan Disconnect: remove only this app's entry. */
export function planDisconnect(clientId, scan) {
  const client = clientById(clientId);
  if (!client) return { ok: false, error: `Unknown client ${clientId}` };
  const refused = guard(scan);
  if (refused) return { ok: false, error: refused };
  const before = baseText(scan);
  try {
    let after;
    if (client.format === 'toml') {
      if (tomlForeignDefinition(before, client.table, SERVER_NAME)) {
        return { ok: false, error: `"${SERVER_NAME}" is written in a form this panel does not edit. Change it by hand.` };
      }
      after = tomlRemoveTable(before, [...client.table, SERVER_NAME]);
    } else {
      after = jsonRemove(before, client.container, SERVER_NAME);
      if (client.legacyContainer) after = jsonRemove(after, client.legacyContainer, SERVER_NAME);
    }
    return plan(client, scan, after);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Copyable settings for a client the panel does not list. */
export function snippets(ctx) {
  const url = mcpUrl(ctx.port);
  const bridge = ctx.bridge?.script || '<app>/mcp-stdio/server.mjs';
  return {
    url,
    http: JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url } } }, null, 2),
    stdio: JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 'node', args: [bridge], env: { OPS_MCP_PORT: String(Number(ctx.port) || DEFAULT_PORT) } } } }, null, 2),
    claudeCli: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`,
    codexCli: `codex mcp add ${SERVER_NAME} --url ${url}`,
  };
}

/**
 * Plan any other change to a client's settings file (an edition's own
 * section of the panel uses this): `edit(text)` returns the new text or
 * throws with the reason. The same refusals and preview as Connect apply.
 */
export function planEdit(clientId, scan, edit) {
  const client = clientById(clientId);
  if (!client) return { ok: false, error: `Unknown client ${clientId}` };
  const refused = guard(scan);
  if (refused) return { ok: false, error: refused };
  try {
    return plan(client, scan, edit(baseText(scan)));
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

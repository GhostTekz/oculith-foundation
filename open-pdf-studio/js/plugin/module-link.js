// An edition plug-in may be split into several module files: plugin.js and
// the `chunks/*.js` files it imports (statically, or with import() for a
// feature it loads on first use). A release serves them as files beside
// plugin.js, so their relative imports simply work. When the shell hands
// over the program text instead (a development build, or the fallback after
// a served file failed to load), this module links the texts in memory:
// each file becomes a Blob URL, its static imports of the others point at
// their Blob URLs, and its import() of another file asks linkedModule() for
// that file's URL when it runs. Only quoted relative specifiers that name a
// file of the same plug-in are changed.

const links = new Map(); // link id -> Map(file name -> Blob URL)
const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
let nextLink = 0;

const SPECIFIER = /(["'])(\.\.?\/[^"'\s\\]+\.js)\1/g;
const DYNAMIC = /\bimport\s*\(\s*$/;

/** The file name `specifier` names, seen from the file `from` (both relative to the plug-in). */
export function resolveModuleName(from, specifier) {
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** Each file's references to other files of the program: `{ index, length, target, dynamic }`. */
function references(name, text, names) {
  const found = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const target = resolveModuleName(name, match[2]);
    if (!target || target === name || !names.has(target)) continue;
    const dynamic = DYNAMIC.test(text.slice(Math.max(0, match.index - 16), match.index));
    found.push({ index: match.index, length: match[0].length, target, dynamic });
  }
  return found;
}

/** Order the files so that each comes after the files it imports statically. */
function staticOrder(files) {
  const order = [];
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') throw new Error(`The plug-in's module files import each other in a cycle (${[...path, name].join(' > ')}).`);
    state.set(name, 'open');
    for (const ref of files.get(name).refs) if (!ref.dynamic) visit(ref.target, [...path, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of files.keys()) visit(name, []);
  return order;
}

/**
 * Link `entry` (the text of plugin.js) and `modules` ({ 'chunks/x.js': text })
 * and return the Blob URL to import the entry from. The URLs stay valid for
 * the session: a feature's file may be imported long after start-up.
 * `createUrl` makes the URL of a linked text (tests use data: URLs).
 */
export function linkModules(entry, modules = {}, { createUrl = blobUrl } = {}) {
  const files = new Map([['plugin.js', { text: String(entry) }]]);
  for (const [name, text] of Object.entries(modules || {})) {
    if (typeof name !== 'string' || !/^chunks\/[A-Za-z0-9_.-]+\.js$/.test(name) || typeof text !== 'string') {
      throw new Error(`Invalid plug-in module file: ${String(name)}`);
    }
    files.set(name, { text });
  }
  const names = new Set(files.keys());
  for (const [name, file] of files) file.refs = references(name, file.text, names);
  const id = String(nextLink++);
  const urls = new Map();
  links.set(id, urls);
  for (const name of staticOrder(files)) {
    const { text, refs } = files.get(name);
    let out = '';
    let at = 0;
    for (const ref of refs) {
      out += text.slice(at, ref.index);
      out += ref.dynamic
        ? `globalThis.__ocudrawHost.linkedModule(${JSON.stringify(id)}, ${JSON.stringify(ref.target)})`
        : JSON.stringify(urls.get(ref.target));
      at = ref.index + ref.length;
    }
    out += text.slice(at);
    urls.set(name, createUrl(out));
  }
  return urls.get('plugin.js');
}

/** The Blob URL of file `name` of link `id` (for a linked import()). */
export function linkedModule(id, name) {
  const url = links.get(String(id))?.get(String(name));
  if (!url) throw new Error(`Unknown plug-in module file: ${String(name)}`);
  return url;
}

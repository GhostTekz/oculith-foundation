// Load hooks for behaviour tests of loader.js's page reads under node.
//
// loader.js imports half the app (renderer, tabs, dialogs, pdf.js). These
// hooks keep the modules the page reads run on (the state store, the page
// annotation cache, solid-js/store, timing helpers) and replace every other
// module loader.js imports with a stub whose named exports do nothing.
// Register app-test-hooks.mjs first, then these.

import { readFileSync } from 'node:fs';

const LOADER = new URL('./loader.js', import.meta.url).href;
const KEEP = [
  '../core/state.js', '../core/perf.js', '../core/yield-to-main.js', 'solid-js/store',
  './page-annotations.js', './pdfjs-idle-cleanup.js', './large-open.js',
];

// The names loader.js imports from each module, static and dynamic.
const names = new Map();
const source = readFileSync(new URL(LOADER), 'utf8');
const add = (from, list) => {
  const set = names.get(from) || new Set();
  for (const part of list.split(',')) {
    const name = part.trim().split(/\s+as\s+|\s*:\s*/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
  }
  names.set(from, set);
};
for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) add(m[2], m[1]);
for (const m of source.matchAll(/\{([^}]*)\}\s*=\s*await import\('([^']+)'\)/g)) add(m[2], m[1]);

const stub = (from) => {
  const lines = [...(names.get(from) || [])].map((n) => `export const ${n} = () => undefined;`);
  lines.push('export default { t: (key) => key };');
  if (from === 'pdfjs-dist') lines.push('export const GlobalWorkerOptions = {};');
  return `data:text/javascript,${encodeURIComponent(lines.join('\n'))}`;
};

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === LOADER && !KEEP.includes(specifier)) {
    return { url: stub(specifier), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

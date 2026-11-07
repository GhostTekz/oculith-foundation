import assert from 'node:assert/strict';
import test from 'node:test';
import { linkModules, linkedModule, resolveModuleName } from './module-link.js';

const dataUrl = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
globalThis.__ocudrawHost = { linkedModule };

test('relative specifiers resolve inside the plug-in directory only', () => {
  assert.equal(resolveModuleName('plugin.js', './chunks/a-1.js'), 'chunks/a-1.js');
  assert.equal(resolveModuleName('chunks/a-1.js', '../plugin.js'), 'plugin.js');
  assert.equal(resolveModuleName('chunks/a-1.js', './b-2.js'), 'chunks/b-2.js');
  assert.equal(resolveModuleName('plugin.js', '../outside.js'), null);
});

test('a split program loaded from its text links static and dynamic imports between its files', async () => {
  // As a bundler writes it: the entry loads a feature on first use; the
  // feature imports the entry and a shared file; the shared file is also
  // imported by the entry. Other strings are left alone.
  const entry = `import{shared as s}from"./chunks/shared-b2.js";export const base=40;
export const label="./chunks/not-a-file.js";
export async function feature(){const m=await import("./chunks/panel-a1.js");return m.value()+s;}`;
  const modules = {
    'chunks/panel-a1.js': `import{base as b}from"../plugin.js";import{shared as s}from'./shared-b2.js';export const value=()=>b+s;`,
    'chunks/shared-b2.js': 'export const shared=1;',
  };
  const texts = [];
  const url = linkModules(entry, modules, { createUrl: (text) => { texts.push(text); return dataUrl(text); } });
  assert.equal(texts.length, 3);
  assert.ok(texts.every((text) => !text.includes('"./chunks/panel-a1.js"') && !text.includes('"../plugin.js"')));
  assert.ok(texts.some((text) => text.includes('"./chunks/not-a-file.js"')), 'a string that names no file stays');
  const program = await import(url);
  assert.equal(program.label, './chunks/not-a-file.js');
  assert.equal(await program.feature(), 42);
});

test('a static import cycle between the files and malformed file names are refused', () => {
  assert.throws(() => linkModules('import"./chunks/a-1.js";', {
    'chunks/a-1.js': 'import"../plugin.js";',
  }, { createUrl: dataUrl }), /cycle/);
  assert.throws(() => linkModules('', { 'bin/helper.js': '' }, { createUrl: dataUrl }), /Invalid/);
  assert.throws(() => linkModules('', { 'chunks/../x.js': '' }, { createUrl: dataUrl }), /Invalid/);
  assert.throws(() => linkedModule('nope', 'chunks/a-1.js'), /Unknown/);
});

test('a single-file program is one URL', async () => {
  const url = linkModules('export const one = 1;', {}, { createUrl: dataUrl });
  assert.equal((await import(url)).one, 1);
});

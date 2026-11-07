import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Set Scale strings: English and Dutch carry the same keys, none empty, and
// every key the dialog uses exists. Other locales fall back to English.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const block = (locale) => JSON.parse(read(`../i18n/locales/${locale}/dialogs.json`)).setScale;

function flat(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
}

test('en and nl have the same Set Scale keys, none empty, nl translated', () => {
  const en = Object.fromEntries(flat(block('en')));
  const nl = Object.fromEntries(flat(block('nl')));
  assert.deepEqual(Object.keys(nl).sort(), Object.keys(en).sort());
  for (const [key, text] of Object.entries(nl)) {
    assert.ok(typeof text === 'string' && text.trim(), `nl setScale.${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].trim(), `en setScale.${key}`);
  }
  assert.notEqual(nl.title, en.title);
  assert.match(en.currentPage, /\{\{page\}\}/u);
  assert.match(nl.currentPage, /\{\{page\}\}/u);
  assert.match(nl['range.outOfRange'], /\{\{count\}\}/u);
});

test('every Set Scale key used in the code exists', () => {
  const en = Object.fromEntries(flat(block('en')));
  const sources = ['../solid/components/dialogs/SetScaleDialog.jsx', '../solid/components/dialogs/ScaleEquationEditor.jsx']
    .map(read).join('\n');
  const used = new Set([...sources.matchAll(/'setScale\.([\w.]+)'/gu)].map(m => m[1]));
  // Error keys come from set-scale-form.js.
  for (const key of ['invalidEquation', 'range.empty', 'range.syntax', 'range.outOfRange']) used.add(key);
  assert.ok(used.size > 20);
  for (const key of used) assert.ok(key in en, `setScale.${key}`);
});

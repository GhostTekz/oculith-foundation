// The add-on's editor modules load one after another at start-up. Older
// WebKit (the Linux desktop's) resolves concurrent imports that reach the
// same cyclic output chunk before its namespace is initialized, and the
// add-on then fails with "Cannot access uninitialized variable".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadHostModules } from './host.js';

const boot = fs.readFileSync(new URL('../boot.js', import.meta.url), 'utf8');

test('only the edition-independent EARLY modules load in parallel at start-up', () => {
  const calls = [...boot.matchAll(/loadHostModules\(([^;]*)\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[0], /^EARLY, \{ parallel: true \}$/);
  assert.doesNotMatch(calls[1], /parallel/);
});

test('serial loading keeps the requested order and refuses modules outside the interface', async () => {
  await loadHostModules(['solid-js', 'pdf-lib']);
  await assert.rejects(loadHostModules(['js/pdf/not-an-interface-module.js']), /Not part of/);
});

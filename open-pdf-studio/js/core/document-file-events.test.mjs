import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyDocumentFileChanged, onDocumentFileChanged, writeDocumentFile } from './document-file-events.js';

test('a disk write publishes synchronously only after the physical writer succeeds', async () => {
  const events = [];
  const off = onDocumentFileChanged(event => events.push(event));
  try {
    let finish;
    const write = writeDocumentFile({ documentId: 'doc-1', path: '/synthetic/plan.pdf' },
      () => new Promise(resolve => { finish = resolve; }));
    assert.deepEqual(events, []);
    finish('written');
    assert.equal(await write, 'written');
    assert.deepEqual(events, [{ documentId: 'doc-1', path: '/synthetic/plan.pdf', reason: 'saved' }]);
    assert.equal(Object.isFrozen(events[0]), true);
  } finally { off(); }
});

test('failed writes and invalid events leave consumers untouched', async () => {
  const events = [];
  const off = onDocumentFileChanged(event => events.push(event));
  try {
    await assert.rejects(writeDocumentFile({ path: '/synthetic/plan.pdf' }, async () => { throw Error('Disk full'); }), /Disk full/);
    notifyDocumentFileChanged({ path: '', reason: 'loaded' });
    notifyDocumentFileChanged({ path: '/synthetic/plan.pdf', reason: 'saving' });
    assert.deepEqual(events, []);
  } finally { off(); }
});

test('a loaded event names its own background document and subscriptions can be removed', () => {
  const events = [];
  const off = onDocumentFileChanged(event => events.push(event));
  notifyDocumentFileChanged({ documentId: 'background-doc', path: '/synthetic/background.pdf', reason: 'loaded' });
  off();
  notifyDocumentFileChanged({ path: '/synthetic/another.pdf', reason: 'loaded' });
  assert.deepEqual(events, [{ documentId: 'background-doc', path: '/synthetic/background.pdf', reason: 'loaded' }]);
});

test('a failing listener cannot prevent another cache from observing a written file', async () => {
  const warnings = [];
  const prior = console.warn;
  console.warn = (...args) => warnings.push(args);
  const bad = onDocumentFileChanged(() => { throw Error('Consumer failed'); });
  const events = [];
  const good = onDocumentFileChanged(event => events.push(event));
  try {
    assert.equal(await writeDocumentFile({ path: '/synthetic/plan.pdf' }, async () => true), true);
    assert.equal(events.length, 1);
    assert.equal(warnings.length, 1);
  } finally { bad(); good(); console.warn = prior; }
});

test('browser downloads without a disk source do not notify source caches', async () => {
  const events = [];
  const off = onDocumentFileChanged(event => events.push(event));
  try {
    assert.equal(await writeDocumentFile(null, async () => 'downloaded'), 'downloaded');
    assert.deepEqual(events, []);
  } finally { off(); }
});

test('async observer failures are contained without delaying other observers', async () => {
  const warnings = [];
  const prior = console.warn;
  console.warn = (...args) => warnings.push(args);
  const bad = onDocumentFileChanged(async () => { throw Error('Async consumer failed'); });
  const events = [];
  const good = onDocumentFileChanged(event => events.push(event));
  try {
    notifyDocumentFileChanged({ path: '/synthetic/plan.pdf', reason: 'loaded' });
    assert.equal(events.length, 1);
    await Promise.resolve();
    assert.equal(warnings.length, 1);
  } finally { bad(); good(); console.warn = prior; }
});

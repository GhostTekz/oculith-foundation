import assert from 'node:assert/strict';
import test from 'node:test';
import { runBatch, batchFileList, setFilePaths, writeBatchOutputs, joinOutputPath } from './runner.js';

const job = (seen = []) => ({
  processFile: async (file) => {
    seen.push(file.name);
    if (file.name.startsWith('bad')) throw new Error(`cannot read ${file.name}`);
    return file.bytes.length;
  },
  describe: (n) => `${n} bytes`,
  finish: async (successes) => successes.map((s) => s.result),
});
const files = batchFileList(['C:/a/one.pdf', 'C:/a/bad.pdf', 'C:/a/two.pdf']);
const read = async (path) => (path.includes('missing') ? null : new TextEncoder().encode(path));

test('file lists drop duplicates and non-PDFs; a set gives its unique source files', () => {
  assert.deepEqual(batchFileList(['C:\\x\\A.pdf', 'c:/x/a.PDF', 'notes.txt', '', 'b.pdf']).map((f) => f.name), ['A.pdf', 'b.pdf']);
  assert.deepEqual(setFilePaths({ sheets: [{ filePath: '/s/one.pdf', page: 1 }, { filePath: '/s/one.pdf', page: 2 }, { filePath: '/s/two.pdf', page: 1 }] }),
    ['/s/one.pdf', '/s/two.pdf']);
});

test('a failing file is logged and the run continues in order', async () => {
  const seen = [];
  const result = await runBatch({ files, readFile: read, job: job(seen) });
  assert.deepEqual(seen, ['one.pdf', 'bad.pdf', 'two.pdf']);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.log.map((e) => [e.name, e.ok, e.ok ? e.detail : e.error]),
    [['one.pdf', true, '12 bytes'], ['bad.pdf', false, 'cannot read bad.pdf'], ['two.pdf', true, '12 bytes']]);
  assert.deepEqual(result.output, [12, 12]);
});

test('an unreadable file is a failure, not a crash', async () => {
  const result = await runBatch({ files: batchFileList(['missing.pdf']), readFile: read, job: job() });
  assert.equal(result.log[0].ok, false);
  assert.match(result.log[0].error, /could not be read/u);
});

test('cancel stops before the next file and skips finish', async () => {
  const controller = new AbortController();
  const seen = [];
  const j = job(seen);
  let finished = false;
  j.finish = async () => { finished = true; };
  const result = await runBatch({ files, readFile: read, job: j, signal: controller.signal,
    onProgress: (p) => { if (p.phase === 'done') controller.abort(); } });
  assert.equal(result.cancelled, true);
  assert.equal(result.output, null);
  assert.equal(finished, false);
  assert.deepEqual(seen, ['one.pdf']);
});

test('cancel during finish discards the output', async () => {
  const controller = new AbortController();
  const j = job();
  j.finish = async () => { controller.abort(); return ['late']; };
  const result = await runBatch({ files, readFile: read, job: j, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.output, null);
});

test('outputs never land on a source or an existing file', async () => {
  assert.equal(joinOutputPath('C:\\out', 'x.csv'), 'C:\\out\\x.csv');
  assert.equal(joinOutputPath('/out/', 'x.csv'), '/out/x.csv');
  const writes = [];
  const written = await writeBatchOutputs([{ name: 'set.pdf', bytes: new Uint8Array(1) }, { name: 'sum.csv', bytes: new Uint8Array(2) }], {
    dir: '/proj', sources: ['/proj/set.pdf'], exists: async (p) => p === '/proj/sum.csv',
    write: async (p, b) => writes.push([p, b.length]) });
  assert.deepEqual(written, ['/proj/set (2).pdf', '/proj/sum (2).csv']);
  assert.deepEqual(writes, [['/proj/set (2).pdf', 1], ['/proj/sum (2).csv', 2]]);
});

test('an export named beside its drawing keeps the drawing folder and separator', async () => {
  const { directoryOf } = await import('../pdf/remote-link.js');
  const beside = (pdf) => joinOutputPath(directoryOf(pdf), 'E-101-markups.csv');
  assert.equal(beside('C:\\Jobs\\Barn\\E-101.pdf'), 'C:\\Jobs\\Barn\\E-101-markups.csv');
  assert.equal(beside('\\\\server\\jobs\\E-101.pdf'), '\\\\server\\jobs\\E-101-markups.csv');
  assert.equal(beside('/jobs/barn/E-101.pdf'), '/jobs/barn/E-101-markups.csv');
  assert.equal(beside('E-101.pdf'), 'E-101-markups.csv');
});

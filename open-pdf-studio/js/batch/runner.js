// Generic batch runner (the external editor Batch menu, docs/reference/editor/sets-and-batch.md): one job runs
// over a list of PDFs, one file at a time, with progress, cancel and a
// per-file log. The runner only READS the sources. A job returns its output
// as data ({ name, bytes } items); writeBatchOutputs() writes them afterwards
// and refuses any path that is one of the sources. A cancelled run returns no
// output, so nothing is written.
//
// No UI and no platform imports: the dialog passes readFile/write functions,
// so node tests run the same code on real PDF bytes.

/** A thrown abort, recognisable after any await. */
export class BatchCancelledError extends Error {
  constructor() {
    super('Batch run cancelled.');
    this.name = 'BatchCancelledError';
  }
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new BatchCancelledError();
}

const pathKey = (path) => String(path ?? '').replace(/\\/g, '/').toLocaleLowerCase();

/** The display name of a path or browser file name. */
export function batchFileName(path) {
  const parts = String(path ?? '').split(/[\\/]/u);
  return parts[parts.length - 1] || String(path ?? '');
}

/**
 * Paths → [{ path, name }] without duplicates (case-insensitive, either slash),
 * keeping the first occurrence's order. Non-PDF and empty entries are dropped.
 */
export function batchFileList(paths) {
  const seen = new Set();
  const files = [];
  for (const raw of paths || []) {
    const path = typeof raw === 'string' ? raw : raw?.path;
    if (!path || !/\.pdf$/iu.test(path)) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ path, name: batchFileName(path) });
  }
  return files;
}

/** The unique source PDFs of a drawing set (sheet register), in sheet order. */
export function setFilePaths(register) {
  return batchFileList((register?.sheets || []).map((sheet) => sheet.filePath)).map((file) => file.path);
}

/**
 * Run `job` over `files` in order.
 *  - readFile(path) → bytes (Uint8Array/ArrayBuffer); null/empty is a failure.
 *  - job.processFile({ path, name, bytes }, { signal, index }) → result;
 *    a throw marks that file failed and the run continues.
 *  - job.describe?.(result) → short log text for a success.
 *  - job.finish(successes, { log, signal }) → output (any value), called only
 *    when the run was not cancelled.
 *  - onProgress({ phase: 'file' | 'done' | 'finish', index, total, file, entry })
 *  - signal: an AbortSignal; checked before and after every await.
 * Returns { cancelled, log: [{ path, name, ok, detail?, error? }], output }.
 */
export async function runBatch({ files, readFile, job, onProgress = () => {}, signal } = {}) {
  if (typeof readFile !== 'function') throw new Error('runBatch needs readFile.');
  if (typeof job?.processFile !== 'function' || typeof job?.finish !== 'function') {
    throw new Error('runBatch needs a job with processFile and finish.');
  }
  const list = files || [];
  const log = [];
  const successes = [];
  const cancelled = () => ({ cancelled: true, log, output: null });
  try {
    for (let index = 0; index < list.length; index++) {
      throwIfCancelled(signal);
      const file = list[index];
      onProgress({ phase: 'file', index, total: list.length, file });
      let entry;
      try {
        const raw = await readFile(file.path);
        throwIfCancelled(signal);
        if (!raw || !raw.byteLength) throw new Error('The file is empty or could not be read.');
        // The job gets its own copy; PDF.js may transfer (detach) a buffer.
        const bytes = new Uint8Array(raw instanceof Uint8Array ? raw : new Uint8Array(raw)).slice();
        const result = await job.processFile({ ...file, bytes }, { signal, index });
        throwIfCancelled(signal);
        successes.push({ file, result });
        entry = { path: file.path, name: file.name, ok: true, detail: job.describe?.(result) ?? '' };
      } catch (error) {
        if (error instanceof BatchCancelledError || signal?.aborted) throw new BatchCancelledError();
        entry = { path: file.path, name: file.name, ok: false, error: error?.message || String(error) };
      }
      log.push(entry);
      onProgress({ phase: 'done', index, total: list.length, file, entry });
    }
    throwIfCancelled(signal);
    onProgress({ phase: 'finish', index: list.length, total: list.length });
    const output = await job.finish(successes, { log, signal });
    throwIfCancelled(signal);
    return { cancelled: false, log, output };
  } catch (error) {
    if (error instanceof BatchCancelledError) return cancelled();
    throw error;
  }
}

/** `dir` + `name` with the separator `dir` already uses. */
export function joinOutputPath(dir, name) {
  if (!dir) return name;
  const sep = /\\/u.test(dir) && !/\//u.test(dir) ? '\\' : '/';
  return /[\\/]$/u.test(dir) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * Write a finished run's outputs ([{ name, bytes }]) into `dir` (or by bare
 * name, the browser's download). A name that would land on a source path, or
 * on an existing file, gets " (2)", " (3)", … appended before the extension.
 * Every byte array is complete before the first write, so a run either writes
 * all its outputs or reports the write error.
 */
export async function writeBatchOutputs(outputs, { dir = '', sources = [], write, exists = async () => false } = {}) {
  if (typeof write !== 'function') throw new Error('writeBatchOutputs needs write.');
  const taken = new Set((sources || []).map((s) => pathKey(typeof s === 'string' ? s : s?.path)));
  const written = [];
  for (const output of outputs || []) {
    const dot = output.name.lastIndexOf('.');
    const stem = dot > 0 ? output.name.slice(0, dot) : output.name;
    const ext = dot > 0 ? output.name.slice(dot) : '';
    let path = joinOutputPath(dir, output.name);
    for (let n = 2; taken.has(pathKey(path)) || (dir && await exists(path)); n++) {
      path = joinOutputPath(dir, `${stem} (${n})${ext}`);
    }
    taken.add(pathKey(path));
    await write(path, output.bytes);
    written.push(path);
  }
  return written;
}

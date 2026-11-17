// The files the open tabs stand for, for the in-place batch guard
// (batch-ops-job.js openPaths). After a page edit a tab shows a working copy
// (filePath) and saves to the real file (saveTargetPath); both count as open.

/**
 * @param {Array<{filePath?:string|null, saveTargetPath?:string|null}>} documents
 * @returns {string[]}
 */
export function openDocumentPaths(documents) {
  const paths = [];
  for (const d of documents || []) {
    for (const p of [d?.filePath, d?.saveTargetPath]) {
      if (typeof p === 'string' && p && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

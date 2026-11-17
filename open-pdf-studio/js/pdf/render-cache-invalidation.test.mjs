// Closing a tab forgets the rendered pixels of its file, as a save of that
// path does: tiles, continuous-view bitmaps, page bitmaps and previews carry
// no revision of the file in their keys, so a file reissued under the same
// name would otherwise reopen with the old tiles.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('./page-manager-test-hooks.mjs', import.meta.url);
const { clearRenderCachesForPath } = await import('./render-cache-invalidation.js?real');
const { geefDocumentVrij } = await import('./document-release.js');

function recordingModules(calls) {
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    bitmaps: { invalidateDocumentBitmaps: rec('bitmaps') },
    tiles: { tileCacheClearForFile: rec('tiles') },
    progressive: { cancelProgressiveRenderForFile: rec('progressive') },
    orchestrator: { cancelBitmapRendersForFile: rec('orchestrator') },
    renderer: { clearBitmapJSCacheForFile: rec('continuous'), clearLowResCache: rec('previews') },
  };
}

test('one helper clears every render cache of a path', () => {
  const calls = [];
  clearRenderCachesForPath('C:/set/a.pdf', recordingModules(calls));
  assert.deepEqual(calls, [
    ['bitmaps', 'C:/set/a.pdf'], ['tiles', 'C:/set/a.pdf'], ['progressive', 'C:/set/a.pdf'],
    ['orchestrator', 'C:/set/a.pdf'], ['continuous', 'C:/set/a.pdf'], ['previews'],
  ]);
  const none = [];
  clearRenderCachesForPath('', recordingModules(none));
  assert.deepEqual(none, []);
});

test('closing the last tab on a file clears its render caches; a second tab on it keeps them', async () => {
  const cleared = [];
  globalThis.__pmTest = { impl: { invalidateRenderCachesForPath: (path) => { cleared.push(path); } } };
  try {
    await geefDocumentVrij({ id: 'a', filePath: 'C:/set/a.pdf' }, [{ id: 'b', filePath: 'C:/set/b.pdf' }]);
    assert.deepEqual(cleared, ['C:/set/a.pdf']);
    cleared.length = 0;
    await geefDocumentVrij({ id: 'c', filePath: 'C:/set/b.pdf' }, [{ id: 'b', filePath: 'C:/set/b.pdf' }]);
    assert.deepEqual(cleared, []);
  } finally {
    delete globalThis.__pmTest;
  }
});

// The OCR assets' sources: the pinned URL first, then the same file from
// GitHub's raw host and a public mirror (the bytes are checked against the
// pinned hash whichever answers).
import assert from 'node:assert/strict';
import test from 'node:test';
import { OCR_RUNTIME_ASSETS, assetSources } from './ocr-runtime.mjs';

test('each asset has its URL first, then the raw host and a mirror of the same file', () => {
  assert.deepEqual(assetSources('https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata'), [
    'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata',
    'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata',
    'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/eng.traineddata',
  ]);
  assert.deepEqual(assetSources('https://example.org/file.bin'), ['https://example.org/file.bin']);
  for (const asset of OCR_RUNTIME_ASSETS) assert.equal(assetSources(asset.url).length, 3, asset.name);
});

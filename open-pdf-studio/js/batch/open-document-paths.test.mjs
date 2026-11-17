import assert from 'node:assert/strict';
import test from 'node:test';
import { openDocumentPaths } from './open-paths.js';

test('a tab on a page-edit working copy still guards the real file', () => {
  const docs = [
    { filePath: '/tmp/opds-edit-1.pdf', saveTargetPath: '/set/A-101.pdf' },
    { filePath: '/set/B.pdf', saveTargetPath: null },
    { filePath: null },
    { filePath: '/set/B.pdf' },
  ];
  assert.deepEqual(openDocumentPaths(docs), ['/tmp/opds-edit-1.pdf', '/set/A-101.pdf', '/set/B.pdf']);
  assert.deepEqual(openDocumentPaths(undefined), []);
});

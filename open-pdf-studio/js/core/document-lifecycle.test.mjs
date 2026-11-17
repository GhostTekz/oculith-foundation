import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { documentClosed, documentPathChanged, onDocumentClosed, onDocumentPathChanged } from './document-lifecycle.js';

test('a closed document reaches its listeners with the documents still open, until they unsubscribe', () => {
  const seen = [];
  const off = onDocumentClosed((doc, info) => seen.push([doc.id, info.filePath, info.openDocuments.map((d) => d.id)]));
  const open = [{ id: 2, filePath: '/b.pdf' }];
  documentClosed({ id: 1, filePath: '/a.pdf' }, open);
  open.push({ id: 3 }); // the listener got a copy of the list
  off();
  documentClosed({ id: 4, filePath: '/c.pdf' }, []);
  assert.deepEqual(seen, [[1, '/a.pdf', [2]]]);
});

test('a listener that throws does not stop the others', (t) => {
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const offs = [onDocumentClosed(() => { throw new Error('boom'); }), onDocumentClosed((doc) => seen.push(doc.id))];
  documentClosed({ id: 7 });
  offs.forEach((off) => off());
  assert.deepEqual(seen, [7]);
  assert.throws(() => onDocumentClosed(null), TypeError);
});

test('a path change fires only when the path differs', () => {
  const seen = [];
  const off = onDocumentPathChanged((doc, info) => seen.push(info));
  const doc = { id: 1, filePath: '/new.pdf' };
  documentPathChanged(doc, '/old.pdf');
  documentPathChanged(doc, '/new.pdf', '/new.pdf');
  documentPathChanged(doc, null, '/x.pdf');
  off();
  assert.deepEqual(seen, [{ oldPath: '/old.pdf', newPath: '/new.pdf' }, { oldPath: null, newPath: '/x.pdf' }]);
});

test('the editor fires the events from its close, Save As, rename and working-copy paths, and offers them to plug-ins', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const tabs = read('../ui/chrome/tabs.js');
  assert.match(tabs, /state\.documents\.splice\(index, 1\);\s*\n\s*\/\/[^\n]*\n\s*documentClosed\(doc, state\.documents\);/);
  assert.match(tabs, /documentPathChanged\(doc, oldPath, newPath\)/);
  assert.match(read('../pdf/saver.js'), /documentPathChanged\(doc, currentPath, savePath\)/);
  assert.match(read('../pdf/page-manager.js'), /documentPathChanged\(doc, pathBefore, renderPath\)/);
  assert.match(read('../sets/slip-sheet-run.js'), /documentPathChanged\(target, targetPath, output\)/);
  assert.match(read('../plugin/host.js'), /'js\/core\/document-lifecycle\.js': \(\) => import\('\.\.\/core\/document-lifecycle\.js'\)/);
});

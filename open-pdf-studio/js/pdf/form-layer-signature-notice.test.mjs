// The fillable-form notice appears only for widgets that hold editable values.
// A sheet whose only widgets are signature fields gets no fill-in notice
// (signatures have their own status bar).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
// PDF.js's AnnotationLayer needs a real DOM; the form layer only needs it to
// render into the div it creates.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pdfjs-dist') return { url: 'stub:pdfjs-dist', shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'stub:pdfjs-dist') {
    return { format: 'module', shortCircuit: true,
      source: 'export class AnnotationLayer { constructor(o) { this.o = o; } async render() {} }' };
  }
  return nextLoad(url, context);
}`)}`);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const element = () => ({
  className: '', dataset: {}, children: [],
  appendChild(child) { this.children.push(child); return child; },
  remove() {}, querySelector: () => null, querySelectorAll: () => [],
});
globalThis.document.createElement = element;

const { state } = await import('../core/state.js');
const { createFormLayer } = await import('./form-layer.js');

const widget = (id, fieldType, extra = {}) => ({ id, subtype: 'Widget', fieldType, fieldName: `f${id}`, ...extra });
let pageIndex = 0;
const page = (annotations) => ({ pageNumber: ++pageIndex, getAnnotations: async () => annotations });
const noticeCount = () => globalThis.__stubCalls?.showFormFieldsBar || 0;

state.documents = [{ pdfDoc: { annotationStorage: {}, getJSActions: async () => null }, annotations: [] }];
state.activeDocumentIndex = 0;

test('a signature-only page renders its form layer without the fillable-form notice', async () => {
  const before = noticeCount();
  const div = await createFormLayer(page([widget('1R', 'Sig'), widget('2R', 'Sig')]), {}, element(), 1);
  assert.ok(div, 'the signature widgets still get a form layer');
  assert.equal(noticeCount(), before);
});

test('a page with a text field next to a signature shows the notice', async () => {
  const before = noticeCount();
  await createFormLayer(page([widget('3R', 'Sig'), widget('4R', 'Tx')]), {}, element(), 2);
  assert.equal(noticeCount(), before + 1);
});

test('a page with only a checkbox shows the notice', async () => {
  const before = noticeCount();
  await createFormLayer(page([widget('5R', 'Btn', { checkBox: true })]), {}, element(), 3);
  assert.equal(noticeCount(), before + 1);
});

test('a page without widgets has no form layer and no notice', async () => {
  const before = noticeCount();
  const div = await createFormLayer(page([{ id: '6R', subtype: 'Link' }]), {}, element(), 4);
  assert.equal(div, null);
  assert.equal(noticeCount(), before);
});

// Load hooks for the tests of the page operations outside page-manager.js
// (crop, deskew, resize, shift, flatten, page labels, image removal).
// Registered after page-manager-test-hooks.mjs, so these run first: they add
// the app modules those operations import on top of page-manager's set, again
// as thin pass-throughs to `globalThis.__pmTest.impl[name]`. pdf-lib, the
// operations themselves and page-manager.js stay real.

const STUBS = {
  'js/core/state.js': ['getActiveDocument', 'getNextUntitledName', 'getPageRotation'],
  'js/pdf/loader.js': ['getCachedPdfBytes', 'getPdfBytes', 'forgetPdfRangeSource', 'setCachedPdfBytes', 'clearCachedPdfBytes',
    'cancelAnnotationLoading', 'markAnnotationPagesLoaded', 'loadPDF', 'getSharedPdfLibDoc', 'pdfLibCatalog',
    'ensureAnnotationsForPage'],
  'js/pdf/exporter.js': ['renderPageOffscreen', 'parsePageRange'],
  'js/pdf/saver.js': ['savedPdfBytes'],
  'js/pdf/saver/vector-snippet.js': ['markeerGebakken'],
  'js/ui/panels/annotations-list.js': ['updateAnnotationsList'],
  'js/annotations/rendering.js': ['redrawContinuous', 'redrawAnnotations'],
  // The markup model: the tests move no markups, a copy is a plain clone.
  'js/annotations/factory.js': [],
  'js/annotations/transforms.js': ['applyMoveGeneric'],
};

const EXTRA = {
  'js/core/state.js': 'export const state = { get documents() { const t = globalThis.__pmTest; if (t?.documents) return t.documents; const d = t?.impl?.getActiveDocument?.(); return d ? [d] : []; } };',
  'js/annotations/factory.js': 'export const cloneAnnotation = (a) => structuredClone(a);',
};

function source(names, extra = '') {
  const lines = names.map(
    (n) => `export const ${n} = (...a) => globalThis.__pmTest?.impl?.[${JSON.stringify(n)}]?.(...a);`,
  );
  return `${lines.join('\n')}\n${extra}`;
}

const dataUrl = (text) => `data:text/javascript,${encodeURIComponent(text)}`;

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') || !context.parentURL?.startsWith('file:')) return nextResolve(specifier, context);
  const target = new URL(specifier, context.parentURL).href;
  for (const [path, names] of Object.entries(STUBS)) {
    if (!target.endsWith(`/${path}`)) continue;
    return { url: dataUrl(source(names, EXTRA[path] || '')), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

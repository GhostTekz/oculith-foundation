import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { PDFDocument, rgb } from "pdf-lib";

// The page operations outside page-manager.js (resize, deskew, shift, crop
// margins, page labels, image removal, flatten), on real PDF bytes, as
// page-manager-history.test.mjs does for insert/delete/move:
// - an operation stays on the tab where it started when another tab is
//   active by the time it applies, and records its undo step there, with the
//   page scales and spaces of before and after;
// - it does nothing to a tab closed meanwhile;
// - it is refused while another page operation runs (history-lock.js).
register("./page-manager-test-hooks.mjs", import.meta.url);
register("./page-operations-test-hooks.mjs", import.meta.url);
const pm = await import("./page-manager.js");
const { resizePages } = await import("./resize-pages.js");
const { straightenPages } = await import("./deskew.js");
const { shiftPages } = await import("./shift-page.js");
const { cropMargins } = await import("./crop-margins.js");
const { applyDocumentLabels } = await import("./page-labels-app.js");
const { removeEmbeddedImage } = await import("../tools/embedded-image-detector.js");
const { historyBusy } = await import("../core/history-lock.js");

const SCALE = { pixelsPerUnit: 2, unit: "mm", method: "ratio", scaleRatio: "1:100" };
// 1x1 opaque PNG.
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

async function pdf(pages) {
  const lib = await PDFDocument.create();
  const image = await lib.embedPng(PNG);
  for (let i = 0; i < pages; i++) {
    const page = lib.addPage([200 + i, 200]);
    page.drawRectangle({ x: 50, y: 50, width: 40, height: 40, color: rgb(0, 0, 0) });
    page.drawImage(image, { x: 100, y: 100, width: 20, height: 20 });
  }
  return new Uint8Array(await lib.save());
}

function documentOn(key, pages, extra = {}) {
  return {
    id: key, filePath: key, pdfDoc: { numPages: pages, destroy() {}, getPage: async () => fakePage },
    annotations: [], pageRotations: {}, currentPage: 1, ...extra,
  };
}
const fakePage = { getViewport: () => ({ width: 200, height: 200, transform: [1, 0, 0, -1, 0, 200] }), rotate: 0 };

// A rendered page: white with a black block, for the crop analysis.
function renderedPage() {
  const width = 20, height = 20;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) data.set([0, 0, 0, 255], (y * width + x) * 4);
  return { width, height, getContext: () => ({ getImageData: () => ({ data }) }) };
}

/** Tabs A and B; `tabs.active` is the active one, `tabs.documents` the open ones. */
async function twoTabs() {
  const cache = new Map();
  const a = documentOn("a.pdf", 2, {
    pageScales: { 2: SCALE },
    spaces: [{ id: "s1", name: "Space 1", page: 2, points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }] }],
  });
  const b = documentOn("b.pdf", 2);
  cache.set("a.pdf", await pdf(2));
  cache.set("b.pdf", await pdf(2));
  const tabs = { active: a, documents: [a, b] };
  const recorded = [];
  const impl = {
    getActiveDocument: () => tabs.active,
    getCachedPdfBytes: (k) => cache.get(k),
    getPdfBytes: async (k) => cache.get(k),
    setCachedPdfBytes: (k, v) => { cache.set(k, v); },
    isTauri: () => false,
    getPageRotation: () => 0,
    getDocument: ({ data }) => ({
      promise: PDFDocument.load(data).then((d) => ({ numPages: d.getPageCount(), destroy() {}, getPage: async () => fakePage })),
    }),
    setViewMode: async () => {},
    renderPageOffscreen: async () => renderedPage(),
    recordPageStructure: (...args) => { recorded.push(args); },
  };
  globalThis.window = { __TAURI__: {} };
  globalThis.__pmTest = { get documents() { return tabs.documents; }, impl };
  return { a, b, tabs, recorded, cache, impl };
}

// Each operation, started on tab A.
const OPERATIONS = {
  resize: () => resizePages("current", "", 100, 100),
  deskew: () => straightenPages(0, 0, 100, 5, "current"),
  shift: () => shiftPages(5, 5, "current"),
  crop: () => cropMargins("all", "", 1, 250),
  labels: () => applyDocumentLabels(["A1", "A2"]),
  removeImage: () => removeEmbeddedImage(1, 0),
};

for (const [name, run] of Object.entries(OPERATIONS)) {
  test(`${name}: applies to its own tab and records the step there with its page data`, async () => {
    const { a, b, tabs, recorded, cache, impl } = await twoTabs();
    const aBefore = cache.get("a.pdf");
    const bBefore = cache.get("b.pdf");
    // Page labels refuse a tab switch before they write (the dialog belongs
    // to the active tab); the others switch while the bytes are read.
    if (name !== "labels") {
      const read = impl.getPdfBytes;
      impl.getPdfBytes = async (k) => { const v = await read(k); tabs.active = b; return v; };
    }
    await run();
    assert.equal(recorded.length, 1, "one undo step");
    const [oldBytes, , , , newBytes, , , , extra] = recorded[0];
    assert.equal(extra.doc, a, "the step belongs to A");
    assert.deepEqual(oldBytes, aBefore);
    assert.deepEqual(cache.get(a.filePath), newBytes, "A has the new bytes");
    assert.notEqual(newBytes, aBefore);
    assert.equal(cache.get("b.pdf"), bBefore, "B is untouched");
    assert.equal(b.pdfDoc.numPages, 2);
    assert.deepEqual(extra.oldPageData, { pageScales: { 2: SCALE }, spaces: a.spaces });
    assert.deepEqual(extra.newPageData, extra.oldPageData, "these operations keep page numbers");
  });

  test(`${name}: a tab closed meanwhile is left alone and gets no step`, async () => {
    const { a, b, tabs, recorded, cache, impl } = await twoTabs();
    const aBefore = cache.get("a.pdf");
    const read = impl.getPdfBytes;
    impl.getPdfBytes = async (k) => { const v = await read(k); tabs.documents = [b]; tabs.active = b; return v; };
    await run();
    assert.equal(recorded.length, 0);
    assert.equal(cache.get("a.pdf"), aBefore);
    assert.equal(a.pdfDoc.numPages, 2);
    assert.equal(a.filePath, "a.pdf");
  });

  test(`${name}: refused while another page operation runs`, async () => {
    const { a, recorded, cache, impl } = await twoTabs();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    impl.setViewMode = () => gate;
    const first = pm.insertBlankPages("end", 1, 1, 100, 100);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(historyBusy(), true);
    const during = cache.get(a.filePath);
    // Refused at once; an operation that ran would wait on the gate as well.
    const outcome = await Promise.race([run().then(() => "refused"), new Promise((r) => setTimeout(() => r("waiting"), 200))]);
    assert.equal(outcome, "refused");
    assert.equal(cache.get(a.filePath), during, "nothing written meanwhile");
    release();
    await first;
    assert.equal(recorded.length, 1, "only the insert");
    assert.equal(historyBusy(), false);
  });
}

test("crop: a tab switch that stops the page analysis changes nothing", async () => {
  const { b, tabs, recorded, cache, impl } = await twoTabs();
  const aBefore = cache.get("a.pdf");
  impl.renderPageOffscreen = async () => { tabs.active = b; throw new Error("The document changed during export."); };
  assert.deepEqual(await cropMargins("all", "", 1, 250), { cropped: 0, skipped: 0 });
  assert.equal(recorded.length, 0);
  assert.equal(cache.get("a.pdf"), aBefore);
});

test("flatten and unflatten: locked, on their own tab, with page data", () => {
  const source = readFileSync(new URL("./flatten-document.js", import.meta.url), "utf8");
  assert.match(source, /export function flattenDocument\(options = \{\}\) \{\n\s*return withHistoryLock\(/);
  assert.match(source, /export function unflattenDocument\(options = \{\}\) \{\n\s*return withHistoryLock\(/);
  assert.equal((source.match(/reloadFromBytes\([^)]*, doc\)/g) || []).length, 2, "both reload their own tab");
  assert.equal((source.match(/\{ doc, \.\.\.pageDataChange\(dataBefore, doc\) \}/g) || []).length, 2, "both record on it");
  assert.match(source, /if \(!state\.documents\.includes\(doc\)\) return/);
});

test("cut pages: copy and delete stay on the tab where the cut started", async () => {
  const { a, b, tabs, cache, impl, recorded } = await twoTabs();
  const bBefore = cache.get("b.pdf");
  const read = impl.getCachedPdfBytes;
  impl.getCachedPdfBytes = (k) => { const v = read(k); tabs.active = b; return v; };
  await pm.cutPage(1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0][8].doc, a);
  assert.equal(a.pdfDoc.numPages, 1, "A lost the page");
  assert.equal(cache.get("b.pdf"), bBefore, "B is untouched");
  assert.equal(b.pdfDoc.numPages, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { PDFDocument } from "pdf-lib";

// Page operations and their undo on real PDF bytes (page-manager-test-hooks.mjs):
// - undo and redo put the page scales and spaces back on the page numbers of
//   their moment, as they do with the markups;
// - an operation stays on the tab where it started, even when another tab is
//   active by the time it applies its result, and does nothing to a closed tab;
// - one history step at a time: a page operation started while another runs
//   is refused.
register("./page-manager-test-hooks.mjs", import.meta.url);
const pm = await import("./page-manager.js");
const { historyBusy } = await import("../core/history-lock.js");

const SCALE = { pixelsPerUnit: 2, unit: "mm", method: "ratio", scaleRatio: "1:100" };

async function pdf(pages) {
  const lib = await PDFDocument.create();
  for (let i = 0; i < pages; i++) lib.addPage([200 + i, 200]);
  return new Uint8Array(await lib.save());
}

function documentOn(key, bytes, pages, extra = {}) {
  return {
    id: key, filePath: key, pdfDoc: { numPages: pages, destroy() {} },
    annotations: [], pageRotations: {}, currentPage: 1, ...extra,
  };
}

/** Tabs A and B; `active` decides which one getActiveDocument returns. */
async function twoTabs() {
  const cache = new Map();
  const a = documentOn("a.pdf", null, 4, {
    pageScales: { 3: SCALE },
    spaces: [{ id: "s1", name: "Space 1", page: 3, points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }] }],
  });
  const b = documentOn("b.pdf", null, 2);
  cache.set("a.pdf", await pdf(4));
  cache.set("b.pdf", await pdf(2));
  const tabs = { active: a, documents: [a, b] };
  const recorded = [];
  globalThis.window = { __TAURI__: {} };
  globalThis.__pmTest = {
    get documents() { return tabs.documents; },
    impl: {
      getActiveDocument: () => tabs.active,
      getCachedPdfBytes: (k) => cache.get(k),
      setCachedPdfBytes: (k, v) => { cache.set(k, v); },
      isTauri: () => false,
      getDocument: ({ data }) => ({
        promise: PDFDocument.load(data).then((d) => ({ numPages: d.getPageCount(), destroy() {} })),
      }),
      setViewMode: async () => {},
      recordPageStructure: (...args) => { recorded.push(args); },
    },
  };
  return { a, b, tabs, recorded, cache };
}

test("undo and redo of a page delete put page scales and spaces back on their pages", async () => {
  const { a, recorded } = await twoTabs();
  await pm.deletePages([1]);
  assert.deepEqual(Object.keys(a.pageScales), ["2"], "the scale moved with its page");
  assert.equal(a.spaces[0].page, 2);
  const [oldBytes, oldAnnotations, oldRotations, oldPage, newBytes, newAnnotations, newRotations, newPage, extra] = recorded.at(-1);
  assert.equal(extra.doc, a, "the step is recorded for the tab that changed");

  await pm.restorePageState(oldBytes, oldAnnotations, oldRotations, oldPage, extra.readBefore,
    { doc: a, pageData: extra.oldPageData });
  assert.equal(a.pdfDoc.numPages, 4);
  assert.deepEqual(Object.keys(a.pageScales), ["3"], "undo: back on page 3");
  assert.deepEqual(a.pageScales[3], SCALE);
  assert.equal(a.spaces[0].page, 3);

  await pm.restorePageState(newBytes, newAnnotations, newRotations, newPage, extra.readAfter,
    { doc: a, pageData: extra.newPageData });
  assert.deepEqual(Object.keys(a.pageScales), ["2"], "redo: on page 2 again");
  assert.equal(a.spaces[0].page, 2);
});

test("a page operation applies to the tab it started on after a tab switch", async () => {
  const { a, b, tabs, recorded, cache } = await twoTabs();
  const bBefore = cache.get("b.pdf");
  const original = globalThis.__pmTest.impl.getCachedPdfBytes;
  // Switch tabs while the operation reads the document's bytes.
  globalThis.__pmTest.impl.getCachedPdfBytes = (k) => { const v = original(k); tabs.active = b; return v; };
  await pm.insertBlankPages("end", 1, 1, 100, 100);
  assert.equal(a.pdfDoc.numPages, 5, "A got the page");
  assert.equal(b.pdfDoc.numPages, 2, "B is untouched");
  assert.equal(cache.get("b.pdf"), bBefore);
  assert.equal(recorded.at(-1)[8].doc, a, "the undo step goes to A");
});

test("a page operation on a tab closed meanwhile changes nothing and records nothing", async () => {
  const { a, b, tabs, recorded } = await twoTabs();
  const original = globalThis.__pmTest.impl.getCachedPdfBytes;
  globalThis.__pmTest.impl.getCachedPdfBytes = (k) => { const v = original(k); tabs.documents = [b]; tabs.active = b; return v; };
  await pm.deletePages([2]);
  assert.equal(a.pdfDoc.numPages, 4);
  assert.equal(recorded.length, 0);
});

test("one history step at a time: a page operation during another is refused", async () => {
  const { a, recorded } = await twoTabs();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.__pmTest.impl.setViewMode = () => gate;
  const first = pm.insertBlankPages("end", 1, 1, 100, 100);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(historyBusy(), true);
  assert.equal(await pm.deletePages([1]), undefined, "refused while the insert runs");
  assert.equal(a.pdfDoc.numPages, 5, "only the insert happened so far");
  release();
  await first;
  assert.equal(historyBusy(), false);
  assert.equal(recorded.length, 1);
  await pm.deletePages([1]);
  assert.equal(a.pdfDoc.numPages, 4, "after it finished, the next one runs");
});

test("undo and redo share the lock and restore the recorded page data", () => {
  const source = readFileSync(new URL("../core/undo-manager.js", import.meta.url), "utf8");
  assert.match(source, /export async function undo\(\) \{\n\s*if \(historyBusy\(\)\) return;\n.*'pageStructure'\) return withHistoryLock\(undoNu\);/);
  assert.match(source, /export async function redo\(\) \{\n\s*if \(historyBusy\(\)\) return;\n.*'pageStructure'\) return withHistoryLock\(redoNu\);/);
  assert.match(source, /pageData: cmd\.oldPageData/);
  assert.match(source, /pageData: cmd\.newPageData/);
});

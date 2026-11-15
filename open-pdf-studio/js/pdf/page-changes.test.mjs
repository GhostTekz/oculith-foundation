import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";

// The page operations announce which page went where (page-changes.js), so
// data kept by page number elsewhere can follow its pages. Run with the real
// page manager on real PDF bytes (page-manager-test-hooks.mjs).
register("./page-manager-test-hooks.mjs", import.meta.url);
const pm = await import("./page-manager.js");
const { onPageChange, pageChange } = await import("./page-changes.js");

const KEY = "SLEUTEL";
const NOTE = PDFName.of("ZZ_PageNote");

async function setup(pages = 4) {
  const lib = await PDFDocument.create();
  for (let i = 0; i < pages; i++) lib.addPage([100 + i, 100]);
  lib.catalog.set(NOTE, PDFString.of("page 1"));
  const bytes = new Uint8Array(await lib.save());
  const cache = new Map([[KEY, bytes]]);
  const doc = {
    id: "doc-1", filePath: KEY, pdfDoc: { numPages: pages, destroy() {} },
    annotations: [], pageRotations: {}, currentPage: 1,
  };
  const recorded = [];
  globalThis.window = { __TAURI__: {} };
  globalThis.__pmTest = {
    impl: {
      getActiveDocument: () => doc,
      getCachedPdfBytes: (k) => cache.get(k),
      setCachedPdfBytes: (k, b) => { cache.set(k, b); },
      isTauri: () => true,
      getDocument: ({ data }) => ({
        promise: PDFDocument.load(data).then((d) => ({ numPages: d.getPageCount(), destroy() {} })),
      }),
      setViewMode: async () => {},
      recordPageStructure: (...args) => { recorded.push(args); },
    },
  };
  const events = [];
  // A listener that keeps a note on "page 1" in the catalog, as a plug-in would.
  const stop = onPageChange(async (event) => {
    events.push(event);
    if (event.type !== "write") return;
    const was = event.source.catalog.lookup(NOTE)?.decodeText();
    const page = Number(String(was).replace("page ", ""));
    const now = event.change.pageAt(page);
    if (now) event.target.catalog.set(NOTE, PDFString.of(`page ${now}`));
    else event.target.catalog.delete(NOTE);
  });
  const note = async () => (await PDFDocument.load(cache.get(KEY))).catalog.lookup(NOTE)?.decodeText() ?? null;
  return { doc, cache, events, recorded, stop, note };
}

const widths = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth());

test("a page change maps old pages to new ones; nothing moved is no change", () => {
  const doc = {};
  const change = pageChange(doc, "delete", { 1: null, 2: 1, 3: 2 }, 3, 2);
  assert.equal(change.doc, doc);
  assert.deepEqual([...change.pages], [[2, 1], [3, 2]]);
  assert.equal(change.pageAt(1), null);
  assert.equal(change.pageAt("3"), 2);
  assert.equal(change.pageAt(9), null);
  assert.equal(pageChange(doc, "move", { 1: 1, 2: 2 }, 2, 2), null);
  // Pages appended at the end move nothing, but the count changes.
  assert.equal(pageChange(doc, "insert", new Map([[1, 1], [2, 2]]), 2, 3).after, 3);
});

test("deleting the first page announces it before the bytes are written and after they show", async () => {
  const o = await setup();
  try {
    await pm.deletePages([1]);
    assert.deepEqual(o.events.map((e) => e.type), ["write", "changed"]);
    const { change } = o.events[0];
    assert.equal(change.operation, "delete");
    assert.equal(change.before, 4);
    assert.equal(change.after, 3);
    assert.deepEqual([...change.pages], [[2, 1], [3, 2], [4, 3]]);
    assert.equal(o.events[1].change, change, "one change object for every event of it");
    assert.equal(o.events[0].source, o.events[0].target, "the document is changed in place");
    assert.deepEqual(await widths(o.cache.get(KEY)), [101, 102, 103]);
    // The note on page 1 went with the page.
    assert.equal(await o.note(), null);
    // Undo gets the change with the step.
    assert.equal(o.recorded.length, 1);
    assert.equal(o.recorded[0][8].pageChange, change);
  } finally { o.stop(); }
});

test("moving pages offers the old catalog while the pages go into a new document", async () => {
  const o = await setup();
  try {
    await pm.reorderPages([3, 1, 2, 4]);
    const write = o.events.find((e) => e.type === "write");
    assert.notEqual(write.source, write.target);
    assert.equal(write.change.operation, "move");
    assert.equal(write.change.pageAt(1), 2);
    assert.equal(write.change.pageAt(3), 1);
    assert.deepEqual(await widths(o.cache.get(KEY)), [102, 100, 101, 103]);
    // Without the listener the moved document would have lost the note.
    assert.equal(await o.note(), "page 2");
  } finally { o.stop(); }
});

test("inserted and pasted pages hold nothing; the pages after them shift", async () => {
  const o = await setup();
  try {
    await pm.insertBlankPages("after", 1, 2, 50, 50);
    const change = o.events.find((e) => e.type === "changed").change;
    assert.equal(change.operation, "insert");
    assert.deepEqual([...change.pages], [[1, 1], [2, 4], [3, 5], [4, 6]]);
    assert.equal(await o.note(), "page 1");
    o.events.length = 0;
    await pm.copyPage(4);
    await pm.pastePage(0);
    const pasted = o.events.find((e) => e.type === "changed").change;
    assert.equal(pasted.operation, "paste");
    assert.equal(pasted.pageAt(1), 2);
    assert.equal(await o.note(), "page 2");
  } finally { o.stop(); }
});

test("a listener that fails does not stop the page change or the other listeners", async () => {
  const o = await setup();
  const stopBad = onPageChange(() => { throw new Error("broken"); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await pm.deletePages([2]);
    assert.deepEqual(await widths(o.cache.get(KEY)), [100, 102, 103]);
    assert.deepEqual(o.events.map((e) => e.type), ["write", "changed"]);
  } finally { console.warn = warn; stopBad(); o.stop(); }
});

test("the undo history keeps the change object itself, without walking into the document", async () => {
  // The history stores a command through solid's unwrap (undo-manager.js
  // plainCommand); the browser build copies a frozen plain object and walks
  // into every plain object it holds. Listeners key what they kept by the change.
  const { unwrap } = await import("solid-js/store/dist/store.js");
  const doc = { id: "d", annotations: [{ id: "a" }] };
  const change = pageChange(doc, "delete", { 1: null, 2: 1 }, 2, 1);
  const cmd = unwrap({ type: "pageStructure", pageChange: change });
  assert.equal(cmd.pageChange, change);
  assert.equal(cmd.pageChange.doc, doc);
  assert.equal(cmd.pageChange.pageAt(2), 1);
});

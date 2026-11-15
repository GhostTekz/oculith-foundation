import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// page-manager.js pulls in the whole app (state, renderer, pdf.js) and cannot
// be imported under plain node, so this is a guard rail on its source.
const source = readFileSync(new URL("./page-manager.js", import.meta.url), "utf8");
const start = source.indexOf("export async function reloadFromBytes");
const body = source.slice(start, source.indexOf("\n}\n", start));

test("replacing the document bytes drops the caches that are not keyed by path", () => {
  assert.ok(start > 0, "reloadFromBytes not found");
  const snap = body.indexOf("clearPdfVectorCache()");
  const text = body.indexOf("clearTextCache(doc.id)");
  const render = body.indexOf("await setViewMode(");
  assert.ok(snap > 0, "snap-to-content geometry (keyed by page number) must be cleared");
  assert.ok(text > 0, "search text (keyed by document id) must be cleared");
  // The re-render prefetches the snap geometry again; clearing after it would
  // leave the cache empty until the next page change.
  assert.ok(render > snap && render > text, "clear the caches before the re-render");
});

// ── Page changes on a drawing whose markups are read lazily ─────────────────
// The real page manager on real PDF bytes (page-manager-test-hooks.mjs). Each
// page holds two markups with a field of another producer; only some pages
// were read, as on a large drawing just reopened. After any sequence of page
// changes, (1) only the pages read before count as read, so a save keeps the
// other pages' markups from the file, and (2) every loaded markup's source
// names its own annotation in the new bytes, so the saver can carry its
// fields over (the check that threw "PDF annotation source changed").
import { register } from "node:module";
import { PDFDocument, PDFName, PDFString, PDFArray } from "pdf-lib";
import { carryUnmodeledAnnotationKeys } from "./saver/unmodeled-annotation-keys.js";

register("./page-manager-test-hooks.mjs", import.meta.url);
const pm = await import("./page-manager.js");

const KEY = "drawing.pdf";
const OWNER = PDFName.of("ZZ_Owner");

/** A drawing of `pages` pages, two square markups per page named p<page><a|b>. */
async function drawing(pages) {
  const lib = await PDFDocument.create();
  for (let p = 1; p <= pages; p++) {
    const page = lib.addPage([200 + p, 200]);
    const refs = ["a", "b"].map((s, i) => lib.context.register(lib.context.obj({
      Type: "Annot", Subtype: "Square", Rect: [10 + i * 20, 10, 25 + i * 20, 25],
      NM: PDFString.of(`p${p}${s}`), ZZ_Owner: PDFString.of(`owner p${p}${s}`),
    })));
    page.node.set(PDFName.of("Annots"), lib.context.obj(refs));
  }
  return new Uint8Array(await lib.save());
}

/** The models the loader makes when it reads `page` of `bytes`. */
async function readPage(bytes, page) {
  const lib = await PDFDocument.load(bytes);
  const annots = lib.getPage(page - 1).node.lookup(PDFName.of("Annots"), PDFArray).asArray();
  return annots.map((ref) => {
    const nm = lib.context.lookup(ref).get(PDFName.of("NM")).decodeText();
    return { id: `m-${nm}`, type: "box", page, nm, pdfSource: { ref: ref.toString(), modelId: `m-${nm}`, nm } };
  });
}

async function lazyDoc(pages, read) {
  const bytes = await drawing(pages);
  const cache = new Map([[KEY, bytes]]);
  const annotations = [];
  for (const p of read) annotations.push(...await readPage(bytes, p));
  const doc = {
    id: "doc-lazy", filePath: KEY, pdfDoc: { numPages: pages, destroy() {} },
    annotations, pageRotations: {}, currentPage: 1,
    _loadedAnnotationPages: new Set(read), _annotationPagesReady: new Set(read),
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
      // As loader.js does it.
      cancelAnnotationLoading: (d) => { d._loadedAnnotationPages.clear(); d._annotationPagesReady.clear(); },
      markAnnotationPagesLoaded: (pagesRead, d) => {
        for (const p of pagesRead) { d._loadedAnnotationPages.add(p); d._annotationPagesReady.add(p); }
      },
      // The editor before this fix: every page counted as read.
      markAllAnnotationPagesLoaded: (n, d) => {
        for (let p = 1; p <= n; p++) { d._loadedAnnotationPages.add(p); d._annotationPagesReady.add(p); }
      },
      setViewMode: async () => {},
      recordPageStructure: (...args) => { recorded.push(args); },
    },
  };
  return { doc, recorded, bytes: () => cache.get(KEY) };
}

/** What the saver does with each loaded markup, against the bytes it saves from. */
async function sourcesHold(bytes, annotations) {
  const lib = await PDFDocument.load(bytes);
  for (const model of annotations) {
    const annots = lib.getPage(model.page - 1).node.lookup(PDFName.of("Annots"), PDFArray).asArray();
    const target = lib.context.obj({ Type: "Annot", Subtype: "Square" });
    const copied = carryUnmodeledAnnotationKeys(lib.context, annots, model, target);
    assert.deepEqual(copied, ["ZZ_Owner"], `${model.nm} on page ${model.page}: its own fields carried over`);
    assert.equal(target.get(OWNER).decodeText(), `owner ${model.nm}`);
  }
}

/** Page -> markup names in the file, for the pages not read: the saver keeps these. */
async function namesOnPage(bytes, page) {
  return (await readPage(bytes, page)).map((m) => m.nm);
}

const ready = (doc) => [...doc._annotationPagesReady].sort((a, b) => a - b);
const moveToSecond = (n, k) => [1, k, ...Array.from({ length: n }, (_, i) => i + 1).filter((p) => p !== 1 && p !== k)];

test("delete then move on a lazily read drawing: only read pages count as read, sources follow", async () => {
  const o = await lazyDoc(6, [2, 3]);
  await pm.deletePages([1]); // pages 2..6 -> 1..5; read {1, 2}
  assert.deepEqual(ready(o.doc), [1, 2]);
  await pm.reorderPages(moveToSecond(5, 4)); // old 4 to page 2: read {1, 3}
  assert.deepEqual(ready(o.doc), [1, 3], "a page not read stays unread: its markups stay in the file");
  assert.deepEqual(o.doc.annotations.map((a) => `${a.page}:${a.nm}`).sort(), ["1:p2a", "1:p2b", "3:p3a", "3:p3b"]);
  await sourcesHold(o.bytes(), o.doc.annotations);
  // The unread pages still carry their markups in the bytes a save starts from.
  assert.deepEqual(await namesOnPage(o.bytes(), 2), ["p5a", "p5b"]);
  assert.deepEqual(await namesOnPage(o.bytes(), 4), ["p4a", "p4b"]);
  assert.deepEqual(await namesOnPage(o.bytes(), 5), ["p6a", "p6b"]);
});

test("insert, delete and two moves: every loaded markup once, each source on its own annotation", async () => {
  const o = await lazyDoc(7, [1, 4, 6]);
  await pm.insertBlankPages("after", 1, 1, 200, 200); // 1, new, 2..7 -> 3..8; read {1, 5, 7}
  await pm.reorderPages([8, 1, 2, 3, 4, 5, 6, 7]); // read {2, 6, 8}
  await pm.deletePages([3]); // the blank page went; read {2, 5, 7}
  await pm.reorderPages(moveToSecond(7, 7)); // read {3, 6, 2}
  assert.deepEqual(ready(o.doc), [2, 3, 6]);
  const names = o.doc.annotations.map((a) => a.nm);
  assert.equal(new Set(names).size, names.length, "no markup twice");
  assert.deepEqual(names.sort(), ["p1a", "p1b", "p4a", "p4b", "p6a", "p6b"]);
  await sourcesHold(o.bytes(), o.doc.annotations);
});

test("undo after delete and move restores the read pages of that moment, redo those after", async () => {
  const o = await lazyDoc(5, [2]);
  await pm.deletePages([1]);
  await pm.reorderPages(moveToSecond(4, 3));
  const [oldBytes, oldAnnotations, oldRotations, oldPage, newBytes, newAnnotations, newRotations, newPage, extra] = o.recorded.at(-1);
  await pm.restorePageState(oldBytes, oldAnnotations, oldRotations, oldPage, extra.readBefore);
  assert.deepEqual(ready(o.doc), [1]);
  await sourcesHold(oldBytes, o.doc.annotations);
  await pm.restorePageState(newBytes, newAnnotations, newRotations, newPage, extra.readAfter);
  assert.deepEqual(ready(o.doc), [1]);
  await sourcesHold(newBytes, o.doc.annotations);
});

test("every page read: after delete and move the saver still finds each markup's own annotation", async () => {
  const o = await lazyDoc(6, [1, 2, 3, 4, 5, 6]);
  await pm.deletePages([1]);
  await pm.reorderPages(moveToSecond(5, 4));
  assert.deepEqual(ready(o.doc), [1, 2, 3, 4, 5]);
  assert.equal(o.doc.annotations.length, 10);
  await sourcesHold(o.bytes(), o.doc.annotations);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  annotationRefsByPage, movedSource, remapPageAnnotations, readMarkupPages, readPagesAfterChange,
} from "./page-markup-state.js";

test("annotationRefsByPage lists each page's /Annots in order", async () => {
  const lib = await PDFDocument.create();
  const a = lib.addPage([100, 100]);
  lib.addPage([100, 100]);
  const r1 = lib.context.register(lib.context.obj({ Type: "Annot", NM: PDFString.of("x") }));
  const r2 = lib.context.register(lib.context.obj({ Type: "Annot", NM: PDFString.of("y") }));
  a.node.set(PDFName.of("Annots"), lib.context.obj([r1, r2, lib.context.obj({ Type: "Annot" })]));
  assert.deepEqual(annotationRefsByPage(lib), [[r1.toString(), r2.toString(), null], []]);
});

test("a source follows its annotation's place in /Annots; no match drops it", () => {
  const before = [["5 0 R", "6 0 R"], ["7 0 R"]];
  const after = [["7 0 R"], ["20 0 R", "21 0 R"]];
  const source = { ref: "6 0 R", modelId: "m", nm: "n" };
  assert.deepEqual(movedSource(source, 1, 2, before, after), { ref: "21 0 R", modelId: "m", nm: "n" });
  assert.equal(movedSource({ ...source, ref: "9 0 R" }, 1, 2, before, after), null);
  assert.equal(movedSource(source, 1, 1, before, after), null, "another number of annotations: no guess");
});

test("remapPageAnnotations moves markups, drops those of a deleted page, keeps others' sources", () => {
  const anns = [
    { id: "a", page: 1, pdfSource: { ref: "5 0 R", modelId: "a", nm: "a" } },
    { id: "b", page: 2, pdfSource: { ref: "7 0 R", modelId: "b", nm: "b" } },
    { id: "c", page: 2 },
    { id: "d", page: 2, pdfSource: { ref: "7 0 R", modelId: "copied-from", nm: "b" } },
  ];
  const mapping = { 1: null, 2: 1 };
  const out = remapPageAnnotations(anns, mapping, [["5 0 R"], ["7 0 R"]], [["30 0 R"]]);
  assert.deepEqual(out.map((a) => [a.id, a.page, a.pdfSource?.ref]), [["b", 1, "30 0 R"], ["c", 1, undefined], ["d", 1, "7 0 R"]]);
  assert.equal(anns[1].pdfSource.ref, "7 0 R", "the markups before the change (undo) keep theirs");
  const same = remapPageAnnotations(anns, mapping);
  assert.equal(same[0].pdfSource.ref, "7 0 R", "without /Annots the object numbers were kept");
});

test("read pages follow the mapping; new pages are unread; model pages are always read", () => {
  const read = new Set([1, 3]);
  assert.deepEqual([...readPagesAfterChange({ read, pageMapping: { 1: null, 2: 1, 3: 2 }, numPages: 2 })], [2]);
  assert.deepEqual([...readPagesAfterChange({ read, pageMapping: { 1: 1, 2: 3, 3: 4 }, numPages: 4 })].sort(), [1, 4]);
  assert.deepEqual([...readPagesAfterChange({ read, numPages: 3, annotations: [{ page: 2 }] })].sort(), [1, 2, 3]);
  assert.deepEqual([...readPagesAfterChange({ read, explicit: [2], numPages: 3 })], [2]);
  assert.deepEqual([...readPagesAfterChange({ read: new Set([9]), numPages: 3 })], [], "past the last page");
  assert.deepEqual([...readMarkupPages({ _annotationPagesReady: new Set([4]) })], [4]);
  assert.deepEqual([...readMarkupPages({})], []);
});

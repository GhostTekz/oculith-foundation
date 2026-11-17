import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFHexString, PDFName, PDFString, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { ownCatalogBytes, loadOwnCatalog, ownCatalogAnswers } from './own-catalog.js';

const catalogOf = (pdf) => pdf.context.lookup(pdf.context.trailerInfo.Root);
const streamText = (s) => new TextDecoder().decode(decodePDFRawStream(s).decode());

async function sample() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const cat = catalogOf(pdf);
  cat.set(PDFName.of('OPS_TextV1'), PDFHexString.fromText('{"plan":"één ✓"}'));
  cat.set(PDFName.of('OPS_LiteralV1'), PDFString.of('a\\(b\\)'));
  cat.set(PDFName.of('OPS_StreamV1'), pdf.context.register(pdf.context.flateStream(JSON.stringify({ rows: [1, 2, 3] }))));
  cat.set(PDFName.of('OPS_DictV1'), pdf.context.obj({ Count: 3, Inner: pdf.context.register(pdf.context.obj({ A: 'x' })) }));
  cat.set(PDFName.of('OPS_PageLinkV1'), pdf.context.obj({ P: page.ref }));
  cat.set(PDFName.of('PageLayout'), PDFName.of('SinglePage'));
  return PDFDocument.load(await pdf.save({ useObjectStreams: false }));
}

test('own catalog entries read the same from the small copy as from the file', async () => {
  const full = await sample();
  const own = await ownCatalogBytes(full);
  assert.deepEqual(own.keys.sort(), ['OPS_DictV1', 'OPS_LiteralV1', 'OPS_StreamV1', 'OPS_TextV1']);
  const small = await loadOwnCatalog(own.bytes);
  const a = catalogOf(full), b = catalogOf(small);
  assert.equal(b.lookup(PDFName.of('OPS_TextV1')).decodeText(), a.lookup(PDFName.of('OPS_TextV1')).decodeText());
  assert.equal(b.lookup(PDFName.of('OPS_LiteralV1')).decodeText(), a.lookup(PDFName.of('OPS_LiteralV1')).decodeText());
  assert.ok(b.lookup(PDFName.of('OPS_StreamV1')) instanceof PDFRawStream);
  assert.equal(streamText(b.lookup(PDFName.of('OPS_StreamV1'))), streamText(a.lookup(PDFName.of('OPS_StreamV1'))));
  assert.equal(small.catalog.lookup(PDFName.of('OPS_DictV1')).lookup(PDFName.of('Inner')).get(PDFName.of('A')).decodeText(), 'x');
  // An entry that reaches a page, and the standard ones, are not copied.
  assert.equal(b.get(PDFName.of('OPS_PageLinkV1')), undefined);
  assert.equal(b.get(PDFName.of('PageLayout')), undefined);
  assert.ok(own.bytes.length < 4096);
});

test('a document without own entries has no copy', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  assert.equal(await ownCatalogBytes(await PDFDocument.load(await pdf.save())), null);
});

test('the copy answers only for keys it holds or the file lacks', () => {
  const file = ['Pages', 'OPS_A', 'OPS_B'];
  assert.equal(ownCatalogAnswers(['OPS_A'], ['OPS_A'], file), true);
  assert.equal(ownCatalogAnswers(['OPS_A', 'OPS_C'], ['OPS_A'], file), true);
  assert.equal(ownCatalogAnswers(['OPS_B'], ['OPS_A'], file), false);
  assert.equal(ownCatalogAnswers([], ['OPS_A'], file), false);
  assert.equal(ownCatalogAnswers(undefined, ['OPS_A'], file), false);
  assert.equal(ownCatalogAnswers(['OPS_A'], null, file), false);
});

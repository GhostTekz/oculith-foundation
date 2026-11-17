import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkbook, cellRef, csvText, parseRange, parseRef, safeSheetName, sheetPrefix } from './xlsx-workbook.js';
import { assertWellFormedXml, readXlsx } from './xlsx-read.js';

const created = new Date(Date.UTC(2026, 9, 30, 12, 0, 0));
const model = () => ({
  title: 'Quantities & <totals>', creator: 'Test', created,
  names: [{ name: 'Rate', ref: 'Inputs!$B$1' }],
  sheets: [
    { name: 'Lines', freeze: { rows: 1 }, widths: [10, 24],
      rows: [
        [{ v: 'Code', s: 'header' }, { v: 'Text', s: 'header' }, { v: 'Qty', s: 'header' }, { v: 'Total', s: 'header' }],
        ['A1', 'Café "quoted" <b>', { v: 2.5, s: 'decimal' }, { f: 'C2*Rate', v: 5, s: 'decimal' }],
        ['A2', 'Line\nbreak', { v: 4, s: 'integer' }, { f: 'IF(C3>3,"big","small")', v: 'big' }],
      ],
      tables: [{ name: 'Lines', ref: 'A1:D3' }],
      highlight: [{ ref: 'A2:D3', formula: '$C2>3', style: 'flag' }] },
    { name: 'Inputs', rows: [['Rate', { v: 2, s: 'inputDecimal' }], ['Empty input', { s: 'inputPercent' }]], merges: ['A4:B4'] },
  ],
});

test('cell references and ranges', () => {
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(9, 27), 'AB10');
  assert.deepEqual(parseRef('$AB$10'), [9, 27]);
  assert.deepEqual(parseRange('C5:A1'), { r0: 0, c0: 0, r1: 4, c1: 2 });
});

test('sheet names are Excel-safe and unique; prefixes quote when needed', () => {
  const used = new Set();
  assert.equal(safeSheetName('A/B: [x]', used), 'A B   x');
  assert.equal(safeSheetName('Items', used), 'Items');
  assert.equal(safeSheetName('items', used), 'items (2)');
  assert.equal(safeSheetName('x'.repeat(40), used).length, 31);
  assert.equal(sheetPrefix('Items'), 'Items!');
  assert.equal(sheetPrefix('By Area'), "'By Area'!");
  assert.equal(sheetPrefix("Bob's"), "'Bob''s'!");
  assert.equal(sheetPrefix('AB1'), "'AB1'!");
});

test('workbook is valid and reads back with values, formulas, tables and panes', async () => {
  const bytes = buildWorkbook(model());
  const book = await readXlsx(bytes);
  assert.deepEqual(book.sheets.map((s) => s.name), ['Lines', 'Inputs']);
  const lines = book.sheets[0];
  assert.equal(lines.cells.get('B2').v, 'Café "quoted" <b>');
  assert.equal(lines.cells.get('B3').v, 'Line\nbreak');
  assert.equal(lines.cells.get('C2').v, 2.5);
  assert.deepEqual([lines.cells.get('D2').f, lines.cells.get('D2').v], ['C2*Rate', 5]);
  assert.deepEqual([lines.cells.get('D3').f, lines.cells.get('D3').v, lines.cells.get('D3').t], ['IF(C3>3,"big","small")', 'big', 'str']);
  assert.deepEqual(lines.tables, [{ name: 'Lines', ref: 'A1:D3', columns: ['Code', 'Text', 'Qty', 'Total'] }]);
  assert.deepEqual(lines.freeze, { rows: 1, cols: 0 });
  assert.match(lines.xml, /<conditionalFormatting sqref="A2:D3"><cfRule type="expression" dxfId="0" priority="1"><formula>\$C2&gt;3<\/formula>/);
  assert.equal(book.names.get('Rate'), 'Inputs!$B$1');
  assert.ok(book.sheets[1].cells.has('B2'), 'a styled empty input cell is written');
  assert.match(book.parts.get('xl/workbook.xml'), /fullCalcOnLoad="1"/);
  assert.match(book.parts.get('docProps/core.xml'), /Quantities &amp; &lt;totals&gt;/);
});

test('the same model gives the same bytes', () => {
  assert.deepEqual(buildWorkbook(model()), buildWorkbook(model()));
});

test('a table with only a header still has a data row; bad tables are refused', async () => {
  const book = await readXlsx(buildWorkbook({ sheets: [{ name: 'S', rows: [['A', 'B']], tables: [{ name: 'T', ref: 'A1:B1' }] }] }));
  assert.equal(book.sheets[0].tables[0].ref, 'A1:B2');
  assert.throws(() => buildWorkbook({ sheets: [{ name: 'S', rows: [['A', 'A']], tables: [{ name: 'T', ref: 'A1:B2' }] }] }), /duplicate column/);
  assert.throws(() => buildWorkbook({ sheets: [{ name: 'S', rows: [['A', null]], tables: [{ name: 'T', ref: 'A1:B2' }] }] }), /must be text/);
  assert.throws(() => buildWorkbook({ sheets: [{ name: 'S', rows: [['A']], tables: [{ name: 'A1', ref: 'A1:A2' }] }] }), /valid table name/);
  assert.throws(() => buildWorkbook({ sheets: [{ name: 'S', rows: [[{ v: 1, s: 'nope' }]] }] }), /Unknown cell style/);
  assert.throws(() => buildWorkbook({ sheets: [{ name: 'S', rows: [[Infinity]] }] }), /not finite/);
});

test('control characters never reach the XML', async () => {
  const book = await readXlsx(buildWorkbook({ sheets: [{ name: 'S', rows: [['a\u0001b\u0008c']] }] }));
  assert.equal(book.sheets[0].cells.get('A1').v, 'abc');
});

test('the XML checker rejects broken XML', () => {
  assertWellFormedXml('<?xml version="1.0"?><a x="1"><b/>t &amp; u</a>');
  for (const bad of ['<a><b></a></b>', '<a>&nbsp;</a>', '<a x="1" x="2"/>', '<a/><b/>', '<a>', '<a>x & y</a>', '<a x=1/>']) {
    assert.throws(() => assertWellFormedXml(bad), Error, bad);
  }
});

test('CSV quotes what needs quoting and ends lines with CRLF', () => {
  assert.equal(csvText([['a', 'b,c', 'say "hi"', 1.5, null], [' x', 'line\nbreak', Infinity]]),
    'a,"b,c","say ""hi""",1.5,\r\n" x","line\nbreak",\r\n');
});

test('CSV text that would open as a formula is written as text; numbers stay numbers', () => {
  const lines = csvText([
    ['=HYPERLINK("http://x","y")', '+1+2', '-2+3', '@SUM(A1)', '\tx', 'a=b'],
    [-12.5, '-12.5', '+3', '1e-3', -0, '-'],
  ]).split('\r\n');
  assert.equal(lines[0], `"'=HYPERLINK(""http://x"",""y"")",'+1+2,'-2+3,'@SUM(A1),'\tx,a=b`);
  assert.equal(lines[1], "-12.5,-12.5,+3,1e-3,0,'-");
});

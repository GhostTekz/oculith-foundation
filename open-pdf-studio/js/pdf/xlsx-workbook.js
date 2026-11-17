// A small, deterministic XLSX (SpreadsheetML) writer for workbooks that people
// keep working in: typed cells, real formulas with cached results, a fixed set
// of named cell styles (number formats, header, input and flag fills), column
// widths, frozen panes, merged cells, Excel Tables with filters, conditional
// highlighting and defined names. Pure: no UI or file access. The same input
// gives the same bytes (shared strings in first-use order, fixed ZIP time).
//
// office-files.js keeps the simple text-table export; this module is for
// workbooks built from a model.
import { zipStore } from '../bcf/bcf-zip.js';
import { columnName, xml } from './office-files.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

export const MAX_ROWS = 1048576;
export const MAX_COLUMNS = 16384;

// Number formats: built-in 0 (General), 3 (#,##0); custom from 164.
const NUM_FORMATS = [
  [164, '#,##0.00'],
  [165, '0.0%'],
  [166, 'yyyy-mm-dd'],
];
// Fonts: 0 normal, 1 bold, 2 bold white, 3 bold large, 4 italic grey.
const FONTS = [
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>',
  '<font><i/><color rgb="FF595959"/><sz val="10"/><name val="Calibri"/><family val="2"/></font>',
];
// Fills: 0 none and 1 gray125 (required), 2 header, 3 input, 4 flag, 5 total.
const solid = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
const FILLS = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
  solid('FF244766'), solid('FFFFF2CC'), solid('FFFCE4D6'), solid('FFE7ECF2')];
// Borders: 0 none, 1 thin (input cells), 2 top (totals).
const BORDERS = [
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  '<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>',
  '<border><left/><right/><top style="thin"><color rgb="FF7F7F7F"/></top><bottom/><diagonal/></border>',
];

/**
 * The named cell styles a workbook model may use: `{ v, s: 'decimal' }`.
 * `input*` styles mark cells meant to be edited; `flag` marks a warning.
 */
export const CELL_STYLES = Object.freeze({
  text: { numFmt: 0, font: 0, fill: 0, border: 0 },
  wrap: { numFmt: 0, font: 0, fill: 0, border: 0, wrap: true },
  bold: { numFmt: 0, font: 1, fill: 0, border: 0 },
  header: { numFmt: 0, font: 2, fill: 2, border: 0, wrap: true },
  title: { numFmt: 0, font: 3, fill: 0, border: 0 },
  note: { numFmt: 0, font: 4, fill: 0, border: 0 },
  integer: { numFmt: 3, font: 0, fill: 0, border: 0 },
  decimal: { numFmt: 164, font: 0, fill: 0, border: 0 },
  percent: { numFmt: 165, font: 0, fill: 0, border: 0 },
  date: { numFmt: 166, font: 0, fill: 0, border: 0 },
  flag: { numFmt: 0, font: 0, fill: 4, border: 0 },
  inputText: { numFmt: 0, font: 0, fill: 3, border: 1 },
  inputInteger: { numFmt: 3, font: 0, fill: 3, border: 1 },
  inputDecimal: { numFmt: 164, font: 0, fill: 3, border: 1 },
  inputPercent: { numFmt: 165, font: 0, fill: 3, border: 1 },
  totalText: { numFmt: 0, font: 1, fill: 5, border: 2 },
  totalInteger: { numFmt: 3, font: 1, fill: 5, border: 2 },
  totalDecimal: { numFmt: 164, font: 1, fill: 5, border: 2 },
});
const STYLE_NAMES = Object.keys(CELL_STYLES);
const STYLE_INDEX = new Map(STYLE_NAMES.map((name, i) => [name, i]));
// Differential formats for conditional highlighting.
const DXF = Object.freeze({ flag: 0, muted: 1 });
const DXFS = [
  '<dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor rgb="FFFCE4D6"/></patternFill></fill></dxf>',
  '<dxf><font><color rgb="FF808080"/></font></dxf>',
];

function stylesXml() {
  const xf = (s) => `<xf numFmtId="${s.numFmt}" fontId="${s.font}" fillId="${s.fill}" borderId="${s.border}" xfId="0"`
    + `${s.numFmt ? ' applyNumberFormat="1"' : ''}${s.font ? ' applyFont="1"' : ''}${s.fill ? ' applyFill="1"' : ''}${s.border ? ' applyBorder="1"' : ''}`
    + (s.wrap ? ' applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' : '/>');
  return `${XML}<styleSheet xmlns="${MAIN}">`
    + `<numFmts count="${NUM_FORMATS.length}">${NUM_FORMATS.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`).join('')}</numFmts>`
    + `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>`
    + `<fills count="${FILLS.length}">${FILLS.join('')}</fills>`
    + `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${STYLE_NAMES.length}">${STYLE_NAMES.map((name) => xf(CELL_STYLES[name])).join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + `<dxfs count="${DXFS.length}">${DXFS.join('')}</dxfs>`
    + '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
    + '</styleSheet>';
}

/** A1 reference of a zero-based row and column. */
export function cellRef(row, col) { return `${columnName(col)}${row + 1}`; }

/** Zero-based [row, col] of an A1 reference ($ signs allowed). */
export function parseRef(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(String(ref));
  if (!m) throw new Error(`Not a cell reference: ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

/** A sheet name Excel accepts (31 characters, none of \ / ? * [ ] :), unique in `used`. */
export function safeSheetName(name, used = new Set()) {
  const base = String(name ?? '').replace(/[\\/?:*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let out = base, n = 1;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 26)} (${++n})`;
  used.add(out.toLowerCase());
  return out;
}

/** A sheet name as a formula prefix: Items!, 'By Area'!. */
export function sheetPrefix(name) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? `${name}!` : `'${String(name).replace(/'/g, "''")}'!`;
}

const TABLE_NAME = /^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/;

/** A cell as `{ v, f, s }`: plain values become cells, null stays empty. */
function normalizeCell(cell) {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'object' && !(cell instanceof Date)) return cell;
  return { v: cell };
}

function valueXml(ref, cell, style, strings) {
  const s = style ? ` s="${style}"` : '';
  const v = cell.v;
  if (cell.f) {
    const f = `<f>${xml(String(cell.f).replace(/^=/, ''))}</f>`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}>${f}<v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b">${f}<v>${v ? 1 : 0}</v></c>`;
    if (v === null || v === undefined) return `<c r="${ref}"${s}>${f}</c>`;
    return `<c r="${ref}"${s} t="str">${f}<v>${xml(v)}</v></c>`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Cell ${ref} holds a number that is not finite`);
    return `<c r="${ref}"${s}><v>${v}</v></c>`;
  }
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (v === null || v === undefined || v === '') return style ? `<c r="${ref}"${s}/>` : '';
  const text = String(v);
  if (text.length > 32767) throw new Error(`Cell ${ref} text exceeds 32767 characters`);
  return `<c r="${ref}"${s} t="s"><v>${strings.index(text)}</v></c>`;
}

function sharedStrings() {
  const list = [];
  const map = new Map();
  return {
    index(text) {
      if (!map.has(text)) { map.set(text, list.length); list.push(text); }
      return map.get(text);
    },
    xml(count) {
      return `${XML}<sst xmlns="${MAIN}" count="${count}" uniqueCount="${list.length}">${list.map((t) => `<si><t xml:space="preserve">${xml(t)}</t></si>`).join('')}</sst>`;
    },
  };
}

/** Columns and width of a range 'A1:C9': { r0, c0, r1, c1 }. */
export function parseRange(range) {
  const [a, b = a] = String(range).split(':');
  const [r0, c0] = parseRef(a);
  const [r1, c1] = parseRef(b);
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

function rangeText({ r0, c0, r1, c1 }) { return `${cellRef(r0, c0)}:${cellRef(r1, c1)}`; }

function autoWidth(rows, col) {
  let max = 8;
  for (const row of rows) {
    const cell = normalizeCell(row?.[col]);
    if (!cell || cell.span) continue;
    const v = cell.v;
    const len = typeof v === 'number' ? String(Math.round(v * 100) / 100).length + 2 : String(v ?? '').length;
    if (len > max) max = len;
  }
  return Math.min(60, max + 2);
}

/**
 * Build an .xlsx from a workbook model.
 *
 * ```
 * {
 *   title, creator, created: Date,        // document properties; `created` also dates the ZIP entries
 *   active: 0,                            // the sheet shown when opened
 *   names: [{ name, ref: "Settings!$B$3" }],
 *   sheets: [{
 *     name,
 *     rows: [[cell, …], …],               // cell: null | string | number | boolean | { v, f, s, span }
 *     widths: [12, 30, …],                // characters; missing ones fit the content
 *     freeze: { rows: 1, cols: 0 },
 *     merges: ['A1:F1'],
 *     tables: [{ name, ref: 'A7:M30' }],  // first row of ref is the header; columns are its texts
 *     highlight: [{ ref: 'A2:R40', formula: '$P2<>"OK"', style: 'flag' }],
 *     landscape: true,
 *   }],
 * }
 * ```
 * A formula cell `{ f: 'SUM(A1:A3)', v: 6 }` keeps `v` as its cached result,
 * so readers that do not calculate still show it; Excel recalculates on open.
 */
export function buildWorkbook(model) {
  const used = new Set();
  const created = model.created instanceof Date && !Number.isNaN(model.created.getTime()) ? model.created : new Date(Date.UTC(2000, 0, 1));
  const strings = sharedStrings();
  let stringCells = 0;
  const countingStrings = { index(text) { stringCells += 1; return strings.index(text); } };
  const tableNames = new Set();
  let tableId = 0;
  const sheets = (model.sheets || []).map((sheet) => ({ ...sheet, name: safeSheetName(sheet.name, used) }));
  if (!sheets.length) throw new Error('A workbook needs at least one sheet');
  const entries = [];
  const tableParts = [];
  const sheetXml = sheets.map((sheet, index) => {
    const rows = sheet.rows || [];
    if (rows.length > MAX_ROWS) throw new Error('Excel worksheet row limit exceeded');
    const width = rows.reduce((max, row) => Math.max(max, row?.length || 0), 1);
    if (width > MAX_COLUMNS) throw new Error('Excel worksheet column limit exceeded');
    const tables = (sheet.tables || []).map((table) => {
      if (!TABLE_NAME.test(table.name) || /^[A-Za-z]{1,3}\d+$/.test(table.name) || /^[RC]$/i.test(table.name)) {
        throw new Error(`Not a valid table name: ${table.name}`);
      }
      if (tableNames.has(table.name.toLowerCase())) throw new Error(`Duplicate table name: ${table.name}`);
      tableNames.add(table.name.toLowerCase());
      const range = parseRange(table.ref);
      // A table holds a header and at least one data row.
      if (range.r1 === range.r0) range.r1 += 1;
      const header = rows[range.r0] || [];
      const seen = new Set();
      const columns = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const cell = normalizeCell(header[c]);
        const name = typeof cell?.v === 'string' ? cell.v.trim() : '';
        if (!name || cell.f) throw new Error(`Table ${table.name}: header ${cellRef(range.r0, c)} must be text`);
        if (seen.has(name.toLowerCase())) throw new Error(`Table ${table.name}: duplicate column "${name}"`);
        seen.add(name.toLowerCase());
        columns.push(name);
      }
      return { id: ++tableId, name: table.name, range, columns, style: table.style || 'TableStyleLight9' };
    });
    const widths = Array.from({ length: width }, (_, c) => (Number(sheet.widths?.[c]) > 0 ? Number(sheet.widths[c]) : autoWidth(rows, c)));
    const cols = widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`).join('');
    const rowXml = rows.map((row, r) => {
      const cells = (row || []).map((raw, c) => {
        const cell = normalizeCell(raw);
        if (!cell) return '';
        const style = cell.s ? STYLE_INDEX.get(cell.s) : 0;
        if (style === undefined) throw new Error(`Unknown cell style "${cell.s}"`);
        return valueXml(cellRef(r, c), cell, style, countingStrings);
      }).join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    }).join('');
    const lastRow = Math.max(1, rows.length, ...tables.map((t) => t.range.r1 + 1));
    const dimension = `A1:${cellRef(lastRow - 1, width - 1)}`;
    const freezeRows = Math.max(0, Number(sheet.freeze?.rows) || 0);
    const freezeCols = Math.max(0, Number(sheet.freeze?.cols) || 0);
    let pane = '';
    if (freezeRows || freezeCols) {
      const activePane = freezeRows && freezeCols ? 'bottomRight' : freezeRows ? 'bottomLeft' : 'topRight';
      pane = `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freezeRows ? ` ySplit="${freezeRows}"` : ''} topLeftCell="${cellRef(freezeRows, freezeCols)}" activePane="${activePane}" state="frozen"/>`
        + `<selection pane="${activePane}" activeCell="${cellRef(freezeRows, freezeCols)}" sqref="${cellRef(freezeRows, freezeCols)}"/>`;
    }
    const selected = index === (model.active || 0) ? ' tabSelected="1"' : '';
    const merges = (sheet.merges || []).map((m) => `<mergeCell ref="${rangeText(parseRange(m))}"/>`);
    let priority = 0;
    const highlight = (sheet.highlight || []).map((h) => {
      const dxf = DXF[h.style || 'flag'];
      if (dxf === undefined) throw new Error(`Unknown highlight style "${h.style}"`);
      return `<conditionalFormatting sqref="${rangeText(parseRange(h.ref))}"><cfRule type="expression" dxfId="${dxf}" priority="${++priority}"><formula>${xml(String(h.formula).replace(/^=/, ''))}</formula></cfRule></conditionalFormatting>`;
    }).join('');
    const rels = tables.map((t, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/table" Target="../tables/table${t.id}.xml"/>`).join('');
    if (tables.length) entries.push({ name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`, data: `${XML}<Relationships xmlns="${PACKAGE_REL}">${rels}</Relationships>` });
    for (const t of tables) {
      tableParts.push(t.id);
      const ref = rangeText(t.range);
      entries.push({ name: `xl/tables/table${t.id}.xml`, data: `${XML}<table xmlns="${MAIN}" id="${t.id}" name="${t.name}" displayName="${t.name}" ref="${ref}" totalsRowShown="0">`
        + `<autoFilter ref="${ref}"/><tableColumns count="${t.columns.length}">${t.columns.map((c, i) => `<tableColumn id="${i + 1}" name="${xml(c)}"/>`).join('')}</tableColumns>`
        + `<tableStyleInfo name="${xml(t.style)}" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>` });
    }
    const fit = sheet.landscape !== false;
    return `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
      + `<sheetPr>${fit ? '<pageSetUpPr fitToPage="1"/>' : ''}</sheetPr>`
      + `<dimension ref="${dimension}"/>`
      + `<sheetViews><sheetView workbookViewId="0"${selected}>${pane}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + `<cols>${cols}</cols><sheetData>${rowXml}</sheetData>`
      + (merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '')
      + highlight
      + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>'
      + `<pageSetup orientation="${fit ? 'landscape' : 'portrait'}"${fit ? ' fitToWidth="1" fitToHeight="0"' : ''}/>`
      + (tables.length ? `<tableParts count="${tables.length}">${tables.map((_, i) => `<tablePart r:id="rId${i + 1}"/>`).join('')}</tableParts>` : '')
      + '</worksheet>';
  });
  sheetXml.forEach((data, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data }));
  const names = (model.names || []).map((n) => {
    if (!TABLE_NAME.test(n.name) || tableNames.has(n.name.toLowerCase())) throw new Error(`Not a valid defined name: ${n.name}`);
    return `<definedName name="${xml(n.name)}">${xml(n.ref)}</definedName>`;
  });
  const iso = created.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const head = [
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>`
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.worksheet+xml"/>`).join('')
      + tableParts.map((id) => `<Override PartName="/xl/tables/table${id}.xml" ContentType="${CT}.table+xml"/>`).join('')
      + `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>`
      + `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/>`
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>' },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="${PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`
      + `<Relationship Id="rId2" Type="${PACKAGE_REL}/metadata/core-properties" Target="docProps/core.xml"/>`
      + `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
      + `<dc:title>${xml(model.title || 'Workbook')}</dc:title><dc:creator>${xml(model.creator || '')}</dc:creator>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${xml(model.creator || '')}</Application></Properties>` },
    { name: 'xl/workbook.xml', data: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr/>`
      + `<bookViews><workbookView activeTab="${model.active || 0}"/></bookViews>`
      + `<sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
      + (names.length ? `<definedNames>${names.join('')}</definedNames>` : '')
      + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML}<Relationships xmlns="${PACKAGE_REL}">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId${sheets.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: stylesXml() },
    { name: 'xl/sharedStrings.xml', data: strings.xml(stringCells) },
  ];
  // The ZIP stores local time: give it the creation time's UTC fields so the
  // bytes do not depend on the machine's time zone.
  const zipDate = new Date(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate(),
    created.getUTCHours(), created.getUTCMinutes(), created.getUTCSeconds());
  return zipStore([...head, ...entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))], zipDate);
}

// A text cell a spreadsheet would run as a formula when the CSV is opened
// (CSV injection): it starts with = + - @, a tab or a carriage return.
const FORMULA_START = /^[=+\-@\t\r]/;
// A number written as text ("-12.5", "+3"): a value, not a formula.
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * CSV text (RFC 4180, CRLF line ends) from rows of plain values. A text
 * cell that would open as a formula gets a leading apostrophe, so it is
 * shown as text; numbers, also negative ones, stay numbers.
 */
export function csvText(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
    if (typeof v !== 'number' && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

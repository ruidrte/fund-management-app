/**
 * Serialising an extract.
 *
 * Two formats, because two different people ask for the same data:
 *
 *  - **CSV bundle** — one file per table plus a manifest, zipped. Canonical and
 *    lossless; what you hand to whoever is loading it into another system.
 *  - **XLSX** — one workbook, one sheet per table. What a person opens.
 *
 * The XLSX is written directly rather than through a spreadsheet library. A
 * workbook is a zip of a handful of XML parts, and the alternative was a
 * dependency tree carrying its own advisories into an application whose whole
 * purpose is handling confidential investor data.
 */

import { zipSync, strToU8 } from 'fflate';
import type { Extract, Sheet } from './extract';

export type CellValue = string | number | null;

/* ------------------------------------------------------------------ *
 * Formula injection
 *
 * A spreadsheet cell beginning `=`, `+`, `-`, `@`, tab or carriage return is
 * executed as a formula when the file is opened in Excel or Sheets. Fund names,
 * sources and descriptions in this system come from imported documents and are
 * not trusted input, so every text cell is neutralised on the way out — in both
 * formats, because an XLSX cell behaves the same way.
 *
 * The guard is a leading apostrophe, which spreadsheets strip on display: the
 * value still reads correctly, it just no longer executes.
 * ------------------------------------------------------------------ */

const DANGEROUS_LEAD = /^[=+\-@\t\r]/;

export function neutralise(value: CellValue): CellValue {
  if (typeof value !== 'string') return value;
  return DANGEROUS_LEAD.test(value) ? `'${value}` : value;
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

export function toCsv(sheet: Sheet): string {
  const lines = [sheet.columns.map(csvCell).join(',')];
  for (const row of sheet.rows) {
    lines.push(row.map((cell) => csvCell(neutralise(cell))).join(','));
  }
  // CRLF and a trailing newline: RFC 4180, and what Excel expects on import.
  return `${lines.join('\r\n')}\r\n`;
}

function csvCell(value: CellValue): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Quote when the value contains a delimiter, a quote or a newline. Doubling
  // the quote is how RFC 4180 escapes one.
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** The whole extract as a zip of CSVs plus the manifest. */
export function toCsvBundle(extract: Extract): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'MANIFEST.txt': strToU8(extract.manifest),
  };
  for (const sheet of extract.sheets) {
    files[`${sheet.name}.csv`] = strToU8(toCsv(sheet));
  }
  return zipSync(files, { level: 6 });
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

export function toXlsx(extract: Extract): Uint8Array {
  // The manifest becomes the first sheet, so the workbook explains itself.
  const sheets: Sheet[] = [manifestSheet(extract), ...extract.sheets];

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(sheets.length)),
    '_rels/.rels': strToU8(rootRels()),
    'xl/workbook.xml': strToU8(workbook(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels(sheets.length)),
    'xl/styles.xml': strToU8(styles()),
  };

  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheet(sheet));
  });

  return zipSync(files, { level: 6 });
}

function manifestSheet(extract: Extract): Sheet {
  return {
    name: 'manifest',
    description: 'What this extract contains and how to read it.',
    columns: ['Extract manifest'],
    rows: extract.manifest.split('\n').map((line) => [line] as CellValue[]),
  };
}

function contentTypes(sheetCount: number): string {
  const overrides = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function workbook(sheets: Sheet[]): string {
  const entries = sheets.map((sheet, index) =>
    `<sheet name="${xml(sheetName(sheet.name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${entries}</sheets>
</workbook>`;
}

function workbookRels(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

/** Two styles: a bold header, and everything else. */
function styles(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function worksheet(sheet: Sheet): string {
  const header = `<row r="1">${sheet.columns
    .map((column, index) => cell(index, 1, column, true))
    .join('')}</row>`;

  const body = sheet.rows.map((row, rowIndex) =>
    `<row r="${rowIndex + 2}">${row
      .map((value, columnIndex) => cell(columnIndex, rowIndex + 2, neutralise(value), false))
      .join('')}</row>`,
  ).join('');

  // Freeze the header row: these sheets are long and get scrolled.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>${header}${body}</sheetData>
</worksheet>`;
}

function cell(columnIndex: number, rowNumber: number, value: CellValue, bold: boolean): string {
  const reference = `${columnLetter(columnIndex)}${rowNumber}`;
  const style = bold ? ' s="1"' : '';

  if (value === null || value === undefined || value === '') {
    return `<c r="${reference}"${style}/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  // Inline strings avoid a shared-strings part: a larger file, but much less
  // machinery to get wrong for a one-shot extract.
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let letters = '';
  let remaining = index;
  while (remaining >= 0) {
    letters = String.fromCharCode((remaining % 26) + 65) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return letters;
}

/**
 * Excel sheet names cannot exceed 31 characters or contain : \ / ? * [ ].
 * Breaking either rule makes the whole workbook unopenable, with no indication
 * of which sheet was at fault.
 */
export function sheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters other than tab, newline and carriage return are not
    // legal in XML 1.0 at all, and make the file unreadable rather than ugly.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Triggers a download in the browser. */
export function download(data: Uint8Array | string, filename: string, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

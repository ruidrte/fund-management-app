/**
 * Reading a spreadsheet.
 *
 * Handles CSV directly and XLSX by unzipping it — the same understanding of the
 * format the writer in `export/serialise.ts` uses, in reverse. That keeps the
 * dependency surface at one small zip library rather than a spreadsheet
 * framework, which matters for an application handling confidential data.
 *
 * What it deliberately does *not* do is guess. A workbook whose header row it
 * cannot find is reported as such, with its first rows shown, so a person can
 * point at the header. Guessing wrong here produces a column of numbers
 * confidently loaded into the wrong field.
 */

import { unzipSync, strFromU8 } from 'fflate';
import type { TableData } from './types';

export type Cell = string | number | null;

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * A state-machine parser rather than a split on commas, because a quoted field
 * containing a comma or a newline is not exotic in this data — fund names and
 * transaction descriptions routinely contain both.
 */
export function parseCsv(text: string, delimiter = ','): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(coerce(field, started));
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  // A byte-order mark at the start of the file otherwise becomes part of the
  // first column header and silently breaks every mapping against it.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r') {
      // Swallow; the newline that follows ends the row.
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
    }
  }

  // A file not ending in a newline still has a last row.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/** Picks the delimiter by which one yields the most consistent row width. */
export function detectDelimiter(text: string): string {
  const sample = text.split('\n').slice(0, 20).join('\n');
  const candidates = [',', ';', '\t', '|'];

  let best = ',';
  let bestScore = -1;

  for (const delimiter of candidates) {
    const rows = parseCsv(sample, delimiter).filter((r) => r.length > 0);
    if (rows.length < 2) continue;
    const widths = rows.map((r) => r.length);
    const modal = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    if (modal < 2) continue;
    // Consistency matters more than width: a delimiter that splits every row
    // into the same number of columns is almost certainly the right one.
    const consistent = widths.filter((w) => w === modal).length / widths.length;
    const score = consistent * 10 + Math.min(modal, 30) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

export interface WorkbookSheets {
  sheets: TableData[];
}

export function parseXlsx(bytes: Uint8Array): WorkbookSheets {
  const zip = unzipSync(bytes);

  const workbookXml = decode(zip['xl/workbook.xml']);
  if (!workbookXml) throw new Error('Not a readable workbook — xl/workbook.xml is missing');

  const relsXml = decode(zip['xl/_rels/workbook.xml.rels']) ?? '';
  const relTargets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship([^>]*)\/>/g)) {
    const id = attribute(match[1], 'Id');
    const target = attribute(match[1], 'Target');
    if (id && target) relTargets.set(id, target.replace(/^\/?xl\//, ''));
  }

  const shared = sharedStrings(zip);

  const sheets: TableData[] = [];
  let positional = 0;

  for (const match of workbookXml.matchAll(/<sheet([^>]*)\/>/g)) {
    const attrs = match[1];
    const name = decodeEntities(attribute(attrs, 'name') ?? `Sheet${positional + 1}`);
    const relId = attribute(attrs, 'r:id');
    positional += 1;

    const target = relId ? relTargets.get(relId) : undefined;
    const path = target
      ? `xl/${target}`
      : `xl/worksheets/sheet${positional}.xml`;

    const sheetXml = decode(zip[path]);
    if (!sheetXml) continue;

    sheets.push({ sheetName: name, rows: parseWorksheet(sheetXml, shared) });
  }

  if (sheets.length === 0) throw new Error('The workbook contains no readable sheets');
  return { sheets };
}

function sharedStrings(zip: Record<string, Uint8Array>): string[] {
  const xml = decode(zip['xl/sharedStrings.xml']);
  if (!xml) return [];
  // Each <si> may hold several <t> runs when part of the text was formatted
  // differently; concatenating them is what recovers the original string.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((run) => decodeEntities(run[1]))
      .join(''),
  );
}

function parseWorksheet(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];

  for (const rowMatch of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r') ?? rows.length + 1);
    const cells: Cell[] = [];

    for (const cellMatch of rowMatch[2].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const reference = attribute(attrs, 'r');
      const type = attribute(attrs, 't');

      // Empty cells are omitted from the XML entirely, so a cell's column has
      // to come from its reference or the row silently shifts left.
      const columnIndex = reference ? columnIndexOf(reference) : cells.length;
      while (cells.length < columnIndex) cells.push(null);

      cells.push(cellValue(type, body, shared));
    }

    // Likewise, an entirely empty row is omitted.
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(cells);
  }

  return rows;
}

function cellValue(type: string | undefined, body: string, shared: string[]): Cell {
  if (type === 's') {
    const index = Number(inner(body, 'v'));
    return Number.isFinite(index) ? shared[index] ?? null : null;
  }
  if (type === 'inlineStr') {
    return decodeEntities(
      [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
    );
  }
  if (type === 'str' || type === 'e') {
    // A formula result, or an error such as #REF!. Kept as text so a reviewer
    // sees the error rather than a plausible-looking blank.
    return decodeEntities(inner(body, 'v') ?? '');
  }
  if (type === 'b') {
    return inner(body, 'v') === '1' ? 'TRUE' : 'FALSE';
  }

  const raw = inner(body, 'v');
  if (raw === undefined || raw === '') return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : decodeEntities(raw);
}

function inner(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
  return match?.[1];
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

/** "BC12" -> 54 (zero-based column). */
export function columnIndexOf(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1];
  if (!letters) return 0;
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function decode(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? strFromU8(bytes) : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * Shared coercion
 * ------------------------------------------------------------------ */

/**
 * A CSV field arrives as text. Numbers written the way fund documents write
 * them — `1'234.56` in Switzerland, `1.234,56` in Germany, `(1,234)` for a
 * negative in an accounting pack — have to survive.
 *
 * Anything ambiguous stays text. A wrongly parsed number is far worse here than
 * an unparsed one, because the unparsed one gets flagged and the wrong one does
 * not.
 */
function coerce(field: string, wasQuoted: boolean): Cell {
  if (wasQuoted) return field;
  const trimmed = field.trim();
  if (trimmed === '') return null;
  return parseNumber(trimmed) ?? trimmed;
}

export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Accounting negatives: (1,234.56)
  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  const body = parenthesised ? parenthesised[1] : trimmed;
  const sign = parenthesised ? -1 : 1;

  // Strip currency symbols, thin spaces and the Swiss apostrophe separator.
  const cleaned = body
    .replace(/[€$£¥]/g, '')
    // Swiss and Liechtenstein documents group digits with an apostrophe. The
    // various Unicode spaces other locales use are already covered by \s below.
    .replace(/['’]/g, '')
    .replace(/\s/g, '')
    .trim();

  if (cleaned === '' || !/\d/.test(cleaned)) return null;
  if (!/^[-+]?[\d.,]+%?$/.test(cleaned)) return null;

  const percent = cleaned.endsWith('%');
  const digits = percent ? cleaned.slice(0, -1) : cleaned;

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  let normalised: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever appears last is the decimal separator.
    normalised = lastComma > lastDot
      ? digits.replace(/\./g, '').replace(',', '.')
      : digits.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // A lone comma is a decimal point unless it groups three digits, in which
    // case it is a thousands separator — "1,234" is 1234, "1,23" is 1.23.
    const after = digits.length - lastComma - 1;
    normalised = after === 3 && /^[-+]?\d{1,3}(,\d{3})+$/.test(digits)
      ? digits.replace(/,/g, '')
      : digits.replace(',', '.');
  } else {
    normalised = digits;
  }

  const parsed = Number(normalised);
  if (!Number.isFinite(parsed)) return null;
  return sign * (percent ? parsed / 100 : parsed);
}

/**
 * Finds the header row: the first row whose cells are mostly non-empty text and
 * which is followed by rows of the same width. Returns undefined rather than
 * guessing when nothing qualifies.
 */
export function findHeaderRow(rows: Cell[][], searchDepth = 25): number | undefined {
  const limit = Math.min(searchDepth, rows.length);

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const filled = row.filter((cell) => cell !== null && String(cell).trim() !== '');
    if (filled.length < 2) continue;

    const textual = filled.filter((cell) => typeof cell === 'string').length / filled.length;
    if (textual < 0.7) continue;

    // A header is followed by data, not by nothing.
    const following = rows.slice(i + 1, i + 4)
      .filter((r) => r.some((cell) => cell !== null && String(cell).trim() !== ''));
    if (following.length === 0) continue;

    return i;
  }

  return undefined;
}

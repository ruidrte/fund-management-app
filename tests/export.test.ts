import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildExtract } from '../src/export/extract';
import {
  columnLetter, neutralise, sheetName, toCsv, toCsvBundle, toXlsx,
} from '../src/export/serialise';
import { buildDemoDataSet, DEMO_TIMELINE } from './fixtures/portfolio';

const dataset = buildDemoDataSet('client-ebg');

describe('formula injection', () => {
  it('neutralises every lead character a spreadsheet would execute', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(neutralise(`${lead}cmd|' /c calc'!A1`)).toBe(`'${lead}cmd|' /c calc'!A1`);
    }
  });

  it('leaves ordinary text and numbers alone', () => {
    expect(neutralise('Nordic Growth Partners IV')).toBe('Nordic Growth Partners IV');
    // A negative number is a number, not a string, so it is never touched.
    expect(neutralise(-1234.5)).toBe(-1234.5);
    expect(neutralise(null)).toBeNull();
  });

  it('carries the defence into the CSV output', () => {
    const csv = toCsv({
      name: 't', description: '', columns: ['a'],
      rows: [['=HYPERLINK("http://x","click")']],
    });
    expect(csv).toContain(`"'=HYPERLINK`);
  });
});

describe('CSV', () => {
  it('quotes and escapes per RFC 4180', () => {
    const csv = toCsv({
      name: 't', description: '', columns: ['a', 'b'],
      rows: [['has, comma', 'has "quote"'], ['has\nnewline', null]],
    });
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quote"""');
    expect(csv).toContain('"has\nnewline"');
    // A null renders as an empty field, not the string "null".
    expect(csv).not.toContain('null');
  });
});

describe('XLSX geometry', () => {
  it('maps column indices past Z', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
    expect(columnLetter(701)).toBe('ZZ');
  });

  it('keeps sheet names inside what Excel will open', () => {
    expect(sheetName('position_valuations')).toBe('position_valuations');
    expect(sheetName('a/b:c*d?e[f]g')).toBe('a_b_c_d_e_f_g');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
  });
});

describe('extract', () => {
  const extract = buildExtract({
    dataset,
    window: { kind: 'since-inception', period: '2026Q1' },
    vehicleId: 'veh-abif',
  });

  it('carries every fact table plus the derived sheets', () => {
    const names = extract.sheets.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'vehicles', 'positions', 'assets', 'investors',
      'position_valuations', 'asset_valuations', 'cashflows',
      'balance_sheets', 'fx_rates', 'derived_by_quarter', 'position_history',
    ]));
  });

  it('carries recorded_at on every fact sheet', () => {
    const factSheets = ['position_valuations', 'asset_valuations', 'cashflows', 'balance_sheets', 'fx_rates'];
    for (const name of factSheets) {
      const sheet = extract.sheets.find((s) => s.name === name)!;
      // Without it the extract cannot reproduce a past quarter, which is
      // usually the reason it was asked for.
      expect(sheet.columns).toContain('recorded_at');
      expect(sheet.rows.length).toBeGreaterThan(0);
    }
  });

  it('keeps superseded valuations and flags them', () => {
    const sheet = extract.sheets.find((s) => s.name === 'position_valuations')!;
    const flagColumn = sheet.columns.indexOf('superseded');
    const superseded = sheet.rows.filter((row) => row[flagColumn] === 'yes');
    expect(superseded.length).toBeGreaterThan(0);
  });

  it('gives every row the same width as its header', () => {
    for (const sheet of extract.sheets) {
      for (const row of sheet.rows) {
        expect(row).toHaveLength(sheet.columns.length);
      }
    }
  });

  it('narrows to a single quarter when asked', () => {
    const one = buildExtract({
      dataset,
      window: { kind: 'period', period: '2025Q4' },
      vehicleId: 'veh-abif',
    });
    const sheet = one.sheets.find((s) => s.name === 'position_valuations')!;
    const periodColumn = sheet.columns.indexOf('period');
    expect(new Set(sheet.rows.map((r) => r[periodColumn]))).toEqual(new Set(['2025Q4']));
    expect(one.periods).toEqual(['2025Q4']);
  });

  it('honours the as-at date, excluding later restatements', () => {
    const pinned = buildExtract({
      dataset,
      window: { kind: 'since-inception', period: '2025Q4' },
      vehicleId: 'veh-abif',
      knowledgeDate: DEMO_TIMELINE.DRAFT_CUT,
    });
    const now = buildExtract({
      dataset,
      window: { kind: 'since-inception', period: '2025Q4' },
      vehicleId: 'veh-abif',
    });
    const rows = (e: typeof pinned) => e.sheets.find((s) => s.name === 'position_valuations')!.rows.length;
    expect(rows(pinned)).toBeLessThan(rows(now));
    expect(pinned.manifest).toContain('later restatements are excluded');
  });

  it('states in the manifest what was extracted', () => {
    expect(extract.manifest).toContain('EBG Investment Solutions');
    expect(extract.manifest).toContain('Since inception through Q1 2026');
    expect(extract.manifest).toContain('money out is negative');
  });
});

describe('serialised output', () => {
  const extract = buildExtract({
    dataset,
    window: { kind: 'range', from: '2025Q1', period: '2026Q1' },
    vehicleId: 'veh-abif',
  });

  it('produces a CSV bundle with one file per sheet plus a manifest', () => {
    const zip = unzipSync(toCsvBundle(extract));
    const names = Object.keys(zip);
    expect(names).toContain('MANIFEST.txt');
    for (const sheet of extract.sheets) {
      expect(names).toContain(`${sheet.name}.csv`);
    }
    const header = strFromU8(zip['positions.csv']).split('\r\n')[0];
    expect(header).toBe(extract.sheets.find((s) => s.name === 'positions')!.columns.join(','));
  });

  it('produces a workbook with every part Excel requires', () => {
    const zip = unzipSync(toXlsx(extract));
    const names = Object.keys(zip);
    expect(names).toEqual(expect.arrayContaining([
      '[Content_Types].xml', '_rels/.rels',
      'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    ]));

    // One worksheet part per sheet, plus the manifest sheet prepended.
    const worksheets = names.filter((n) => n.startsWith('xl/worksheets/'));
    expect(worksheets).toHaveLength(extract.sheets.length + 1);

    // Every declared relationship resolves to a part that exists.
    const rels = strFromU8(zip['xl/_rels/workbook.xml.rels']);
    for (const target of [...rels.matchAll(/Target="([^"]+)"/g)].map((m) => m[1])) {
      expect(names).toContain(`xl/${target}`);
    }

    // Every sheet declared in the workbook has a matching relationship id.
    const book = strFromU8(zip['xl/workbook.xml']);
    const ids = [...book.matchAll(/r:id="(rId\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(extract.sheets.length + 1);
    for (const id of ids) expect(rels).toContain(`Id="${id}"`);
  });

  it('writes numbers as numbers and text as inline strings', () => {
    const zip = unzipSync(toXlsx(extract));
    const sheetIndex = extract.sheets.findIndex((s) => s.name === 'positions') + 2;
    const xmlText = strFromU8(zip[`xl/worksheets/sheet${sheetIndex}.xml`]);
    expect(xmlText).toContain('t="inlineStr"');
    expect(xmlText).toMatch(/<v>\d/);
    // The header row is frozen so long sheets stay readable.
    expect(xmlText).toContain('state="frozen"');
  });

  it('escapes XML metacharacters rather than corrupting the workbook', () => {
    const hostile = buildExtract({
      dataset: {
        ...dataset,
        positions: dataset.positions.map((p, i) =>
          i === 0 ? { ...p, name: 'Ampersand & <script>alert("x")</script>' } : p),
      },
      window: { kind: 'period', period: '2026Q1' },
      vehicleId: 'veh-abif',
    });
    const zip = unzipSync(toXlsx(hostile));
    const sheetIndex = hostile.sheets.findIndex((s) => s.name === 'positions') + 2;
    const xmlText = strFromU8(zip[`xl/worksheets/sheet${sheetIndex}.xml`]);
    expect(xmlText).toContain('&amp;');
    expect(xmlText).toContain('&lt;script&gt;');
    expect(xmlText).not.toContain('<script>');
  });
});

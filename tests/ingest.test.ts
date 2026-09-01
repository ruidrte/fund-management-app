import { describe, expect, it } from 'vitest';
import { matchEntity, normalise, similarity } from '../src/ingest/match';
import {
  detectDelimiter, findHeaderRow, parseCsv, parseNumber, parseXlsx,
} from '../src/ingest/workbook';
import {
  classifyCashflow, historicalWorkbookExtractor, mapColumns, navPackExtractor,
  parseDate, transactionNoticeExtractor,
} from '../src/ingest/extractors';
import { canCommit, validateAll } from '../src/ingest/validate';
import { toXlsx } from '../src/export/serialise';
import { buildExtract } from '../src/export/extract';
import { buildDemoDataSet } from '../src/data/demo';
import type { MatchContext, SourceDocument } from '../src/ingest/types';

const dataset = buildDemoDataSet('client-meridian');

const context: MatchContext = {
  clientId: dataset.client.id,
  vehicles: dataset.vehicles.map((v) => ({
    id: v.id, name: v.name, shortName: v.shortName, currency: v.currency,
  })),
  positions: dataset.positions.map((p) => ({
    id: p.id, vehicleId: p.vehicleId, name: p.name, currency: p.currency,
  })),
  investors: dataset.investors.map((i) => ({
    id: i.id, vehicleId: i.vehicleId, name: i.name, currency: i.currency,
  })),
  assets: dataset.assets.map((a) => ({ id: a.id, positionId: a.positionId, name: a.name })),
};

const doc = (over: Partial<SourceDocument> = {}): SourceDocument => ({
  id: 'doc-1', clientId: dataset.client.id, kind: 'historical-workbook',
  name: 'Q1 2026 positions.xlsx', mimeType: 'application/vnd.ms-excel',
  sizeBytes: 1024, contentHash: 'abc', uploadedAt: '2026-04-20T09:00:00Z',
  status: 'uploaded', ...over,
});

describe('number parsing across the formats fund documents actually use', () => {
  it('reads the separators of every locale these documents come from', () => {
    expect(parseNumber('1,234.56')).toBeCloseTo(1234.56);      // UK / US
    expect(parseNumber('1.234,56')).toBeCloseTo(1234.56);      // DE / PT
    expect(parseNumber("1'234.56")).toBeCloseTo(1234.56);      // CH
    expect(parseNumber('1 234,56')).toBeCloseTo(1234.56);      // FR
    expect(parseNumber('1234')).toBe(1234);
  });

  it('reads accounting negatives', () => {
    expect(parseNumber('(1,234.56)')).toBeCloseTo(-1234.56);
    expect(parseNumber('(500)')).toBe(-500);
  });

  it('strips currency symbols and percent', () => {
    expect(parseNumber('€ 1,000')).toBe(1000);
    expect(parseNumber('12.5%')).toBeCloseTo(0.125);
  });

  it('distinguishes a thousands comma from a decimal comma', () => {
    expect(parseNumber('1,234')).toBe(1234);   // grouped
    expect(parseNumber('1,23')).toBeCloseTo(1.23); // decimal
  });

  it('returns null rather than a wrong number for text', () => {
    expect(parseNumber('n/a')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('Nordic Growth')).toBeNull();
  });
});

describe('date parsing', () => {
  it('reads unambiguous forms', () => {
    expect(parseDate('2026-03-31')).toBe('2026-03-31');
    expect(parseDate('31 March 2026')).toBe('2026-03-31');
    expect(parseDate('31/03/2026')).toBe('2026-03-31');
    expect(parseDate('46112')).toBe('2026-03-31'); // Excel serial
  });

  it('refuses an ambiguous day/month rather than guessing', () => {
    // 03/04/2026 is 3 April or 4 March depending on where it was written, and a
    // wrong guess moves the cashflow into a different quarter.
    expect(parseDate('03/04/2026')).toBeNull();
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields containing delimiters and newlines', () => {
    const rows = parseCsv('a,b\n"Smith, John","line1\nline2"\n');
    expect(rows[1][0]).toBe('Smith, John');
    expect(rows[1][1]).toBe('line1\nline2');
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"""\n')[1][0]).toBe('say "hi"');
  });

  it('strips a byte-order mark from the first header', () => {
    expect(parseCsv('﻿Fund,NAV\nx,1\n')[0][0]).toBe('Fund');
  });

  it('detects the delimiter', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n4\t5\t6')).toBe('\t');
  });
});

describe('header detection and column mapping', () => {
  it('skips title rows and finds the real header', () => {
    const rows = [
      ['Meridian Capital Partners', null, null],
      ['Portfolio as at 31 March 2026', null, null],
      [],
      ['Fund Name', 'Commitment (EUR)', 'NAV'],
      ['Nordic Growth Partners IV', 15000, 13300],
    ];
    expect(findHeaderRow(rows)).toBe(3);
  });

  it('returns undefined rather than guessing when nothing qualifies', () => {
    expect(findHeaderRow([[1, 2, 3], [4, 5, 6]])).toBeUndefined();
  });

  it('recognises the synonyms different administrators use', () => {
    const { columns } = mapColumns([
      'Investment Name', 'Total Commitment', 'Paid-In', 'Cumulative Distributions',
      'Net Asset Value', 'CCY',
    ]);
    expect(columns.name).toBe(0);
    expect(columns.commitment).toBe(1);
    expect(columns.drawn).toBe(2);
    expect(columns.distributed).toBe(3);
    expect(columns.nav).toBe(4);
    expect(columns.currency).toBe(5);
  });

  it('reports headers it does not recognise rather than dropping them silently', () => {
    const { unmapped } = mapColumns(['Fund', 'NAV', 'Internal Ref Code']);
    expect(unmapped).toContain('Internal Ref Code');
  });
});

describe('entity matching', () => {
  it('matches through legal-form suffixes and case', () => {
    expect(similarity('Nordic Growth Partners IV SCSp', 'Nordic Growth Partners IV')).toBeGreaterThan(0.9);
    expect(similarity('NORDIC GROWTH PARTNERS IV (EUR)', 'Nordic Growth Partners IV')).toBeGreaterThan(0.9);
  });

  it('strips accents', () => {
    expect(normalise('Société Générale')).toBe('societe generale');
  });

  it('treats a different fund number as a different fund', () => {
    // The single most dangerous near-match in this data.
    const score = similarity('Nordic Growth Partners III', 'Nordic Growth Partners IV');
    expect(score).toBeLessThan(0.5);
  });

  it('equates roman and arabic numerals', () => {
    expect(similarity('Atlantic Buyout Fund VII', 'Atlantic Buyout Fund 7')).toBeGreaterThan(0.9);
  });

  it('proposes a confident match with its alternatives', () => {
    const match = matchEntity('Nordic Growth Partners IV SCSp', 'position', context);
    expect(match.matchedName).toBe('Nordic Growth Partners IV');
    expect(match.confidence).toBeGreaterThan(0.85);
    expect(match.alternatives.length).toBeGreaterThan(0);
  });

  it('refuses to match an unknown name rather than picking the nearest', () => {
    const match = matchEntity('Completely Unrelated Vehicle SA', 'position', context);
    expect(match.id).toBeUndefined();
  });
});

describe('historical workbook extraction', () => {
  it('reads valuations and matches them to holdings', async () => {
    const result = await historicalWorkbookExtractor.extract({
      document: doc(),
      context,
      period: '2026Q1',
      table: {
        sheetName: 'Positions',
        rows: [
          ['Meridian Private Markets Fund II', null, null, null],
          ['Portfolio as at 31 March 2026', null, null, null],
          ['Fund Name', 'Commitment', 'Paid-In', 'Net Asset Value'],
          ['Nordic Growth Partners IV SCSp', 15000, 11300, 13300],
          ['Atlantic Buyout Fund VII', 15700, 13100, 10700],
          ['Total', 30700, 24400, 24000],
        ],
      },
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].match?.matchedName).toBe('Nordic Growth Partners IV');
    expect(result.candidates[0].fields.nav.value).toBe(13300);
    expect(result.candidates[0].fields.nav.locator).toBe('D4');
    // The total row must not become a holding.
    expect(result.candidates.map((c) => c.match?.sourceName)).not.toContain('Total');
  });

  it('refuses rather than guessing when it cannot find a header', async () => {
    const result = await historicalWorkbookExtractor.extract({
      document: doc(), context,
      table: { sheetName: 'x', rows: [[1, 2], [3, 4]] },
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.summary).toMatch(/header row/i);
  });

  it('reports rows it could not read instead of dropping them', async () => {
    const result = await historicalWorkbookExtractor.extract({
      document: doc(), context, period: '2026Q1',
      table: {
        sheetName: 'x',
        rows: [
          ['Fund Name', 'Net Asset Value'],
          ['Nordic Growth Partners IV', 13300],
          ['Helios Infrastructure II', 'n/a'],
        ],
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.unparsed.join(' ')).toMatch(/Helios/);
  });
});

describe('transaction notices', () => {
  it('classifies movements from their wording', () => {
    expect(classifyCashflow('Capital Call No. 7', 100).type).toBe('Capital Call');
    expect(classifyCashflow('Distribution - realisation of Asset A', 100).type).toBe('Distribution');
    expect(classifyCashflow('Management fee', 100).type).toBe('Fee');
  });

  it('falls back to the sign at a confidence that says it is an inference', () => {
    const guessed = classifyCashflow('Movement', -100);
    expect(guessed.type).toBe('Capital Call');
    expect(guessed.confidence).toBeLessThan(0.5);
  });

  it('reads a PDF-style notice as text and flags every field for confirmation', async () => {
    const result = await transactionNoticeExtractor.extract({
      document: doc({ kind: 'transaction-notice', name: 'drawdown.pdf' }),
      context,
      text: [
        'NORDIC GROWTH PARTNERS IV SCSp',
        'CAPITAL CALL NOTICE',
        'Date: 31 March 2026',
        'Total amount due: EUR 600,000.00',
      ].join('\n'),
    });

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.fields.type.value).toBe('Capital Call');
    // A call is money out of the vehicle.
    expect(candidate.fields.amount.value).toBe(-600000);
    expect(candidate.fields.date.value).toBe('2026-03-31');
    expect(candidate.fields.currency.value).toBe('EUR');
    // Nothing read out of prose is presented as settled.
    expect(candidate.fields.amount.confidence).toBeLessThan(0.9);
  });

  it('says so plainly when it cannot find a movement', async () => {
    const result = await transactionNoticeExtractor.extract({
      document: doc({ kind: 'transaction-notice' }), context,
      text: 'Dear Partner, please find enclosed our quarterly commentary.',
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.summary).toMatch(/manually/i);
  });
});

describe('administrator NAV pack', () => {
  it('classifies balance-sheet lines and lists what it did', async () => {
    const result = await navPackExtractor.extract({
      document: doc({ kind: 'nav-pack', name: 'Meridian Private Markets Fund II TB.xlsx' }),
      context,
      period: '2026Q1',
      table: {
        sheetName: 'Trial Balance',
        rows: [
          ['Account', 'Balance'],
          ['Cash at bank', 1800],
          ['Other receivables', 300],
          ['Accounts payable', -300],
          ['Accrued management fee', -200],
          ['Investments at fair value', 58700],
        ],
      },
    });

    expect(result.candidates).toHaveLength(1);
    const fields = result.candidates[0].fields;
    expect(fields.cash.value).toBe(1800);
    expect(fields.otherAssets.value).toBe(300);
    // Liabilities are stored positive; the engine subtracts them.
    expect(fields.currentLiabilities.value).toBe(300);
    expect(fields.accruedExpenses.value).toBe(200);
    // The portfolio line is not a balance-sheet bucket and must be reported,
    // not silently folded into one.
    expect(result.unparsed.join(' ')).toMatch(/Investments at fair value/);
    expect(result.unparsed.join(' ')).toMatch(/Classified: Cash at bank/);
  });
});

describe('vehicle-level documents target the scoped vehicle', () => {
  it('uses the vehicle in scope rather than reading the filename', async () => {
    const result = await navPackExtractor.extract({
      // A filename that names nothing, which is the normal case.
      document: doc({ kind: 'nav-pack', name: 'TB_export_final_v3.xlsx' }),
      context,
      period: '2026Q1',
      vehicleId: 'veh-meridian-pf-ii',
      table: {
        sheetName: 'TB',
        rows: [['Account', 'Balance'], ['Cash at bank', 1800]],
      },
    });
    expect(result.candidates[0].match?.id).toBe('veh-meridian-pf-ii');
    expect(result.candidates[0].match?.confidence).toBe(1);
  });
});

describe('validation', () => {
  it('does not warn about fields nobody would check', () => {
    // Warning on a description or a derived flag buries the warnings that
    // matter, which is how a review step stops being read.
    const [candidate] = validateAll([{
      id: 'c0', documentId: 'doc-1', kind: 'cashflow',
      fields: {
        amount: { value: -100, confidence: 1 },
        date: { value: '2026-03-31', confidence: 1 },
        period: { value: '2026Q1', confidence: 1 },
        currency: { value: 'EUR', confidence: 1 },
        description: { value: 'Notice', confidence: 0.4 },
        affectsCommitment: { value: true, confidence: 0.5 },
        source: { value: 'file.pdf', confidence: 0.3 },
      },
      issues: [], state: 'pending',
    }], dataset);

    expect(candidate.issues.filter((i) => /confidence/.test(i.message))).toEqual([]);
  });

  it('blocks a candidate whose holding did not match', () => {
    const [candidate] = validateAll([{
      id: 'c1', documentId: 'doc-1', kind: 'position-valuation',
      fields: {
        period: { value: '2026Q1', confidence: 1 },
        nav: { value: 1000, confidence: 1 },
      },
      match: {
        kind: 'position', sourceName: 'Unknown Fund', confidence: 0, alternatives: [],
      },
      issues: [], state: 'pending',
    }], dataset);

    expect(canCommit(candidate)).toBe(false);
    expect(candidate.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('flags a large unexplained move without blocking it', () => {
    const position = dataset.positions[0];
    const [candidate] = validateAll([{
      id: 'c2', documentId: 'doc-1', kind: 'position-valuation',
      fields: {
        period: { value: '2026Q1', confidence: 1 },
        nav: { value: 99000, confidence: 1 },
      },
      match: {
        kind: 'position', id: position.id, sourceName: position.name,
        matchedName: position.name, confidence: 1, alternatives: [],
      },
      issues: [], state: 'pending',
    }], dataset);

    expect(canCommit(candidate)).toBe(true);
    expect(candidate.issues.some((i) => /moves/.test(i.message))).toBe(true);
  });

  it('blocks a cashflow whose date and period disagree', () => {
    const [candidate] = validateAll([{
      id: 'c3', documentId: 'doc-1', kind: 'cashflow',
      fields: {
        amount: { value: -100, confidence: 1 },
        date: { value: '2026-03-31', confidence: 1 },
        period: { value: '2026Q2', confidence: 1 },
        currency: { value: 'EUR', confidence: 1 },
      },
      issues: [], state: 'pending',
    }], dataset);

    expect(canCommit(candidate)).toBe(false);
    expect(candidate.issues.some((i) => /falls in 2026Q1/.test(i.message))).toBe(true);
  });

  it('rejects a future period', () => {
    const [candidate] = validateAll([{
      id: 'c4', documentId: 'doc-1', kind: 'position-valuation',
      fields: {
        period: { value: '2099Q1', confidence: 1 },
        nav: { value: 1000, confidence: 1 },
      },
      issues: [], state: 'pending',
    }], dataset);
    expect(canCommit(candidate)).toBe(false);
  });

  it('spots a duplicate of an existing valuation', () => {
    const existing = dataset.positionValuations.find((v) => !v.supersededBy)!;
    const [candidate] = validateAll([{
      id: 'c5', documentId: 'doc-1', kind: 'position-valuation',
      fields: {
        period: { value: existing.period, confidence: 1 },
        nav: { value: existing.nav, confidence: 1 },
      },
      match: {
        kind: 'position', id: existing.positionId, sourceName: 'x',
        matchedName: 'x', confidence: 1, alternatives: [],
      },
      issues: [], state: 'pending',
    }], dataset);

    expect(candidate.duplicateOf).toBe(existing.id);
    expect(candidate.issues.some((i) => /double-count/.test(i.message))).toBe(true);
  });
});

describe('round trip: an export can be read back in', () => {
  it('parses a workbook this application wrote', async () => {
    const extract = buildExtract({
      dataset,
      window: { kind: 'period', period: '2026Q1' },
      vehicleId: 'veh-meridian-pf-ii',
      includeDerived: false,
    });
    const bytes = toXlsx(extract);

    const workbook = parseXlsx(bytes);
    const positions = workbook.sheets.find((s) => s.sheetName === 'positions');
    expect(positions).toBeDefined();
    expect(positions!.rows[0]).toContain('name');
    expect(positions!.rows.length).toBe(dataset.positions.length + 1);

    // And the values survive as values, not as strings.
    const valuations = workbook.sheets.find((s) => s.sheetName === 'position_valuations')!;
    const navColumn = valuations.rows[0].indexOf('nav');
    expect(typeof valuations.rows[1][navColumn]).toBe('number');
  });
});

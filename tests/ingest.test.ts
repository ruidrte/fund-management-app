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
import { applyCandidates, factsFrom, REVIEW_THRESHOLD } from '../src/ingest';
import { buildRateLookup } from '../src/engine/fx';
import { toXlsx } from '../src/export/serialise';
import { buildTemplate } from '../src/ingest/template';
import { buildExtract } from '../src/export/extract';
import { buildDemoDataSet } from '../src/data/demo';
import type { MatchContext, SourceDocument } from '../src/ingest/types';

const dataset = buildDemoDataSet('client-ebg');

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
      ['EBG Investment Solutions', null, null],
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
    const match = matchEntity('Circular Materials Venture II SCSp', 'position', context);
    expect(match.matchedName).toBe('Circular Materials Venture II');
    expect(match.confidence).toBeGreaterThan(0.85);
    expect(match.alternatives.length).toBeGreaterThan(0);
  });

  it('proposes a plausible near-miss without calling it confident', () => {
    // "Nordic Growth Partners IV" is not in this client's portfolio; the nearest
    // thing is "Global Growth Partners IV". Proposing it is useful — silently
    // treating it as settled is how a valuation lands on the wrong fund.
    const match = matchEntity('Nordic Growth Partners IV SCSp', 'position', context);
    expect(match.matchedName).toBe('Global Growth Partners IV');
    expect(match.confidence).toBeLessThan(0.88);
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
          ['Abendrot Impulse Fund', null, null, null],
          ['Portfolio as at 31 March 2026', null, null, null],
          ['Fund Name', 'Commitment', 'Paid-In', 'Net Asset Value'],
          ['European Impact Growth Fund III SCSp', 26000, 19400, 21300],
          ['Social Infrastructure Partners II', 24000, 17800, 18600],
          ['Total', 50000, 37200, 39900],
        ],
      },
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].match?.matchedName).toBe('European Impact Growth Fund III');
    expect(result.candidates[0].fields.nav.value).toBe(21300);
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
          ['Social Infrastructure Partners II', 'n/a'],
        ],
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.unparsed.join(' ')).toMatch(/Social Infrastructure/);
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

  it('finds the amount due in a real notice, not the date or the undrawn balance', async () => {
    // The shape a GP actually sends: a due *date*, several component amounts,
    // a total, and the remaining commitment — which is the largest number on
    // the page and is never what is being called.
    const notice = [
      'IMPULSE PARTNERS',
      'European Impact Growth Fund III SCSp',
      'CAPITAL CALL NOTICE No. 14',
      'To:      Abendrot Impulse Fund',
      'Date:    31 March 2026',
      'Due:     14 April 2026',
      'Description                          Amount (EUR)',
      "Investment in portfolio company Helios Bio    850'000.00",
      "Management fee, Q1 2026                       112'500.00",
      "Fund operating expenses                        37'500.00",
      "Total amount due                            1'000'000.00",
      'Your remaining undrawn commitment after this call: EUR 6,400,000.00',
    ].join('\n');

    const result = await transactionNoticeExtractor.extract({
      document: doc({ kind: 'transaction-notice', name: 'drawdown.pdf' }),
      context,
      text: notice,
    });

    expect(result.candidates).toHaveLength(1);
    const amount = result.candidates[0].fields.amount.value;
    // A call is money out of the vehicle.
    expect(amount).toBe(-1_000_000);
    // Not the day from "Due: 14 April", not a component, and not the undrawn
    // commitment — all three of which a naive reading picks up.
    expect(amount).not.toBe(-14);
    expect(amount).not.toBe(-850_000);
    expect(amount).not.toBe(-6_400_000);
    expect(result.candidates[0].fields.date.value).toBe('2026-03-31');
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
      vehicleId: 'veh-abif',
      table: {
        sheetName: 'TB',
        rows: [['Account', 'Balance'], ['Cash at bank', 1800]],
      },
    });
    expect(result.candidates[0].match?.id).toBe('veh-abif');
    expect(result.candidates[0].match?.confidence).toBe(1);
  });
});

describe('rates declared in the financials', () => {
  const pack = (rows: (string | number)[][]) => navPackExtractor.extract({
    document: doc({ kind: 'nav-pack', name: 'Q1 2026 trial balance.xlsx' }),
    context,
    period: '2026Q1',
    vehicleId: 'veh-abif',
    table: { sheetName: 'TB', rows: [['Account', 'Balance'], ['Cash at bank', 1800], ...rows] },
  });

  const rates = (result: Awaited<ReturnType<typeof pack>>) =>
    result.candidates.filter((c) => c.kind === 'fx-rate');

  it('reads a pair written the way a pack writes it', async () => {
    const result = await pack([
      ['EUR/USD as at 31.03.2026', 1.1523],
      ['EUR / CHF', 0.9323],
      ['1 EUR = 0.8626 GBP', ''],
    ]);
    expect(rates(result).map((c) => [c.fields.base.value, c.fields.quote.value, c.fields.rate.value]))
      .toEqual([['EUR', 'USD', 1.1523], ['EUR', 'CHF', 0.9323], ['EUR', 'GBP', 0.8626]]);
  });

  it('does not read a date as a rate', async () => {
    // "31.03.2026" contains 31.03, which is a perfectly good rate as far as a
    // regular expression is concerned.
    const result = await pack([['EUR/USD as at 31.03.2026', 1.1523]]);
    expect(rates(result)[0].fields.rate.value).toBe(1.1523);
  });

  it('refuses a rate whose direction is a guess, and says why', async () => {
    const result = await pack([['FX rate used for translation', 1.1523]]);
    expect(rates(result)).toHaveLength(0);
    expect(result.unparsed.join(' ')).toMatch(/names no currency pair/);
  });

  it('keeps the first sighting and reports a second that disagrees', async () => {
    const result = await pack([
      ['EUR/USD', 1.1523],
      ['Portfolio translated at EUR/USD', 1.1498],
    ]);
    expect(rates(result)).toHaveLength(1);
    expect(rates(result)[0].fields.rate.value).toBe(1.1523);
    expect(result.unparsed.join(' ')).toMatch(/appears again as 1.1498/);
  });

  it('leaves an ordinary balance sheet alone', async () => {
    const result = await pack([['Accrued management fee', -200], ['Investments at fair value', 58700]]);
    expect(rates(result)).toHaveLength(0);
  });

  it('files an accepted rate with the authority of the books', async () => {
    const result = await pack([['EUR/USD as at 31.03.2026', 1.1523]]);
    const accepted = result.candidates.map((c) => ({ ...c, state: 'accepted' as const }));
    const next = applyCandidates(dataset, accepted, result.document);

    const filed = next.fxRates.filter((r) => r.authority === 'administrator' && r.documentId === 'doc-1');
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ base: 'EUR', quote: 'USD', rate: 1.1523, period: '2026Q1', kind: 'closing' });

    // And it wins, which is the entire reason for reading it.
    expect(buildRateLookup(next.fxRates).rate('EUR', 'USD', '2026Q1')).toBe(1.1523);
  });

  it('warns when a declared rate contradicts what is already on file', async () => {
    const result = await pack([['EUR/USD as at 31.03.2026', 1.4]]);
    const [rate] = validateAll(rates(result), dataset).filter((c) => c.kind === 'fx-rate');
    expect(rate.issues.some((i) => /already on file/.test(i.message))).toBe(true);
    // A warning, not a block: the administrator's books can legitimately differ.
    expect(canCommit(rate)).toBe(true);
  });

  it('blocks a pair that names no currency this client uses', async () => {
    // Three capital letters separated by a slash is not proof of a rate.
    const result = await pack([['VAT/TAX', 1.05]]);
    const [rate] = validateAll(rates(result), dataset);
    expect(rate.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(canCommit(rate)).toBe(false);
  });
});

describe('seeding a book from a workbook', () => {
  const sheet = (rows: (string | number)[][]) => ({
    sheetName: 'Positions',
    rows: [['Fund', 'Currency', 'Commitment', 'Vintage', 'Region', 'NAV'], ...rows],
  });

  const read = (rows: (string | number)[][], createMissing: boolean) =>
    historicalWorkbookExtractor.extract({
      document: doc({ name: 'AbIF since inception.xlsx' }),
      context,
      period: '2026Q1',
      vehicleId: 'veh-abif',
      createMissing,
      table: sheet(rows),
    });

  it('leaves an unknown name unmatched when it was not asked to create', async () => {
    const result = await read([['Baltic Wind Partners II', 'EUR', 8000, 2022, 'Europe', 6400]], false);
    expect(result.candidates.map((c) => c.kind)).toEqual(['position-valuation']);
    expect(result.candidates[0].match?.id).toBeUndefined();
  });

  it('creates the holding and ties the row-s valuation to it', async () => {
    const result = await read([['Baltic Wind Partners II', 'EUR', 8000, 2022, 'Europe', 6400]], true);
    expect(result.candidates.map((c) => c.kind)).toEqual(['position', 'position-valuation']);

    const [position, valuationCandidate] = result.candidates;
    expect(position.fields.name.value).toBe('Baltic Wind Partners II');
    expect(position.fields.currency.value).toBe('EUR');
    expect(position.fields.commitment.value).toBe(8000);
    expect(position.fields.vintage.value).toBe(2022);
    expect(position.fields.vehicleId.value).toBe('veh-abif');
    // The valuation cannot carry an id that does not exist yet, so it carries
    // the dependency instead.
    expect(valuationCandidate.dependsOn).toBe(position.id);
    expect(valuationCandidate.match).toBeUndefined();
  });

  it('marks a currency it had to assume rather than presenting it as read', async () => {
    const result = await historicalWorkbookExtractor.extract({
      document: doc(), context, period: '2026Q1', vehicleId: 'veh-abif', createMissing: true,
      table: { sheetName: 'P', rows: [['Fund', 'NAV'], ['Baltic Wind Partners II', 6400]] },
    });
    const position = result.candidates.find((c) => c.kind === 'position')!;
    expect(position.fields.currency.confidence).toBeLessThan(REVIEW_THRESHOLD);
    expect(position.fields.currency.locator).toMatch(/not stated/);
  });

  it('leaves an attribute the sheet does not carry unclassified rather than inventing it', async () => {
    const result = await historicalWorkbookExtractor.extract({
      document: doc(), context, period: '2026Q1', vehicleId: 'veh-abif', createMissing: true,
      table: { sheetName: 'P', rows: [['Fund', 'NAV'], ['Baltic Wind Partners II', 6400]] },
    });
    const position = result.candidates.find((c) => c.kind === 'position')!;
    expect(position.fields.assetClass).toBeUndefined();

    const facts = factsFrom(dataset, result.candidates.map((c) => ({ ...c, state: 'accepted' as const })), doc());
    expect(facts.positions[0].assetClass).toBe('Unclassified');
    expect(facts.positions[0].region).toBe('Unclassified');
  });

  it('matches a name the book already has instead of creating it again', async () => {
    const existing = dataset.positions[0].name;
    const result = await read([[existing, 'EUR', 8000, 2022, 'Europe', 6400]], true);
    expect(result.candidates.map((c) => c.kind)).toEqual(['position-valuation']);
    expect(result.candidates[0].match?.id).toBe(dataset.positions[0].id);
  });

  it('blocks a holding whose name is near one already in the book', async () => {
    // The matcher can leave a name unclaimed and still be close to something —
    // an ambiguous name, or one just under the matching threshold. Creating it
    // then splits one holding's history across two, so validation refuses.
    const [checked] = validateAll([{
      id: 'cand-dup', documentId: 'doc-1', kind: 'position', state: 'pending', issues: [],
      fields: {
        name: { value: dataset.positions[0].name, confidence: 1 },
        vehicleId: { value: dataset.positions[0].vehicleId, confidence: 1 },
        currency: { value: 'EUR', confidence: 1 },
      },
    }], dataset);

    expect(canCommit(checked)).toBe(false);
    expect(checked.issues.some((i) => /already has/.test(i.message))).toBe(true);
  });

  it('warns on every holding it does create, so a typo is seen before it is filed', async () => {
    const result = await read([['Baltic Wind Partners II', 'EUR', 8000, 2022, 'Europe', 6400]], true);
    const [position] = validateAll(result.candidates.filter((c) => c.kind === 'position'), dataset);
    expect(canCommit(position)).toBe(true);
    expect(position.issues.some((i) => i.severity === 'warning' && /new holding/.test(i.message))).toBe(true);
  });
});

describe('the template the application offers', () => {
  it('reads back through the same reader it was written for', async () => {
    // A template nobody validated is a promise: this proves the sheet the
    // application hands out is one the application can read.
    const workbook = parseXlsx(toXlsx(buildTemplate()));
    const holdings = workbook.sheets.find((sheet) => sheet.sheetName === 'Holdings')!;
    expect(holdings).toBeDefined();

    const result = await historicalWorkbookExtractor.extract({
      document: doc({ name: 'reporting_template.xlsx' }),
      context,
      period: '2026Q1',
      vehicleId: 'veh-abif',
      createMissing: true,
      table: holdings,
    });

    const valuations = result.candidates.filter((c) => c.kind === 'position-valuation');
    expect(valuations).toHaveLength(2);
    expect(valuations[0].fields.nav.value).toBe(6400);
    expect(valuations[0].fields.drawnCumulative.value).toBe(5600);

    // The second row is written in another convention on purpose — Swiss
    // grouping and the quarter as a date — and must read identically.
    expect(valuations[1].fields.nav.value).toBe(11400);
    expect(valuations[1].fields.period.value).toBe('2026Q1');

    // Every row lands somewhere: matched to a holding the book has, or tied to
    // one this batch creates. A row that is neither would be silently lost.
    expect(valuations.every((c) => c.match?.id || c.dependsOn)).toBe(true);

    const created = result.candidates.filter((c) => c.kind === 'position');
    expect(created.length).toBeGreaterThan(0);
    expect(created[0].fields.currency.value).toBe('EUR');
    expect(created[0].fields.vintage.value).toBe(2021);
  });

  it('describes every sheet it contains', () => {
    const template = buildTemplate();
    expect(template.sheets.map((s) => s.name)).toEqual([
      'Read me', 'Holdings', 'Transactions', 'Balance sheet', 'FX',
    ]);
    // The manifest is what a person reads before filling anything in.
    expect(template.manifest).toMatch(/never required|not a requirement|convenience/i);
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
      vehicleId: 'veh-abif',
      includeDerived: false,
    });
    const bytes = toXlsx(extract);

    const workbook = parseXlsx(bytes);
    const positions = workbook.sheets.find((s) => s.sheetName === 'positions');
    expect(positions).toBeDefined();
    expect(positions!.rows[0]).toContain('name');
    const inVehicle = dataset.positions.filter((p) => p.vehicleId === 'veh-abif');
    expect(positions!.rows.length).toBe(inVehicle.length + 1);

    // And the values survive as values, not as strings.
    const valuations = workbook.sheets.find((s) => s.sheetName === 'position_valuations')!;
    const navColumn = valuations.rows[0].indexOf('nav');
    expect(typeof valuations.rows[1][navColumn]).toBe('number');
  });
});

/**
 * Reading a report support model.
 *
 * The shape that holds no transactions: one figure per line per quarter, each
 * with a note saying where it came from. What is pinned is what it is read for
 * and what it is deliberately not read for — the balance sheet that lets the
 * net tier close, the published figures kept apart from computed ones, the
 * exchange rates that would otherwise read as figures called `usd`, and a
 * reference table that is reported rather than applied.
 */

import { describe, expect, it } from 'vitest';
import { isSupportModel, planModelImport, summariseModel } from '../src/ingest/model';
import { isSupportWorkbook } from '../src/ingest/support';
import { isMasterWorkbook } from '../src/ingest/master';
import type { TableData } from '../src/ingest/types';
import type { Cell } from '../src/ingest/workbook';

const PARAMS: TableData = {
  sheetName: 'PARAMS',
  rows: ([
    ['PARAMS – Source Data & Assumptions'],
    [],
    ['Reference', 'Q3 2025', 'Q4 2025', 'Q1 2026', 'Notes'],
    [null, '30-Sep-25', '31-Dec-25', '31-Mar-26'],
    [],
    ['FX Rates  (1 EUR = X CCY)  – Source: the portfolio database'],
    ['CCY', 'Q3 2025', 'Q4 2025', 'Q1 2026', 'Notes'],
    ['USD', 1.1741, 1.175, 1.1498, 'Quarter-end'],
    ['GBP', 0.8734, 0.8726, 0.86833, 'Quarter-end'],
    [],
    ['Key Financial Data'],
    ['Item', 'Q3 2025', 'Q4 2025', 'Q1 2026', 'Notes'],
    ['Net NAV (€k)   [derived: Fixed Assets + Cash + Other BS]', 9_000, 9_500, 10_000,
      'Derived, not taken from the administrator: portfolio + cash + other.'],
    ['  of which: Cash & equivalents (€k)', 150, 200, 250, 'Source: administrator'],
    ['Portfolio Gross – PFDB (€k)   [REPORT BASIS]', 8_900, 9_380, 9_800, 'Source: the database'],
    ['Portfolio Gross – RSM / CAS (€k)   [cross-check only]', 8_900, 9_380, 9_830,
      'The statement sent to the investor. Not the reported figure.'],
    ['Capital Called Cumulative (€k)', 11_000, 11_400, 11_900, 'Source: the database'],
    ['TVPI Net (x)', 0.94, 0.98, 1.01, 'Derived on the report basis'],
    ['Other BS items, net (€k)   [receivables − payables]', -50, -80, -50,
      'Receivables 40 less payables 90.'],
    [],
    ['Fund Reference – Source: PFDB FundDB'],
    ['Fund Name', 'Short', 'CCY', 'Generation', 'Strategy', 'Region', 'Notes'],
    ['EIF IV', 'EIF IV', 'USD', 'Gen 1', 'PE', 'Europe'],
    ['ETF3', 'ETF3', 'GBP', 'Gen 1', 'Infra', 'UK'],
  ] as Cell[][]),
};

const SUMMARY: TableData = {
  sheetName: 'SUMMARY',
  rows: ([
    ['NORTHERN IMPULSE FUND'],
    ['2.2  Financial Overview', null, null, null, null, "in '000 €"],
  ] as Cell[][]),
};

const sheets = (): TableData[] => [SUMMARY, PARAMS];
const plan = () => planModelImport(sheets(), { vehicleId: 'veh-nif' });

describe('recognising the workbook', () => {
  it('needs figures by quarter and a net asset value among them', () => {
    expect(isSupportModel(sheets())).toBe(true);
    expect(isSupportModel([SUMMARY])).toBe(false);
  });

  it('is not mistaken for a workbook that holds movements', () => {
    expect(isSupportWorkbook(sheets())).toBe(false);
    expect(isMasterWorkbook(sheets())).toBe(false);
  });

  it('reads the product, the currency and the quarters it covers', () => {
    const summary = summariseModel(sheets())!;
    expect(summary.fund).toBe('NORTHERN IMPULSE FUND');
    expect(summary.currency).toBe('EUR');
    expect(summary.quarters).toBe(3);
    expect(summary.last).toBe('2026Q1');
    expect(summary.holdings).toBe(2);
  });
});

describe('the product’s own balance sheet', () => {
  it('is what lets the net tier close on the accounts', () => {
    const sheet = plan().balanceSheets.find((b) => b.period === '2026Q1')!;
    expect(sheet.cash).toBe(250);
    // 9,800 of portfolio + 250 of cash − 50 of net payables = 10,000, which is
    // the net asset value the model publishes.
    expect(sheet.currentLiabilities).toBe(50);
    expect(sheet.otherAssets).toBe(0);
  });

  it('files one netted figure as one, rather than inventing the two halves', () => {
    // The note says receivables 40 less payables 90. The model carries only the
    // net, so only the net is filed.
    const sheet = plan().balanceSheets.find((b) => b.period === '2026Q1')!;
    expect(sheet.otherAssets + sheet.currentLiabilities).toBe(50);
    expect(sheet.accruedExpenses).toBe(0);
  });
});

describe('what was published', () => {
  const of = (name: string, period = '2026Q1') => plan().metrics
    .find((m) => m.metric === `published.${name}` && m.period === period);

  it('is kept apart from anything computed, and carries its own note', () => {
    expect(of('netAssetValue')?.value).toBe(10_000);
    expect(of('netAssetValue')?.source).toContain('portfolio + cash + other');
    expect(of('netAssetValue')?.scope.kind).toBe('vehicle');
    expect(plan().metrics.every((m) => m.metric.startsWith('published.'))).toBe(true);
  });

  it('keeps the reported figure and the administrator’s apart', () => {
    expect(of('portfolioGross')?.value).toBe(9_800);
    expect(of('portfolioCrossCheck')?.value).toBe(9_830);
    expect(of('portfolioCrossCheck')?.source).toContain('Not the reported figure');
  });

  it('keeps a line nobody mapped under its own label', () => {
    expect(of('tvpiNet')?.value).toBe(1.01);
    expect(of('calledCumulative')?.value).toBe(11_900);
  });
});

describe('the exchange rates', () => {
  it('are read as rates rather than as figures called usd and gbp', () => {
    expect(plan().metrics.some((m) => /usd|gbp/i.test(m.metric))).toBe(false);
    const rates = plan().fxRates.filter((r) => r.period === '2026Q1');
    expect(rates.map((r) => `${r.base}/${r.quote}|${r.rate}`).sort())
      .toEqual(['EUR/GBP|0.86833', 'EUR/USD|1.1498']);
  });

  it('takes the direction from the heading rather than assuming it', () => {
    // `1 EUR = X CCY`, so one euro is 1.1498 dollars and not the other way
    // round — which would translate a holding by the square of the error.
    const usd = plan().fxRates.find((r) => r.quote === 'USD' && r.period === '2026Q1')!;
    expect(usd.base).toBe('EUR');
    expect(usd.date).toBe('2026-03-31');
  });
});

describe('what it does not do', () => {
  it('creates no holdings, because it describes a record rather than being one', () => {
    expect(plan().positions).toEqual([]);
    expect(plan().valuations).toEqual([]);
    expect(plan().cashflows).toEqual([]);
  });

  it('reports the reference table rather than applying it', () => {
    expect(plan().notes.some((note) => /names 2 fund\(s\) by the short names/.test(note)))
      .toBe(true);
    expect(plan().problems).toEqual([]);
  });
});

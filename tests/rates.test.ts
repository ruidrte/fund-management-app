/**
 * Reading a published table of exchange rates.
 *
 * The shape the ECB publishes: one row per day, one column per currency, quoted
 * as one euro buys so many of the other. What is pinned is that a published
 * fixing never outranks the rate an administrator's own books used, that a gap
 * in the series is a gap rather than a zero, and that a rate published on a
 * business day carries the days after it until the next one.
 */

import { describe, expect, it } from 'vitest';
import { isRateSeries, planRatesImport, summariseRates } from '../src/ingest/rates';
import { buildRateLookup } from '../src/engine/fx';
import type { TableData } from '../src/ingest/types';
import type { Cell } from '../src/ingest/workbook';
import { supportSheets } from './fixtures/support';

const sheet = (rows: Cell[][]): TableData[] => [
  { sheetName: 'eurofxref-hist', rows } as unknown as TableData,
];

const HISTORY = sheet([
  ['Date', 'USD', 'JPY', 'GBP', 'CHF', 'SEK', 'NOK'],
  ['2026-06-30', 1.1498, 172.5, 0.8701, 0.9245, 10.943, 11.62],
  ['2026-06-29', 1.1512, 172.1, 0.8712, 0.9251, 10.951, 11.63],
  ['2026-06-26', 1.1533, 171.8, 0.8725, 0.9262, 10.962, 11.65],
]);

describe('recognising the file', () => {
  it('knows it by a date column with currency columns beside it', () => {
    expect(isRateSeries(HISTORY)).toBe(true);
  });

  it('is not fooled by a workbook that happens to have a currency column', () => {
    expect(isRateSeries(supportSheets())).toBe(false);
    // Two columns called USD and GBP are somebody's own sheet. A published
    // series never carries fewer than a dozen.
    expect(isRateSeries(sheet([['Date', 'USD', 'GBP'], ['2026-06-30', 1.15, 0.87]]))).toBe(false);
  });

  it('is not fooled by a heading with nothing under it', () => {
    expect(isRateSeries(sheet([['Date', 'USD', 'JPY', 'GBP', 'CHF', 'SEK']]))).toBe(false);
  });

  it('reads the day written either way the file writes it', () => {
    const daily = sheet([
      ['Date', 'USD', 'JPY', 'GBP', 'CHF', 'SEK'],
      ['30 June 2026', 1.1498, 172.5, 0.8701, 0.9245, 10.943],
    ]);
    expect(summariseRates(daily)?.first).toBe('2026-06-30');
  });

  it('summarises what it holds', () => {
    const summary = summariseRates(HISTORY)!;
    expect(summary).toMatchObject({
      base: 'EUR', currencies: 6, days: 3, rates: 18, first: '2026-06-26', last: '2026-06-30',
    });
  });
});

describe('what it files', () => {
  const plan = () => planRatesImport(HISTORY, { vehicleId: 'v', recordedAt: '2026-07-01T00:00:00.000Z' });

  it('quotes them the way the file does: one euro in each currency', () => {
    const usd = plan().fxRates.find((r) => r.quote === 'USD' && r.date === '2026-06-30')!;
    expect(usd.base).toBe('EUR');
    expect(usd.rate).toBe(1.1498);
    expect(usd.kind).toBe('closing');
  });

  it('files them at the lowest authority there is', () => {
    // The whole reason loading a series is safe: a fixing can never displace
    // the rate an administrator's own statement used.
    expect(plan().fxRates.every((r) => r.authority === 'market')).toBe(true);
  });

  it('creates nothing but rates', () => {
    const built = plan();
    expect(built.positions).toHaveLength(0);
    expect(built.cashflows).toHaveLength(0);
    expect(built.metrics).toHaveLength(0);
    expect(built.fxRates).toHaveLength(18);
  });

  it('treats a currency the series did not quote as no rate, not as zero', () => {
    const gaps = sheet([
      ['Date', 'USD', 'JPY', 'GBP', 'CHF', 'SEK'],
      ['2026-06-30', 1.1498, 'N/A', 0.8701, '', 10.943],
    ]);
    const built = planRatesImport(gaps, { vehicleId: 'v' });
    expect(built.fxRates.map((r) => r.quote).sort()).toEqual(['GBP', 'SEK', 'USD']);
  });

  it('says which rows it could not date rather than dropping them quietly', () => {
    const messy = sheet([
      ['Date', 'USD', 'JPY', 'GBP', 'CHF', 'SEK'],
      ['2026-06-30', 1.1498, 172.5, 0.8701, 0.9245, 10.943],
      ['Source: European Central Bank', null, null, null, null, null],
    ]);
    expect(planRatesImport(messy, { vehicleId: 'v' }).problems.some(
      (p) => /1 row\(s\) carry no date/.test(p),
    )).toBe(true);
  });

  it('refuses a file that is not one', () => {
    expect(() => planRatesImport(supportSheets(), { vehicleId: 'v' }))
      .toThrow(/not a table of exchange rates/);
  });
});

describe('what the rates are then good for', () => {
  const lookup = () => buildRateLookup([
    ...planRatesImport(HISTORY, { vehicleId: 'v', recordedAt: '2026-07-01T00:00:00.000Z' }).fxRates,
    // What an administrator's own books used for one of those days.
    {
      id: 'fx-admin', base: 'EUR', quote: 'USD', rate: 1.16, date: '2026-06-30',
      period: '2026Q2', recordedAt: '2026-07-01T00:00:00.000Z', kind: 'closing' as const,
      source: 'NAV pack', authority: 'administrator' as const,
    },
  ]);

  it('gives a movement the rate of its own day', () => {
    expect(lookup().onDate('EUR', 'GBP', '2026-06-29')).toBe(0.8712);
  });

  it('carries a business day over the days that follow it', () => {
    // The 27th and 28th are a weekend and nothing is published. A payment that
    // settles on the Sunday settled at Friday's rate, not at the quarter's.
    expect(lookup().onDate('EUR', 'GBP', '2026-06-28')).toBe(0.8725);
  });

  it('lets the administrator rate win on the day it covers', () => {
    expect(lookup().onDate('EUR', 'USD', '2026-06-30')).toBe(1.16);
    // And the published fixing still stands where the administrator said nothing.
    expect(lookup().onDate('EUR', 'USD', '2026-06-29')).toBe(1.1512);
  });

  it('inverts for a pair quoted the other way round', () => {
    expect(lookup().onDate('GBP', 'EUR', '2026-06-29')).toBeCloseTo(1 / 0.8712, 12);
  });
});

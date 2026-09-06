/**
 * Reading a published table of exchange rates.
 *
 * The house rule is that rates come from the ECB and are replaced by whatever
 * the administrator's own books used — that is written into how a rate is
 * ranked, and it has been true of everything except the one part that matters:
 * nothing ever loaded the ECB rates. Every rate in the book so far arrived
 * beside a movement in somebody's workbook, which means a movement nobody wrote
 * a rate against had none at all, and was translated at its quarter's closing
 * rate instead of at the rate of its day.
 *
 * This reads the reference series the ECB publishes, in the shape it publishes
 * it: one row per day, one column per currency, quoted as one euro buys so many
 * of the other. Both the file that carries a single day and the one that
 * carries the history are the same table with a different number of rows.
 *
 * They are filed as `market`, which is the lowest authority there is, so a
 * fixing can never displace what an administrator's books actually used. That
 * ranking is the whole reason loading them is safe: a daily series fills the
 * gaps and touches nothing else.
 */

import { periodForDate, type PeriodId } from '../domain/period';
import type { CurrencyCode, FxRate } from '../domain/types';
import type { TableData } from './types';
import type { Cell } from './workbook';
import type { ImportPlan } from './pfdb';

/* ------------------------------------------------------------------ *
 * Cells
 * ------------------------------------------------------------------ */

function text(cell: Cell): string {
  return cell === null || cell === undefined ? '' : String(cell).trim();
}

function toNumber(cell: Cell): number | undefined {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const cleaned = cell.replace(/\s/g, '');
    const parsed = Number(cleaned);
    if (cleaned !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * The date a row is for.
 *
 * The history file writes it as `2026-06-30` and the daily file as
 * `30 June 2026`, which are the same date and neither of which is a
 * spreadsheet serial — these arrive as text, because the file is a CSV.
 */
function toDate(cell: Cell): string | undefined {
  const serial = toNumber(cell);
  if (typeof cell === 'number' && serial !== undefined && serial > 20_000 && serial < 80_000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  const value = text(cell);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return iso[0];
  const written = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(value);
  if (written) {
    const month = MONTHS.indexOf(written[2].toLowerCase());
    if (month >= 0) {
      return `${written[3]}-${String(month + 1).padStart(2, '0')}-${written[1].padStart(2, '0')}`;
    }
  }
  return undefined;
}

const CURRENCY = /^[A-Z]{3}$/;

/* ------------------------------------------------------------------ *
 * Recognition
 * ------------------------------------------------------------------ */

interface Header { sheet: TableData; row: number; base: CurrencyCode; columns: Array<{ index: number; code: CurrencyCode }> }

/**
 * What makes this shape itself: a date column, and beside it a run of columns
 * headed by nothing but currency codes.
 *
 * Five is the floor. A workbook of somebody's own with two columns happening to
 * be called `USD` and `GBP` is a different file, and a published reference
 * series never carries fewer than a dozen.
 */
function headerOf(sheets: TableData[]): Header | undefined {
  for (const sheet of sheets) {
    for (let i = 0; i < Math.min(sheet.rows.length, 10); i += 1) {
      const cells = sheet.rows[i].map(text);
      if (!/^date$/i.test(cells[0] ?? '')) continue;
      const columns = cells
        .map((cell, index) => ({ index, code: cell.toUpperCase() }))
        .filter((entry) => entry.index > 0 && CURRENCY.test(entry.code));
      if (columns.length < 5) continue;
      // The euro is what the series is quoted against, and the file says so by
      // not carrying a column for it.
      return { sheet, row: i, base: 'EUR', columns };
    }
  }
  return undefined;
}

export function isRateSeries(sheets: TableData[]): boolean {
  const header = headerOf(sheets);
  if (!header) return false;
  // At least one row under the heading has a date and a rate. A heading alone
  // is a template, and importing a template files nothing.
  return header.sheet.rows.slice(header.row + 1).some(
    (row) => toDate(row[0]) !== undefined
      && header.columns.some(({ index }) => (toNumber(row[index]) ?? 0) > 0),
  );
}

/* ------------------------------------------------------------------ *
 * What the file is about
 * ------------------------------------------------------------------ */

export interface RateSeriesSummary {
  /** The currency every rate is quoted against. */
  base: CurrencyCode;
  currencies: number;
  /** Days carried. */
  days: number;
  /** Rates carried, which is days times currencies less the gaps. */
  rates: number;
  first?: string;
  last?: string;
  firstPeriod?: PeriodId;
  lastPeriod?: PeriodId;
}

export interface RateOptions {
  /** Not used: a rate belongs to the book rather than to any one product. */
  vehicleId: string;
  recordedAt?: string;
}

interface Reading { date: string; code: CurrencyCode; rate: number }

function readSeries(sheets: TableData[]): { base: CurrencyCode; readings: Reading[]; skipped: string[] } {
  const header = headerOf(sheets);
  if (!header) return { base: 'EUR', readings: [], skipped: [] };

  const readings: Reading[] = [];
  const skipped: string[] = [];
  for (let i = header.row + 1; i < header.sheet.rows.length; i += 1) {
    const row = header.sheet.rows[i];
    const first = text(row[0]);
    if (!first) continue;
    const date = toDate(row[0]);
    if (!date) {
      skipped.push(`row ${i + 1} ("${first}")`);
      continue;
    }
    for (const { index, code } of header.columns) {
      const rate = toNumber(row[index]);
      // The series writes `N/A` for a currency it did not quote that day, and a
      // blank for one that did not exist yet. Both mean no rate, which is not
      // the same as a rate of zero.
      if (rate === undefined || rate <= 0) continue;
      readings.push({ date, code, rate });
    }
  }
  return { base: header.base, readings, skipped };
}

export function summariseRates(sheets: TableData[]): RateSeriesSummary | undefined {
  if (!isRateSeries(sheets)) return undefined;
  const { base, readings } = readSeries(sheets);
  const days = [...new Set(readings.map((r) => r.date))].sort();

  return {
    base,
    currencies: new Set(readings.map((r) => r.code)).size,
    days: days.length,
    rates: readings.length,
    first: days[0],
    last: days[days.length - 1],
    firstPeriod: days[0] ? periodForDate(days[0]) : undefined,
    lastPeriod: days.length > 0 ? periodForDate(days[days.length - 1]) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export function planRatesImport(sheets: TableData[], options: RateOptions): ImportPlan {
  const summary = summariseRates(sheets);
  if (!summary) {
    throw new Error(
      'This file has no date column with currency columns beside it, so it is not a table of '
      + 'exchange rates.',
    );
  }

  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const { base, readings, skipped } = readSeries(sheets);
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();

  const fxRates: FxRate[] = readings.map((reading) => {
    const period = periodForDate(reading.date);
    periods.add(period);
    return {
      id: `fx-${base}-${reading.code}-${reading.date}-ref`,
      base,
      quote: reading.code,
      rate: reading.rate,
      date: reading.date,
      period,
      recordedAt,
      // A daily reference rate is the closing fixing for its day. It is not an
      // average of anything, and filing it as one would let it stand in for the
      // quarter's average rate, which is a different figure.
      kind: 'closing',
      // The lowest authority there is, deliberately. A published fixing must
      // never displace the rate an administrator's own books used, and the
      // ranking is what makes loading a whole series safe.
      authority: 'market',
      source: `Published reference rates, one ${base} in each currency`,
    };
  });

  if (skipped.length > 0) {
    problems.push(
      `${skipped.length} row(s) carry no date that could be read and were left out: `
      + `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}.`,
    );
  }

  notes.push(
    `${summary.rates} rate(s) across ${summary.currencies} currencies and ${summary.days} day(s), `
    + `${summary.first} to ${summary.last}. They are filed as published fixings, which is the `
    + 'lowest authority a rate can have: wherever the book already holds the rate an '
    + "administrator's own statement used, that one still wins. These fill the days nothing "
    + 'else covers — a movement with no rate beside it was being translated at its quarter\'s '
    + 'closing rate, which is a rate from a different day.',
  );

  return {
    program: `Reference rates, ${summary.first} to ${summary.last}`,
    // Rates belong to the book rather than to a product. The field is here
    // because every import plan has one; nothing reads it for these rows.
    vehicleId: options.vehicleId,
    positions: [],
    valuations: [],
    cashflows: [],
    investors: [],
    assets: [],
    assetValuations: [],
    balanceSheets: [],
    metrics: [],
    fxRates,
    problems,
    periods: [...periods].sort(),
    notes,
  };
}

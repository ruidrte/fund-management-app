/**
 * Reading a report support model.
 *
 * The sixth shape, and the first that holds no transactions at all. The other
 * five are records — a ledger, a register, a trial balance. This is the layer a
 * desk builds *over* those to produce a quarter's report: one figure per line
 * per quarter, each with a note saying which file it came from and how it was
 * arrived at, plus the process around it — what has to be requested, what has
 * been reviewed, what reconciles against what.
 *
 * So it is read for three things the records cannot give.
 *
 *   The product's own balance sheet. A portfolio database says what the funds
 *   are worth and nothing about the cash beside them, so the net tier could not
 *   close. This carries cash and the net of receivables and payables, quarter by
 *   quarter, and that is what makes a reported net asset value tie to the
 *   accounts rather than to the portfolio.
 *
 *   What was actually published, and on what basis. Every figure here has a
 *   note beside it; a figure this application computes and a figure a deck
 *   printed are two different things, and being able to put them side by side
 *   is the difference between a discrepancy found now and one found by an
 *   investor. They are filed as published figures rather than as facts, and
 *   nothing computed depends on them.
 *
 *   What each fund is. A portfolio database carries names, currencies and
 *   money; the strategy, the region and the generation live here. They are
 *   applied to holdings the book already has rather than creating any: this
 *   file is a layer over a record, and a layer that could invent a holding
 *   would be a second record.
 */

import { periodEndDate, type PeriodId } from '../domain/period';
import type {
  CurrencyCode, FxRate, Metric, VehicleBalanceSheet,
} from '../domain/types';
import { slug } from './ids';
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
    const cleaned = cell.replace(/[\s'’]/g, '').replace(/,(?=\d{3}\b)/g, '');
    const parsed = Number(cleaned);
    if (cleaned !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** `Q1 2026` and `2026 Q1` are the same quarter, and both are written here. */
function toPeriod(value: string): PeriodId | undefined {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const quarterFirst = /^Q([1-4])\s*(\d{4})$/i.exec(trimmed);
  if (quarterFirst) return `${quarterFirst[2]}Q${quarterFirst[1]}`;
  const yearFirst = /^(\d{4})\s*Q([1-4])$/i.exec(trimmed);
  if (yearFirst) return `${yearFirst[1]}Q${yearFirst[2]}`;
  return undefined;
}

function camel(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  return words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('') || 'unnamed';
}

function named(sheets: TableData[], pattern: RegExp): TableData | undefined {
  return sheets.find((sheet) => pattern.test(sheet.sheetName.trim().toLowerCase()));
}

const PARAMS = /^params$/;
const SUMMARY = /^summary$/;
const OVERVIEW = /^financial_overview$/;

/* ------------------------------------------------------------------ *
 * The quarter columns
 * ------------------------------------------------------------------ */

interface QuarterColumn { index: number; period: PeriodId }

/** The row of quarter headings, and where each quarter sits. */
function quarterColumns(table: TableData, depth = 20): { header: number; columns: QuarterColumn[] } {
  for (let i = 0; i < Math.min(table.rows.length, depth); i += 1) {
    const columns = table.rows[i]
      .map((cell, index) => ({ index, period: toPeriod(text(cell)) }))
      .filter((entry): entry is QuarterColumn => Boolean(entry.period));
    if (columns.length >= 2) return { header: i, columns };
  }
  return { header: -1, columns: [] };
}

export function isSupportModel(sheets: TableData[]): boolean {
  const params = named(sheets, PARAMS);
  if (!params) return false;
  if (quarterColumns(params).columns.length < 2) return false;
  // A model is the layer over a record: it states a net asset value per quarter
  // and carries no ledger of its own.
  return params.rows.some((row) => /^net nav/i.test(text(row[0])));
}

/* ------------------------------------------------------------------ *
 * What the workbook is about
 * ------------------------------------------------------------------ */

export interface ModelSummary {
  /** The product, as the workbook's own masthead names it. */
  fund: string;
  currency: CurrencyCode;
  /** The quarter the model was built for. */
  reportingDate?: string;
  /** Quarters carried. */
  quarters: number;
  /** Lines of published figures. */
  lines: number;
  /** Funds in the reference table. */
  holdings: number;
  first?: PeriodId;
  last?: PeriodId;
}

export interface ModelOptions {
  vehicleId: string;
  recordedAt?: string;
}

/* ------------------------------------------------------------------ *
 * The published lines
 * ------------------------------------------------------------------ */

/** The lines this reader knows by name. Anything else keeps its own label. */
const LINES: Array<[RegExp, string]> = [
  [/^net nav/i, 'netAssetValue'],
  [/^\s*of which: cash|^cash & equivalents/i, 'cash'],
  [/^portfolio gross – pfdb|^portfolio gross - pfdb/i, 'portfolioGross'],
  [/^portfolio gross – rsm|^portfolio gross - rsm/i, 'portfolioCrossCheck'],
  [/^capital called cumulative/i, 'calledCumulative'],
  [/^distributions cumulative/i, 'distributedCumulative'],
  [/^\s*contributions in qtr/i, 'contributionsInQuarter'],
  [/^\s*distributions in qtr/i, 'distributionsInQuarter'],
  [/^\s*portfolio result in qtr/i, 'portfolioResultInQuarter'],
  [/^\s*expenses in qtr/i, 'expensesInQuarter'],
  [/^tvpi net/i, 'tvpiNet'],
  [/^tvpi gross/i, 'tvpiGross'],
  [/^dpi net/i, 'dpiNet'],
  [/^dpi gross/i, 'dpiGross'],
  [/^irr net/i, 'irrNet'],
  [/^irr gross/i, 'irrGross'],
  [/^other bs items/i, 'otherBalanceSheet'],
];

/**
 * The exchange rates the model carries, one per currency per quarter.
 *
 * They sit in the same table as the figures and under the same quarter
 * headings, so without this they read as published lines called `usd` and
 * `gbp`. They are rates, and the book has a place for rates.
 *
 * The direction is taken from the heading above them rather than assumed: this
 * workbook writes one euro as so many of the other currency, which is the same
 * way round the portfolio database writes it, and getting it backwards would
 * translate a holding by the square of the error.
 */
interface RateRow {
  currency: CurrencyCode;
  base: CurrencyCode;
  values: Map<PeriodId, number>;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

function readRates(sheets: TableData[]): RateRow[] {
  const table = named(sheets, PARAMS);
  if (!table) return [];
  const { header, columns } = quarterColumns(table);
  if (header < 0) return [];

  // `FX Rates (1 EUR = X CCY)`: the currency named first is the one unit of.
  const heading = table.rows
    .map((row) => text(row[0]))
    .find((value) => /fx rates/i.test(value)) ?? '';
  const base = (/1\s*([A-Z]{3})\s*=/i.exec(heading)?.[1] ?? 'EUR').toUpperCase();

  const rows: RateRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const label = text(table.rows[i][0]);
    if (!CURRENCY_CODE.test(label) || label === base) continue;
    const values = new Map<PeriodId, number>();
    for (const column of columns) {
      const value = toNumber(table.rows[i][column.index]);
      if (value !== undefined && value > 0) values.set(column.period, value);
    }
    if (values.size > 0) rows.push({ currency: label, base, values });
  }
  return rows;
}

interface PublishedRow {
  label: string;
  name: string;
  /** The note beside the line, which says where the figure came from. */
  note: string;
  values: Map<PeriodId, number>;
}

function readPublished(sheets: TableData[]): PublishedRow[] {
  const table = named(sheets, PARAMS);
  if (!table) return [];
  const { header, columns } = quarterColumns(table);
  if (header < 0) return [];

  // The note sits in the column after the last quarter.
  const notes = Math.max(...columns.map((column) => column.index)) + 1;

  const rows: PublishedRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const label = text(row[0]);
    // A row headed with a currency code is a rate, not a figure the report
    // published, and is read as one.
    if (!label || CURRENCY_CODE.test(label)) continue;
    const values = new Map<PeriodId, number>();
    for (const column of columns) {
      const value = toNumber(row[column.index]);
      if (value !== undefined) values.set(column.period, value);
    }
    if (values.size === 0) continue;
    const known = LINES.find(([pattern]) => pattern.test(label));
    rows.push({
      label,
      name: known ? known[1] : camel(label),
      note: text(row[notes]),
      values,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The fund reference table
 * ------------------------------------------------------------------ */

interface FundReference {
  name: string;
  short: string;
  currency: CurrencyCode;
  generation: string;
  strategy: string;
  region: string;
}

function readFundReference(sheets: TableData[]): FundReference[] {
  const table = named(sheets, PARAMS);
  if (!table) return [];

  const header = table.rows.findIndex((row) => {
    const cells = row.map((cell) => text(cell).toLowerCase());
    return cells[0] === 'fund name' && cells.includes('strategy');
  });
  if (header < 0) return [];

  const at = (name: string) =>
    table.rows[header].findIndex((cell) => text(cell).toLowerCase() === name);
  const short = at('short');
  const currency = at('ccy');
  const generation = at('generation');
  const strategy = at('strategy');
  const region = at('region');

  const rows: FundReference[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const name = text(row[0]);
    if (!name) continue;
    rows.push({
      name,
      short: short < 0 ? '' : text(row[short]),
      currency: (currency < 0 ? '' : text(row[currency]).toUpperCase()) as CurrencyCode,
      generation: generation < 0 ? '' : text(row[generation]),
      strategy: strategy < 0 ? '' : text(row[strategy]),
      region: region < 0 ? '' : text(row[region]),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The summary
 * ------------------------------------------------------------------ */

/** The product's name, from the masthead of whichever sheet carries one. */
function fundName(sheets: TableData[]): string {
  for (const pattern of [SUMMARY, OVERVIEW, PARAMS]) {
    const sheet = named(sheets, pattern);
    const line = (sheet?.rows ?? []).slice(0, 4)
      .map((row) => text(row[0]))
      .find((value) => value.length > 6 && !/^params|^financial overview/i.test(value));
    if (line) return line;
  }
  return 'This product';
}

/** The currency the figures are stated in, from the heading that says so. */
function statedCurrency(sheets: TableData[]): CurrencyCode | undefined {
  for (const sheet of sheets) {
    for (const row of sheet.rows.slice(0, 6)) {
      for (const cell of row) {
        const said = text(cell);
        if (!/in\s*'?000|\(€k\)|€k\b/i.test(said)) continue;
        const code = /\b(EUR|USD|CHF|GBP)\b/.exec(said.toUpperCase());
        if (code) return code[1];
        if (said.includes('€')) return 'EUR';
      }
    }
  }
  return undefined;
}

export function summariseModel(sheets: TableData[]): ModelSummary | undefined {
  if (!isSupportModel(sheets)) return undefined;

  const published = readPublished(sheets);
  const periods = [...new Set(published.flatMap((row) => [...row.values.keys()]))].sort();

  return {
    fund: fundName(sheets),
    currency: statedCurrency(sheets) ?? 'EUR',
    reportingDate: periods[periods.length - 1],
    quarters: periods.length,
    lines: published.length,
    holdings: readFundReference(sheets).length,
    first: periods[0],
    last: periods[periods.length - 1],
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export function planModelImport(sheets: TableData[], options: ModelOptions): ImportPlan {
  const summary = summariseModel(sheets);
  if (!summary) {
    throw new Error(
      'This workbook has no table of figures by quarter, so it is not a report support model.',
    );
  }

  const { vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();

  const published = readPublished(sheets);
  const metrics: Metric[] = [];

  for (const row of published) {
    for (const [period, value] of row.values) {
      periods.add(period);
      metrics.push({
        id: `met-${vehicleId}-${period}-published.${slug(row.name, 40)}`,
        scope: { kind: 'vehicle', id: vehicleId },
        period,
        recordedAt,
        // Published rather than computed. Nothing here drives a figure this
        // application works out; they exist so the two can be put side by side.
        metric: `published.${row.name}`,
        value,
        unit: summary.currency,
        source: row.note
          ? `${summary.fund} — ${row.label}. ${row.note}`
          : `${summary.fund} — ${row.label}`,
      });
    }
  }

  /* --- the rates ---------------------------------------------------- */

  const fxRates: FxRate[] = [];
  for (const rate of readRates(sheets)) {
    for (const [period, value] of rate.values) {
      periods.add(period);
      fxRates.push({
        id: `fx-${rate.base}-${rate.currency}-${period}`,
        base: rate.base,
        quote: rate.currency,
        rate: value,
        date: periodEndDate(period),
        period,
        recordedAt,
        kind: 'closing',
        source: `${summary.fund} — report support model`,
        authority: 'manual',
      });
    }
  }

  /* --- the product's own balance sheet ------------------------------ */

  const cash = published.find((row) => row.name === 'cash');
  const other = published.find((row) => row.name === 'otherBalanceSheet');
  const balanceSheets: VehicleBalanceSheet[] = [];

  for (const period of [...new Set([
    ...(cash?.values.keys() ?? []),
    ...(other?.values.keys() ?? []),
  ])].sort()) {
    const net = other?.values.get(period) ?? 0;
    balanceSheets.push({
      vehicleId,
      period,
      recordedAt,
      cash: cash?.values.get(period) ?? 0,
      // The file states one netted figure for receivables less payables, so
      // that is what is filed: positive on the asset side, negative on the
      // liability side. Splitting it into the two halves the note mentions
      // would be inventing a figure the model does not carry.
      otherAssets: Math.max(0, net),
      currentLiabilities: Math.max(0, -net),
      accruedExpenses: 0,
      source: `${summary.fund} — report support model`,
    });
    periods.add(period);
  }

  if (balanceSheets.length > 0) {
    notes.push(
      `Cash and the net of receivables and payables for ${balanceSheets.length} quarter(s). A `
      + 'portfolio database says what the funds are worth and nothing about the cash beside '
      + 'them, so this is what lets the net tier close on the accounts rather than on the '
      + 'portfolio.',
    );
  } else {
    problems.push(
      'No cash or balance-sheet line was found, so the net tier will still be the portfolio '
      + 'alone.',
    );
  }

  /* --- what each fund is -------------------------------------------- */

  const reference = readFundReference(sheets);
  if (reference.length > 0) {
    // Read and reported, not applied. The table names funds the way a deck
    // does — `EIF IV`, `ETF3`, `Gen SSF III` — and the portfolio database names
    // them as they are registered — `Ecosystem Integrity Fund IV`,
    // `Environmental Technologies Fund 3`, `Generation IM Sustainable Solutions
    // Fund III`. Those are abbreviations, not shortenings, and no rule that
    // matched them would also refuse `Alder II` against `Alder III`.
    //
    // Nothing is lost by refusing: the database already classifies every
    // holding, and more finely than this table does — `Affordable Housing` and
    // `Timber` where this says `PE`. The one thing it adds is the generation a
    // deck groups by, and attaching that is a mapping somebody makes rather
    // than a guess this reader makes.
    notes.push(
      `The reference table names ${reference.length} fund(s) by the short names a deck uses. `
      + 'They are not applied to the portfolio: those names are abbreviations rather than '
      + 'shortenings of the registered ones, and a rule loose enough to match them would also '
      + 'match one fund in a series to another. The portfolio database already classifies every '
      + 'holding, and more finely than this table does.',
    );
  }

  notes.push(
    'These are the figures a report published, with the note beside each saying where it came '
    + 'from. Nothing this application computes depends on them — they are here so that what was '
    + 'published and what is computed can be put side by side.',
  );

  return {
    program: summary.fund,
    vehicleId,
    // None. This file describes a portfolio database rather than being one, and
    // a layer that could create a holding would be a second record.
    positions: [],
    valuations: [],
    cashflows: [],
    investors: [],
    assets: [],
    assetValuations: [],
    balanceSheets,
    metrics,
    fxRates,
    problems,
    periods: [...periods].sort(),
    notes,
  };
}

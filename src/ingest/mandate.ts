/**
 * Reading an advisory monitoring workbook.
 *
 * The fourth shape, and the one that is not a product. The other three readers
 * take a book kept by whoever runs the fund: the manager's portfolio database,
 * the product's own quarterly workbook, the allocation sheet behind its
 * look-through. This one takes the book an *adviser* keeps about funds somebody
 * else runs — a register of the properties inside them, the quarter's figures
 * as the manager reported them, and, separately, the client's own ledger of
 * calls, distributions and advisory fees since inception.
 *
 * That difference decides everything about how it is read.
 *
 *   There is no product to value. The adviser runs no vehicle, so nothing here
 *   has a net asset value of its own. What the mandate is worth is what the
 *   client's capital account says it is worth, and the ledger's closing line is
 *   that figure — read, not computed.
 *
 *   Every figure sits at one of three levels, and they must never be added
 *   together: the properties are reported at 100% of the whole fund, the fund
 *   vehicle the client invests through is a slice of that, and the client is a
 *   slice of the vehicle. The workbook's own control sheet monitors both ratios
 *   for exactly this reason. This reader records the level a figure came from
 *   rather than flattening them, so the look-through multiplies down to the
 *   client's share instead of overstating it by an order of magnitude.
 *
 *   The adviser's own fee is not a portfolio flow. It is what the client pays
 *   for the advice, so it is filed against the client, on the investor side,
 *   which is what makes the net-of-fee return differ from the gross one.
 *
 * A note on history. The ledger carries the client's own valuation only for the
 * quarter it was written for; the closed quarters are held at fund level. The
 * client's share of each closed quarter is therefore derived — the fund's net
 * asset value at the share the client's paid-in capital represents — and every
 * derived figure says so in its source, so a chart never presents one as
 * reported.
 */

import { makePeriod, periodForDate, type PeriodId } from '../domain/period';
import type {
  Asset, AssetValuation, Attribution, Cashflow, CashflowType, CurrencyCode, FxRate,
  Investor, Metric, Position, PositionValuation,
} from '../domain/types';
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

function toDate(cell: Cell): string | undefined {
  const serial = toNumber(cell);
  if (serial !== undefined && serial > 20_000 && serial < 80_000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  const value = text(cell);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return iso[0];
  const written = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(value);
  if (written) return `${written[3]}-${written[2]}-${written[1]}`;
  return undefined;
}

/**
 * A quarter written any of the ways this workbook writes one.
 *
 * Its history sheets are headed `2025 Q4` and its open column `Q2 2026`, in the
 * same row. Both are the same quarter and both are accepted; a heading that is
 * neither is not a period column and is skipped rather than guessed at.
 */
function toPeriod(value: string): PeriodId | undefined {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const yearFirst = /^(\d{4})\s*Q([1-4])$/i.exec(trimmed);
  if (yearFirst) return makePeriod(Number(yearFirst[1]), Number(yearFirst[2]) as 1).id;
  const quarterFirst = /^Q([1-4])\s*(\d{4})$/i.exec(trimmed);
  if (quarterFirst) return makePeriod(Number(quarterFirst[2]), Number(quarterFirst[1]) as 1).id;
  return undefined;
}

/**
 * The quarter a column heading ends in.
 *
 * A heading in these sheets names the figure, then the level it is stated at,
 * then the quarter — `Fund equity FV / gesamt-fund \u00b7 Q1 2026` — across a line
 * break and a separator. Only the last part is a period, and a heading that
 * does not end in one is not a period column.
 */
function periodInHeading(heading: string): PeriodId | undefined {
  const parts = heading.split(/\r?\n|\u00b7|\|/).map((part) => part.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const period = toPeriod(parts[i]);
    if (period) return period;
  }
  return undefined;
}

/** A metric name from a row label: `Cumulative Paid In Capital` -> `cumulativePaidInCapital`. */
function camel(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  return words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('') || 'unnamed';
}

/** The one value a list agrees on, or `Unclassified` when it does not agree. */
function only(values: string[]): string {
  const distinct = [...new Set(values.filter((value) => value && value !== 'Unclassified'))];
  return distinct.length === 1 ? distinct[0] : 'Unclassified';
}

function slug(value: string, limit = 24): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, limit)
    || 'x';
}

/** The roman numeral a fund is distinguished by, as `Fund VI REIT LP` -> `VI`. */
function romanIn(value: string): string | undefined {
  const found = [...value.matchAll(/\b(I{1,3}|IV|VI{0,3}|IX|XI{0,3})\b/g)];
  return found.length > 0 ? found[found.length - 1][1] : undefined;
}

/* ------------------------------------------------------------------ *
 * Sheets
 *
 * Named `40 PKTG LEDGER`, `20 QUARTER V` and so on: a sort key, sometimes a
 * house abbreviation, then what the sheet is. Only the last part is a property
 * of the format, so that is what is matched on.
 * ------------------------------------------------------------------ */

function tail(name: string): string {
  return name.replace(/^\s*\d+\s*/, '').trim().toLowerCase();
}

function sheetLike(sheets: TableData[], pattern: RegExp): TableData | undefined {
  return sheets.find((sheet) => pattern.test(tail(sheet.sheetName)));
}

function sheetsLike(sheets: TableData[], pattern: RegExp): TableData[] {
  return sheets.filter((sheet) => pattern.test(tail(sheet.sheetName)));
}

const LEDGER = /ledger$/;
const REGISTER = /assets?$/;
const QUARTER = /^(?:\S+\s+)?quarter\s+(\S+)$/;
const FUND_QUARTER = /^fund quarter$/;
const FUND_HISTORY = /^fund history$/;
const ASSET_HISTORY = /^asset history$/;
const CONTROL = /^control/;
const README = /^readme$/;

/** The row carrying the column headings, found by what has to be on it. */
function headerRow(table: TableData, required: string[], depth = 12): number {
  const wanted = required.map((name) => name.toLowerCase());
  for (let i = 0; i < Math.min(table.rows.length, depth); i += 1) {
    const cells = table.rows[i].map((cell) => text(cell).toLowerCase().replace(/\s+/g, ' '));
    if (wanted.every((name) => cells.some((cell) => cell === name))) return i;
  }
  return -1;
}

interface Columns {
  index(name: string): number;
  /** The first column whose heading says this, for one nobody names the same way. */
  matching(pattern: RegExp): number;
  text(row: Cell[], name: string): string;
  number(row: Cell[], name: string): number | undefined;
  date(row: Cell[], name: string): string | undefined;
  like(row: Cell[], pattern: RegExp): number | undefined;
}

function columns(header: Cell[]): Columns {
  const at = new Map<string, number>();
  header.forEach((cell, i) => {
    const name = text(cell).toLowerCase().replace(/\s+/g, ' ');
    if (name && !at.has(name)) at.set(name, i);
  });
  const index = (name: string) => at.get(name.toLowerCase().replace(/\s+/g, ' ')) ?? -1;
  const matching = (pattern: RegExp) => {
    for (const [name, i] of at) if (pattern.test(name)) return i;
    return -1;
  };
  return {
    index,
    matching,
    text: (row, name) => (index(name) < 0 ? '' : text(row[index(name)])),
    number: (row, name) => (index(name) < 0 ? undefined : toNumber(row[index(name)])),
    date: (row, name) => (index(name) < 0 ? undefined : toDate(row[index(name)])),
    like: (row, pattern) => (matching(pattern) < 0 ? undefined : toNumber(row[matching(pattern)])),
  };
}

const LEDGER_HEADINGS = ['fund', 'date', 'commitment', 'paid-in capital', 'distributions'];
const REGISTER_HEADINGS = ['id', 'fund', 'units'];

export function isMandateWorkbook(sheets: TableData[]): boolean {
  const ledger = sheetLike(sheets, LEDGER);
  const register = sheetLike(sheets, REGISTER);
  if (!ledger || !register) return false;
  return headerRow(ledger, LEDGER_HEADINGS) >= 0 && headerRow(register, REGISTER_HEADINGS) >= 0;
}

/* ------------------------------------------------------------------ *
 * What the workbook is about
 * ------------------------------------------------------------------ */

/**
 * One fund the mandate is invested in.
 *
 * `share` is the client's share of the vehicle it invests through — the figure
 * the workbook's control sheet states, which the reader checks against the
 * ledger rather than assuming.
 */
export interface MandateFund {
  /** How the workbook distinguishes it: `V`, `VI`. */
  key: string;
  name: string;
  commitment: number;
  share?: number;
  companies: number;
}

/**
 * Field names follow the reporting-workbook summary, because the import screen
 * asks the same question of both: one workbook, one product, where does it go.
 */
export interface MandateSummary {
  /** What the workbook is about, as its own front matter names it. */
  fund: string;
  /** Who holds the mandate — the client whose capital account the ledger is. */
  holder: string;
  currency: CurrencyCode;
  reportingDate?: string;
  /** Funds advised on. */
  holdings: number;
  /** Ledger lines. */
  movements: number;
  /** Always one: the mandate holder. */
  investors: number;
  /** None: an adviser runs no vehicle, so there is no balance sheet to read. */
  balanceSheets: number;
  first?: PeriodId;
  last?: PeriodId;
  funds: MandateFund[];
  companies: number;
}

export interface MandateOptions {
  vehicleId: string;
  recordedAt?: string;
}

/* ------------------------------------------------------------------ *
 * The control sheet
 * ------------------------------------------------------------------ */

interface Control {
  period?: PeriodId;
  quarterEnd?: string;
  /** The closing rate, which is what the quarter's valuation is restated at. */
  closingRate?: number;
  shares: Map<string, number>;
  commitments: Map<string, number>;
}

/**
 * A two-column list of label and value rather than a table, so it is read by
 * what each label says. Anything it does not recognise is left alone: this
 * sheet also carries the validation block, which is not parameters.
 */
function readControl(sheets: TableData[]): Control {
  const control: Control = { shares: new Map(), commitments: new Map() };
  const sheet = sheetLike(sheets, CONTROL);
  if (!sheet) return control;

  for (const row of sheet.rows) {
    const cells = row.map(text);
    const labelAt = cells.findIndex((cell) => cell !== '');
    if (labelAt < 0) continue;
    const label = cells[labelAt];
    const valueAt = row.findIndex((cell, i) => i > labelAt && text(cell) !== '');
    if (valueAt < 0) continue;
    const value = row[valueAt];

    if (/^quarter$/i.test(label)) control.period = toPeriod(text(value)) ?? control.period;
    else if (/^quarter end$/i.test(label)) control.quarterEnd = toDate(value);
    else if (/^[A-Z]{3}\s*\/\s*[A-Z]{3}\b.*quarter end/i.test(label)) {
      control.closingRate = toNumber(value);
    } else {
      const share = /share of .*fund\s+(\S+?)\b/i.exec(label);
      const number = toNumber(value);
      if (share && number !== undefined) control.shares.set(share[1].toUpperCase(), number);
      const commitment = /commitment,?\s+.*fund\s+(\S+?)\b/i.exec(label);
      if (commitment && number !== undefined) {
        control.commitments.set(commitment[1].toUpperCase(), number);
      }
    }
  }

  return control;
}

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

interface LedgerRow {
  line: number;
  fund: string;
  date: string;
  period: PeriodId;
  description: string;
  commitment?: number;
  /** Written negative: capital the holder paid out. */
  paid?: number;
  distribution?: number;
  /** The closing valuation, present only on the last line of each fund. */
  residual?: number;
  /** True-up interest between closings, either way. */
  interest?: number;
  /** The adviser's own fee, written negative. */
  fee?: number;
  fx?: number;
}

function readLedger(sheets: TableData[]): LedgerRow[] {
  const sheet = sheetLike(sheets, LEDGER);
  if (!sheet) return [];
  const header = headerRow(sheet, LEDGER_HEADINGS);
  if (header < 0) return [];
  const at = columns(sheet.rows[header]);

  const rows: LedgerRow[] = [];
  for (let i = header + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const fund = at.text(row, 'Fund').toUpperCase();
    const date = at.date(row, 'Date');
    // The totals and the legend below the table have no fund and no date.
    if (!fund || !date) continue;

    rows.push({
      line: i + 1,
      fund,
      date,
      period: periodForDate(date),
      description: at.text(row, 'Description'),
      commitment: at.number(row, 'Commitment'),
      paid: at.number(row, 'Paid-in capital'),
      distribution: at.number(row, 'Distributions'),
      residual: at.number(row, 'Residual value'),
      interest: at.like(row, /interest/),
      // The adviser names this column after itself — "EBG fees" — so it is
      // found by what it is rather than by whose it is.
      fee: at.like(row, /fee/),
      fx: at.like(row, RATE_HEADING),
    });
  }
  return rows;
}

/** A column headed with a currency pair is the exchange rate, as `USD/CHF`. */
const RATE_HEADING = /^([a-z]{3})\s*\/\s*([a-z]{3})$/;

/** The currency pair a rate column is headed with, as `USD/CHF`. */
function ratePair(sheets: TableData[]): { base: CurrencyCode; quote: CurrencyCode } | undefined {
  const sheet = sheetLike(sheets, LEDGER);
  if (!sheet) return undefined;
  const header = headerRow(sheet, LEDGER_HEADINGS);
  if (header < 0) return undefined;
  for (const cell of sheet.rows[header]) {
    const pair = RATE_HEADING.exec(text(cell).toLowerCase());
    if (pair) return { base: pair[1].toUpperCase(), quote: pair[2].toUpperCase() };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Fund-level figures
 * ------------------------------------------------------------------ */

const NAV = 'Total Net Asset Value (NAV)';
const PAID_IN = 'Cumulative Paid In Capital';
const PORTFOLIO = 'Total Portfolio fair value';

/** `metric -> fund key -> period -> value`, from the history and open quarters. */
type FundSeries = Map<string, Map<string, Map<PeriodId, number>>>;

function put(series: FundSeries, metric: string, fund: string, period: PeriodId, value: number) {
  const byFund = series.get(metric) ?? new Map<string, Map<PeriodId, number>>();
  const byPeriod = byFund.get(fund) ?? new Map<PeriodId, number>();
  byPeriod.set(period, value);
  byFund.set(fund, byPeriod);
  series.set(metric, byFund);
}

function get(series: FundSeries, metric: string, fund: string, period: PeriodId): number | undefined {
  return series.get(metric)?.get(fund)?.get(period);
}

/**
 * The closed quarters, held one row per fund and metric with a column per
 * quarter, and the open one, held two funds side by side. Both are fund-level;
 * neither is the client's share.
 */
function readFundSeries(sheets: TableData[]): { series: FundSeries; names: Map<string, string> } {
  const series: FundSeries = new Map();
  const names = new Map<string, string>();

  const history = sheetLike(sheets, FUND_HISTORY);
  if (history) {
    const header = headerRow(history, ['fund', 'metric']);
    if (header >= 0) {
      const at = columns(history.rows[header]);
      const periods: Array<{ index: number; period: PeriodId }> = [];
      history.rows[header].forEach((cell, i) => {
        const period = toPeriod(text(cell));
        if (period) periods.push({ index: i, period });
      });
      for (let i = header + 1; i < history.rows.length; i += 1) {
        const row = history.rows[i];
        const fund = at.text(row, 'Fund').toUpperCase();
        const metric = at.text(row, 'Metric');
        if (!fund || !metric) continue;
        for (const column of periods) {
          const value = toNumber(row[column.index]);
          if (value !== undefined) put(series, metric, fund, column.period, value);
        }
      }
    }
  }

  const quarter = sheetLike(sheets, FUND_QUARTER);
  if (quarter) {
    const header = headerRow(quarter, ['metric']);
    if (header >= 0) {
      const at = columns(quarter.rows[header]);
      // Each column is headed with the vehicle and the quarter it is for, so
      // the prior quarter beside the current one is read as its own column
      // rather than as a comparison.
      const fundColumns: Array<{ index: number; fund: string; period: PeriodId }> = [];
      quarter.rows[header].forEach((cell, i) => {
        const heading = text(cell);
        const lines = heading.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length < 2) return;
        const fund = romanIn(lines[0]);
        const period = periodInHeading(heading);
        if (!fund || !period) return;
        fundColumns.push({ index: i, fund, period });
        if (!names.has(fund)) names.set(fund, lines.slice(0, -1).join(' ').trim());
      });
      for (let i = header + 1; i < quarter.rows.length; i += 1) {
        const row = quarter.rows[i];
        const metric = at.text(row, 'Metric');
        if (!metric) continue;
        for (const column of fundColumns) {
          const value = toNumber(row[column.index]);
          if (value !== undefined) put(series, metric, column.fund, column.period, value);
        }
      }
    }
  }

  return { series, names };
}

/* ------------------------------------------------------------------ *
 * The properties
 * ------------------------------------------------------------------ */

interface RegisterRow {
  id: string;
  fund: string;
  name: string;
  city: string;
  state: string;
  region: string;
  tenantType: string;
  units?: number;
  acquired?: string;
}

function readRegister(sheets: TableData[]): RegisterRow[] {
  const sheet = sheetLike(sheets, REGISTER);
  if (!sheet) return [];
  const header = headerRow(sheet, REGISTER_HEADINGS);
  if (header < 0) return [];
  const at = columns(sheet.rows[header]);

  const rows: RegisterRow[] = [];
  for (let i = header + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const id = at.text(row, 'ID');
    const fund = at.text(row, 'Fund').toUpperCase();
    if (!IDENTIFIER.test(id) || !fund) continue;
    rows.push({
      id,
      fund,
      name: at.text(row, 'Asset — report name') || at.text(row, 'Asset') || id,
      city: at.text(row, 'City'),
      state: at.text(row, 'State'),
      region: at.text(row, 'Region'),
      tenantType: at.text(row, 'Tenant type'),
      units: at.number(row, 'Units'),
      acquired: at.date(row, 'Acquisition'),
    });
  }
  return rows;
}

/**
 * Where a property is.
 *
 * The register locates each one by city and state and says nothing about the
 * country, so the country is read off the state rather than assumed: a
 * two-letter code is a United States state, and anything else is left alone.
 */
function countryOf(state: string): string {
  return /^[A-Z]{2}\b/.test(state.trim()) ? 'United States' : 'Unclassified';
}

/* ------------------------------------------------------------------ *
 * The columns beside the valuation
 *
 * A quarter sheet is about sixty columns wide per property. Four of them are
 * facts the engine computes on — equity at fair value, invested, realised, and
 * the affordability split that becomes the sector. Everything else is what the
 * manager reports beside a valuation: what moved the value, the debt, the
 * operations against budget, the rehabilitation programme, the rents, and the
 * sentence explaining the quarter. A report page needs those and nothing
 * computed does, so they are kept as metrics rather than read and dropped.
 *
 * Known headings get a stable name, so a layout can ask for one and an emitted
 * workbook can put it back in its own column. A heading nobody has mapped is
 * kept anyway under a name derived from itself: a manager who adds a column
 * should not have it silently discarded, and a round trip through this book
 * should give back the sheet that went in.
 * ------------------------------------------------------------------ */

/** Read as a fact, or derived from two that are — not kept twice. */
const NOT_A_METRIC = [
  /^id$/, /^asset$/, /^fund equity fv/, /^invested capital$/, /^realised proceeds$/,
  // Any column headed with a delta is the difference between two that are
  // already kept, whatever it goes on to name.
  /^δ/, /^ties\?$/, /^total$/, /^total cap \+ noi \+ rehab$/,
];

/** The headings this format is known to use, and what each one is. */
const METRIC_NAMES: Array<[RegExp, string]> = [
  [/^ownership ?%$/, 'holding.ownership'],
  [/^asset fmv/, 'value.fairMarketValue'],
  [/^cap rate$/, 'value.capRate'],
  [/^noi$/, 'value.netOperatingIncome'],
  [/^rehabilitation$/, 'value.rehabilitation'],
  [/^other/, 'value.other'],
  [/^principal driver/, 'narrative.driver'],
  [/^total committed$/, 'capital.committed'],
  [/^uncalled$/, 'capital.uncalled'],
  [/^total proceeds$/, 'capital.proceeds'],
  [/^gross multiple$/, 'capital.grossMultiple'],
  [/^gain/, 'capital.gain'],
  [/^capital in/, 'capital.movement'],
  [/^principal mortgage$/, 'debt.principal'],
  [/^fmv debt/, 'debt.fairValue'],
  [/^ltv$/, 'debt.loanToValue'],
  [/^status$/, 'operations.status'],
  [/^occupancy$/, 'operations.occupancy'],
  [/^3y high$/, 'operations.occupancyHigh'],
  [/^3y low$/, 'operations.occupancyLow'],
  [/^income actual$/, 'operations.income.actual'],
  [/^income budget$/, 'operations.income.budget'],
  [/^expense actual$/, 'operations.expense.actual'],
  [/^expense budget$/, 'operations.expense.budget'],
  [/^noi actual$/, 'operations.noi.actual'],
  [/^noi budget$/, 'operations.noi.budget'],
  [/^debt service actual$/, 'operations.debtService.actual'],
  [/^debt service budget$/, 'operations.debtService.budget'],
  [/^cfads actual$/, 'operations.cfads.actual'],
  [/^cfads budget$/, 'operations.cfads.budget'],
  [/^rehab strategy$/, 'rehab.strategy'],
  [/^rehab planned$/, 'rehab.planned'],
  [/^rehab executed$/, 'rehab.executed'],
  [/^%$/, 'rehab.progress'],
  [/^rehab status$/, 'rehab.status'],
  [/^green certification$/, 'esg.greenCertification'],
  [/^retrofit$/, 'esg.retrofit'],
  [/^rsc$/, 'esg.residentServices'],
  [/^section 8$/, 'units.section8'],
  [/^<50% ami$/, 'units.below50Ami'],
  [/^<60% ami$/, 'units.below60Ami'],
  [/^<80% ami$/, 'units.below80Ami'],
  [/^restricted$/, 'units.restricted'],
  [/^market rate$/, 'units.marketRate'],
  [/^avg total rent$/, 'rent.average'],
  [/^avg market rent$/, 'rent.market'],
];

/** A heading nobody mapped, kept under a name derived from what it says. */
function derivedName(heading: string): string {
  const words = heading.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  const camel = words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');
  return `reported.${camel || 'unnamed'}`;
}

interface MetricColumn {
  index: number;
  metric: string;
  /** Set where the heading names its own quarter, as the paired value columns do. */
  period?: PeriodId;
  /** Whether this column was recognised or kept under a derived name. */
  known: boolean;
}

function metricColumns(header: Cell[]): MetricColumn[] {
  const found: MetricColumn[] = [];
  const seen = new Set<string>();

  header.forEach((cell, index) => {
    const heading = text(cell);
    if (!heading) return;
    // The quarter is part of the heading, not part of what is being measured.
    const period = periodInHeading(heading);
    const name = heading
      .split(/\r?\n|\u00b7/)
      .filter((part) => !toPeriod(part.trim()))
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || NOT_A_METRIC.some((pattern) => pattern.test(name))) return;

    const known = METRIC_NAMES.find(([pattern]) => pattern.test(name));
    const metric = known ? known[1] : derivedName(name);
    // A heading repeated for two quarters is one metric measured twice; the
    // same heading repeated without a quarter is one column, read once.
    const key = `${metric}/${period ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ index, metric, period, known: Boolean(known) });
  });

  return found;
}

/** What an identifier looks like, so a footnote in the same column is not one. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/;

/** The affordability bands, which are what a property's units are let under. */
const BANDS = ['Section 8', '<50% AMI', '<60% AMI', '<80% AMI', 'Restricted', 'Market rate'];

interface QuarterRow {
  id: string;
  line: number;
  /** Equity at fair value, at 100% of the fund, prior and current quarter. */
  equityBefore?: number;
  equity?: number;
  fmvBefore?: number;
  fmv?: number;
  capRate?: number;
  noi?: number;
  rehabilitation?: number;
  invested?: number;
  realised?: number;
  units: Record<string, number>;
  /** Everything else the row states, by metric name and the quarter it is for. */
  reported: Array<{ metric: string; period?: PeriodId; value?: number; text?: string }>;
}

interface QuarterSheet {
  rows: QuarterRow[];
  period?: PeriodId;
  before?: PeriodId;
  /** Columns kept under a derived name, because nothing had mapped them. */
  unmapped: string[];
}

function readQuarterSheets(sheets: TableData[]): Map<string, QuarterSheet> {
  const found = new Map<string, QuarterSheet>();

  for (const sheet of sheetsLike(sheets, QUARTER)) {
    const key = QUARTER.exec(tail(sheet.sheetName))?.[1]?.toUpperCase();
    if (!key) continue;
    const header = headerRow(sheet, ['id', 'asset'], 12);
    if (header < 0) continue;
    const at = columns(sheet.rows[header]);

    // Two columns are headed with the same figure for two quarters, so which is
    // which is read from the headings rather than from their order.
    const equity: Array<{ index: number; period: PeriodId }> = [];
    const fmv: Array<{ index: number; period: PeriodId }> = [];
    sheet.rows[header].forEach((cell, i) => {
      const heading = text(cell);
      const period = periodInHeading(heading);
      if (!period) return;
      if (/fund equity/i.test(heading)) equity.push({ index: i, period });
      else if (/fmv|fair market value/i.test(heading) && !/debt/i.test(heading)) {
        fmv.push({ index: i, period });
      }
    });
    equity.sort((a, b) => a.period.localeCompare(b.period));
    fmv.sort((a, b) => a.period.localeCompare(b.period));

    const reported = metricColumns(sheet.rows[header]);
    const rows: QuarterRow[] = [];
    for (let i = header + 1; i < sheet.rows.length; i += 1) {
      const row = sheet.rows[i];
      const id = at.text(row, 'ID');
      // The sheet's footnote sits in the same column as the identifiers, and a
      // paragraph is not an identifier.
      if (!IDENTIFIER.test(id)) continue;
      const units: Record<string, number> = {};
      for (const band of BANDS) {
        const value = at.number(row, band);
        if (value !== undefined && value > 0) units[band] = value;
      }
      rows.push({
        id,
        line: i + 1,
        equityBefore: equity.length > 1 ? toNumber(row[equity[0].index]) : undefined,
        equity: equity.length > 0 ? toNumber(row[equity[equity.length - 1].index]) : undefined,
        fmvBefore: fmv.length > 1 ? toNumber(row[fmv[0].index]) : undefined,
        fmv: fmv.length > 0 ? toNumber(row[fmv[fmv.length - 1].index]) : undefined,
        capRate: at.number(row, 'Cap rate'),
        noi: at.number(row, 'NOI'),
        rehabilitation: at.number(row, 'Rehabilitation'),
        invested: at.number(row, 'Invested capital'),
        realised: at.number(row, 'Realised proceeds'),
        units,
        reported: reported.flatMap((column) => {
          const cell = row[column.index];
          const value = toNumber(cell);
          const written = text(cell);
          if (value === undefined && !written) return [];
          return [{
            metric: column.metric,
            period: column.period,
            value,
            text: value === undefined ? written : undefined,
          }];
        }),
      });
    }

    found.set(key, {
      rows,
      period: equity[equity.length - 1]?.period,
      before: equity.length > 1 ? equity[0].period : undefined,
      unmapped: reported.filter((column) => !column.known).map((column) => column.metric),
    });
  }

  return found;
}

const EQUITY_METRIC = /fund equity at fair value/i;
const INVESTED_METRIC = /^invested capital$/i;
const REALISED_METRIC = /^realised proceeds$/i;

/** Closed quarters per property: one row per property and metric, columns of quarters. */
function readAssetHistory(sheets: TableData[]): Map<string, Map<PeriodId, Partial<AssetValuation>>> {
  const found = new Map<string, Map<PeriodId, Partial<AssetValuation>>>();
  const sheet = sheetLike(sheets, ASSET_HISTORY);
  if (!sheet) return found;
  const header = headerRow(sheet, ['id', 'metric']);
  if (header < 0) return found;
  const at = columns(sheet.rows[header]);

  const periods: Array<{ index: number; period: PeriodId }> = [];
  sheet.rows[header].forEach((cell, i) => {
    const period = toPeriod(text(cell));
    if (period) periods.push({ index: i, period });
  });

  for (let i = header + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const id = at.text(row, 'ID');
    const metric = at.text(row, 'Metric');
    if (!IDENTIFIER.test(id) || !metric) continue;

    const field = EQUITY_METRIC.test(metric)
      ? 'unrealised'
      : INVESTED_METRIC.test(metric)
        ? 'invested'
        : REALISED_METRIC.test(metric) ? 'realised' : undefined;
    if (!field) continue;

    const byPeriod = found.get(id) ?? new Map<PeriodId, Partial<AssetValuation>>();
    for (const column of periods) {
      const value = toNumber(row[column.index]);
      if (value === undefined) continue;
      byPeriod.set(column.period, { ...byPeriod.get(column.period), [field]: value });
    }
    found.set(id, byPeriod);
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * The summary
 * ------------------------------------------------------------------ */

/** The workbook's own front matter: what it is about, and whose it is. */
function frontMatter(sheets: TableData[]): { subject: string; holder: string } {
  const sheet = sheetLike(sheets, README) ?? sheetLike(sheets, CONTROL);
  const lines = (sheet?.rows ?? [])
    .slice(0, 12)
    .map((row) => row.map(text).filter(Boolean))
    .filter((cells) => cells.length === 1)
    .map((cells) => cells[0]);

  // The subject line names the funds and, after a separator, whose mandate it
  // is: "…Fund V and VI · Pensionskasse Thurgau".
  const subject = lines.find((line) => line.includes('·')) ?? lines[1] ?? lines[0] ?? 'This mandate';
  const parts = subject.split('·').map((part) => part.trim()).filter(Boolean);
  return {
    subject: parts[0] ?? subject,
    holder: parts.length > 1 ? parts[parts.length - 1] : 'The mandate holder',
  };
}

/** The currency the workbook says it is written in, from its own conventions. */
function statedCurrency(sheets: TableData[]): CurrencyCode | undefined {
  const sheet = sheetLike(sheets, README);
  for (const row of sheet?.rows ?? []) {
    const cells = row.map(text);
    if (!cells.some((cell) => /^currency$/i.test(cell))) continue;
    const said = cells.join(' ');
    const code = /\b(EUR|USD|CHF|GBP|SEK|NOK|DKK|JPY)\b/.exec(said.toUpperCase());
    if (code) return code[1];
  }
  return undefined;
}

export function summariseMandate(sheets: TableData[]): MandateSummary | undefined {
  if (!isMandateWorkbook(sheets)) return undefined;

  const ledger = readLedger(sheets);
  const control = readControl(sheets);
  const { names } = readFundSeries(sheets);
  const register = readRegister(sheets);
  const { subject, holder } = frontMatter(sheets);

  const keys = [...new Set(ledger.map((row) => row.fund))];
  const periods = [...new Set(ledger.map((row) => row.period))].sort();

  return {
    fund: subject,
    holder,
    currency: statedCurrency(sheets) ?? ratePair(sheets)?.base ?? 'USD',
    reportingDate: control.quarterEnd,
    holdings: keys.length,
    movements: ledger.length,
    investors: 1,
    balanceSheets: 0,
    first: periods[0],
    last: control.period ?? periods[periods.length - 1],
    companies: register.length,
    funds: keys.map((key) => ({
      key,
      name: names.get(key) ?? `Fund ${key}`,
      commitment: control.commitments.get(key)
        ?? ledger.filter((row) => row.fund === key)
          .reduce((sum, row) => sum + (row.commitment ?? 0), 0),
      share: control.shares.get(key),
      companies: register.filter((row) => row.fund === key).length,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export function planMandateImport(sheets: TableData[], options: MandateOptions): ImportPlan {
  const summary = summariseMandate(sheets);
  if (!summary) {
    throw new Error(
      'This workbook has no capital-account ledger and property register, so it is not an '
      + 'advisory monitoring workbook.',
    );
  }

  const { vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const currency = summary.currency;
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();

  const ledger = readLedger(sheets);
  const control = readControl(sheets);
  const { series } = readFundSeries(sheets);
  const register = readRegister(sheets);
  const quarters = readQuarterSheets(sheets);
  const history = readAssetHistory(sheets);
  const book = slug(summary.fund, 16);

  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${book}-${(sequence += 1)}`;

  /* --- the funds the mandate holds -------------------------------- */

  const positions: Position[] = [];
  const positionOf = new Map<string, Position>();

  for (const fund of summary.funds) {
    const lines = ledger.filter((row) => row.fund === fund.key);
    const opened = lines.find((row) => (row.commitment ?? 0) !== 0) ?? lines[0];
    const position: Position = {
      id: `pos-${book}-${slug(fund.key, 8)}`,
      vehicleId,
      kind: 'fund',
      name: fund.name,
      currency,
      vintage: Number((opened?.date ?? recordedAt).slice(0, 4)),
      commitmentDate: opened?.date ?? recordedAt.slice(0, 10),
      commitment: fund.commitment,
      // The share of the vehicle the mandate holds. It is what turns a figure
      // reported for the whole fund into the holder's own exposure, and is
      // never applied to the capital account, which is already theirs.
      ownership: fund.share ?? 1,
      // The register counts units, occupancy, rents and mortgages, so what
      // these funds hold is property; nothing finer is stated and nothing
      // finer is invented.
      assetClass: 'Real Estate',
      // Where the fund invests, when its register puts every property in the
      // same country. Two countries and it is not one region, so it is left
      // unstated rather than reduced to whichever has more properties.
      region: only(register.filter((row) => row.fund === fund.key).map((row) => countryOf(row.state))),
      status: 'Investing',
    };
    positions.push(position);
    positionOf.set(fund.key, position);
  }

  /* --- the holder's own ledger ------------------------------------ */

  const cashflows: Cashflow[] = [];
  const fxRates: FxRate[] = [];
  const paidInAt = new Map<string, Map<PeriodId, number>>();
  const distributedAt = new Map<string, Map<PeriodId, number>>();
  const residual = new Map<string, { period: PeriodId; value: number }>();

  const investor: Investor = {
    id: `inv-${book}-holder`,
    vehicleId,
    name: summary.holder,
    type: 'Institution',
    currency,
    commitment: summary.funds.reduce((sum, fund) => sum + fund.commitment, 0),
    entryDate: [...ledger].sort((a, b) => a.date.localeCompare(b.date))[0]?.date
      ?? recordedAt.slice(0, 10),
  };

  const flow = (
    row: LedgerRow, type: CashflowType, amount: number,
    affectsCommitment: boolean, side: 'position' | 'investor',
  ) => {
    periods.add(row.period);
    cashflows.push({
      id: id('cf'),
      vehicleId,
      positionId: side === 'position' ? positionOf.get(row.fund)?.id : undefined,
      investorId: side === 'investor' ? investor.id : undefined,
      type,
      amount,
      currency,
      date: row.date,
      period: row.period,
      recordedAt,
      affectsCommitment,
      description: row.description || undefined,
      status: 'Settled',
    });
  };

  const missingRate: string[] = [];
  const rate = ratePair(sheets);

  for (const row of ledger) {
    if (!positionOf.has(row.fund)) {
      problems.push(`Ledger line ${row.line}: "${row.fund}" is not one of the funds, so it was skipped.`);
      continue;
    }

    // The capital account, written from the holder's side: capital paid out is
    // negative and money received is positive, which is the sign convention
    // this application uses throughout.
    if (row.paid !== undefined && row.paid !== 0) {
      flow(row, 'Capital Call', row.paid, true, 'position');
      const byPeriod = paidInAt.get(row.fund) ?? new Map<PeriodId, number>();
      byPeriod.set(row.period, (byPeriod.get(row.period) ?? 0) + Math.abs(row.paid));
      paidInAt.set(row.fund, byPeriod);
    }
    if (row.distribution !== undefined && row.distribution !== 0) {
      flow(row, 'Distribution', row.distribution, false, 'position');
      const byPeriod = distributedAt.get(row.fund) ?? new Map<PeriodId, number>();
      byPeriod.set(row.period, (byPeriod.get(row.period) ?? 0) + row.distribution);
      distributedAt.set(row.fund, byPeriod);
    }
    // True-up interest between closings: a flow with the fund, on neither side
    // of the commitment, which is why the return including it differs.
    if (row.interest !== undefined && row.interest !== 0) {
      flow(row, 'Equalisation', row.interest, false, 'position');
    }
    // The adviser's fee is not a portfolio flow. It is what the holder pays for
    // the advice, so it is filed against them and not against the funds.
    if (row.fee !== undefined && row.fee !== 0) {
      flow(row, 'Fee', row.fee, false, 'investor');
    }
    if (row.residual !== undefined && row.residual !== 0) {
      residual.set(row.fund, { period: control.period ?? row.period, value: row.residual });
      periods.add(control.period ?? row.period);
    }

    if (rate && row.fx !== undefined && row.fx > 0) {
      fxRates.push({
        id: `fx-${rate.base}-${rate.quote}-${row.date}-${/fee/i.test(row.description) ? 'avg' : 'cls'}`,
        base: rate.base,
        quote: rate.quote,
        rate: row.fx,
        date: row.date,
        period: row.period,
        recordedAt,
        // The workbook's own footnote: fee invoices are converted at the
        // quarter's average, every other line at the rate of its own date.
        kind: /fee/i.test(row.description) ? 'average' : 'closing',
        source: `${summary.fund} — capital-account ledger`,
        authority: 'market',
      });
    } else if (rate && (row.paid || row.distribution || row.fee || row.interest)) {
      missingRate.push(`line ${row.line} (${row.description || row.date})`);
    }
  }

  const pair = rate;
  // The closing rate is a different rate from the ones beside the flows: it is
  // what the quarter's valuation is restated at, and without it the return in
  // the holder's own currency stops at the last flow.
  if (pair && control.period && control.quarterEnd) {
    if (control.closingRate && control.closingRate > 0) {
      fxRates.push({
        id: `fx-${pair.base}-${pair.quote}-${control.quarterEnd}-cls`,
        base: pair.base,
        quote: pair.quote,
        rate: control.closingRate,
        date: control.quarterEnd,
        period: control.period,
        recordedAt,
        kind: 'closing',
        source: `${summary.fund} — control sheet`,
        authority: 'market',
      });
    } else if (residual.size > 0) {
      problems.push(
        `No ${pair.base}/${pair.quote} rate is recorded at ${control.quarterEnd}, so the closing `
        + `valuation cannot be restated in ${pair.quote}.`,
      );
    }
  }

  if (missingRate.length > 0) {
    problems.push(
      `${missingRate.length} ledger line(s) carry a flow but no exchange rate, so the return `
      + `restated in ${rate?.quote} cannot close on them: ${missingRate.slice(0, 4).join('; ')}`
      + `${missingRate.length > 4 ? ', and others' : ''}.`,
    );
  }

  /* --- what the mandate is worth, quarter by quarter -------------- */

  const valuations: PositionValuation[] = [];
  const cumulative = (
    source: Map<string, Map<PeriodId, number>>, fund: string, upTo: PeriodId,
  ): number => {
    let total = 0;
    for (const [period, amount] of source.get(fund) ?? []) {
      if (period <= upTo) total += amount;
    }
    return total;
  };

  let derived = 0;
  for (const fund of summary.funds) {
    const position = positionOf.get(fund.key)!;
    const navByPeriod = series.get(NAV)?.get(fund.key) ?? new Map<PeriodId, number>();
    const reported = residual.get(fund.key);

    for (const [period, fundNav] of [...navByPeriod].sort((a, b) => a[0].localeCompare(b[0]))) {
      // The quarter the ledger closes on is the holder's own figure and is
      // filed as such; every earlier one is the fund's, at the share the
      // holder's paid-in capital represented at the time.
      if (reported && period === reported.period) continue;
      const holderPaid = cumulative(paidInAt, fund.key, period);
      const fundPaid = get(series, PAID_IN, fund.key, period);
      if (!fundPaid || holderPaid === 0) continue;

      periods.add(period);
      derived += 1;
      valuations.push({
        id: id('val'),
        positionId: position.id,
        period,
        recordedAt,
        nav: fundNav * (holderPaid / fundPaid),
        drawnCumulative: holderPaid,
        distributedCumulative: cumulative(distributedAt, fund.key, period),
        source: `${fund.name} statements, at the mandate's paid-in share — derived`,
      });
    }

    if (reported) {
      valuations.push({
        id: id('val'),
        positionId: position.id,
        period: reported.period,
        recordedAt,
        nav: reported.value,
        drawnCumulative: cumulative(paidInAt, fund.key, reported.period),
        distributedCumulative: cumulative(distributedAt, fund.key, reported.period),
        source: `${summary.holder} capital account`,
      });

      // The share the control sheet states, checked against the ledger rather
      // than taken on trust: it is the ratio every look-through figure is
      // scaled by, so a stale one would move the whole exposure.
      const fundPaid = get(series, PAID_IN, fund.key, reported.period);
      const holderPaid = cumulative(paidInAt, fund.key, reported.period);
      if (fund.share && fundPaid && holderPaid > 0) {
        const implied = holderPaid / fundPaid;
        if (Math.abs(implied / fund.share - 1) > 0.01) {
          problems.push(
            `${fund.name}: the stated share of ${(fund.share * 100).toFixed(2)}% is not what the `
            + `ledger implies (${(implied * 100).toFixed(2)}%, being ${Math.round(holderPaid).toLocaleString('en-GB')} `
            + `paid in against the fund's ${Math.round(fundPaid).toLocaleString('en-GB')}).`,
          );
        }
      }
    }

    // A valuation repeated to the unit across quarters is what a fund that has
    // not reported looks like once somebody has carried it forward by hand. The
    // whole run is named, because a chart of it shows a flat line and no reason.
    const run = [...navByPeriod].sort((a, b) => a[0].localeCompare(b[0]));
    let from = 0;
    for (let i = 1; i <= run.length; i += 1) {
      if (i < run.length && run[i][1] === run[from][1]) continue;
      if (i - from > 1) {
        notes.push(
          `${fund.name}: net asset value is unchanged from ${run[from][0]} to ${run[i - 1][0]}, `
          + `so ${i - from - 1} of those quarter(s) are carried forward rather than reported.`,
        );
      }
      from = i;
    }
  }

  if (derived > 0) {
    notes.push(
      `${derived} closed quarter(s) are the fund's own net asset value at the share the mandate's `
      + 'paid-in capital represented, because the ledger carries the holder’s own figure only '
      + 'for the quarter it was written for. Each says so in its source.',
    );
  }

  /* --- the properties inside the funds ---------------------------- */

  const assets: Asset[] = [];
  const assetValuations: AssetValuation[] = [];
  const metrics: Metric[] = [];
  const bridgeBreaks: string[] = [];
  const unmapped = new Set<string>();

  const metric = (
    scope: Metric['scope'], period: PeriodId, name: string,
    figure: { value?: number; text?: string }, source: string,
  ) => {
    if (figure.value === undefined && !figure.text) return;
    periods.add(period);
    metrics.push({
      id: `met-${scope.id}-${period}-${name}`,
      scope,
      period,
      recordedAt,
      metric: name,
      value: figure.value,
      text: figure.text,
      source,
    });
  };

  // What the manager reports about each fund beside its net asset value: the
  // multiples and returns as they state them, the leverage, the operations.
  // They are not what the engine computes from the ledger and are not meant to
  // be — a report page prints the manager's figure and says so.
  for (const fund of summary.funds) {
    const position = positionOf.get(fund.key);
    if (!position) continue;
    for (const [name, byFund] of series) {
      for (const [period, value] of byFund.get(fund.key) ?? []) {
        metric(
          { kind: 'position', id: position.id }, period,
          `fund.${camel(name)}`, { value },
          `${fund.name} statements, as the manager reports them`,
        );
      }
    }
  }

  for (const fund of summary.funds) {
    const position = positionOf.get(fund.key);
    const quarter = quarters.get(fund.key);
    if (!position || !quarter) continue;

    // The properties are reported at 100% of the whole fund; the vehicle the
    // mandate invests through holds a slice of it. That slice is what the fund
    // sheet's portfolio fair value is of the register's total equity, and it is
    // the missing step between a property's figures and the holder's exposure.
    const equityTotal = quarter.rows.reduce((sum, row) => sum + (row.equity ?? 0), 0);
    const vehiclePortfolio = quarter.period
      ? get(series, PORTFOLIO, fund.key, quarter.period)
      : undefined;
    const slice = equityTotal > 0 && vehiclePortfolio ? vehiclePortfolio / equityTotal : 1;

    if (slice !== 1) {
      notes.push(
        `${fund.name}: the properties are reported at 100% of the fund and the vehicle holds `
        + `${(slice * 100).toFixed(1)}% of it, so the look-through is scaled by that and then by `
        + `the mandate's ${((fund.share ?? 1) * 100).toFixed(2)}%.`,
      );
    }

    for (const row of quarter.rows) {
      const entry = register.find((item) => item.id === row.id);
      if (!entry) {
        problems.push(`${fund.name} quarter row ${row.line}: "${row.id}" is not in the register.`);
        continue;
      }

      const bands = Object.values(row.units).reduce((sum, value) => sum + value, 0);
      const sector: Attribution = bands > 0
        ? Object.fromEntries(
          Object.entries(row.units).map(([band, count]) => [band, count / bands]),
        )
        : entry.tenantType || 'Unclassified';

      if (entry.units !== undefined && bands > 0 && Math.abs(entry.units - bands) > 0.5) {
        problems.push(
          `${entry.name}: the register counts ${entry.units} units and the affordability bands `
          + `account for ${bands}.`,
        );
      }

      // The workbook's own identity: what moved the property's value is the
      // capitalisation rate, its operating income and what was spent on it.
      // A break is the manager's to explain, and is named rather than absorbed.
      const move = row.fmv !== undefined && row.fmvBefore !== undefined
        ? row.fmv - row.fmvBefore
        : undefined;
      const explained = [row.capRate, row.noi, row.rehabilitation];
      if (move !== undefined && explained.some((part) => part !== undefined)) {
        const total = explained.reduce((sum: number, part) => sum + (part ?? 0), 0);
        if (Math.abs(move - total) > Math.max(Math.abs(move) * 0.01, 1_000)) {
          bridgeBreaks.push(entry.name);
        }
      }

      for (const figure of row.reported) {
        metric(
          { kind: 'asset', id: `ast-${book}-${slug(row.id, 12)}` },
          figure.period ?? quarter.period ?? control.period ?? recordedAt.slice(0, 7),
          figure.metric, figure,
          `${fund.name} quarterly report, at 100% of the fund`,
        );
      }
      for (const name of quarter.unmapped) unmapped.add(name);

      const asset: Asset = {
        id: `ast-${book}-${slug(row.id, 12)}`,
        positionId: position.id,
        name: entry.name,
        currency,
        investmentDate: entry.acquired ?? position.commitmentDate,
        // The share of the property that reaches the vehicle. The mandate's own
        // share of the vehicle is carried on the position and applied after,
        // so neither level is applied twice.
        ownership: slice,
        assetClass: 'Real Estate',
        sector,
        region: entry.region || 'Unclassified',
        country: countryOf(entry.state),
        status: 'Held',
      };
      assets.push(asset);

      const past = history.get(row.id) ?? new Map<PeriodId, Partial<AssetValuation>>();
      const filed = new Map<PeriodId, Partial<AssetValuation>>(past);
      if (quarter.period && row.equity !== undefined) {
        filed.set(quarter.period, {
          unrealised: row.equity,
          invested: row.invested,
          realised: row.realised,
        });
      }

      for (const [period, figures] of filed) {
        if (figures.unrealised === undefined) continue;
        periods.add(period);
        assetValuations.push({
          id: `${asset.id}-${period}`,
          assetId: asset.id,
          period,
          recordedAt,
          invested: figures.invested ?? 0,
          realised: figures.realised ?? 0,
          // Equity at fair value is what the fund still holds in the property.
          // What has already come back is carried beside it and deliberately
          // not counted as exposure.
          unrealised: figures.unrealised,
          source: `${fund.name} quarterly report, at 100% of the fund`,
        });
      }
    }
  }

  if (bridgeBreaks.length > 0) {
    problems.push(
      `${bridgeBreaks.length} propert(ies) whose movement in value is not explained by the `
      + `capitalisation rate, operating income and rehabilitation the workbook states: `
      + `${bridgeBreaks.slice(0, 5).join(', ')}${bridgeBreaks.length > 5 ? ', and others' : ''}.`,
    );
  }

  if (unmapped.size > 0) {
    notes.push(
      `${unmapped.size} column(s) of the quarter sheets are not ones this reader knows by name, `
      + 'so they are kept under a name derived from their own heading rather than dropped: '
      + `${[...unmapped].slice(0, 6).map((name) => name.replace('reported.', '')).join(', ')}`
      + `${unmapped.size > 6 ? ', and others' : ''}.`,
    );
  }
  if (metrics.length > 0) {
    notes.push(
      `${metrics.length} figure(s) beside the valuations — what moved each value, the debt, the `
      + 'operations against budget, the rehabilitation and the narrative — are kept as reported. '
      + 'Nothing computed depends on them; the report pages do.',
    );
  }

  notes.push(
    'An adviser runs no vehicle, so there is no product net asset value here and no balance '
    + 'sheet to read. What the mandate is worth is the capital account, and the advisory fee is '
    + 'filed against the holder, which is what makes the return net of it differ from the gross.',
  );

  return {
    program: summary.fund,
    vehicleId,
    positions,
    valuations,
    cashflows,
    investors: [investor],
    assets,
    assetValuations,
    balanceSheets: [],
    metrics,
    fxRates: [...new Map(fxRates.map((rate) => [rate.id, rate])).values()],
    problems,
    periods: [...periods].sort(),
    notes,
  };
}

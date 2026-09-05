/**
 * Reading a quarterly reporting workbook.
 *
 * The other reader takes a portfolio database — one manager's whole book of
 * funds across every programme they run. This one takes the workbook a desk
 * builds *for one product, for one quarter*: a control panel naming the
 * reporting date, one ledger of every movement in the portfolio, the
 * administrator's balance sheet quarter by quarter, and the investors' own
 * ledger.
 *
 * They are different documents with different authorities, which is why they
 * are read separately rather than through one lenient reader. A portfolio
 * database is what the manager knows about their funds. This is what the
 * product's own books say — so it carries the two things a portfolio database
 * cannot: the cash and accruals that sit outside the portfolio, and the
 * capital accounts of the people who subscribed.
 *
 * Four conventions this reader has to get right, because each is a place where
 * a plausible wrong answer is available:
 *
 *   Acquisition costs are capitalised, not expensed. The workbook's own
 *   identity is "called = drawn + acquisition costs", so they are filed as
 *   capital called that does not draw down commitment. Filing them as an
 *   expense would leave paid-in short by the exact amount the desk reports.
 *
 *   Distributions are written positive and calls positive, each on its own
 *   side of the ledger. This application signs everything from the vehicle's
 *   side, so calls are negated and distributions are not.
 *
 *   A capital-call row with a negative amount is a net receipt, not a
 *   correction to ignore: the sign is followed rather than the column heading.
 *
 *   The rate beside each row is euros per unit of the row's currency, which is
 *   the inverse of the direction a rate table is usually written in.
 */

import { periodForDate, type PeriodId } from '../domain/period';
import type {
  Cashflow, CashflowType, CurrencyCode, FxRate, Investor, Metric, Position, PositionKind,
  PositionValuation, VehicleBalanceSheet,
} from '../domain/types';
import type { TableData } from './types';
import type { Cell } from './workbook';
import type { ImportPlan } from './pfdb';

const SHEETS = {
  cover: 'cover',
  investments: 'investments',
  balance: 'bs',
  investors: 'investors cf',
  income: 'p&l',
  acquisitionCosts: 'acquisition costs',
} as const;

/** What the workbook is about, before anything is imported from it. */
export interface SupportSummary {
  /** The product, as the workbook's own cover names it. */
  fund: string;
  currency: CurrencyCode;
  /** The quarter the workbook was built for. */
  reportingDate?: string;
  holdings: number;
  movements: number;
  investors: number;
  balanceSheets: number;
  first?: PeriodId;
  last?: PeriodId;
}

export interface SupportOptions {
  vehicleId: string;
  recordedAt?: string;
}

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

/**
 * Dates arrive three ways in one workbook: as a spreadsheet serial, as an ISO
 * string, and — in the balance sheet's own headings — typed by hand as
 * `31.03.2025`. All three are the same quarter and all three are accepted.
 */
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

function sheet(sheets: TableData[], name: string): TableData | undefined {
  return sheets.find((s) => s.sheetName.trim().toLowerCase() === name);
}

/** The row that carries the column headings, found by what must be on it. */
function headerRow(table: TableData, required: string[]): number {
  const wanted = required.map((r) => r.toLowerCase());
  for (let i = 0; i < Math.min(table.rows.length, 12); i += 1) {
    const cells = table.rows[i].map((cell) => text(cell).toLowerCase());
    if (wanted.every((name) => cells.includes(name))) return i;
  }
  return -1;
}

interface Columns {
  index(name: string): number;
  text(row: Cell[], name: string): string;
  number(row: Cell[], name: string): number | undefined;
  date(row: Cell[], name: string): string | undefined;
}

function columns(header: Cell[]): Columns {
  const at = new Map<string, number>();
  header.forEach((cell, i) => {
    const name = text(cell).toLowerCase();
    if (name && !at.has(name)) at.set(name, i);
  });
  const index = (name: string) => at.get(name.toLowerCase()) ?? -1;
  return {
    index,
    text: (row, name) => (index(name) < 0 ? '' : text(row[index(name)])),
    number: (row, name) => (index(name) < 0 ? undefined : toNumber(row[index(name)])),
    date: (row, name) => (index(name) < 0 ? undefined : toDate(row[index(name)])),
  };
}

/* ------------------------------------------------------------------ *
 * What is in the workbook
 * ------------------------------------------------------------------ */

export function isSupportWorkbook(sheets: TableData[]): boolean {
  const investments = sheet(sheets, SHEETS.investments);
  if (!investments) return false;
  // A portfolio database also has a sheet of holdings; what marks this one is a
  // dated ledger of events for them.
  return headerRow(investments, ['Asset', 'Event', 'Date', 'NAV']) >= 0;
}

export function summariseSupport(sheets: TableData[]): SupportSummary | undefined {
  if (!isSupportWorkbook(sheets)) return undefined;

  const cover = sheet(sheets, SHEETS.cover);
  let fund = '';
  let currency: CurrencyCode = 'EUR';
  let reportingDate: string | undefined;

  if (cover) {
    // The masthead is the lines above the control panel: the house, then the
    // product. The product is the one worth carrying, and it is the second.
    const masthead: string[] = [];
    for (const row of cover.rows) {
      const cells = row.map(text).filter(Boolean);
      const label = cells[0]?.toLowerCase() ?? '';
      if (label === 'control panel') break;
      if (cells.length === 1 && cells[0].length > 8) masthead.push(cells[0]);
    }
    fund = masthead[1] ?? masthead[0] ?? '';

    for (const row of cover.rows) {
      const cells = row.map(text).filter(Boolean);
      const label = cells[0]?.toLowerCase() ?? '';
      if (label === 'reporting date') reportingDate = toDate(row.find((c) => toDate(c)) ?? null);
      if (label === 'reporting currency' && cells[1]) currency = cells[1].toUpperCase();
    }
  }

  const ledger = readLedger(sheets);
  const balance = readBalanceRows(sheets);
  const investors = readInvestorRows(sheets);
  const periods = [...new Set(ledger.map((row) => row.period))].sort();

  return {
    fund: fund || 'This workbook',
    currency,
    reportingDate,
    holdings: new Set(ledger.map((row) => row.asset)).size,
    movements: ledger.length,
    investors: new Set(investors.map((row) => row.name)).size,
    balanceSheets: balance.length,
    first: periods[0],
    last: periods[periods.length - 1],
  };
}

/* ------------------------------------------------------------------ *
 * The three ledgers, read once and used twice
 * ------------------------------------------------------------------ */

interface LedgerRow {
  line: number;
  asset: string;
  klass: string;
  currency: CurrencyCode;
  date: string;
  period: PeriodId;
  event: string;
  comment: string;
  commitment?: number;
  call?: number;
  acquisition?: number;
  otherExpense?: number;
  recallable?: number;
  distribution?: number;
  nav?: number;
  rate?: number;
  /** The working behind the figure, where the sheet records it. */
  detail: string;
}

function readLedger(sheets: TableData[]): LedgerRow[] {
  const table = sheet(sheets, SHEETS.investments);
  if (!table) return [];
  const header = headerRow(table, ['Asset', 'Event', 'Date', 'NAV']);
  if (header < 0) return [];
  const col = columns(table.rows[header]);

  const rows: LedgerRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const asset = col.text(row, 'Asset');
    // Section markers ("— Q2 2026 basis adjustments —") and the total line.
    if (!asset || asset.startsWith('—') || asset.toLowerCase() === 'total') continue;
    const date = col.date(row, 'Date');
    if (!date) continue;

    rows.push({
      line: i + 1,
      asset,
      klass: col.text(row, 'Class'),
      currency: (col.text(row, 'CCY').toUpperCase() || 'EUR') as CurrencyCode,
      date,
      period: periodForDate(date),
      event: col.text(row, 'Event'),
      comment: col.text(row, 'Comment'),
      commitment: col.number(row, 'Commitment'),
      call: col.number(row, 'Capital Call'),
      acquisition: col.number(row, 'Acq cost'),
      otherExpense: col.number(row, 'Other exp'),
      recallable: col.number(row, 'Recallable'),
      distribution: col.number(row, 'Distributions'),
      detail: col.text(row, 'Source detail'),
      nav: col.number(row, 'NAV'),
      rate: col.number(row, 'FX rate'),
    });
  }
  return rows;
}

interface BalanceRow {
  period: PeriodId;
  date: string;
  cash: number;
  otherAssets: number;
  currentLiabilities: number;
  accruedExpenses: number;
}

/**
 * The balance sheet is the one sheet laid out the other way round: a column per
 * quarter, and a row per line item tagged in a `Mapping` column. The tags are
 * what makes it readable — the labels beside them are in three languages.
 */
function readBalanceRows(sheets: TableData[]): BalanceRow[] {
  const table = sheet(sheets, SHEETS.balance);
  if (!table) return [];

  const header = table.rows.findIndex(
    (row) => text(row[0]).toLowerCase() === 'mapping' && row.some((cell) => toDate(cell)),
  );
  if (header < 0) return [];

  const dates = table.rows[header]
    .map((cell, index) => ({ index, date: toDate(cell) }))
    .filter((entry): entry is { index: number; date: string } => Boolean(entry.date));

  const of = (tag: string, index: number): number => {
    const row = table.rows.find((r) => text(r[0]).toLowerCase() === tag.toLowerCase());
    return row ? toNumber(row[index]) ?? 0 : 0;
  };

  return dates.map(({ index, date }) => ({
    period: periodForDate(date),
    date,
    cash: of('Cash', index),
    // Receivables and prepayments are both "something owed to the fund that is
    // not the portfolio", which is exactly what this field is for.
    otherAssets: of('ST receivables', index) + of('Accruals A', index),
    currentLiabilities: of('ST Liabilities', index),
    accruedExpenses: of('Accruals P', index),
  }));
}

/**
 * The income statement.
 *
 * Laid out like the balance sheet — a `Mapping` column of stable tags, the
 * labels beside them in three languages, a column per period — with one
 * difference that decides how it is filed: its columns are ranges rather than
 * dates, and every one of them starts at the beginning of a year. They are
 * year-to-date figures, so they are named as such and filed against the quarter
 * their range ends in. A reader that treated them as quarterly would double the
 * management fee every quarter after the first.
 *
 * Nothing the engine computes depends on any of it. The total expense ratio,
 * the fee analysis and the operating result on a report page do.
 */
interface IncomeRow {
  tag: string;
  label: string;
  period: PeriodId;
  /** The range the figure covers, as the sheet heads it. */
  basis: string;
  value: number;
}

/** `01.01.2026-30.06.2026` and `23.02.2024-31.12.2024`: a range, not a date. */
function rangeEnd(heading: string): string | undefined {
  const parts = heading.split(/[-–—]/).map((part) => part.trim());
  if (parts.length < 2) return undefined;
  return toDate(parts[parts.length - 1]);
}

function readIncomeRows(sheets: TableData[]): IncomeRow[] {
  const table = sheet(sheets, SHEETS.income);
  if (!table) return [];

  const header = table.rows.findIndex(
    (row) => text(row[0]).toLowerCase() === 'mapping'
      && row.some((cell) => rangeEnd(text(cell))),
  );
  if (header < 0) return [];

  const columnsOf = table.rows[header]
    .map((cell, index) => ({ index, heading: text(cell), end: rangeEnd(text(cell)) }))
    .filter((entry): entry is { index: number; heading: string; end: string } =>
      Boolean(entry.end));

  const rows: IncomeRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const tag = text(row[0]);
    // A row with no tag is a subtotal or a heading: readable, and derived from
    // the tagged rows above it rather than a figure of its own.
    if (!tag) continue;
    // The English label, which is the third of the three the sheet carries.
    const label = text(row[3]) || tag;
    for (const column of columnsOf) {
      const value = toNumber(row[column.index]);
      if (value === undefined) continue;
      rows.push({
        tag, label, period: periodForDate(column.end), basis: column.heading, value,
      });
    }
  }
  return rows;
}

/**
 * The accounting ledger behind the capitalised acquisition costs.
 *
 * Not filed: its lines are the components of a figure the investments ledger
 * already carries, and filing both would count the cost twice. It is read to
 * check one against the other — the workbook's own third control, enforced
 * rather than looked at.
 *
 * Its own summary total is what is read, not the lines above it. Which lines
 * are capitalised is marked in prose beside them — "capitalised" on most, "new
 * in Q2" or "internal estimate" on others that are capitalised just the same —
 * and a reader that added up the ones it recognised would quietly report a
 * shortfall that is its own.
 */
function readAcquisitionTotal(sheets: TableData[]): number | undefined {
  const table = sheet(sheets, SHEETS.acquisitionCosts);
  if (!table) return undefined;

  const summary = table.rows.findIndex((row) => /summary/i.test(text(row[0])));
  if (summary < 0) return undefined;

  for (let i = summary + 1; i < table.rows.length; i += 1) {
    if (!/^total$/i.test(text(table.rows[i][0]))) continue;
    return table.rows[i].map(toNumber).find((value) => value !== undefined);
  }
  return undefined;
}

interface InvestorRow {
  line: number;
  name: string;
  date: string;
  period: PeriodId;
  description: string;
  commitment?: number;
  called?: number;
  fees?: number;
  rebate?: number;
}

function readInvestorRows(sheets: TableData[]): InvestorRow[] {
  const table = sheet(sheets, SHEETS.investors);
  if (!table) return [];
  const header = headerRow(table, ['Short Name', 'Commitment', 'Capital Called']);
  if (header < 0) return [];
  const col = columns(table.rows[header]);

  const rows: InvestorRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const name = col.text(row, 'Short Name');
    // Rows carrying no investor id are the fund's own marker lines, which exist
    // to date the share count rather than to record a movement.
    const id = col.text(row, 'ID');
    if (!name || !id) continue;
    const date = col.date(row, 'Date');
    if (!date) continue;

    rows.push({
      line: i + 1,
      name,
      date,
      period: periodForDate(date),
      description: col.text(row, 'Description'),
      commitment: col.number(row, 'Commitment'),
      called: col.number(row, 'Capital Called'),
      fees: col.number(row, 'Other (fees)'),
      rebate: col.number(row, 'Rebates'),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

const KIND: Record<string, PositionKind> = {
  primary: 'fund',
  secondary: 'secondary',
  'co-investment': 'co-investment',
  coinvestment: 'co-investment',
  direct: 'direct-investment',
};

/** `Invest.Income` -> `investIncome`, so a tag is a name rather than a label. */
function camel(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  return words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('') || 'unnamed';
}

const round = (value: number): string =>
  Math.round(value).toLocaleString('en-GB');

function slug(value: string): string {
  const full = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return full || 'x';
}

export function planSupportImport(sheets: TableData[], options: SupportOptions): ImportPlan {
  const summary = summariseSupport(sheets);
  if (!summary) {
    throw new Error('This workbook has no dated ledger of investments, so it is not a reporting workbook.');
  }

  const { vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();

  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${slug(summary.fund).slice(0, 24)}-${(sequence += 1)}`;

  /* --- holdings --------------------------------------------------- */

  const ledger = readLedger(sheets);
  const positions: Position[] = [];
  const positionOf = new Map<string, Position>();

  for (const row of ledger) {
    let position = positionOf.get(row.asset);
    if (!position) {
      position = {
        id: `pos-${slug(summary.fund).slice(0, 16)}-${slug(row.asset)}`,
        vehicleId,
        kind: KIND[row.klass.toLowerCase()] ?? 'fund',
        name: row.asset,
        currency: row.currency,
        vintage: Number(row.date.slice(0, 4)),
        commitmentDate: row.date,
        commitment: 0,
        // The workbook does not say what share of each fund the product holds,
        // so nothing is scaled by a guess. Look-through comes from company
        // figures, which this workbook does not carry.
        ownership: 1,
        assetClass: 'Unclassified',
        region: 'Unclassified',
        status: 'Investing',
      };
      positions.push(position);
      positionOf.set(row.asset, position);
    }
    if (row.commitment) position.commitment += row.commitment;
    if (row.date < position.commitmentDate) position.commitmentDate = row.date;
  }

  /* --- valuations and movements ----------------------------------- */

  const valuations: PositionValuation[] = [];
  const cashflows: Cashflow[] = [];
  const rates = new Map<string, FxRate>();

  // A figure in the NAV column only means a valuation when the row says it is
  // one. This workbook has a distribution row carrying a number there too, and
  // reading it as a valuation put one holding at fifty thousand instead of six
  // and a half million — a wrong figure that ties to nothing and looks like a
  // collapse rather than a misread.
  const valued = new Map<string, LedgerRow>();
  for (const row of ledger) {
    if (row.nav === undefined) continue;
    if (row.event.trim().toLowerCase() !== 'nav') {
      problems.push(
        `Investments row ${row.line} (${row.asset}, ${row.date}): the NAV column holds a figure on `
        + `a "${row.event || 'blank'}" row. It was not read as a valuation.`,
      );
      continue;
    }
    // Several valuations can fall in one quarter — an appendix figure after a
    // preliminary one. The last one dated in the quarter is the quarter's.
    const key = `${row.asset}/${row.period}`;
    const held = valued.get(key);
    if (!held || row.date >= held.date) valued.set(key, row);
  }

  for (const row of valued.values()) {
    valuations.push({
      id: id('val'),
      positionId: positionOf.get(row.asset)!.id,
      period: row.period,
      recordedAt,
      nav: row.nav!,
      source: `${summary.fund} — ${row.comment || 'NAV'}`,
    });
  }

  for (const row of ledger) {
    const position = positionOf.get(row.asset)!;
    periods.add(row.period);

    const flows: Array<{ type: CashflowType; amount: number; recallable?: boolean; commits: boolean; note: string }> = [];

    if (row.call) {
      // Positive is money out of the product, negative is money back into it;
      // the sign is followed rather than the column heading.
      flows.push({
        type: row.call >= 0 ? 'Capital Call' : 'Distribution',
        amount: -row.call,
        commits: true,
        note: row.comment || 'Capital call',
      });
    }
    if (row.acquisition) {
      flows.push({
        type: 'Capital Call',
        amount: -row.acquisition,
        // Capitalised into the investment, so it is called capital — but it
        // does not consume commitment, which is the workbook's own convention.
        commits: false,
        note: row.comment || 'Acquisition cost',
      });
    }
    if (row.otherExpense) {
      flows.push({
        type: 'Equalisation',
        amount: -row.otherExpense,
        commits: false,
        note: row.comment || 'Equalisation',
      });
    }
    if (row.recallable) {
      flows.push({
        type: 'Distribution',
        amount: row.recallable,
        recallable: true,
        commits: false,
        note: row.comment || 'Recallable distribution',
      });
    }
    if (row.distribution) {
      flows.push({
        type: 'Distribution',
        amount: row.distribution,
        commits: false,
        note: row.comment || 'Distribution',
      });
    }

    for (const flow of flows) {
      cashflows.push({
        id: id('cf'),
        vehicleId,
        positionId: position.id,
        type: flow.type,
        amount: flow.amount,
        currency: row.currency,
        date: row.date,
        period: row.period,
        recordedAt,
        affectsCommitment: flow.commits && flow.type === 'Capital Call',
        recallable: flow.recallable,
        description: flow.note,
        // The notice, the components, the account it was booked to. Dropping
        // it means finding it again in the file, which is the thing this
        // application exists to make unnecessary.
        sourceDetail: row.detail || undefined,
        status: 'Confirmed',
      });
    }

    // The rate beside a row is euros per unit of that row's currency, which is
    // the direction this application stores: one unit of base buys `rate` of
    // quote.
    //
    // Every row in a quarter carries the rate of its own date, and a stock
    // translates at the closing one — so the latest row in the quarter wins.
    // Keeping the first put one holding seventy-four thousand above the
    // balance sheet it has to tie to.
    // Every rate the ledger states, on the date it states it for — not one a
    // quarter. A movement was converted at the rate beside it, and the quarter's
    // closing rate is the last of them rather than a different figure; keeping
    // only that one leaves every earlier conversion unreproducible.
    if (row.rate && row.currency !== summary.currency) {
      rates.set(`${row.currency}/${row.date}`, {
        id: `fx-${row.currency}-${row.date}`,
        base: row.currency,
        quote: summary.currency,
        rate: row.rate,
        date: row.date,
        period: row.period,
        recordedAt,
        kind: 'closing',
        source: `${summary.fund} reporting workbook`,
        authority: 'manual',
      });
    }
  }

  if (ledger.some((row) => row.event.toLowerCase().startsWith('basis adj'))) {
    notes.push(
      'The basis adjustments are filed as movements on their own dates, so the quarter they '
      + 'belong to carries them and earlier quarters stay as they were published.',
    );
  }

  /* --- the balance sheet ------------------------------------------ */

  const balanceSheets: VehicleBalanceSheet[] = readBalanceRows(sheets).map((row) => {
    periods.add(row.period);
    return {
      vehicleId,
      period: row.period,
      recordedAt,
      cash: row.cash,
      otherAssets: row.otherAssets,
      currentLiabilities: row.currentLiabilities,
      accruedExpenses: row.accruedExpenses,
      source: `${summary.fund} — balance sheet`,
    };
  });

  if (balanceSheets.length === 0) {
    problems.push(
      'No balance sheet was found, so the net tier will be the portfolio alone and will not tie '
      + 'to the financials.',
    );
  } else {
    notes.push(
      `Cash and accruals for ${balanceSheets.length} quarter(s) came from the balance sheet, `
      + 'which is what lets the net asset value tie to the accounts rather than to the portfolio.',
    );
  }

  /* --- the income statement ---------------------------------------- */

  const metrics: Metric[] = [];
  for (const row of readIncomeRows(sheets)) {
    periods.add(row.period);
    metrics.push({
      id: `met-${vehicleId}-${row.period}-pl.${slug(row.tag)}`,
      scope: { kind: 'vehicle', id: vehicleId },
      period: row.period,
      recordedAt,
      // Named year-to-date because that is what the column is. A quarter's own
      // figure is the difference between two of these, and calling it anything
      // else invites somebody to add four of them together.
      metric: `pl.ytd.${camel(row.tag)}`,
      value: row.value,
      unit: summary.currency,
      source: `${summary.fund} — profit and loss, ${row.basis}`,
    });
  }
  if (metrics.length > 0) {
    notes.push(
      `${metrics.length} figure(s) from the income statement are kept as year-to-date amounts `
      + 'against the quarter each range ends in. Nothing computed depends on them; the expense '
      + 'ratio and the fee analysis on a report page do.',
    );
  }

  /* --- what the accounting ledger says the costs were --------------- */

  // In the product's currency, not in each row's own. One holding is in
  // sterling and its costs are stated there, so a plain sum across the ledger
  // compares a mixed total against a euro one and reports a break that is only
  // the exchange rate.
  const capitalised = ledger.reduce(
    (sum, row) => sum + (row.acquisition ?? 0) * (row.rate ?? 1), 0,
  );
  const ledgerTotal = readAcquisitionTotal(sheets);
  if (ledgerTotal !== undefined) {
    // Kept so the check outlives this file. The accounting ledger's itemisation
    // is not filed — its lines are the components of a figure the investments
    // ledger already carries, and filing both would count the cost twice — but
    // its total is what the check needs, and a check that only runs on the day
    // of the import is not one.
    metrics.push({
      id: `met-${vehicleId}-${summary.last ?? 'x'}-accounting.acquisitionCosts`,
      scope: { kind: 'vehicle', id: vehicleId },
      period: summary.last ?? [...periods].sort().pop() ?? '',
      recordedAt,
      metric: 'accounting.capitalisedAcquisitionCosts',
      value: ledgerTotal,
      unit: summary.currency,
      source: `${summary.fund} — acquisition cost ledger`,
    });
  }
  if (ledgerTotal !== undefined && Math.abs(ledgerTotal - capitalised) > 1) {
    problems.push(
      `Capitalised acquisition costs come to ${round(capitalised)} in the investments ledger and `
      + `${round(ledgerTotal)} in the accounting one, a difference of `
      + `${round(capitalised - ledgerTotal)}. One of the two is missing a line.`,
    );
  }

  /* --- the investors ---------------------------------------------- */

  const investorRows = readInvestorRows(sheets);
  const investors: Investor[] = [];
  const investorOf = new Map<string, Investor>();

  for (const row of investorRows) {
    let investor = investorOf.get(row.name);
    if (!investor) {
      investor = {
        id: `inv-${slug(summary.fund).slice(0, 16)}-${slug(row.name)}`,
        vehicleId,
        name: row.name,
        // The workbook does not classify them, and inventing a type would show
        // up on a chart nobody could account for.
        type: 'Institution',
        country: 'Unclassified',
        currency: summary.currency,
        commitment: 0,
        entryDate: row.date,
      };
      investors.push(investor);
      investorOf.set(row.name, investor);
    }
    if (row.commitment) investor.commitment += row.commitment;
    if (row.date < investor.entryDate) investor.entryDate = row.date;

    periods.add(row.period);

    const emit = (type: CashflowType, amount: number, note: string) => {
      cashflows.push({
        id: id('cf'),
        vehicleId,
        investorId: investor!.id,
        type,
        amount,
        currency: summary.currency,
        date: row.date,
        period: row.period,
        recordedAt,
        affectsCommitment: type === 'Capital Call',
        description: note,
        status: 'Confirmed',
      });
    };

    // The investors' ledger is already written from the investor's side, where
    // a call is money they paid out. That is the same sign this application
    // uses, so it is carried across rather than flipped.
    if (row.called) emit('Capital Call', row.called, row.description || 'Capital call');
    if (row.fees) emit('Fee', row.fees, row.description || 'Fee');
    // A rebate is a fee returned, so it is filed as one with the opposite sign
    // rather than as income: fees then read net, which is what the investor is
    // actually charged.
    if (row.rebate) emit('Fee', row.rebate, row.description || 'Rebate');
  }

  if (investors.length === 0) {
    problems.push('No investor rows were found, so the capital accounts will be empty.');
  }

  return {
    program: summary.fund,
    vehicleId,
    positions,
    valuations,
    cashflows,
    investors,
    assets: [],
    assetValuations: [],
    balanceSheets,
    metrics,
    fxRates: [...rates.values()],
    problems,
    periods: [...periods].sort(),
    notes,
  };
}

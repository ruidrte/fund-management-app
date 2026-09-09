/**
 * Reading an investment accounts workbook.
 *
 * The supporting file a desk keeps for a fund of funds administered by a
 * third party: one ledger of every movement with every holding, the
 * administrator's financial statements quarter by quarter, and the register
 * feed the administrator writes the capital accounts from. It is the seventh
 * shape and the closest to the quarterly reporting workbook — it carries the
 * same three things — and it is read separately because the sheets are laid
 * out differently in every particular, and a reader lenient enough to take
 * both would take a third thing as well.
 *
 * Five conventions this reader has to get right, because each is a place where
 * a plausible wrong answer is available:
 *
 *   The ledger is signed from the fund's side: a call is positive, a
 *   distribution negative. This application signs everything from the
 *   vehicle's side, where a call is money out, so every amount is negated.
 *
 *   The off-commitment column carries both directions. A positive figure is
 *   an expense paid outside the commitment — equalisation interest, a
 *   secondary premium, an expense advance — and belongs in what was paid. A
 *   negative one is income received outside the commitment and belongs in what
 *   came back. The column heading says "expenses (income)" and means it.
 *
 *   A recallable distribution is a distribution. It is marked as recallable so
 *   the basis in force at the fund — which nets it off what was drawn rather
 *   than counting it as returned — can be reconstructed, and it is not netted
 *   here, because a distribution that has been netted cannot be un-netted by
 *   whoever needs the other basis.
 *
 *   The register feed's event type says which way the money went, and its
 *   sign says nothing: one extract of it carries every value positive, an
 *   earlier one carries the investor's own signs, and both mean the same
 *   thing. So the magnitude is taken and the event decides. An equalisation
 *   distributed to an earlier investor is capital handed back out of the
 *   denominator, filed as a negative call rather than as a distribution, which
 *   is the same rule the reporting workbook's reader follows for a negative row
 *   in the call column.
 *
 *   The euro columns beside the local ones are the local figure at the rate on
 *   the row, and nothing else. They are checked against that rather than read,
 *   because a figure that can be derived is one that only ever disagrees with
 *   its derivation by mistake.
 */

import { periodForDate, type PeriodId } from '../domain/period';
import type {
  Cashflow, CashflowType, CurrencyCode, FxRate, Investor, Metric, Position, PositionKind,
  PositionValuation, VehicleBalanceSheet,
} from '../domain/types';
import { distinctly, factId, slug } from './ids';
import type { TableData } from './types';
import type { Cell } from './workbook';
import type { ImportPlan } from './pfdb';

const SHEETS = {
  accounts: 'investment accounts',
  register: 'onesource',
  financials: 'fs',
  snapshot: 'portfolio new',
} as const;

/** What the workbook is about, before anything is imported from it. */
export interface AccountsSummary {
  /** The product, as the register feed names its compartment. */
  fund: string;
  currency: CurrencyCode;
  /** The latest quarter the portfolio is valued at. */
  reportingDate?: string;
  holdings: number;
  movements: number;
  investors: number;
  balanceSheets: number;
  first?: PeriodId;
  last?: PeriodId;
}

export interface AccountsOptions {
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

const round = (value: number): string =>
  value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ *
 * What is in the workbook
 * ------------------------------------------------------------------ */

const ACCOUNT_COLUMNS = ['Class', 'Asset', 'Date', 'CCY', 'Capital Call', 'NAV'];

export function isAccountsWorkbook(sheets: TableData[]): boolean {
  const accounts = sheet(sheets, SHEETS.accounts);
  if (!accounts) return false;
  // The reporting workbook also has a dated ledger of holdings, under another
  // name and with an event column this one does not have. What marks this one
  // is the ledger's own name and its class-and-currency columns.
  return headerRow(accounts, ACCOUNT_COLUMNS) >= 0;
}

export function summariseAccounts(sheets: TableData[]): AccountsSummary | undefined {
  if (!isAccountsWorkbook(sheets)) return undefined;

  const ledger = readLedger(sheets);
  const register = readRegisterRows(sheets);
  const balance = readBalanceRows(sheets);
  const periods = [...new Set(ledger.map((row) => row.period))].sort();

  // The workbook has no cover. The register feed names the compartment on
  // every row, and that is the product's own name for itself.
  const fund = register.find((row) => row.fund)?.fund ?? '';
  const valued = ledger.filter((row) => row.nav !== undefined).map((row) => row.date).sort();

  return {
    fund: fund || 'This workbook',
    // The financials, the register and every euro column are in one currency,
    // and nothing in the file names it. The register's unit column does.
    currency: register.find((row) => row.currency)?.currency ?? 'EUR',
    reportingDate: valued[valued.length - 1],
    holdings: new Set(ledger.map((row) => row.asset)).size,
    movements: ledger.length,
    investors: new Set(register.map((row) => row.key)).size,
    balanceSheets: balance.length,
    first: periods[0],
    last: periods[periods.length - 1],
  };
}

/* ------------------------------------------------------------------ *
 * The portfolio ledger
 * ------------------------------------------------------------------ */

interface LedgerRow {
  line: number;
  klass: string;
  asset: string;
  date: string;
  period: PeriodId;
  comment: string;
  currency: CurrencyCode;
  commitment?: number;
  call?: number;
  /** Positive is an expense paid outside the commitment; negative is income received. */
  offCommitment?: number;
  recallable?: number;
  distribution?: number;
  nav?: number;
  rate?: number;
  /** The euro figures the sheet carries beside the local ones, for checking. */
  euro: { commitment?: number; call?: number; offCommitment?: number; recallable?: number; distribution?: number; nav?: number };
  /** The FX policy and change log, which the sheet keeps in a column of its own. */
  aside: string;
}

function readLedger(sheets: TableData[]): LedgerRow[] {
  const table = sheet(sheets, SHEETS.accounts);
  if (!table) return [];
  const header = headerRow(table, ACCOUNT_COLUMNS);
  if (header < 0) return [];
  const col = columns(table.rows[header]);

  const rows: LedgerRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const asset = col.text(row, 'Asset');
    const date = col.date(row, 'Date');
    if (!asset || !date) continue;

    rows.push({
      line: i + 1,
      klass: col.text(row, 'Class'),
      asset,
      date,
      period: periodForDate(date),
      comment: col.text(row, 'Comment'),
      currency: (col.text(row, 'CCY').toUpperCase() || 'EUR') as CurrencyCode,
      commitment: col.number(row, 'Commitment'),
      call: col.number(row, 'Capital Call'),
      offCommitment: col.number(row, 'Off commit Expenses (income)'),
      recallable: col.number(row, 'Distributions (rec.)'),
      distribution: col.number(row, 'Distributions'),
      nav: col.number(row, 'NAV'),
      rate: col.number(row, 'FX Rate applied'),
      euro: {
        commitment: col.number(row, 'Commit. €'),
        call: col.number(row, 'Capital Call €'),
        offCommitment: col.number(row, 'Off commit Expenses (income) €'),
        recallable: col.number(row, 'Distributions (rec.) €'),
        distribution: col.number(row, 'Distributions €'),
        nav: col.number(row, 'NAV €'),
      },
      aside: col.text(row, 'FX policy'),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The financial statements
 *
 * A column per quarter and a row per line, the lines numbered in an outline
 * the way an administrator's trial balance is. The captions are what a reader
 * can hold onto: the numbering restarts for the income statement and is
 * repeated for two lines of the balance sheet, so it locates nothing on its own.
 * ------------------------------------------------------------------ */

interface BalanceRow {
  period: PeriodId;
  date: string;
  investments: number;
  cash: number;
  otherAssets: number;
  currentLiabilities: number;
  accruedExpenses: number;
  /** What the statements say the fund is worth to its partners. */
  capitalAndReserves: number;
  /**
   * The carried interest the statements have set aside for the carry holder.
   * Under partners' capital in the accounts, and in no partner's capital
   * account — the accounts the register feed confirms sum to the capital less
   * this — so it is carried here as what it is to the limited partners: an
   * accrual against them.
   */
  carriedInterest: number;
  /** What the partners have paid in, net, and been paid out, per the statements. */
  contributions: number;
  distributions: number;
}

interface IncomeRow {
  period: PeriodId;
  caption: string;
  value: number;
}

const BALANCE_LINES = {
  investments: /^investments/i,
  cash: /^cash and cash equivalents/i,
  debtors: /^debtors and prepayments/i,
  receivables: /^accounts receivable/i,
  establishment: /^establishment costs/i,
  creditors: /^creditors and accruals/i,
  payables: /^accounts payable/i,
  capital: /^capital and reserves/i,
  contributions: /^limited partners contributions/i,
  distributions: /^limited partners distrib/i,
  carry: /carried interest/i,
} as const;

/** The financials, split where the sheet itself changes statement. */
function statements(sheets: TableData[]): {
  dates: Array<{ index: number; date: string }>;
  balance: Cell[][];
  income: Cell[][];
} | undefined {
  const table = sheet(sheets, SHEETS.financials);
  if (!table) return undefined;

  const header = table.rows.findIndex((row) => row.filter((cell) => toDate(cell)).length >= 2);
  if (header < 0) return undefined;
  const dates = table.rows[header]
    .map((cell, index) => ({ index, date: toDate(cell) }))
    .filter((entry): entry is { index: number; date: string } => Boolean(entry.date));

  // The first column names the statement on the row it starts, and is blank
  // on every other. The income statement is everything from its marker on.
  const split = table.rows.findIndex(
    (row, i) => i > header && /p\s*&\s*l|income statement|profit/i.test(text(row[0])),
  );
  return {
    dates,
    balance: table.rows.slice(header + 1, split < 0 ? undefined : split),
    income: split < 0 ? [] : table.rows.slice(split),
  };
}

/** The caption a line carries: the first text cell that is not the outline number. */
function captionOf(row: Cell[]): string {
  return row.map(text).find((value, i) => i > 0 && value && !/^\d+(\.\d+)*$/.test(value)) ?? '';
}

function readBalanceRows(sheets: TableData[]): BalanceRow[] {
  const parts = statements(sheets);
  if (!parts) return [];

  const line = (pattern: RegExp, index: number): number => {
    const row = parts.balance.find((r) => pattern.test(captionOf(r)));
    return row ? toNumber(row[index]) ?? 0 : 0;
  };

  return parts.dates
    .map(({ index, date }) => ({
      period: periodForDate(date),
      date,
      investments: line(BALANCE_LINES.investments, index),
      cash: line(BALANCE_LINES.cash, index),
      // Everything owed to the fund that is not the portfolio, and the
      // establishment costs it carries as an asset until they are written off.
      otherAssets: line(BALANCE_LINES.debtors, index)
        + line(BALANCE_LINES.receivables, index)
        + line(BALANCE_LINES.establishment, index),
      currentLiabilities: line(BALANCE_LINES.payables, index),
      accruedExpenses: line(BALANCE_LINES.creditors, index) + line(BALANCE_LINES.carry, index),
      capitalAndReserves: line(BALANCE_LINES.capital, index),
      carriedInterest: line(BALANCE_LINES.carry, index),
      contributions: line(BALANCE_LINES.contributions, index),
      distributions: line(BALANCE_LINES.distributions, index),
    }))
    // A quarter the statements have a column for but no figures in is a
    // quarter the administrator has not closed. It is not a balance sheet of
    // nothing.
    .filter((row) => row.capitalAndReserves !== 0 || row.cash !== 0 || row.investments !== 0);
}

function readIncomeRows(sheets: TableData[]): IncomeRow[] {
  const parts = statements(sheets);
  if (!parts) return [];

  const rows: IncomeRow[] = [];
  for (const row of parts.income) {
    const caption = captionOf(row);
    if (!caption) continue;
    for (const { index, date } of parts.dates) {
      const value = toNumber(row[index]);
      if (value === undefined) continue;
      rows.push({ period: periodForDate(date), caption, value });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The register feed
 *
 * One row per event per investor, unsigned, the event type saying which way
 * the money went. The quarter-end capital account statements are in the same
 * list as the movements, which is what lets an investor's account be checked
 * against what the administrator confirmed rather than only derived.
 * ------------------------------------------------------------------ */

interface RegisterRow {
  line: number;
  fund: string;
  /** The identifier the administrator knows the investor by. */
  key: string;
  name: string;
  date: string;
  period: PeriodId;
  event: string;
  value: number;
  currency: CurrencyCode;
  source: string;
}

function readRegisterRows(sheets: TableData[]): RegisterRow[] {
  const table = sheet(sheets, SHEETS.register);
  if (!table) return [];
  const header = headerRow(table, ['Investor_name', 'Investor_Fund_ID', 'Date', 'Event_type', 'Value']);
  if (header < 0) return [];
  const col = columns(table.rows[header]);

  const rows: RegisterRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const key = col.text(row, 'Investor_Fund_ID');
    const name = col.text(row, 'Investor_name');
    const date = col.date(row, 'Date');
    const value = col.number(row, 'Value');
    if (!key || !name || !date || value === undefined) continue;
    rows.push({
      line: i + 1,
      fund: col.text(row, 'Fund_Compartiment'),
      key,
      name,
      date,
      period: periodForDate(date),
      event: col.text(row, 'Event_type'),
      value,
      currency: (col.text(row, 'Unit').toUpperCase() || 'EUR') as CurrencyCode,
      source: col.text(row, 'Source'),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The snapshot the desk publishes from
 *
 * Not read for figures — every one of them is derivable from the ledger — but
 * read for what the desk says the figures are, so the check that the two
 * agree outlives the day of the import.
 * ------------------------------------------------------------------ */

interface Snapshot {
  period: PeriodId;
  commitment?: number;
  drawdown?: number;
  distributed?: number;
  nav?: number;
  open?: number;
  paidIn?: number;
}

function readSnapshot(sheets: TableData[]): Snapshot | undefined {
  const table = sheet(sheets, SHEETS.snapshot);
  if (!table) return undefined;
  const header = headerRow(table, ['Asset', 'Commitment €', 'Drawdown €', 'NAV €']);
  if (header < 0) return undefined;
  const col = columns(table.rows[header]);
  const total = table.rows.slice(header + 1).find((row) => /^total$/i.test(text(row[0])));
  if (!total) return undefined;
  const dated = table.rows.slice(header + 1).map((row) => col.date(row, 'Date')).find(Boolean);
  if (!dated) return undefined;
  return {
    period: periodForDate(dated),
    commitment: col.number(total, 'Commitment €'),
    drawdown: col.number(total, 'Drawdown €'),
    distributed: col.number(total, 'Distributed €'),
    nav: col.number(total, 'NAV €'),
    open: col.number(total, 'Open €'),
    paidIn: col.number(total, 'Paid-In €'),
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

const KIND: Record<string, PositionKind> = {
  primary: 'fund',
  secondary: 'secondary',
  'co-inv.': 'co-investment',
  'co-inv': 'co-investment',
  'co-investment': 'co-investment',
  gp: 'direct-investment',
};

function camel(value: string): string {
  return slug(value).split('-').map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1))).join('');
}

export function planAccountsImport(sheets: TableData[], options: AccountsOptions): ImportPlan {
  const summary = summariseAccounts(sheets);
  if (!summary) {
    throw new Error('This workbook has no ledger of investment accounts, so it is not one.');
  }

  const { vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();

  const book = slug(summary.fund).slice(0, 24);
  const distinct = distinctly();

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
  const metrics: Metric[] = [];
  const rates = new Map<string, FxRate>();

  const valued = new Map<string, LedgerRow>();
  for (const row of ledger) {
    if (row.nav === undefined) continue;
    if (!/nav/i.test(row.comment)) {
      problems.push(
        `Investment Accounts row ${row.line} (${row.asset}, ${row.date}): the NAV column holds a `
        + `figure on a "${row.comment || 'blank'}" row. It was not read as a valuation.`,
      );
      continue;
    }
    const key = `${row.asset}/${row.period}`;
    const held = valued.get(key);
    if (!held || row.date >= held.date) valued.set(key, row);
  }

  for (const row of valued.values()) {
    const position = positionOf.get(row.asset)!;
    valuations.push({
      id: factId('val', position.id, row.period),
      positionId: position.id,
      period: row.period,
      recordedAt,
      nav: row.nav!,
      source: `${summary.fund} — ${row.comment}`,
    });
  }

  let euroBreaks = 0;
  for (const row of ledger) {
    const position = positionOf.get(row.asset)!;
    periods.add(row.period);

    const flows: Array<{ type: CashflowType; amount: number; recallable?: boolean; commits: boolean; note: string }> = [];

    // The ledger is written from the fund's side — paid out positive, received
    // negative — and every flow here is from the vehicle's, so each is turned
    // round. A negative call stays a call: it is capital coming back out of
    // the denominator, and the desk's own paid-in is the sum of the column.
    if (row.call) {
      flows.push({ type: 'Capital Call', amount: -row.call, commits: true, note: row.comment || 'Capital call' });
    }
    if (row.offCommitment) {
      flows.push(row.offCommitment > 0
        // Paid, and in the return, and outside the commitment: the very thing
        // an equalisation is, whatever the notice called it.
        ? { type: 'Equalisation', amount: -row.offCommitment, commits: false, note: row.comment || 'Off-commitment expense' }
        // Received outside the commitment. Money back, so it belongs with what
        // came back — and not a distribution of the commitment, which the
        // basis in force at the fund has to be able to leave out.
        : { type: 'Income', amount: -row.offCommitment, commits: false, note: row.comment || 'Off-commitment income' });
    }
    if (row.recallable) {
      flows.push({
        type: 'Distribution', amount: -row.recallable, recallable: true, commits: false,
        note: row.comment || 'Recallable distribution',
      });
    }
    if (row.distribution) {
      flows.push({ type: 'Distribution', amount: -row.distribution, commits: false, note: row.comment || 'Distribution' });
    }

    for (const flow of flows) {
      cashflows.push({
        id: distinct(factId('cf', book, position.id, flow.type, row.date, flow.amount, flow.note)),
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
        status: 'Confirmed',
      });
    }

    // The euro columns are the local figure at the rate on the row. Checked
    // rather than read: a euro figure that disagrees with local times rate is
    // a formula somebody overwrote, and the file is where it has to be fixed.
    const rate = row.rate ?? 1;
    for (const [name, local, euro] of [
      ['Capital Call', row.call, row.euro.call],
      ['Off commit Expenses (income)', row.offCommitment, row.euro.offCommitment],
      ['Distributions (rec.)', row.recallable, row.euro.recallable],
      ['Distributions', row.distribution, row.euro.distribution],
      ['NAV', row.nav, row.euro.nav],
    ] as const) {
      if (local === undefined || euro === undefined) continue;
      if (Math.abs(local * rate - euro) > 0.01) {
        euroBreaks += 1;
        if (euroBreaks <= 5) {
          problems.push(
            `Investment Accounts row ${row.line} (${row.asset}, ${row.date}): ${name} is `
            + `${round(local)} ${row.currency} at ${rate}, which is ${round(local * rate)} `
            + `${summary.currency}; the sheet's own euro column says ${round(euro)}.`,
          );
        }
      }
    }

    if (row.rate && row.currency !== summary.currency) {
      const held = [...rates.values()].find(
        (kept) => kept.base === row.currency && kept.date === row.date && kept.rate !== row.rate,
      );
      if (held) {
        problems.push(
          `Investment Accounts row ${row.line} (${row.asset}, ${row.date}): the file states `
          + `${row.rate} for ${row.currency}/${summary.currency} where an earlier row on the same `
          + `date states ${held.rate}. Both are kept and the first stands for anything converted `
          + 'by date.',
        );
      }
      rates.set(`${row.currency}/${row.date}/${row.rate}`, {
        id: `fx-${row.currency}-${row.date}-${row.rate}`,
        base: row.currency,
        quote: summary.currency,
        rate: row.rate,
        date: row.date,
        period: row.period,
        recordedAt,
        kind: 'closing',
        source: `${summary.fund} investment accounts`,
        authority: 'manual',
      });
    }

    // The commitment in euro is frozen at the rate of the day it was made and
    // never revalued — the file's stated policy, and the opposite of what this
    // application does with a stock. Both are right about different things,
    // so the file's figure is kept beside the holding for the page that has
    // to show what the desk publishes.
    if (row.commitment && row.euro.commitment !== undefined) {
      metrics.push({
        id: `met-${position.id}-${row.period}-commitmentAtCommitmentRate`,
        scope: { kind: 'position', id: position.id },
        period: row.period,
        recordedAt,
        metric: 'accounts.commitmentAtCommitmentRate',
        value: row.euro.commitment,
        unit: summary.currency,
        source: `${summary.fund} — investment accounts, ${row.date}`,
      });
    }
  }
  if (euroBreaks > 5) {
    problems.push(`${euroBreaks - 5} further euro column(s) disagree with local times rate.`);
  }

  // The policy the rates were applied under, and the log of what was
  // corrected. Prose, kept whole: the reasons behind a figure are the part of a
  // file that cannot be re-derived once it is gone.
  const aside = ledger.map((row) => row.aside).filter(Boolean);
  if (aside.length > 0) {
    const last = summary.last ?? [...periods].sort().pop() ?? '';
    metrics.push({
      id: `met-${vehicleId}-${last}-accounts.fxPolicy`,
      scope: { kind: 'vehicle', id: vehicleId },
      period: last,
      recordedAt,
      metric: 'accounts.fxPolicy',
      text: aside.join('\n'),
      source: `${summary.fund} — investment accounts, FX policy column`,
    });
    notes.push(
      `The FX policy and its change log (${aside.length} line(s)) are kept as written, against `
      + `${last}.`,
    );
  }

  /* --- the financial statements ------------------------------------ */

  const balanceRows = readBalanceRows(sheets);
  const balanceSheets: VehicleBalanceSheet[] = balanceRows.map((row) => {
    periods.add(row.period);
    return {
      vehicleId,
      period: row.period,
      recordedAt,
      cash: row.cash,
      otherAssets: row.otherAssets,
      currentLiabilities: row.currentLiabilities,
      accruedExpenses: row.accruedExpenses,
      source: `${summary.fund} — financial statements`,
    };
  });

  for (const row of balanceRows) {
    // What the statements themselves say the fund is worth and holds, so the
    // identity between the portfolio and the accounts is a check and not a
    // coincidence.
    for (const [name, value] of [
      ['fs.investments', row.investments],
      ['fs.capitalAndReserves', row.capitalAndReserves],
      ['fs.contributions', row.contributions],
      ['fs.distributions', row.distributions],
      ['fs.carriedInterest', row.carriedInterest],
    ] as const) {
      metrics.push({
        id: `met-${vehicleId}-${row.period}-${name}`,
        scope: { kind: 'vehicle', id: vehicleId },
        period: row.period,
        recordedAt,
        metric: name,
        value,
        unit: summary.currency,
        source: `${summary.fund} — financial statements, ${row.date}`,
      });
    }
  }

  if (balanceSheets.length === 0) {
    problems.push(
      'No financial statements were found, so the net tier will be the portfolio alone and will '
      + 'not tie to the accounts.',
    );
  } else {
    const lastBalance = balanceRows.map((row) => row.period).sort().pop()!;
    const lastValued = [...valued.values()].map((row) => row.period).sort().pop();
    notes.push(
      `Cash and accruals for ${balanceSheets.length} quarter(s) came from the financial `
      + 'statements, which is what lets the net asset value tie to the accounts.',
    );
    const carried = balanceRows[balanceRows.length - 1].carriedInterest;
    if (carried) {
      notes.push(
        `The statements set aside ${round(carried)} ${summary.currency} of carried interest `
        + 'under partners\u2019 capital. It is in no limited partner\u2019s account, so it is '
        + 'carried as an accrual against them: the net asset value here is capital and reserves '
        + 'less the carry, which is what the confirmed capital accounts sum to.',
      );
    }
    if (lastValued && lastValued > lastBalance) {
      problems.push(
        `The portfolio is valued to ${lastValued} and the financial statements stop at `
        + `${lastBalance}. The later quarter's net tier carries the last known balance sheet `
        + 'until the administrator\'s accounts arrive.',
      );
    }
  }

  for (const row of readIncomeRows(sheets)) {
    periods.add(row.period);
    metrics.push({
      id: `met-${vehicleId}-${row.period}-pl.${slug(row.caption)}`,
      scope: { kind: 'vehicle', id: vehicleId },
      period: row.period,
      recordedAt,
      // Year-to-date, because that is what the column holds: the fourth
      // quarter's management fee is four times the first's.
      metric: `pl.ytd.${camel(row.caption)}`,
      value: row.value,
      unit: summary.currency,
      source: `${summary.fund} — income statement`,
    });
  }

  /* --- what the desk says the portfolio comes to ------------------- */

  const snapshot = readSnapshot(sheets);
  if (snapshot) {
    for (const [name, value] of [
      ['snapshot.commitment', snapshot.commitment],
      ['snapshot.drawdown', snapshot.drawdown],
      ['snapshot.distributed', snapshot.distributed],
      ['snapshot.nav', snapshot.nav],
      ['snapshot.openCommitment', snapshot.open],
      ['snapshot.paidIn', snapshot.paidIn],
    ] as const) {
      if (value === undefined) continue;
      metrics.push({
        id: `met-${vehicleId}-${snapshot.period}-${name}`,
        scope: { kind: 'vehicle', id: vehicleId },
        period: snapshot.period,
        recordedAt,
        metric: name,
        value,
        unit: summary.currency,
        source: `${summary.fund} — portfolio snapshot, ${snapshot.period}`,
      });
    }
    notes.push(
      `The portfolio snapshot's totals for ${snapshot.period} are kept as what the desk `
      + 'published, so what this application computes can be checked against them. Its drawdown '
      + 'is calls net of recallable distributions, which is the basis in force at the fund; its '
      + 'paid-in is the calls alone.',
    );
  }

  /* --- the investors ---------------------------------------------- */

  const register = readRegisterRows(sheets);
  const investors: Investor[] = [];
  const investorOf = new Map<string, Investor>();
  const unknownEvents = new Set<string>();
  const statements = new Map<string, RegisterRow>();

  for (const row of register) {
    let investor = investorOf.get(row.key);
    if (!investor) {
      investor = {
        // By the administrator's identifier, not the name: two investors here
        // share a name to the twentieth character, and a name is what a desk
        // retypes.
        id: `inv-${slug(summary.fund).slice(0, 16)}-${slug(row.key)}`,
        vehicleId,
        name: row.name,
        type: 'Institution',
        country: 'Unclassified',
        currency: row.currency,
        commitment: 0,
        entryDate: row.date,
      };
      investors.push(investor);
      investorOf.set(row.key, investor);
    }
    if (row.date < investor.entryDate) investor.entryDate = row.date;
    periods.add(row.period);

    const emit = (type: CashflowType, amount: number, note: string, commits = false) => {
      cashflows.push({
        id: distinct(factId('cf', book, investor!.id, type, row.date, amount, note)),
        vehicleId,
        investorId: investor!.id,
        type,
        amount,
        currency: row.currency,
        date: row.date,
        period: row.period,
        recordedAt,
        affectsCommitment: commits,
        description: note,
        sourceDetail: row.source || undefined,
        status: 'Confirmed',
      });
    };

    // The event says which way; the magnitude is all the value is read for.
    // One extract of this feed is unsigned and an earlier one signed from the
    // investor's side, and a reader that trusted the sign would turn every
    // dividend in the second into a call. From the vehicle's side money from
    // an investor is positive and money to one negative.
    const event = row.event.toLowerCase();
    const size = Math.abs(row.value);
    if (event === 'subscription') {
      investor.commitment += size;
    } else if (event === 'capital call') {
      emit('Capital Call', size, 'Capital call', true);
    } else if (event === 'equalization called') {
      // A later closer's catch-up: called against their commitment, like any
      // other call.
      emit('Capital Call', size, 'Equalisation called', true);
    } else if (event === 'equalization distributed') {
      // Capital handed back to an earlier closer out of what they had paid.
      // A negative call, not a distribution: it comes out of the denominator
      // and restores commitment, and their DPI did not move.
      emit('Capital Call', -size, 'Equalisation distributed', true);
    } else if (event === 'equalization premium paid') {
      // Named from the investor's side: paid by a later closer, so received by
      // the fund. The statements' contributions line only ties when it is read
      // that way round.
      emit('Equalisation', size, 'Equalisation premium paid');
    } else if (event === 'equalization premium received') {
      emit('Equalisation', -size, 'Equalisation premium received');
    } else if (/^dividend/.test(event)) {
      emit('Distribution', -size, 'Distribution');
    } else if (event === 'capital account statement') {
      // What the administrator confirmed the account was worth at the quarter
      // end — a statement, filed as one, rather than an allocation of the
      // fund's value by contributed capital.
      const at = `${investor.id}/${row.period}`;
      const held = statements.get(at);
      if (!held || held.date <= row.date) statements.set(at, row);
    } else {
      unknownEvents.add(row.event);
    }
  }

  for (const [at, row] of statements) {
    const investorId = at.slice(0, at.lastIndexOf('/'));
    metrics.push({
      id: `met-${investorId}-${row.period}-capitalAccount`,
      scope: { kind: 'investor', id: investorId },
      period: row.period,
      recordedAt,
      metric: 'capitalAccount',
      value: row.value,
      unit: row.currency,
      source: `${summary.fund} — register feed, ${row.date}`,
    });
  }

  if (investors.length === 0) {
    problems.push('No register feed was found, so the capital accounts will be empty.');
  } else {
    notes.push(
      `${investors.length} investor(s) from the register feed, with ${statements.size} confirmed `
      + 'capital account(s). Every movement is unsigned in the feed and signed here by what it is.',
    );
  }
  if (unknownEvents.size > 0) {
    problems.push(
      `${unknownEvents.size} event type(s) in the register feed were not recognised and were `
      + `skipped: ${[...unknownEvents].join('; ')}.`,
    );
  }

  const lastStatement = [...statements.values()].map((row) => row.period).sort().pop();
  const lastValued = [...valued.values()].map((row) => row.period).sort().pop();
  if (lastStatement && lastValued && lastStatement < lastValued) {
    problems.push(
      `The register feed's capital account statements stop at ${lastStatement} and the portfolio `
      + `is valued to ${lastValued}. The newer quarter's accounts are worked out rather than stated.`,
    );
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
    restatesHistory: true,
  };
}

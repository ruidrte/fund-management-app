/**
 * Reading an LP capital master.
 *
 * The fifth shape, and the first for a fund that holds companies rather than
 * other funds. Where the quarterly reporting workbook is one ledger of
 * movements with the accounts beside it, this is a fund's whole record kept in
 * one file: the investors' register and every movement in it, the investments
 * tranche by tranche and share class by share class, the trial balance quarter
 * by quarter, and a change log that says what was restated and why.
 *
 * Four of its two dozen sheets are what somebody types. The rest — the capital
 * account statements, the financial statements, the reconciliations against the
 * administrator, the bridges, the dashboard — are worked out from those four,
 * and are not read: this application computes them, and reading a computed
 * sheet as though it were a source is how a figure comes to have two origins
 * that quietly disagree.
 *
 * What the shape decides:
 *
 *   A position is a company and an asset is a share class of it. That is not a
 *   convenience — the investments ledger records a tranche per class, and the
 *   valuation committee approves a value per class. Look-through here means by
 *   instrument, which for a direct fund is the only look-through there is.
 *
 *   The fund has three share classes of its own — investor, founder and general
 *   partner — and its own figures are quoted sometimes for all of them and
 *   sometimes for the investor class alone. Every investor carries their class
 *   so both can be produced, rather than one being picked here.
 *
 *   Contributions buy units at a fixed price, so units are contributions
 *   divided by that price rather than a figure of their own. The register is
 *   the authority for the money; the unit count follows it.
 */

import { makePeriod, periodForDate, type PeriodId } from '../domain/period';
import type {
  Asset, AssetValuation, Cashflow, CashflowType, CurrencyCode, FxRate, Investor, Metric,
  Position, PositionValuation, VehicleBalanceSheet,
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


/** `Mgt. Fees (on-commit.)` -> `mgtFeesOnCommit`, so a label becomes a name. */
function camel(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  return words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('') || 'unnamed';
}

/* ------------------------------------------------------------------ *
 * Sheets
 * ------------------------------------------------------------------ */

function named(sheets: TableData[], pattern: RegExp): TableData | undefined {
  return sheets.find((sheet) => pattern.test(sheet.sheetName.trim().toLowerCase()));
}

const REGISTER = /^lp db$/;
const INVESTMENTS = /^invs\.?$/;
const TRIAL_BALANCE = /^tb$/;
const PORTFOLIO = /^portfolio$/;
const SUMMARY = /^summary$/;
const README = /^readme/;
const CAPITAL_ACCOUNTS = /cas/;

/** The row carrying the column headings, found by what must be on it. */
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
  text(row: Cell[], name: string): string;
  number(row: Cell[], name: string): number | undefined;
  date(row: Cell[], name: string): string | undefined;
}

function columns(header: Cell[]): Columns {
  const at = new Map<string, number>();
  header.forEach((cell, i) => {
    const name = text(cell).toLowerCase().replace(/\s+/g, ' ');
    if (name && !at.has(name)) at.set(name, i);
  });
  const index = (name: string) => at.get(name.toLowerCase().replace(/\s+/g, ' ')) ?? -1;
  return {
    index,
    text: (row, name) => (index(name) < 0 ? '' : text(row[index(name)])),
    number: (row, name) => (index(name) < 0 ? undefined : toNumber(row[index(name)])),
    date: (row, name) => (index(name) < 0 ? undefined : toDate(row[index(name)])),
  };
}

const REGISTER_HEADINGS = ['investor', 'commitment', 'type of transaction'];
const INVESTMENT_HEADINGS = ['asset', 'invested', 'ccy'];

export function isMasterWorkbook(sheets: TableData[]): boolean {
  const register = named(sheets, REGISTER);
  const investments = named(sheets, INVESTMENTS);
  if (!register || !investments) return false;
  return headerRow(register, REGISTER_HEADINGS) >= 0
    && headerRow(investments, INVESTMENT_HEADINGS) >= 0;
}

/* ------------------------------------------------------------------ *
 * What the workbook is about
 * ------------------------------------------------------------------ */

export interface MasterSummary {
  /** The fund, as the change log's first line names it. */
  fund: string;
  currency: CurrencyCode;
  /** The date the file was re-baselined at, which is the quarter it is for. */
  reportingDate?: string;
  /** Companies held. */
  holdings: number;
  /** Movements in the investors' register. */
  movements: number;
  investors: number;
  balanceSheets: number;
  first?: PeriodId;
  last?: PeriodId;
  /** Share classes across the companies — the look-through unit here. */
  instruments: number;
}

export interface MasterOptions {
  vehicleId: string;
  recordedAt?: string;
  /**
   * What one unit costs, in the fund's currency. Contributions buy units at a
   * fixed price and the register records the money; the unit count follows it.
   *
   * Absent, it is worked out from the workbook's own figures — the units it
   * says are in issue against the capital it says was called — and where those
   * do not give a round price, units are left unfiled rather than derived at a
   * guess.
   */
  unitPrice?: number;
}

/**
 * What one unit costs, worked out from the workbook rather than assumed.
 *
 * The register records money and the dashboard records units in issue; one
 * divided by the other is the price. It is accepted only where it comes out a
 * round figure, because a price that is nearly a thousand is a sign that the
 * two numbers are not measuring the same thing, and a unit count derived from
 * such a price would be wrong in a way nothing on the screen would show.
 */
function unitPriceIn(sheets: TableData[], register: RegisterRow[]): number | undefined {
  const summary = named(sheets, SUMMARY);
  if (!summary) return undefined;

  const units = summary.rows
    .filter((row) => row.some((cell) => /^units (held|in issue)$/i.test(text(cell))))
    .flatMap((row) => row.map(toNumber).filter((value): value is number => value !== undefined))
    .sort((a, b) => b - a)[0];
  if (!units || units <= 0) return undefined;

  const called = register.reduce(
    (sum, row) => sum + row.contributions
      .filter((entry) => entry.column === CONTRIBUTION_COLUMNS[0][0])
      .reduce((own, entry) => own + entry.amount, 0),
    0,
  );
  if (called <= 0) return undefined;

  const implied = called / units;
  const rounded = Math.pow(10, Math.round(Math.log10(implied)));
  return Math.abs(implied / rounded - 1) < 0.005 ? rounded : undefined;
}

/** The fund's name, from the first line of the change log. */
function fundName(sheets: TableData[]): string {
  const sheet = named(sheets, README) ?? named(sheets, SUMMARY);
  for (const row of (sheet?.rows ?? []).slice(0, 6)) {
    const line = text(row.find((cell) => text(cell).length > 20) ?? null);
    if (line) return line.split(' - ')[0].trim();
  }
  return 'This fund';
}

/** The as-of date the workbook was built for. */
function reportingDate(sheets: TableData[]): string | undefined {
  const summary = named(sheets, SUMMARY);
  for (const row of summary?.rows ?? []) {
    const cells = row.map(text);
    if (!cells.some((cell) => /^as of:?$/i.test(cell))) continue;
    const found = row.map(toDate).find(Boolean);
    if (found) return found;
  }
  // Failing that, the last dated column of the trial balance.
  const dates = trialBalanceDates(sheets);
  return dates[dates.length - 1]?.date;
}

/* ------------------------------------------------------------------ *
 * The investors' register
 * ------------------------------------------------------------------ */

/**
 * The fee columns, and what each one is.
 *
 * They are split because the fund's own reporting splits them: a management fee
 * charged inside the commitment consumes it, one charged outside does not, and
 * the total called is quoted both ways. Collapsing them into a single "fee"
 * would leave the two figures the fund publishes unreachable.
 */
const CONTRIBUTION_COLUMNS: Array<[string, CashflowType, boolean, string]> = [
  ['Investment (on-commit.)', 'Capital Call', true, 'capital'],
  ['Mgt. Fees (on-commit.)', 'Fee', true, 'management fee'],
  ['Mgt. Fees (off-commit.)', 'Fee', false, 'management fee, outside the commitment'],
  ['Fund OpEx (off.commit.)', 'Expense', false, 'fund operating expenses'],
  ['Setup Fees (Off-commit)', 'Fee', false, 'set-up fee'],
];

interface RegisterRow {
  line: number;
  date: string;
  period: PeriodId;
  investor: string;
  klass: string;
  status: string;
  account: string;
  address: string;
  shareClass: string;
  description: string;
  kind: string;
  currency: CurrencyCode;
  commitment?: number;
  contributions: Array<{ column: string; amount: number }>;
}

function readRegister(sheets: TableData[]): RegisterRow[] {
  const table = named(sheets, REGISTER);
  if (!table) return [];
  const header = headerRow(table, REGISTER_HEADINGS);
  if (header < 0) return [];
  const at = columns(table.rows[header]);

  const rows: RegisterRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const date = at.date(row, 'Date');
    const investor = at.text(row, 'Investor');
    if (!date || !investor) continue;

    rows.push({
      line: i + 1,
      date,
      period: periodForDate(date),
      investor,
      klass: at.text(row, 'Type of Investor') || 'LP',
      status: at.text(row, 'Status'),
      account: at.text(row, 'Account #') || at.text(row, 'Account ID'),
      address: at.text(row, 'Address'),
      shareClass: at.text(row, 'Shares class'),
      description: at.text(row, 'Description'),
      kind: at.text(row, 'Type of transaction'),
      currency: (at.text(row, 'CCY').toUpperCase() || 'EUR') as CurrencyCode,
      commitment: at.number(row, 'Commitment'),
      contributions: CONTRIBUTION_COLUMNS
        .map(([column]) => ({ column, amount: at.number(row, column) ?? 0 }))
        .filter((entry) => entry.amount !== 0),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The investments ledger
 * ------------------------------------------------------------------ */

interface InvestmentRow {
  line: number;
  date: string;
  period: PeriodId;
  asset: string;
  shortName: string;
  currency: CurrencyCode;
  instrument: string;
  commitment?: number;
  invested?: number;
  shares?: number;
  costPerShare?: number;
  stake?: number;
  proceeds?: number;
  fairValue?: number;
  rate?: number;
  /** The same amounts as the fund states them in its own currency. */
  commitmentBase?: number;
  investedBase?: number;
  proceedsBase?: number;
  fairValueBase?: number;
}

/**
 * An amount in the fund's own currency.
 *
 * The ledger states each transaction in the currency it was made in and again
 * in the fund's, at the rate of that tranche's own date. The second is what
 * every other sheet in the book is in, so it is what is filed — and where the
 * file gives no euro figure, the transaction was in the fund's currency
 * already and the one column is both.
 */
function amountIn(
  row: InvestmentRow, what: 'commitment' | 'invested' | 'proceeds' | 'fairValue',
  base: CurrencyCode,
): number | undefined {
  const stated = row[`${what}Base` as const] as number | undefined;
  if (stated !== undefined) return stated;
  return row.currency === base ? row[what] : undefined;
}

/* ------------------------------------------------------------------ *
 * The capital account statements
 *
 * The register says what every investor paid and when. This says what each of
 * them has — which is a different figure, and not one any split of the fund
 * arrives at.
 *
 * A fee waterfall is why. The management fee and most of the operating expenses
 * are borne by one share class here, so at this quarter end the Founder class
 * carries a negative account of 1.58 million and every LP carries more than
 * their pro-rata share. Allocating the fund by capital contributed gives each
 * of them somebody else's return, and gives the Founder a positive account they
 * do not have. The statement is the answer; there is no rule that reconstructs
 * it.
 *
 * The sheets are laid out sideways — investors across, line items down — and
 * the rows move between one statement and the next, so every figure is found by
 * its own label rather than by where it sat last quarter.
 * ------------------------------------------------------------------ */

interface StatementRow {
  investor: string;
  type: string;
  date: string;
  period: PeriodId;
  units?: number;
  commitment?: number;
  drawn?: number;
  distributed?: number;
  nav?: number;
}

function readAccounts(sheets: TableData[]): StatementRow[] {
  const rows: StatementRow[] = [];

  for (const sheet of sheets) {
    if (!CAPITAL_ACCOUNTS.test(sheet.sheetName.trim().toLowerCase())) continue;

    // The label column is wherever `Type of Investor` sits, and the investors
    // are named on the row above it.
    let labelAt = -1;
    let namesRow = -1;
    for (let i = 0; i < sheet.rows.length && namesRow < 0; i += 1) {
      const at = sheet.rows[i].findIndex((cell) => /^type of investor/i.test(text(cell)));
      if (at >= 0) {
        labelAt = at;
        namesRow = i - 1;
      }
    }
    if (namesRow < 0) continue;

    // `As at` labels the date, and the date sits either beside the label or on
    // the line under it. Both are written in these statements.
    let asAt: string | undefined;
    for (let i = 0; i < sheet.rows.length && !asAt; i += 1) {
      if (!/^as at/i.test(text(sheet.rows[i][labelAt]))) continue;
      asAt = toDate(sheet.rows[i][labelAt + 1] ?? null)
        ?? toDate(sheet.rows[i + 1]?.[labelAt] ?? null);
    }
    if (!asAt) continue;

    const line = (pattern: RegExp) => sheet.rows.find((row) => pattern.test(text(row[labelAt])));
    const units = line(/^number of shares/i);
    const commitment = line(/^commitment$/i);
    const drawn = line(/^drawdowns$/i);
    const distributed = line(/^distributions$/i);
    const nav = line(/^net asset value$/i);
    // A statement with no net asset value on it is a fragment of one.
    if (!nav) continue;

    const names = sheet.rows[namesRow];
    const types = sheet.rows[namesRow + 1];
    for (let column = labelAt + 1; column < names.length; column += 1) {
      const name = text(names[column]);
      if (!name) continue;
      // The totals sit to the right of the investors and are a check on them,
      // not another account.
      if (/^total\b/i.test(name)) break;
      rows.push({
        investor: name,
        type: text(types[column]),
        date: asAt,
        period: periodForDate(asAt),
        units: toNumber(units?.[column] ?? null),
        commitment: toNumber(commitment?.[column] ?? null),
        drawn: toNumber(drawn?.[column] ?? null),
        distributed: toNumber(distributed?.[column] ?? null),
        nav: toNumber(nav[column] ?? null),
      });
    }
  }
  return rows;
}

function readInvestments(sheets: TableData[]): InvestmentRow[] {
  const table = named(sheets, INVESTMENTS);
  if (!table) return [];
  const header = headerRow(table, INVESTMENT_HEADINGS);
  if (header < 0) return [];
  const at = columns(table.rows[header]);

  const rows: InvestmentRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const asset = at.text(row, 'Asset');
    const date = at.date(row, 'Date');
    if (!asset || !date) continue;

    rows.push({
      line: i + 1,
      date,
      period: periodForDate(date),
      asset,
      shortName: at.text(row, 'Short Name'),
      currency: (at.text(row, 'CCY').toUpperCase() || 'EUR') as CurrencyCode,
      instrument: at.text(row, 'Type'),
      commitment: at.number(row, 'Commitment'),
      invested: at.number(row, 'Invested'),
      shares: at.number(row, '# UT Shares'),
      costPerShare: at.number(row, 'Cost / Share'),
      stake: at.number(row, 'Cum FD Stake %'),
      proceeds: at.number(row, 'Proceeds'),
      fairValue: at.number(row, 'FV'),
      rate: at.number(row, 'FX'),
      // The same figures in the fund's own currency, which the ledger states
      // beside them at the rate of the tranche's own date. They are what the
      // valuation sheet, the trial balance and the capital accounts are all in,
      // so they are what the book is kept in — and the transaction currency
      // survives as the fact it is rather than as a label on a euro figure.
      commitmentBase: at.number(row, 'Commitment €'),
      investedBase: at.number(row, 'Invested €'),
      proceedsBase: at.number(row, 'Proceeds €'),
      fairValueBase: at.number(row, 'FV €'),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The portfolio summary
 *
 * The one sheet that is computed and read anyway, because what it computes is
 * not arithmetic over the other sheets: it is the valuation committee's
 * approved fair value per company, transcribed. Its total ties to the trial
 * balance and to the administrator's statement.
 * ------------------------------------------------------------------ */

interface PortfolioRow {
  company: string;
  country: string;
  ownership?: number;
  cost?: number;
  realised?: number;
  fairValue?: number;
}

function readPortfolio(sheets: TableData[]): PortfolioRow[] {
  const table = named(sheets, PORTFOLIO);
  if (!table) return [];

  // Its heading is spread over two rows — `Fair` above `Value` — so the columns
  // are found by the first row and read from the one below the second.
  const header = table.rows.findIndex(
    (row) => row.some((cell) => /^company$/i.test(text(cell))),
  );
  if (header < 0) return [];
  const index = (pattern: RegExp) =>
    table.rows[header].findIndex((cell) => pattern.test(text(cell)));

  const company = index(/^company$/i);
  const country = index(/^country$/i);
  const ownership = index(/^ownership$/i);
  const cost = index(/^investment$/i);
  const realised = index(/^realized|^realised/i);
  const fair = index(/^fair$/i);

  const rows: PortfolioRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const name = company < 0 ? '' : text(row[company]);
    if (!name || /^portfolio totals?$/i.test(name)) continue;
    rows.push({
      company: name,
      country: country < 0 ? '' : text(row[country]),
      ownership: ownership < 0 ? undefined : toNumber(row[ownership]),
      cost: cost < 0 ? undefined : toNumber(row[cost]),
      realised: realised < 0 ? undefined : toNumber(row[realised]),
      fairValue: fair < 0 ? undefined : toNumber(row[fair]),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The trial balance
 * ------------------------------------------------------------------ */

interface TrialBalanceColumn { index: number; date: string; period: PeriodId }

function trialBalanceDates(sheets: TableData[]): TrialBalanceColumn[] {
  const table = named(sheets, TRIAL_BALANCE);
  if (!table) return [];
  // The dates sit on their own row above the accounts, one per column.
  for (const row of table.rows.slice(0, 6)) {
    const dated = row
      .map((cell, index) => ({ index, date: toDate(cell) }))
      .filter((entry): entry is { index: number; date: string } => Boolean(entry.date));
    if (dated.length >= 2) {
      // A column repeated further right is the superseded copy kept for the
      // audit trail; the first run of dates is the live one.
      const live: TrialBalanceColumn[] = [];
      const seen = new Set<string>();
      for (const entry of dated) {
        if (seen.has(entry.date)) break;
        seen.add(entry.date);
        live.push({ ...entry, period: periodForDate(entry.date) });
      }
      return live;
    }
  }
  return [];
}

interface AccountRow {
  section: string;
  group: string;
  caption: string;
  account: string;
  description: string;
  values: Map<PeriodId, number>;
}

function readTrialBalance(sheets: TableData[]): AccountRow[] {
  const table = named(sheets, TRIAL_BALANCE);
  if (!table) return [];
  const dates = trialBalanceDates(sheets);
  if (dates.length === 0) return [];

  const rows: AccountRow[] = [];
  for (const row of table.rows) {
    const section = text(row[0]);
    if (!/^balance sheet$|^p&l$/i.test(section)) continue;
    const values = new Map<PeriodId, number>();
    for (const column of dates) {
      const value = toNumber(row[column.index]);
      if (value !== undefined) values.set(column.period, value);
    }
    if (values.size === 0) continue;
    rows.push({
      section: section.toLowerCase() === 'p&l' ? 'pl' : 'bs',
      group: text(row[1]),
      caption: text(row[2]),
      account: text(row[3]),
      description: text(row[4]),
      values,
    });
  }
  return rows;
}

/** Which balance-sheet captions make up the figures outside the portfolio. */
const OUTSIDE_PORTFOLIO: Array<[RegExp, 'cash' | 'otherAssets' | 'currentLiabilities' | 'accruedExpenses']> = [
  [/^cash/i, 'cash'],
  [/^receivab|^prepaid|^formation/i, 'otherAssets'],
  [/^accounts payable/i, 'currentLiabilities'],
  [/^accrued/i, 'accruedExpenses'],
];

/* ------------------------------------------------------------------ *
 * The summary
 * ------------------------------------------------------------------ */

export function summariseMaster(sheets: TableData[]): MasterSummary | undefined {
  if (!isMasterWorkbook(sheets)) return undefined;

  const register = readRegister(sheets);
  const investments = readInvestments(sheets);
  const periods = [...new Set([
    ...register.map((row) => row.period),
    ...investments.map((row) => row.period),
  ])].sort();

  const currency = register[0]?.currency ?? investments[0]?.currency ?? 'EUR';

  return {
    fund: fundName(sheets),
    currency,
    reportingDate: reportingDate(sheets),
    holdings: new Set(investments.map((row) => row.asset)).size,
    movements: register.length,
    investors: new Set(register.map((row) => row.investor)).size,
    balanceSheets: trialBalanceDates(sheets).length,
    first: periods[0],
    last: periods[periods.length - 1],
    instruments: new Set(
      investments.filter((row) => row.instrument).map((row) => `${row.asset}/${row.instrument}`),
    ).size,
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export function planMasterImport(sheets: TableData[], options: MasterOptions): ImportPlan {
  const summary = summariseMaster(sheets);
  if (!summary) {
    throw new Error(
      'This workbook has no investors’ register and investments ledger, so it is not an LP '
      + 'capital master.',
    );
  }

  const { vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const currency = summary.currency;
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();
  const book = slug(summary.fund, 16);

  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${book}-${(sequence += 1)}`;

  const register = readRegister(sheets);
  const investments = readInvestments(sheets);
  const portfolio = readPortfolio(sheets);
  const accounts = readTrialBalance(sheets);
  const asAt = summary.reportingDate ? periodForDate(summary.reportingDate) : undefined;

  /* --- the companies, and the share classes under them ------------- */

  const positions: Position[] = [];
  const positionOf = new Map<string, Position>();
  const assets: Asset[] = [];
  const assetOf = new Map<string, Asset>();
  const fxRates = new Map<string, FxRate>();

  const countryOf = new Map(portfolio.map((row) => [row.company, row.country]));
  const ownershipOf = new Map(portfolio.map((row) => [row.company, row.ownership]));

  for (const row of investments) {
    let position = positionOf.get(row.asset);
    if (!position) {
      position = {
        id: `pos-${book}-${slug(row.asset, 20)}`,
        vehicleId,
        // The fund holds the company itself, not an interest in a fund that
        // holds it.
        kind: 'direct-investment',
        name: row.asset,
        // The fund's currency, not the company's. The valuation sheet, the
        // trial balance and the capital accounts are all in euro, and the
        // ledger states a euro figure beside every transaction one. Tagging the
        // holding with the company's currency and then filing euro figures
        // against it translates them a second time: one holding here read
        // 3,073,944 where its own valuation letter says 2,634,359.
        currency,
        vintage: Number(row.date.slice(0, 4)),
        commitmentDate: row.date,
        commitment: 0,
        ownership: matchOwnership(row.asset, ownershipOf) ?? 1,
        assetClass: 'Venture Capital',
        region: 'Unclassified',
        status: 'Investing',
      };
      positions.push(position);
      positionOf.set(row.asset, position);
    }
    if (row.date < position.commitmentDate) position.commitmentDate = row.date;
    // The commitment is stated on every tranche of the same company rather than
    // added up across them, so the largest is the commitment and not the sum.
    const commitment = amountIn(row, 'commitment', currency);
    if (commitment && commitment > position.commitment) {
      position.commitment = commitment;
    }

    if (row.instrument) {
      const key = `${row.asset}/${row.instrument}`;
      if (!assetOf.has(key)) {
        const asset: Asset = {
          id: `ast-${book}-${slug(key, 28)}`,
          positionId: position.id,
          name: row.instrument,
          currency: row.currency,
          investmentDate: row.date,
          ownership: 1,
          assetClass: 'Venture Capital',
          sector: 'Unclassified',
          region: 'Unclassified',
          country: matchCountry(row.asset, countryOf) || 'Unclassified',
          status: 'Held',
          attributes: { company: row.asset, instrument: row.instrument },
        };
        assets.push(asset);
        assetOf.set(key, asset);
      }
      const asset = assetOf.get(key)!;
      if (row.date < asset.investmentDate) asset.investmentDate = row.date;
    }

    if (row.rate && row.currency !== currency) {
      fxRates.set(`${row.currency}/${row.date}`, {
        id: `fx-${row.currency}-${row.date}`,
        base: row.currency,
        quote: currency,
        rate: row.rate,
        date: row.date,
        period: row.period,
        recordedAt,
        kind: 'closing',
        source: `${summary.fund} — investments ledger`,
        authority: 'manual',
      });
    }
  }

  /* --- what was put into each company ------------------------------ */

  const cashflows: Cashflow[] = [];
  const metrics: Metric[] = [];

  const metric = (
    scope: Metric['scope'], period: PeriodId, name: string,
    figure: { value?: number; text?: string }, source: string, unit?: string,
  ) => {
    if (figure.value === undefined && !figure.text) return;
    periods.add(period);
    metrics.push({
      id: `met-${scope.id}-${period}-${name}`,
      scope, period, recordedAt, metric: name,
      value: figure.value, text: figure.text, unit, source,
    });
  };

  for (const row of investments) {
    const position = positionOf.get(row.asset)!;
    periods.add(row.period);

    const invested = amountIn(row, 'invested', currency);
    if (invested) {
      cashflows.push({
        id: id('cf'),
        vehicleId,
        positionId: position.id,
        type: 'Capital Call',
        amount: -invested,
        currency,
        date: row.date,
        period: row.period,
        recordedAt,
        affectsCommitment: true,
        description: row.instrument
          ? `Investment — ${row.instrument}`
          : 'Investment',
        status: 'Confirmed',
      });
    }
    const proceeds = amountIn(row, 'proceeds', currency);
    if (proceeds) {
      cashflows.push({
        id: id('cf'),
        vehicleId,
        positionId: position.id,
        type: 'Distribution',
        amount: proceeds,
        currency,
        date: row.date,
        period: row.period,
        recordedAt,
        affectsCommitment: false,
        description: 'Proceeds',
        status: 'Confirmed',
      });
    }

    // Shares and the stake are what the ledger records beside the money, and
    // are what a report page prints beside a valuation.
    const asset = row.instrument ? assetOf.get(`${row.asset}/${row.instrument}`) : undefined;
    if (asset) {
      metric({ kind: 'asset', id: asset.id }, row.period, 'holding.shares',
        { value: row.shares }, `${summary.fund} — investments ledger`);
      metric({ kind: 'asset', id: asset.id }, row.period, 'holding.costPerShare',
        { value: row.costPerShare }, `${summary.fund} — investments ledger`, row.currency);
    }
    metric({ kind: 'position', id: position.id }, row.period, 'holding.fullyDilutedStake',
      { value: row.stake }, `${summary.fund} — investments ledger`);
  }

  /* --- what each company is worth ---------------------------------- */

  const valuations: PositionValuation[] = [];
  const assetValuations: AssetValuation[] = [];

  if (asAt && portfolio.length > 0) {
    for (const row of portfolio) {
      const position = positions.find((held) => matches(held.name, row.company));
      if (!position) {
        problems.push(
          `The portfolio sheet values "${row.company}", which the investments ledger does not `
          + 'hold. It was left out rather than filed against a company invented for it.',
        );
        continue;
      }
      if (row.fairValue === undefined) continue;
      periods.add(asAt);
      valuations.push({
        id: id('val'),
        positionId: position.id,
        period: asAt,
        recordedAt,
        nav: row.fairValue,
        drawnCumulative: row.cost,
        distributedCumulative: row.realised,
        source: `${summary.fund} — valuation committee approval, as transcribed`,
      });

      // The approved value is per share class where a company has more than
      // one, and the portfolio sheet carries only the company total. So the
      // classes of a company held one way take it, and a company held several
      // ways is left for the approval letter to split rather than apportioned
      // here on a basis nobody chose.
      const classes = assets.filter((asset) => asset.positionId === position.id);
      if (classes.length === 1) {
        assetValuations.push({
          id: `${classes[0].id}-${asAt}`,
          assetId: classes[0].id,
          period: asAt,
          recordedAt,
          invested: row.cost ?? 0,
          realised: row.realised ?? 0,
          unrealised: row.fairValue,
          source: `${summary.fund} — valuation committee approval, as transcribed`,
        });
      } else if (classes.length > 1) {
        problems.push(
          `${position.name} is held in ${classes.length} share classes and the portfolio sheet `
          + 'states one value for the company. The split is in the valuation approval letter; '
          + 'until that is loaded the look-through leaves this company out rather than '
          + 'apportioning it.',
        );
      }
    }
  } else if (portfolio.length > 0) {
    problems.push(
      'The workbook does not say which date it was built for, so its valuations have no quarter '
      + 'to be filed against.',
    );
  }

  /* --- the accounts ------------------------------------------------ */

  const balanceSheets: VehicleBalanceSheet[] = [];
  const outside = new Map<PeriodId, VehicleBalanceSheet>();

  for (const row of accounts) {
    for (const [period, value] of row.values) {
      periods.add(period);
      const name = `${row.section}.${camel(row.account || row.description)}`;
      metric(
        { kind: 'vehicle', id: vehicleId }, period, name,
        { value },
        `${summary.fund} — trial balance, ${row.account || row.description}`,
        currency,
      );

      if (row.section !== 'bs') continue;
      const field = OUTSIDE_PORTFOLIO.find(([pattern]) => pattern.test(row.caption))?.[1];
      if (!field) continue;
      const held = outside.get(period) ?? {
        vehicleId, period, recordedAt,
        cash: 0, otherAssets: 0, currentLiabilities: 0, accruedExpenses: 0,
        source: `${summary.fund} — trial balance`,
      };
      // The trial balance signs a liability negative; this application holds
      // liabilities as positive amounts to be deducted, so the sign is turned
      // rather than the figure being subtracted twice further down.
      held[field] += field === 'cash' || field === 'otherAssets' ? value : -value;
      outside.set(period, held);
    }
  }
  balanceSheets.push(...outside.values());

  if (balanceSheets.length > 0) {
    notes.push(
      `Cash, receivables, payables and accruals for ${balanceSheets.length} quarter(s) come from `
      + 'the trial balance, which is what lets the net asset value tie to the accounts rather '
      + 'than to the portfolio.',
    );
  }

  /* --- the investors ----------------------------------------------- */

  const investors: Investor[] = [];
  const investorOf = new Map<string, Investor>();

  for (const row of register) {
    let investor = investorOf.get(row.investor);
    if (!investor) {
      investor = {
        id: `inv-${book}-${slug(row.investor, 28)}`,
        vehicleId,
        name: row.investor,
        type: 'Institution',
        country: 'Unclassified',
        currency: row.currency,
        commitment: 0,
        // Investor, founder or general partner. The fund quotes its own totals
        // sometimes for all three and sometimes for the first alone, so the
        // class travels with the investor rather than being chosen here.
        shareClass: row.klass,
        entryDate: row.date,
      };
      investors.push(investor);
      investorOf.set(row.investor, investor);
    }
    if (row.commitment) investor.commitment += row.commitment;
    if (row.date < investor.entryDate) investor.entryDate = row.date;
    periods.add(row.period);

    for (const entry of row.contributions) {
      const column = CONTRIBUTION_COLUMNS.find(([name]) => name === entry.column)!;
      cashflows.push({
        id: id('cf'),
        vehicleId,
        investorId: investor.id,
        type: column[1],
        // The register writes what an investor paid as a positive amount, which
        // is money into the fund, which is the direction this application signs
        // every flow from. So it is carried across as written — and a transfer
        // between two investors, written as one negative leg and one positive,
        // nets to nothing at fund level, which is what a transfer is.
        amount: entry.amount,
        currency: row.currency,
        date: row.date,
        period: row.period,
        recordedAt,
        affectsCommitment: column[2] && column[1] === 'Capital Call',
        description: row.description || column[3],
        sourceDetail: row.kind && row.kind !== row.description ? row.kind : undefined,
        status: 'Confirmed',
      });
    }
  }

  /* --- units ------------------------------------------------------- */

  const price = options.unitPrice ?? unitPriceIn(sheets, register);
  if (price && price > 0) {
    for (const investor of investors) {
      // Signed. A transfer out is a negative call, and the units go with the
      // money: taking each leg absolutely would issue units to both sides of a
      // transfer and leave the fund with more in issue than it ever created.
      const called = cashflows
        .filter((flow) => flow.investorId === investor.id && flow.type === 'Capital Call')
        .reduce((sum, flow) => sum + flow.amount, 0);
      if (called === 0 || !asAt) continue;
      metric(
        { kind: 'investor', id: investor.id }, asAt, 'units.held',
        { value: called / price },
        `${summary.fund} — contributions at ${price.toLocaleString('en-GB')} ${currency} a unit`,
      );
    }
    notes.push(
      `Units are contributions divided by ${price.toLocaleString('en-GB')} ${currency}, which is `
      + 'what one costs. The register is the authority for the money and the unit count follows '
      + 'it, rather than the two being kept separately and drifting.',
    );
  }

  /* --- what each investor has, as the statements say ---------------- */

  const statements = readAccounts(sheets);
  if (statements.length > 0) {
    // The statements name an investor and its class separately; the register
    // carries the class in the name where two accounts share one. Joining on
    // both is what keeps a founder's account out of the same holder's LP one.
    const byName = new Map<string, Investor>();
    for (const held of investors) {
      byName.set(held.name.toLowerCase(), held);
      const plain = held.name.replace(/\s*\[[^\]]*\]\s*$/, '').toLowerCase();
      const klass = /\[([^\]]*)\]\s*$/.exec(held.name)?.[1] ?? held.shareClass ?? '';
      byName.set(`${plain}|${klass.toLowerCase()}`, held);
    }

    const unmatched = new Set<string>();
    let filed = 0;
    for (const row of statements) {
      const plain = row.investor.replace(/\s*\[[^\]]*\]\s*$/, '').toLowerCase();
      const investor = byName.get(`${plain}|${row.type.toLowerCase()}`)
        ?? byName.get(row.investor.toLowerCase())
        ?? [...byName.values()].find((held) => held.name.toLowerCase().startsWith(plain.slice(0, 18)));
      if (!investor) {
        unmatched.add(row.investor);
        continue;
      }
      periods.add(row.period);
      const at = `${summary.fund} — capital account statement at ${row.date}`;
      if (row.units !== undefined) {
        metric({ kind: 'investor', id: investor.id }, row.period, 'units', { value: row.units }, at);
      }
      if (row.nav !== undefined) {
        metric({ kind: 'investor', id: investor.id }, row.period, 'capitalAccount',
          { value: row.nav }, at, currency);
        filed += 1;
      }
    }

    notes.push(
      `${filed} capital account(s) are read from the statements rather than allocated. The `
      + 'management fee and most of the operating expenses fall on one share class here, so an '
      + 'account worked out from capital contributed gives every investor somebody else\'s '
      + 'return — and gives the class that bears them a positive balance it does not have.',
    );
    if (unmatched.size > 0) {
      problems.push(
        `${unmatched.size} name(s) on the capital account statements match no investor in the `
        + `register: ${[...unmatched].join('; ')}.`,
      );
    }
  }

  /* --- what the workbook says about itself -------------------------- */

  const changeLog = named(sheets, README);
  const restated = (changeLog?.rows ?? [])
    .map((row) => text(row.find((cell) => text(cell).length > 40) ?? null))
    .filter((line) => /supersed|preliminary|re-baselin|restat|correction/i.test(line));
  if (restated.length > 0 && asAt) {
    metric(
      { kind: 'vehicle', id: vehicleId }, asAt, 'narrative.basis',
      { text: restated.slice(0, 3).join(' ') },
      `${summary.fund} — change log`,
    );
    notes.push(
      'The change log records what was restated and why, and it is kept: a quarter republished '
      + 'on a corrected basis has to be able to say so.',
    );
  }

  if (positions.length > 0) {
    notes.push(
      `A position here is a company and an asset is a share class of it — ${positions.length} `
      + `compan(ies) across ${assets.length} instrument(s). For a fund holding companies `
      + 'directly, by instrument is the only look-through there is.',
    );
  }

  return {
    program: summary.fund,
    vehicleId,
    positions,
    valuations,
    cashflows,
    investors,
    assets,
    assetValuations,
    balanceSheets,
    metrics,
    fxRates: [...fxRates.values()],
    problems,
    periods: [...periods].sort(),
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Matching a company between two sheets
 *
 * The ledger writes `GreyParrot.ai` and the portfolio sheet writes
 * `GreyParrot.ai`; it also writes `Another Tomorrow` against `Another Tomorrow
 * Inc.`. A suffix a company is registered under is not a different company, so
 * one name containing the other is a match — and nothing weaker is, because a
 * valuation filed against the wrong company is worse than one not filed.
 * ------------------------------------------------------------------ */

function normalise(value: string): string {
  return value.toLowerCase().replace(/\b(inc|ltd|limited|llp|ag|gmbh|sa|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function matches(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function matchCountry(company: string, from: Map<string, string>): string {
  for (const [name, country] of from) if (matches(company, name)) return country;
  return '';
}

function matchOwnership(company: string, from: Map<string, number | undefined>): number | undefined {
  for (const [name, share] of from) if (matches(company, name)) return share;
  return undefined;
}

export { makePeriod };

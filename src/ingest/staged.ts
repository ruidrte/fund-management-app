/**
 * Reading a staged reporting support file.
 *
 * The seventh shape, and the first that is built rather than kept. The other
 * six are each somebody's working file grown over time — a ledger, a register,
 * a database, a model — where source and result sit in the same cell and the
 * only way to tell them apart is to know who typed what. This one is arranged
 * the other way round, and says so on its first sheet: tabs numbered `0x` for
 * the parameters of the quarter, `1x` for what arrived from outside, `2x` for
 * what is computed from it, and `9x` for the reconciliations that have to pass
 * before any of it is published.
 *
 * That arrangement decides how it is read.
 *
 *   The `1x` tabs are the facts. Everything this reader files comes from them:
 *   the administrator's pack, the quarterly series by target fund and at fund
 *   level, the capital calls, the target funds' own reports, and the extract
 *   from the portfolio database that the first four are checked against.
 *
 *   The `2x` tabs are not read at all. They hold no input — every cell is a
 *   formula over the `1x` tabs — so reading them would file the same fact twice
 *   under two names, and a workbook written back out would then have to
 *   reproduce a computation rather than a record. They are what this
 *   application exists to compute; taking them as given would be circular.
 *
 *   The `9x` tabs are read as findings rather than as figures. A check that
 *   passes says nothing that the figures do not already say. A check that does
 *   not pass is the most valuable line in the file, because somebody has
 *   already done the work of knowing which two numbers disagree and why — so
 *   each one becomes a problem or a note, carried through with its own words.
 *
 * The file is also the first that states its own history: nine quarters by
 * target fund and six at fund level, which is six quarters of net asset value,
 * capital called and multiple that no other source for this product carries.
 */

import { periodEndDate, periodForDate, type PeriodId } from '../domain/period';
import type {
  Asset, AssetValuation, Cashflow, CurrencyCode, FxRate, Investor, Metric,
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

/** `Q1 2026` and `2026 Q1` are the same quarter, and both are written here. */
function toPeriod(value: string): PeriodId | undefined {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const quarterFirst = /^Q([1-4])\s*(\d{4})$/i.exec(trimmed);
  if (quarterFirst) return `${quarterFirst[2]}Q${quarterFirst[1]}`;
  const yearFirst = /^(\d{4})\s*Q([1-4])$/i.exec(trimmed);
  if (yearFirst) return `${yearFirst[1]}Q${yearFirst[2]}`;
  // `2025YE` is how an impact figure dates itself: the year, at its end.
  const yearEnd = /^(\d{4})\s*YE$/i.exec(trimmed);
  if (yearEnd) return `${yearEnd[1]}Q4`;
  return undefined;
}

function camel(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  return words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('') || 'unnamed';
}

/** The first cell on the row that says anything. */
function label(row: Cell[]): string {
  for (const cell of row) {
    const value = text(cell);
    if (value) return value;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * The tabs, and the blocks inside them
 * ------------------------------------------------------------------ */

const CONTROL = /^0\d[_ ].*control/;
const NAV_PACK = /^1\d[_ ].*nav.?pack/;
const TF_HISTORY = /^1\d[_ ].*tf.?_?hist/;
const FUND_HISTORY = /^1\d[_ ].*fund.?hist/;
const CASHFLOWS = /^1\d[_ ].*cashflow/;
const TARGET_FUNDS = /^1\d[_ ].*target.?fund/;
const PFDB_EXTRACT = /^1\d[_ ].*pfdb/;
const CHECKS = /^9\d[_ ].*check/;
const RECON = /^9\d[_ ].*recon/;

function tab(sheets: TableData[], pattern: RegExp): TableData | undefined {
  return sheets.find((sheet) => pattern.test(sheet.sheetName.trim().toLowerCase()));
}

/**
 * The product's name, from whichever masthead states it.
 *
 * Every tab here opens with two lines: what the tab is, and what it is for. The
 * one that names the product is the one carrying a legal form, and it names the
 * manager and the administrator after it, separated by a bullet — so the name
 * is the first segment of the first such line, and a heading that merely
 * describes a process is passed over rather than mistaken for it.
 */
const LEGAL_FORM = /\b(fund|sicav|sicaf|scs|sca|s\.?c\.?a|s\.?a\.?r\.?l|l\.?p|partnership|trust|kg)\b/i;
const A_PROCESS = /process|support file|paste|template|parameters|input\b|output\b/i;

function fundName(sheets: TableData[]): string {
  for (const sheet of sheets) {
    for (const row of sheet.rows.slice(0, 5)) {
      const line = label(row);
      if (line.length < 12 || !LEGAL_FORM.test(line) || A_PROCESS.test(line)) continue;
      return line.split(/\s*[·|•]\s*/)[0].trim();
    }
  }
  return 'This product';
}

/**
 * A lettered block within a tab: `C. SNA — Statement of Net Assets (EUR)`.
 *
 * The letter is what the file's own report map addresses ranges by, so it is
 * what this reader finds them by too. Matching the words instead would break on
 * the first quarter somebody rewords a heading.
 */
interface Block { letter: string; title: string; start: number; end: number }

function blocks(table: TableData): Block[] {
  const found: Block[] = [];
  table.rows.forEach((row, index) => {
    const heading = /^([A-Z])\.\s+(.*)$/.exec(label(row));
    if (heading) found.push({ letter: heading[1], title: heading[2], start: index, end: table.rows.length });
  });
  found.forEach((block, i) => {
    if (i + 1 < found.length) block.end = found[i + 1].start;
  });
  return found;
}

function block(table: TableData | undefined, letter: string): Block | undefined {
  return table ? blocks(table).find((b) => b.letter === letter) : undefined;
}

/**
 * The label/value pairs a parameter tab is written as: a name in one column and
 * a figure in the next, with whatever note the author left beside it.
 */
interface Pair { name: string; cell: Cell; note: string; row: number }

function pairs(table: TableData, from = 0, to = Number.MAX_SAFE_INTEGER): Pair[] {
  const found: Pair[] = [];
  for (let i = from; i < Math.min(table.rows.length, to); i += 1) {
    const row = table.rows[i];
    // The name is the first cell that says anything; the value is the next one
    // after it, whether or not that column is the same on every row.
    const at = row.findIndex((cell) => text(cell) !== '');
    if (at < 0) continue;
    const name = text(row[at]);
    // A lettered or numbered heading names a section, not a figure.
    if (/^[A-Z]\.\s/.test(name) || /^\d+\.\s/.test(name)) continue;
    found.push({ name, cell: row[at + 1] ?? null, note: text(row[at + 2]), row: i });
  }
  return found;
}

function find(list: Pair[], pattern: RegExp): Pair | undefined {
  return list.find((pair) => pattern.test(pair.name));
}

/** The row of column headings, found by two labels that must both be on it. */
function headerRow(table: TableData, ...required: RegExp[]): number {
  for (let i = 0; i < table.rows.length; i += 1) {
    const cells = table.rows[i].map((cell) => text(cell));
    if (required.every((pattern) => cells.some((cell) => pattern.test(cell)))) return i;
  }
  return -1;
}

function columnsOf(row: Cell[]): Map<string, number> {
  const index = new Map<string, number>();
  row.forEach((cell, i) => {
    const key = camel(text(cell));
    if (key !== 'unnamed' && !index.has(key)) index.set(key, i);
  });
  return index;
}

/* ------------------------------------------------------------------ *
 * Recognition
 * ------------------------------------------------------------------ */

/**
 * What makes this shape itself is the numbering, not any one sheet: a control
 * tab that states the quarter, and input tabs kept apart from everything
 * derived from them. Two input tabs is the floor — one could be a coincidence
 * of naming in a file that is really something else.
 */
export function isStagedSupport(sheets: TableData[]): boolean {
  const control = tab(sheets, CONTROL);
  if (!control) return false;
  const inputs = sheets.filter((sheet) => /^1\d[_ ].*\bin\b|^1\d[_ ]in_/i.test(sheet.sheetName.trim()));
  if (inputs.length < 2) return false;
  const stated = pairs(control);
  return Boolean(find(stated, /^quarter$/i) && find(stated, /^reporting date/i));
}

/* ------------------------------------------------------------------ *
 * The parameters of the quarter
 * ------------------------------------------------------------------ */

interface Control {
  fund: string;
  period?: PeriodId;
  reportingDate?: string;
  priorPeriod?: PeriodId;
  currency: CurrencyCode;
  rates: Array<{ base: CurrencyCode; quote: CurrencyCode; rate: number }>;
  /** Stated figures, kept under their own names for the consistency check. */
  stated: Map<string, number>;
  limitedPartners?: number;
  shareClass?: string;
  casAdjustment?: number;
  tolerance?: number;
}

/** `EUR/SEK` — one euro buys so many crowns, which is the way round the book stores it. */
const PAIR = /^([A-Z]{3})\s*\/\s*([A-Z]{3})$/;

function readControl(sheets: TableData[]): Control | undefined {
  const table = tab(sheets, CONTROL);
  if (!table) return undefined;
  const stated = pairs(table);

  const quarter = toPeriod(text(find(stated, /^quarter$/i)?.cell ?? ''));
  const reportingDate = toDate(find(stated, /^reporting date/i)?.cell ?? null);
  const prior = toPeriod(text(find(stated, /^prior quarter/i)?.cell ?? ''));

  const rates: Control['rates'] = [];
  for (const pair of stated) {
    const codes = PAIR.exec(pair.name.toUpperCase());
    const rate = toNumber(pair.cell);
    if (codes && rate !== undefined && rate > 0) {
      rates.push({ base: codes[1], quote: codes[2], rate });
    }
  }

  const figures = new Map<string, number>();
  for (const pair of stated) {
    if (PAIR.test(pair.name.toUpperCase())) continue;
    const value = toNumber(pair.cell);
    if (value !== undefined) figures.set(camel(pair.name), value);
  }

  // `NAV Class C (LP)` names the class the reporting basis is: everything on
  // the LP side of this file is that class and not the fund as a whole.
  const classLine = stated.find((pair) => /^nav\s+class\s+\w/i.test(pair.name));
  const shareClass = classLine ? /class\s+(\w+)/i.exec(classLine.name)?.[1] : undefined;

  return {
    fund: fundName(sheets),
    period: quarter ?? (reportingDate ? periodForDate(reportingDate) : undefined),
    reportingDate,
    priorPeriod: prior,
    currency: (text(find(stated, /^fund currency/i)?.cell ?? '') || 'EUR').toUpperCase(),
    rates,
    stated: figures,
    limitedPartners: figures.get('numberOfLimitedPartners'),
    shareClass,
    casAdjustment: figures.get(
      [...figures.keys()].find((key) => key.startsWith('cumulativeCas')) ?? 'never',
    ),
    tolerance: figures.get('checkTolerance') ?? figures.get('checkToleranceEur'),
  };
}

/* ------------------------------------------------------------------ *
 * The administrator's pack
 * ------------------------------------------------------------------ */

/** One holding as the pack's portfolio overview states it, in its own currency. */
interface PackHolding {
  name: string;
  currency: CurrencyCode;
  commitment?: number;
  totalInvested?: number;
  investmentCost?: number;
  costBase?: number;
  fxGain?: number;
  valuationGain?: number;
  valuation?: number;
  valuationBase?: number;
  remaining?: number;
}

function readPackHoldings(table: TableData | undefined): PackHolding[] {
  const overview = block(table, 'E');
  if (!table || !overview) return [];
  const header = overview.start + 1;
  const columns = columnsOf(table.rows[header] ?? []);
  const at = (name: string) => columns.get(name) ?? -1;
  const value = (row: Cell[], name: string) => {
    const index = at(name);
    return index < 0 ? undefined : toNumber(row[index]);
  };

  const holdings: PackHolding[] = [];
  for (let i = header + 1; i < overview.end; i += 1) {
    const row = table.rows[i];
    const name = label(row);
    // The grand total repeats the columns and is checked against, not read.
    if (!name || /grand total/i.test(name)) continue;
    const currency = text(row[at('ccy')]).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    holdings.push({
      name,
      currency,
      commitment: value(row, 'commitmentCcy'),
      totalInvested: value(row, 'totalInvestedCcy'),
      investmentCost: value(row, 'investmentCostCcy'),
      costBase: value(row, 'investmentCostEur'),
      // Stated the way the books state them, which is credit-positive: a gain
      // carries a minus sign because it is a credit. The identity the pack's
      // own columns satisfy is valuation = cost − fx − valuation, so the sign
      // is turned here, once, and everything downstream reads a gain as
      // positive. Filing them as they arrive would report this quarter's
      // best-performing holding as its worst.
      fxGain: negate(value(row, 'fxGainsLossesEur')),
      valuationGain: negate(value(row, 'valuationGainsLossesEur')),
      valuation: value(row, 'valuationCcy'),
      valuationBase: value(row, 'valuationEur'),
      remaining: value(row, 'remainingCommitmentCcy'),
    });
  }
  return holdings;
}

function negate(value: number | undefined): number | undefined {
  return value === undefined ? undefined : -value;
}

/** Every account of the trial balance, as four figures that must reconcile. */
interface Account { code: string; name: string; opening: number; debit: number; credit: number; ending: number }

function readTrialBalance(table: TableData | undefined): Account[] {
  const found = block(table, 'F');
  if (!table || !found) return [];
  const header = found.start + 1;
  const accounts: Account[] = [];
  for (let i = header + 1; i < found.end; i += 1) {
    const row = table.rows[i];
    const name = label(row);
    if (!name || /^total\b/i.test(name)) continue;
    const at = row.findIndex((cell) => text(cell) === name);
    const numbers = [0, 1, 2, 3].map((offset) => toNumber(row[at + 1 + offset]) ?? 0);
    const code = /^(\w+)\s*-\s*(.*)$/.exec(name);
    accounts.push({
      code: code ? code[1] : slug(name, 20),
      name: code ? code[2] : name,
      opening: numbers[0],
      debit: numbers[1],
      credit: numbers[2],
      ending: numbers[3],
    });
  }
  return accounts;
}

/* ------------------------------------------------------------------ *
 * The quarterly series by target fund
 * ------------------------------------------------------------------ */

interface HistoryRow {
  period: PeriodId;
  fund: string;
  currency: CurrencyCode;
  rate?: number;
  values: Map<string, number>;
}

function readTargetHistory(table: TableData | undefined): HistoryRow[] {
  if (!table) return [];
  const header = headerRow(table, /^quarter$/i, /^target fund$/i);
  if (header < 0) return [];
  const columns = columnsOf(table.rows[header]);
  const quarterAt = columns.get('quarter') ?? 0;
  const fundAt = columns.get('targetFund') ?? 1;
  const currencyAt = columns.get('ccy') ?? 2;

  const rows: HistoryRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const period = toPeriod(text(row[quarterAt]));
    const fund = text(row[fundAt]);
    if (!period || !fund) continue;
    const values = new Map<string, number>();
    for (const [name, index] of columns) {
      if (index === quarterAt || index === fundAt || index === currencyAt) continue;
      const value = toNumber(row[index]);
      if (value !== undefined) values.set(name, value);
    }
    rows.push({
      period,
      fund,
      currency: text(row[currencyAt]).toUpperCase(),
      // The rate column is named for the pair it holds, so it is found by shape.
      rate: [...columns.entries()]
        .filter(([name]) => /^fxEur/i.test(name))
        .map(([, index]) => toNumber(row[index]))
        .find((value) => value !== undefined && value > 0),
      values,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The quarterly series at fund level
 * ------------------------------------------------------------------ */

interface FundRow { period: PeriodId; values: Map<string, number> }

function readFundHistory(table: TableData | undefined): FundRow[] {
  if (!table) return [];
  const header = headerRow(table, /^quarter$/i, /^lp commitment$/i);
  if (header < 0) return [];
  const columns = columnsOf(table.rows[header]);
  const quarterAt = columns.get('quarter') ?? 0;

  const rows: FundRow[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const period = toPeriod(text(table.rows[i][quarterAt]));
    if (!period) continue;
    const values = new Map<string, number>();
    for (const [name, index] of columns) {
      if (index === quarterAt) continue;
      const value = toNumber(table.rows[i][index]);
      if (value !== undefined) values.set(name, value);
    }
    rows.push({ period, values });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The register of calls and distributions
 * ------------------------------------------------------------------ */

interface Movement { date: string; description: string; called?: number; distributed?: number; commitment?: number; note: string }

function readMovements(table: TableData | undefined): Movement[] {
  if (!table) return [];
  const header = headerRow(table, /^date$/i, /^called$/i);
  if (header < 0) return [];
  const columns = columnsOf(table.rows[header]);
  const at = (name: string) => columns.get(name) ?? -1;

  const rows: Movement[] = [];
  for (let i = header + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const date = toDate(row[at('date')] ?? null);
    const description = text(row[at('transaction')]);
    // The totals line has no date and is a check on the rows above it.
    if (!date || !description) continue;
    rows.push({
      date,
      description,
      called: toNumber(row[at('called')]),
      distributed: toNumber(row[at('distributed')]),
      commitment: toNumber(row[at('commitment')]),
      note: text(row[at('notes')]),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The target funds' own reports
 * ------------------------------------------------------------------ */

interface Company {
  fund: string;
  name: string;
  country: string;
  sector: string;
  detail: string;
  stake?: number;
  entryYear?: number;
  invested?: number;
  realised?: number;
  unrealised?: number;
  otherName: string;
}

/**
 * A portfolio company table, in the millions its heading says it is in.
 *
 * Everything else in this file is in currency units — that was one of the
 * things its author set out to fix — but these two blocks are headed `(SEK m)`
 * and `(USD m)` because that is how the target funds report. So the scale is
 * taken from the heading rather than assumed, and the figures are filed in
 * units like every other figure in the book.
 */
function scaleOf(title: string): number {
  if (/\bbn\b|\bbillion/i.test(title)) return 1_000_000_000;
  if (/\bm\b|\bmillion/i.test(title)) return 1_000_000;
  if (/\bk\b|\bthousand|'000/i.test(title)) return 1_000;
  return 1;
}

function readCompanies(table: TableData | undefined, letters: string[]): Company[] {
  if (!table) return [];
  const found: Company[] = [];
  for (const letter of letters) {
    const area = block(table, letter);
    if (!area) continue;
    const scale = scaleOf(area.title);
    const header = area.start + 1;
    const columns = columnsOf(table.rows[header] ?? []);
    // `Company` in one block and `Property` in the other: the same table.
    const nameAt = columns.get('company') ?? columns.get('property') ?? -1;
    if (nameAt < 0) continue;
    const at = (...names: string[]) => {
      for (const name of names) {
        const index = columns.get(name);
        if (index !== undefined) return index;
      }
      return -1;
    };
    const fund = /—\s*(.*?)\s*\(/.exec(area.title)?.[1] ?? area.title;
    for (let i = header + 1; i < area.end; i += 1) {
      const row = table.rows[i];
      const name = text(row[nameAt]);
      if (!name || /^total|^note/i.test(name)) continue;
      const scaled = (index: number) => {
        const value = index < 0 ? undefined : toNumber(row[index]);
        return value === undefined ? undefined : value * scale;
      };
      found.push({
        fund,
        name,
        country: text(row[at('country')]),
        sector: text(row[at('sector')]),
        // A sub-sector in one block and a US state in the other. Both are
        // standing facts the model has no column for, so both are kept as
        // stated rather than forced into one meaning.
        detail: text(row[at('subSector', 'state')]),
        stake: at('fmStake') < 0 ? undefined : toNumber(row[at('fmStake')]),
        entryYear: at('entryYear', 'investmentYear') < 0
          ? undefined
          : toNumber(row[at('entryYear', 'investmentYear')]),
        invested: scaled(at('invest')),
        realised: scaled(at('distribRealization')),
        unrealised: scaled(at('currentValue')),
        otherName: text(row[at('pfdbName')]),
      });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The checks the file runs on itself
 * ------------------------------------------------------------------ */

interface Finding { sheet: string; label: string; status: string; comment: string; difference?: number }

/**
 * A row of a reconciliation tab.
 *
 * Only the ones that did not pass are worth carrying: a check that reads OK
 * says nothing the figures beside it do not already say. One that reads DIFF or
 * KO is somebody's finished work on which two numbers disagree and why, and
 * that is not derivable from the figures at all.
 */
function readFindings(table: TableData | undefined): Finding[] {
  if (!table) return [];
  const found: Finding[] = [];
  for (let i = 0; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const cells = row.map((cell) => text(cell));
    const at = cells.findIndex((cell) => /^(OK|DIFF|KO|INFO|FAIL|PASS)$/i.test(cell));
    if (at < 0) continue;
    const status = cells[at].toUpperCase();
    if (status === 'OK' || status === 'PASS') continue;
    // The check's name is the first thing on the row that is not a number.
    const name = cells.slice(0, at).find((cell) => cell && toNumber(cell) === undefined
      && !/^\d+$/.test(cell)) ?? '';
    found.push({
      sheet: table.sheetName,
      label: name,
      status,
      comment: cells.slice(at + 1).find((cell) => cell.length > 3) ?? '',
      difference: toNumber(row[at - 1] ?? null),
    });
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * What the workbook is about
 * ------------------------------------------------------------------ */

export interface StagedSummary {
  fund: string;
  currency: CurrencyCode;
  reportingDate?: string;
  /** Quarters carried by the two history tabs together. */
  quarters: number;
  /** Target funds held. */
  holdings: number;
  /** Calls and distributions in the register. */
  movements: number;
  /** Look-through companies across the target funds. */
  companies: number;
  /** Checks the file itself reports as unresolved. */
  findings: number;
  first?: PeriodId;
  last?: PeriodId;
}

export interface StagedOptions {
  vehicleId: string;
  recordedAt?: string;
}

export function summariseStaged(sheets: TableData[]): StagedSummary | undefined {
  if (!isStagedSupport(sheets)) return undefined;
  const control = readControl(sheets);
  const history = readTargetHistory(tab(sheets, TF_HISTORY));
  const fundHistory = readFundHistory(tab(sheets, FUND_HISTORY));
  const periods = [...new Set([
    ...history.map((row) => row.period),
    ...fundHistory.map((row) => row.period),
    ...(control?.period ? [control.period] : []),
  ])].sort();

  return {
    fund: control?.fund ?? 'This product',
    currency: control?.currency ?? 'EUR',
    reportingDate: control?.reportingDate,
    quarters: periods.length,
    holdings: new Set(history.map((row) => row.fund)).size,
    movements: readMovements(tab(sheets, CASHFLOWS)).length,
    companies: readCompanies(tab(sheets, TARGET_FUNDS), ['D', 'E']).length,
    findings: readFindings(tab(sheets, CHECKS)).length + readFindings(tab(sheets, RECON)).length,
    first: periods[0],
    last: periods[periods.length - 1],
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/** Columns of the target fund history that are the position's own figures. */
const POSITION_METRICS: Array<[RegExp, string]> = [
  [/^commitmentCcy$/, 'commitment'],
  [/^investmentCostCcy$/, 'investmentCost'],
  [/^equalisationFeesCcy$/, 'equalisationAndFees'],
  [/^distributionsCcy$/, 'distributed'],
  [/^navCcy$/, 'netAssetValue'],
  [/^totalDrawnCcy$/, 'totalDrawn'],
  [/^openCommitmentCcy$/, 'openCommitment'],
  [/^moic$/, 'moic'],
];

export function planStagedImport(sheets: TableData[], options: StagedOptions): ImportPlan {
  const control = readControl(sheets);
  if (!control) {
    throw new Error(
      'This workbook has no control tab stating the quarter, so it is not a staged support file.',
    );
  }

  const { vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();
  const metrics: Metric[] = [];
  const fxRates: FxRate[] = [];
  const source = `${control.fund} — staged reporting support file`;

  const packTab = tab(sheets, NAV_PACK);
  const history = readTargetHistory(tab(sheets, TF_HISTORY));
  const fundHistory = readFundHistory(tab(sheets, FUND_HISTORY));
  const packHoldings = readPackHoldings(packTab);
  const companies = readCompanies(tab(sheets, TARGET_FUNDS), ['D', 'E']);
  const classification = readClassification(tab(sheets, TARGET_FUNDS));

  const current = control.period;
  if (current) periods.add(current);

  const metric = (
    scope: Metric['scope'], period: PeriodId, name: string,
    value: number | undefined, unit: string | undefined, note: string,
  ) => {
    if (value === undefined) return;
    periods.add(period);
    metrics.push({
      id: `met-${scope.kind}-${scope.id}-${period}-${slug(name, 48)}`,
      scope,
      period,
      recordedAt,
      metric: name,
      value,
      unit,
      source: note,
    });
  };

  const written = (scope: Metric['scope'], period: PeriodId, name: string, value: string, note: string) => {
    periods.add(period);
    metrics.push({
      id: `met-${scope.kind}-${scope.id}-${period}-${slug(name, 48)}`,
      scope,
      period,
      recordedAt,
      metric: name,
      text: value,
      source: note,
    });
  };

  const vehicle = { kind: 'vehicle' as const, id: vehicleId };

  /* --- the positions ------------------------------------------------ */

  // The pack names the holdings and the history carries them through time; the
  // pack's spelling wins, because it is the administrator's and the one the
  // reported net asset value is built on.
  const names = new Map<string, string>();
  for (const holding of packHoldings) names.set(keyOf(holding.name), holding.name);
  for (const row of history) if (!names.has(keyOf(row.fund))) names.set(keyOf(row.fund), row.fund);

  const positions: Position[] = [];
  const positionIds = new Map<string, string>();
  for (const [key, name] of names) {
    const pack = packHoldings.find((holding) => keyOf(holding.name) === key);
    const rows = history.filter((row) => keyOf(row.fund) === key).sort(byPeriod);
    // The history carries a row per quarter for every holding, including the
    // quarters before one was made — all zeroes. The first quarter that says
    // anything is the earliest date the holding can honestly be given.
    const first = rows.find((row) => [...row.values.values()].some((value) => value !== 0)) ?? rows[0];
    const attributes = classification.get(key);
    const currency = pack?.currency ?? first?.currency ?? control.currency;
    const id = `pos-${vehicleId}-${slug(name, 40)}`;
    positionIds.set(key, id);
    positions.push({
      id,
      vehicleId,
      kind: 'fund',
      name,
      currency,
      vintage: attributes?.vintage ?? (first ? Number(first.period.slice(0, 4)) : 0),
      // The file states no commitment date. The quarter the holding first
      // appears in is the earliest date it can be given without inventing one,
      // and it is stated as that rather than as a date somebody chose.
      commitmentDate: first ? periodEndDate(first.period) : (control.reportingDate ?? ''),
      commitment: pack?.commitment ?? first?.values.get('commitmentCcy') ?? 0,
      // The vehicle's share of the target fund, which the fact box states as an
      // implied interest. Absent leaves it unset rather than guessed at 1.
      ownership: attributes?.impliedInterest ?? 0,
      assetClass: attributes?.assetClass ?? 'Private Equity',
      region: attributes?.region ?? '',
      sector: attributes?.sector,
      status: 'Investing',
    } as Position);
  }

  /* --- valuations, quarter by quarter ------------------------------- */

  const valuations: PositionValuation[] = [];
  for (const row of history) {
    const positionId = positionIds.get(keyOf(row.fund));
    if (!positionId) continue;
    const nav = row.values.get('navCcy');
    const drawn = row.values.get('totalDrawnCcy');
    if (nav === undefined && drawn === undefined) continue;
    periods.add(row.period);
    valuations.push({
      id: `val-${positionId}-${row.period}`,
      positionId,
      period: row.period,
      recordedAt,
      nav: nav ?? 0,
      drawnCumulative: drawn,
      distributedCumulative: row.values.get('distributionsCcy'),
      source: `${source} — quarterly series by target fund`,
    });

    const scope = { kind: 'position' as const, id: positionId };
    for (const [pattern, name] of POSITION_METRICS) {
      const key = [...row.values.keys()].find((column) => pattern.test(column));
      if (key) metric(scope, row.period, name, row.values.get(key), row.currency, `${source} — history`);
    }

    if (row.rate) {
      fxRates.push({
        id: `fx-${control.currency}-${row.currency}-${row.period}`,
        base: control.currency,
        quote: row.currency,
        rate: row.rate,
        date: periodEndDate(row.period),
        period: row.period,
        recordedAt,
        kind: 'closing',
        // The rates are the administrator's own, carried across from the pack,
        // and the reported net asset value is translated at them. A market
        // fixing that disagrees must not displace them.
        authority: 'administrator',
        source: `${source} — quarterly series by target fund`,
      });
    }
  }

  /* --- the equalisation basis, which does not hold across the series - */

  // A quarter where total drawn moves further than investment cost is a quarter
  // where the equalisation moved, and equalisation moves for two very different
  // reasons: a new charge, or a change of basis. The file's own notes say this
  // series changes basis partway through — from what the portfolio database
  // nets to what the administrator books — so any movement taken from the drawn
  // column across that boundary is part restatement and part cash.
  //
  // Nothing here can tell the two apart, and neither can a reader. What it can
  // do is refuse to let the difference pass unremarked, because a deployment
  // figure built on it is overstated by exactly this much.
  for (const [key, name] of names) {
    const rows = history.filter((row) => keyOf(row.fund) === key).sort(byPeriod);
    for (let i = 1; i < rows.length; i += 1) {
      const before = rows[i - 1].values;
      const after = rows[i].values;
      const drawn = (after.get('totalDrawnCcy') ?? 0) - (before.get('totalDrawnCcy') ?? 0);
      const cost = (after.get('investmentCostCcy') ?? 0) - (before.get('investmentCostCcy') ?? 0);
      const moved = drawn - cost;
      if (Math.abs(moved) < 0.005) continue;
      notes.push(
        `${name}: between ${rows[i - 1].period} and ${rows[i].period} total drawn moves `
        + `${format(drawn)} ${rows[i].currency} while the capital actually drawn moves `
        + `${format(cost)}. The ${format(moved)} difference is the equalisation, which the file `
        + 'restates partway through this series rather than accruing. A quarter\'s deployment '
        + 'taken from total drawn instead of from investment cost is wrong by that much.',
      );
    }
  }

  /* --- the administrator's pack ------------------------------------- */

  const balanceSheets: VehicleBalanceSheet[] = [];
  const accounts = readTrialBalance(packTab);

  if (packTab && current) {
    const sna = block(packTab, 'C');
    if (sna) {
      const lines = pairs(packTab, sna.start + 1, sna.end);
      const of = (pattern: RegExp) => toNumber(find(lines, pattern)?.cell ?? null);
      for (const line of lines) {
        metric(vehicle, current, `sna.${camel(line.name)}`, toNumber(line.cell),
          control.currency, `${source} — statement of net assets`);
      }
      const bank = of(/^bank$/i) ?? 0;
      const receivables = of(/receivable/i) ?? 0;
      const formation = of(/formation expense/i) ?? 0;
      const liabilities = of(/^total liabilities/i) ?? 0;
      balanceSheets.push({
        vehicleId,
        period: current,
        recordedAt,
        cash: bank,
        // The deferred formation expense is an asset the pack carries above the
        // line, so it sits with the other assets rather than being netted away.
        otherAssets: receivables + formation,
        currentLiabilities: 0,
        // Stated negative, as a liability is in a balance sheet that adds down.
        accruedExpenses: Math.abs(liabilities),
        source: `${source} — statement of net assets`,
      });
    }

    const soo = block(packTab, 'D');
    if (soo) {
      // The same convention the quarterly reporting workbook uses, so that a
      // profit-and-loss line reads the same whichever product it came from.
      for (const line of pairs(packTab, soo.start + 1, soo.end)) {
        metric(vehicle, current, `pl.ytd.${camel(line.name)}`, toNumber(line.cell),
          control.currency, `${source} — statement of operations`);
      }
    }

    const cover = block(packTab, 'A');
    if (cover) {
      for (const line of pairs(packTab, cover.start + 1, cover.end)) {
        const value = toNumber(line.cell);
        if (value !== undefined) {
          metric(vehicle, current, `cover.${camel(line.name)}`, value, control.currency,
            `${source} — NAV pack cover`);
        }
      }
    }

    for (const account of accounts) {
      const scope = vehicle;
      const stem = `tb.${account.code}`;
      const note = `${source} — trial balance, ${account.name}`;
      metric(scope, current, `${stem}.ending`, account.ending, control.currency, note);
      if (account.opening !== 0) metric(scope, current, `${stem}.opening`, account.opening, control.currency, note);
      if (account.debit !== 0) metric(scope, current, `${stem}.debit`, account.debit, control.currency, note);
      if (account.credit !== 0) metric(scope, current, `${stem}.credit`, account.credit, control.currency, note);
    }

    const drift = accounts.filter((a) => Math.abs(a.opening + a.debit - a.credit - a.ending) > 0.005);
    if (drift.length > 0) {
      problems.push(
        `The trial balance does not add up on ${drift.length} account(s): `
        + `${drift.map((a) => a.code).join(', ')}. Opening plus debits less credits should be the `
        + 'closing balance, and the pack was pasted in rather than recomputed, so a paste that '
        + 'missed a column would look exactly like this.',
      );
    }
    const ending = accounts.reduce((sum, a) => sum + a.ending, 0);
    if (accounts.length > 0 && Math.abs(ending) > (control.tolerance ?? 1)) {
      problems.push(`The trial balance does not net to zero: ${format(ending)} ${control.currency}.`);
    }
  }

  /* --- the pack's own view of each holding -------------------------- */

  for (const holding of packHoldings) {
    const positionId = positionIds.get(keyOf(holding.name));
    if (!positionId || !current) continue;
    const scope = { kind: 'position' as const, id: positionId };
    const note = `${source} — NAV pack portfolio overview`;
    metric(scope, current, 'pack.investmentCost', holding.investmentCost, holding.currency, note);
    metric(scope, current, 'pack.totalInvested', holding.totalInvested, holding.currency, note);
    metric(scope, current, 'pack.valuation', holding.valuation, holding.currency, note);
    metric(scope, current, 'pack.remainingCommitment', holding.remaining, holding.currency, note);
    metric(scope, current, 'pack.investmentCostBase', holding.costBase, control.currency, note);
    metric(scope, current, 'pack.valuationBase', holding.valuationBase, control.currency, note);
    // Signs turned on the way in, so a gain is positive here and everywhere.
    metric(scope, current, 'pack.unrealisedGain', holding.valuationGain, control.currency, note);
    metric(scope, current, 'pack.fxGain', holding.fxGain, control.currency, note);
  }

  /* --- the series at fund level ------------------------------------- */

  for (const row of fundHistory) {
    for (const [column, value] of row.values) {
      metric(vehicle, row.period, `fund.${column}`, value, control.currency,
        `${source} — quarterly series at fund level`);
    }
    // The four balance-sheet columns are the fund's, and the net asset value
    // beside them is the LP share class's. They differ by the general
    // partner's capital, so a balance sheet built from the row is the fund's
    // and is filed as such; the class figure stays a figure of its own.
    const cash = row.values.get('cashEquivalents');
    const portfolio = row.values.get('portfolioValue');
    if (cash === undefined || portfolio === undefined) continue;
    if (row.period === current && balanceSheets.some((sheet) => sheet.period === row.period)) continue;
    balanceSheets.push({
      vehicleId,
      period: row.period,
      recordedAt,
      cash,
      otherAssets: row.values.get('formationExpense') ?? 0,
      currentLiabilities: 0,
      accruedExpenses: Math.abs(row.values.get('liabilities') ?? 0),
      source: `${source} — quarterly series at fund level`,
    });
  }

  /* --- the register --------------------------------------------------*/

  const movements = readMovements(tab(sheets, CASHFLOWS));
  const cashflows: Cashflow[] = [];
  const investors: Investor[] = [];

  // The file states how many limited partners there are and what class they
  // hold, and states every call on them — but never a name. One partner can
  // therefore be filed as one investor without apportioning anything; two could
  // not, because splitting a call between unnamed partners would be invention.
  const partnerCount = control.limitedPartners;
  const commitment = control.stated.get('lpCommitmentReportingBasis')
    ?? control.stated.get('lpCommitment')
    ?? movements.find((m) => /commitment/i.test(m.description))?.commitment
    ?? 0;

  let investorId: string | undefined;
  if (partnerCount === 1 && movements.length > 0) {
    const name = control.shareClass
      ? `Class ${control.shareClass} limited partner`
      : 'Limited partner';
    investorId = `inv-${vehicleId}-${slug(name, 40)}`;
    investors.push({
      id: investorId,
      vehicleId,
      name,
      type: 'Institution',
      currency: control.currency,
      commitment,
      shareClass: control.shareClass,
      entryDate: movements[0].date,
    });
    notes.push(
      `The register is on a limited-partner basis and states one partner holding `
      + `${format(commitment)} ${control.currency}, but does not name them. The calls are filed `
      + `against a single investor called "${name}" so that the net tier has something to stand `
      + 'on; when a register that names the partner arrives, it replaces this one rather than '
      + 'adding to it.',
    );
  } else if (movements.length > 0) {
    problems.push(
      `The register states ${partnerCount ?? 'an unstated number of'} limited partners and names `
      + 'none of them, so the calls cannot be attributed. They are filed at product level, which '
      + 'leaves the per-partner view empty until a named register arrives.',
    );
  }

  for (const movement of movements) {
    const period = periodForDate(movement.date);
    periods.add(period);
    const called = movement.called ?? 0;
    const distributed = movement.distributed ?? 0;
    const base = {
      vehicleId,
      investorId,
      currency: control.currency,
      date: movement.date,
      period,
      recordedAt,
      status: 'Confirmed' as const,
      description: movement.description,
      sourceDetail: movement.note || undefined,
      source: `${source} — register`,
    };
    if (called !== 0) {
      cashflows.push({
        ...base,
        id: `cf-${vehicleId}-${slug(movement.description, 24)}-${movement.date}-call`,
        type: 'Capital Call',
        // Signed from the vehicle's side, as every flow in this book is: a call
        // on an investor is money into the product, and positive.
        amount: called,
        affectsCommitment: true,
      } as Cashflow);
    }
    if (distributed !== 0) {
      cashflows.push({
        ...base,
        id: `cf-${vehicleId}-${slug(movement.description, 24)}-${movement.date}-dist`,
        type: 'Distribution',
        amount: -distributed,
        affectsCommitment: false,
      } as Cashflow);
    }
    if (called === 0 && distributed === 0 && movement.commitment) {
      cashflows.push({
        ...base,
        id: `cf-${vehicleId}-${slug(movement.description, 24)}-${movement.date}-commit`,
        type: 'Commitment',
        amount: movement.commitment,
        affectsCommitment: true,
      } as Cashflow);
    }
  }

  /* --- what the vehicle paid its target funds ----------------------- */

  const pfdbTab = tab(sheets, PFDB_EXTRACT);
  const transactions = block(pfdbTab, 'B');
  if (pfdbTab && transactions) {
    const header = transactions.start + 1;
    const columns = columnsOf(pfdbTab.rows[header] ?? []);
    const at = (name: string) => columns.get(name) ?? -1;
    for (let i = header + 1; i < transactions.end; i += 1) {
      const row = pfdbTab.rows[i];
      const date = toDate(row[at('date')] ?? null);
      const fund = text(row[at('targetFund')]);
      const call = toNumber(row[at('capitalCallCcy')]);
      if (!date || !fund || !call) continue;
      const positionId = holdingFor(fund, positionIds);
      if (!positionId) {
        problems.push(`A payment of ${format(call)} on ${date} names "${fund}", which is not one of the holdings.`);
        continue;
      }
      const period = periodForDate(date);
      periods.add(period);
      const currency = text(row[at('ccy')]).toUpperCase() || control.currency;
      cashflows.push({
        id: `cf-${positionId}-${date}-${slug(text(row[at('description')]) || 'call', 16)}`,
        vehicleId,
        positionId,
        type: 'Capital Call',
        // Out of the vehicle and into the target fund, so negative.
        amount: -call,
        currency,
        date,
        period,
        recordedAt,
        status: 'Confirmed',
        affectsCommitment: true,
        description: text(row[at('description')]) || 'Capital call',
        sourceDetail: `Paid ${format(toNumber(row[at('cashPaidEur')]) ?? 0)} ${control.currency} `
          + `at ${toNumber(row[at('fxAtTradeDate')]) ?? '—'}`,
        source: `${source} — portfolio database extract`,
      } as Cashflow);

      const rate = toNumber(row[at('fxAtTradeDate')]);
      if (rate && currency !== control.currency) {
        fxRates.push({
          id: `fx-${control.currency}-${currency}-${date}-trade`,
          base: control.currency,
          quote: currency,
          rate,
          date,
          period,
          recordedAt,
          kind: 'closing',
          // The rate the payment actually settled at. It is not a quarter-end
          // fixing and must not displace one, so it is filed as what it is: a
          // dated rate somebody transacted on.
          authority: 'manual',
          source: `${source} — portfolio database extract, trade date`,
        });
      }
    }
  }

  /* --- the look-through --------------------------------------------- */

  const assets: Asset[] = [];
  const assetValuations: AssetValuation[] = [];
  for (const company of companies) {
    const positionId = holdingFor(company.fund, positionIds);
    if (!positionId) {
      problems.push(`"${company.name}" is listed under "${company.fund}", which is not one of the holdings.`);
      continue;
    }
    const position = positions.find((p) => p.id === positionId);
    const id = `ast-${positionId}-${slug(company.name, 40)}`;
    const attributes: Record<string, string | number> = {};
    if (company.detail) attributes.detail = company.detail;
    if (company.otherName && company.otherName !== company.name) attributes.databaseName = company.otherName;
    assets.push({
      id,
      positionId,
      name: company.name,
      currency: position?.currency ?? control.currency,
      investmentDate: company.entryYear ? `${company.entryYear}-01-01` : '',
      ownership: company.stake ?? 0,
      assetClass: position?.assetClass ?? '',
      sector: company.sector,
      region: position?.region ?? '',
      country: company.country,
      status: (company.realised ?? 0) > 0 ? 'Partially Realised' : 'Held',
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    } as Asset);

    if (current) {
      assetValuations.push({
        id: `av-${id}-${current}`,
        assetId: id,
        period: current,
        recordedAt,
        invested: company.invested ?? 0,
        realised: company.realised ?? 0,
        unrealised: company.unrealised ?? 0,
        source: `${source} — target fund report`,
      });
    }
  }

  /* --- the fact boxes, the impact figures and the narratives --------- */

  const targetTab = tab(sheets, TARGET_FUNDS);
  if (targetTab && current) {
    for (const area of blocks(targetTab)) {
      const factBox = /^FACT BOX\s*—\s*(.*?)\s*\(/i.exec(area.title);
      const impact = /^IMPACT KPIs\s*—\s*(.*?)\s*\(/i.exec(area.title);
      const which = factBox?.[1] ?? impact?.[1];
      if (!which) continue;
      const positionId = holdingFor(which, positionIds);
      if (!positionId) continue;
      const scope = { kind: 'position' as const, id: positionId };

      if (factBox) {
        for (const line of pairs(targetTab, area.start + 1, area.end)) {
          const value = toNumber(line.cell);
          const name = `fund.${camel(line.name)}`;
          if (value !== undefined) metric(scope, current, name, value, undefined, `${source} — fact box`);
          else if (text(line.cell)) written(scope, current, name, text(line.cell), `${source} — fact box`);
        }
      }

      if (impact) {
        const header = area.start + 1;
        const columns = columnsOf(targetTab.rows[header] ?? []);
        const at = (...candidates: string[]) => {
          for (const name of candidates) {
            const index = columns.get(name);
            if (index !== undefined) return index;
          }
          return -1;
        };
        for (let i = header + 1; i < area.end; i += 1) {
          const row = targetTab.rows[i];
          const name = text(row[at('portfolioKpi')]);
          if (!name || /^\*/.test(name)) continue;
          // Impact figures date themselves — a KPI measured at the year end is
          // not a fact about this quarter — so the row's own period is used.
          const period = toPeriod(text(row[at('period')])) ?? current;
          const value = toNumber(row[at('value')]);
          const unit = text(row[at('unit')]);
          const note = `${source} — impact, ${text(row[at('contributors')]) || 'portfolio'}`;
          if (value !== undefined) metric(scope, period, `impact.${camel(name)}`, value, unit || undefined, note);
          else if (text(row[at('value')])) {
            written(scope, period, `impact.${camel(name)}`, text(row[at('value')]), note);
          }
        }
      }
    }

    const narratives = blocks(targetTab).find((area) => /^NARRATIVES/i.test(area.title));
    if (narratives) {
      const missing: string[] = [];
      for (const line of pairs(targetTab, narratives.start + 1, narratives.end)) {
        const body = text(line.cell);
        if (/^current quarter text/i.test(line.name)) continue;
        if (body) written(vehicle, current, `narrative.${camel(line.name)}`, body, `${source} — narrative`);
        else missing.push(line.name);
      }
      if (missing.length > 0) {
        problems.push(
          `${missing.length} of the report's narratives are not written: ${missing.join('; ')}. `
          + 'Every figure the report needs is here; these are the sentences beside them.',
        );
      }
    }
  }

  /* --- the portfolio database, as a cross-check --------------------- */

  const pfdbCompanies = block(pfdbTab, 'C');
  if (pfdbTab && pfdbCompanies && current) {
    const header = pfdbCompanies.start + 1;
    const columns = columnsOf(pfdbTab.rows[header] ?? []);
    const nameAt = columns.get('companyPfdbName') ?? columns.get('company') ?? -1;
    const stakeAt = columns.get('fmStakePfdb') ?? columns.get('fmStake') ?? -1;
    if (nameAt >= 0 && stakeAt >= 0) {
      for (let i = header + 1; i < pfdbCompanies.end; i += 1) {
        const row = pfdbTab.rows[i];
        const name = text(row[nameAt]);
        const stake = toNumber(row[stakeAt]);
        if (!name || stake === undefined || /^total/i.test(name)) continue;
        const asset = assets.find((a) => a.name === name
          || a.attributes?.databaseName === name);
        if (!asset) continue;
        // Filed beside the target fund's own figure rather than instead of it.
        // Where the two disagree the report is right and the database is stale,
        // which is a fix to the database and not to this quarter.
        metric({ kind: 'asset', id: asset.id }, current, 'database.ownership', stake, undefined,
          `${source} — portfolio database extract`);
      }
    }
  }

  /* --- the rates stated for the quarter ----------------------------- */

  for (const rate of control.rates) {
    if (!current) break;
    fxRates.push({
      id: `fx-${rate.base}-${rate.quote}-${current}`,
      base: rate.base,
      quote: rate.quote,
      rate: rate.rate,
      date: periodEndDate(current),
      period: current,
      recordedAt,
      kind: 'closing',
      authority: 'administrator',
      source: `${source} — control`,
    });
  }

  if (control.casAdjustment !== undefined && current) {
    metric(vehicle, current, 'capitalAccountDifference', control.casAdjustment, control.currency,
      `${source} — the standing difference between the capital account statement and the books`);
  }

  /* --- what the file says about itself ------------------------------ */

  for (const finding of [...readFindings(tab(sheets, CHECKS)), ...readFindings(tab(sheets, RECON))]) {
    const said = `${finding.sheet}: ${finding.label}`
      + (finding.difference !== undefined ? ` — difference ${format(finding.difference)}` : '')
      + (finding.comment ? `. ${finding.comment}` : '');
    if (finding.status === 'INFO') notes.push(said);
    else problems.push(`${said} [${finding.status}]`);
  }

  /* --- what changed against the last quarter published -------------- */

  // A basis that changed between one quarter and the next is the hardest thing
  // to see from the figures, because both quarters are internally consistent
  // and only the comparison between them is wrong. Somebody has written down
  // which ones changed and why, and that belongs beside the numbers rather than
  // in a tab nobody opens again.
  const checksTab = tab(sheets, CHECKS);
  const deliberate = checksTab?.rows.findIndex((row) => /known and deliberate/i.test(label(row))) ?? -1;
  if (checksTab && deliberate >= 0) {
    const columns = columnsOf(checksTab.rows[deliberate + 1] ?? []);
    const at = (...names: string[]) => {
      for (const name of names) {
        const index = columns.get(name);
        if (index !== undefined) return index;
      }
      return -1;
    };
    for (let i = deliberate + 2; i < checksTab.rows.length; i += 1) {
      const row = checksTab.rows[i];
      const topic = at('topic') < 0 ? '' : text(row[at('topic')]);
      if (!topic) continue;
      const was = at('publishedQ42025') < 0 ? label(row.slice(at('topic') + 1)) : text(row[at('publishedQ42025')]);
      const now = text(row[at('newBasis')] ?? null);
      const why = text(row[at('why')] ?? null);
      notes.push(
        `Changed against the last published quarter — ${topic}: ${was || 'previously'} is now `
        + `${now || 'on a new basis'}.${why ? ` ${why}` : ''}`,
      );
    }
  }

  /* --- what was deliberately not read ------------------------------- */

  const derived = sheets.filter((sheet) => /^2\d[_ ]/.test(sheet.sheetName.trim()));
  if (derived.length > 0) {
    notes.push(
      `${derived.length} computed tab(s) were not read: `
      + `${derived.map((sheet) => sheet.sheetName).join(', ')}. They hold no input — every cell `
      + 'is a formula over the input tabs — so reading them would file the same fact twice under '
      + 'two names. They are what this application computes, and taking them as given would make '
      + 'the check of them circular.',
    );
  }

  /* --- does the control tab agree with the history? ----------------- */

  if (current) {
    const row = fundHistory.find((entry) => entry.period === current);
    const tolerance = control.tolerance ?? 1;
    const comparisons: Array<[string, number | undefined, number | undefined]> = [
      ['capital called', control.stated.get('lpCapitalCalled'), row?.values.get('lpCapitalCalled')],
      ['net asset value', control.stated.get(`navClass${control.shareClass ?? ''}Lp`), row?.values.get('navClassC')],
      ['unfunded commitment', control.stated.get('unfundedCommitment'),
        row ? (row.values.get('lpCommitment') ?? 0) - (row.values.get('lpCapitalCalled') ?? 0) : undefined],
    ];
    for (const [what, a, b] of comparisons) {
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a - b) > tolerance) {
        problems.push(
          `The control tab and the fund history disagree on ${what}: ${format(a)} against `
          + `${format(b)}. One of the two was updated for this quarter and the other was not.`,
        );
      }
    }
  }

  if (balanceSheets.length > 1) {
    notes.push(
      'The balance sheets come from two statements of the same thing: the administrator\'s pack '
      + 'for its own quarter, which separates the bank balance from the receivables, and the '
      + 'fund-level history for the quarters before it, which states cash and equivalents as one '
      + 'figure including them. The totals agree; the cash line alone moves by the receivable '
      + 'between the two bases.',
    );
  }

  notes.push(
    'The input tabs are the record and the computed tabs are not read, so what is filed here is '
    + 'what arrived from the administrator, the target funds and the portfolio database — and '
    + 'nothing that was worked out from it.',
  );

  // The same quarter-end rate is stated three times over — in the control tab,
  // in the pack it was copied from, and again in every row of the target fund
  // history — and the copies do not always agree to the last digit, because one
  // of them came out of a division. They are one rate, so they are filed once,
  // and the statement of the rate wins over the row that used it.
  const rates = new Map<string, FxRate>();
  for (const rate of fxRates) rates.set(rate.id, rate);

  return {
    program: control.fund,
    vehicleId,
    positions,
    valuations,
    cashflows,
    investors,
    assets,
    assetValuations,
    balanceSheets,
    metrics,
    fxRates: [...rates.values()],
    problems,
    periods: [...periods].sort(),
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Odds and ends
 * ------------------------------------------------------------------ */

/**
 * A target fund is named three ways in one file — `Alder III (D) AB` by the
 * administrator, `Alder III AB` by the database, `Alder III` by the deck — so
 * the name is reduced to what all three agree on before it is matched.
 */
function keyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(ab|l\.?p\.?|llp|reit|sca|sicav|raif|inc|ltd|gmbh|s\.?a\.?r\.?l\.?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * The initials of a name, as an acronym is built from it.
 *
 * The administrator writes `RAHPF VI REIT, L.P.` and the portfolio database
 * writes `Rose Affordable Housing Preservation Fund VI`, which no comparison of
 * the two strings will ever bring together. They are the same holding, and the
 * acronym is not a guess about that — it is a transformation either name can be
 * put through, so the match either falls out or it does not.
 *
 * The generation has to survive it: `Alder II` and `Alder III` differ in
 * nothing else, and an acronym that dropped the numeral would merge them.
 */
const SKIP_WORD = /^(of|the|and|for|a|an|de|da|und|le|la)$/i;
const GENERATION = /^([ivxl]+|\d+)$/i;

function initialsOf(name: string): string {
  const words = name
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let initials = '';
  let generation = '';
  for (const word of words) {
    if (GENERATION.test(word)) { generation = word.toLowerCase(); continue; }
    if (SKIP_WORD.test(word)) continue;
    if (/^(ab|reit|inc|ltd|llp|gmbh|sca|sicav|raif|scs|lp)$/i.test(word)) continue;
    initials += word[0].toLowerCase();
  }
  return initials + generation;
}

/**
 * The holding a name refers to: the same name, its acronym, or a prefix long
 * enough to be one name rather than a family of them.
 */
function holdingFor(name: string, ids: Map<string, string>): string | undefined {
  const key = keyOf(name);
  const exact = ids.get(key);
  if (exact) return exact;

  const acronym = initialsOf(name);
  for (const [candidate, id] of ids) {
    // Both directions: either side of a file may be the one that abbreviates.
    if (acronym.length >= 3 && candidate === acronym) return id;
    if (candidate.length >= 3 && key === initialsOf(candidate)) return id;
  }
  for (const [candidate, id] of ids) {
    if (candidate.length >= 8 && key.startsWith(candidate.slice(0, 8))) return id;
    if (key.length >= 8 && candidate.startsWith(key.slice(0, 8))) return id;
  }
  return undefined;
}

function byPeriod(a: { period: PeriodId }, b: { period: PeriodId }): number {
  return a.period < b.period ? -1 : a.period > b.period ? 1 : 0;
}

function format(value: number): string {
  return value.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

/** The classification block: what each target fund is, as the file states it. */
interface Classification {
  assetClass?: string;
  sector?: string;
  region?: string;
  country?: string;
  vintage?: number;
  impliedInterest?: number;
}

function readClassification(table: TableData | undefined): Map<string, Classification> {
  const found = new Map<string, Classification>();
  if (!table) return found;
  const area = block(table, 'A');
  if (!area) return found;
  const header = area.start + 1;
  const columns = columnsOf(table.rows[header] ?? []);
  const at = (...names: string[]) => {
    for (const name of names) {
      const index = columns.get(name);
      if (index !== undefined) return index;
    }
    return -1;
  };
  const nameAt = at('targetFund');
  if (nameAt < 0) return found;

  for (let i = header + 1; i < area.end; i += 1) {
    const row = table.rows[i];
    const name = text(row[nameAt]);
    if (!name) continue;
    found.set(keyOf(name), {
      assetClass: text(row[at('assetClass')]) || undefined,
      sector: text(row[at('sector')]) || undefined,
      region: text(row[at('region')]) || undefined,
      country: text(row[at('countryDomicile', 'country')]) || undefined,
      vintage: toNumber(row[at('vintage')]),
    });
  }

  // The implied interest — the vehicle's share of the target fund — is stated
  // in the fact box rather than in the classification table, so it is picked up
  // from there and attached to the same holding.
  for (const box of blocks(table)) {
    const which = /^FACT BOX\s*—\s*(.*?)\s*\(/i.exec(box.title)?.[1];
    if (!which) continue;
    const stated = pairs(table, box.start + 1, box.end);
    const share = toNumber(find(stated, /implied interest/i)?.cell ?? null);
    if (share === undefined) continue;
    const key = [...found.keys()].find((candidate) => candidate.startsWith(keyOf(which).slice(0, 8)));
    if (key) found.set(key, { ...found.get(key)!, impliedInterest: share });
  }

  return found;
}

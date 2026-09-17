/**
 * Emitting an investment accounts workbook.
 *
 * The third writer, for the third shape a fund of funds arrives in. Same
 * discipline as the other two: the sheets the reader reads, written back from
 * the book, and a round trip that has to close.
 *
 * What is written is the input — the ledger of every movement with every
 * holding, the administrator's statements a column per quarter, and the
 * register feed the capital accounts are written from — and two things beside
 * it. The snapshot the desk publishes, because the book keeps what was
 * published as a check and a check that stays in the book cannot be run on the
 * file. And the two bases side by side, because a fund whose statements are on
 * capital drawn and whose report is on paid-in needs both on one page, and
 * that page is arithmetic this application does rather than a figure anybody
 * types.
 *
 * Two things do not survive exactly. A rate the ledger stated twice on one
 * date, a whisker apart, comes back on the same two rows in whichever order
 * they fall, since the book does not keep which movement carried which. And
 * the register feed has no event for a fee charged to an investor, so a book
 * holding one is told so rather than having it written under another name.
 */

import { periodEndDate, sortPeriods, type PeriodId } from '../domain/period';
import type {
  Cashflow, DataSet, FxRate, Investor, Metric, Position, PositionValuation,
  VehicleBalanceSheet,
} from '../domain/types';
import { returnBases } from '../engine/basis';
import { slug } from '../ingest/ids';
import type { TableData } from '../ingest/types';
import { twoBases } from './supportWorkbook';

export interface AccountsWorkbookOptions {
  dataset: DataSet;
  vehicleId: string;
  period: PeriodId;
  knowledgeDate?: string;
}

export interface AccountsWorkbook {
  sheets: TableData[];
  filename: string;
  problems: string[];
}

type Cell = string | number | null;

/* ------------------------------------------------------------------ */

function visible<T extends { recordedAt: string }>(rows: T[], knowledgeDate?: string): T[] {
  if (!knowledgeDate) return rows;
  const cutoff = Date.parse(knowledgeDate);
  return rows.filter((row) => Date.parse(row.recordedAt) <= cutoff);
}

function newest<T extends { recordedAt: string }>(rows: T[], key: (row: T) => string): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const at = key(row);
    const held = best.get(at);
    if (!held || Date.parse(row.recordedAt) >= Date.parse(held.recordedAt)) best.set(at, row);
  }
  return [...best.values()];
}

/* ------------------------------------------------------------------ */

export function buildAccountsWorkbook(options: AccountsWorkbookOptions): AccountsWorkbook {
  const { dataset, vehicleId, period, knowledgeDate } = options;
  const problems: string[] = [];

  const vehicle = dataset.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new Error('That product is not in this book.');

  const positions = dataset.positions.filter((p) => p.vehicleId === vehicleId);
  const positionIds = new Set(positions.map((p) => p.id));
  const investors = dataset.investors.filter((i) => i.vehicleId === vehicleId);
  const investorIds = new Set(investors.map((i) => i.id));

  const valuations = newest(
    visible(dataset.positionValuations.filter((v) => positionIds.has(v.positionId)), knowledgeDate),
    (v) => `${v.positionId}/${v.period}`,
  );
  const cashflows = visible(
    dataset.cashflows.filter((c) => c.vehicleId === vehicleId), knowledgeDate,
  );
  const balanceSheets = newest(
    visible(dataset.balanceSheets.filter((b) => b.vehicleId === vehicleId), knowledgeDate),
    (b) => b.period,
  );
  const metrics = newest(
    visible(dataset.metrics.filter(
      (m) => m.scope.id === vehicleId || positionIds.has(m.scope.id) || investorIds.has(m.scope.id),
    ), knowledgeDate),
    (m) => `${m.scope.id}/${m.metric}/${m.period}`,
  );
  const rates = newest(
    visible(dataset.fxRates, knowledgeDate),
    (r) => `${r.base}/${r.quote}/${r.date}/${r.rate}`,
  );

  if (positions.length === 0) {
    problems.push('This product has no holdings, so the ledger will be empty.');
  }

  // The name the register feed knows the compartment by, which is what the
  // reader takes the product's name from and builds every identifier on.
  const fund = vehicle.shortName || vehicle.name;

  const sheets: TableData[] = [
    ledger(positions, valuations, cashflows, rates, metrics, vehicle.currency),
    register(fund, investors, cashflows.filter((c) => c.investorId && investorIds.has(c.investorId)),
      metrics, vehicle.currency, problems),
    statements(balanceSheets, metrics),
    ...snapshot(positions, valuations, cashflows, dataset.fxRates, metrics, vehicle.currency, period),
    ...twoBases(positions, valuations, cashflows, dataset.fxRates, vehicle.currency, period),
  ];

  return {
    sheets,
    filename: `${slug(fund)}_supporting_${period}`,
    problems,
  };
}

/* --- Investment Accounts ------------------------------------------ */

const LEDGER_COLUMNS: Cell[] = [
  'Class', 'Asset', 'Date', 'Comment', 'CCY', 'Commitment', 'Capital Call',
  'Off commit Expenses (income)', 'Distributions (rec.)', 'Distributions', 'NAV',
  'Net Cash', 'Called Acc', 'Dist Acc', 'Unfunded', 'Net cash2', 'FX Rate applied',
  'Commit. €', 'Capital Call €', 'Off commit Expenses (income) €', 'Distributions (rec.) €',
  'Distributions €', 'NAV €', 'Net Cash €', 'Called Acc €', 'Dist Acc €', 'Unfunded €',
  'Net cash2 €', null, 'FX policy',
];

const CLASS_OF: Record<Position['kind'], string> = {
  fund: 'Primary',
  secondary: 'Secondary',
  'co-investment': 'Co-inv.',
  'direct-investment': 'GP',
};

/** Column indices in the ledger, named so the mapping below reads. */
const COL = {
  klass: 0, asset: 1, date: 2, comment: 3, ccy: 4, commitment: 5, call: 6, off: 7, rec: 8,
  dist: 9, nav: 10, rate: 16, aside: 29,
} as const;

/**
 * The ledger, one row per event.
 *
 * Signed the way the file is — a call positive, money back negative — which
 * is the opposite of the book, so every amount is turned round. The euro
 * columns are the local figure at the rate on the row, which is all they ever
 * are; writing them is what lets the reader check them.
 */
function ledger(
  positions: Position[],
  valuations: PositionValuation[],
  cashflows: Cashflow[],
  rates: FxRate[],
  metrics: Metric[],
  currency: string,
): TableData {
  const byId = new Map(positions.map((p) => [p.id, p]));

  // The rates the ledger stated for a currency on a date, in the order the
  // reader keeps them. Two on one date go to that date's rows in turn: which
  // movement carried which is not a fact the book keeps, and both are.
  const onDate = new Map<string, number[]>();
  for (const rate of rates) {
    if (rate.quote !== currency) continue;
    const key = `${rate.base}/${rate.date}`;
    onDate.set(key, [...(onDate.get(key) ?? []), rate.rate].sort((a, b) => a - b));
  }
  const handed = new Map<string, number>();
  const rateFor = (position: Position, date: string): number | null => {
    if (position.currency === currency) return 1;
    const key = `${position.currency}/${date}`;
    const stated = onDate.get(key);
    if (!stated || stated.length === 0) return null;
    const turn = handed.get(key) ?? 0;
    handed.set(key, turn + 1);
    return stated[Math.min(turn, stated.length - 1)];
  };

  interface Line { asset: string; date: string; order: number; cells: Cell[] }
  const lines: Line[] = [];

  const blank = (position: Position, date: string, comment: string): Cell[] => {
    const cells: Cell[] = new Array(LEDGER_COLUMNS.length).fill(null);
    cells[COL.klass] = CLASS_OF[position.kind] ?? 'Primary';
    cells[COL.asset] = position.name;
    cells[COL.date] = date;
    cells[COL.comment] = comment;
    cells[COL.ccy] = position.currency;
    return cells;
  };

  // Local into euro, on every figure the row carries, at the rate it carries.
  const priced = (cells: Cell[], rate: number | null): Cell[] => {
    cells[COL.rate] = rate;
    for (const at of [COL.commitment, COL.call, COL.off, COL.rec, COL.dist, COL.nav]) {
      const local = cells[at];
      cells[at + 12] = typeof local === 'number' && rate !== null ? local * rate : null;
    }
    return cells;
  };

  for (const position of positions) {
    if (!position.commitment) continue;
    const cells = blank(position, position.commitmentDate, 'Initial Commitment');
    cells[COL.commitment] = position.commitment;
    // The commitment in euro is frozen at the rate of the day it was made, and
    // the book keeps that figure beside the holding rather than the rate. The
    // rate on the row is the one that produces it.
    const frozen = metrics
      .filter((m) => m.scope.id === position.id && m.metric === 'accounts.commitmentAtCommitmentRate')
      .reduce((sum, m) => sum + (m.value ?? 0), 0);
    const rate = frozen > 0 && position.commitment > 0
      ? frozen / position.commitment
      : rateFor(position, position.commitmentDate);
    priced(cells, rate);
    if (frozen > 0) cells[COL.commitment + 12] = frozen;
    lines.push({ asset: position.name, date: position.commitmentDate, order: 0, cells });
  }

  for (const flow of cashflows) {
    if (!flow.positionId) continue;
    const position = byId.get(flow.positionId);
    if (!position) continue;
    if (flow.type === 'Commitment') continue;

    // The column a movement goes back into is the one the reader takes it
    // from: a call of either sign in the call column, a payment outside the
    // commitment and income received outside it both in the off-commitment
    // column with their own signs, a recallable distribution in its own.
    const column = flow.type === 'Capital Call' ? COL.call
      : flow.type === 'Equalisation' || flow.type === 'Income' || flow.type === 'Fee' || flow.type === 'Expense' ? COL.off
        : flow.recallable ? COL.rec
          : COL.dist;

    const cells = blank(position, flow.date, flow.description ?? '');
    cells[column] = -flow.amount;
    priced(cells, rateFor(position, flow.date));
    lines.push({ asset: position.name, date: flow.date, order: 1, cells });
  }

  for (const valuation of valuations) {
    const position = byId.get(valuation.positionId);
    if (!position) continue;
    const date = periodEndDate(valuation.period);
    const cells = blank(position, date, 'NAV');
    cells[COL.nav] = valuation.nav;
    priced(cells, rateFor(position, date));
    lines.push({ asset: position.name, date, order: 2, cells });
  }

  lines.sort((a, b) => a.asset.localeCompare(b.asset)
    || a.date.localeCompare(b.date)
    || a.order - b.order);

  // The FX policy and its change log, as written, down the column the file
  // keeps them in — on the first rows of the ledger, which is where the reader
  // looks for them.
  const policy = metrics.find((m) => m.metric === 'accounts.fxPolicy')?.text;
  if (policy) {
    policy.split('\n').forEach((line, i) => {
      if (lines[i]) lines[i].cells[COL.aside] = line;
    });
  }

  return {
    sheetName: 'Investment Accounts',
    rows: [LEDGER_COLUMNS, ...lines.map((line) => line.cells)],
  };
}

/* --- Onesource ---------------------------------------------------- */

const REGISTER_COLUMNS: Cell[] = [
  'Fund_Compartiment', 'Investor_name', 'Investor_Fund_ID', 'Date', 'Event_type', 'Value', 'Unit', 'Source',
];

/**
 * The register feed: one row per event per investor, every value positive,
 * the event saying which way the money went.
 *
 * The identifier is the one the reader builds the investor's own identity
 * from, taken back out of it, so a book that came from this shape goes back
 * out under the administrator's numbers rather than under new ones.
 */
function register(
  fund: string,
  investors: Investor[],
  cashflows: Cashflow[],
  metrics: Metric[],
  currency: string,
  problems: string[],
): TableData {
  const prefix = `inv-${slug(fund).slice(0, 16)}-`;
  const keyOf = (investor: Investor) => (
    investor.id.startsWith(prefix) ? investor.id.slice(prefix.length) : slug(investor.name)
  );
  const byId = new Map(investors.map((investor) => [investor.id, investor]));

  interface Line { date: string; investor: string; order: number; cells: Cell[] }
  const lines: Line[] = [];
  const line = (
    investor: Investor, date: string, event: string, value: number, source: string, order: number,
  ) => lines.push({
    date, investor: investor.name, order,
    cells: [fund, investor.name, keyOf(investor), date, event, value, currency, source],
  });

  for (const investor of investors) {
    if (investor.commitment) {
      line(investor, investor.entryDate, 'Subscription', investor.commitment, 'Acceptance Letter', 0);
    }
  }

  const unwritten = new Set<string>();
  for (const flow of cashflows) {
    const investor = flow.investorId ? byId.get(flow.investorId) : undefined;
    if (!investor) continue;
    const size = Math.abs(flow.amount);
    const source = flow.sourceDetail ?? 'Notices';
    // Positive from the vehicle's side is money from the investor. A call the
    // other way is capital handed back to an earlier closer, which the feed
    // calls an equalisation distributed; a premium is named from the
    // investor's side, so the one the fund received is the one they paid.
    if (flow.type === 'Capital Call') {
      const event = flow.amount < 0 ? 'Equalization Called'
        : /equalisation|equalization/i.test(flow.description ?? '') ? 'Equalization Called'
          : 'Capital Call';
      line(investor, flow.date, flow.amount < 0 ? 'Equalization Distributed' : event, size, source, 1);
    } else if (flow.type === 'Equalisation') {
      line(investor, flow.date,
        flow.amount >= 0 ? 'Equalization Premium paid' : 'Equalization Premium received', size, source, 1);
    } else if (flow.type === 'Distribution' || flow.type === 'Return of Capital' || flow.type === 'Income') {
      line(investor, flow.date, 'Dividend (Cash Distribution)', size, source, 1);
    } else {
      unwritten.add(`${flow.type} of ${size} to ${investor.name} on ${flow.date}`);
    }
  }
  if (unwritten.size > 0) {
    problems.push(
      `The register feed has no event for a fee or an expense charged to an investor, so `
      + `${unwritten.size} movement(s) are not in it: ${[...unwritten].slice(0, 3).join('; ')}`
      + `${unwritten.size > 3 ? '; …' : ''}.`,
    );
  }

  for (const metric of metrics) {
    if (metric.metric !== 'capitalAccount' || metric.value === undefined) continue;
    const investor = byId.get(metric.scope.id);
    if (!investor) continue;
    line(investor, periodEndDate(metric.period), 'Capital Account Statement', metric.value,
      'Capital account statement', 2);
  }

  lines.sort((a, b) => a.date.localeCompare(b.date)
    || a.order - b.order
    || a.investor.localeCompare(b.investor));

  return {
    sheetName: 'Onesource',
    rows: [REGISTER_COLUMNS, ...lines.map((row) => row.cells)],
  };
}

/* --- FS ----------------------------------------------------------- */

const YTD = /^pl\.ytd\./;

/**
 * The statements, a column per quarter, the balance sheet above and the income
 * statement below its own marker.
 *
 * The book keeps the balance sheet in four fields and the statements in a
 * dozen lines, so what goes back is what the reader maps: cash on its line,
 * everything else owed to the fund on the debtors' line, the payables, the
 * creditors and accruals with the carried interest taken back out of them and
 * shown on its own line under capital — and the totals the statements state
 * for themselves, investments, capital and reserves, contributions and
 * distributions, from the figures the book kept of them.
 */
function statements(balanceSheets: VehicleBalanceSheet[], metrics: Metric[]): TableData {
  const stated = (name: string, period: PeriodId): number | undefined => metrics.find(
    (m) => m.scope.kind === 'vehicle' && m.metric === name && m.period === period,
  )?.value;
  const income = metrics.filter((m) => m.scope.kind === 'vehicle' && YTD.test(m.metric));

  const periods = sortPeriods([
    ...new Set([...balanceSheets.map((b) => b.period), ...income.map((m) => m.period)]),
  ]);
  const sheetAt = new Map(balanceSheets.map((b) => [b.period, b]));

  const line = (
    number: Cell, caption: string, pick: (period: PeriodId, sheet?: VehicleBalanceSheet) => Cell,
  ): Cell[] => [null, number, null, caption, ...periods.map((period) => pick(period, sheetAt.get(period)))];

  const or = (value: number | undefined, fallback: Cell): Cell => (value === undefined ? fallback : value);
  const carry = (period: PeriodId) => stated('fs.carriedInterest', period) ?? 0;

  const rows: Cell[][] = [
    [null, null, null, null, ...periods.map((period) => periodEndDate(period))],
    ['Balance\nSheet', '1.00', null, 'Assets:', ...periods.map((period) => {
      const sheet = sheetAt.get(period);
      const investments = stated('fs.investments', period);
      return sheet && investments !== undefined
        ? investments + sheet.cash + sheet.otherAssets
        : null;
    })],
    line('1.10', 'Non-current Assets', (period) => or(stated('fs.investments', period), null)),
    line('1.1.1', 'Investments:', (period) => or(stated('fs.investments', period), null)),
    line('1.20', 'Current Assets:', (_, sheet) => (sheet ? sheet.cash + sheet.otherAssets : null)),
    line('1.2.1', 'Cash and cash equivalents', (_, sheet) => sheet?.cash ?? null),
    line('1.2.2', 'Debtors and prepayments', (_, sheet) => sheet?.otherAssets ?? null),
    line('1.2.3', 'Accounts receivable', (_, sheet) => (sheet ? 0 : null)),
    line('1.2.4', 'Establishment Costs', (_, sheet) => (sheet ? 0 : null)),
    line('2.00', 'Capital and Reserves', (period) => or(stated('fs.capitalAndReserves', period), null)),
    line('2.10', 'Limited Partners Contributions', (period) => or(stated('fs.contributions', period), null)),
    line(null, 'Limited Partners Distributions', (period) => or(stated('fs.distributions', period), null)),
    line('2.40', 'Theoretical Carried Interest to Initial Limited Partner', (period, sheet) => (sheet ? carry(period) : null)),
    line('3.00', 'Liabilities', (_, sheet) => (sheet ? sheet.currentLiabilities + sheet.accruedExpenses : null)),
    line('3.1.1', 'Creditors and accruals', (period, sheet) => (sheet ? sheet.accruedExpenses - carry(period) : null)),
    line('3.1.2', 'Accounts payable', (_, sheet) => sheet?.currentLiabilities ?? null),
    [],
  ];

  // The income statement, each line under the caption it was read from — put
  // back into words from the name the reader made of it, so that reading it
  // again makes the same name. A word boundary before every capital, not only
  // after a lower-case letter: `G/L` came in as two one-letter words, and
  // `realisedGLOnInvestments` split any other way comes back as `Gl On`.
  const names = [...new Set(income.map((m) => m.metric))].sort();
  const held = new Map(income.map((m) => [`${m.metric}/${m.period}`, m.value ?? null]));
  names.forEach((name, i) => {
    const caption = name.replace(YTD, '').replace(/([A-Z])/g, ' $1').trim();
    rows.push([
      i === 0 ? 'P&L\nStatement' : null, null, null, caption,
      ...periods.map((period) => (held.get(`${name}/${period}`) ?? null) as Cell),
    ]);
  });

  return { sheetName: 'FS', rows };
}

/* --- Portfolio New ------------------------------------------------ */

const SNAPSHOT_COLUMNS: Cell[] = [
  'Quarter', 'Date', 'Asset', 'CCY', 'Commitment', 'Drawdown', 'Distributed', 'NAV', 'Open', 'TVPI',
  'FX', 'Commitment €', 'Drawdown €', 'Distributed €', 'NAV €', 'Total Value', 'Open €', 'TVPI €',
  'Multiple basis', 'Paid-In €',
];

/**
 * The snapshot, as the desk publishes it.
 *
 * The lines are computed — capital drawn and paid-in from the ledger, the
 * value from the valuation — and the total is what the book kept of the
 * desk's own total, where it kept one. The two can differ by a rate, and the
 * reader compares them, which is what the total is there for; a total
 * recomputed from the lines would agree with them by construction and check
 * nothing.
 */
function snapshot(
  positions: Position[],
  valuations: PositionValuation[],
  cashflows: Cashflow[],
  fxRates: FxRate[],
  metrics: Metric[],
  currency: string,
  period: PeriodId,
): TableData[] {
  if (positions.length === 0) return [];

  // The quarter the book holds a published total for, at or before the one
  // asked for; failing that, the one asked for.
  const published = sortPeriods(
    [...new Set(metrics.filter((m) => m.metric.startsWith('snapshot.') && m.period <= period).map((m) => m.period))],
  ).pop() ?? period;
  const stated = (name: string) => metrics.find(
    (m) => m.scope.kind === 'vehicle' && m.metric === `snapshot.${name}` && m.period === published,
  )?.value;

  const quarter = `Q${published.slice(5)} ${published.slice(0, 4)}`;
  const date = periodEndDate(published);
  const total = { commitment: 0, drawdown: 0, distributed: 0, nav: 0, open: 0, paidIn: 0, applied: 0, returned: 0 };
  const rows: Cell[][] = [];

  for (const position of positions) {
    const local = returnBases({
      cashflows, valuations, fxRates, positionId: position.id, currency: position.currency, period: published,
    });
    const euro = returnBases({
      cashflows, valuations, fxRates, positionId: position.id, currency: position.currency,
      period: published, stateIn: currency,
    });
    const drawn = local.find((b) => b.key === 'capital-drawn');
    const drawnEur = euro.find((b) => b.key === 'capital-drawn');
    const paidEur = euro.find((b) => b.key === 'with-off-commitment');
    if (!drawn || !drawnEur || !paidEur) continue;

    const frozen = metrics
      .filter((m) => m.scope.id === position.id && m.metric === 'accounts.commitmentAtCommitmentRate')
      .reduce((sum, m) => sum + (m.value ?? 0), 0);
    const closing = drawn.residual > 0 ? drawnEur.residual / drawn.residual : null;
    const open = position.commitment - drawn.paidIn;
    const commitmentEur = frozen > 0 ? frozen : (closing !== null ? position.commitment * closing : null);
    const openEur = closing !== null ? open * closing : null;

    // The multiple on the basis the holding is agreed to sit on — the
    // product's, unless the book says this one is the exception.
    const onDrawn = position.reportingBasis === 'capital-drawn';
    const shown = onDrawn ? drawn : local.find((b) => b.key === 'with-off-commitment')!;
    const shownEur = onDrawn ? drawnEur : paidEur;

    total.commitment += commitmentEur ?? 0;
    total.drawdown += drawnEur.paidIn;
    total.distributed += drawnEur.distributed;
    total.nav += drawnEur.residual;
    total.open += openEur ?? 0;
    total.paidIn += paidEur.paidIn;
    total.applied += shownEur.paidIn;
    total.returned += shownEur.distributed;

    rows.push([
      quarter, date, position.name, position.currency,
      position.commitment, drawn.paidIn, drawn.distributed, drawn.residual, open, shown.tvpi ?? null,
      closing,
      commitmentEur, drawnEur.paidIn, drawnEur.distributed, drawnEur.residual,
      drawnEur.residual + drawnEur.distributed, openEur, shownEur.tvpi ?? null,
      onDrawn ? 'Drawdown' : 'Paid-In',
      paidEur.paidIn,
    ]);
  }

  const or = (name: 'commitment' | 'drawdown' | 'distributed' | 'nav' | 'open' | 'paidIn') =>
    stated(name === 'open' ? 'openCommitment' : name) ?? total[name];
  rows.push([
    'Total', null, null, null, null, null, null, null, null, null, null,
    or('commitment'), or('drawdown'), or('distributed'), or('nav'),
    or('nav') + or('distributed'), or('open'),
    // Over the denominators applied, as the desk publishes it.
    total.applied > 0 ? (total.nav + total.returned) / total.applied : null,
    null,
    or('paidIn'),
  ]);

  return [{
    sheetName: 'Portfolio New',
    rows: [
      ['Portfolio — Snapshot by Quarter', null, null, 'Quarter:', quarter],
      ['The lines are computed from the ledger: drawdown is capital drawn, calls net of what may '
        + 'be called back; paid-in is the calls with everything paid outside the commitment. The '
        + 'total is the figure the desk published, kept so the two can be compared. TVPI and DPI '
        + 'are taken on paid-in; a holding the column beside it puts on drawdown is the agreed '
        + 'exception, and the total\u2019s multiple is over the denominators applied.'],
      [],
      [],
      SNAPSHOT_COLUMNS,
      ...rows,
    ],
  }];
}

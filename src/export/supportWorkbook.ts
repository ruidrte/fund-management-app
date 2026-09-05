/**
 * Emitting a quarterly reporting workbook.
 *
 * The second writer, for the second shape. Same discipline as the first: the
 * sheets a reader reads, written back from the book, and a round trip that has
 * to close. What differs is what the file it imitates is.
 *
 * The advisory workbook was built to be a source of truth and nothing else.
 * This one is a working file — twenty-six sheets, most of them calculation: the
 * internal rate of return, the expense ratio, the split of net asset value, the
 * geometric performance series, the tables behind the charts. Those are not
 * reproduced, and deliberately. They are arithmetic this application already
 * does, and copying somebody's formulas into a generated file is how two
 * answers to the same question start to disagree.
 *
 * So what is written is the input: the control panel, the transaction log, the
 * balance sheet, the income statement and the investors' own ledger. Everything
 * a person types, and nothing a spreadsheet works out.
 *
 * One thing does not survive exactly. The income statement's columns are dated
 * ranges rather than quarters, and the range a figure covers is not a fact the
 * book keeps — only the quarter it ends in. So the headings are rebuilt from
 * the year rather than reproduced, and a first period that began at inception
 * comes back beginning on the first of January. Every figure under them is the
 * figure that went in.
 */

import {
  formatPeriod, periodEndDate, sortPeriods, type PeriodId,
} from '../domain/period';
import type {
  Cashflow, DataSet, Investor, Metric, Position, PositionValuation, VehicleBalanceSheet,
} from '../domain/types';
import type { TableData } from '../ingest/types';

export interface SupportWorkbookOptions {
  dataset: DataSet;
  vehicleId: string;
  period: PeriodId;
  knowledgeDate?: string;
}

export interface SupportWorkbook {
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

/** `2026-06-30` -> `30.06.2026`, which is how this workbook writes a date. */
function written(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/* ------------------------------------------------------------------ */

export function buildSupportWorkbook(options: SupportWorkbookOptions): SupportWorkbook {
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
    visible(dataset.metrics.filter((m) => m.scope.id === vehicleId), knowledgeDate),
    (m) => `${m.metric}/${m.period}`,
  );
  // By date, not by quarter: a quarter holds one rate per transaction date and
  // reducing them to one puts the closing rate on every movement in it, which
  // converts each of them at a rate that was not the rate on the day.
  const rates = newest(
    visible(dataset.fxRates, knowledgeDate),
    (r) => `${r.base}/${r.quote}/${r.date}/${r.kind}`,
  );

  if (positions.length === 0) {
    problems.push('This product has no holdings, so the transaction log will be empty.');
  }

  const sheets: TableData[] = [
    cover(vehicle.name, dataset.client.name, vehicle.currency, period, knowledgeDate),
    investments(positions, valuations, cashflows, rates, vehicle.currency),
    balanceSheet(balanceSheets),
    incomeStatement(metrics, vehicle.currency),
    investorLedger(investors, cashflows.filter((c) => c.investorId && investorIds.has(c.investorId))),
    ...acquisitionCosts(metrics),
  ];

  return {
    sheets,
    filename: `${slug(vehicle.shortName)}_reporting_${period}`,
    problems,
  };
}

/* --- Cover -------------------------------------------------------- */

function cover(
  product: string, house: string, currency: string,
  period: PeriodId, knowledgeDate?: string,
): TableData {
  return {
    sheetName: 'Cover',
    // The masthead is the lines above the control panel, and the product is the
    // second of them. That is how the reader finds it, so that is how it is
    // written — the house first, then what this file is about.
    rows: ([
      [null, house.toUpperCase()],
      [null, product],
      [],
      [null, 'Reporting support workbook — written by the reporting system'],
      [],
      [null, 'CONTROL PANEL'],
      [null, 'Reporting date', periodEndDate(period)],
      [null, 'Reporting currency', currency],
      [null, 'Quarter', formatPeriod(period)],
      [null, 'Knowledge date', knowledgeDate ?? 'Everything known now'],
      [],
      [null, 'The sheets a person types into are here. The internal rate of return, the '
        + 'expense ratio and the tables behind the charts are not: this application computes '
        + 'them, and a copy of somebody else’s formulas is how two answers start to disagree.'],
      [null, 'The income statement’s column headings are rebuilt from the year each range '
        + 'ends in, because the range itself is not a figure this book keeps. The figures '
        + 'under them are the figures that went in.'],
    ] as Cell[][]),
  };
}

/* --- Investments -------------------------------------------------- */

const LEDGER_COLUMNS = [
  'Asset', 'Class', 'CCY', 'Date', 'Event', 'Comment', 'Commitment', 'Capital Call',
  'Acq cost', 'Other exp', 'Recallable', 'Distributions', 'NAV', 'FX rate', 'Source detail',
];

const CLASS_OF: Record<Position['kind'], string> = {
  fund: 'Primary',
  secondary: 'Secondary',
  'co-investment': 'Co-investment',
  'direct-investment': 'Direct',
};

/**
 * The transaction log, one row per event.
 *
 * Which column a movement goes back into is decided by what the reader would
 * make of it, not by its type alone: capital called that consumes commitment
 * and capital called that does not are the same type here and different columns
 * there, because one is a drawdown and the other is a cost capitalised into the
 * asset.
 */
function investments(
  positions: Position[],
  valuations: PositionValuation[],
  cashflows: Cashflow[],
  rates: DataSet['fxRates'],
  currency: string,
): TableData {
  const byId = new Map(positions.map((p) => [p.id, p]));
  // The rate the movement was converted at, which is the one for its own date.
  // Falling back to the quarter's is a last resort and is visibly different
  // from having none at all.
  const rateFor = (position: Position, date: string, period: PeriodId): number | null => {
    if (position.currency === currency) return 1;
    const onTheDay = rates.find(
      (rate) => rate.base === position.currency && rate.date === date,
    );
    if (onTheDay) return onTheDay.rate;
    const inTheQuarter = rates
      .filter((rate) => rate.base === position.currency && rate.period === period)
      .sort((a, b) => a.date.localeCompare(b.date))
      .pop();
    return inTheQuarter?.rate ?? null;
  };

  interface Line { asset: string; date: string; period: PeriodId; order: number; cells: Cell[] }
  const lines: Line[] = [];

  const blank = (position: Position, date: string, period: PeriodId, event: string): Cell[] => [
    position.name, CLASS_OF[position.kind] ?? 'Primary', position.currency, date, event,
    '', null, null, null, null, null, null, null, rateFor(position, date, period), '',
  ];

  for (const position of positions) {
    if (position.commitment) {
      const cells = blank(position, position.commitmentDate, position.vintage
        ? `${position.vintage}Q1` as PeriodId : `${position.commitmentDate.slice(0, 4)}Q1` as PeriodId,
        'Commitment');
      cells[5] = 'Commitment';
      cells[6] = position.commitment;
      lines.push({
        asset: position.name, date: position.commitmentDate,
        period: `${position.commitmentDate.slice(0, 4)}Q1`, order: 0, cells,
      });
    }
  }

  for (const flow of cashflows) {
    if (!flow.positionId) continue;
    const position = byId.get(flow.positionId);
    if (!position) continue;

    // Column 6 is a drawdown, 7 a cost capitalised into the asset, 8 an expense
    // outside the commitment, 9 a distribution that can be called again, 10 one
    // that cannot. The reader reverses exactly this.
    const column = flow.type === 'Capital Call'
      ? (flow.affectsCommitment ? 7 : 8)
      : flow.type === 'Equalisation' ? 9
        : flow.recallable ? 10 : 11;

    const cells = blank(position, flow.date, flow.period, eventOf(flow));
    cells[5] = flow.description ?? '';
    cells[column] = column === 10 || column === 11 ? flow.amount : -flow.amount;
    cells[14] = flow.sourceDetail ?? '';
    lines.push({ asset: position.name, date: flow.date, period: flow.period, order: 1, cells });
  }

  for (const valuation of valuations) {
    const position = byId.get(valuation.positionId);
    if (!position) continue;
    const cells = blank(position, periodEndDate(valuation.period), valuation.period, 'NAV');
    cells[5] = 'NAV';
    cells[12] = valuation.nav;
    lines.push({
      asset: position.name, date: periodEndDate(valuation.period),
      period: valuation.period, order: 2, cells,
    });
  }

  lines.sort((a, b) => a.asset.localeCompare(b.asset)
    || a.date.localeCompare(b.date)
    || a.order - b.order);

  return {
    sheetName: 'Investments',
    rows: ([
      ['INVESTMENTS — single transaction log (one row per event, all assets)'],
      [],
      LEDGER_COLUMNS,
      ...lines.map((line) => line.cells),
    ] as Cell[][]),
  };
}

function eventOf(flow: Cashflow): string {
  if (flow.type === 'Capital Call') return flow.affectsCommitment ? 'Capital call' : 'Acq cost';
  if (flow.type === 'Equalisation') return 'Equalisation';
  return 'Distribution';
}

/* --- BS ----------------------------------------------------------- */

/**
 * The balance sheet, a column per quarter and a row per tagged line.
 *
 * Receivables and prepayments are one field in this application and two rows
 * here, and which of the two a figure came from is not kept. It is written back
 * under receivables and the other row left at zero: the reader adds them, so
 * what it makes of the sheet is unchanged, and no figure is invented for a row
 * nobody can reconstruct.
 */
function balanceSheet(rows: VehicleBalanceSheet[]): TableData {
  const periods = sortPeriods(rows.map((row) => row.period));
  const at = new Map(rows.map((row) => [row.period, row]));
  const line = (tag: string, label: string, pick: (row: VehicleBalanceSheet) => number): Cell[] => [
    tag, label, ...periods.map((period) => {
      const held = at.get(period);
      return held ? pick(held) : null;
    }),
  ];

  return {
    sheetName: 'BS',
    rows: ([
      ['Balance Sheet'],
      [],
      ['Mapping', 'ASSETS', ...periods.map((period) => periodEndDate(period))],
      line('Cash', 'Cash and cash equivalent', (row) => row.cash),
      line('ST receivables', 'Short term receivables', (row) => row.otherAssets),
      line('Accruals A', 'Accrued income and prepaid expenses', () => 0),
      line('ST Liabilities', 'Short term liabilities', (row) => row.currentLiabilities),
      line('Accruals P', 'Accrued expenses', (row) => row.accruedExpenses),
    ] as Cell[][]),
  };
}

/* --- P&L ---------------------------------------------------------- */

const YTD = /^pl\.ytd\./;

function incomeStatement(metrics: Metric[], currency: string): TableData {
  const mine = metrics.filter((metric) => YTD.test(metric.metric));
  const periods = sortPeriods([...new Set(mine.map((metric) => metric.period))]);
  const names = [...new Set(mine.map((metric) => metric.metric))].sort();
  const held = new Map(mine.map((metric) => [`${metric.metric}/${metric.period}`, metric]));

  // The range each column covers begins at the start of its own year, which is
  // what a year-to-date figure means. The original may have begun at inception
  // instead; that is a heading, not a figure, and is said so on the cover.
  const heading = (period: PeriodId) => {
    const end = periodEndDate(period);
    return `01.01.${end.slice(0, 4)}-${written(end)}`;
  };

  return {
    sheetName: 'P&L',
    rows: ([
      ['Profit & Loss account'],
      [],
      ['Mapping', '', '', 'Profit & Loss account', ...periods.map(heading)],
      ['', '', '', '', ...periods.map(() => currency)],
      ...names.map((name) => {
        // Spaced out again, so that reading it back gives the name it went out
        // under. `commissIncome` written as written comes back `commissincome`,
        // which is a different figure to anything asking for it by name.
        const tag = name.replace(YTD, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        return [
          tag, '', '', tag,
          ...periods.map((period) => (held.get(`${name}/${period}`)?.value ?? null) as Cell),
        ];
      }),
    ] as Cell[][]),
  };
}

/* --- Investors CF ------------------------------------------------- */

function investorLedger(investors: Investor[], cashflows: Cashflow[]): TableData {
  const byId = new Map(investors.map((investor) => [investor.id, investor]));
  const rows: Cell[][] = [];

  for (const investor of investors) {
    rows.push([
      slug(investor.name), investor.name, investor.entryDate, 'Commitment',
      investor.commitment, null, null, null,
    ]);
  }

  for (const flow of cashflows) {
    const investor = flow.investorId ? byId.get(flow.investorId) : undefined;
    if (!investor) continue;
    rows.push([
      slug(investor.name), investor.name, flow.date, flow.description ?? '',
      null,
      flow.type === 'Capital Call' ? flow.amount : null,
      flow.type === 'Fee' ? flow.amount : null,
      null,
    ]);
  }

  rows.sort((a, b) => String(a[1]).localeCompare(String(b[1]))
    || String(a[2]).localeCompare(String(b[2])));

  return {
    sheetName: 'Investors CF',
    rows: ([
      ['INVESTORS — capital accounts'],
      [],
      ['ID', 'Short Name', 'Date', 'Description', 'Commitment', 'Capital Called',
        'Other (fees)', 'Rebates'],
      ...rows,
    ] as Cell[][]),
  };
}

/* --- Acquisition costs -------------------------------------------- */

/**
 * The accounting ledger's total, and only its total.
 *
 * Its itemisation is not in the book — the lines are the components of a figure
 * the transaction log already carries, and filing both would count the cost
 * twice. What the check needs is the total, so the total is written, and the
 * check survives into the file rather than only running on the day of import.
 */
function acquisitionCosts(metrics: Metric[]): TableData[] {
  const total = metrics.find(
    (metric) => metric.metric === 'accounting.capitalisedAcquisitionCosts',
  );
  if (!total?.value) return [];
  return [{
    sheetName: 'Acquisition costs',
    rows: ([
      ['ACQUISITION COSTS — capitalised into asset cost, therefore part of Called'],
      [],
      ['SUMMARY — capitalised acquisition costs, as the accounting ledger states them'],
      ['Total', total.value],
    ] as Cell[][]),
  }];
}

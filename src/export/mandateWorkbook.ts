/**
 * Emitting the support workbook.
 *
 * The reader takes an adviser's monitoring workbook and turns it into facts.
 * This turns the facts back into the workbook. Same shape, same sheet names,
 * same headings — because the workbook is the contract between this system and
 * the deck that gets sent, and a contract that drifts is not one.
 *
 * The point is not convenience. Once the history is in the book, the quarter
 * arrives as events — a capital call, a distribution, a statement — and the
 * workbook stops being something to maintain by hand and becomes something to
 * produce. What has to be true for that to be safe is that nothing was lost on
 * the way in: a column the reader did not understand, a city, a narrative
 * sentence. So the emitter is written against the same map as the reader, and
 * the round trip is a test — read a workbook, emit it, read it again, and the
 * facts must be the same.
 *
 * Two things it does that the file it imitates does not.
 *
 *   It says what is derived. The workbook it emits looks hand-kept, and a
 *   figure this system rolled forward or worked out at a paid-in share must not
 *   be mistaken for one the manager reported. Every such figure is listed on a
 *   sheet of its own, by fund and quarter, with the reason.
 *
 *   It states its own knowledge date. A workbook emitted today for a quarter
 *   closed a year ago is not the workbook that was emitted then, and the
 *   difference is the whole reason the facts carry when they were learned.
 */

import {
  formatPeriod, periodEndDate, previousPeriod, sortPeriods, type PeriodId,
} from '../domain/period';
import type {
  Asset, AssetValuation, Cashflow, DataSet, Metric, Position, PositionValuation,
} from '../domain/types';
import type { TableData } from '../ingest/types';
import { visibleAt } from '../engine/asof';

export interface MandateWorkbookOptions {
  dataset: DataSet;
  /** The mandate to emit. One product, one workbook, as the format is. */
  vehicleId: string;
  /** The quarter the fill surface is for. */
  period: PeriodId;
  /** Only facts recorded at or before this instant, so a past quarter reproduces. */
  knowledgeDate?: string;
}

export interface MandateWorkbook {
  sheets: TableData[];
  filename: string;
  /** What could not be written, and why — never silently omitted. */
  problems: string[];
}

type Cell = string | number | null;

/* ------------------------------------------------------------------ *
 * Reading the book back
 * ------------------------------------------------------------------ */

/** The roman numeral a fund is distinguished by, as `Fund VI REIT LP` -> `VI`. */
function romanIn(value: string): string | undefined {
  const found = [...value.matchAll(/\b(I{1,3}|IV|VI{0,3}|IX|XI{0,3})\b/g)];
  return found.length > 0 ? found[found.length - 1][1] : undefined;
}

/** The newest observation of each thing, at the knowledge date. */
function latest<T extends { recordedAt: string }>(rows: T[], key: (row: T) => string): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const at = key(row);
    const held = best.get(at);
    if (!held || Date.parse(row.recordedAt) >= Date.parse(held.recordedAt)) best.set(at, row);
  }
  return [...best.values()];
}

interface Fund {
  key: string;
  position: Position;
  valuations: PositionValuation[];
  assets: Asset[];
}

/* ------------------------------------------------------------------ *
 * The workbook
 * ------------------------------------------------------------------ */

export function buildMandateWorkbook(options: MandateWorkbookOptions): MandateWorkbook {
  const { dataset, vehicleId, period, knowledgeDate } = options;
  const problems: string[] = [];

  const vehicle = dataset.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new Error('That product is not in this book.');

  const at = <T extends { period: PeriodId; recordedAt: string }>(rows: T[]) =>
    visibleAt(rows, knowledgeDate);

  const positions = dataset.positions.filter((p) => p.vehicleId === vehicleId);
  const positionIds = new Set(positions.map((p) => p.id));
  const assets = dataset.assets.filter((a) => positionIds.has(a.positionId));
  const assetIds = new Set(assets.map((a) => a.id));

  const valuations = at(dataset.positionValuations.filter((v) => positionIds.has(v.positionId)));
  const assetValuations = at(dataset.assetValuations.filter((v) => assetIds.has(v.assetId)));
  const cashflows = at(dataset.cashflows.filter((c) => c.vehicleId === vehicleId));
  const metrics = at(dataset.metrics.filter(
    (m) => positionIds.has(m.scope.id) || assetIds.has(m.scope.id),
  ));
  const rates = at(dataset.fxRates);
  const investor = dataset.investors.find((i) => i.vehicleId === vehicleId);

  const funds: Fund[] = positions.map((position) => ({
    key: romanIn(position.name) ?? position.name,
    position,
    valuations: latest(
      valuations.filter((v) => v.positionId === position.id),
      (v) => v.period,
    ).sort((a, b) => a.period.localeCompare(b.period)),
    assets: assets.filter((a) => a.positionId === position.id),
  }));

  if (funds.length === 0) problems.push('This product has no holdings, so there is nothing to write.');

  const before = previousPeriod(period);
  const currency = vehicle.currency;
  const holder = investor?.name ?? 'The mandate holder';
  // What the workbook is about, then whose it is. The first half names the
  // funds rather than the product, which is how the file it imitates reads.
  const about = funds.map((fund) => fund.position.name).join(' and ') || vehicle.name;

  const sheets: TableData[] = [
    readme(about, holder, currency, period, knowledgeDate),
    control(funds, period, currency, rates, problems),
    basis(funds),
    register(funds),
    ...funds.map((fund, index) => quarter(fund, index, period, before, metrics, assetValuations)),
    assetHistory(funds, assetValuations),
    fundQuarter(funds, period, before, metrics),
    fundHistory(funds, metrics),
    ledger(funds, cashflows, rates, currency, holder),
  ];

  return {
    sheets,
    filename: `${slug(vehicle.shortName)}_support_${period}`,
    problems,
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mandate';
}

const TITLE = 'ADVISORY MONITORING  ·  SUPPORT DATA';

/* --- 00 README --------------------------------------------------- */

function readme(
  product: string, holder: string, currency: string,
  period: PeriodId, knowledgeDate?: string,
): TableData {
  return {
    sheetName: '00 README',
    rows: ([
      // No separator on this line: the subject below it is the one carrying it,
      // and the reader finds the subject by exactly that.
      ['ADVISORY MONITORING — SUPPORT DATA'],
      [],
      [`${product}  ·  ${holder}`],
      [],
      ['WHAT THIS FILE IS'],
      [null, 'Written by the reporting system from the facts in its book, not kept by hand. '
        + 'Every figure here can be traced to the document it was read from.'],
      [null, 'It is the same shape as the file it replaces, so whatever reads it — a person or '
        + 'the report generator — needs no change.'],
      [],
      ['AS AT'],
      ['Quarter', formatPeriod(period)],
      ['Knowledge date', knowledgeDate
        ? `As known at ${knowledgeDate}`
        : 'Everything known now'],
      [],
      ['CONVENTIONS'],
      ['Currency', `${currency} throughout, in full units — never thousands.`],
      ['Derived figures', 'Listed on sheet 05. A figure not on that sheet was reported.'],
      ['Empty', 'A genuinely empty cell means not yet received. A zero means zero.'],
    ] as Cell[][]),
  };
}

/* --- 01 CONTROL -------------------------------------------------- */

function control(
  funds: Fund[], period: PeriodId, currency: string,
  rates: DataSet['fxRates'], problems: string[],
): TableData {
  const rows: Cell[][] = [
    [TITLE],
    ['01  Control and validation'],
    [],
    [null, 'THIS QUARTER'],
    [null, 'Quarter', formatPeriod(period)],
    [null, 'Quarter end', periodEndDate(period)],
  ];

  // The closing rate, where the book holds one for the quarter. Without it the
  // return restated in the holder's own currency stops at the last flow, which
  // is worth saying here rather than leaving a blank cell to be discovered.
  const closing = rates
    .filter((rate) => rate.base === currency && rate.period === period && rate.kind === 'closing')
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (closing) {
    rows.push([null, `${closing.base}/${closing.quote} at quarter end`, closing.rate]);
  } else {
    problems.push(
      `No closing rate out of ${currency} is on record for ${formatPeriod(period)}, so the `
      + 'control sheet carries none.',
    );
  }

  for (const fund of funds) {
    rows.push([null, `Holder share of ${fund.position.name}`, fund.position.ownership]);
  }
  for (const fund of funds) {
    rows.push([null, `Holder commitment, Fund ${fund.key}`, fund.position.commitment]);
  }

  return { sheetName: '01 CONTROL', rows };
}

/* --- 05 BASIS ---------------------------------------------------- */

/**
 * Every figure that was not reported for the quarter it is filed against.
 *
 * The emitted workbook otherwise reads as though a person typed it, and a
 * rolled-forward valuation typed into a cell is indistinguishable from one the
 * manager sent. This is the sheet that tells them apart.
 */
function basis(funds: Fund[]): TableData {
  const rows: Cell[][] = [
    [TITLE],
    ['05  What is not a reported figure'],
    [],
    ['Fund', 'Quarter', 'Figure', 'Basis'],
  ];

  for (const fund of funds) {
    for (const valuation of fund.valuations) {
      if (/capital account/i.test(valuation.source)) continue;
      rows.push([
        fund.position.name, formatPeriod(valuation.period), 'Net asset value', valuation.source,
      ]);
    }
  }

  if (rows.length === 4) {
    rows.push([null, null, null, 'Every figure in this workbook was reported for its own quarter.']);
  }

  return { sheetName: '05 BASIS', rows };
}

/* --- 10 ASSETS --------------------------------------------------- */

const REGISTER_FIELDS = ['City', 'State', 'Tenant type', 'Units'];

function register(funds: Fund[]): TableData {
  // The register's own columns beyond the ones this model has a field for,
  // taken from whatever the assets actually carry so nothing read is dropped.
  const extra = [...new Set(
    funds.flatMap((fund) => fund.assets).flatMap(
      (asset) => Object.keys(asset.attributes ?? {}),
    ),
  )].filter((name) => name !== 'id' && !REGISTER_FIELDS.includes(name));

  const rows: Cell[][] = [
    [TITLE],
    ['10  Asset register'],
    [],
    ['ID', 'Asset — report name', 'Fund', 'City', 'State', 'Region', 'Tenant type', 'Units',
      'Acquisition', ...extra],
  ];

  for (const fund of funds) {
    for (const asset of fund.assets) {
      const kept = asset.attributes ?? {};
      rows.push([
        String(kept.id ?? asset.id),
        asset.name,
        fund.key,
        String(kept.City ?? ''),
        String(kept.State ?? ''),
        typeof asset.region === 'string' ? asset.region : '',
        String(kept['Tenant type'] ?? ''),
        typeof kept.Units === 'number' ? kept.Units : null,
        asset.investmentDate,
        ...extra.map((name) => (kept[name] ?? null) as Cell),
      ]);
    }
  }

  return { sheetName: '10 ASSETS', rows };
}

/* --- 20 / 21 QUARTER --------------------------------------------- */

/**
 * The fill surface, rebuilt.
 *
 * Its columns are not a fixed list: they are whatever the book holds about
 * these properties for this quarter. A manager who added a column had it kept
 * under a name derived from its own heading, and it comes back out here in a
 * column of its own — which is the property that makes this a round trip
 * rather than a lossy re-render.
 */
function quarter(
  fund: Fund, index: number, period: PeriodId, before: PeriodId,
  metrics: Metric[], assetValuations: AssetValuation[],
): TableData {
  const assetIds = new Set(fund.assets.map((a) => a.id));
  const mine = metrics.filter((m) => assetIds.has(m.scope.id));

  // One column per metric, in a stable order, plus a second column for the
  // prior quarter wherever the book holds the same metric for both.
  const names = [...new Set(mine.filter((m) => m.period === period).map((m) => m.metric))].sort();
  const paired = new Set(
    names.filter((name) => mine.some((m) => m.metric === name && m.period === before)),
  );

  const header: Cell[] = ['ID', 'Asset'];
  const columns: Array<{ metric: string; period: PeriodId }> = [];
  for (const name of names) {
    if (paired.has(name)) {
      header.push(`${heading(name)}\n${formatPeriod(before)}`);
      columns.push({ metric: name, period: before });
    }
    header.push(paired.has(name) ? `${heading(name)}\n${formatPeriod(period)}` : heading(name));
    columns.push({ metric: name, period });
  }
  // The two the engine computes on are written as the reader names them, so it
  // reads them back as facts rather than as two more metrics.
  header.push(
    `Fund equity FV\ngesamt-fund · ${formatPeriod(before)}`,
    `Fund equity FV\ngesamt-fund · ${formatPeriod(period)}`,
    'Invested capital', 'Realised proceeds',
  );

  const rows: Cell[][] = [
    [TITLE],
    [`${20 + index}  ${formatPeriod(period)} — ${fund.position.name}`],
    [],
    header,
  ];

  const valued = (assetId: string, at: PeriodId) => latest(
    assetValuations.filter((v) => v.assetId === assetId && v.period === at),
    (v) => v.assetId,
  )[0];

  for (const asset of fund.assets) {
    const held = new Map(
      mine.filter((m) => m.scope.id === asset.id).map((m) => [`${m.metric}/${m.period}`, m]),
    );
    const now = valued(asset.id, period);
    const then = valued(asset.id, before);
    rows.push([
      String(asset.attributes?.id ?? asset.id),
      asset.name,
      ...columns.map((column) => {
        const metric = held.get(`${column.metric}/${column.period}`);
        if (!metric) return null;
        return metric.value ?? metric.text ?? null;
      }),
      then?.unrealised ?? null,
      now?.unrealised ?? null,
      now?.invested ?? null,
      now?.realised ?? null,
    ]);
  }

  return { sheetName: `${20 + index} QUARTER ${fund.key}`, rows };
}

/** The heading a metric is written under, which is how the reader finds it again. */
const HEADINGS: Record<string, string> = {
  'value.fairMarketValue': 'Asset FMV',
  'value.capRate': 'Cap rate',
  'value.netOperatingIncome': 'NOI',
  'value.rehabilitation': 'Rehabilitation',
  'value.other': 'Other / BS (equity side)',
  'narrative.driver': 'Principal driver of the change',
  'capital.committed': 'Total committed',
  'capital.uncalled': 'Uncalled',
  'capital.proceeds': 'Total proceeds',
  'capital.grossMultiple': 'Gross multiple',
  'capital.gain': 'Gain / (loss)',
  'capital.movement': 'Capital in / (out)',
  'debt.principal': 'Principal mortgage',
  'debt.fairValue': 'FMV debt',
  'debt.loanToValue': 'LTV',
  'holding.ownership': 'Ownership %',
  'operations.status': 'Status',
  'operations.occupancy': 'Occupancy',
  'operations.occupancyHigh': '3y high',
  'operations.occupancyLow': '3y low',
  'operations.income.actual': 'Income actual',
  'operations.income.budget': 'Income budget',
  'operations.expense.actual': 'Expense actual',
  'operations.expense.budget': 'Expense budget',
  'operations.noi.actual': 'NOI actual',
  'operations.noi.budget': 'NOI budget',
  'operations.debtService.actual': 'Debt service actual',
  'operations.debtService.budget': 'Debt service budget',
  'operations.cfads.actual': 'CFADS actual',
  'operations.cfads.budget': 'CFADS budget',
  'rehab.strategy': 'Rehab strategy',
  'rehab.planned': 'Rehab planned',
  'rehab.executed': 'Rehab executed',
  'rehab.progress': '%',
  'rehab.status': 'Rehab status',
  'esg.greenCertification': 'Green certification',
  'esg.retrofit': 'Retrofit',
  'esg.residentServices': 'RSC',
  'units.section8': 'Section 8',
  'units.below50Ami': '<50% AMI',
  'units.below60Ami': '<60% AMI',
  'units.below80Ami': '<80% AMI',
  'units.restricted': 'Restricted',
  'units.marketRate': 'Market rate',
  'rent.average': 'Avg total rent',
  'rent.market': 'Avg market rent',
};

function heading(metric: string): string {
  const known = HEADINGS[metric];
  if (known) return known;
  // A column kept under a name derived from its own heading goes back out under
  // that heading, spaced out again: `reported.roofAge` -> `Roof age`.
  const bare = metric.replace(/^reported\./, '');
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[.]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* --- 25 ASSET HISTORY -------------------------------------------- */

const HISTORY_METRICS: Array<[keyof AssetValuation, string]> = [
  ['unrealised', 'Fund equity at fair value, incl. proceeds'],
  ['invested', 'Invested capital'],
  ['realised', 'Realised proceeds'],
];

function assetHistory(funds: Fund[], assetValuations: AssetValuation[]): TableData {
  const periods = sortPeriods([...new Set(assetValuations.map((v) => v.period))]);
  const rows: Cell[][] = [
    [TITLE],
    ['25  Asset history'],
    [],
    ['ID', 'Fund', 'Asset', 'Metric', ...periods.map(formatPeriod)],
  ];

  for (const fund of funds) {
    for (const asset of fund.assets) {
      const mine = assetValuations.filter((v) => v.assetId === asset.id);
      if (mine.length === 0) continue;
      for (const [field, label] of HISTORY_METRICS) {
        const values = periods.map((at) => {
          const held = latest(mine.filter((v) => v.period === at), (v) => v.assetId)[0];
          return (held?.[field] ?? null) as Cell;
        });
        if (values.every((value) => value === null)) continue;
        rows.push([
          String(asset.attributes?.id ?? asset.id), fund.key, asset.name, label, ...values,
        ]);
      }
    }
  }

  return { sheetName: '25 ASSET HISTORY', rows };
}

/* --- 30 FUND QUARTER, 35 FUND HISTORY ---------------------------- */

/** `fund.cumulativePaidInCapital` -> `Cumulative Paid In Capital`. */
function fundLabel(metric: string): string {
  const bare = metric.replace(/^fund\./, '');
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fundMetrics(metrics: Metric[], funds: Fund[]): Metric[] {
  const ids = new Set(funds.map((fund) => fund.position.id));
  return metrics.filter((m) => ids.has(m.scope.id) && m.metric.startsWith('fund.'));
}

function fundQuarter(
  funds: Fund[], period: PeriodId, before: PeriodId, metrics: Metric[],
): TableData {
  const mine = fundMetrics(metrics, funds);
  const names = [...new Set(mine.map((m) => m.metric))].sort();

  const header: Cell[] = ['Metric'];
  const columns: Array<{ id: string; period: PeriodId }> = [];
  for (const fund of funds) {
    for (const at of [period, before]) {
      header.push(`${fund.position.name}\n${formatPeriod(at)}`);
      columns.push({ id: fund.position.id, period: at });
    }
  }

  const rows: Cell[][] = [
    [TITLE],
    [`30  Fund level — ${formatPeriod(period)}`],
    [],
    header,
  ];

  const held = new Map(mine.map((m) => [`${m.scope.id}/${m.metric}/${m.period}`, m]));
  for (const name of names) {
    const values = columns.map(
      (column) => (held.get(`${column.id}/${name}/${column.period}`)?.value ?? null) as Cell,
    );
    if (values.every((value) => value === null)) continue;
    rows.push([fundLabel(name), ...values]);
  }

  return { sheetName: '30 FUND QUARTER', rows };
}

function fundHistory(funds: Fund[], metrics: Metric[]): TableData {
  const mine = fundMetrics(metrics, funds);
  const periods = sortPeriods([...new Set(mine.map((m) => m.period))]);
  const names = [...new Set(mine.map((m) => m.metric))].sort();
  const held = new Map(mine.map((m) => [`${m.scope.id}/${m.metric}/${m.period}`, m]));

  const rows: Cell[][] = [
    [TITLE],
    ['35  Fund history'],
    [],
    ['Fund', 'Metric', ...periods.map(formatPeriod)],
  ];

  for (const fund of funds) {
    for (const name of names) {
      const values = periods.map(
        (at) => (held.get(`${fund.position.id}/${name}/${at}`)?.value ?? null) as Cell,
      );
      if (values.every((value) => value === null)) continue;
      rows.push([fund.key, fundLabel(name), ...values]);
    }
  }

  return { sheetName: '35 FUND HISTORY', rows };
}

/* --- 40 LEDGER --------------------------------------------------- */

function ledger(
  funds: Fund[], cashflows: Cashflow[], rates: DataSet['fxRates'],
  currency: string, holder: string,
): TableData {
  const quote = rates.find((rate) => rate.base === currency)?.quote;
  const rows: Cell[][] = [
    [TITLE],
    [`40  ${holder} cash-flow ledger`],
    [],
    ['Fund', 'Date', 'Description', 'Commitment', 'Paid-in capital', 'Distributions',
      'Residual value', 'Interest', 'Advisory fees', ...(quote ? [`${currency}/${quote}`] : [])],
  ];

  const rateAt = (date: string, average: boolean) => {
    if (!quote) return null;
    const kind = average ? 'average' : 'closing';
    const found = rates.filter(
      (rate) => rate.base === currency && rate.quote === quote
        && rate.date === date && rate.kind === kind,
    );
    return found[found.length - 1]?.rate ?? null;
  };

  for (const fund of funds) {
    const mine = cashflows
      .filter((flow) => flow.positionId === fund.position.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    // The adviser's fee is filed against the holder rather than against a
    // fund, so it goes back beside the fund it was charged for. A fee with no
    // fund recorded is written under the first, and said so below.
    const fees = cashflows.filter(
      (flow) => flow.investorId && !flow.positionId
        && (flow.chargedFor === fund.position.id
          || (!flow.chargedFor && fund === funds[0])),
    );

    rows.push([
      fund.key, fund.position.commitmentDate, `Commitment to Fund ${fund.key}`,
      fund.position.commitment, null, null, null, null, null,
      ...(quote ? [null] : []),
    ]);

    for (const flow of [...mine, ...fees].sort((a, b) => a.date.localeCompare(b.date))) {
      const column = flow.type === 'Capital Call' ? 4
        : flow.type === 'Distribution' ? 5
          : flow.type === 'Equalisation' ? 7
            : flow.type === 'Fee' ? 8 : -1;
      if (column < 0) continue;
      const line: Cell[] = [fund.key, flow.date, flow.description ?? '', null, null, null, null,
        null, null, ...(quote ? [null] : [])];
      line[column] = flow.amount;
      if (quote) line[9] = rateAt(flow.date, flow.type === 'Fee');
      rows.push(line);
    }

    const closing = fund.valuations[fund.valuations.length - 1];
    if (closing) {
      rows.push([
        fund.key, periodEndDate(closing.period), 'Net Asset Value',
        null, null, null, closing.nav, null, null, ...(quote ? [null] : []),
      ]);
    }
  }

  return { sheetName: '40 LEDGER', rows };
}

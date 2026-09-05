/**
 * Reading an advisory monitoring workbook.
 *
 * The fixture has the shape of a real one with invented funds and properties.
 * What is pinned is the handful of judgements the workbook does not state, and
 * every one of them is a place where a plausible wrong answer is available:
 * that the capital account is the valuation rather than something to derive,
 * that a closed quarter derived from the fund's own figures says so, that the
 * adviser's fee belongs to the holder and not to the funds, and above all that
 * the three levels a figure can be reported at are multiplied down rather than
 * added across.
 */

import { describe, expect, it } from 'vitest';
import { isMandateWorkbook, planMandateImport, summariseMandate } from '../src/ingest/mandate';
import { isAllocationWorkbook } from '../src/ingest/allocation';
import { similarity } from '../src/ingest/match';
import { isSupportWorkbook } from '../src/ingest/support';
import type { TableData } from '../src/ingest/types';
import type { Cell } from '../src/ingest/workbook';

const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

/* ------------------------------------------------------------------ *
 * The fixture
 *
 * Two funds, three properties. Fund I: the holder put in 10,000,000 of a
 * 100,000,000 fund, so its share is a tenth; the fund's properties are worth
 * 90,000,000 between them and the vehicle the holder invests through holds
 * 45,000,000 of that, so it holds half. A tenth of a half of 90,000,000 is
 * 4,500,000, and that is the only figure the look-through may produce.
 * ------------------------------------------------------------------ */

const README: Cell[][] = [
  ['SOME ADVISER'],
  [],
  ['Rowan Housing Fund I and II  ·  Northshore Pension Scheme'],
  [],
  ['CONVENTIONS'],
  ['Currency', 'USD throughout, in full dollars — never thousands.'],
];

const CONTROL: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['01  Control and validation'],
  [],
  [null, 'THIS QUARTER'],
  [null, 'Quarter', 'Q2 2024'],
  [null, 'Quarter end', serial('2024-06-30')],
  [null, 'USD/EUR at quarter end (ECB)', null],
  [null, 'Holder share of Fund I REIT LP', 0.1],
  [null, 'Holder share of Fund II REIT LP', 0.05],
  [null, 'Holder commitment, Fund I', 10_000_000],
  [null, 'Holder commitment, Fund II', 5_000_000],
];

const LEDGER_HEADER = [
  'Fund', 'Date', 'Description', 'Commitment', 'Paid-in capital', 'Distributions',
  'Residual value', 'Interest', 'Advisory fees', 'USD/EUR',
];

/** `[fund, date, description, commitment, paid, distribution, residual, interest, fee, fx]` */
const LEDGER: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['40  Cash-flow ledger'],
  [],
  LEDGER_HEADER,
  ['I', serial('2021-01-20'), 'Commitment to Fund', 10_000_000],
  ['I', serial('2021-03-15'), 'Capital call #1', null, -4_000_000, null, null, null, null, 0.92],
  ['I', serial('2021-03-15'), 'Interest-equivalent component paid', null, null, null, null, -50_000, null, 0.92],
  ['I', serial('2021-04-10'), 'Advisory fee (Q1 2021)', null, null, null, null, null, -25_000, 0.93],
  ['I', serial('2022-06-10'), 'Capital call #2', null, -6_000_000, null, null, null, null, 0.95],
  ['I', serial('2022-07-10'), 'Advisory fee (Q2 2022)', null, null, null, null, null, -25_000, 0.96],
  ['I', serial('2023-09-20'), 'Distribution #1', null, null, 500_000],
  ['I', serial('2024-06-30'), 'Net Asset Value', null, null, null, 9_000_000],
  ['II', serial('2023-02-01'), 'Commitment to Fund', 5_000_000],
  ['II', serial('2023-04-05'), 'Capital call #1', null, -1_000_000, null, null, null, null, 0.91],
  ['II', serial('2024-06-30'), 'Net Asset Value', null, null, null, 1_200_000],
  [null, null, 'Total — Fund I'],
];

const REGISTER: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['10  Asset register'],
  [],
  ['ID', 'Asset — report name', 'Fund', 'City', 'State', 'Region', 'Tenant type', 'Units', 'Acquisition'],
  ['A1', 'Rowan Court', 'I', 'Denver', 'CO', 'West', '', 100, serial('2021-04-01')],
  ['A2', 'Alder Place', 'I', 'Chicago', 'IL', 'Midwest', '', 50, serial('2022-07-01')],
  ['B1', 'Birch Terrace', 'II', 'Boston', 'MA', 'Northeast', '', 40, serial('2023-05-01')],
  [null, 'Total'],
];

const QUARTER_HEADER = [
  'ID', 'Asset', 'Asset FMV\nQ1 2024', 'Asset FMV\nQ2 2024', 'Δ $',
  'Fund equity FV\ngesamt-fund · Q1 2024', 'Fund equity FV\ngesamt-fund · Q2 2024',
  'Cap rate', 'NOI', 'Rehabilitation', 'Invested capital', 'Realised proceeds',
  'Occupancy', 'Principal driver of the change', 'Roof age',
  'Section 8', '<50% AMI', '<60% AMI', '<80% AMI', 'Restricted', 'Market rate',
];

const FOOTNOTE = 'Cap rate, NOI and rehabilitation explain the movement in the asset’s fair '
  + 'market value at 100%, and that is what the “Ties?” column checks.';

const QUARTER_I: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['20  Q2 2024 — Fund I'],
  [],
  QUARTER_HEADER,
  // Ties: 1,000,000 of movement, explained by 400,000 + 600,000.
  ['A1', 'Rowan Court', 20_000_000, 21_000_000, 1_000_000, 58_000_000, 60_000_000,
    400_000, 600_000, 0, 40_000_000, 1_000_000,
    0.95, 'Cap rate held; the lift is operating income.', 12,
    75, 0, 0, 0, 0, 25],
  // Does not tie: 2,000,000 of movement, explained by 200,000.
  ['A2', 'Alder Place', 10_000_000, 12_000_000, 2_000_000, 28_000_000, 30_000_000,
    100_000, 100_000, 0, 25_000_000, 0,
    0.88, 'Reappraised on the new rent roll.', 30,
    50, 0, 0, 0, 0, 0],
  [null, 'Total'],
  [],
  [FOOTNOTE],
];

const QUARTER_II: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['21  Q2 2024 — Fund II'],
  [],
  QUARTER_HEADER,
  ['B1', 'Birch Terrace', 18_000_000, 19_000_000, 1_000_000, 19_000_000, 20_000_000,
    500_000, 500_000, 0, 15_000_000, 0,
    0.91, 'Stabilising after the rehabilitation.', 5,
    40, 0, 0, 0, 0, 0],
  // A property in the quarter that nobody put in the register.
  ['B9', 'Ghost House', 1_000_000, 1_000_000, 0, 1_000_000, 1_000_000],
  [null, 'Total'],
];

const FUND_QUARTER: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['30  Fund level — Q2 2024'],
  [],
  ['Metric', 'Fund I REIT LP\nQ2 2024', 'Fund I REIT LP\nQ1 2024',
    'Fund II REIT LP\nQ2 2024', 'Fund II REIT LP\nQ1 2024'],
  ['Cumulative Paid In Capital', 100_000_000, 100_000_000, 20_000_000, 20_000_000],
  ['Total Portfolio fair value', 45_000_000, 43_000_000, 10_000_000, 9_500_000],
  ['Total Net Asset Value (NAV)', 46_000_000, 44_000_000, 10_400_000, 9_900_000],
];

const FUND_HISTORY: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['35  Fund history'],
  [],
  ['Fund', 'Metric', '2023 Q2', '2023 Q3', '2023 Q4'],
  ['I', 'Cumulative Paid In Capital', 100_000_000, 100_000_000, 100_000_000],
  // The middle quarter repeats the one before it: a figure carried by hand.
  ['I', 'Total Net Asset Value (NAV)', 80_000_000, 80_000_000, 84_000_000],
  ['II', 'Cumulative Paid In Capital', null, 20_000_000, 20_000_000],
  ['II', 'Total Net Asset Value (NAV)', null, 18_000_000, 19_000_000],
];

const ASSET_HISTORY: Cell[][] = [
  ['ADVISORY MONITORING  ·  SUPPORT DATA'],
  ['25  Asset history'],
  [],
  ['ID', 'Fund', 'Asset', 'Metric', '2023 Q4'],
  ['A1', 'I', 'Rowan Court', 'Fund equity at fair value, incl. proceeds', 55_000_000],
  ['A1', 'I', 'Rowan Court', 'Invested capital', 40_000_000],
];

function workbook(overrides: Record<string, Cell[][]> = {}): TableData[] {
  const sheets: Record<string, Cell[][]> = {
    '00 README': README,
    '01 CONTROL': CONTROL,
    '10 ASSETS': REGISTER,
    '20 QUARTER I': QUARTER_I,
    '21 QUARTER II': QUARTER_II,
    '25 ASSET HISTORY': ASSET_HISTORY,
    '30 FUND QUARTER': FUND_QUARTER,
    '35 FUND HISTORY': FUND_HISTORY,
    '40 ADVISER LEDGER': LEDGER,
    ...overrides,
  };
  return Object.entries(sheets).map(([sheetName, rows]) => ({ sheetName, rows }));
}

const plan = () => planMandateImport(workbook(), { vehicleId: 'veh-mandate' });

/* ------------------------------------------------------------------ */

describe('recognising the workbook', () => {
  it('needs a capital-account ledger and a property register', () => {
    expect(isMandateWorkbook(workbook())).toBe(true);
    expect(isMandateWorkbook(workbook({ '40 ADVISER LEDGER': [[]] }))).toBe(false);
    expect(isMandateWorkbook(workbook({ '10 ASSETS': [[]] }))).toBe(false);
  });

  it('is not mistaken for either of the other two workbook shapes', () => {
    expect(isSupportWorkbook(workbook())).toBe(false);
    expect(isAllocationWorkbook(workbook())).toBe(false);
  });

  it('reads what it is about and whose it is from the front matter', () => {
    const summary = summariseMandate(workbook())!;
    expect(summary.fund).toBe('Rowan Housing Fund I and II');
    expect(summary.holder).toBe('Northshore Pension Scheme');
    expect(summary.currency).toBe('USD');
    expect(summary.reportingDate).toBe('2024-06-30');
    expect(summary.holdings).toBe(2);
    expect(summary.companies).toBe(3);
    expect(summary.funds.map((fund) => fund.name))
      .toEqual(['Fund I REIT LP', 'Fund II REIT LP']);
    expect(summary.funds[0].commitment).toBe(10_000_000);
    expect(summary.funds[0].share).toBe(0.1);
  });
});

describe('finding the product it belongs to', () => {
  it('matches on the holder, because the workbook is named after the funds', () => {
    const summary = summariseMandate(workbook())!;
    // What the import screen offers as the default target. The subject line
    // names the funds and matches nothing; the holder names the mandate.
    expect(similarity(summary.holder, 'Northshore Pension Scheme mandate'))
      .toBeGreaterThan(0.5);
    expect(similarity(summary.fund, 'Northshore Pension Scheme mandate'))
      .toBeLessThan(0.5);
  });
});

describe('the funds the mandate holds', () => {
  it('carries the holder’s share of each, which is not a share of the properties', () => {
    const positions = plan().positions;
    expect(positions).toHaveLength(2);
    expect(positions[0].ownership).toBe(0.1);
    expect(positions[1].ownership).toBe(0.05);
    expect(positions[0].commitment).toBe(10_000_000);
    expect(positions[0].commitmentDate).toBe('2021-01-20');
    expect(positions[0].vintage).toBe(2021);
    expect(positions[0].region).toBe('United States');
  });
});

describe('what the mandate is worth', () => {
  const read = () => {
    const built = plan();
    const first = built.positions[0].id;
    return built.valuations
      .filter((valuation) => valuation.positionId === first)
      .sort((a, b) => a.period.localeCompare(b.period));
  };

  it('takes the closing quarter from the capital account rather than deriving it', () => {
    const closing = read().find((valuation) => valuation.period === '2024Q2')!;
    expect(closing.nav).toBe(9_000_000);
    expect(closing.source).toContain('Northshore Pension Scheme');
    expect(closing.drawnCumulative).toBe(10_000_000);
    expect(closing.distributedCumulative).toBe(500_000);
  });

  it('derives a closed quarter at the share the paid-in capital represented, and says so', () => {
    // 80,000,000 of fund net asset value, of which the holder had paid in
    // 10,000,000 of 100,000,000.
    const earlier = read().find((valuation) => valuation.period === '2023Q2')!;
    expect(earlier.nav).toBe(8_000_000);
    expect(earlier.source).toContain('derived');
  });

  it('names a valuation that was carried forward rather than reported', () => {
    expect(plan().notes.some((note) =>
      /Fund I REIT LP: net asset value is unchanged from 2023Q2 to 2023Q3/.test(note))).toBe(true);
  });
});

describe('the ledger', () => {
  const flows = () => plan().cashflows;

  it('keeps the holder’s own signs: capital out negative, money back positive', () => {
    const calls = flows().filter((flow) => flow.type === 'Capital Call');
    expect(calls.reduce((sum, flow) => sum + flow.amount, 0)).toBe(-11_000_000);
    expect(calls.every((flow) => flow.affectsCommitment)).toBe(true);
    const distributions = flows().filter((flow) => flow.type === 'Distribution');
    expect(distributions.reduce((sum, flow) => sum + flow.amount, 0)).toBe(500_000);
  });

  it('files the adviser’s fee against the holder and never against the funds', () => {
    const fees = flows().filter((flow) => flow.type === 'Fee');
    expect(fees).toHaveLength(2);
    expect(fees.every((fee) => fee.investorId && !fee.positionId)).toBe(true);
    expect(fees.reduce((sum, fee) => sum + fee.amount, 0)).toBe(-50_000);
  });

  it('files true-up interest as a flow with the fund, outside the commitment', () => {
    const equalisation = flows().filter((flow) => flow.type === 'Equalisation');
    expect(equalisation).toHaveLength(1);
    expect(equalisation[0].positionId).toBeTruthy();
    expect(equalisation[0].affectsCommitment).toBe(false);
  });

  it('reads the rate pair from the column heading, whatever the pair is', () => {
    const rates = plan().fxRates;
    expect(rates.every((rate) => rate.base === 'USD' && rate.quote === 'EUR')).toBe(true);
    // The fee invoice is converted at the quarter's average, every other line
    // at the rate of its own date.
    expect(rates.find((rate) => rate.date === '2021-04-10')?.kind).toBe('average');
    expect(rates.find((rate) => rate.date === '2021-03-15')?.kind).toBe('closing');
  });

  it('reports a flow with no rate, and a closing valuation with none either', () => {
    const problems = plan().problems.join(' ');
    expect(problems).toContain('Distribution #1');
    expect(problems).toContain('cannot be restated in EUR');
  });

  it('records the holder as the one investor, committed to both funds', () => {
    const investors = plan().investors;
    expect(investors).toHaveLength(1);
    expect(investors[0].name).toBe('Northshore Pension Scheme');
    expect(investors[0].commitment).toBe(15_000_000);
    expect(investors[0].entryDate).toBe('2021-01-20');
  });
});

describe('the properties inside the funds', () => {
  it('multiplies the two levels down instead of adding across them', () => {
    const built = plan();
    const position = built.positions[0];
    const exposure = built.assets
      .filter((asset) => asset.positionId === position.id)
      .reduce((sum, asset) => {
        const filed = built.assetValuations
          .find((v) => v.assetId === asset.id && v.period === '2024Q2');
        return sum + (filed?.unrealised ?? 0) * asset.ownership * position.ownership;
      }, 0);
    // 90,000,000 at 100% of the fund, of which the vehicle holds half, of
    // which the holder has a tenth.
    expect(exposure).toBeCloseTo(4_500_000, 6);
  });

  it('states the level each figure was reported at rather than flattening it', () => {
    const built = plan();
    expect(built.assets[0].ownership).toBeCloseTo(0.5, 6);
    expect(built.assetValuations[0].source).toContain('at 100% of the fund');
    expect(built.notes.some((note) =>
      /Fund I REIT LP: the properties are reported at 100%/.test(note))).toBe(true);
  });

  it('turns the affordability bands into the split a property is let under', () => {
    const rowan = plan().assets.find((asset) => asset.name === 'Rowan Court')!;
    expect(rowan.sector).toEqual({ 'Section 8': 0.75, 'Market rate': 0.25 });
    const alder = plan().assets.find((asset) => asset.name === 'Alder Place')!;
    expect(alder.sector).toEqual({ 'Section 8': 1 });
  });

  it('keeps the closed quarters a property already has', () => {
    const built = plan();
    const rowan = built.assets.find((asset) => asset.name === 'Rowan Court')!;
    const filed = built.assetValuations
      .filter((valuation) => valuation.assetId === rowan.id)
      .map((valuation) => valuation.period)
      .sort();
    expect(filed).toEqual(['2023Q4', '2024Q2']);
  });

  it('names a movement in value the workbook’s own components do not explain', () => {
    expect(plan().problems.some((problem) =>
      /whose movement in value is not explained/.test(problem) && /Alder Place/.test(problem)))
      .toBe(true);
    expect(plan().problems.some((problem) => /Rowan Court/.test(problem))).toBe(false);
  });

  it('names a property the quarter reports that the register does not have', () => {
    expect(plan().problems.some((problem) => /"B9" is not in the register/.test(problem)))
      .toBe(true);
  });

  it('does not read the sheet’s own footnote as a property', () => {
    expect(plan().assets.map((asset) => asset.id)).toHaveLength(3);
    expect(plan().problems.join(' ')).not.toContain('Ties?');
  });
});

describe('what the manager reports beside the valuation', () => {
  const of = (id: string, metric: string) => plan().metrics
    .find((m) => m.scope.id.endsWith(id) && m.metric === metric && m.period === '2024Q2');

  it('keeps the figures nothing computed depends on', () => {
    expect(of('a1', 'operations.occupancy')?.value).toBe(0.95);
    expect(of('a1', 'value.capRate')?.value).toBe(400_000);
    expect(of('a1', 'value.netOperatingIncome')?.value).toBe(600_000);
    expect(of('a1', 'units.section8')?.value).toBe(75);
    expect(of('a1', 'units.marketRate')?.value).toBe(25);
  });

  it('keeps what was written as text rather than losing it to a number field', () => {
    const driver = of('a1', 'narrative.driver')!;
    expect(driver.text).toBe('Cap rate held; the lift is operating income.');
    expect(driver.value).toBeUndefined();
  });

  it('measures a paired column once per quarter it is headed with', () => {
    const fmv = plan().metrics
      .filter((m) => m.scope.id.endsWith('a1') && m.metric === 'value.fairMarketValue')
      .sort((a, b) => a.period.localeCompare(b.period));
    expect(fmv.map((m) => [m.period, m.value]))
      .toEqual([['2024Q1', 20_000_000], ['2024Q2', 21_000_000]]);
  });

  it('keeps a column nobody mapped rather than dropping it, and says it did', () => {
    expect(of('a1', 'reported.roofAge')?.value).toBe(12);
    expect(plan().notes.some((note) => /not ones this reader knows by name/.test(note)))
      .toBe(true);
  });

  it('does not keep a difference between two figures it already has', () => {
    expect(plan().metrics.some((m) => /δ|delta/i.test(m.metric))).toBe(false);
  });

  it('keeps the manager’s own fund figures against the fund, not the properties', () => {
    const nav = plan().metrics.find((m) =>
      m.metric === 'fund.totalNetAssetValueNav' && m.period === '2024Q2'
      && m.scope.id === plan().positions[0].id);
    expect(nav?.scope.kind).toBe('position');
    expect(nav?.value).toBe(46_000_000);
    // The engine's own figure for the same quarter is the capital account, and
    // is deliberately a different number from the manager's fund-level one.
    expect(plan().valuations.find((v) =>
      v.positionId === plan().positions[0].id && v.period === '2024Q2')?.nav).toBe(9_000_000);
  });

  it('does not keep as a metric what is already a fact', () => {
    const names = new Set(plan().metrics.map((m) => m.metric));
    expect(names.has('reported.investedCapital')).toBe(false);
    expect(names.has('reported.realisedProceeds')).toBe(false);
    expect(names.has('reported.fundEquityFv')).toBe(false);
  });
});

describe('what a mandate does not have', () => {
  it('files no balance sheet, because there is no vehicle of the adviser’s own', () => {
    expect(plan().balanceSheets).toEqual([]);
    expect(plan().notes.some((note) => /An adviser runs no vehicle/.test(note))).toBe(true);
  });
});

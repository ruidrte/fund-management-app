/**
 * Demo dataset.
 *
 * Runs the whole application with no backend, and doubles as the fixture the
 * engine tests assert against. It is deliberately awkward in the ways real data
 * is awkward: two clients, a fund-of-funds and a direct fund, three currencies,
 * a latest quarter where a third of the portfolio has not reported, and a prior
 * quarter that was restated after publication. A clean fixture would prove
 * nothing about the parts of the engine that exist to handle mess.
 */

import { DEFAULT_CONVENTIONS, type Cashflow, type DataSet, type FxRate } from '../domain/types';
import { periodEndDate, periodRange, type PeriodId } from '../domain/period';

const PERIODS: PeriodId[] = periodRange('2024Q1', '2026Q1');
const LATEST: PeriodId = '2026Q1';

/** Everything known before the latest quarter's close. */
const EARLY = '2026-01-15T09:00:00Z';
/** The instant the Q1 2026 draft was first assembled. */
const DRAFT_CUT = '2026-04-20T09:00:00Z';
/** Late arrivals, after the draft went out. */
const LATE = '2026-05-28T09:00:00Z';

function recordedFor(period: PeriodId): string {
  // Facts are recorded about six weeks after the quarter they describe.
  const end = new Date(periodEndDate(period));
  end.setUTCDate(end.getUTCDate() + 42);
  return `${end.toISOString().slice(0, 10)}T09:00:00Z`;
}

let sequence = 0;
const id = (prefix: string) => `${prefix}-${String((sequence += 1)).padStart(4, '0')}`;

/* ------------------------------------------------------------------ *
 * FX — EUR base, quarterly closing and average rates
 * ------------------------------------------------------------------ */

const USD_CLOSING: Record<string, number> = {
  '2024Q1': 1.0810, '2024Q2': 1.0710, '2024Q3': 1.1180, '2024Q4': 1.0350,
  '2025Q1': 1.0820, '2025Q2': 1.1720, '2025Q3': 1.1740, '2025Q4': 1.1750,
  '2026Q1': 1.1498,
};

const GBP_CLOSING: Record<string, number> = {
  '2024Q1': 0.8550, '2024Q2': 0.8470, '2024Q3': 0.8330, '2024Q4': 0.8280,
  '2025Q1': 0.8360, '2025Q2': 0.8550, '2025Q3': 0.8720, '2025Q4': 0.8790,
  '2026Q1': 0.8635,
};

function fxRates(): FxRate[] {
  const rows: FxRate[] = [];
  for (const period of PERIODS) {
    const recordedAt = recordedFor(period);
    const date = periodEndDate(period);
    for (const [quote, table] of [['USD', USD_CLOSING], ['GBP', GBP_CLOSING]] as const) {
      rows.push({
        id: id('fx'), base: 'EUR', quote, rate: table[period], date, period,
        recordedAt, kind: 'closing', source: 'ECB',
      });
      // The average sits between this quarter's close and the last one.
      const index = PERIODS.indexOf(period);
      const previous = index > 0 ? table[PERIODS[index - 1]] : table[period];
      rows.push({
        id: id('fx'), base: 'EUR', quote, rate: (table[period] + previous) / 2,
        date, period, recordedAt, kind: 'average', source: 'ECB',
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Client A — Meridian Capital, a EUR fund-of-funds
 * ------------------------------------------------------------------ */

interface PositionSeed {
  id: string;
  name: string;
  manager: string;
  currency: string;
  vintage: number;
  commitment: number;
  ownership: number;
  assetClass: string;
  subAssetClass: string;
  region: string;
  kind: 'fund' | 'direct-investment' | 'co-investment' | 'secondary';
  /** Opening NAV in local currency at 2024Q1, and the quarterly growth applied. */
  openingNav: number;
  quarterlyGrowth: number;
  /**
   * Capital drawn before the series starts, which is what built `openingNav`.
   * Without it the multiples and IRR see a large NAV against almost no paid-in
   * capital and come out at several hundred percent.
   */
  inceptionCall?: number;
  /** Quarters for which no valuation is filed — the draft calculation's job. */
  silentPeriods?: PeriodId[];
  callSchedule: Partial<Record<PeriodId, number>>;
  distributionSchedule?: Partial<Record<PeriodId, number>>;
}

const FOF_POSITIONS: PositionSeed[] = [
  {
    id: 'pos-nordic-growth', name: 'Nordic Growth Partners IV', manager: 'Nordic Growth',
    currency: 'EUR', vintage: 2021, commitment: 15_000, ownership: 0.042,
    assetClass: 'Private Equity', subAssetClass: 'Growth', region: 'Europe', kind: 'fund',
    openingNav: 8_200, quarterlyGrowth: 0.028,
    inceptionCall: 6724,
    callSchedule: { '2024Q2': 1_200, '2024Q4': 900, '2025Q2': 1_100, '2025Q4': 800, '2026Q1': 600 },
    distributionSchedule: { '2025Q3': 1_400, '2026Q1': 900 },
  },
  {
    id: 'pos-atlantic-buyout', name: 'Atlantic Buyout Fund VII', manager: 'Atlantic Partners',
    currency: 'USD', vintage: 2020, commitment: 18_000, ownership: 0.031,
    assetClass: 'Private Equity', subAssetClass: 'Buyout', region: 'North America', kind: 'fund',
    openingNav: 11_400, quarterlyGrowth: 0.021,
    inceptionCall: 9348,
    callSchedule: { '2024Q1': 1_500, '2024Q3': 1_100, '2025Q1': 900, '2025Q3': 700 },
    distributionSchedule: { '2024Q4': 2_100, '2025Q4': 2_600, '2026Q1': 1_200 },
  },
  {
    id: 'pos-helios-infra', name: 'Helios Infrastructure II', manager: 'Helios Capital',
    currency: 'EUR', vintage: 2022, commitment: 12_000, ownership: 0.055,
    assetClass: 'Real Assets', subAssetClass: 'Infrastructure', region: 'Europe', kind: 'fund',
    openingNav: 4_100, quarterlyGrowth: 0.018,
    inceptionCall: 3362,
    callSchedule: { '2024Q2': 900, '2024Q4': 1_100, '2025Q2': 1_300, '2025Q4': 900, '2026Q1': 700 },
  },
  {
    id: 'pos-thames-venture', name: 'Thames Venture Fund III', manager: 'Thames Ventures',
    currency: 'GBP', vintage: 2021, commitment: 8_000, ownership: 0.068,
    assetClass: 'Private Equity', subAssetClass: 'Early (VC)', region: 'Europe', kind: 'fund',
    openingNav: 3_600, quarterlyGrowth: 0.034,
    inceptionCall: 2952,
    // Venture managers file late. Q1 2026 is missing at the draft date.
    silentPeriods: ['2026Q1'],
    callSchedule: { '2024Q1': 600, '2024Q3': 700, '2025Q1': 800, '2025Q3': 600, '2026Q1': 400 },
  },
  {
    id: 'pos-iberia-realestate', name: 'Iberia Real Estate Partners', manager: 'Iberia RE',
    currency: 'EUR', vintage: 2023, commitment: 9_000, ownership: 0.075,
    assetClass: 'Real Assets', subAssetClass: 'Real Estate', region: 'Europe', kind: 'fund',
    openingNav: 1_800, quarterlyGrowth: 0.012,
    inceptionCall: 1476,
    silentPeriods: ['2026Q1'],
    callSchedule: { '2024Q2': 700, '2024Q4': 800, '2025Q2': 900, '2025Q4': 1_000, '2026Q1': 500 },
  },
  {
    id: 'pos-cascade-secondary', name: 'Cascade Secondaries 2024', manager: 'Cascade',
    currency: 'USD', vintage: 2024, commitment: 10_000, ownership: 0.028,
    assetClass: 'Private Equity', subAssetClass: 'Buyout', region: 'Global', kind: 'secondary',
    openingNav: 0, quarterlyGrowth: 0.026,
    callSchedule: { '2024Q3': 1_800, '2025Q1': 1_400, '2025Q3': 1_200, '2026Q1': 900 },
    distributionSchedule: { '2026Q1': 400 },
  },
  {
    id: 'pos-verdant-nature', name: 'Verdant Nature-Based Fund I', manager: 'Verdant',
    currency: 'EUR', vintage: 2023, commitment: 6_000, ownership: 0.090,
    assetClass: 'Real Assets', subAssetClass: 'Nature-based', region: 'Global', kind: 'fund',
    openingNav: 900, quarterlyGrowth: 0.015,
    inceptionCall: 738,
    callSchedule: { '2024Q3': 600, '2025Q1': 700, '2025Q3': 800, '2026Q1': 500 },
  },
];

/* ------------------------------------------------------------------ *
 * Client B — Aurora Direct, a USD direct fund
 * ------------------------------------------------------------------ */

const DIRECT_POSITIONS: PositionSeed[] = [
  {
    id: 'pos-lumen-systems', name: 'Lumen Systems', manager: 'Aurora Direct',
    currency: 'USD', vintage: 2022, commitment: 14_000, ownership: 0.34,
    assetClass: 'Private Equity', subAssetClass: 'Growth', region: 'North America',
    kind: 'direct-investment',
    openingNav: 12_800, quarterlyGrowth: 0.031,
    callSchedule: { '2024Q1': 14_000 },
  },
  {
    id: 'pos-harbourline', name: 'Harbourline Logistics', manager: 'Aurora Direct',
    currency: 'EUR', vintage: 2023, commitment: 9_500, ownership: 0.51,
    assetClass: 'Real Assets', subAssetClass: 'Infrastructure', region: 'Europe',
    kind: 'direct-investment',
    openingNav: 8_900, quarterlyGrowth: 0.017,
    callSchedule: { '2024Q1': 9_500 },
    distributionSchedule: { '2025Q2': 700, '2026Q1': 500 },
  },
  {
    id: 'pos-kestrel-health', name: 'Kestrel Health Group', manager: 'Aurora Direct',
    currency: 'USD', vintage: 2024, commitment: 11_000, ownership: 0.28,
    assetClass: 'Private Equity', subAssetClass: 'Buyout', region: 'North America',
    kind: 'direct-investment',
    openingNav: 0, quarterlyGrowth: 0.024,
    silentPeriods: ['2026Q1'],
    callSchedule: { '2024Q2': 6_000, '2025Q1': 3_000, '2025Q4': 2_000 },
  },
];

const SECTORS = ['Technology', 'Healthcare', 'Industrials', 'Consumer', 'Financials', 'Energy Transition'];
const COUNTRIES = ['Germany', 'France', 'United States', 'United Kingdom', 'Netherlands', 'Sweden', 'Spain'];

export function buildDemoDataSet(clientId: string): DataSet {
  sequence = 0;
  return clientId === 'client-aurora' ? auroraDataSet() : meridianDataSet();
}

export const DEMO_CLIENTS = [
  { id: 'client-meridian', name: 'Meridian Capital Partners', shortName: 'Meridian' },
  { id: 'client-aurora', name: 'Aurora Direct Investments', shortName: 'Aurora' },
];

function meridianDataSet(): DataSet {
  const clientId = 'client-meridian';
  const vehicleId = 'veh-meridian-pf-ii';

  const built = buildPortfolio(FOF_POSITIONS, vehicleId, 'fund');

  return {
    client: {
      id: clientId,
      name: 'Meridian Capital Partners',
      shortName: 'Meridian',
      reportingCurrency: 'EUR',
      conventions: DEFAULT_CONVENTIONS,
    },
    vehicles: [{
      id: vehicleId,
      clientId,
      kind: 'fund-of-funds',
      name: 'Meridian Private Markets Fund II',
      shortName: 'MPMF II',
      currency: 'EUR',
      inceptionDate: '2021-03-31',
      investorCommitment: 72_000,
      manager: 'Meridian Capital Partners',
      administrator: 'Northgate Fund Services',
      domicile: 'Luxembourg',
      status: 'Investing',
      conventions: DEFAULT_CONVENTIONS,
    }],
    positions: built.positions,
    assets: built.assets,
    assetValuations: built.assetValuations,
    positionValuations: built.valuations,
    cashflows: [
      ...built.cashflows,
      ...investorCashflows(vehicleId, meridianInvestors(vehicleId), built.cashflows, 'EUR'),
    ],
    investors: meridianInvestors(vehicleId),
    balanceSheets: balanceSheets(vehicleId, 'EUR', 1_450, 320, 210),
    fxRates: fxRates(),
    esgMetrics: [],
  };
}

function auroraDataSet(): DataSet {
  const clientId = 'client-aurora';
  const vehicleId = 'veh-aurora-opportunities';

  const built = buildPortfolio(DIRECT_POSITIONS, vehicleId, 'direct');

  return {
    client: {
      id: clientId,
      name: 'Aurora Direct Investments',
      shortName: 'Aurora',
      reportingCurrency: 'USD',
      conventions: DEFAULT_CONVENTIONS,
    },
    vehicles: [{
      id: vehicleId,
      clientId,
      kind: 'direct-fund',
      name: 'Aurora Opportunities Fund I',
      shortName: 'AOF I',
      currency: 'USD',
      inceptionDate: '2022-06-30',
      investorCommitment: 38_000,
      manager: 'Aurora Direct Investments',
      administrator: 'Northgate Fund Services',
      domicile: 'Delaware',
      status: 'Investing',
      conventions: DEFAULT_CONVENTIONS,
    }],
    positions: built.positions,
    assets: built.assets,
    assetValuations: built.assetValuations,
    positionValuations: built.valuations,
    cashflows: [
      ...built.cashflows,
      ...investorCashflows(vehicleId, auroraInvestors(vehicleId), built.cashflows, 'USD'),
    ],
    investors: auroraInvestors(vehicleId),
    balanceSheets: balanceSheets(vehicleId, 'USD', 980, 140, 95),
    fxRates: fxRates(),
    esgMetrics: [],
  };
}

function buildPortfolio(seeds: PositionSeed[], vehicleId: string, mode: 'fund' | 'direct') {
  const positions: DataSet['positions'] = [];
  const valuations: DataSet['positionValuations'] = [];
  const cashflows: Cashflow[] = [];
  const assets: DataSet['assets'] = [];
  const assetValuations: DataSet['assetValuations'] = [];

  seeds.forEach((seed, seedIndex) => {
    positions.push({
      id: seed.id,
      vehicleId,
      kind: seed.kind,
      name: seed.name,
      manager: seed.manager,
      currency: seed.currency,
      vintage: seed.vintage,
      commitmentDate: `${seed.vintage}-06-30`,
      investmentPeriodEnd: `${seed.vintage + 5}-06-30`,
      commitment: seed.commitment,
      ownership: seed.ownership,
      assetClass: seed.assetClass,
      subAssetClass: seed.subAssetClass,
      region: seed.region,
      status: 'Investing',
      esg: { sfdr: seedIndex % 3 === 0 ? 'Article 9' : 'Article 8' },
    });

    // Cashflows first — the valuation series has to be consistent with them.
    if (seed.inceptionCall) {
      const date = `${seed.vintage}-09-30`;
      cashflows.push({
        id: id('cf'), positionId: seed.id, vehicleId, type: 'Capital Call',
        amount: -seed.inceptionCall, currency: seed.currency,
        date, period: `${seed.vintage}Q3`, recordedAt: `${seed.vintage}-11-15T09:00:00Z`,
        affectsCommitment: true, status: 'Settled',
        description: `Capital drawn to inception — ${seed.name}`,
      });
    }

    for (const period of PERIODS) {
      const call = seed.callSchedule[period];
      if (call) {
        cashflows.push({
          id: id('cf'), positionId: seed.id, vehicleId, type: 'Capital Call',
          amount: -call, currency: seed.currency,
          date: periodEndDate(period), period, recordedAt: recordedFor(period),
          affectsCommitment: true, status: 'Settled',
          description: `Capital call — ${seed.name}`,
        });
      }
      const distribution = seed.distributionSchedule?.[period];
      if (distribution) {
        cashflows.push({
          id: id('cf'), positionId: seed.id, vehicleId, type: 'Distribution',
          amount: distribution, currency: seed.currency,
          date: periodEndDate(period), period, recordedAt: recordedFor(period),
          affectsCommitment: false, recallable: period.endsWith('Q4'), status: 'Settled',
          description: `Distribution — ${seed.name}`,
        });
      }
    }

    // NAV series: prior NAV, plus the quarter's net capital, grown.
    let nav = seed.openingNav;
    for (const period of PERIODS) {
      const call = seed.callSchedule[period] ?? 0;
      const distribution = seed.distributionSchedule?.[period] ?? 0;
      nav = (nav + call - distribution) * (1 + seed.quarterlyGrowth);

      if (seed.silentPeriods?.includes(period)) continue;

      const restated = period === '2025Q4' && seedIndex === 1;
      valuations.push({
        id: id('val'), positionId: seed.id, period,
        recordedAt: recordedFor(period),
        nav: restated ? Math.round(nav * 0.97 * 100) / 100 : Math.round(nav * 100) / 100,
        source: mode === 'fund' ? 'GP quarterly report' : 'Internal valuation',
        supersededBy: restated ? 'restated' : undefined,
      });

      // One position was restated after the quarter was published. Both rows
      // stay, so a point-in-time view of the original filing still works.
      if (restated) {
        valuations.push({
          id: 'restated', positionId: seed.id, period,
          recordedAt: LATE,
          nav: Math.round(nav * 100) / 100,
          source: 'GP restated report',
        });
      }
    }

    // Look-through assets — three per underlying fund, one per direct holding.
    //
    // The vehicle's economic exposure to an asset is its total value scaled by
    // the position's stake and then by the vehicle's stake in the position. So
    // the total value stored here is grossed back up through both, which is
    // what makes the look-through breakdown reconcile to the portfolio NAV
    // rather than landing two orders of magnitude below it.
    const splits = mode === 'direct' ? [1] : [0.42, 0.33, 0.25];
    const assetOwnerships = mode === 'direct' ? [1] : [0.6, 0.45, 0.8];
    for (let i = 0; i < splits.length; i += 1) {
      const assetId = `${seed.id}-asset-${i + 1}`;
      assets.push({
        id: assetId,
        positionId: seed.id,
        name: mode === 'direct' ? seed.name : `${seed.name.split(' ')[0]} Holding ${i + 1}`,
        currency: seed.currency,
        investmentDate: `${seed.vintage + 1}-03-31`,
        ownership: assetOwnerships[i],
        assetClass: seed.assetClass,
        subAssetClass: seed.subAssetClass,
        sector: i === 0
          ? { [SECTORS[(seedIndex + i) % SECTORS.length]]: 0.7, [SECTORS[(seedIndex + i + 2) % SECTORS.length]]: 0.3 }
          : SECTORS[(seedIndex + i) % SECTORS.length],
        region: seed.region,
        country: COUNTRIES[(seedIndex * 2 + i) % COUNTRIES.length],
        status: 'Held',
      });

      const grossUp = assetOwnerships[i] * seed.ownership;
      // Assets carry the same cashflows and growth as the position, split by
      // their share of it, then grossed back up through both ownership layers.
      // They still land below the position NAV — undeployed capital and
      // fund-level cash sit outside the asset detail — which is the gap the
      // exposure card reports rather than hides.
      let assetNav = (seed.openingNav * splits[i]) / (grossUp || 1);
      for (const period of PERIODS) {
        const call = (seed.callSchedule[period] ?? 0) * splits[i] / (grossUp || 1);
        const distribution = (seed.distributionSchedule?.[period] ?? 0) * splits[i] / (grossUp || 1);
        assetNav = (assetNav + call - distribution) * (1 + seed.quarterlyGrowth);
        if (seed.silentPeriods?.includes(period)) continue;
        assetValuations.push({
          id: id('aval'), assetId, period, recordedAt: recordedFor(period),
          invested: Math.round(assetNav * 0.78 * 100) / 100,
          realised: Math.round(assetNav * 0.12 * 100) / 100,
          // Only part of a fund's value is traceable to named assets.
          unrealised: Math.round(assetNav * 0.88 * 100) / 100,
          source: 'GP portfolio report',
        });
      }
    }
  });

  return { positions, valuations, cashflows, assets, assetValuations };
}

function meridianInvestors(vehicleId: string): DataSet['investors'] {
  return [
    { id: 'inv-pension-nord', vehicleId, name: 'Nordland Pension Fund', type: 'Institution', country: 'Sweden', currency: 'EUR', commitment: 30_000, entryDate: '2021-03-31' },
    { id: 'inv-stiftung', vehicleId, name: 'Weiss Familienstiftung', type: 'Family Office', country: 'Switzerland', currency: 'EUR', commitment: 18_000, entryDate: '2021-03-31' },
    { id: 'inv-mutual', vehicleId, name: 'Continental Mutual', type: 'Institution', country: 'Netherlands', currency: 'EUR', commitment: 15_000, entryDate: '2021-09-30' },
    { id: 'inv-private', vehicleId, name: 'Private Clients Feeder', type: 'Feeder', country: 'Luxembourg', currency: 'EUR', commitment: 9_000, entryDate: '2022-03-31' },
  ];
}

function auroraInvestors(vehicleId: string): DataSet['investors'] {
  return [
    { id: 'inv-endowment', vehicleId, name: 'Cedar Ridge Endowment', type: 'Institution', country: 'United States', currency: 'USD', commitment: 22_000, entryDate: '2022-06-30' },
    { id: 'inv-sponsor', vehicleId, name: 'Aurora Sponsor Commitment', type: 'Seed', country: 'United States', currency: 'USD', commitment: 6_000, entryDate: '2022-06-30' },
    { id: 'inv-office', vehicleId, name: 'Halston Family Office', type: 'Family Office', country: 'United States', currency: 'USD', commitment: 10_000, entryDate: '2022-12-31' },
  ];
}

/**
 * Investor-side flows, derived from the portfolio rather than invented.
 *
 * A vehicle calls capital because its portfolio called capital, and distributes
 * because its portfolio distributed. Deriving the investor schedule from the
 * portfolio one keeps the net tier in a believable relationship with the gross
 * tier — an arbitrary schedule produces net multiples several times the gross
 * ones, which is the giveaway that the two sides were never connected.
 *
 * Calls are raised pro rata on commitment, which is what a vehicle without
 * equalisation does, and gives the LP-level engine booked flows to work from
 * rather than an allocation.
 */
function investorCashflows(
  vehicleId: string,
  investors: DataSet['investors'],
  portfolio: Cashflow[],
  vehicleCurrency: string,
): Cashflow[] {
  const total = investors.reduce((sum, i) => sum + i.commitment, 0);
  if (total === 0) return [];

  // Portfolio flows converted into the vehicle's currency at the period close.
  const byPeriod = new Map<PeriodId, { calls: number; distributions: number }>();
  for (const flow of portfolio) {
    const rate = toVehicleRate(flow.currency, vehicleCurrency, flow.period);
    const entry = byPeriod.get(flow.period) ?? { calls: 0, distributions: 0 };
    if (flow.type === 'Capital Call') entry.calls += Math.abs(flow.amount) * rate;
    if (flow.type === 'Distribution') entry.distributions += Math.abs(flow.amount) * rate;
    byPeriod.set(flow.period, entry);
  }

  const rows: Cashflow[] = [];
  // A quarterly management fee on committed capital, drawn alongside the calls.
  const quarterlyFee = (total * 0.0125) / 4;

  for (const period of [...byPeriod.keys()].sort()) {
    const entry = byPeriod.get(period)!;
    const recordedAt = recordedFor(period);
    // The vehicle calls what the portfolio needs plus its running costs, less
    // whatever it received in the same quarter and can recycle.
    const call = Math.max(0, entry.calls + quarterlyFee - entry.distributions * 0.4);
    // Distributions reach investors net of the retained portion.
    const distribution = entry.distributions * 0.6;

    for (const investor of investors) {
      const share = investor.commitment / total;
      if (call > 1) {
        rows.push({
          id: id('icf'), investorId: investor.id, vehicleId, type: 'Capital Call',
          amount: Math.round(call * share * 100) / 100, currency: investor.currency,
          date: periodEndDate(period), period, recordedAt,
          affectsCommitment: true, status: 'Settled',
          description: 'Investor capital call',
        });
      }
      if (distribution > 1) {
        rows.push({
          id: id('icf'), investorId: investor.id, vehicleId, type: 'Distribution',
          amount: -Math.round(distribution * share * 100) / 100, currency: investor.currency,
          date: periodEndDate(period), period, recordedAt,
          affectsCommitment: false, status: 'Settled',
          description: 'Investor distribution',
        });
      }
    }

    rows.push({
      id: id('fee'), vehicleId, type: 'Fee',
      amount: -Math.round(quarterlyFee * 100) / 100, currency: vehicleCurrency,
      date: periodEndDate(period), period, recordedAt,
      affectsCommitment: false, status: 'Settled',
      description: 'Management fee',
    });
  }

  return rows;
}

/**
 * Closing rate into the vehicle currency, falling back to the nearest quarter
 * the tables cover — the demo's series starts in 2024 but inception calls sit
 * before it.
 */
function toVehicleRate(from: string, to: string, period: PeriodId): number {
  if (from === to) return 1;
  const table = (ccy: string) => (ccy === 'USD' ? USD_CLOSING : ccy === 'GBP' ? GBP_CLOSING : undefined);

  const nearest = (t: Record<string, number>) =>
    t[period] ?? t[PERIODS.find((p) => p >= period) ?? PERIODS[0]] ?? 1;

  // Rates are quoted as 1 EUR = X foreign, so a foreign amount divides.
  const fromTable = table(from);
  const toTable = table(to);
  const fromInEur = fromTable ? 1 / nearest(fromTable) : 1;
  const eurInTo = toTable ? nearest(toTable) : 1;
  return fromInEur * eurInTo;
}

function balanceSheets(
  vehicleId: string, currency: string,
  cash: number, otherAssets: number, liabilities: number,
): DataSet['balanceSheets'] {
  return PERIODS.map((period, index) => ({
    vehicleId,
    period,
    // The latest quarter's balance sheet lands with the draft, not before.
    recordedAt: period === LATEST ? DRAFT_CUT : recordedFor(period),
    cash: Math.round((cash + index * 45) * 100) / 100,
    otherAssets: Math.round((otherAssets - index * 8) * 100) / 100,
    currentLiabilities: Math.round((liabilities + index * 6) * 100) / 100,
    accruedExpenses: Math.round((liabilities * 0.6 + index * 4) * 100) / 100,
    source: `${currency} administrator statement`,
  }));
}

export const DEMO_TIMELINE = { EARLY, DRAFT_CUT, LATE, LATEST, PERIODS };

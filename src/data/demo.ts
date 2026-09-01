/**
 * Sample dataset.
 *
 * The **structure** is real: three clients and the seven vehicles they run.
 * Every **figure** is synthetic, and so is every holding name — commitments,
 * valuations, cashflows and investors are invented to exercise the engine, not
 * taken from any fund's records.
 *
 * That split is deliberate. Real vehicle names make the application recognisable
 * to the people who will use it; invented figures make it impossible for a
 * screenshot to be mistaken for a report. Loading the real numbers is what the
 * intake pipeline is for.
 *
 * The data is deliberately awkward in the ways real data is awkward: four
 * currencies, vehicles at different stages of their life, a latest quarter where
 * part of one portfolio has not reported, and a prior quarter restated after
 * publication. A clean fixture would prove nothing about the parts of the engine
 * that exist to handle mess.
 *
 * **Attributes marked `TO CONFIRM` are assumptions.** Vehicle kind, currency,
 * inception and status were inferred from the strategy, not supplied. Correcting
 * them means editing this one table.
 */

import {
  DEFAULT_CONVENTIONS,
  type Cashflow, type CurrencyCode, type DataSet, type FxRate,
  type Investor, type Vehicle,
} from '../domain/types';
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
const id = (prefix: string) => `${prefix}-${String((sequence += 1)).padStart(5, '0')}`;

/* ------------------------------------------------------------------ *
 * FX — EUR base, quarterly closing and average rates
 * ------------------------------------------------------------------ */

const CLOSING: Record<string, Record<string, number>> = {
  USD: {
    '2024Q1': 1.0810, '2024Q2': 1.0710, '2024Q3': 1.1180, '2024Q4': 1.0350,
    '2025Q1': 1.0820, '2025Q2': 1.1720, '2025Q3': 1.1740, '2025Q4': 1.1750,
    '2026Q1': 1.1498,
  },
  GBP: {
    '2024Q1': 0.8550, '2024Q2': 0.8470, '2024Q3': 0.8330, '2024Q4': 0.8280,
    '2025Q1': 0.8360, '2025Q2': 0.8550, '2025Q3': 0.8720, '2025Q4': 0.8790,
    '2026Q1': 0.8635,
  },
  CHF: {
    '2024Q1': 0.9750, '2024Q2': 0.9630, '2024Q3': 0.9420, '2024Q4': 0.9410,
    '2025Q1': 0.9540, '2025Q2': 0.9350, '2025Q3': 0.9330, '2025Q4': 0.9260,
    '2026Q1': 0.9310,
  },
};

/**
 * Quarters where the administrator's financials imply a rate that differs from
 * the published fixing, and by how much in basis points.
 *
 * This is not an error on either side. An administrator translates at the rate
 * its own systems carry, and the reported net asset value has to tie to their
 * statement — so once the trial balance arrives, its rate supersedes the ECB's.
 */
const ADMINISTRATOR_DRIFT: Record<string, Partial<Record<string, number>>> = {
  USD: { '2025Q4': 18, '2026Q1': 22 },
  CHF: { '2025Q4': -9, '2026Q1': 14 },
  GBP: { '2026Q1': -11 },
};

function fxRates(): FxRate[] {
  const rows: FxRate[] = [];
  for (const period of PERIODS) {
    const recordedAt = recordedFor(period);
    const date = periodEndDate(period);

    for (const [quote, table] of Object.entries(CLOSING)) {
      rows.push({
        id: id('fx'), base: 'EUR', quote, rate: table[period], date, period,
        recordedAt, kind: 'closing', source: 'ECB reference rate',
        authority: 'market',
      });
      // The average sits between this quarter's close and the last one.
      const index = PERIODS.indexOf(period);
      const previous = index > 0 ? table[PERIODS[index - 1]] : table[period];
      rows.push({
        id: id('fx'), base: 'EUR', quote, rate: (table[period] + previous) / 2,
        date, period, recordedAt, kind: 'average', source: 'ECB reference rate',
        authority: 'market',
      });

      // The administrator's rate arrives with the trial balance, weeks after
      // the fixing, and supersedes it.
      const drift = ADMINISTRATOR_DRIFT[quote]?.[period];
      if (drift !== undefined) {
        rows.push({
          id: id('fx'), base: 'EUR', quote,
          rate: Math.round(table[period] * (1 + drift / 10_000) * 10_000) / 10_000,
          date, period,
          recordedAt: period === LATEST ? DRAFT_CUT : recordedFor(period),
          kind: 'closing', source: 'Administrator trial balance',
          authority: 'administrator',
        });
      }
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Seeds
 * ------------------------------------------------------------------ */

interface PositionSeed {
  key: string;
  name: string;
  manager: string;
  currency: CurrencyCode;
  vintage: number;
  commitment: number;
  /** Vehicle's share of the position, 0..1. */
  ownership: number;
  assetClass: string;
  subAssetClass: string;
  region: string;
  kind: 'fund' | 'direct-investment' | 'co-investment' | 'secondary';
  /** NAV in local currency at the start of the series, and quarterly growth. */
  openingNav: number;
  quarterlyGrowth: number;
  /** Capital drawn before the series starts, which is what built `openingNav`. */
  inceptionCall?: number;
  /** Quarters with no filed valuation — what the draft calculation is for. */
  silentPeriods?: PeriodId[];
  callSchedule: Partial<Record<PeriodId, number>>;
  distributionSchedule?: Partial<Record<PeriodId, number>>;
  sfdr?: 'Article 6' | 'Article 8' | 'Article 9';
}

interface InvestorSeed {
  name: string;
  type: Investor['type'];
  country: string;
  commitment: number;
  entryDate: string;
}

interface VehicleSeed {
  key: string;
  name: string;
  shortName: string;
  /** TO CONFIRM — inferred from the strategy, not supplied. */
  kind: Vehicle['kind'];
  /** TO CONFIRM. */
  currency: CurrencyCode;
  /** TO CONFIRM. */
  inception: string;
  investorCommitment: number;
  /** TO CONFIRM. */
  status: Vehicle['status'];
  domicile: string;
  administrator: string;
  positions: PositionSeed[];
  investors: InvestorSeed[];
  /** Balance-sheet scale, in the vehicle's currency and units. */
  cash: number;
}

interface ClientSeed {
  key: string;
  name: string;
  shortName: string;
  reportingCurrency: CurrencyCode;
  manager: string;
  vehicles: VehicleSeed[];
}

/* ------------------------------------------------------------------ *
 * Position helpers, to keep the table below readable
 * ------------------------------------------------------------------ */

type Sched = Partial<Record<PeriodId, number>>;

function fund(
  key: string, name: string, manager: string, currency: CurrencyCode,
  vintage: number, commitment: number, subAssetClass: string, region: string,
  openingNav: number, growth: number, calls: Sched, distributions?: Sched,
  extra: Partial<PositionSeed> = {},
): PositionSeed {
  return {
    key, name, manager, currency, vintage, commitment,
    ownership: 0.05, assetClass: assetClassFor(subAssetClass), subAssetClass, region,
    kind: 'fund', openingNav, quarterlyGrowth: growth,
    inceptionCall: openingNav > 0 ? Math.round(openingNav * 0.82) : undefined,
    callSchedule: calls, distributionSchedule: distributions,
    ...extra,
  };
}

/**
 * A holding the vehicle owns a piece of directly — a co-investment beside a
 * sponsor, or an asset held outright. A fund-of-funds holds these alongside its
 * fund commitments; they are not the preserve of a direct fund.
 *
 * It opens at zero and is established by its funding call. An opening NAV on
 * top of a full call would double-count the investment.
 */
function direct(
  key: string, name: string, currency: CurrencyCode, vintage: number,
  commitment: number, subAssetClass: string, region: string,
  growth: number, calls: Sched, distributions?: Sched,
  extra: Partial<PositionSeed> = {},
): PositionSeed {
  return {
    key, name, manager: 'Held directly', currency, vintage, commitment,
    ownership: 0.4, assetClass: assetClassFor(subAssetClass), subAssetClass, region,
    kind: 'direct-investment', openingNav: 0, quarterlyGrowth: growth,
    callSchedule: calls, distributionSchedule: distributions,
    ...extra,
  };
}

/** A co-investment beside a sponsor, alongside the fund commitment to them. */
function coinvest(
  key: string, name: string, sponsor: string, currency: CurrencyCode, vintage: number,
  commitment: number, subAssetClass: string, region: string,
  growth: number, calls: Sched, distributions?: Sched,
  extra: Partial<PositionSeed> = {},
): PositionSeed {
  return direct(key, name, currency, vintage, commitment, subAssetClass, region,
    growth, calls, distributions,
    { kind: 'co-investment', manager: sponsor, ownership: 0.18, ...extra });
}

/** A fund interest bought on the secondary market. */
function secondary(
  key: string, name: string, manager: string, currency: CurrencyCode,
  vintage: number, commitment: number, subAssetClass: string, region: string,
  openingNav: number, growth: number, calls: Sched, distributions?: Sched,
  extra: Partial<PositionSeed> = {},
): PositionSeed {
  return fund(key, name, manager, currency, vintage, commitment, subAssetClass,
    region, openingNav, growth, calls, distributions, { kind: 'secondary', ...extra });
}

function assetClassFor(sub: string): string {
  const realAssets = ['Infrastructure', 'Real Estate', 'Nature-based', 'Energy Transition'];
  return realAssets.includes(sub) ? 'Real Assets' : 'Private Equity';
}

/* ------------------------------------------------------------------ *
 * The clients
 *
 * Holding names below are invented. They describe the kind of thing each
 * vehicle holds; they are not anybody's portfolio.
 * ------------------------------------------------------------------ */

const CLIENTS: ClientSeed[] = [
  {
    key: 'pam',
    name: 'Patrimonium Asset Management',
    shortName: 'PAM',
    reportingCurrency: 'CHF',
    manager: 'Patrimonium Asset Management AG',
    vehicles: [
      {
        key: 'pciof-i',
        name: 'Patrimonium Climate Infrastructure Opportunity Fund I',
        shortName: 'PCIOF I',
        kind: 'fund-of-funds',
        currency: 'EUR',
        inception: '2021-06-30',
        investorCommitment: 180_000,
        status: 'Investing',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
        cash: 3_200,
        positions: [
          fund('nordic-grid', 'Nordic Grid Infrastructure IV', 'Nordic Grid Partners', 'EUR', 2021, 34_000, 'Infrastructure', 'Europe', 19_400, 0.021,
            { '2024Q2': 2_400, '2024Q4': 1_800, '2025Q2': 2_200, '2025Q4': 1_600, '2026Q1': 1_200 },
            { '2025Q3': 2_100, '2026Q1': 1_400 }, { sfdr: 'Article 9' }),
          fund('iberian-solar', 'Iberian Solar Partners II', 'Iberian Renewables', 'EUR', 2022, 28_000, 'Energy Transition', 'Europe', 12_800, 0.024,
            { '2024Q2': 2_100, '2024Q4': 2_400, '2025Q2': 2_600, '2025Q4': 1_900, '2026Q1': 1_400 },
            undefined, { sfdr: 'Article 9' }),
          fund('atlantic-wind', 'Atlantic Offshore Wind Fund III', 'Atlantic Energy', 'GBP', 2021, 26_000, 'Energy Transition', 'Europe', 15_100, 0.018,
            { '2024Q1': 2_200, '2024Q3': 1_700, '2025Q1': 1_500, '2025Q3': 1_300 },
            { '2024Q4': 2_400, '2025Q4': 2_900 }, { sfdr: 'Article 9' }),
          fund('grid-storage', 'Continental Storage & Grid Fund', 'Continental Infra', 'EUR', 2023, 24_000, 'Infrastructure', 'Europe', 6_200, 0.026,
            { '2024Q3': 2_100, '2025Q1': 2_400, '2025Q3': 2_200, '2026Q1': 1_800 },
            undefined, { sfdr: 'Article 8' }),
          fund('circular', 'Circular Economy Infrastructure I', 'Circular Capital', 'EUR', 2023, 18_000, 'Infrastructure', 'Europe', 4_100, 0.019,
            { '2024Q4': 1_900, '2025Q2': 2_100, '2025Q4': 1_700, '2026Q1': 900 },
            undefined, { sfdr: 'Article 9', silentPeriods: [LATEST] }),
          secondary('transatlantic', 'Transatlantic Clean Power Fund (secondary)', 'Meridian Energy', 'USD', 2022, 22_000, 'Energy Transition', 'North America', 9_800, 0.023,
            { '2024Q1': 1_800, '2024Q3': 1_600, '2025Q1': 1_900, '2025Q3': 1_400, '2026Q1': 1_100 },
            { '2026Q1': 800 }, { sfdr: 'Article 8' }),
          coinvest('onshore-wind-co', 'Onshore Wind Portfolio (co-investment)', 'Nordic Grid Partners', 'EUR', 2023, 14_000, 'Energy Transition', 'Europe', 0.020,
            { '2024Q2': 8_000, '2025Q2': 4_000 }, { '2026Q1': 600 }, { sfdr: 'Article 9' }),
        ],
        investors: [
          { name: 'Swiss Pension Collective A', type: 'Institution', country: 'Switzerland', commitment: 65_000, entryDate: '2021-06-30' },
          { name: 'Cantonal Insurance Group', type: 'Institution', country: 'Switzerland', commitment: 48_000, entryDate: '2021-06-30' },
          { name: 'Alpine Family Office', type: 'Family Office', country: 'Switzerland', commitment: 32_000, entryDate: '2021-12-31' },
          { name: 'European Impact Feeder', type: 'Feeder', country: 'Luxembourg', commitment: 35_000, entryDate: '2022-06-30' },
        ],
      },
      {
        key: 'pciof-ii',
        name: 'Patrimonium Climate Infrastructure Opportunity Fund II',
        shortName: 'PCIOF II',
        kind: 'fund-of-funds',
        currency: 'EUR',
        inception: '2024-09-30',
        investorCommitment: 120_000,
        status: 'Fundraising',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
        cash: 1_900,
        positions: [
          fund('nordic-grid-v', 'Nordic Grid Infrastructure V', 'Nordic Grid Partners', 'EUR', 2024, 30_000, 'Infrastructure', 'Europe', 0, 0.017,
            { '2025Q1': 3_200, '2025Q3': 2_800, '2026Q1': 2_400 },
            undefined, { sfdr: 'Article 9' }),
          fund('heat-networks', 'European Heat Networks Fund', 'Thermal Partners', 'EUR', 2024, 26_000, 'Infrastructure', 'Europe', 0, 0.015,
            { '2025Q2': 2_900, '2025Q4': 2_600, '2026Q1': 1_800 },
            undefined, { sfdr: 'Article 9' }),
          fund('green-hydrogen', 'Green Hydrogen Opportunities I', 'H2 Ventures', 'EUR', 2025, 22_000, 'Energy Transition', 'Europe', 0, 0.012,
            { '2025Q3': 2_200, '2026Q1': 1_900 },
            undefined, { sfdr: 'Article 9', silentPeriods: [LATEST] }),
          coinvest('battery-storage-co', 'Grid Battery Storage (co-investment)', 'Thermal Partners', 'EUR', 2025, 12_000, 'Energy Transition', 'Europe', 0.016,
            { '2025Q4': 6_000, '2026Q1': 3_000 }, undefined, { sfdr: 'Article 9' }),
        ],
        investors: [
          { name: 'Swiss Pension Collective A', type: 'Institution', country: 'Switzerland', commitment: 55_000, entryDate: '2024-09-30' },
          { name: 'Nordic Insurance Mutual', type: 'Institution', country: 'Sweden', commitment: 40_000, entryDate: '2024-12-31' },
          { name: 'Alpine Family Office', type: 'Family Office', country: 'Switzerland', commitment: 25_000, entryDate: '2025-03-31' },
        ],
      },
      {
        key: 'pas-infra',
        name: 'PAS Infra',
        shortName: 'PAS Infra',
        kind: 'fund-of-funds',
        currency: 'CHF',
        inception: '2019-12-31',
        investorCommitment: 250_000,
        status: 'Harvesting',
        domicile: 'Switzerland',
        administrator: 'Helvetia Fund Administration',
        cash: 5_400,
        positions: [
          fund('swiss-infra-fund', 'Swiss Infrastructure Partners III', 'Helvetia Infra', 'CHF', 2019, 62_000, 'Infrastructure', 'Europe', 38_400, 0.013,
            { '2024Q2': 2_600, '2025Q2': 2_100 }, { '2024Q4': 4_200, '2025Q4': 3_800 }),
          fund('euro-transport', 'European Transport Infrastructure IV', 'Corridor Capital', 'EUR', 2020, 48_000, 'Infrastructure', 'Europe', 29_100, 0.015,
            { '2024Q1': 2_200, '2025Q1': 1_800 }, { '2025Q2': 3_400 }),
          direct('rail-terminal', 'Regional Rail Terminal Holding', 'CHF', 2020, 62_000, 'Infrastructure', 'Europe', 0.014,
            { '2024Q1': 62_000 }, { '2025Q2': 3_400, '2026Q1': 2_800 }),
          direct('fibre', 'Regional Fibre Backbone', 'CHF', 2021, 48_000, 'Infrastructure', 'Europe', 0.018,
            { '2024Q1': 48_000 }, { '2026Q1': 2_200 }),
          coinvest('hydro-co', 'Alpine Small Hydro Portfolio (co-investment)', 'Helvetia Infra', 'CHF', 2022, 44_000, 'Energy Transition', 'Europe', 0.011,
            { '2024Q2': 30_000, '2025Q1': 14_000 }),
          direct('water', 'Water Treatment Concession', 'EUR', 2023, 32_000, 'Infrastructure', 'Europe', 0.013,
            { '2024Q3': 20_000, '2025Q2': 12_000 }, undefined, { silentPeriods: [LATEST] }),
        ],
        investors: [
          { name: 'Swiss Pension Collective B', type: 'Institution', country: 'Switzerland', commitment: 110_000, entryDate: '2019-12-31' },
          { name: 'Cantonal Insurance Group', type: 'Institution', country: 'Switzerland', commitment: 85_000, entryDate: '2019-12-31' },
          { name: 'Municipal Pension Association', type: 'Institution', country: 'Switzerland', commitment: 55_000, entryDate: '2020-06-30' },
        ],
      },
    ],
  },

  {
    key: 'ebg',
    name: 'EBG Investment Solutions',
    shortName: 'EBG',
    reportingCurrency: 'CHF',
    manager: 'EBG Investment Solutions AG',
    vehicles: [
      {
        key: 'abif',
        name: 'Abendrot Impulse Fund',
        shortName: 'AbIF',
        kind: 'fund-of-funds',
        currency: 'CHF',
        inception: '2020-03-31',
        investorCommitment: 150_000,
        status: 'Investing',
        domicile: 'Switzerland',
        administrator: 'Helvetia Fund Administration',
        cash: 2_800,
        positions: [
          fund('impact-growth', 'European Impact Growth Fund III', 'Impulse Partners', 'EUR', 2020, 26_000, 'Growth', 'Europe', 16_200, 0.027,
            { '2024Q2': 2_100, '2024Q4': 1_700, '2025Q2': 1_900, '2025Q4': 1_400, '2026Q1': 1_000 },
            { '2025Q3': 2_400, '2026Q1': 1_600 }, { sfdr: 'Article 9' }),
          fund('social-infra', 'Social Infrastructure Partners II', 'Civic Capital', 'EUR', 2021, 24_000, 'Infrastructure', 'Europe', 13_400, 0.019,
            { '2024Q1': 1_900, '2024Q3': 1_600, '2025Q1': 1_800, '2025Q3': 1_300 },
            { '2024Q4': 1_800, '2025Q4': 2_200 }, { sfdr: 'Article 9' }),
          fund('sustainable-forestry', 'Sustainable Forestry Fund I', 'Verdant Land', 'EUR', 2022, 20_000, 'Nature-based', 'Global', 8_600, 0.016,
            { '2024Q3': 1_800, '2025Q1': 2_000, '2025Q3': 1_700, '2026Q1': 1_200 },
            undefined, { sfdr: 'Article 9' }),
          secondary('affordable-housing', 'Affordable Housing Fund CH (secondary)', 'Wohnbau Partners', 'CHF', 2021, 28_000, 'Real Estate', 'Europe', 15_800, 0.014,
            { '2024Q2': 1_700, '2024Q4': 1_500, '2025Q2': 1_600, '2025Q4': 1_200 },
            { '2025Q2': 1_100 }, { sfdr: 'Article 8' }),
          fund('microfinance', 'Global Microfinance Debt Fund', 'Inclusion Capital', 'USD', 2022, 18_000, 'Growth', 'Global', 9_200, 0.013,
            { '2024Q1': 1_400, '2024Q3': 1_300, '2025Q1': 1_500, '2025Q3': 1_100 },
            { '2025Q4': 1_600 }, { sfdr: 'Article 9', silentPeriods: [LATEST] }),
          fund('circular-vc', 'Circular Materials Venture II', 'Loop Ventures', 'EUR', 2023, 16_000, 'Early (VC)', 'Europe', 4_800, 0.031,
            { '2024Q4': 1_600, '2025Q2': 1_800, '2025Q4': 1_400, '2026Q1': 900 },
            undefined, { sfdr: 'Article 9', silentPeriods: [LATEST] }),
          fund('clean-mobility', 'Clean Mobility Infrastructure', 'Mobility Infra', 'EUR', 2023, 18_000, 'Infrastructure', 'Europe', 5_400, 0.020,
            { '2024Q3': 1_500, '2025Q1': 1_700, '2025Q3': 1_500, '2026Q1': 1_000 },
            undefined, { sfdr: 'Article 9' }),
          coinvest('care-homes-co', 'Regional Care Homes (co-investment)', 'Civic Capital', 'CHF', 2023, 12_000, 'Real Estate', 'Europe', 0.013,
            { '2024Q4': 7_000, '2025Q4': 3_500 }, undefined, { sfdr: 'Article 9' }),
        ],
        investors: [
          { name: 'Pension Foundation Abendrot', type: 'Institution', country: 'Switzerland', commitment: 90_000, entryDate: '2020-03-31' },
          { name: 'Basel Charitable Trust', type: 'Institution', country: 'Switzerland', commitment: 28_000, entryDate: '2020-09-30' },
          { name: 'Sustainable Wealth Feeder', type: 'Feeder', country: 'Switzerland', commitment: 20_000, entryDate: '2021-06-30' },
          { name: 'Zurich Family Office', type: 'Family Office', country: 'Switzerland', commitment: 12_000, entryDate: '2022-03-31' },
        ],
      },
      {
        key: 'phf-i',
        name: 'Planetary Health Fund I',
        shortName: 'PHF I',
        kind: 'fund-of-funds',
        currency: 'EUR',
        inception: '2022-06-30',
        investorCommitment: 95_000,
        status: 'Investing',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
        cash: 1_600,
        positions: [
          fund('planetary-health-vc', 'Planetary Health Ventures II', 'Biosphere Capital', 'EUR', 2022, 22_000, 'Early (VC)', 'Europe', 8_400, 0.029,
            { '2024Q2': 2_000, '2024Q4': 1_800, '2025Q2': 2_100, '2025Q4': 1_500, '2026Q1': 1_100 },
            undefined, { sfdr: 'Article 9' }),
          fund('regen-agri', 'Regenerative Agriculture Fund I', 'Terra Nova', 'EUR', 2022, 20_000, 'Nature-based', 'Europe', 7_600, 0.018,
            { '2024Q3': 1_900, '2025Q1': 2_100, '2025Q3': 1_800, '2026Q1': 1_200 },
            undefined, { sfdr: 'Article 9' }),
          fund('oceans', 'Ocean Health Opportunities', 'Blue Horizon', 'USD', 2023, 18_000, 'Nature-based', 'Global', 5_200, 0.022,
            { '2024Q4': 1_800, '2025Q2': 2_000, '2025Q4': 1_600, '2026Q1': 1_000 },
            undefined, { sfdr: 'Article 9' }),
          fund('nutrition', 'Sustainable Nutrition Growth', 'Nourish Partners', 'EUR', 2023, 17_000, 'Growth', 'Europe', 4_900, 0.024,
            { '2024Q4': 1_600, '2025Q2': 1_800, '2025Q4': 1_500, '2026Q1': 900 },
            { '2026Q1': 600 }, { sfdr: 'Article 9' }),
          fund('health-access', 'Health Access Fund II', 'Access Capital', 'EUR', 2024, 14_000, 'Growth', 'Global', 2_100, 0.020,
            { '2025Q1': 1_700, '2025Q3': 1_500, '2026Q1': 1_100 },
            undefined, { sfdr: 'Article 9', silentPeriods: [LATEST] }),
          coinvest('diagnostics-co', 'Rural Diagnostics Network (co-investment)', 'Access Capital', 'EUR', 2024, 9_000, 'Growth', 'Global', 0.021,
            { '2025Q2': 5_000, '2026Q1': 2_500 }, undefined, { sfdr: 'Article 9' }),
        ],
        investors: [
          { name: 'Nordic Health Foundation', type: 'Institution', country: 'Denmark', commitment: 38_000, entryDate: '2022-06-30' },
          { name: 'Pension Foundation Abendrot', type: 'Institution', country: 'Switzerland', commitment: 25_000, entryDate: '2022-06-30' },
          { name: 'Impact Wealth Feeder', type: 'Feeder', country: 'Luxembourg', commitment: 18_000, entryDate: '2022-12-31' },
          { name: 'Geneva Foundation', type: 'Institution', country: 'Switzerland', commitment: 14_000, entryDate: '2023-06-30' },
        ],
      },
      {
        key: 'pk-tg',
        name: 'PK TG',
        shortName: 'PK TG',
        kind: 'fund-of-funds',
        currency: 'CHF',
        inception: '2018-09-30',
        investorCommitment: 320_000,
        status: 'Harvesting',
        domicile: 'Switzerland',
        administrator: 'Helvetia Fund Administration',
        cash: 6_100,
        positions: [
          fund('buyout-europe', 'European Buyout Partners VI', 'Continental Equity', 'EUR', 2018, 58_000, 'Buyout', 'Europe', 41_200, 0.019,
            { '2024Q2': 2_200, '2025Q2': 1_600 },
            { '2024Q4': 6_400, '2025Q3': 5_800, '2026Q1': 4_200 }),
          fund('buyout-us', 'North American Buyout Fund IX', 'Summit Equity', 'USD', 2019, 52_000, 'Buyout', 'North America', 36_800, 0.021,
            { '2024Q1': 1_900, '2025Q1': 1_400 },
            { '2024Q3': 5_200, '2025Q4': 6_100, '2026Q1': 3_800 }),
          fund('growth-global', 'Global Growth Partners IV', 'Meridian Growth', 'USD', 2020, 46_000, 'Growth', 'Global', 29_400, 0.023,
            { '2024Q3': 2_100, '2025Q3': 1_700 },
            { '2025Q2': 4_300, '2026Q1': 2_900 }),
          fund('infra-core', 'Core Infrastructure Fund V', 'Foundation Infra', 'EUR', 2019, 48_000, 'Infrastructure', 'Global', 33_100, 0.015,
            { '2024Q4': 1_800 },
            { '2024Q2': 3_600, '2025Q4': 4_400 }),
          fund('secondaries', 'Diversified Secondaries 2021', 'Cascade Secondaries', 'EUR', 2021, 42_000, 'Buyout', 'Global', 26_700, 0.020,
            { '2024Q2': 2_400, '2025Q2': 1_900, '2026Q1': 1_200 },
            { '2025Q4': 3_900, '2026Q1': 2_100 }, { kind: 'secondary' }),
          fund('real-estate-eu', 'European Real Estate Income III', 'Cityscape Partners', 'EUR', 2020, 38_000, 'Real Estate', 'Europe', 22_900, 0.011,
            { '2024Q1': 1_600, '2025Q1': 1_300 },
            { '2025Q1': 2_800, '2026Q1': 1_900 }),
        ],
        investors: [
          { name: 'Pensionskasse Thurgau', type: 'Institution', country: 'Switzerland', commitment: 320_000, entryDate: '2018-09-30' },
        ],
      },
    ],
  },

  {
    key: 'ut',
    name: 'Una Terra',
    shortName: 'UT',
    reportingCurrency: 'EUR',
    manager: 'Una Terra',
    vehicles: [
      {
        key: 'ut-early-growth',
        name: 'Una Terra Early Growth Fund',
        shortName: 'UT EGF',
        kind: 'direct-fund',
        currency: 'EUR',
        inception: '2022-03-31',
        investorCommitment: 45_000,
        status: 'Investing',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
        cash: 2_100,
        positions: [
          direct('bio-materials', 'Bio-Based Materials Company', 'EUR', 2022, 7_200, 'Early (VC)', 'Europe', 0.038,
            { '2024Q1': 4_200, '2025Q2': 3_000 }, undefined, { sfdr: 'Article 9' }),
          direct('precision-ferm', 'Precision Fermentation Platform', 'EUR', 2022, 6_800, 'Early (VC)', 'Europe', 0.042,
            { '2024Q1': 3_800, '2025Q1': 3_000 }, undefined, { sfdr: 'Article 9' }),
          direct('water-tech', 'Industrial Water Recovery', 'EUR', 2023, 5_900, 'Early (VC)', 'Europe', 0.033,
            { '2024Q3': 3_400, '2025Q3': 2_500 }, undefined, { sfdr: 'Article 9' }),
          direct('battery-recycling', 'Battery Materials Recycling', 'EUR', 2023, 6_400, 'Energy Transition', 'Europe', 0.036,
            { '2024Q2': 3_600, '2025Q2': 2_800 }, undefined, { sfdr: 'Article 9' }),
          direct('agri-robotics', 'Agricultural Robotics Platform', 'USD', 2024, 5_200, 'Early (VC)', 'North America', 0.029,
            { '2024Q4': 3_000, '2025Q4': 2_200 }, undefined, { sfdr: 'Article 8', silentPeriods: [LATEST] }),
          direct('carbon-removal', 'Enhanced Weathering Venture', 'EUR', 2024, 4_800, 'Nature-based', 'Europe', 0.026,
            { '2025Q1': 2_800, '2026Q1': 2_000 }, undefined, { sfdr: 'Article 9', silentPeriods: [LATEST] }),
        ],
        investors: [
          { name: 'Impact Venture Partners', type: 'Institution', country: 'Netherlands', commitment: 16_000, entryDate: '2022-03-31' },
          { name: 'Una Terra Sponsor Commitment', type: 'Seed', country: 'Luxembourg', commitment: 6_000, entryDate: '2022-03-31' },
          { name: 'Green Tech Foundation', type: 'Institution', country: 'Germany', commitment: 13_000, entryDate: '2022-09-30' },
          { name: 'Private Clients Feeder', type: 'Feeder', country: 'Luxembourg', commitment: 10_000, entryDate: '2023-03-31' },
        ],
      },
    ],
  },
];

const SECTORS = [
  'Energy Transition', 'Utilities', 'Transport', 'Digital Infrastructure',
  'Healthcare', 'Agriculture & Food', 'Industrials', 'Consumer',
];
const COUNTRIES = [
  'Switzerland', 'Germany', 'France', 'Netherlands', 'Spain',
  'Sweden', 'United Kingdom', 'United States', 'Denmark',
];

/* ------------------------------------------------------------------ *
 * Building a dataset
 * ------------------------------------------------------------------ */

export const DEMO_CLIENTS = CLIENTS.map((client) => ({
  id: `client-${client.key}`,
  name: client.name,
  shortName: client.shortName,
}));

export function buildDemoDataSet(clientId: string): DataSet {
  sequence = 0;
  const seed = CLIENTS.find((c) => `client-${c.key}` === clientId) ?? CLIENTS[0];
  const clientKey = `client-${seed.key}`;

  const vehicles: Vehicle[] = [];
  const positions: DataSet['positions'] = [];
  const assets: DataSet['assets'] = [];
  const assetValuations: DataSet['assetValuations'] = [];
  const positionValuations: DataSet['positionValuations'] = [];
  const investors: Investor[] = [];
  const cashflows: Cashflow[] = [];
  const balanceSheets: DataSet['balanceSheets'] = [];

  seed.vehicles.forEach((vehicleSeed, vehicleIndex) => {
    const vehicleId = `veh-${vehicleSeed.key}`;

    vehicles.push({
      id: vehicleId,
      clientId: clientKey,
      kind: vehicleSeed.kind,
      name: vehicleSeed.name,
      shortName: vehicleSeed.shortName,
      currency: vehicleSeed.currency,
      inceptionDate: vehicleSeed.inception,
      investorCommitment: vehicleSeed.investorCommitment,
      manager: seed.manager,
      administrator: vehicleSeed.administrator,
      domicile: vehicleSeed.domicile,
      status: vehicleSeed.status,
      conventions: DEFAULT_CONVENTIONS,
    });

    const built = buildPortfolio(vehicleSeed, vehicleId, vehicleIndex);
    positions.push(...built.positions);
    assets.push(...built.assets);
    assetValuations.push(...built.assetValuations);
    positionValuations.push(...built.valuations);
    cashflows.push(...built.cashflows);

    const vehicleInvestors = vehicleSeed.investors.map((investorSeed, i) => ({
      id: `inv-${vehicleSeed.key}-${i + 1}`,
      vehicleId,
      name: investorSeed.name,
      type: investorSeed.type,
      country: investorSeed.country,
      currency: vehicleSeed.currency,
      commitment: investorSeed.commitment,
      entryDate: investorSeed.entryDate,
    }));
    investors.push(...vehicleInvestors);

    cashflows.push(...investorCashflows(
      vehicleId, vehicleInvestors, built.cashflows, vehicleSeed.currency,
    ));
    balanceSheets.push(...balanceSheetsFor(vehicleId, vehicleSeed));
  });

  return {
    client: {
      id: clientKey,
      name: seed.name,
      shortName: seed.shortName,
      reportingCurrency: seed.reportingCurrency,
      conventions: DEFAULT_CONVENTIONS,
    },
    vehicles,
    positions,
    assets,
    assetValuations,
    positionValuations,
    investors,
    cashflows,
    balanceSheets,
    fxRates: fxRates(),
    esgMetrics: [],
  };
}

function buildPortfolio(vehicleSeed: VehicleSeed, vehicleId: string, vehicleIndex: number) {
  const positions: DataSet['positions'] = [];
  const valuations: DataSet['positionValuations'] = [];
  const cashflows: Cashflow[] = [];
  const assets: DataSet['assets'] = [];
  const assetValuations: DataSet['assetValuations'] = [];

  vehicleSeed.positions.forEach((seed, seedIndex) => {
    const positionId = `pos-${vehicleSeed.key}-${seed.key}`;

    positions.push({
      id: positionId,
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
      esg: { sfdr: seed.sfdr ?? 'Article 8' },
    });

    // Capital drawn before the series starts, which is what built the opening
    // NAV. Without it the multiples see a large NAV against almost no paid-in
    // capital and come out at several hundred percent.
    if (seed.inceptionCall) {
      cashflows.push({
        id: id('cf'), positionId, vehicleId, type: 'Capital Call',
        amount: -seed.inceptionCall, currency: seed.currency,
        date: `${seed.vintage}-09-30`, period: `${seed.vintage}Q3`,
        recordedAt: `${seed.vintage}-11-15T09:00:00Z`,
        affectsCommitment: true, status: 'Settled',
        description: `Capital drawn to inception — ${seed.name}`,
      });
    }

    for (const period of PERIODS) {
      const call = seed.callSchedule[period];
      if (call) {
        cashflows.push({
          id: id('cf'), positionId, vehicleId, type: 'Capital Call',
          amount: -call, currency: seed.currency,
          date: periodEndDate(period), period, recordedAt: recordedFor(period),
          affectsCommitment: true, status: 'Settled',
          description: `Capital call — ${seed.name}`,
        });
      }
      const distribution = seed.distributionSchedule?.[period];
      if (distribution) {
        cashflows.push({
          id: id('cf'), positionId, vehicleId, type: 'Distribution',
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

      // One position per client was restated after the quarter was published.
      // Both rows stay, so a point-in-time view of the original still works.
      const restated = period === '2025Q4' && vehicleIndex === 0 && seedIndex === 1;
      valuations.push({
        id: id('val'), positionId, period,
        recordedAt: recordedFor(period),
        nav: restated ? Math.round(nav * 0.97 * 100) / 100 : Math.round(nav * 100) / 100,
        source: seed.kind === 'fund' ? 'GP quarterly report' : 'Internal valuation',
        supersededBy: restated ? 'restated' : undefined,
      });

      if (restated) {
        valuations.push({
          id: `restated-${positionId}`, positionId, period,
          recordedAt: LATE,
          nav: Math.round(nav * 100) / 100,
          source: 'GP restated report',
        });
      }
    }

    // Look-through assets. The vehicle's economic exposure to an asset is its
    // total value scaled by the position's stake and then by the vehicle's stake
    // in the position, so the value stored here is grossed back up through both.
    const splits = seed.kind === 'fund' ? [0.42, 0.33, 0.25] : [1];
    const assetOwnerships = seed.kind === 'fund' ? [0.6, 0.45, 0.8] : [1];

    for (let i = 0; i < splits.length; i += 1) {
      const assetId = `${positionId}-asset-${i + 1}`;
      const spread = seedIndex + i + vehicleIndex;

      assets.push({
        id: assetId,
        positionId,
        name: seed.kind === 'fund'
          ? `${seed.name.split(' ')[0]} Holding ${i + 1}`
          : seed.name,
        currency: seed.currency,
        investmentDate: `${seed.vintage + 1}-03-31`,
        ownership: assetOwnerships[i],
        assetClass: seed.assetClass,
        subAssetClass: seed.subAssetClass,
        sector: i === 0
          ? { [SECTORS[spread % SECTORS.length]]: 0.7, [SECTORS[(spread + 2) % SECTORS.length]]: 0.3 }
          : SECTORS[spread % SECTORS.length],
        region: seed.region,
        country: COUNTRIES[(spread * 2) % COUNTRIES.length],
        status: 'Held',
      });

      const grossUp = assetOwnerships[i] * seed.ownership;
      let assetNav = (seed.openingNav * splits[i]) / (grossUp || 1);

      for (const period of PERIODS) {
        const call = ((seed.callSchedule[period] ?? 0) * splits[i]) / (grossUp || 1);
        const distribution = ((seed.distributionSchedule?.[period] ?? 0) * splits[i]) / (grossUp || 1);
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

/**
 * Investor-side flows, derived from the portfolio rather than invented.
 *
 * A vehicle calls capital because its portfolio called capital, and distributes
 * because its portfolio distributed. Deriving the investor schedule from the
 * portfolio one keeps the net tier in a believable relationship with the gross
 * tier — an arbitrary schedule produces net multiples several times the gross
 * ones, which is the giveaway that the two sides were never connected.
 */
function investorCashflows(
  vehicleId: string,
  investors: Investor[],
  portfolio: Cashflow[],
  vehicleCurrency: CurrencyCode,
): Cashflow[] {
  const total = investors.reduce((sum, i) => sum + i.commitment, 0);
  if (total === 0) return [];

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
 * the tables cover — the series starts in 2024 but inception calls sit before it.
 */
function toVehicleRate(from: CurrencyCode, to: CurrencyCode, period: PeriodId): number {
  if (from === to) return 1;
  const nearest = (table: Record<string, number>) =>
    table[period] ?? table[PERIODS.find((p) => p >= period) ?? PERIODS[0]] ?? 1;

  // Rates are quoted as 1 EUR = X foreign, so a foreign amount divides.
  const fromInEur = CLOSING[from] ? 1 / nearest(CLOSING[from]) : 1;
  const eurInTo = CLOSING[to] ? nearest(CLOSING[to]) : 1;
  return fromInEur * eurInTo;
}

function balanceSheetsFor(vehicleId: string, seed: VehicleSeed): DataSet['balanceSheets'] {
  const other = Math.round(seed.cash * 0.18);
  const liabilities = Math.round(seed.cash * 0.14);

  return PERIODS.map((period, index) => ({
    vehicleId,
    period,
    // The latest quarter's balance sheet lands with the draft, not before.
    recordedAt: period === LATEST ? DRAFT_CUT : recordedFor(period),
    cash: Math.round((seed.cash + index * seed.cash * 0.03) * 100) / 100,
    otherAssets: Math.round((other - index * 4) * 100) / 100,
    currentLiabilities: Math.round((liabilities + index * 5) * 100) / 100,
    accruedExpenses: Math.round((liabilities * 0.65 + index * 3) * 100) / 100,
    source: `${seed.currency} administrator statement`,
  }));
}

export const DEMO_TIMELINE = { EARLY, DRAFT_CUT, LATE, LATEST, PERIODS };

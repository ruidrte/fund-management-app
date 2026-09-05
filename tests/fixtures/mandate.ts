/**
 * An advisory monitoring workbook, in the shape of a real one with invented
 * funds and properties.
 *
 * Two funds, three properties. Fund I: the holder put in 10,000,000 of a
 * 100,000,000 fund, so its share is a tenth; the fund's properties are worth
 * 90,000,000 between them and the vehicle the holder invests through holds
 * 45,000,000 of that, so it holds half. A tenth of a half of 90,000,000 is
 * 4,500,000, and that is the only figure the look-through may produce.
 *
 * `Roof age` is here on purpose: a column no reader has been told about, which
 * has to survive being read into the book and written back out of it.
 */

import type { TableData } from '../../src/ingest/types';
import type { Cell } from '../../src/ingest/workbook';

const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

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

export function mandateWorkbook(overrides: Record<string, Cell[][]> = {}): TableData[] {
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

/** The fixture as it stands, for a test that does not vary it. */
export const MANDATE_WORKBOOK = mandateWorkbook();

/**
 * An investment accounts workbook, in the shape of a real one with invented
 * figures: the ledger of every movement with every holding, the administrator's
 * financial statements in columns, the register feed the capital accounts are
 * written from, and the snapshot the desk publishes.
 *
 * Every convention where a plausible wrong answer is available is in here on
 * purpose — the ledger signed from the fund's side, an off-commitment column
 * carrying both an expense and an income, a recallable distribution, a
 * negative call, a number sitting in the NAV column of a row that is not a
 * valuation, an unsigned register feed with an equalisation each way, and a
 * carried-interest line under partners' capital.
 */

import type { TableData } from '../../src/ingest/types';

export const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

const HEADER = [
  'Class', 'Asset', 'Date', 'Comment', 'CCY', 'Commitment', 'Capital Call',
  'Off commit Expenses (income)', 'Distributions (rec.)', 'Distributions', 'NAV',
  'Net Cash', 'Called Acc', 'Dist Acc', 'Unfunded', 'Net cash2', 'FX Rate applied',
  'Commit. €', 'Capital Call €', 'Off commit Expenses (income) €', 'Distributions (rec.) €',
  'Distributions €', 'NAV €', 'Net Cash €', 'Called Acc €', 'Dist Acc €', 'Unfunded €',
  'Net cash2 €', null, 'FX policy',
];

/** A ledger row: the local figures, and the euro ones the sheet derives beside them. */
function row(
  klass: string, asset: string, date: string, comment: string, ccy: string, rate: number,
  local: { commitment?: number; call?: number; off?: number; rec?: number; dist?: number; nav?: number },
  aside?: string,
  euroOverride?: Partial<{ call: number }>,
): Array<string | number | null> {
  const eur = (value?: number) => (value === undefined ? null : value * rate);
  return [
    klass, asset, serial(date), comment, ccy,
    local.commitment ?? null, local.call ?? null, local.off ?? null, local.rec ?? null,
    local.dist ?? null, local.nav ?? null, null, null, null, null, null, rate,
    eur(local.commitment), euroOverride?.call ?? eur(local.call), eur(local.off), eur(local.rec),
    eur(local.dist), eur(local.nav), null, null, null, null, null, null, aside ?? null,
  ];
}

export const ACCOUNTS: TableData = {
  sheetName: 'Investment Accounts',
  rows: [
    HEADER,
    // A sterling primary, with the rate moving between rows.
    row('Primary ', 'Harbour Fund IV', '2024-01-10', 'Initial Commitment', 'GBP', 1.15, { commitment: 5_000_000 },
      'The administrator’s trial balance is the book of record for FX.'),
    row('Primary ', 'Harbour Fund IV', '2024-02-01', 'Capital Call #1', 'GBP', 1.16, { call: 2_000_000 },
      'Between quarter-ends, use the ECB reference rate on the transaction date.'),
    row('Primary ', 'Harbour Fund IV', '2024-03-31', 'NAV', 'GBP', 1.17, { nav: 2_050_000 }),
    // Off-commitment in both directions: an equalisation expense paid, and
    // income received.
    row('Primary ', 'Harbour Fund IV', '2024-05-15', 'Equalisation', 'GBP', 1.18, { off: 30_000 }),
    row('Primary ', 'Harbour Fund IV', '2024-06-20', 'Interest received', 'GBP', 1.18, { off: -4_000 }),
    row('Primary ', 'Harbour Fund IV', '2024-06-30', 'NAV', 'GBP', 1.19, { nav: 2_180_000 }),
    // A euro co-investment with a recallable distribution and a negative call.
    row('Co-inv.', 'Solar Park Beta', '2024-03-01', 'Initial Commitment', 'EUR', 1, { commitment: 3_000_000 }),
    row('Co-inv.', 'Solar Park Beta', '2024-03-05', 'CC #1', 'EUR', 1, { call: 3_000_000 }),
    row('Co-inv.', 'Solar Park Beta', '2024-03-31', 'NAV', 'EUR', 1, { nav: 3_010_000 }),
    row('Co-inv.', 'Solar Park Beta', '2024-04-10', 'Distribution #1 (recallable)', 'EUR', 1, { rec: -200_000 }),
    row('Co-inv.', 'Solar Park Beta', '2024-05-02', 'Return of excess', 'EUR', 1, { call: -50_000 }),
    row('Co-inv.', 'Solar Park Beta', '2024-06-15', 'Distribution #2', 'EUR', 1, { dist: -100_000 }),
    // A figure in the NAV column on a row that is not a valuation.
    row('Co-inv.', 'Solar Park Beta', '2024-06-18', 'CC #2', 'EUR', 1, { call: 20_000, nav: 19_999 }),
    row('Co-inv.', 'Solar Park Beta', '2024-06-30', 'NAV', 'EUR', 1, { nav: 2_900_000 }),
    // The general partner's stake, valued at nothing and never called again.
    row('GP', 'Beta GP SA', '2024-01-02', 'Initial Commitment', 'EUR', 1, { commitment: 10_000 }),
    row('GP', 'Beta GP SA', '2024-01-02', 'Capital Call', 'EUR', 1, { call: 10_000 }),
    row('GP', 'Beta GP SA', '2024-03-31', 'NAV', 'EUR', 1, { nav: 0 }),
    row('GP', 'Beta GP SA', '2024-06-30', 'NAV', 'EUR', 1, { nav: 0 }),
  ],
};

/** The same ledger with one euro cell overwritten by hand. */
export const ACCOUNTS_WITH_A_BROKEN_EURO_CELL: TableData = {
  sheetName: 'Investment Accounts',
  rows: [
    ...ACCOUNTS.rows.slice(0, 2),
    row('Primary ', 'Harbour Fund IV', '2024-02-01', 'Capital Call #1', 'GBP', 1.16, { call: 2_000_000 },
      undefined, { call: 2_300_000 }),
    ...ACCOUNTS.rows.slice(3),
  ],
};

const REGISTER_HEADER = [
  'Fund_Compartiment', 'Investor_name', 'Investor_Fund_ID', 'Date', 'Event_type', 'Value', 'Unit', 'Source',
];

function event(
  name: string, id: number, date: string, type: string, value: number, source = 'Admin prep file & Notices',
): Array<string | number | null> {
  return ['Compartment One', name, id, serial(date), type, value, 'EUR', source];
}

/**
 * Two closers a quarter apart. The second is equalised in: called for their
 * share of what the first paid, plus a premium, and the first is handed the
 * same capital back and receives the premium. Every value is positive; the
 * event says which way it went.
 */
export const REGISTER: TableData = {
  sheetName: 'Onesource',
  rows: [
    // The feed carries a summary block to the right of its own header, which
    // is nothing to read.
    [...REGISTER_HEADER, null, 'Subscription', 'Capital Call'],
    [...event('Northern Pension', 1, '2024-01-15', 'Subscription', 4_000_000, 'Acceptance Letter'), null, 6_000_000, 3_000_000],
    event('Northern Pension', 1, '2024-02-01', 'Capital Call', 3_000_000),
    event('Northern Pension', 1, '2024-03-31', 'Capital Account Statement', 3_020_000, 'Admin prep file & CAS'),
    event('Coastal Foundation', 2, '2024-04-15', 'Subscription', 2_000_000, 'Acceptance Letter'),
    event('Coastal Foundation', 2, '2024-04-20', 'Equalization Called', 1_000_000),
    event('Coastal Foundation', 2, '2024-04-20', 'Equalization Premium paid', 12_000),
    event('Northern Pension', 1, '2024-04-20', 'Equalization Distributed', 1_000_000),
    event('Northern Pension', 1, '2024-04-20', 'Equalization Premium received', 12_000),
    event('Northern Pension', 1, '2024-06-15', 'Dividend (Cash Distribution)', 60_000),
    // An earlier extract of the feed signs from the investor's side; the
    // event still says which way it went.
    event('Coastal Foundation', 2, '2024-06-15', 'Dividend (Cash Distribution)', -30_000),
    event('Northern Pension', 1, '2024-06-30', 'Capital Account Statement', 3_540_000, 'Admin prep file & CAS'),
    event('Coastal Foundation', 2, '2024-06-30', 'Capital Account Statement', 1_524_200, 'Admin prep file & CAS'),
    // An event the reader has no rule for.
    event('Coastal Foundation', 2, '2024-06-30', 'Transfer of interest', 1),
  ],
};

/**
 * The administrator's statements: a column per quarter, an outline number and
 * a caption per line, the income statement below the balance sheet under a
 * marker in the first column.
 */
export const FS: TableData = {
  sheetName: 'FS',
  rows: [
    [null, null, null, null, serial('2024-03-31'), serial('2024-06-30'), serial('2024-09-30')],
    ['Balance\nSheet', '1.00', null, 'Assets:', 5_460_000, 5_500_000, null],
    [null, '1.10', null, 'Non-current Assets', 5_408_500, 5_490_000, null],
    [null, '1.1.1', null, 'Investments:', 5_408_500, 5_490_000, null],
    [null, '1.1.1.1', null, 'Harbour Fund IV', 2_398_500, 2_594_200, null],
    [null, '1.1.1.2', null, 'Solar Park Beta', 3_010_000, 2_900_000, null],
    [null, '1.1.1.3', null, 'Beta GP SA', 0, 0, null],
    [null, '1.20', null, 'Current Assets:', 51_500, 10_000, null],
    [null, '1.2.1', null, 'Cash and cash equivalents', 50_000, 8_000, null],
    [null, '1.2.1.1', null, 'Euro Account', 50_000, 8_000, null],
    [null, '1.2.2', null, 'Debtors and prepayments', 1_000, 1_500, null],
    [null, '1.2.3', null, 'Accounts receivable', 500, 500, null],
    [null, '2.00', null, 'Capital and Reserves', 5_420_000, 5_460_000, null],
    [null, '2.10', null, 'Limited Partners Contributions', 3_000_000, 3_012_000, null],
    [null, null, null, 'Limited Partners Distribbutions', 0, -90_000, null],
    [null, '2.20', null, 'Revenue reserve', 2_420_000, 2_538_000, null],
    [null, '2.40', null, 'Theoretical Carried Interest to Initial Limited Partner', 0, 400_000, null],
    [null, '3.00', null, 'Liabilities', 40_000, 40_000, null],
    [null, '3.1.1', null, 'Creditors and accruals', 30_000, 25_000, null],
    [null, '3.1.2', null, 'Accounts payable', 10_000, 15_000, null],
    [],
    ['P&L\nStatement', '1.00', null, 'Income', 5_000, 12_000, null],
    [null, '2.00', null, 'Expenses', -20_000, -45_000, null],
    [null, '2.30', null, 'Management Fees (check Mgt Fee tab from TB)', -15_000, -30_000, null],
  ],
};

export const SNAPSHOT: TableData = {
  sheetName: 'Portfolio New',
  rows: [
    ['Portfolio – Snapshot by Quarter', null, null, 'Quarter:', 'Q2 2024'],
    [],
    [],
    [],
    ['Quarter', 'Date', 'Asset', 'CCY', 'Commitment', 'Drawdown', 'Distributed', 'NAV', 'Open', 'TVPI', 'FX',
      'Commitment €', 'Drawdown €', 'Distributed €', 'NAV €', 'Total Value', 'Open €', 'TVPI €', 'Paid-In €'],
    ['Q2 2024', serial('2024-06-30'), 'Harbour Fund IV', 'GBP', 5_000_000, 2_000_000, 0, 2_180_000, 3_000_000, 1.09, 1.19,
      5_750_000, 2_320_000, 0, 2_594_200, 2_594_200, 3_570_000, 1.12, 2_320_000],
    ['Q2 2024', serial('2024-06-30'), 'Solar Park Beta', 'EUR', 3_000_000, 2_770_000, 100_000, 2_900_000, 230_000, 1.08, 1,
      3_000_000, 2_770_000, 100_000, 2_900_000, 3_000_000, 230_000, 1.01, 2_970_000],
    ['Q2 2024', serial('2024-06-30'), 'Beta GP SA', 'EUR', 10_000, 10_000, 0, 0, 0, 0, 1,
      10_000, 10_000, 0, 0, 0, 0, 0, 10_000],
    ['Total', null, null, null, 8_010_000, 4_780_000, 100_000, 5_080_000, 3_230_000, 1.08, null,
      8_760_000, 5_100_000, 100_000, 5_494_200, 5_594_200, 3_800_000, 1.10, 5_300_000],
  ],
};

export const accountsSheets = (over: Partial<Record<string, TableData>> = {}): TableData[] => [
  over.accounts ?? ACCOUNTS,
  over.register ?? REGISTER,
  over.fs ?? FS,
  over.snapshot ?? SNAPSHOT,
];

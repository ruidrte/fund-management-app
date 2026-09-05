/**
 * An LP capital master, in the shape of a real one with an invented fund.
 *
 * Two companies, three share classes, five investors across three classes of
 * the fund's own. Every convention where a plausible wrong answer is available
 * is here on purpose: a transfer between two investors that must net to
 * nothing, a company held in more than one share class whose approved value
 * cannot be split without the letter, two investors whose names differ only in
 * a suffix, and a trial balance that signs liabilities negative.
 */

import type { TableData } from '../../src/ingest/types';
import type { Cell } from '../../src/ingest/workbook';

const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

export const README: TableData = {
  sheetName: 'README & Change Log',
  rows: [
    ['Northwind Ventures Fund SCA SICAV-RAIF - LP Capital master, version 2 - re-baselined at 30 June 2026'],
    ['Prepared 20 July 2026. The earlier version ran off a preliminary trial balance which is superseded.'],
  ],
};

export const SUMMARY: TableData = {
  sheetName: 'Summary',
  rows: [
    [null, null, 'Northwind Ventures Fund SCA SICAV-RAIF - Summary dashboard'],
    [null, null, 'As of: ', serial('2026-06-30')],
    [],
    [null, null, 'Metric', null, null, 'Selected investor', 'Whole fund'],
    [null, null, 'Units held', null, null, 300, 1_030],
  ],
};

const REGISTER_HEADER = [
  'Date', 'Account # ', 'Account ID', 'Status', 'Investor', 'Type of Investor', 'Address',
  'Shares class', 'Description', 'Type of transaction', 'CCY', 'Commitment',
  'Investment (on-commit.)', 'Mgt. Fees (on-commit.)', 'Mgt. Fees (off-commit.)',
  'Fund OpEx (off.commit.)', 'Setup Fees (Off-commit)',
];

/** `[date, acct, id, status, investor, class, address, shares, desc, kind, ccy, commit, on, mfOn, mfOff, opex, setup]` */
export const REGISTER: TableData = {
  sheetName: 'LP DB',
  rows: ([
    REGISTER_HEADER,
    [serial('2024-01-15'), 'a1', 'I1', 'Active', 'NORTHWIND STUDIO AG [LP]', 'LP', 'Zurich',
      's1 [LP]', 'Initial Commitment', 'Initial Commitment', 'EUR', 600_000],
    // The same name with a different suffix is a different account, and an
    // identifier that truncates would make them one.
    [serial('2024-01-15'), 'a1', 'I1', 'Active', 'NORTHWIND STUDIO AG [Founder]', 'Founder', 'Zurich',
      's2 [Founder]', 'Initial Commitment', 'Initial Commitment', 'EUR', 29_000, 29_000],
    [serial('2024-01-15'), 'a2', 'I2', 'Active', 'NORTHWIND VENTURES SARL [GP]', 'GP', '',
      's3 [GP]', 'Initial Commitment', 'Initial Commitment', 'EUR', 1_000, 1_000],
    [serial('2024-02-01'), 'a3', 'I3', 'Active', 'HARBOUR TRUST', 'LP', 'London',
      's1 [LP]', 'Initial Commitment', 'Initial Commitment', 'EUR', 400_000],
    [serial('2024-06-30'), 'a1', 'I1', 'Active', 'NORTHWIND STUDIO AG [LP]', 'LP', 'Zurich',
      's1 [LP]', 'Capital Call #1', 'Capital Call', 'EUR', null, 300_000, null, 2_000, 1_500, 500],
    [serial('2024-06-30'), 'a3', 'I3', 'Active', 'HARBOUR TRUST', 'LP', 'London',
      's1 [LP]', 'Capital Call #1', 'Capital Call', 'EUR', null, 200_000, null, 1_000],
    // A transfer: one investor's call reversed, another's made. The fund called
    // nothing; the capital moved between two accounts.
    [serial('2025-03-01'), 'a1', 'I1', 'Active', 'NORTHWIND STUDIO AG [LP]', 'LP', 'Zurich',
      's1 [LP]', 'Transfer > Aldgate Partners', 'Commitment adjustment', 'EUR', -100_000, -100_000],
    [serial('2025-03-01'), 'a4', 'I4', 'Active', 'ALDGATE PARTNERS LLP', 'LP', 'London',
      's1 [LP]', 'Initial Commitment', 'Initial Commitment', 'EUR', 100_000],
    [serial('2025-03-01'), 'a4', 'I4', 'Active', 'ALDGATE PARTNERS LLP', 'LP', 'London',
      's1 [LP]', 'Capital Contribution (transfer)', 'Capital Call', 'EUR', null, 100_000],
    [null, null, null, null, null, null, null, null, 'TOTAL'],
  ] as Cell[][]),
};

const INVESTMENT_HEADER = [
  'Quarter', 'Date', 'Asset', 'Short Name', 'CCY', 'Commitment', 'Invested', 'Cost / Share',
  '# UT Shares', 'Cum # shares', 'Type', 'Total FD # shares', 'Cum FD Stake %', 'Proceeds',
  'FV', 'Uncalled', 'MoIC', 'DPI', 'FX',
];

export const INVESTMENTS: TableData = {
  sheetName: 'Invs.',
  rows: ([
    INVESTMENT_HEADER,
    ['2024Q2', serial('2024-05-02'), 'Halyard Robotics', 'HR', 'EUR', 900_000, 500_000, 10,
      50_000, 50_000, 'Common (CS)', 2_000_000, 0.025, null, null, null, null, null, 1],
    ['2025Q1', serial('2025-02-10'), 'Halyard Robotics', 'HR', 'EUR', 900_000, 300_000, 12,
      25_000, 75_000, 'Series A Preferred (SA)', 2_000_000, 0.0375, null, null, null, null, null, 1],
    // A dollar holding, so a rate has to travel with the tranche.
    ['2025Q3', serial('2025-08-20'), 'Continuum Labs Inc.', 'CL', 'USD', 400_000, 220_000, 2.2,
      100_000, 100_000, 'Ordinary', 5_000_000, 0.02, null, null, null, null, null, 1.1],
  ] as Cell[][]),
};

export const PORTFOLIO: TableData = {
  sheetName: 'portfolio',
  rows: ([
    [],
    [null, null, null, null, null, null, 'Company', 'Country', 'Initial Investment', 'Additions',
      'Ownership', 'Investment', 'Realized ', 'Fair ', 'Total ', 'MoIC'],
    [null, null, null, null, null, null, null, null, null, null, '%', 'Cost', 'Proceeds', 'Value', 'Value'],
    [null, null, null, null, null, null, 'Halyard Robotics', 'DE', 500_000, 300_000, 0.0375,
      800_000, 0, 1_100_000, 1_100_000, 1.375],
    [null, null, null, null, null, null, 'Continuum Labs Inc.', 'USA', 220_000, null, 0.02,
      220_000, 0, 260_000, 260_000, 1.18],
    [null, null, null, null, null, null, 'Portfolio Totals', '—', 720_000, 300_000, null,
      1_020_000, 0, 1_360_000, 1_360_000, 1.33],
  ] as Cell[][]),
};

export const TRIAL_BALANCE: TableData = {
  sheetName: 'TB',
  rows: ([
    ['Supporting sheet'],
    [null, null, null, null, null, serial('2026-03-31'), serial('2026-06-30')],
    ['Balance Sheet', 'Fixed Assets', 'Investments at fair value', '1300-2020',
      'Other securities held as fixed assets', 1_200_000, 1_360_000],
    ['Balance Sheet', 'Current Assets', 'Cash and Cash equivalents', '1510-4010',
      'Bank account', 90_000, 120_000],
    ['Balance Sheet', 'Current Assets', 'Receivables', '1618-9650',
      'Other accounts receivable', 5_000, 4_000],
    // The trial balance signs what the fund owes negative.
    ['Balance Sheet', 'Liabilities', 'Accounts Payable', '2530-1310', 'Trade payables', -3_000, -2_500],
    ['Balance Sheet', 'Liabilities', 'Accrued expenses', '2610-6110', 'Accrued audit fees', -11_000, -13_000],
    ['P&L', 'Expenses', 'Audit & Legal', '6010-1600', 'Prof Fees - Audit Fees', -4_000, -8_000],
    ['P&L', 'Expenses', 'Management Fees', '6010-4000', 'Prof Fees - Fund Management Fees', -20_000, -40_000],
  ] as Cell[][]),
};

export function masterSheets(): TableData[] {
  return [README, SUMMARY, REGISTER, INVESTMENTS, PORTFOLIO, TRIAL_BALANCE];
}

/** The fixture as it stands, for a test that does not vary it. */
export const MASTER_WORKBOOK = masterSheets();

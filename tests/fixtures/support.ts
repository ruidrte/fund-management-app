/**
 * A quarterly reporting workbook, in the shape of a real one with invented
 * figures: a control panel, one ledger of movements, a balance sheet laid out
 * in columns, and the investors' own ledger.
 *
 * Every convention where a plausible wrong answer is available is in here on
 * purpose — a capitalised acquisition cost, a negative call that is a receipt,
 * a rate that moves inside a quarter, a number sitting in the NAV column of a
 * row that is not a valuation, and a marker row with no investor.
 */

import type { TableData } from '../../src/ingest/types';

const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

export const COVER: TableData = {
  sheetName: 'Cover',
  rows: [
    [0],
    [null, 'NORTHERN PENSION FOUNDATION'],
    [null, 'Anlagegruppe Baltic Infrastructure — BALT INFRA'],
    [null, 'Reporting support workbook'],
    [null, 'CONTROL PANEL'],
    [null, 'Reporting date', serial('2026-06-30'), null, '← every sheet reads this'],
    [null, 'Prior reporting date', serial('2026-03-31')],
    [null, 'Reporting currency', 'EUR'],
  ],
};

export const INVESTMENTS: TableData = {
  sheetName: 'Investments',
  rows: [
    ['INVESTMENTS — single ledger'],
    ['Replaces the three sheets it used to take'],
    [],
    ['Asset', 'Class', 'CCY', 'Date', 'Event', 'Comment', 'Commitment', 'Capital Call',
      'Acq cost', 'Other exp', 'Recallable', 'Distributions', 'NAV', 'FX rate'],
    ['Baltic Wind', 'Co-investment', 'EUR', serial('2025-01-15'), 'Commitment', 'Initial', 4_000_000, null, null, null, null, null, null, 1],
    ['Baltic Wind', 'Co-investment', 'EUR', serial('2025-02-01'), 'Capital call', 'CC#1', null, 2_000_000, null, null, null, null, null, 1],
    ['Baltic Wind', 'Co-investment', 'EUR', serial('2025-02-01'), 'Acq cost', 'Stamp duty', null, null, 20_000, null, null, null, null, 1],
    ['Baltic Wind', 'Co-investment', 'EUR', serial('2026-03-31'), 'NAV', 'NAV', null, null, null, null, null, null, 2_150_000, 1],
    ['Baltic Wind', 'Co-investment', 'EUR', serial('2026-05-10'), 'Capital call', 'Net receipt', null, -30_000, null, null, 5_000, null, null, 1],
    ['Baltic Wind', 'Co-investment', 'EUR', serial('2026-06-30'), 'NAV', 'NAV', null, null, null, null, null, null, 2_240_000, 1],
    // A sterling holding, with the rate moving inside the quarter.
    ['Sound Grid', 'Primary', 'GBP', serial('2025-03-01'), 'Commitment', 'Initial', 1_000_000, null, null, null, null, null, null, 1.2],
    ['Sound Grid', 'Primary', 'GBP', serial('2025-03-02'), 'Capital call', 'CC#1', null, 600_000, null, null, null, null, null, 1.2],
    ['Sound Grid', 'Primary', 'GBP', serial('2026-04-10'), 'Distribution', 'Dist #1', null, null, null, null, null, 40_000, 39_999, 1.5],
    ['Sound Grid', 'Primary', 'GBP', serial('2026-06-30'), 'NAV', 'NAV', null, null, null, null, null, null, 700_000, 1.1],
    [null, null, null, null, null, 'TOTAL (all dates)', 5_000_000, 2_570_000, 20_000],
  ],
};

export const BS: TableData = {
  sheetName: 'BS',
  rows: [
    [null, 'Vermögensrechnung', 'Bilan', 'Balance Sheet'],
    [],
    ['Mapping', 'AKTIVEN', 'ACTIFS', 'ASSETS', serial('2026-03-31'), '30.06.2026'],
    [null, null, null, null, 'EUR', 'EUR'],
    ['Cash', 'Flüssige Mittel', 'Disponibilités', 'Cash', 500_000, 620_000],
    ['ST receivables', 'Forderungen', 'Créances', 'Receivables', 1_000, 2_000],
    ['Accruals A', 'Aktive RA', 'Régularisation', 'Accrued income', 3_000, 0],
    ['ST Liabilities', 'Verbindlichkeiten', 'Engagements', 'Liabilities', 7_000, 9_000],
    ['Accruals P', 'Passive RA', 'Régularisation', 'Accrued expenses', 11_000, 13_000],
  ],
};

export const INVESTORS: TableData = {
  sheetName: 'Investors CF',
  rows: [
    [null, 'Date', 'ID', 'Short Name', 'Description', 'Comment', 'Commitment', 'Capital Called',
      'Other (fees)', 'Rebates', 'net cashflow'],
    [null, serial('2024-11-01'), 1, 'PK Nord', 'Initial Commitment', null, 3_000_000],
    [null, serial('2025-01-20'), 1, 'PK Nord', 'Capital Call #1', null, null, -1_500_000],
    [null, serial('2026-06-05'), 1, 'PK Nord', 'Rebate received', null, null, null, null, 4_000],
    [null, serial('2025-02-01'), 2, 'Baltic Trust', 'Initial Commitment', null, 2_000_000],
    [null, serial('2025-02-20'), 2, 'Baltic Trust', 'Capital Call #1', null, null, -900_000],
    // The fund's own marker rows carry no investor id and are not movements.
    [null, serial('2026-06-30'), null, 'BALT INFRA', 'NAV'],
  ],
};

export const supportSheets = (): TableData[] => [COVER, INVESTMENTS, BS, INVESTORS];

/** The fixture as it stands, for a test that does not vary it. */
export const SUPPORT_WORKBOOK = supportSheets();

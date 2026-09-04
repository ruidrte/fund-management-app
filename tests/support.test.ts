/**
 * Reading a quarterly reporting workbook.
 *
 * The fixture is the shape of a real one — a control panel, one ledger of
 * movements, a balance sheet in columns, an investors' ledger — with invented
 * figures. What is pinned is the handful of conventions where a plausible wrong
 * answer is available: a capitalised acquisition cost, a negative call, a
 * closing rate that must be the quarter's last, and a number sitting in the NAV
 * column of a row that is not a valuation.
 */

import { describe, expect, it } from 'vitest';
import { isSupportWorkbook, planSupportImport, summariseSupport } from '../src/ingest/support';
import type { TableData } from '../src/ingest/types';

const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

const COVER: TableData = {
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

const INVESTMENTS: TableData = {
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

const BS: TableData = {
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

const INVESTORS: TableData = {
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

const sheets = (): TableData[] => [COVER, INVESTMENTS, BS, INVESTORS];
const plan = () => planSupportImport(sheets(), { vehicleId: 'veh-balt' });

describe('recognising the workbook', () => {
  it('knows it by its dated ledger of investments', () => {
    expect(isSupportWorkbook(sheets())).toBe(true);
    expect(isSupportWorkbook([BS, INVESTORS])).toBe(false);
  });

  it('takes the product from the cover, not the house above it', () => {
    const summary = summariseSupport(sheets())!;

    expect(summary.fund).toBe('Anlagegruppe Baltic Infrastructure — BALT INFRA');
    expect(summary.currency).toBe('EUR');
    expect(summary.reportingDate).toBe('2026-06-30');
    expect(summary).toMatchObject({ holdings: 2, investors: 2, balanceSheets: 2 });
  });
});

describe('the portfolio ledger', () => {
  it('capitalises an acquisition cost instead of expensing it', () => {
    const { cashflows } = plan();
    const acquisition = cashflows.find((c) => c.description === 'Stamp duty')!;

    // Called capital, because the desk's own identity is "called = drawn plus
    // acquisition costs" — but it does not consume commitment.
    expect(acquisition.type).toBe('Capital Call');
    expect(acquisition.amount).toBe(-20_000);
    expect(acquisition.affectsCommitment).toBe(false);
  });

  it('follows the sign of a call rather than its column heading', () => {
    const { cashflows } = plan();
    const receipt = cashflows.find((c) => c.description === 'Net receipt')!;

    expect(receipt.type).toBe('Distribution');
    expect(receipt.amount).toBe(30_000);
  });

  it('signs calls out and distributions in, from the product’s side', () => {
    const { cashflows } = plan();

    expect(cashflows.find((c) => c.description === 'CC#1' && c.positionId?.includes('baltic'))!.amount)
      .toBe(-2_000_000);
    const distribution = cashflows.find((c) => c.description === 'Dist #1')!;
    expect(distribution.amount).toBe(40_000);
    expect(distribution.recallable).toBeUndefined();
  });

  it('marks a recallable distribution as one, so it can restore commitment', () => {
    const { cashflows } = plan();
    const recallable = cashflows.filter((c) => c.recallable);

    expect(recallable).toHaveLength(1);
    expect(recallable[0]).toMatchObject({ type: 'Distribution', amount: 5_000 });
  });

  it('reads a commitment as the commitment, not as a movement of cash', () => {
    const { positions } = plan();

    expect(positions.find((p) => p.name === 'Baltic Wind')!.commitment).toBe(4_000_000);
    expect(positions.find((p) => p.name === 'Sound Grid')!.commitment).toBe(1_000_000);
  });
});

describe('a figure in the NAV column of a row that is not a valuation', () => {
  it('is refused, and said so', () => {
    const { valuations, problems } = plan();
    const sound = valuations.filter((v) => v.positionId.includes('sound'));

    // The distribution row carried 39,999 in the NAV column. Reading it would
    // have put the holding at forty thousand instead of seven hundred.
    expect(sound.map((v) => v.nav)).toEqual([700_000]);
    expect(problems.join(' ')).toContain('Dist #1'.slice(0, 4));
    expect(problems.some((p) => p.includes('NAV column'))).toBe(true);
  });
});

describe('the rate a stock translates at', () => {
  it('is the last one in the quarter, not the first', () => {
    const { fxRates } = plan();
    const q2 = fxRates.find((r) => r.base === 'GBP' && r.period === '2026Q2')!;

    // 1.5 on 10 April, 1.1 at the quarter end. A stock translates at closing.
    expect(q2.rate).toBe(1.1);
    expect(q2.quote).toBe('EUR');
  });
});

describe('the balance sheet', () => {
  it('reads a column per quarter, whichever way the heading was typed', () => {
    const { balanceSheets } = plan();

    expect(balanceSheets.map((b) => b.period)).toEqual(['2026Q1', '2026Q2']);
    expect(balanceSheets[1]).toMatchObject({
      cash: 620_000,
      otherAssets: 2_000,
      currentLiabilities: 9_000,
      accruedExpenses: 13_000,
    });
  });

  it('groups receivables and prepayments as what is owed to the fund', () => {
    const { balanceSheets } = plan();

    expect(balanceSheets[0].otherAssets).toBe(1_000 + 3_000);
  });
});

describe('the investors', () => {
  it('takes their commitments and leaves the fund’s own marker rows out', () => {
    const { investors } = plan();

    expect(investors.map((i) => i.name)).toEqual(['PK Nord', 'Baltic Trust']);
    expect(investors[0]).toMatchObject({ commitment: 3_000_000, entryDate: '2024-11-01' });
  });

  it('files a rebate as a fee returned, so fees read net', () => {
    const { cashflows } = plan();
    const rebate = cashflows.find((c) => c.description === 'Rebate received')!;

    expect(rebate.type).toBe('Fee');
    expect(rebate.amount).toBe(4_000);
    expect(rebate.investorId).toBeDefined();
  });

  it('keeps investor movements off the portfolio', () => {
    const { cashflows } = plan();
    const investorFlows = cashflows.filter((c) => c.investorId);

    expect(investorFlows).toHaveLength(3);
    expect(investorFlows.every((c) => c.positionId === undefined)).toBe(true);
  });
});

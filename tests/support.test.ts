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
import { buildRateLookup } from '../src/engine/fx';
import { supportSheets as sheets, BS, INVESTORS } from './fixtures/support';

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

describe('the rates beside the movements', () => {
  it('are all kept, on the dates they are for', () => {
    const { fxRates } = plan();
    const gbp = fxRates
      .filter((r) => r.base === 'GBP')
      .sort((a, b) => a.date.localeCompare(b.date));

    // A movement was converted at the rate beside it. Keeping only the last one
    // in the quarter leaves every earlier conversion unreproducible, and the
    // capitalised costs it converted no longer tie to the accounting ledger.
    expect(gbp.map((r) => [r.date, r.rate])).toContainEqual(['2026-04-10', 1.5]);
    expect(gbp.map((r) => r.quote)).toEqual(gbp.map(() => 'EUR'));
  });

  it('still translate a stock at the closing rate, which is the last of them', () => {
    const { fxRates } = plan();
    const rates = buildRateLookup(fxRates);

    // 1.5 on 10 April, 1.1 at the quarter end. A stock translates at closing —
    // decided by the lookup now that the quarter holds more than one rate,
    // rather than by the reader having thrown the others away.
    expect(rates.tryRate('GBP', 'EUR', '2026Q2')).toBe(1.1);
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

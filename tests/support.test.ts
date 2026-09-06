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
import {
  supportSheets as sheets, registeredSheets, BS, INVESTMENTS, INVESTORS,
} from './fixtures/support';
import type { TableData } from '../src/ingest/types';

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

  it('carries the sign of a negative call without turning it into a distribution', () => {
    // A negative row in the call column is capital coming back out of the
    // denominator, not a distribution of profit. The workbook's own paid-in is
    // the sum of that column, so reading it as a distribution would put the
    // same amount into the numerator and the denominator at once — which moves
    // TVPI and DPI both, and away from what the source file states.
    const { cashflows } = plan();
    const receipt = cashflows.find((c) => c.description === 'Net receipt')!;

    expect(receipt.type).toBe('Capital Call');
    expect(receipt.amount).toBe(30_000);
    expect(receipt.affectsCommitment).toBe(true);
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

describe('a row that restates an earlier basis', () => {
  /** The same fixture with the two rows a change of basis is carried as. */
  const restated = () => {
    const rows = [...INVESTMENTS.rows];
    const total = rows.pop()!;
    rows.push(
      ['— Q2 2026 basis adjustments —'],
      ['Baltic Wind', 'Co-investment', 'EUR', 46_193, 'Basis adj', 'Equalisation reclassified',
        null, null, -20_000, null, null, null, null, 1],
      total,
    );
    return sheets().map((sheet) => (sheet.sheetName === 'Investments'
      ? { ...sheet, rows } as TableData
      : sheet));
  };

  it('keeps it in the ledger and marks it as a restatement', () => {
    const built = planSupportImport(restated(), { vehicleId: 'veh-balt' });
    const row = built.cashflows.find((c) => c.description === 'Equalisation reclassified')!;

    // Kept, because the basis it restates was published and the comparison
    // between the two is what the change has to be explained by.
    expect(row.amount).toBe(20_000);
    expect(row.restatement).toBe(true);
    expect(built.notes.some((n) => /1 basis adjustment/.test(n))).toBe(true);
  });

  it('leaves every other row alone', () => {
    const built = planSupportImport(restated(), { vehicleId: 'veh-balt' });
    expect(built.cashflows.filter((c) => c.restatement)).toHaveLength(1);
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

  it('are all kept when a date carries two different ones, and the clash is named', () => {
    // Two notices from the same fund on one day, converted at rates the
    // manager's own paperwork puts a week apart. Collapsing them to one
    // silently reconverts whichever movement lost.
    const rows = [...INVESTMENTS.rows];
    const total = rows.pop()!;
    rows.push(
      ['Sound Grid', 'Primary', 'GBP', 46_122, 'Distribution', 'Dist #2',
        null, null, null, null, null, 10_000, null, 1.42],
      total,
    );
    const clashing = sheets().map((sheet) => (sheet.sheetName === 'Investments'
      ? { ...sheet, rows } as TableData
      : sheet));
    const built = planSupportImport(clashing, { vehicleId: 'veh-balt' });

    const onTheDay = built.fxRates.filter((r) => r.base === 'GBP' && r.date === '2026-04-10');
    expect(onTheDay.map((r) => r.rate).sort()).toEqual([1.42, 1.5]);
    expect(built.problems.some((p) => /states 1.42 .* where an earlier row on the same date states 1.5/.test(p)))
      .toBe(true);
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

describe('the register the administrator is fed from', () => {
  const built = () => planSupportImport(registeredSheets(), { vehicleId: 'veh-balt' });

  it('reads the shares held and the account confirmed, per investor per quarter', () => {
    const facts = built().metrics.filter((m) => m.scope.kind === 'investor');
    const of = (name: string, metric: string) => facts.find(
      (m) => m.metric === metric && m.scope.id.includes(name),
    )?.value;

    expect(of('nord', 'units')).toBe(1_500);
    expect(of('nord', 'capitalAccount')).toBe(1_650_000);
    expect(of('baltic', 'units')).toBeCloseTo(818.1818, 4);
  });

  it('keeps shares issued against a call apart from shares held at a quarter end', () => {
    // The first says what was bought, the second what is owned. Only the second
    // can split a fund.
    const facts = built().metrics.filter((m) => m.scope.kind === 'investor');
    expect(facts.filter((m) => m.metric === 'unitsIssued')).toHaveLength(2);
    expect(facts.filter((m) => m.metric === 'units').every((m) => m.period === '2026Q2')).toBe(true);
  });

  it('joins the two sheets on the identifier they share, not on the names', () => {
    // `PK Nord` in the ledger, `Pensionskasse Nord` in the feed. Matching those
    // is guesswork where the file has given a number.
    expect(built().problems.some((p) => /match no investor/.test(p))).toBe(false);
  });

  it('says when the feed has not been rolled to the reported quarter', () => {
    const stale = registeredSheets().map((sheet) => (sheet.sheetName === 'OneSource'
      ? { ...sheet, rows: sheet.rows.filter((row) => row[3] !== 46_203) }
      : sheet));
    const behind = planSupportImport(stale, { vehicleId: 'veh-balt' });
    expect(behind.problems.some((p) => /register feed stops at/.test(p))).toBe(true);
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

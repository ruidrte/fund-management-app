/**
 * Reading an investment accounts workbook.
 *
 * The fixture is the shape of a real one — a ledger of every movement with
 * every holding, the administrator's statements in columns, the register feed
 * the capital accounts are written from, and the snapshot the desk publishes
 * — with invented figures. What is pinned is the handful of conventions where
 * a plausible wrong answer is available: a ledger signed from the fund's side,
 * an off-commitment column that runs both ways, a recallable distribution
 * kept as one, an unsigned register feed, and a carried-interest line that is
 * in the accounts and in nobody's capital account.
 */

import { describe, expect, it } from 'vitest';
import { isAccountsWorkbook, planAccountsImport, summariseAccounts } from '../src/ingest/accounts';
import { isSupportWorkbook } from '../src/ingest/support';
import { isMandateWorkbook } from '../src/ingest/mandate';
import { analyse } from '../src/engine';
import type { DataSet } from '../src/domain/types';
import {
  accountsSheets as sheets, serial, ACCOUNTS, ACCOUNTS_WITH_A_BROKEN_EURO_CELL, FS, REGISTER,
} from './fixtures/accounts';
import { supportSheets } from './fixtures/support';

const plan = () => planAccountsImport(sheets(), { vehicleId: 'veh-one' });

const flows = () => plan().cashflows;
const by = (description: string) => flows().find((c) => c.description === description)!;

describe('recognising the workbook', () => {
  it('knows it by its ledger of investment accounts', () => {
    expect(isAccountsWorkbook(sheets())).toBe(true);
    expect(isAccountsWorkbook([FS, REGISTER])).toBe(false);
  });

  it('is not mistaken for the reporting workbook, nor the other way round', () => {
    expect(isSupportWorkbook(sheets())).toBe(false);
    expect(isMandateWorkbook(sheets())).toBe(false);
    expect(isAccountsWorkbook(supportSheets())).toBe(false);
  });

  it('names the product from the register feed, which is the only place the file does', () => {
    const summary = summariseAccounts(sheets())!;
    expect(summary.fund).toBe('Compartment One');
    expect(summary.currency).toBe('EUR');
    expect(summary.reportingDate).toBe('2024-06-30');
    expect(summary).toMatchObject({ holdings: 3, investors: 2, balanceSheets: 2, first: '2024Q1', last: '2024Q2' });
  });
});

describe('the portfolio ledger', () => {
  it('turns every amount round, from the fund’s side to the vehicle’s', () => {
    expect(by('Capital Call #1').amount).toBe(-2_000_000);
    expect(by('Capital Call #1').affectsCommitment).toBe(true);
    expect(by('Distribution #2').amount).toBe(100_000);
  });

  it('keeps a negative call a call, out of the denominator and back into the commitment', () => {
    const returned = by('Return of excess');
    expect(returned.type).toBe('Capital Call');
    expect(returned.amount).toBe(50_000);
    expect(returned.affectsCommitment).toBe(true);
  });

  it('reads the off-commitment column both ways', () => {
    // Paid outside the commitment: in the return and in what was paid, and
    // not a draw on the commitment.
    const expense = by('Equalisation');
    expect(expense.type).toBe('Equalisation');
    expect(expense.amount).toBe(-30_000);
    expect(expense.affectsCommitment).toBe(false);

    // Received outside the commitment: money back, and not a distribution of
    // the commitment either.
    const income = by('Interest received');
    expect(income.type).toBe('Income');
    expect(income.amount).toBe(4_000);
  });

  it('keeps a recallable distribution as a distribution, marked', () => {
    const recallable = by('Distribution #1 (recallable)');
    expect(recallable.type).toBe('Distribution');
    expect(recallable.amount).toBe(200_000);
    expect(recallable.recallable).toBe(true);
    expect(by('Distribution #2').recallable).toBeUndefined();
  });

  it('classifies the holdings by the class column', () => {
    const kinds = Object.fromEntries(plan().positions.map((p) => [p.name, p.kind]));
    expect(kinds).toEqual({
      'Harbour Fund IV': 'fund', 'Solar Park Beta': 'co-investment', 'Beta GP SA': 'direct-investment',
    });
    expect(plan().positions.find((p) => p.name === 'Harbour Fund IV')).toMatchObject({
      currency: 'GBP', commitment: 5_000_000, commitmentDate: '2024-01-10', vintage: 2024,
    });
  });

  it('takes a valuation only from a row that says it is one', () => {
    const { valuations, problems } = plan();
    const beta = valuations.filter((v) => v.positionId.endsWith('solar-park-beta'));
    expect(beta.map((v) => [v.period, v.nav])).toEqual([['2024Q1', 3_010_000], ['2024Q2', 2_900_000]]);
    expect(problems.some((p) => p.includes('row 14') && p.includes('"CC #2" row'))).toBe(true);
    // And the call on that row is still a call.
    expect(by('CC #2').amount).toBe(-20_000);
  });

  it('keeps every rate the ledger states, in the direction the sheet writes it', () => {
    const { fxRates } = plan();
    const sterling = fxRates.filter((r) => r.base === 'GBP' && r.quote === 'EUR');
    expect(sterling.map((r) => [r.date, r.rate])).toEqual([
      ['2024-01-10', 1.15], ['2024-02-01', 1.16], ['2024-03-31', 1.17],
      ['2024-05-15', 1.18], ['2024-06-20', 1.18], ['2024-06-30', 1.19],
    ]);
    // A euro row states no rate worth keeping.
    expect(fxRates.some((r) => r.base === 'EUR')).toBe(false);
  });

  it('checks the euro columns against local times rate instead of reading them', () => {
    expect(plan().problems.some((p) => p.includes('euro column'))).toBe(false);
    const broken = planAccountsImport(
      sheets({ accounts: ACCOUNTS_WITH_A_BROKEN_EURO_CELL }), { vehicleId: 'veh-one' },
    );
    expect(broken.problems.some((p) => p.includes('Capital Call is 2,000,000.00 GBP at 1.16')
      && p.includes('2,300,000.00'))).toBe(true);
    // The figure filed is still the local one at the row's rate; the sheet's
    // overwritten cell changes nothing but the report of it.
    expect(broken.cashflows.find((c) => c.description === 'Capital Call #1')!.amount).toBe(-2_000_000);
  });

  it('keeps the commitment at the rate of the day it was made, beside the holding', () => {
    const frozen = plan().metrics.filter((m) => m.metric === 'accounts.commitmentAtCommitmentRate');
    expect(frozen.map((m) => [m.scope.id.split('-').pop(), m.value])).toEqual([
      ['iv', 5_750_000], ['beta', 3_000_000], ['sa', 10_000],
    ]);
  });

  it('keeps the FX policy as written', () => {
    const policy = plan().metrics.find((m) => m.metric === 'accounts.fxPolicy')!;
    expect(policy.scope).toEqual({ kind: 'vehicle', id: 'veh-one' });
    expect(policy.text).toContain('book of record for FX');
    expect(policy.text).toContain('ECB reference rate');
  });
});

describe('the financial statements', () => {
  it('reads the balance sheet by caption, a column per quarter', () => {
    const { balanceSheets } = plan();
    expect(balanceSheets.map((b) => b.period)).toEqual(['2024Q1', '2024Q2']);
    expect(balanceSheets[0]).toMatchObject({
      cash: 50_000, otherAssets: 1_500, currentLiabilities: 10_000, accruedExpenses: 30_000,
    });
  });

  it('leaves out a quarter the statements have a column for and no figures in', () => {
    expect(plan().balanceSheets.some((b) => b.period === '2024Q3')).toBe(false);
  });

  it('carries the theoretical carried interest as an accrual against the partners', () => {
    // Under partners' capital in the accounts and in no partner's capital
    // account, so the net asset value the capital accounts sum to is capital
    // and reserves less the carry.
    const q2 = plan().balanceSheets.find((b) => b.period === '2024Q2')!;
    expect(q2.accruedExpenses).toBe(25_000 + 400_000);
    expect(plan().metrics.find((m) => m.metric === 'fs.carriedInterest' && m.period === '2024Q2')!.value)
      .toBe(400_000);
    expect(plan().notes.some((n) => n.includes('400,000.00 EUR of carried interest'))).toBe(true);
  });

  it('keeps what the statements say the fund is worth and holds, for the check', () => {
    const stated = Object.fromEntries(
      plan().metrics.filter((m) => m.metric.startsWith('fs.') && m.period === '2024Q2')
        .map((m) => [m.metric, m.value]),
    );
    expect(stated).toEqual({
      'fs.investments': 5_490_000, 'fs.capitalAndReserves': 5_460_000,
      'fs.contributions': 3_012_000, 'fs.distributions': -90_000, 'fs.carriedInterest': 400_000,
    });
  });

  it('files the income statement year-to-date, against the quarter each column ends in', () => {
    const fees = plan().metrics.filter((m) => m.metric.startsWith('pl.ytd.managementFees'));
    expect(fees.map((m) => [m.period, m.value])).toEqual([['2024Q1', -15_000], ['2024Q2', -30_000]]);
  });
});

describe('the register feed', () => {
  it('knows an investor by the administrator’s identifier and takes the commitment from the subscription', () => {
    const { investors } = plan();
    expect(investors.map((i) => [i.id, i.name, i.commitment, i.entryDate])).toEqual([
      ['inv-compartment-one-1', 'Northern Pension', 4_000_000, '2024-01-15'],
      ['inv-compartment-one-2', 'Coastal Foundation', 2_000_000, '2024-04-15'],
    ]);
  });

  it('signs the feed by what each event is, from the vehicle’s side, whatever sign it came with', () => {
    const northern = flows().filter((c) => c.investorId === 'inv-compartment-one-1');
    const coastal = flows().filter((c) => c.investorId === 'inv-compartment-one-2');
    const amounts = (rows: typeof northern) => rows.map((c) => [c.type, c.amount, c.affectsCommitment]);

    expect(amounts(northern)).toEqual([
      ['Capital Call', 3_000_000, true],
      // Handed back to the earlier closer: a negative call, out of the
      // denominator and back into the commitment — not a distribution.
      ['Capital Call', -1_000_000, true],
      // The premium is named from the investor's side: received by them, paid
      // by the fund.
      ['Equalisation', -12_000, false],
      ['Distribution', -60_000, false],
    ]);
    expect(amounts(coastal)).toEqual([
      ['Capital Call', 1_000_000, true],
      ['Equalisation', 12_000, false],
      ['Distribution', -30_000, false],
    ]);
  });

  it('files the capital account statements as what the administrator confirmed', () => {
    const accounts = plan().metrics.filter((m) => m.metric === 'capitalAccount');
    expect(accounts.map((m) => [m.scope.id, m.period, m.value])).toEqual([
      ['inv-compartment-one-1', '2024Q1', 3_020_000],
      ['inv-compartment-one-1', '2024Q2', 3_540_000],
      ['inv-compartment-one-2', '2024Q2', 1_524_200],
    ]);
    expect(accounts[0].scope.kind).toBe('investor');
  });

  it('names an event it has no rule for rather than guessing', () => {
    expect(plan().problems.some((p) => p.includes('Transfer of interest'))).toBe(true);
    expect(flows().some((c) => c.amount === 1 || c.amount === -1)).toBe(false);
  });

  it('carries the feed’s own source against every movement', () => {
    expect(by('Capital call').sourceDetail).toBe('Admin prep file & Notices');
  });
});

describe('the snapshot', () => {
  it('keeps the desk’s published totals for the check, and reads no figure from them', () => {
    const stated = Object.fromEntries(
      plan().metrics.filter((m) => m.metric.startsWith('snapshot.')).map((m) => [m.metric, [m.period, m.value]]),
    );
    expect(stated).toEqual({
      'snapshot.commitment': ['2024Q2', 8_760_000],
      'snapshot.drawdown': ['2024Q2', 5_100_000],
      'snapshot.distributed': ['2024Q2', 100_000],
      'snapshot.nav': ['2024Q2', 5_494_200],
      'snapshot.openCommitment': ['2024Q2', 3_800_000],
      'snapshot.paidIn': ['2024Q2', 5_300_000],
    });
    expect(plan().valuations.some((v) => v.nav === 5_494_200)).toBe(false);
  });
});

describe('through the engine', () => {
  const dataset = (): DataSet => {
    const read = plan();
    return {
      client: { id: 'c', name: 'House', reportingCurrency: 'EUR' },
      vehicles: [{
        id: 'veh-one', clientId: 'c', name: 'Compartment One', shortName: 'One', kind: 'fund-of-funds',
        currency: 'EUR', inceptionDate: '2024-01-01',
        investorCommitment: read.investors.reduce((t, i) => t + i.commitment, 0),
        strategy: 'Infrastructure', status: 'Investing',
      }],
      positions: read.positions, assets: [], investors: read.investors,
      cashflows: read.cashflows, positionValuations: read.valuations, assetValuations: [],
      balanceSheets: read.balanceSheets, metrics: read.metrics, fxRates: read.fxRates,
      attributions: [], documents: [],
    } as unknown as DataSet;
  };

  it('ties the portfolio to the statements’ investments line', () => {
    const view = analyse(dataset(), { clientId: 'c', vehicleId: 'veh-one', period: '2024Q2' });
    // Harbour at the closing rate, Beta in euro, the GP stake at nothing.
    expect(view.gross.totals.nav).toBeCloseTo(2_180_000 * 1.19 + 2_900_000, 2);
    expect(view.gross.totals.nav).toBeCloseTo(5_494_200, 2);
  });

  it('reports the basis the desk agreed: off-commitment both ways in, recallable as returned', () => {
    const view = analyse(dataset(), { clientId: 'c', vehicleId: 'veh-one', period: '2024Q2' });
    const { totals } = view.gross;
    // Paid in: the calls at their own day's rate, plus the equalisation expense.
    expect(totals.paidIn).toBeCloseTo(2_000_000 * 1.16 + 3_000_000 - 50_000 + 20_000 + 10_000 + 30_000 * 1.18, 2);
    // Returned: the recallable and the permanent distribution, and the income.
    expect(totals.distributed).toBeCloseTo(200_000 + 100_000 + 4_000 * 1.18, 2);
    expect(totals.recallable).toBe(200_000);
    // What consumed the commitment is the calls alone.
    expect(totals.drawn).toBeCloseTo(2_000_000 * 1.16 + 3_000_000 - 50_000 + 20_000 + 10_000, 2);
  });

  it('sums the confirmed capital accounts to the net asset value less the carry', () => {
    const view = analyse(dataset(), { clientId: 'c', vehicleId: 'veh-one', period: '2024Q2' });
    expect(view.net.product.components.vehicleNav)
      .toBeCloseTo(5_494_200 + 8_000 + 2_000 - 15_000 - 25_000 - 400_000, 2);
    expect(view.net.product.components.vehicleNav).toBeCloseTo(3_540_000 + 1_524_200, 2);
    expect(view.net.product.called).toBe(3_000_000 + 1_000_000 - 1_000_000 + 12_000 - 12_000);
    expect(view.net.product.distributed).toBe(90_000);
    expect(view.checks.results.filter((r) => r.status === 'fail')).toEqual([]);
  });

  it('says so when the portfolio runs ahead of the statements', () => {
    const later = sheets({
      accounts: {
        ...ACCOUNTS,
        rows: [...ACCOUNTS.rows, [
          'Co-inv.', 'Solar Park Beta', serial('2024-09-30'), 'NAV', 'EUR', null, null, null, null, null, 2_950_000,
          null, null, null, null, null, 1, null, null, null, null, null, 2_950_000,
        ]],
      },
    });
    const read = planAccountsImport(later, { vehicleId: 'veh-one' });
    expect(read.problems.some((p) => p.includes('valued to 2024Q3') && p.includes('stop at 2024Q2'))).toBe(true);
  });
});

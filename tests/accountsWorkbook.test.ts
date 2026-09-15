/**
 * Writing an investment accounts workbook.
 *
 * Same discipline as the other writers: read a workbook, write the book back
 * out as one, read that, and the facts must be the same. The fixture is the
 * one the reader's own tests use, so what is pinned here is the writing.
 *
 * The interesting cases are where a fact and a column do not correspond one to
 * one: a ledger signed the other way round from the book, an off-commitment
 * column that carries two kinds of flow, a register feed with no sign on
 * anything and no event for a fee, a carried interest that is one line in the
 * statements and part of one field in the book, and a snapshot whose total is
 * the desk's figure rather than the sum of its lines.
 */

import { describe, expect, it } from 'vitest';
import { planAccountsImport } from '../src/ingest/accounts';
import { buildAccountsWorkbook } from '../src/export/accountsWorkbook';
import { toWorkbook } from '../src/export/serialise';
import { parseXlsx } from '../src/ingest/workbook';
import { verifyWorkbook, summariseVerification } from '../src/export/verify';
import { WORKBOOK_SHAPES, shapeFor } from '../src/export/workbooks';
import { DEFAULT_CONVENTIONS, type DataSet, type Vehicle } from '../src/domain/types';
import type { ImportPlan } from '../src/ingest/pfdb';
import { accountsSheets as sheets } from './fixtures/accounts';
import { supportSheets } from './fixtures/support';
import { planSupportImport } from '../src/ingest/support';

const VEHICLE = 'veh-one';
const PERIOD = '2024Q2';
const SHAPE = WORKBOOK_SHAPES.find((row) => row.id === 'accounts')!;
const at = '2024-07-15T09:00:00.000Z';

const vehicle: Vehicle = {
  id: VEHICLE,
  clientId: 'client-h',
  kind: 'fund-of-funds',
  name: 'Climate Opportunity Fund — Compartment One',
  shortName: 'Compartment One',
  currency: 'EUR',
  inceptionDate: '2024-01-01',
  investorCommitment: 6_000_000,
  status: 'Investing',
};

function book(plan: ImportPlan): DataSet {
  return {
    client: {
      id: 'client-h', name: 'House', shortName: 'H',
      reportingCurrency: 'EUR', conventions: DEFAULT_CONVENTIONS,
    },
    vehicles: [vehicle],
    positions: plan.positions,
    assets: plan.assets,
    investors: plan.investors,
    positionValuations: plan.valuations,
    assetValuations: plan.assetValuations,
    cashflows: plan.cashflows,
    balanceSheets: plan.balanceSheets,
    metrics: plan.metrics,
    fxRates: plan.fxRates,
  };
}

const first = planAccountsImport(sheets(), { vehicleId: VEHICLE, recordedAt: at });
const dataset = book(first);
const written = buildAccountsWorkbook({ dataset, vehicleId: VEHICLE, period: PERIOD });
const second = planAccountsImport(written.sheets, { vehicleId: VEHICLE, recordedAt: at });

describe('what is written', () => {
  it('is the sheets the reader reads, and the two the book keeps as checks', () => {
    expect(written.sheets.map((sheet) => sheet.sheetName))
      .toEqual(['Investment Accounts', 'Onesource', 'FS', 'Portfolio New', 'Two bases']);
    expect(written.filename).toBe('compartment-one_supporting_2024Q2');
    expect(written.problems).toEqual([]);
  });

  it('is recognised as the workbook it imitates, and is the shape this product takes', () => {
    expect(second.program).toBe('Compartment One');
    expect(shapeFor(vehicle, dataset)!.id).toBe('accounts');
    // A fund of funds whose book carries no statements arrived as a quarterly
    // reporting workbook, and goes back out as one.
    const support = planSupportImport(supportSheets(), { vehicleId: 'veh-balt' });
    expect(shapeFor(vehicle, book(support))!.id).toBe('support');
  });
});

describe('the round trip', () => {
  it('carries every fact of the book back through the reader', () => {
    const result = verifyWorkbook({ dataset, vehicleId: VEHICLE, period: PERIOD, shape: SHAPE });
    expect(summariseVerification(result, PERIOD)).toMatch(/read back unchanged/);
    expect(result.differences).toEqual([]);
    expect(result.compared).toBeGreaterThan(40);
  });

  it('is a workbook a spreadsheet can open, and this reader can read', () => {
    const reopened = parseXlsx(toWorkbook(written.sheets));
    const again = planAccountsImport(reopened.sheets, { vehicleId: VEHICLE, recordedAt: at });
    expect(again.positions.map((p) => p.name).sort()).toEqual(first.positions.map((p) => p.name).sort());
    expect(again.cashflows).toHaveLength(first.cashflows.length);
    expect(again.balanceSheets).toHaveLength(first.balanceSheets.length);
  });
});

describe('the ledger', () => {
  const rows = written.sheets.find((s) => s.sheetName === 'Investment Accounts')!.rows;
  const line = (comment: string) => rows.find((row) => row[3] === comment)!;

  it('signs the ledger the way the file does, calls positive and money back negative', () => {
    expect(line('Capital Call #1')[6]).toBe(2_000_000);
    expect(line('Distribution #2')[9]).toBe(-100_000);
    expect(line('Return of excess')[6]).toBe(-50_000);
  });

  it('puts both kinds of off-commitment flow in the one column, each with its sign', () => {
    expect(line('Equalisation')[7]).toBe(30_000);
    expect(line('Interest received')[7]).toBe(-4_000);
  });

  it('keeps a recallable distribution in its own column', () => {
    expect(line('Distribution #1 (recallable)')[8]).toBe(-200_000);
    expect(line('Distribution #1 (recallable)')[9]).toBeNull();
  });

  it('prices every row at the rate the ledger stated for its day, into the euro columns', () => {
    const call = line('Capital Call #1');
    expect(call[16]).toBe(1.16);
    expect(call[18]).toBeCloseTo(2_320_000, 6);
    const nav = rows.find((row) => row[1] === 'Harbour Fund IV' && row[3] === 'NAV' && row[2] === '2024-06-30')!;
    expect(nav[16]).toBe(1.19);
    expect(nav[22]).toBeCloseTo(2_180_000 * 1.19, 6);
  });

  it('writes the commitment in euro at the rate of the day it was made, not revalued', () => {
    const commitment = rows.find((row) => row[1] === 'Harbour Fund IV' && row[3] === 'Initial Commitment')!;
    expect(commitment[5]).toBe(5_000_000);
    expect(commitment[17]).toBe(5_750_000);
    expect(second.metrics.find((m) => m.metric === 'accounts.commitmentAtCommitmentRate' && m.scope.id.endsWith('iv'))!.value)
      .toBe(5_750_000);
  });

  it('writes the FX policy down its own column, where the reader finds it', () => {
    expect(rows[1][29]).toContain('book of record');
    expect(second.metrics.find((m) => m.metric === 'accounts.fxPolicy')!.text)
      .toBe(first.metrics.find((m) => m.metric === 'accounts.fxPolicy')!.text);
  });
});

describe('the register feed', () => {
  const rows = written.sheets.find((s) => s.sheetName === 'Onesource')!.rows;
  const of = (name: string) => rows.filter((row) => row[1] === name).map((row) => [row[4], row[5]]);

  it('writes every value positive and names the event, from the investor’s side', () => {
    expect(of('Northern Pension')).toEqual([
      ['Subscription', 4_000_000],
      ['Capital Call', 3_000_000],
      ['Capital Account Statement', 3_020_000],
      ['Equalization Distributed', 1_000_000],
      ['Equalization Premium received', 12_000],
      ['Dividend (Cash Distribution)', 60_000],
      ['Capital Account Statement', 3_540_000],
    ]);
    expect(of('Coastal Foundation')).toEqual([
      ['Subscription', 2_000_000],
      ['Equalization Called', 1_000_000],
      ['Equalization Premium paid', 12_000],
      ['Dividend (Cash Distribution)', 30_000],
      ['Capital Account Statement', 1_524_200],
    ]);
  });

  it('goes out under the administrator’s identifiers, so it comes back as the same investors', () => {
    expect(rows.slice(1).map((row) => row[2])).toContain('1');
    expect(second.investors.map((i) => i.id)).toEqual(first.investors.map((i) => i.id));
  });

  it('says so where the book holds a fee the feed has no event for', () => {
    const fee = {
      ...first.cashflows.find((c) => c.investorId)!,
      id: 'cf-fee', type: 'Fee' as const, amount: -1_500, description: 'Advisory fee',
    };
    const charged = buildAccountsWorkbook({
      dataset: { ...dataset, cashflows: [...dataset.cashflows, fee] }, vehicleId: VEHICLE, period: PERIOD,
    });
    expect(charged.problems.some((p) => p.includes('no event for a fee') && p.includes('1,500'.replace(',', '')))).toBe(true);
  });
});

describe('the statements', () => {
  const rows = written.sheets.find((s) => s.sheetName === 'FS')!.rows;
  const line = (caption: string) => rows.find((row) => row[3] === caption)!;

  it('takes the carried interest back out of the accruals and shows it under capital', () => {
    // Q2 is the sixth column: 2024Q1 then 2024Q2.
    expect(line('Creditors and accruals')[5]).toBe(25_000);
    expect(line('Theoretical Carried Interest to Initial Limited Partner')[5]).toBe(400_000);
    expect(second.balanceSheets.find((b) => b.period === '2024Q2')!.accruedExpenses).toBe(425_000);
  });

  it('states what the statements said of themselves, so the check survives the write', () => {
    expect(line('Investments:')[5]).toBe(5_490_000);
    expect(line('Capital and Reserves')[5]).toBe(5_460_000);
    expect(line('Limited Partners Contributions')[5]).toBe(3_012_000);
  });

  it('puts the income statement back into words the reader turns into the same names', () => {
    const fees = second.metrics.filter((m) => m.metric.startsWith('pl.ytd.managementFees'));
    expect(fees.map((m) => [m.period, m.value])).toEqual([['2024Q1', -15_000], ['2024Q2', -30_000]]);
    expect(rows.some((row) => typeof row[0] === 'string' && /P&L/.test(row[0]))).toBe(true);
  });
});

describe('the snapshot', () => {
  const rows = written.sheets.find((s) => s.sheetName === 'Portfolio New')!.rows;
  const total = rows.find((row) => row[0] === 'Total')!;

  it('carries the desk’s published total, not the sum of its own lines', () => {
    expect(total[14]).toBe(5_494_200);
    expect(total[12]).toBe(5_100_000);
    expect(total[18]).toBe(5_300_000);
    expect(second.metrics.find((m) => m.metric === 'snapshot.nav')!.value).toBe(5_494_200);
  });

  it('computes each line on capital drawn, with paid-in beside it', () => {
    const beta = rows.find((row) => row[2] === 'Solar Park Beta')!;
    // Calls 3,000,000 − 50,000 + 20,000 = 2,970,000, net of the 200,000
    // recallable; only the 100,000 permanent distribution returned.
    expect(beta[5]).toBeCloseTo(2_770_000, 6);
    expect(beta[6]).toBeCloseTo(100_000, 6);
    expect(beta[18]).toBeCloseTo(2_970_000, 6);
  });
});

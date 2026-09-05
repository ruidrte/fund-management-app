/**
 * Writing a quarterly reporting workbook.
 *
 * Same discipline as the other writer: read a workbook, write the book back out
 * as one, read that, and the facts must be the same. The fixture is the one the
 * reader's own tests use, so what is pinned here is the writing rather than the
 * reading.
 *
 * The interesting cases are the ones where a fact and a column do not
 * correspond one to one. Capital called that consumes commitment and capital
 * called that does not are one type here and two columns there. Receivables and
 * prepayments are two rows there and one field here. A quarter holds one
 * exchange rate per transaction date, and putting the closing one on every
 * movement converts each at a rate that was not the rate on the day.
 */

import { describe, expect, it } from 'vitest';
import { planSupportImport } from '../src/ingest/support';
import { buildSupportWorkbook } from '../src/export/supportWorkbook';
import { toWorkbook } from '../src/export/serialise';
import { parseXlsx } from '../src/ingest/workbook';
import { verifyWorkbook, summariseVerification } from '../src/export/verify';
import { WORKBOOK_SHAPES } from '../src/export/workbooks';
import { DEFAULT_CONVENTIONS, type DataSet } from '../src/domain/types';
import type { ImportPlan } from '../src/ingest/pfdb';
import { SUPPORT_WORKBOOK } from './fixtures/support';

const VEHICLE = 'veh-balt';
const PERIOD = '2026Q2';
const SHAPE = WORKBOOK_SHAPES.find((row) => row.id === 'support')!;

function book(plan: ImportPlan): DataSet {
  return {
    client: {
      id: 'client-n', name: 'Northern Pension Foundation', shortName: 'NPF',
      reportingCurrency: 'EUR', conventions: DEFAULT_CONVENTIONS,
    },
    vehicles: [{
      id: VEHICLE,
      clientId: 'client-n',
      kind: 'fund-of-funds',
      name: 'Anlagegruppe Baltic Infrastructure — BALT INFRA',
      shortName: 'BALT INFRA',
      currency: 'EUR',
      unitScale: 1,
      inceptionDate: '2025-01-15',
      investorCommitment: 5_000_000,
      status: 'Investing',
    }],
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

const at = '2026-09-01T00:00:00.000Z';
const first = planSupportImport(SUPPORT_WORKBOOK, { vehicleId: VEHICLE, recordedAt: at });
const written = buildSupportWorkbook({ dataset: book(first), vehicleId: VEHICLE, period: PERIOD });
const second = planSupportImport(written.sheets, { vehicleId: VEHICLE, recordedAt: at });

describe('what is written', () => {
  it('is the sheets a person types into, and not the ones a spreadsheet works out', () => {
    expect(written.sheets.map((sheet) => sheet.sheetName))
      .toEqual(['Cover', 'Investments', 'BS', 'P&L', 'Investors CF']);
    expect(written.filename).toBe('balt-infra_reporting_2026Q2');
  });

  it('is recognised as the workbook it imitates', () => {
    expect(second.positions.length).toBeGreaterThan(0);
    expect(second.program).toBe(first.program);
  });
});

describe('what comes back out', () => {
  const names = (plan: ImportPlan) => new Map(plan.positions.map((p) => [p.id, p.name]));

  it('is the same holdings, on the same terms', () => {
    const shape = (plan: ImportPlan) => plan.positions
      .map((p) => `${p.name}|${p.currency}|${p.kind}|${Math.round(p.commitment)}`).sort();
    expect(shape(second)).toEqual(shape(first));
  });

  it('is the same valuations', () => {
    const shape = (plan: ImportPlan) => plan.valuations
      .map((v) => `${names(plan).get(v.positionId)}|${v.period}|${v.nav}`).sort();
    expect(shape(second)).toEqual(shape(first));
  });

  it('keeps a capitalised cost apart from a drawdown, which are one type and two columns', () => {
    const shape = (plan: ImportPlan) => plan.cashflows
      .filter((c) => c.type === 'Capital Call' && c.positionId)
      .map((c) => `${c.date}|${c.amount}|${c.affectsCommitment ? 'drawn' : 'capitalised'}`).sort();
    expect(shape(first)).toContain('2025-02-01|-20000|capitalised');
    expect(shape(second)).toEqual(shape(first));
  });

  it('keeps a recallable distribution recallable', () => {
    const shape = (plan: ImportPlan) => plan.cashflows
      .filter((c) => c.type === 'Distribution')
      .map((c) => `${c.date}|${c.amount}|${c.recallable ?? false}`).sort();
    expect(shape(first).some((row) => row.endsWith('|true'))).toBe(true);
    expect(shape(second)).toEqual(shape(first));
  });

  it('is the same capital accounts, including a rebate filed as a fee', () => {
    expect(second.investors.map((i) => `${i.name}|${i.commitment}|${i.entryDate}`).sort())
      .toEqual(first.investors.map((i) => `${i.name}|${i.commitment}|${i.entryDate}`).sort());
    const fees = (plan: ImportPlan) => plan.cashflows
      .filter((c) => c.investorId).map((c) => `${c.type}|${c.date}|${c.amount}`).sort();
    expect(fees(second)).toEqual(fees(first));
  });

  it('is the same balance sheet, though two of its rows are one field here', () => {
    const shape = (plan: ImportPlan) => plan.balanceSheets
      .map((b) => `${b.period}|${b.cash}|${b.otherAssets}|${b.currentLiabilities}|${b.accruedExpenses}`)
      .sort();
    // 1,000 of receivables and 3,000 of prepayments went in; 4,000 of
    // receivables and nothing prepaid comes back, and the field they share is
    // unchanged. Nothing is invented for a row that cannot be reconstructed.
    expect(shape(second)).toEqual(shape(first));
  });

  it('puts each movement back at the rate it was converted at, not the quarter’s', () => {
    const shape = (plan: ImportPlan) => plan.fxRates
      .map((r) => `${r.base}/${r.quote}|${r.date}|${r.rate}`).sort();
    expect(shape(first)).toContain('GBP/EUR|2026-04-10|1.5');
    expect(shape(first)).toContain('GBP/EUR|2026-06-30|1.1');
    expect(shape(second)).toEqual(shape(first));
  });
});

describe('the check on it', () => {
  it('passes, and says how much it looked at', () => {
    const result = verifyWorkbook({
      dataset: book(first), vehicleId: VEHICLE, period: PERIOD, shape: SHAPE,
    });
    expect(result.failure).toBeUndefined();
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(summariseVerification(result, PERIOD)).toContain('read back unchanged');
  });

  it('reports a look-through company, which this workbook has nowhere to put', () => {
    const dataset = book(first);
    const result = verifyWorkbook({
      dataset: {
        ...dataset,
        assets: [{
          id: 'ast-x',
          positionId: dataset.positions[0].id,
          name: 'A wind farm',
          currency: 'EUR',
          investmentDate: '2025-02-01',
          ownership: 1,
          assetClass: 'Infrastructure',
          sector: 'Energy',
          region: 'Baltics',
          country: 'Estonia',
          status: 'Held',
        }],
      },
      vehicleId: VEHICLE,
      period: PERIOD,
      shape: SHAPE,
    });
    expect(result.ok).toBe(false);
    expect(result.differences.some((d) => /compan.*does not carry/.test(d.what))).toBe(true);
  });
});

describe('the file itself', () => {
  it('is a workbook a spreadsheet can open, and this reader can read', () => {
    const bytes = toWorkbook(written.sheets);
    const reopened = parseXlsx(bytes);
    const again = planSupportImport(reopened.sheets, { vehicleId: VEHICLE });
    expect(again.positions).toHaveLength(first.positions.length);
    expect(again.cashflows).toHaveLength(first.cashflows.length);
    expect(again.problems).toEqual([]);
  });
});

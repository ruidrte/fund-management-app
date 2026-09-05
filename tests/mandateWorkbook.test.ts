/**
 * The round trip.
 *
 * The workbook is the contract between this system and the deck that gets sent,
 * so what has to hold is not that the emitted file looks right — it is that the
 * facts survive it. Read a workbook, write the book back out as one, read that,
 * and the two sets of facts must agree.
 *
 * The interesting failures are the quiet ones: a column the reader kept under a
 * derived name and the writer has no heading for, a narrative that came back as
 * a number, a property's city dropped because the model has no field for it, a
 * derived valuation emitted as though the manager had reported it. Each of
 * those is a test here.
 */

import { describe, expect, it } from 'vitest';
import { planMandateImport } from '../src/ingest/mandate';
import { buildMandateWorkbook } from '../src/export/mandateWorkbook';
import { toWorkbook } from '../src/export/serialise';
import { summariseVerification, verifyWorkbook } from '../src/export/verify';
import { WORKBOOK_SHAPES } from '../src/export/workbooks';

const SHAPE = WORKBOOK_SHAPES.find((row) => row.id === 'mandate')!;
import { parseXlsx } from '../src/ingest/workbook';
import type { ImportPlan } from '../src/ingest/pfdb';
import type { DataSet } from '../src/domain/types';
import { DEFAULT_CONVENTIONS } from '../src/domain/types';
import { MANDATE_WORKBOOK } from './fixtures/mandate';

const VEHICLE = 'veh-mandate';
const PERIOD = '2024Q2';

/** The book, as it would stand after one import of that workbook. */
function book(plan: ImportPlan): DataSet {
  return {
    client: {
      id: 'client-x', name: 'A house', shortName: 'X', reportingCurrency: 'USD',
      conventions: DEFAULT_CONVENTIONS,
    },
    vehicles: [{
      id: VEHICLE,
      clientId: 'client-x',
      kind: 'mandate',
      name: 'Rowan Housing Fund I and II',
      shortName: 'Rowan',
      currency: 'USD',
      unitScale: 1,
      inceptionDate: '2021-01-20',
      investorCommitment: 15_000_000,
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

const first = planMandateImport(MANDATE_WORKBOOK, { vehicleId: VEHICLE, recordedAt: '2024-07-01T00:00:00.000Z' });
const emitted = buildMandateWorkbook({ dataset: book(first), vehicleId: VEHICLE, period: PERIOD });
const second = planMandateImport(emitted.sheets, { vehicleId: VEHICLE, recordedAt: '2024-07-01T00:00:00.000Z' });

describe('what comes back out', () => {
  it('is still recognisably the same workbook', () => {
    const names = emitted.sheets.map((sheet) => sheet.sheetName);
    expect(names).toContain('00 README');
    expect(names).toContain('01 CONTROL');
    expect(names).toContain('10 ASSETS');
    expect(names).toContain('20 QUARTER I');
    expect(names).toContain('21 QUARTER II');
    expect(names).toContain('40 LEDGER');
    expect(emitted.filename).toBe('rowan_support_2024Q2');
  });

  it('is read back as the same funds, on the same terms', () => {
    expect(second.positions.map((p) => [p.name, p.commitment, p.ownership]))
      .toEqual(first.positions.map((p) => [p.name, p.commitment, p.ownership]));
  });

  it('is read back as the same capital account', () => {
    const flows = (plan: ImportPlan) => plan.cashflows
      .map((c) => [c.type, c.date, c.amount, Boolean(c.investorId)])
      .sort();
    expect(flows(second)).toEqual(flows(first));
  });

  it('is read back as the same valuations, to the unit', () => {
    const navs = (plan: ImportPlan) => plan.valuations
      .map((v) => [v.positionId, v.period, Math.round(v.nav)])
      .sort();
    expect(navs(second)).toEqual(navs(first));
  });

  it('is read back as the same properties, with the same look-through', () => {
    expect(second.assets.map((a) => a.name).sort())
      .toEqual(first.assets.map((a) => a.name).sort());
    const values = (plan: ImportPlan) => plan.assetValuations
      .map((v) => [v.period, v.invested, v.realised, v.unrealised]).sort();
    expect(values(second)).toEqual(values(first));
  });

  it('does not lose a property’s city, which the model has no field for', () => {
    const rowan = second.assets.find((a) => a.name === 'Rowan Court')!;
    expect(rowan.attributes?.City).toBe('Denver');
    expect(rowan.attributes?.State).toBe('CO');
    expect(rowan.attributes?.Units).toBe(100);
  });

  it('does not lose a column nobody had mapped', () => {
    const roof = (plan: ImportPlan) => plan.metrics
      .filter((m) => m.metric === 'reported.roofAge' && m.period === PERIOD)
      .map((m) => m.value).sort();
    expect(roof(first)).not.toEqual([]);
    expect(roof(second)).toEqual(roof(first));
  });

  it('does not turn a sentence into a number, or lose it', () => {
    const driver = second.metrics.find(
      (m) => m.metric === 'narrative.driver' && m.scope.id.endsWith('a1') && m.period === PERIOD,
    );
    expect(driver?.text).toBe('Cap rate held; the lift is operating income.');
    expect(driver?.value).toBeUndefined();
  });

  it('brings every metric back, for every property and quarter', () => {
    const shape = (plan: ImportPlan) => plan.metrics
      .map((m) => `${m.scope.kind}/${m.period}/${m.metric}/${m.value ?? m.text}`)
      .sort();
    expect(shape(second)).toEqual(shape(first));
  });
});

describe('what the emitted workbook says about itself', () => {
  it('names every figure that was not reported for its own quarter', () => {
    const rows = emitted.sheets.find((s) => s.sheetName === '05 BASIS')!.rows;
    const derived = rows.filter((row) => String(row[3] ?? '').includes('derived'));
    // Every closed quarter is the fund's own figure at the holder's paid-in
    // share; only the quarter the ledger closes on is the capital account.
    expect(derived.length).toBe(
      first.valuations.filter((v) => /derived/.test(v.source)).length,
    );
    expect(rows.some((row) => String(row[3] ?? '').includes('capital account'))).toBe(false);
  });

  it('states the quarter and the knowledge date it was written for', () => {
    const readme = emitted.sheets.find((s) => s.sheetName === '00 README')!.rows.flat();
    expect(readme).toContain('Q2 2024');
    expect(readme).toContain('Everything known now');
  });

  it('says so when the book has no closing rate for the quarter', () => {
    expect(emitted.problems.some((p) => /No closing rate/.test(p))).toBe(true);
  });
});

describe('the file itself', () => {
  it('is a workbook a spreadsheet can open, and this reader can read', () => {
    const bytes = toWorkbook(emitted.sheets);
    const reopened = parseXlsx(bytes);
    expect(reopened.sheets.map((s) => s.sheetName)).toEqual(
      emitted.sheets.map((s) => s.sheetName),
    );
    const again = planMandateImport(reopened.sheets, { vehicleId: VEHICLE });
    expect(again.positions).toHaveLength(2);
    expect(again.assets).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * The check, and what it is worth
 *
 * A check that cannot fail is not a check. These put things in the book that
 * the workbook has no column for, and expect to be told.
 * ------------------------------------------------------------------ */

describe('the check the application runs on a real book', () => {
  const dataset = book(first);

  it('passes on a book that came from a workbook, and says how much it looked at', () => {
    const result = verifyWorkbook({ dataset, vehicleId: VEHICLE, period: PERIOD, shape: SHAPE });
    expect(result.failure).toBeUndefined();
    expect(result.compared).toBeGreaterThanOrEqual(first.metrics.length);
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(summariseVerification(result, PERIOD)).toContain('read back unchanged');
  });

  it('reports a movement of a kind the ledger has no column for', () => {
    const result = verifyWorkbook({
      dataset: {
        ...dataset,
        cashflows: [...dataset.cashflows, {
          id: 'cf-odd',
          vehicleId: VEHICLE,
          positionId: dataset.positions[0].id,
          type: 'Return of Capital',
          amount: 250_000,
          currency: 'USD',
          date: '2024-05-02',
          period: PERIOD,
          recordedAt: '2024-07-01T00:00:00.000Z',
          affectsCommitment: false,
          status: 'Settled',
        }],
      },
      vehicleId: VEHICLE,
      period: PERIOD,
      shape: SHAPE,
    });
    expect(result.ok).toBe(false);
    expect(result.differences.some((d) => /movement.*does not carry/.test(d.what))).toBe(true);
    expect(result.differences.flatMap((d) => d.examples).join(' ')).toContain('Return of Capital');
  });

  it('reports a balance sheet, which an adviser’s workbook has nowhere to put', () => {
    const result = verifyWorkbook({
      dataset: {
        ...dataset,
        balanceSheets: [{
          vehicleId: VEHICLE,
          period: PERIOD,
          recordedAt: '2024-07-01T00:00:00.000Z',
          cash: 100_000,
          otherAssets: 0,
          currentLiabilities: 0,
          accruedExpenses: 0,
          source: 'Typed in',
        }],
      },
      vehicleId: VEHICLE,
      period: PERIOD,
      shape: SHAPE,
    });
    expect(result.ok).toBe(false);
    expect(result.differences.some((d) => /balance sheet.*does not carry/.test(d.what))).toBe(true);
  });

  it('reports a figure filed against the product itself, which has no column', () => {
    const result = verifyWorkbook({
      dataset: {
        ...dataset,
        metrics: [...dataset.metrics, {
          id: 'met-odd',
          scope: { kind: 'vehicle', id: VEHICLE },
          period: PERIOD,
          recordedAt: '2024-07-01T00:00:00.000Z',
          metric: 'esg.scope1',
          value: 42,
          source: 'Typed in',
        }],
      },
      vehicleId: VEHICLE,
      period: PERIOD,
      shape: SHAPE,
    });
    expect(result.ok).toBe(false);
    expect(result.differences.flatMap((d) => d.examples).join(' ')).toContain('esg.scope1');
  });
});

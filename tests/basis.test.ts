/**
 * The bases a return can be measured on.
 *
 * One holding, four answers, all four correct. What is pinned here is that they
 * are cumulative — the gap between any two is exactly what the wider one admits
 * — and that the fourth restates each flow at the rate of its own date rather
 * than at one rate for the quarter, which is a different number and a wrong one.
 */

import { describe, expect, it } from 'vitest';
import { returnBases, type BasisKey } from '../src/engine/basis';
import type { Cashflow, FxRate, PositionValuation } from '../src/domain/types';

const POSITION = 'pos-1';
const RECORDED = '2026-07-01T00:00:00.000Z';

function flow(
  date: string, amount: number, type: Cashflow['type'],
  side: 'position' | 'investor', description: string,
): Cashflow {
  return {
    id: `cf-${date}-${type}-${amount}`,
    vehicleId: 'veh-1',
    positionId: side === 'position' ? POSITION : undefined,
    investorId: side === 'investor' ? 'inv-1' : undefined,
    chargedFor: side === 'investor' ? POSITION : undefined,
    type,
    amount,
    currency: 'USD',
    date,
    period: `${date.slice(0, 4)}Q${Math.floor(Number(date.slice(5, 7)) / 3.01) + 1}`,
    recordedAt: RECORDED,
    affectsCommitment: type === 'Capital Call',
    description,
    status: 'Settled',
  };
}

const CASHFLOWS: Cashflow[] = [
  flow('2024-01-15', 20_000_000, 'Commitment', 'position', 'Commitment'),
  flow('2024-02-01', -1_000_000, 'Capital Call', 'position', 'Capital call #1'),
  flow('2024-02-01', -50_000, 'Equalisation', 'position', 'Interest-equivalent compensation'),
  flow('2024-04-01', -10_000, 'Fee', 'investor', 'Adviser fee (Q1 2024)'),
  flow('2025-01-15', -500_000, 'Capital Call', 'position', 'Capital call #2'),
  flow('2025-06-30', 100_000, 'Distribution', 'position', 'Distribution #1'),
  flow('2026-04-01', -10_000, 'Fee', 'investor', 'Adviser fee (Q1 2026)'),
];

const VALUATIONS: PositionValuation[] = [
  { id: 'v1', positionId: POSITION, period: '2026Q2', recordedAt: RECORDED, nav: 1_600_000, source: 'x' },
];

function rate(date: string, value: number, kind: 'closing' | 'average'): FxRate {
  return {
    id: `fx-${date}-${kind}`, base: 'USD', quote: 'CHF', rate: value,
    date, period: '2026Q2', recordedAt: RECORDED, kind, source: 'ledger',
  };
}

const RATES: FxRate[] = [
  rate('2024-02-01', 0.90, 'closing'),
  rate('2024-04-01', 0.92, 'average'),
  rate('2025-01-15', 0.88, 'closing'),
  rate('2025-06-30', 0.86, 'closing'),
  rate('2026-04-01', 0.78, 'average'),
  // A quarter end carries two: the fee settled that day at the quarter's
  // average, and the rate the book is struck at.
  rate('2026-06-30', 0.79, 'average'),
  rate('2026-06-30', 0.81, 'closing'),
];

const bases = (restateIn?: string) => returnBases({
  cashflows: CASHFLOWS,
  valuations: VALUATIONS,
  fxRates: RATES,
  positionId: POSITION,
  currency: 'USD',
  period: '2026Q2',
  restateIn,
});

const of = (key: BasisKey, restateIn?: string) => bases(restateIn).find((b) => b.key === key)!;

describe('what each basis admits', () => {
  it('measures the commitment being drawn and returned, and nothing else', () => {
    const basis = of('on-commitment');
    expect(basis.paidIn).toBe(1_500_000);
    expect(basis.distributed).toBe(100_000);
    expect(basis.residual).toBe(1_600_000);
    expect(basis.flows).toBe(3);
  });

  it('never counts a commitment as cash', () => {
    // A commitment is a promise. Admitting it would put twenty million of
    // capital into a return that never received it.
    expect(of('on-commitment').paidIn).toBe(1_500_000);
    expect(of('after-fees').flows).toBe(6);
  });

  it('adds the flows with the fund that sit outside the commitment', () => {
    const basis = of('with-off-commitment');
    expect(basis.paidIn).toBe(1_550_000);
    expect(basis.flows).toBe(4);
    // The equalisation is capital paid in on this basis and invisible on the
    // one before it, so the return is lower by exactly what it cost.
    expect(basis.irr!).toBeLessThan(of('on-commitment').irr!);
  });

  it('adds what the holder paid the adviser, which the fund never saw', () => {
    const basis = of('after-fees');
    expect(basis.paidIn).toBe(1_570_000);
    expect(basis.flows).toBe(6);
    expect(basis.irr!).toBeLessThan(of('with-off-commitment').irr!);
  });

  it('keeps TVPI equal to DPI plus RVPI on every basis', () => {
    for (const basis of bases('CHF')) {
      expect(basis.tvpi!).toBeCloseTo(basis.dpi! + basis.rvpi!, 12);
    }
  });

  it('offers no restatement when there is nothing to restate into', () => {
    expect(bases().map((b) => b.key))
      .toEqual(['on-commitment', 'with-off-commitment', 'after-fees']);
    expect(bases('USD')).toHaveLength(3);
  });
});

describe('restating into the holder’s own currency', () => {
  it('converts each flow at the rate of its own date, not at one rate', () => {
    const basis = of('restated', 'CHF');
    // 1,000,000 at 0.90 + 500,000 at 0.88 + 50,000 at 0.90 + 10,000 at 0.92
    // + 10,000 at 0.78.
    expect(basis.paidIn).toBeCloseTo(900_000 + 440_000 + 45_000 + 9_200 + 7_800, 6);
    expect(basis.distributed).toBeCloseTo(86_000, 6);
    expect(basis.currency).toBe('CHF');
  });

  it('restates the valuation at the closing rate where a date carries two', () => {
    // 2026-06-30 holds both the quarter's average, at which the last fee was
    // invoiced, and the rate the book is struck at. Taking the average would
    // move the whole residual value by the spread.
    expect(of('restated', 'CHF').residual).toBeCloseTo(1_600_000 * 0.81, 6);
  });

  it('invoices a fee at the average and moves cash at the closing rate', () => {
    const withLateFee = returnBases({
      cashflows: [...CASHFLOWS, flow('2026-06-30', -20_000, 'Fee', 'investor', 'Adviser fee (Q2 2026)')],
      valuations: VALUATIONS,
      fxRates: RATES,
      positionId: POSITION,
      currency: 'USD',
      period: '2026Q2',
      restateIn: 'CHF',
    }).find((b) => b.key === 'restated')!;
    // The fee at 0.79, the average — not at the 0.81 the valuation uses.
    expect(withLateFee.paidIn - of('restated', 'CHF').paidIn).toBeCloseTo(20_000 * 0.79, 6);
  });

  it('leaves out a flow with no rate and names it rather than guessing one', () => {
    const gap = returnBases({
      cashflows: [...CASHFLOWS, flow('2026-05-04', 250_000, 'Distribution', 'position', 'Distribution #2')],
      valuations: VALUATIONS,
      fxRates: RATES,
      positionId: POSITION,
      currency: 'USD',
      period: '2026Q2',
      restateIn: 'CHF',
    }).find((b) => b.key === 'restated')!;
    expect(gap.missing).toEqual(['Distribution #2 on 2026-05-04']);
    expect(gap.distributed).toBeCloseTo(86_000, 6);
  });

  it('says the valuation could not be restated when no rate reaches the quarter end', () => {
    const gap = returnBases({
      cashflows: CASHFLOWS,
      valuations: VALUATIONS,
      fxRates: RATES.filter((r) => r.date < '2026-01-01'),
      positionId: POSITION,
      currency: 'USD',
      period: '2026Q2',
      restateIn: 'CHF',
    }).find((b) => b.key === 'restated')!;
    // The last rate before the quarter end stands in, so nothing is lost.
    expect(gap.residual).toBeCloseTo(1_600_000 * 0.86, 6);
    expect(gap.missing).toEqual(['Adviser fee (Q1 2026) on 2026-04-01']);
  });
});

describe('what it refuses to state', () => {
  it('has no return without a flow of each sign', () => {
    const nothing = returnBases({
      cashflows: [flow('2026-01-01', -100, 'Capital Call', 'position', 'Call')],
      valuations: [],
      fxRates: [],
      positionId: POSITION,
      currency: 'USD',
      period: '2026Q2',
    });
    expect(nothing.every((basis) => basis.irr === undefined)).toBe(true);
    expect(nothing[0].rvpi).toBe(0);
  });

  it('ignores a draft flow and a flow dated after the quarter', () => {
    const later = returnBases({
      cashflows: [
        ...CASHFLOWS,
        { ...flow('2026-09-01', 900_000, 'Distribution', 'position', 'After the quarter') },
        { ...flow('2026-05-01', 800_000, 'Distribution', 'position', 'Not settled'), status: 'Draft' },
      ],
      valuations: VALUATIONS,
      fxRates: RATES,
      positionId: POSITION,
      currency: 'USD',
      period: '2026Q2',
    }).find((b) => b.key === 'on-commitment')!;
    expect(later.distributed).toBe(100_000);
  });
});

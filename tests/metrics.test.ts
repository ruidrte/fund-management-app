import { describe, expect, it } from 'vitest';
import { annualise, compound, irrWithTerminalValue, multiples, npv, xirr } from '../src/engine/metrics';

const d = (iso: string) => new Date(iso);

describe('xirr', () => {
  it('recovers a known rate', () => {
    // -1000 today, 1100 in a year is 10%.
    const rate = xirr([
      { date: d('2025-01-01'), amount: -1000 },
      { date: d('2026-01-01'), amount: 1100 },
    ]);
    expect(rate).toBeCloseTo(0.1, 4);
  });

  it('matches Excel XIRR on an irregular private-markets schedule', () => {
    const rate = xirr([
      { date: d('2020-06-30'), amount: -10_000 },
      { date: d('2021-03-31'), amount: -5_000 },
      { date: d('2023-09-30'), amount: 4_000 },
      { date: d('2026-03-31'), amount: 18_500 },
    ]);
    expect(rate).toBeCloseTo(0.08403, 4);
  });

  it('solves a late-distribution shape that defeats Newton alone', () => {
    const flows = Array.from({ length: 12 }, (_, i) => ({
      date: d(`20${20 + Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, '0')}-01`),
      amount: -1000,
    }));
    flows.push({ date: d('2026-01-01'), amount: 30_000 });
    const rate = xirr(flows);
    expect(rate).toBeDefined();
    expect(npv(rate!, flows)).toBeCloseTo(0, 4);
  });

  it('returns undefined rather than a wrong root when no rate exists', () => {
    expect(xirr([{ date: d('2025-01-01'), amount: -100 }])).toBeUndefined();
    expect(xirr([
      { date: d('2025-01-01'), amount: -100 },
      { date: d('2026-01-01'), amount: -100 },
    ])).toBeUndefined();
  });

  it('adds residual value as a terminal inflow', () => {
    const rate = irrWithTerminalValue(
      [{ date: d('2025-01-01'), amount: -1000 }],
      1100,
      d('2026-01-01'),
    );
    expect(rate).toBeCloseTo(0.1, 4);
  });
});

describe('multiples', () => {
  it('computes the standard three', () => {
    expect(multiples({ paidIn: 100, distributed: 40, nav: 90 })).toEqual({
      tvpi: 1.3, dpi: 0.4, rvpi: 0.9,
    });
  });

  it('is undefined rather than zero with no paid-in capital', () => {
    // 0.00x would read as a total loss; a fund that has drawn nothing has no TVPI.
    expect(multiples({ paidIn: 0, distributed: 0, nav: 0 })).toEqual({
      tvpi: undefined, dpi: undefined, rvpi: undefined,
    });
  });
});

describe('compounding', () => {
  it('chains quarterly returns', () => {
    expect(compound([0.01, 0.02, -0.005, 0.03])).toBeCloseTo(0.055800, 6);
  });

  it('annualises over a span', () => {
    expect(annualise(0.21, 2)).toBeCloseTo(0.1, 6);
    expect(annualise(0.21, 0)).toBeUndefined();
  });
});

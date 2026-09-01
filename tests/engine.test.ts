import { describe, expect, it } from 'vitest';
import { analyse, availableKnowledgeDates, availablePeriods } from '../src/engine';
import { buildRateLookup, attributeFx } from '../src/engine/fx';
import { latestThrough, visibleAt } from '../src/engine/asof';
import { buildDemoDataSet, DEMO_TIMELINE } from '../src/data/demo';
import type { Scope } from '../src/domain/types';

const meridian = buildDemoDataSet('client-meridian');
const aurora = buildDemoDataSet('client-aurora');

const scope = (over: Partial<Scope> = {}): Scope => ({
  clientId: 'client-meridian',
  vehicleId: 'veh-meridian-pf-ii',
  period: '2026Q1',
  ...over,
});

describe('point-in-time selection', () => {
  it('hides facts recorded after the knowledge date', () => {
    const all = meridian.positionValuations;
    const early = visibleAt(all, DEMO_TIMELINE.EARLY);
    expect(early.length).toBeLessThan(all.length);
    expect(early.every((v) => Date.parse(v.recordedAt) <= Date.parse(DEMO_TIMELINE.EARLY))).toBe(true);
  });

  it('lets a later restatement win, but only once it is known', () => {
    const rows = meridian.positionValuations.filter(
      (v) => v.positionId === 'pos-atlantic-buyout' && v.period === '2025Q4',
    );
    expect(rows.length).toBe(2);

    const asPublished = latestThrough(rows, '2025Q4', DEMO_TIMELINE.DRAFT_CUT);
    const asRestated = latestThrough(rows, '2025Q4');
    expect(asPublished!.nav).not.toBe(asRestated!.nav);
    expect(asRestated!.source).toBe('GP restated report');
  });

  it('reproduces a past quarter identically when pinned to its publication date', () => {
    const pinned = { clientId: 'client-meridian', vehicleId: 'veh-meridian-pf-ii', period: '2025Q4' as const, knowledgeDate: DEMO_TIMELINE.DRAFT_CUT };
    const a = analyse(meridian, pinned);
    const b = analyse(meridian, pinned);
    expect(a.gross.totals.nav).toBe(b.gross.totals.nav);

    // Unpinned, the restatement moves the number — which is the whole point.
    const now = analyse(meridian, { ...pinned, knowledgeDate: undefined });
    expect(now.gross.totals.nav).not.toBe(a.gross.totals.nav);
  });

  it('offers only periods and knowledge dates that exist', () => {
    const periods = availablePeriods(meridian, { clientId: 'client-meridian' });
    expect(periods[0]).toBe('2026Q1');
    expect(periods).toContain('2024Q1');
    expect(availableKnowledgeDates(meridian).length).toBeGreaterThan(0);
  });
});

describe('currency treatment', () => {
  const rates = buildRateLookup(meridian.fxRates);

  it('inverts a stored pair rather than requiring both directions', () => {
    const eurUsd = rates.rate('EUR', 'USD', '2026Q1');
    const usdEur = rates.rate('USD', 'EUR', '2026Q1');
    expect(eurUsd * usdEur).toBeCloseTo(1, 10);
  });

  it('crosses two pairs through a common currency', () => {
    const usdGbp = rates.rate('USD', 'GBP', '2026Q1');
    const viaEur = rates.rate('USD', 'EUR', '2026Q1') * rates.rate('EUR', 'GBP', '2026Q1');
    expect(usdGbp).toBeCloseTo(viaEur, 10);
  });

  it('is the identity within one currency', () => {
    expect(rates.rate('EUR', 'EUR', '2026Q1')).toBe(1);
  });

  it('falls back to the closing rate when no average is filed', () => {
    expect(rates.tryRate('EUR', 'USD', '2026Q1', 'average')).toBeDefined();
  });

  it('reports a missing pair rather than silently using 1.0', () => {
    expect(rates.tryRate('EUR', 'JPY', '2026Q1')).toBeUndefined();
    expect(() => rates.rate('EUR', 'JPY', '2026Q1')).toThrow(/No EUR\/JPY rate/);
  });

  it('splits a move into local performance and translation, exactly', () => {
    const a = attributeFx(1_000, 1_100, 0.90, 0.95);
    expect(a.local + a.translation).toBeCloseTo(a.total, 10);
    expect(a.translation).toBeCloseTo(1_000 * 0.05, 10);
  });
});

describe('gross and net analysis', () => {
  const view = analyse(meridian, scope());

  it('produces a portfolio NAV that is the sum of its positions', () => {
    const sum = view.gross.positions.reduce((t, p) => t + p.nav, 0);
    expect(view.gross.totals.nav).toBeCloseTo(sum, 6);
  });

  it('keeps the gross and net tiers distinct', () => {
    // Net NAV carries the vehicle's own cash and accruals; gross does not.
    expect(view.net.product.components.portfolio).toBeCloseTo(view.gross.totals.nav, 6);
    expect(view.net.product.components.vehicleNav).not.toBeCloseTo(view.gross.totals.nav, 2);
  });

  it('closes the NAV bridge', () => {
    expect(view.bridges.portfolioNav.closes).toBe(true);
    expect(Math.abs(view.bridges.portfolioNav.residual)).toBeLessThan(0.5);
  });

  it('closes the net NAV bridge', () => {
    expect(view.bridges.productNav.closes).toBe(true);
  });

  it('splits commitments exhaustively into drawn and undrawn', () => {
    const t = view.gross.totals;
    expect(t.drawn + t.undrawn).toBeCloseTo(t.commitments, 6);
  });

  it('allocates every unit of net asset value to an investor', () => {
    const sum = view.net.investors.reduce((t, i) => t + i.nav, 0);
    expect(sum).toBeCloseTo(view.net.product.components.vehicleNav, 4);
    const ownership = view.net.investors.reduce((t, i) => t + i.ownership, 0);
    expect(ownership).toBeCloseTo(1, 8);
  });

  it('computes multiples and an IRR at both tiers', () => {
    expect(view.gross.totals.multiples.tvpi).toBeGreaterThan(0);
    expect(view.net.product.multiples.tvpi).toBeGreaterThan(0);
    expect(view.gross.totals.irr).toBeDefined();
    expect(view.net.product.irr).toBeDefined();
  });

  it('presents in a requested currency, translating stocks at the closing rate', () => {
    const inUsd = analyse(meridian, scope({ presentationCurrency: 'USD' }));
    const rate = buildRateLookup(meridian.fxRates).rate('EUR', 'USD', '2026Q1');
    expect(inUsd.currency).toBe('USD');
    // NAV is a stock: one closing rate applies to the whole of it.
    expect(inUsd.gross.totals.nav).toBeCloseTo(view.gross.totals.nav * rate, 0);
  });

  it('does not pretend a multiple is currency-invariant', () => {
    // Flows translate at the rate of their own date, NAV at the closing rate.
    // Over a series where EUR/USD moved from 1.04 to 1.17 the two currencies
    // therefore give genuinely different multiples — that is the euro investor's
    // experience versus the dollar investor's, not a rounding artefact. Forcing
    // them to agree would mean translating history at today's rate.
    const inUsd = analyse(meridian, scope({ presentationCurrency: 'USD' }));
    expect(inUsd.gross.totals.multiples.tvpi).not.toBeCloseTo(view.gross.totals.multiples.tvpi!, 2);
    expect(inUsd.gross.totals.multiples.tvpi).toBeGreaterThan(1);
    expect(view.gross.totals.multiples.tvpi).toBeGreaterThan(1);
  });
});

describe('draft calculation on an incomplete quarter', () => {
  const draft = analyse(meridian, scope({ period: '2026Q1' }));
  const complete = analyse(meridian, scope({ period: '2025Q3' }));

  it('marks the quarter as a draft and says why', () => {
    expect(draft.isFinal).toBe(false);
    expect(draft.gross.coverage.complete).toBe(false);
    expect(draft.qualifications.length).toBeGreaterThan(0);
  });

  it('marks a complete quarter as final', () => {
    expect(complete.gross.coverage.complete).toBe(true);
    expect(complete.provenance).toBe('reported');
  });

  it('never lets a missing valuation become a silent zero', () => {
    const silent = draft.gross.positions.find((p) => p.position.id === 'pos-thames-venture')!;
    expect(silent.nav).toBeGreaterThan(0);
    expect(silent.provenance).not.toBe('reported');
    expect(silent.state.note).toMatch(/Last valued/);
  });

  it('carries the weakest provenance up to the portfolio total', () => {
    expect(draft.provenance).not.toBe('reported');
    expect(draft.gross.coverage.reported).toBeLessThan(draft.gross.coverage.expected);
  });

  it('reports NAV coverage rather than implying completeness', () => {
    expect(draft.gross.coverage.navCoverage).toBeGreaterThan(0);
    expect(draft.gross.coverage.navCoverage).toBeLessThan(1);
    expect(draft.gross.coverage.publishable).toBe(true);
  });

  it('still closes its bridges — a draft is arithmetically sound, just incomplete', () => {
    expect(draft.bridges.portfolioNav.closes).toBe(true);
    expect(draft.bridges.commitments.closes).toBe(true);
  });
});

describe('an over-called position', () => {
  it('reports negative undrawn rather than clamping and breaking the identity', () => {
    const over = buildDemoDataSet('client-meridian');
    const target = over.positions[0];
    // Draw twice the commitment, as recycling or a late equalisation would.
    over.cashflows.push({
      id: 'cf-overcall', positionId: target.id, vehicleId: target.vehicleId,
      type: 'Capital Call', amount: -target.commitment * 2, currency: target.currency,
      date: '2026-03-31', period: '2026Q1', recordedAt: '2026-05-12T09:00:00Z',
      affectsCommitment: true, status: 'Settled',
    });

    const view = analyse(over, scope());
    const result = view.gross.positions.find((p) => p.position.id === target.id)!;

    expect(result.undrawn).toBeLessThan(0);
    const t = view.gross.totals;
    expect(t.drawn + t.undrawn).toBeCloseTo(t.commitments, 6);
    expect(view.checks.results.find((r) => r.id === 'commitments_split')!.status).toBe('pass');
  });
});

describe('a restricted investor register', () => {
  // An investor login receives only its own capital account, either because
  // row-level security filtered the others or because the scope did. The
  // vehicle's size must not then be inferred from the one row that survived.
  const restricted = {
    ...meridian,
    investors: meridian.investors.slice(0, 1),
    cashflows: meridian.cashflows.filter(
      (c) => c.investorId === undefined || c.investorId === meridian.investors[0].id,
    ),
  };

  const full = analyse(meridian, scope());
  const partial = analyse(restricted, scope());

  it('says the register is restricted', () => {
    expect(full.net.restricted).toBe(false);
    expect(partial.net.restricted).toBe(true);
  });

  it('keeps the fund-level commitment whole rather than collapsing to one investor', () => {
    // Summing the visible rows would give this investor's own commitment, and
    // every multiple built on it would be several times the real one.
    expect(partial.net.product.commitment).toBeCloseTo(full.net.product.commitment, 6);
  });

  it('gives the investor the ownership share they actually hold', () => {
    const own = partial.net.investors[0];
    expect(own.ownership).toBeGreaterThan(0);
    expect(own.ownership).toBeLessThan(1);
    // Their share of a EUR 72m fund on a EUR 30m commitment.
    expect(own.ownership).toBeCloseTo(
      meridian.investors[0].commitment / meridian.vehicles[0].investorCommitment, 6,
    );
  });

  it('does not hand the whole fund’s net asset value to one investor', () => {
    const own = partial.net.investors[0];
    expect(own.nav).toBeLessThan(partial.net.product.components.vehicleNav);
    expect(own.multiples.tvpi).toBeLessThan(2);
  });

  it('leaves the fund-level composition untouched', () => {
    // Portfolio, cash and accruals are the vehicle's and are not confidential.
    expect(partial.net.product.components.vehicleNav)
      .toBeCloseTo(full.net.product.components.vehicleNav, 6);
  });
});

describe('exposure and allocation', () => {
  const view = analyse(meridian, scope());

  it('produces breakdowns that sum to the whole', () => {
    for (const breakdown of Object.values(view.exposure)) {
      const weight = breakdown.slices.reduce((t, s) => t + s.weight, 0);
      expect(weight).toBeCloseTo(1, 6);
    }
  });

  it('splits a weighted attribution across its labels', () => {
    const sectors = view.lookThrough.sector;
    expect(sectors).toBeDefined();
    expect(sectors.slices.length).toBeGreaterThan(1);
    expect(sectors.basis).toBe('look-through');
  });

  it('shows currency exposure the vehicle carries whether it wants to or not', () => {
    const currencies = view.exposure.currency.slices.map((s) => s.label);
    expect(currencies).toContain('USD');
    expect(currencies).toContain('GBP');
  });
});

describe('identity checks', () => {
  it('passes every applicable check on a complete quarter', () => {
    const view = analyse(meridian, scope({ period: '2025Q3' }));
    const failures = view.checks.results.filter((r) => r.status === 'fail');
    expect(failures).toEqual([]);
    expect(view.checks.ok).toBe(true);
  });

  it('reports skips rather than hiding checks that never ran', () => {
    const view = analyse(meridian, scope({ period: '2024Q1' }));
    expect(view.checks.results.length).toBe(view.checks.passed + view.checks.failed + view.checks.skipped);
  });
});

describe('direct funds use the same engine as fund-of-funds', () => {
  const view = analyse(aurora, {
    clientId: 'client-aurora',
    vehicleId: 'veh-aurora-opportunities',
    period: '2026Q1',
  });

  it('reports in the vehicle currency', () => {
    expect(view.currency).toBe('USD');
    expect(view.vehicles[0].kind).toBe('direct-fund');
  });

  it('produces gross, net and a closing bridge', () => {
    expect(view.gross.totals.nav).toBeGreaterThan(0);
    expect(view.net.product.components.vehicleNav).toBeGreaterThan(0);
    expect(view.bridges.portfolioNav.closes).toBe(true);
  });

  it('passes its identity checks', () => {
    expect(view.checks.results.filter((r) => r.status === 'fail')).toEqual([]);
  });
});

describe('scoping', () => {
  it('narrows to a single position', () => {
    const one = analyse(meridian, scope({ positionId: 'pos-helios-infra' }));
    expect(one.gross.positions).toHaveLength(1);
    expect(one.gross.positions[0].position.name).toBe('Helios Infrastructure II');
  });

  it('keeps clients separate', () => {
    const view = analyse(meridian, { clientId: 'client-meridian', period: '2026Q1' });
    expect(view.vehicles.every((v) => v.clientId === 'client-meridian')).toBe(true);
  });
});

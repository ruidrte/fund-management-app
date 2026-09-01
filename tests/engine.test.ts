import { describe, expect, it } from 'vitest';
import { analyse, availableKnowledgeDates, availablePeriods } from '../src/engine';
import { buildRateLookup, attributeFx } from '../src/engine/fx';
import { latestThrough, visibleAt } from '../src/engine/asof';
import { buildDemoDataSet, DEMO_TIMELINE } from '../src/data/demo';
import type { FxRate, Scope } from '../src/domain/types';

const meridian = buildDemoDataSet('client-ebg');
const aurora = buildDemoDataSet('client-ut');

const scope = (over: Partial<Scope> = {}): Scope => ({
  clientId: 'client-ebg',
  vehicleId: 'veh-abif',
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
      (v) => v.positionId === 'pos-abif-social-infra' && v.period === '2025Q4',
    );
    expect(rows.length).toBe(2);

    const asPublished = latestThrough(rows, '2025Q4', DEMO_TIMELINE.DRAFT_CUT);
    const asRestated = latestThrough(rows, '2025Q4');
    expect(asPublished!.nav).not.toBe(asRestated!.nav);
    expect(asRestated!.source).toBe('GP restated report');
  });

  it('reproduces a past quarter identically when pinned to its publication date', () => {
    const pinned = { clientId: 'client-ebg', vehicleId: 'veh-abif', period: '2025Q4' as const, knowledgeDate: DEMO_TIMELINE.DRAFT_CUT };
    const a = analyse(meridian, pinned);
    const b = analyse(meridian, pinned);
    expect(a.gross.totals.nav).toBe(b.gross.totals.nav);

    // Unpinned, the restatement moves the number — which is the whole point.
    const now = analyse(meridian, { ...pinned, knowledgeDate: undefined });
    expect(now.gross.totals.nav).not.toBe(a.gross.totals.nav);
  });

  it('offers only periods and knowledge dates that exist', () => {
    const periods = availablePeriods(meridian, { clientId: 'client-ebg' });
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

describe('the administrator overrides the market fixing', () => {
  const row = (over: Partial<FxRate> & { rate: number; recordedAt: string }): FxRate => ({
    id: `fx-${over.rate}-${over.recordedAt}`,
    base: 'EUR',
    quote: 'USD',
    date: '2026-03-31',
    period: '2026Q1',
    kind: 'closing',
    source: 'test',
    ...over,
  });

  const ecb = row({ rate: 1.1498, recordedAt: '2026-04-02T00:00:00Z', authority: 'market', source: 'ECB reference rate' });
  const administrator = row({ rate: 1.1523, recordedAt: '2026-04-20T00:00:00Z', authority: 'administrator', source: 'Administrator trial balance' });
  // The dangerous one: a correction to the published fixing, filed after the
  // financials arrived. Recency alone would let it win.
  const ecbBackfill = row({ rate: 1.1501, recordedAt: '2026-05-10T00:00:00Z', authority: 'market', source: 'ECB reference rate (corrected)' });

  it('applies the trial balance rate whatever order the rows are loaded in', () => {
    const orders = [
      [ecb, administrator],
      [administrator, ecb],
      [ecb, administrator, ecbBackfill],
      [ecbBackfill, administrator, ecb],
    ];
    for (const rows of orders) {
      expect(buildRateLookup(rows).rate('EUR', 'USD', '2026Q1')).toBe(administrator.rate);
    }
  });

  it('names what was applied and what it displaced', () => {
    const explained = buildRateLookup([ecb, administrator, ecbBackfill]).explain('EUR', 'USD', '2026Q1');
    expect(explained!.applied!.source).toBe('Administrator trial balance');
    expect(explained!.derived).toBe(false);
    expect(explained!.superseded.map((r) => r.rate).sort()).toEqual([1.1498, 1.1501]);
  });

  it('leaves the market fixing in charge where no financials have arrived', () => {
    const explained = buildRateLookup([ecb, ecbBackfill]).explain('EUR', 'USD', '2026Q1');
    expect(explained!.rate).toBe(ecbBackfill.rate);
    expect(explained!.superseded).toHaveLength(1);
  });

  it('does not carry an administrator rate across into a later quarter that has its own', () => {
    const q2 = row({ rate: 1.1600, recordedAt: '2026-07-02T00:00:00Z', authority: 'market', period: '2026Q2', date: '2026-06-30' });
    const lookup = buildRateLookup([administrator, q2]);
    expect(lookup.rate('EUR', 'USD', '2026Q2')).toBe(q2.rate);
    // But an unpublished quarter still falls back to the last rate known, and
    // says so rather than pretending the period was filed.
    const gap = buildRateLookup([administrator]).explain('EUR', 'USD', '2026Q2');
    expect(gap!.fallbackFrom).toBe('2026Q1');
  });

  it('treats an unlabelled rate as a market fixing', () => {
    const unlabelled = row({ rate: 1.14, recordedAt: '2026-06-01T00:00:00Z' });
    expect(buildRateLookup([administrator, unlabelled]).rate('EUR', 'USD', '2026Q1')).toBe(administrator.rate);
  });

  it('carries the override into the demo dataset the screens read', () => {
    const explained = buildRateLookup(meridian.fxRates).explain('EUR', 'CHF', '2026Q1');
    expect(explained!.applied!.authority).toBe('administrator');
    expect(explained!.superseded.some((r) => r.source.includes('ECB'))).toBe(true);
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
    const rate = buildRateLookup(meridian.fxRates).rate(view.currency, 'USD', '2026Q1');
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
    const silent = draft.gross.positions.find((p) => p.position.id === 'pos-abif-microfinance')!;
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
    const over = buildDemoDataSet('client-ebg');
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

describe('consolidating several vehicles', () => {
  // The net tier once took a single vehicle id, so a consolidated view summed
  // the portfolio across every vehicle but took investor flows and the balance
  // sheet from the first one — a numerator and a denominator describing
  // different funds, and a net multiple several times the real one.
  const pam = buildDemoDataSet('client-pam');
  const whole = analyse(pam, { clientId: 'client-pam', period: '2026Q1' });

  const parts = pam.vehicles.map((vehicle) => analyse(pam, {
    clientId: 'client-pam', vehicleId: vehicle.id, period: '2026Q1',
    presentationCurrency: whole.currency,
  }));

  it('covers more than one vehicle', () => {
    expect(pam.vehicles.length).toBeGreaterThan(1);
  });

  it('passes every identity check', () => {
    expect(whole.checks.results.filter((r) => r.status === 'fail')).toEqual([]);
  });

  it('is the sum of its vehicles, exactly', () => {
    // Anyone looking at three vehicles and a total will add them up. The draft
    // cohort is therefore computed per vehicle: blending a fund-of-funds with a
    // direct portfolio would both misprice the estimate and break this.
    const sum = (pick: (v: typeof whole) => number) =>
      parts.reduce((total, part) => total + pick(part), 0);

    expect(whole.gross.totals.nav).toBeCloseTo(sum((v) => v.gross.totals.nav), 4);
    expect(whole.net.product.components.vehicleNav)
      .toBeCloseTo(sum((v) => v.net.product.components.vehicleNav), 4);
    expect(whole.net.product.called).toBeCloseTo(sum((v) => v.net.product.called), 4);
    expect(whole.net.product.commitment).toBeCloseTo(sum((v) => v.net.product.commitment), 4);
  });

  it('produces a net multiple in the same range as its vehicles', () => {
    const tvpi = whole.net.product.multiples.tvpi!;
    const lowest = Math.min(...parts.map((p) => p.net.product.multiples.tvpi ?? 0));
    const highest = Math.max(...parts.map((p) => p.net.product.multiples.tvpi ?? 0));
    expect(tvpi).toBeGreaterThanOrEqual(lowest - 0.01);
    expect(tvpi).toBeLessThanOrEqual(highest + 0.01);
  });

  it('sums balance sheets across vehicles rather than taking the first', () => {
    const cash = parts.reduce((total, part) => total + part.net.product.components.cash, 0);
    expect(whole.net.product.components.cash).toBeCloseTo(cash, 4);
    expect(whole.net.product.components.cash)
      .toBeGreaterThan(parts[0].net.product.components.cash);
  });
});

describe('the draft cohort is per vehicle', () => {
  const pam = buildDemoDataSet('client-pam');

  it('marks an unreported holding with its own vehicle’s experience', () => {
    const whole = analyse(pam, { clientId: 'client-pam', period: '2026Q1' });

    for (const vehicle of pam.vehicles) {
      const alone = analyse(pam, {
        clientId: 'client-pam', vehicleId: vehicle.id, period: '2026Q1',
      });
      for (const part of alone.gross.positions.filter((p) => p.provenance !== 'reported')) {
        const consolidated = whole.gross.positions.find(
          (p) => p.position.id === part.position.id,
        )!;
        // The assumption must not change with how wide a net the viewer cast.
        expect(consolidated.state.appliedReturn).toBeCloseTo(part.state.appliedReturn, 10);
      }
    }
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
    // AbIF reports in CHF and holds EUR and USD funds; the exposure is real
    // whether or not the vehicle intends to carry it.
    expect(currencies).toContain('USD');
    expect(currencies).toContain('EUR');
    expect(currencies.length).toBeGreaterThan(1);
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
    clientId: 'client-ut',
    vehicleId: 'veh-ut-early-growth',
    period: '2026Q1',
  });

  it('reports in the vehicle currency', () => {
    expect(view.currency).toBe('EUR');
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
    const one = analyse(meridian, scope({ positionId: 'pos-abif-social-infra' }));
    expect(one.gross.positions).toHaveLength(1);
    expect(one.gross.positions[0].position.name).toBe('Social Infrastructure Partners II');
  });

  it('keeps clients separate', () => {
    const view = analyse(meridian, { clientId: 'client-ebg', period: '2026Q1' });
    expect(view.vehicles.every((v) => v.clientId === 'client-ebg')).toBe(true);
  });
});

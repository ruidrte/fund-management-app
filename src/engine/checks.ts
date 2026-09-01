/**
 * Identity checks.
 *
 * A green recalculation does not prove a number is right. A failing identity
 * proves one is wrong — loudly, early, and for free. Every check is conditional
 * on its inputs, so a partial quarter produces skips rather than failures, and
 * a skip is reported: a check that silently never ran is worse than one that failed.
 */

import type { ExposureBreakdown } from './exposure';
import type { Bridge } from './bridge';
import type { GrossResult } from './gross';
import type { NetResult } from './net';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** Present on pass and fail; the size of the discrepancy. */
  difference?: number;
  detail: string;
}

export interface CheckReport {
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** False when any check failed. Nothing should be published on a false. */
  ok: boolean;
}

/** Absolute tolerance, in the storage denomination. */
const ABS_TOLERANCE = 0.5;
/** Relative tolerance for figures large enough that absolute is meaningless. */
const REL_TOLERANCE = 1e-6;

function close(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= ABS_TOLERANCE) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && diff / scale <= REL_TOLERANCE;
}

export function runChecks(
  gross: GrossResult,
  net: NetResult,
  bridges: Bridge[],
  breakdowns: ExposureBreakdown[],
): CheckReport {
  const results: CheckResult[] = [];

  const check = (
    id: string,
    label: string,
    condition: boolean | undefined,
    actual: number,
    expected: number,
    detail: string,
  ) => {
    if (condition === undefined || condition === false) {
      results.push({ id, label, status: 'skip', detail });
      return;
    }
    const ok = close(actual, expected);
    results.push({
      id,
      label,
      status: ok ? 'pass' : 'fail',
      difference: actual - expected,
      detail,
    });
  };

  const t = gross.totals;
  const hasPortfolio = gross.positions.length > 0;

  check(
    'commitments_split',
    'Undrawn + drawn = commitments',
    hasPortfolio,
    t.undrawn + t.drawn,
    t.commitments,
    'Every unit of commitment is either drawn or still undrawn',
  );

  check(
    'open_commitment',
    'Open commitment = undrawn + recallable',
    hasPortfolio,
    t.openCommitment,
    t.undrawn + t.recallable,
    'Open commitment restores recallable distributions where the convention allows it',
  );

  check(
    'percent_invested',
    'Percent invested = drawn / commitments',
    hasPortfolio && t.commitments > 0,
    t.percentInvested,
    t.commitments > 0 ? t.drawn / t.commitments : 0,
    'The headline invested share is the ratio it claims to be',
  );

  check(
    'portfolio_nav_sum',
    'Portfolio NAV = sum of positions',
    hasPortfolio,
    t.nav,
    gross.positions.reduce((sum, p) => sum + p.nav, 0),
    'The total is the sum of its parts and nothing else',
  );

  for (const bridge of bridges) {
    const opening = bridge.steps.find((s) => s.key === 'opening');
    const closing = bridge.steps.find((s) => s.key === 'closing');
    check(
      `bridge_${slug(bridge.label)}`,
      `${bridge.label} closes`,
      opening !== undefined && closing !== undefined,
      bridge.residual,
      0,
      'Opening plus every step equals closing',
    );
  }

  const components = net.product.components;
  check(
    'nav_components',
    'Vehicle NAV = portfolio + cash + other - liabilities - accruals',
    true,
    components.vehicleNav,
    components.portfolio + components.cash + components.otherAssets
      - components.currentLiabilities - components.accruedExpenses,
    'The net asset value is exactly its stated components',
  );

  check(
    'net_commitment_split',
    'Investor commitment = called + undrawn',
    net.product.commitment > 0,
    net.product.called + net.product.undrawn,
    net.product.commitment,
    'The investor-side commitment splits the same way the portfolio side does',
  );

  const investorNav = net.investors.reduce((sum, i) => sum + i.nav, 0);
  check(
    'investor_nav_sum',
    'Capital accounts sum to vehicle NAV',
    net.investors.length > 0,
    investorNav,
    components.vehicleNav,
    'Every unit of net asset value belongs to exactly one investor',
  );

  const ownership = net.investors.reduce((sum, i) => sum + i.ownership, 0);
  check(
    'investor_ownership',
    'Ownership shares sum to 100%',
    net.investors.length > 0,
    ownership,
    1,
    'The capital account split is exhaustive',
  );

  for (const breakdown of breakdowns) {
    const weight = breakdown.slices.reduce((sum, s) => sum + s.weight, 0);
    check(
      `breakdown_${slug(breakdown.dimension)}`,
      `${breakdown.dimension} breakdown sums to 100%`,
      breakdown.slices.length > 0,
      weight,
      1,
      'A breakdown that does not sum to the whole is hiding something',
    );
  }

  check(
    'coverage_floor',
    'Reported NAV coverage meets the minimum',
    gross.positions.length > 0,
    gross.coverage.publishable ? 1 : 0,
    1,
    'A draft below the coverage floor is refused rather than published',
  );

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;

  return { results, passed, failed, skipped, ok: failed === 0 };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

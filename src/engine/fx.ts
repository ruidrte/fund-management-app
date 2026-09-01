/**
 * Currency treatment.
 *
 * Rates are stored one way — `1 base = rate quote` — and inverted on demand, so
 * a EUR/USD rate and a USD/EUR rate can never disagree in the database.
 *
 * The convention that matters for reporting: stocks (NAV, commitments) translate
 * at the period closing rate; flows translate at the rate of their own date, or
 * at the period average when the house convention says so. Translating flows at
 * the closing rate would fold FX into the value change and make the NAV bridge
 * lie about where the quarter's return came from.
 */

import { comparePeriods, type PeriodId } from '../domain/period';
import type { CurrencyCode, FxAuthority, FxRate, ReportingConventions } from '../domain/types';
import { visibleAt } from './asof';

export class MissingRateError extends Error {
  constructor(
    readonly from: CurrencyCode,
    readonly to: CurrencyCode,
    readonly period: PeriodId,
  ) {
    super(`No ${kind(from, to)} rate available for ${period}`);
    this.name = 'MissingRateError';
  }
}

function kind(from: CurrencyCode, to: CurrencyCode): string {
  return `${from}/${to}`;
}

export interface RateLookup {
  /** Rate to multiply a `from` amount by to get a `to` amount. */
  rate(from: CurrencyCode, to: CurrencyCode, period: PeriodId, kind?: 'closing' | 'average'): number;
  /** Same, but returns undefined instead of throwing. */
  tryRate(from: CurrencyCode, to: CurrencyCode, period: PeriodId, kind?: 'closing' | 'average'): number | undefined;
  convert(amount: number, from: CurrencyCode, to: CurrencyCode, period: PeriodId, kind?: 'closing' | 'average'): number;
  /**
   * Which stored rate was used for a pair, and what it displaced.
   *
   * Reconciliation arguments are almost always about which rate somebody
   * applied. Being able to answer that from the application, rather than by
   * reading the rate table, is the difference between a five-minute question
   * and an afternoon.
   */
  explain(from: CurrencyCode, to: CurrencyCode, period: PeriodId, kind?: 'closing' | 'average'): RateExplanation | undefined;
}

export interface RateExplanation {
  pair: string;
  rate: number;
  /** True when the pair was inverted or crossed rather than stored directly. */
  derived: boolean;
  /** The row that won, for a directly stored pair. */
  applied?: FxRate;
  /** Same pair, period and kind, outranked by the applied row. */
  superseded: FxRate[];
  /** Set when the rate came from an earlier period than the one asked for. */
  fallbackFrom?: PeriodId;
}

/**
 * Precedence, worst to best. The administrator's books are what the reported
 * net asset value must tie to, so a rate implied by the financials outranks a
 * published fixing — and it does so on authority, not on arrival order, or a
 * later backfill of ECB rates would silently displace it.
 */
const AUTHORITY_RANK: Record<FxAuthority, number> = {
  market: 0,
  manual: 1,
  administrator: 2,
};

export function authorityOf(row: FxRate): FxAuthority {
  return row.authority ?? 'market';
}

export const AUTHORITY_LABEL: Record<FxAuthority, string> = {
  market: 'Market fixing',
  manual: 'Entered by hand',
  administrator: 'Administrator financials',
};

/**
 * Builds a lookup over the rate table, restricted to what was known at
 * `knowledgeDate`. Rates for a period fall back to the most recent earlier
 * period, which is what happens in practice when a quarter's official fixing
 * has not landed yet — but a fallback is never silent at the call site that
 * cares, because `tryRate` exists for exactly that.
 */
export function buildRateLookup(rates: FxRate[], knowledgeDate?: string): RateLookup {
  const visible = visibleAt(rates, knowledgeDate);

  // pair -> kind -> chronological rows
  const index = new Map<string, Map<string, FxRate[]>>();
  for (const row of visible) {
    const pair = kind(row.base, row.quote);
    let byKind = index.get(pair);
    if (!byKind) {
      byKind = new Map();
      index.set(pair, byKind);
    }
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }
  // Sorted so the winner for a period is the last row at or before it: period
  // ascending, then authority worst-to-best, then oldest-to-newest. Authority
  // before recency is the whole point — an administrator rate must not be
  // displaced by a market rate that happens to be loaded afterwards.
  for (const byKind of index.values()) {
    for (const list of byKind.values()) {
      list.sort((a, b) => {
        const byPeriod = comparePeriods(a.period, b.period);
        if (byPeriod !== 0) return byPeriod;
        const byAuthority = AUTHORITY_RANK[authorityOf(a)] - AUTHORITY_RANK[authorityOf(b)];
        if (byAuthority !== 0) return byAuthority;
        return Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
      });
    }
  }

  /** The winning row for a pair at a period, with what it outranked. */
  function winner(
    from: CurrencyCode, to: CurrencyCode, period: PeriodId,
    rateKind: 'closing' | 'average',
  ): { applied: FxRate; superseded: FxRate[] } | undefined {
    const list = index.get(kind(from, to))?.get(rateKind);
    if (!list) return undefined;

    let applied: FxRate | undefined;
    for (const row of list) {
      if (comparePeriods(row.period, period) <= 0) applied = row;
      else break;
    }
    if (!applied) return undefined;

    return {
      applied,
      superseded: list.filter(
        (row) => row !== applied
          && row.period === applied!.period
          && AUTHORITY_RANK[authorityOf(row)] <= AUTHORITY_RANK[authorityOf(applied!)],
      ),
    };
  }

  function directRate(
    from: CurrencyCode,
    to: CurrencyCode,
    period: PeriodId,
    rateKind: 'closing' | 'average',
  ): number | undefined {
    return winner(from, to, period, rateKind)?.applied.rate;
  }

  function explain(
    from: CurrencyCode, to: CurrencyCode, period: PeriodId,
    rateKind: 'closing' | 'average' = 'closing',
  ): RateExplanation | undefined {
    const pair = kind(from, to);
    if (from === to) return { pair, rate: 1, derived: false, superseded: [] };

    const direct = winner(from, to, period, rateKind);
    if (direct) {
      return {
        pair,
        rate: direct.applied.rate,
        derived: false,
        applied: direct.applied,
        superseded: direct.superseded,
        fallbackFrom: direct.applied.period === period ? undefined : direct.applied.period,
      };
    }

    // Inverted or crossed: there is no single stored row to point at, so the
    // explanation says the rate is derived rather than naming a source that
    // was not consulted.
    const value = tryRate(from, to, period, rateKind);
    return value === undefined
      ? undefined
      : { pair, rate: value, derived: true, superseded: [] };
  }

  function tryRate(
    from: CurrencyCode,
    to: CurrencyCode,
    period: PeriodId,
    rateKind: 'closing' | 'average' = 'closing',
  ): number | undefined {
    if (from === to) return 1;

    const direct = directRate(from, to, period, rateKind);
    if (direct !== undefined) return direct;

    const inverse = directRate(to, from, period, rateKind);
    if (inverse !== undefined && inverse !== 0) return 1 / inverse;

    // Cross via any currency that quotes against both. EUR first, since a
    // European book almost always has it, then anything else in the table.
    const bridges = new Set<CurrencyCode>(['EUR']);
    for (const pair of index.keys()) {
      const [base, quote] = pair.split('/');
      bridges.add(base);
      bridges.add(quote);
    }
    for (const bridge of bridges) {
      if (bridge === from || bridge === to) continue;
      const left = directRate(from, bridge, period, rateKind) ??
        invert(directRate(bridge, from, period, rateKind));
      const right = directRate(bridge, to, period, rateKind) ??
        invert(directRate(to, bridge, period, rateKind));
      if (left !== undefined && right !== undefined) return left * right;
    }

    // An average rate that does not exist falls back to the closing rate rather
    // than failing — a quarter's average is a refinement, not a prerequisite.
    if (rateKind === 'average') return tryRate(from, to, period, 'closing');

    return undefined;
  }

  function rate(
    from: CurrencyCode,
    to: CurrencyCode,
    period: PeriodId,
    rateKind: 'closing' | 'average' = 'closing',
  ): number {
    const found = tryRate(from, to, period, rateKind);
    if (found === undefined) throw new MissingRateError(from, to, period);
    return found;
  }

  return {
    rate,
    tryRate,
    explain,
    convert: (amount, from, to, period, rateKind = 'closing') =>
      amount * rate(from, to, period, rateKind),
  };
}

function invert(value: number | undefined): number | undefined {
  return value === undefined || value === 0 ? undefined : 1 / value;
}

/** The rate kind a flow should use, given the house convention. */
export function flowRateKind(conventions: ReportingConventions): 'closing' | 'average' {
  return conventions.flowRate === 'average' ? 'average' : 'closing';
}

/**
 * Splits a period-on-period move into the part caused by the underlying
 * position and the part caused purely by translation.
 *
 * Holding the local value constant and revaluing it at both rates isolates
 * translation; the remainder is the local move carried at the closing rate.
 * The two parts always sum to the total move in presentation currency, which
 * is the identity the NAV bridge checks.
 */
export interface FxAttribution {
  /** Move in presentation currency, total. */
  total: number;
  /** The part explained by the local-currency move. */
  local: number;
  /** The part explained by the change in rate. */
  translation: number;
}

export function attributeFx(
  openingLocal: number,
  closingLocal: number,
  openingRate: number,
  closingRate: number,
): FxAttribution {
  const openingPresentation = openingLocal * openingRate;
  const closingPresentation = closingLocal * closingRate;
  const translation = openingLocal * (closingRate - openingRate);
  const local = (closingLocal - openingLocal) * closingRate;
  return {
    total: closingPresentation - openingPresentation,
    local,
    translation,
  };
}

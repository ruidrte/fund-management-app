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
import type { CurrencyCode, FxRate, ReportingConventions } from '../domain/types';
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
}

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
  for (const byKind of index.values()) {
    for (const list of byKind.values()) {
      list.sort((a, b) => {
        const byPeriod = comparePeriods(a.period, b.period);
        return byPeriod !== 0 ? byPeriod : Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
      });
    }
  }

  function directRate(
    from: CurrencyCode,
    to: CurrencyCode,
    period: PeriodId,
    rateKind: 'closing' | 'average',
  ): number | undefined {
    const list = index.get(kind(from, to))?.get(rateKind);
    if (!list) return undefined;
    // Latest row at or before the requested period.
    let found: FxRate | undefined;
    for (const row of list) {
      if (comparePeriods(row.period, period) <= 0) found = row;
      else break;
    }
    return found?.rate;
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

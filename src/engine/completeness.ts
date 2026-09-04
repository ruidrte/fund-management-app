/**
 * Draft calculation.
 *
 * A quarter is almost never complete on the day it is wanted. Underlying funds
 * report on their own timetables, and waiting for the last one means the desk
 * has no number for six weeks. So the engine produces a figure from what has
 * arrived and states plainly what it did for the rest.
 *
 * Three rules govern this, and they are what separates a usable draft from a
 * fabricated one:
 *
 *   1. A missing valuation is never silently zero. It is rolled forward from the
 *      last known NAV, adjusted for the cashflows since, and labelled.
 *   2. Every derived figure carries its weakest input's provenance upward. One
 *      estimated position makes the portfolio total an estimate.
 *   3. Below `minimumCoverage` of reported NAV the quarter is refused outright.
 *      A draft built on a fifth of the portfolio is not a draft, it is a guess.
 */

import { comparePeriods, formatPeriod, periodsBetween, type PeriodId } from '../domain/period';
import type {
  Cashflow,
  DraftPolicy,
  Position,
  PositionValuation,
  Provenance,
} from '../domain/types';
import { forPeriod, latestThrough, throughPeriod } from './asof';

export interface PositionState {
  positionId: string;
  /** NAV in the position's own currency for the requested period. */
  nav: number;
  provenance: Provenance;
  /** Period the underlying reported figure belongs to. */
  sourcePeriod?: PeriodId;
  /** How many quarters the source lags the requested period. */
  lagQuarters: number;
  /** Net cashflow applied on top of the source NAV when rolling forward. */
  rollForwardAdjustment: number;
  /** Return assumption applied on top of the roll-forward, as a decimal. */
  appliedReturn: number;
  /**
   * Cumulative amounts as the source statement reported them, in the position's
   * own currency, with the quarter they were reported for.
   *
   * A historical workbook gives cumulative drawn and distributed per holding
   * and no cashflow ledger at all; a live book has the ledger and often no
   * cumulatives. Carrying whichever the source gave lets the engine use the
   * statement as the authority for the stock and the ledger for the dated
   * flows, rather than reporting nothing drawn because no call was ever filed.
   */
  reported?: {
    period: PeriodId;
    drawn?: number;
    distributed?: number;
    recallable?: number;
  };
  note?: string;
}

/** The cumulative figures a valuation carries, if it carries any. */
function reportedCumulatives(row: PositionValuation): PositionState['reported'] {
  if (row.drawnCumulative === undefined
    && row.distributedCumulative === undefined
    && row.recallableCumulative === undefined) return undefined;
  return {
    period: row.period,
    drawn: row.drawnCumulative,
    distributed: row.distributedCumulative,
    recallable: row.recallableCumulative,
  };
}

export interface CoverageSummary {
  /** Positions expected to report for this period. */
  expected: number;
  reported: number;
  rolledForward: number;
  estimated: number;
  stale: number;
  missing: number;
  /** Share of closing NAV backed by a valuation reported for this exact period. */
  navCoverage: number;
  /** True when every position reported for the period. */
  complete: boolean;
  /** True when the result is publishable at all under the policy. */
  publishable: boolean;
}

export interface DraftResult {
  states: PositionState[];
  coverage: CoverageSummary;
  /** Weakest provenance across the portfolio — what the whole quarter is worth. */
  provenance: Provenance;
  /** Reasons the quarter is not final. Empty when it is. */
  qualifications: string[];
}

const PROVENANCE_RANK: Record<Provenance, number> = {
  reported: 0,
  stale: 1,
  'rolled-forward': 2,
  estimated: 3,
  missing: 4,
};

/** The weaker of two provenances — what a derived figure inherits. */
export function weakest(values: Provenance[]): Provenance {
  if (values.length === 0) return 'missing';
  return values.reduce((worst, value) =>
    PROVENANCE_RANK[value] > PROVENANCE_RANK[worst] ? value : worst,
  );
}

/** Whether a position is expected to have a valuation for the period at all. */
export function isExpectedToReport(position: Position, period: PeriodId): boolean {
  if (comparePeriods(period, periodOfDate(position.commitmentDate)) < 0) return false;
  if (position.terminatedPeriod && comparePeriods(period, position.terminatedPeriod) > 0) {
    return false;
  }
  return true;
}

function periodOfDate(date: string): PeriodId {
  const d = new Date(date);
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${quarter}`;
}

/**
 * Resolves every position to a NAV for `period`, filling gaps according to the
 * policy and recording exactly how each gap was filled.
 *
 * The order matters. Reported positions are resolved first, because the return
 * they collectively achieved is what the `portfolio` policy applies to the ones
 * that have not reported — an estimate anchored to this quarter's actual
 * experience rather than to a house assumption.
 */
/**
 * Restates an amount held in one position's own currency into the currency
 * everything is being measured in.
 *
 * Coverage and the cohort return are both ratios over sums across positions,
 * and a sum across currencies is not a quantity: 27,000 SEK and 2,000 USD add
 * to nothing meaningful, and the Swedish holding would dominate a share it
 * accounts for a third of. Every amount handed to this uses the same period's
 * rate, so translation cancels within a position and the return that comes out
 * is the local value change, weighted by size on one scale.
 */
export type Translate = (positionId: string, amount: number) => number;

export function resolvePositionStates(
  positions: Position[],
  valuations: PositionValuation[],
  cashflows: Cashflow[],
  period: PeriodId,
  policy: DraftPolicy,
  knowledgeDate?: string,
  translate?: Translate,
): DraftResult {
  const expected = positions.filter((p) => isExpectedToReport(p, period));

  // Pass 1 — everything with a valuation reported for this exact period.
  const reportedStates = new Map<string, PositionState>();
  const outstanding: Position[] = [];

  for (const position of expected) {
    const rows = valuations.filter((v) => v.positionId === position.id);
    const exact = forPeriod(rows, period, knowledgeDate)
      .filter((v) => !v.supersededBy)
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];

    if (exact) {
      reportedStates.set(position.id, {
        positionId: position.id,
        nav: exact.nav,
        provenance: 'reported',
        sourcePeriod: period,
        lagQuarters: 0,
        rollForwardAdjustment: 0,
        appliedReturn: 0,
        reported: reportedCumulatives(exact),
      });
    } else {
      outstanding.push(position);
    }
  }

  // The reported cohort's value change this quarter, before cashflows — the only
  // return assumption defensible without a house view.
  //
  // Computed per vehicle rather than across the whole scope. A climate
  // infrastructure fund-of-funds and a direct Swiss infrastructure portfolio do
  // not inform each other's estimates, and blending them would also make a
  // consolidated total differ from the sum of its vehicles, which is the first
  // thing anyone checks.
  const byVehicle = new Map<string, number | undefined>();
  const vehicleIds = new Set(expected.map((p) => p.vehicleId));
  for (const vehicleId of vehicleIds) {
    const reported = [...reportedStates.values()].filter((state) =>
      expected.find((p) => p.id === state.positionId)?.vehicleId === vehicleId);
    byVehicle.set(vehicleId, reportedCohortReturn(
      reported, valuations, cashflows, period, knowledgeDate, translate,
    ));
  }

  // Falls back to the whole scope when a vehicle has nothing reported at all.
  const overallReturn = reportedCohortReturn(
    [...reportedStates.values()], valuations, cashflows, period, knowledgeDate, translate,
  );

  // Pass 2 — fill the gaps.
  const states: PositionState[] = [...reportedStates.values()];

  for (const position of outstanding) {
    const cohortReturn = byVehicle.get(position.vehicleId) ?? overallReturn;
    states.push(
      fillGap(position, valuations, cashflows, period, policy, cohortReturn, knowledgeDate),
    );
  }

  states.sort((a, b) => a.positionId.localeCompare(b.positionId));

  return summarise(states, expected.length, policy, overallReturn, translate);
}

function fillGap(
  position: Position,
  valuations: PositionValuation[],
  cashflows: Cashflow[],
  period: PeriodId,
  policy: DraftPolicy,
  cohortReturn: number | undefined,
  knowledgeDate?: string,
): PositionState {
  const rows = valuations.filter((v) => v.positionId === position.id && !v.supersededBy);
  const last = latestThrough(rows, period, knowledgeDate);

  if (!last) {
    // Never valued. Cost is the only anchor available: net capital drawn to date.
    const cost = netCapitalDrawn(cashflows, position.id, period, knowledgeDate);
    if (cost === 0) {
      return {
        positionId: position.id,
        nav: 0,
        provenance: 'missing',
        lagQuarters: 0,
        rollForwardAdjustment: 0,
        appliedReturn: 0,
        note: 'No valuation and no cashflows — position contributes nothing',
      };
    }
    return {
      positionId: position.id,
      nav: cost,
      provenance: 'estimated',
      lagQuarters: 0,
      rollForwardAdjustment: cost,
      appliedReturn: 0,
      note: 'Never valued — held at net capital drawn',
    };
  }

  const lag = periodsBetween(last.period, period);

  if (!policy.rollForward) {
    return {
      positionId: position.id,
      nav: last.nav,
      provenance: 'stale',
      sourcePeriod: last.period,
      lagQuarters: lag,
      rollForwardAdjustment: 0,
      appliedReturn: 0,
      reported: reportedCumulatives(last),
      note: `Valuation as at ${formatPeriod(last.period)}, carried unchanged`,
    };
  }

  // Roll forward: last NAV plus the net capital that moved since.
  const adjustment = netCapitalDrawnBetween(
    cashflows,
    position.id,
    last.period,
    period,
    knowledgeDate,
  );
  const rolled = last.nav + adjustment;

  const appliedReturn = resolveReturn(policy, cohortReturn);
  const nav = rolled * (1 + appliedReturn);

  // Within the staleness tolerance a roll-forward is an accepted convention;
  // beyond it, saying "stale" understates the problem, so it stays estimated
  // but the note carries the lag.
  const provenance: Provenance = appliedReturn !== 0 ? 'estimated'
    : lag <= policy.staleAfterQuarters ? 'rolled-forward'
    : 'estimated';

  const noteParts = [`Last valued ${formatPeriod(last.period)} (${lag}Q lag)`];
  if (adjustment !== 0) noteParts.push('rolled forward for cashflows');
  if (appliedReturn !== 0) {
    noteParts.push(`${(appliedReturn * 100).toFixed(1)}% assumed value change`);
  }

  return {
    positionId: position.id,
    nav,
    provenance,
    sourcePeriod: last.period,
    lagQuarters: lag,
    rollForwardAdjustment: adjustment,
    appliedReturn,
    reported: reportedCumulatives(last),
    note: noteParts.join(', '),
  };
}

function resolveReturn(policy: DraftPolicy, cohortReturn: number | undefined): number {
  switch (policy.valueChange) {
    case 'fixed':
      return policy.fixedReturn ?? 0;
    case 'portfolio':
      return cohortReturn ?? 0;
    case 'none':
    default:
      return 0;
  }
}

/**
 * Value change of the positions that did report, expressed as a return on their
 * opening NAV adjusted for cashflows. Undefined when the cohort is too small or
 * had no opening base — in which case no return is applied at all.
 */
function reportedCohortReturn(
  reported: PositionState[],
  valuations: PositionValuation[],
  cashflows: Cashflow[],
  period: PeriodId,
  knowledgeDate?: string,
  translate?: Translate,
): number | undefined {
  if (reported.length === 0) return undefined;

  let base = 0;
  let closing = 0;

  for (const state of reported) {
    const rows = valuations.filter((v) => v.positionId === state.positionId && !v.supersededBy);
    const prior = latestThrough(
      rows.filter((v) => comparePeriods(v.period, period) < 0),
      period,
      knowledgeDate,
    );
    if (!prior) continue;

    const flow = netCapitalDrawnBetween(
      cashflows,
      state.positionId,
      prior.period,
      period,
      knowledgeDate,
    );
    const into = (amount: number) =>
      (translate ? translate(state.positionId, amount) : amount);
    base += into(prior.nav + flow);
    closing += into(state.nav);
  }

  if (base <= 0) return undefined;
  return closing / base - 1;
}

/** Net capital drawn into a position from inception through `period`. */
function netCapitalDrawn(
  cashflows: Cashflow[],
  positionId: string,
  period: PeriodId,
  knowledgeDate?: string,
): number {
  const rows = throughPeriod(
    cashflows.filter((c) => c.positionId === positionId),
    period,
    knowledgeDate,
  );
  return sumCapital(rows);
}

/** Net capital drawn strictly after `from` and through `to`. */
function netCapitalDrawnBetween(
  cashflows: Cashflow[],
  positionId: string,
  from: PeriodId,
  to: PeriodId,
  knowledgeDate?: string,
): number {
  const rows = throughPeriod(
    cashflows.filter(
      (c) => c.positionId === positionId && comparePeriods(c.period, from) > 0,
    ),
    to,
    knowledgeDate,
  );
  return sumCapital(rows);
}

/**
 * Capital calls raise a position's NAV, distributions lower it. Cashflows are
 * signed from the vehicle's perspective — a call is money out — so the sign is
 * flipped here to express the effect on the holding.
 */
function sumCapital(rows: Cashflow[]): number {
  return rows
    .filter((c) => c.status !== 'Draft')
    .filter((c) => c.type === 'Capital Call' || c.type === 'Distribution' || c.type === 'Return of Capital')
    .reduce((total, c) => total - c.amount, 0);
}

function summarise(
  states: PositionState[],
  expected: number,
  policy: DraftPolicy,
  cohortReturn: number | undefined,
  translate?: Translate,
): DraftResult {
  const count = (p: Provenance) => states.filter((s) => s.provenance === p).length;
  const positions = (n: number) => `${n} position${n === 1 ? '' : 's'}`;

  const weigh = (s: PositionState) =>
    Math.abs(translate ? translate(s.positionId, s.nav) : s.nav);
  const totalNav = states.reduce((sum, s) => sum + weigh(s), 0);
  const reportedNav = states
    .filter((s) => s.provenance === 'reported')
    .reduce((sum, s) => sum + weigh(s), 0);
  const navCoverage = totalNav > 0 ? reportedNav / totalNav : 0;

  const provenance = weakest(states.map((s) => s.provenance));
  const complete = states.length > 0 && states.every((s) => s.provenance === 'reported');
  const publishable = states.length === 0 || navCoverage >= policy.minimumCoverage;

  const qualifications: string[] = [];
  if (count('rolled-forward') > 0) {
    qualifications.push(
      `${positions(count('rolled-forward'))} rolled forward from an earlier valuation`,
    );
  }
  if (count('estimated') > 0) {
    qualifications.push(`${positions(count('estimated'))} carry an estimated value`);
  }
  if (count('stale') > 0) {
    qualifications.push(`${positions(count('stale'))} carried at a stale valuation`);
  }
  if (count('missing') > 0) {
    qualifications.push(`${positions(count('missing'))} have no data and contribute nothing`);
  }
  if (policy.valueChange === 'portfolio' && cohortReturn !== undefined && count('estimated') > 0) {
    qualifications.push(
      `Estimates use the reported cohort's ${(cohortReturn * 100).toFixed(1)}% value change`,
    );
  }
  if (!publishable) {
    qualifications.push(
      `Only ${(navCoverage * 100).toFixed(0)}% of NAV is reported, below the ${(policy.minimumCoverage * 100).toFixed(0)}% minimum`,
    );
  }

  return {
    states,
    coverage: {
      expected,
      reported: count('reported'),
      rolledForward: count('rolled-forward'),
      estimated: count('estimated'),
      stale: count('stale'),
      missing: count('missing'),
      navCoverage,
      complete,
      publishable,
    },
    provenance,
    qualifications,
  };
}

/**
 * Gross analysis — the portfolio, before anything the vehicle charges.
 *
 * "Gross" here means the underlying holdings measured on their own terms: what
 * was committed to them, what they drew, what they returned, what they are
 * worth. Management fees, carry and vehicle-level expenses do not appear. The
 * gross and net tiers are not expected to reconcile to each other and should
 * never be presented as though they do.
 */

import { comparePeriods, periodEndDate, previousPeriod, type PeriodId } from '../domain/period';
import type {
  Cashflow,
  CurrencyCode,
  DraftPolicy,
  Position,
  PositionValuation,
  Provenance,
} from '../domain/types';
import { throughPeriod, forPeriod } from './asof';
import type { RateLookup } from './fx';
import { flowRateKind } from './fx';
import { irrWithTerminalValue, multiples, type DatedFlow, type Multiples, moved } from './metrics';
import { PAID_IN } from './basis';
import {
  resolvePositionStates, weakest,
  type CoverageSummary, type PositionState, type Translate,
} from './completeness';
import type { ReportingConventions } from '../domain/types';

export interface PositionResult {
  position: Position;
  state: PositionState;
  /** All figures below are in presentation currency. */
  nav: number;
  navPrior: number;
  commitment: number;
  /** Every unit paid, the denominator of the multiples. */
  paidIn: number;
  drawn: number;
  distributed: number;
  recallable: number;
  undrawn: number;
  /** Undrawn plus recallable — what the vehicle may still have to fund. */
  openCommitment: number;
  callsInPeriod: number;
  /** Of those, the part that consumed the commitment. */
  commitmentCallsInPeriod: number;
  distributionsInPeriod: number;
  valueChange: number;
  fxEffect: number;
  multiples: Multiples;
  irr?: number;
  provenance: Provenance;
  /**
   * What the cashflow ledger alone says, and what the statement said, kept
   * apart so the identity check can compare them. `drawn` above is whichever
   * of the two the engine took.
   */
  ledger: { drawn: number; distributed: number };
  stated?: { drawn?: number; distributed?: number };
}

export interface GrossResult {
  period: PeriodId;
  currency: CurrencyCode;
  positions: PositionResult[];
  totals: {
    nav: number;
    navPrior: number;
    commitments: number;
    commitmentsPrior: number;
    drawn: number;
    drawnPrior: number;
    distributed: number;
    recallable: number;
    undrawn: number;
    undrawnPrior: number;
    openCommitment: number;
    callsInPeriod: number;
    commitmentCallsInPeriod: number;
    paidIn: number;
    distributionsInPeriod: number;
    valueChange: number;
    fxEffect: number;
    /** Drawn as a share of commitments. */
    percentInvested: number;
    multiples: Multiples;
    irr?: number;
  };
  coverage: CoverageSummary;
  provenance: Provenance;
  qualifications: string[];
}

export interface GrossInputs {
  positions: Position[];
  valuations: PositionValuation[];
  cashflows: Cashflow[];
  period: PeriodId;
  presentationCurrency: CurrencyCode;
  rates: RateLookup;
  conventions: ReportingConventions;
  knowledgeDate?: string;
}

export function computeGross(inputs: GrossInputs): GrossResult {
  const {
    positions, valuations, cashflows, period,
    presentationCurrency, rates, conventions, knowledgeDate,
  } = inputs;

  const policy: DraftPolicy = conventions.draftPolicy;
  const prior = previousPeriod(period);

  // Coverage and the cohort return are shares and ratios over the whole
  // portfolio, so they are computed on one scale rather than by adding
  // Swedish kronor to dollars. Both sides of a ratio use the same period's
  // rate, so translation cancels and what is left is the local value change.
  const currencyOf = new Map(positions.map((p) => [p.id, p.currency]));
  const onto = (at: PeriodId): Translate => (positionId, amount) => {
    const local = currencyOf.get(positionId);
    if (!local) return amount;
    return amount * (rates.tryRate(local, presentationCurrency, at) ?? 1);
  };

  const current = resolvePositionStates(
    positions, valuations, cashflows, period, policy, knowledgeDate, onto(period),
  );
  // The comparative is resolved through the same machinery, so a restated prior
  // quarter shows the same number the current-quarter bridge opens from.
  const priorResolved = resolvePositionStates(
    positions, valuations, cashflows, prior, policy, knowledgeDate, onto(prior),
  );
  const priorByPosition = new Map(priorResolved.states.map((s) => [s.positionId, s]));

  const results: PositionResult[] = current.states.map((state) => {
    const position = positions.find((p) => p.id === state.positionId)!;
    const local = position.currency;

    const closingRate = rates.tryRate(local, presentationCurrency, period) ?? 1;
    const openingRate = rates.tryRate(local, presentationCurrency, prior) ?? closingRate;
    const flowKind = flowRateKind(conventions);

    const priorState = priorByPosition.get(state.positionId);
    const navLocal = state.nav;
    const navPriorLocal = priorState?.nav ?? 0;

    const positionFlows = cashflows.filter((c) => c.positionId === position.id);
    const toDate = throughPeriod(positionFlows, period, knowledgeDate)
      .filter((c) => moved(c));
    const inPeriod = forPeriod(positionFlows, period, knowledgeDate)
      .filter((c) => moved(c));

    // At the rate of the day it moved, as the return is. A cumulative figure
    // built at the quarter's rate and a return built at each flow's own rate
    // are two different histories, and putting them on one page invites the
    // question of which is wrong.
    const convertFlow = (c: Cashflow) =>
      c.amount * (rates.onDate(c.currency, presentationCurrency, c.date, flowKind) ?? 1);

    // Calls are negative from the vehicle's perspective; report them positive.
    const ledgerDrawn = -sum(toDate.filter(drawsCommitment).map(convertFlow));
    const ledgerDistributed = sum(toDate.filter(isDistribution).map(convertFlow));
    const ledgerRecallable = sum(
      toDate.filter((c) => isDistribution(c) && c.recallable).map(convertFlow),
    );

    /**
     * Cumulative amounts, taking the statement as the authority for the stock
     * and the ledger for anything that moved after it.
     *
     * A book loaded from a historical workbook has cumulative drawn and
     * distributed per holding and no cashflow ledger at all. Deriving these
     * from flows alone reported nothing drawn, the whole commitment undrawn,
     * and no multiple — for a portfolio whose statements say otherwise.
     *
     * Where both exist they should agree, and an identity check says so when
     * they do not. This is not the place to reconcile them silently.
     */
    const reportedPeriod = state.reported?.period;
    const after = reportedPeriod
      ? toDate.filter((c) => comparePeriods(c.period, reportedPeriod) > 0)
      : [];
    // Calls are stored negative; both of these are reported positive.
    const callsSince = -sum(after.filter(drawsCommitment).map(convertFlow));
    const distributionsSince = sum(after.filter(isDistribution).map(convertFlow));
    const recallableSince = sum(
      after.filter((c) => isDistribution(c) && c.recallable).map(convertFlow),
    );

    /** A reported cumulative, translated, or undefined when the source gave none. */
    const stated = (value: number | undefined): number | undefined => (
      value === undefined ? undefined : value * closingRate
    );

    const statedDrawn = stated(state.reported?.drawn);
    const statedDistributed = stated(state.reported?.distributed);
    const statedRecallable = stated(state.reported?.recallable);

    const drawn = statedDrawn === undefined ? ledgerDrawn : statedDrawn + callsSince;
    const distributed = statedDistributed === undefined
      ? ledgerDistributed
      : statedDistributed + distributionsSince;
    const recallable = statedRecallable === undefined
      ? ledgerRecallable
      : statedRecallable + recallableSince;
    const callsInPeriod = -sum(inPeriod.filter(isCall).map(convertFlow));
    // What the quarter took out of the commitment, which is what the
    // commitments bridge steps by. Different from the line above, which is
    // cash and is what the net asset value bridge steps by.
    const commitmentCallsInPeriod = -sum(inPeriod.filter(drawsCommitment).map(convertFlow));
    const distributionsInPeriod = sum(inPeriod.filter(isDistribution).map(convertFlow));

    // Everything paid, whether or not it consumed the commitment.
    //
    // Where there is no ledger to compute it from — a book loaded from
    // historical statements has cumulative drawn per holding and no flows at
    // all — what the statement says was drawn stands in. It is all that is
    // known, and a multiple over a denominator of nothing is no multiple.
    const paying = toDate.filter(isPaidIn);
    const paidIn = paying.length > 0 ? -sum(paying.map(convertFlow)) : drawn;

    const commitment = position.commitment * closingRate;
    // Not clamped at zero. A position drawn beyond its commitment — recycling,
    // or an equalisation the data has not caught up with — is a real condition,
    // and clamping would hide it while silently breaking the identity that
    // commitment equals drawn plus undrawn.
    const undrawn = commitment - drawn;
    const openCommitment = conventions.recallableRestoresCommitment
      ? undrawn + recallable
      : undrawn;

    const nav = navLocal * closingRate;
    const navPrior = navPriorLocal * openingRate;

    // The quarter's move splits into translation and local performance. Holding
    // the local NAV at its opening level and revaluing isolates the FX part.
    const fxEffect = navPriorLocal * (closingRate - openingRate);
    const netFlowInPeriod = callsInPeriod - distributionsInPeriod;
    const valueChange = nav - navPrior - fxEffect - netFlowInPeriod;

    const flows: DatedFlow[] = toDate.map((c) => ({
      date: new Date(c.date),
      amount: convertFlow(c),
    }));

    return {
      position,
      state,
      nav,
      navPrior,
      commitment,
      drawn,
      distributed,
      recallable,
      undrawn,
      openCommitment,
      callsInPeriod,
      distributionsInPeriod,
      valueChange,
      fxEffect,
      paidIn,
      commitmentCallsInPeriod,
      multiples: multiples({ paidIn, distributed, nav }),
      ledger: { drawn: ledgerDrawn, distributed: ledgerDistributed },
      stated: state.reported
        ? { drawn: statedDrawn, distributed: statedDistributed }
        : undefined,
      irr: irrWithTerminalValue(flows, nav, new Date(periodEndDate(period))),
      provenance: state.provenance,
    };
  });

  const totals = aggregate(results, positions, cashflows, period, prior, presentationCurrency, rates, conventions, knowledgeDate);

  return {
    period,
    currency: presentationCurrency,
    positions: results,
    totals,
    coverage: current.coverage,
    provenance: weakest(results.map((r) => r.provenance)),
    qualifications: current.qualifications,
  };
}

function aggregate(
  results: PositionResult[],
  positions: Position[],
  cashflows: Cashflow[],
  period: PeriodId,
  prior: PeriodId,
  currency: CurrencyCode,
  rates: RateLookup,
  conventions: ReportingConventions,
  knowledgeDate?: string,
): GrossResult['totals'] {
  const nav = sum(results.map((r) => r.nav));
  const navPrior = sum(results.map((r) => r.navPrior));
  const commitments = sum(results.map((r) => r.commitment));
  const drawn = sum(results.map((r) => r.drawn));
  const distributed = sum(results.map((r) => r.distributed));
  const recallable = sum(results.map((r) => r.recallable));
  const undrawn = sum(results.map((r) => r.undrawn));

  // Prior-period commitments and drawn are recomputed at prior rates so the
  // commitments bridge closes; carrying them at current rates would leave the
  // whole translation effect stranded in the residual.
  const flowKind = flowRateKind(conventions);
  // At the rate of the day each one moved, exactly as the current cumulative
  // is. Drawn is not a stock that gets retranslated at a closing rate — it is
  // the sum of what was paid, and each payment happened once, at one rate.
  // Converting last quarter's at the quarter rate and this quarter's at the
  // day rate left the difference between the two bases in the commitments
  // bridge, where it read as 15,327.80 of PAS Infra commitment that was
  // neither drawn nor undrawn.
  const priorConvert = (c: Cashflow) =>
    c.amount * (rates.onDate(c.currency, currency, c.date, flowKind) ?? 1);
  const priorFlows = throughPeriod(
    cashflows.filter((c) => c.positionId),
    prior,
    knowledgeDate,
  ).filter((c) => moved(c));
  const drawnPrior = -sum(priorFlows.filter(drawsCommitment).map(priorConvert));

  const commitmentsPrior = sum(
    positions
      .filter((p) => results.some((r) => r.position.id === p.id))
      .map((p) => p.commitment * (rates.tryRate(p.currency, currency, prior) ?? 1)),
  );
  const undrawnPrior = commitmentsPrior - drawnPrior;

  const allFlows: DatedFlow[] = throughPeriod(
    cashflows.filter((c) => c.positionId),
    period,
    knowledgeDate,
  )
    .filter((c) => moved(c))
    .filter((c) => isCall(c) || isDistribution(c))
    .map((c) => ({
      date: new Date(c.date),
      // At the rate of the day it moved, where the book records one. A flow
      // translated at its quarter's rate carries a currency movement that did
      // not happen to it, and over a series of calls in a currency that has
      // moved, that is most of the difference between this return and the one
      // the source workbook states.
      amount: c.amount * (rates.onDate(c.currency, currency, c.date, flowKind) ?? 1),
    }));

  return {
    nav,
    navPrior,
    commitments,
    commitmentsPrior,
    drawn,
    drawnPrior,
    distributed,
    recallable,
    undrawn,
    undrawnPrior,
    openCommitment: sum(results.map((r) => r.openCommitment)),
    callsInPeriod: sum(results.map((r) => r.callsInPeriod)),
    commitmentCallsInPeriod: sum(results.map((r) => r.commitmentCallsInPeriod)),
    paidIn: sum(results.map((r) => r.paidIn)),
    distributionsInPeriod: sum(results.map((r) => r.distributionsInPeriod)),
    valueChange: sum(results.map((r) => r.valueChange)),
    fxEffect: sum(results.map((r) => r.fxEffect)),
    percentInvested: commitments > 0 ? drawn / commitments : 0,
    multiples: multiples({ paidIn: sum(results.map((r) => r.paidIn)), distributed, nav }),
    irr: irrWithTerminalValue(allFlows, nav, new Date(periodEndDate(period))),
  };
}

function isCall(c: Cashflow): boolean {
  return c.type === 'Capital Call' || c.type === 'Equalisation';
}

/**
 * A call that consumes the commitment, as against one that is merely money
 * with the fund.
 *
 * `drawn` and `undrawn` are the two halves of a commitment, so only the flows
 * that use it up belong in them. An equalisation is real money — paid, earning,
 * and in the return — but it does not consume what was promised: a fund that
 * has called its whole commitment and taken an equalisation beside it is fully
 * drawn, not over-drawn. The test is what a drawdown notice states as remaining
 * commitment, and that is the figure this has to tie to.
 *
 * Counting it put PK TG's ledger 23,599 above the statement it reconciles
 * against and pushed the undrawn bridge out by the same amount: one definition,
 * two checks failing.
 */
function drawsCommitment(c: Cashflow): boolean {
  return isCall(c) && c.affectsCommitment !== false;
}

/**
 * Every unit the holding was paid, which is the denominator of a multiple.
 *
 * A different question from how much commitment was consumed, and the reason
 * one figure could not serve both: PAS Infra has drawn 22,650,587 against its
 * commitment and 22,800,502 paid in, and both are right. Multiples and rates of
 * return run on the second; `drawn` and `undrawn` on the first.
 *
 * Shares its definition with `basis.ts` rather than restating it, because two
 * definitions of paid-in is how two answers to one question begin.
 */
function isPaidIn(c: Cashflow): boolean {
  return PAID_IN.includes(c.type);
}

/**
 * Money that came back, whatever the notice called it.
 *
 * Income a fund pays out beside its distributions — interest on a bridge, a
 * dividend outside the commitment — is money returned, and the desk that
 * reports the fund counts it in what was distributed. `basis.ts` already does:
 * anything not paid in is distributed there, so leaving it out here would be
 * the second definition of one figure.
 */
function isDistribution(c: Cashflow): boolean {
  return c.type === 'Distribution' || c.type === 'Return of Capital' || c.type === 'Income';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

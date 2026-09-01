/**
 * Gross analysis — the portfolio, before anything the vehicle charges.
 *
 * "Gross" here means the underlying holdings measured on their own terms: what
 * was committed to them, what they drew, what they returned, what they are
 * worth. Management fees, carry and vehicle-level expenses do not appear. The
 * gross and net tiers are not expected to reconcile to each other and should
 * never be presented as though they do.
 */

import { periodEndDate, previousPeriod, type PeriodId } from '../domain/period';
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
import { irrWithTerminalValue, multiples, type DatedFlow, type Multiples } from './metrics';
import { resolvePositionStates, weakest, type CoverageSummary, type PositionState } from './completeness';
import type { ReportingConventions } from '../domain/types';

export interface PositionResult {
  position: Position;
  state: PositionState;
  /** All figures below are in presentation currency. */
  nav: number;
  navPrior: number;
  commitment: number;
  drawn: number;
  distributed: number;
  recallable: number;
  undrawn: number;
  /** Undrawn plus recallable — what the vehicle may still have to fund. */
  openCommitment: number;
  callsInPeriod: number;
  distributionsInPeriod: number;
  valueChange: number;
  fxEffect: number;
  multiples: Multiples;
  irr?: number;
  provenance: Provenance;
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

  const current = resolvePositionStates(
    positions, valuations, cashflows, period, policy, knowledgeDate,
  );
  // The comparative is resolved through the same machinery, so a restated prior
  // quarter shows the same number the current-quarter bridge opens from.
  const priorResolved = resolvePositionStates(
    positions, valuations, cashflows, prior, policy, knowledgeDate,
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
      .filter((c) => c.status !== 'Draft');
    const inPeriod = forPeriod(positionFlows, period, knowledgeDate)
      .filter((c) => c.status !== 'Draft');

    const convertFlow = (c: Cashflow) =>
      c.amount * (rates.tryRate(c.currency, presentationCurrency, c.period, flowKind) ?? 1);

    // Calls are negative from the vehicle's perspective; report them positive.
    const drawn = -sum(toDate.filter(isCall).map(convertFlow));
    const distributed = sum(toDate.filter(isDistribution).map(convertFlow));
    const recallable = sum(
      toDate.filter((c) => isDistribution(c) && c.recallable).map(convertFlow),
    );
    const callsInPeriod = -sum(inPeriod.filter(isCall).map(convertFlow));
    const distributionsInPeriod = sum(inPeriod.filter(isDistribution).map(convertFlow));

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
      multiples: multiples({ paidIn: drawn, distributed, nav }),
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
  const priorConvert = (c: Cashflow) =>
    c.amount * (rates.tryRate(c.currency, currency, c.period, flowKind) ?? 1);
  const priorFlows = throughPeriod(
    cashflows.filter((c) => c.positionId),
    prior,
    knowledgeDate,
  ).filter((c) => c.status !== 'Draft');
  const drawnPrior = -sum(priorFlows.filter(isCall).map(priorConvert));

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
    .filter((c) => c.status !== 'Draft')
    .filter((c) => isCall(c) || isDistribution(c))
    .map((c) => ({
      date: new Date(c.date),
      amount: c.amount * (rates.tryRate(c.currency, currency, c.period, flowKind) ?? 1),
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
    distributionsInPeriod: sum(results.map((r) => r.distributionsInPeriod)),
    valueChange: sum(results.map((r) => r.valueChange)),
    fxEffect: sum(results.map((r) => r.fxEffect)),
    percentInvested: commitments > 0 ? drawn / commitments : 0,
    multiples: multiples({ paidIn: drawn, distributed, nav }),
    irr: irrWithTerminalValue(allFlows, nav, new Date(periodEndDate(period))),
  };
}

function isCall(c: Cashflow): boolean {
  return c.type === 'Capital Call' || c.type === 'Equalisation';
}

function isDistribution(c: Cashflow): boolean {
  return c.type === 'Distribution' || c.type === 'Return of Capital';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

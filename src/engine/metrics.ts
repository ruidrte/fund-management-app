/**
 * Performance metrics.
 *
 * XIRR is solved by Newton–Raphson with a bisection fallback, because Newton
 * alone diverges on the cashflow shapes private funds actually produce — a long
 * run of calls followed by one large late distribution. Returning a wrong root
 * quietly is worse than returning `undefined`, so an unsolved IRR is undefined.
 */

export interface DatedFlow {
  date: Date;
  /** Signed: money leaving the investor is negative, money returned positive. */
  amount: number;
}

const DAYS_PER_YEAR = 365;

export function npv(rate: number, flows: DatedFlow[]): number {
  if (flows.length === 0) return 0;
  const base = flows.reduce(
    (earliest, flow) => (flow.date < earliest ? flow.date : earliest),
    flows[0].date,
  );
  return flows.reduce((total, flow) => {
    const years = (flow.date.getTime() - base.getTime()) / (86_400_000 * DAYS_PER_YEAR);
    return total + flow.amount / Math.pow(1 + rate, years);
  }, 0);
}

/**
 * Money-weighted return on irregularly dated flows, as a decimal (0.12 = 12%).
 * Undefined when the flows cannot produce a rate: fewer than two flows, or all
 * of them the same sign.
 */
export function xirr(flows: DatedFlow[], guess = 0.1): number | undefined {
  const meaningful = flows.filter((f) => f.amount !== 0);
  if (meaningful.length < 2) return undefined;
  if (!meaningful.some((f) => f.amount > 0)) return undefined;
  if (!meaningful.some((f) => f.amount < 0)) return undefined;

  const newton = solveNewton(meaningful, guess);
  if (newton !== undefined) return newton;
  return solveBisection(meaningful);
}

function solveNewton(flows: DatedFlow[], guess: number): number | undefined {
  let rate = guess;
  for (let i = 0; i < 100; i += 1) {
    const value = npv(rate, flows);
    if (Math.abs(value) < 1e-7) return rate;

    const step = 1e-6;
    const derivative = (npv(rate + step, flows) - value) / step;
    if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) return undefined;

    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.9999) return undefined;
    if (Math.abs(next - rate) < 1e-9) return next;
    rate = next;
  }
  return undefined;
}

function solveBisection(flows: DatedFlow[]): number | undefined {
  let low = -0.9999;
  let high = 10;
  let valueLow = npv(low, flows);
  let valueHigh = npv(high, flows);

  // Widen once before giving up — a >1000% IRR is rare but real in early venture.
  if (valueLow * valueHigh > 0) {
    high = 100;
    valueHigh = npv(high, flows);
    if (valueLow * valueHigh > 0) return undefined;
  }

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const valueMid = npv(mid, flows);
    if (Math.abs(valueMid) < 1e-9 || (high - low) / 2 < 1e-9) return mid;
    if (valueLow * valueMid < 0) {
      high = mid;
      valueHigh = valueMid;
    } else {
      low = mid;
      valueLow = valueMid;
    }
  }
  return (low + high) / 2;
}

export interface MultipleInputs {
  /** Capital paid in, positive. */
  paidIn: number;
  /** Capital returned, positive. */
  distributed: number;
  /** Residual value at the measurement date. */
  nav: number;
}

export interface Multiples {
  tvpi?: number;
  dpi?: number;
  rvpi?: number;
}

/**
 * Multiples are undefined rather than zero when there is no paid-in capital.
 * A fund that has drawn nothing has no TVPI; reporting 0.00x would read as a
 * total loss.
 */
export function multiples({ paidIn, distributed, nav }: MultipleInputs): Multiples {
  if (paidIn <= 0) return { tvpi: undefined, dpi: undefined, rvpi: undefined };
  return {
    tvpi: (distributed + nav) / paidIn,
    dpi: distributed / paidIn,
    rvpi: nav / paidIn,
  };
}

/**
 * IRR including the residual value as a terminal inflow at the measurement
 * date — the standard private-markets convention.
 */
export function irrWithTerminalValue(
  flows: DatedFlow[],
  nav: number,
  measurementDate: Date,
): number | undefined {
  if (nav === 0 && flows.length === 0) return undefined;
  return xirr([...flows, { date: measurementDate, amount: nav }]);
}

/** Compound a quarterly return series into a period return. */
export function compound(returns: number[]): number {
  return returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** Annualise a return achieved over `years`. */
export function annualise(totalReturn: number, years: number): number | undefined {
  if (years <= 0) return undefined;
  return Math.pow(1 + totalReturn, 1 / years) - 1;
}

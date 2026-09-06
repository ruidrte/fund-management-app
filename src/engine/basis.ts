/**
 * The bases a return can be measured on.
 *
 * One holding, four answers, and all four are correct — they differ in which
 * flows the question admits. An advisory mandate reports all of them side by
 * side, because each answers something different:
 *
 *   On commitment      what the capital committed to the fund earned. Calls out,
 *                      distributions back, the holding's value at the end. It is
 *                      the number the manager's own report is comparable with.
 *   With off-commitment adds the flows that are with the fund but outside the
 *                      commitment — the interest-equivalent paid or received for
 *                      joining a closing late. Real money, and invisible in the
 *                      first.
 *   After fees         adds what the holder paid the adviser. Charged for a fund
 *                      but not paid to it, so it never appears in a portfolio
 *                      figure — and it is the difference between what the fund
 *                      returned and what the holder kept.
 *   Restated           the same flows in the holder's own currency, each at the
 *                      rate of its own date. A pension fund that reports in
 *                      francs earned the franc number, whatever the dollar
 *                      number says.
 *
 * They are cumulative, so the gap between any two is exactly what the wider one
 * admits. That is the point of showing them together: the fee drag and the
 * currency drag are read off the differences rather than argued about.
 *
 * Nothing here is stored. A return is a function of the flows and the valuation,
 * and a stored return is one restatement away from disagreeing with them.
 */

import { periodEndDate, type PeriodId } from '../domain/period';
import type { Cashflow, CashflowType, CurrencyCode, FxRate, PositionValuation } from '../domain/types';
import { irrWithTerminalValue, multiples, type DatedFlow } from './metrics';

export type BasisKey = 'on-commitment' | 'with-off-commitment' | 'after-fees' | 'restated';

export interface ReturnBasis {
  key: BasisKey;
  /** What the basis admits, in the words a report prints. */
  label: string;
  currency: CurrencyCode;
  irr?: number;
  paidIn: number;
  distributed: number;
  residual: number;
  tvpi?: number;
  dpi?: number;
  rvpi?: number;
  /** How many flows the return ran over, terminal value aside. */
  flows: number;
  /**
   * Why there is no IRR, where the flows would have produced one.
   *
   * A rate of return is an annual rate. Annualising a fortnight compounds
   * whatever happened in it twenty-six times, and what comes out is not a
   * property of the investment — a holding drawn twelve days before the
   * reporting date has printed three hundred per cent this way. The multiple is
   * still meaningful over any span; the rate is not, and saying so is better
   * than printing it with a footnote.
   */
  irrNote?: string;
  /**
   * Flows the basis should have admitted and could not, each named. A basis
   * with anything here is incomplete, and saying which line is missing is the
   * difference between a figure somebody can fix and one they cannot trust.
   */
  missing: string[];
}

/**
 * What the commitment itself is drawn and returned through. Everything else a
 * fund does with its investor — an equalisation, a true-up, income paid outside
 * the commitment — is a flow with the fund but not a movement of it.
 */
const ON_COMMITMENT: CashflowType[] = ['Capital Call', 'Distribution', 'Return of Capital'];

/**
 * The shortest span an annualised rate is worth quoting over.
 *
 * A quarter. Below it the compounding does the talking: a two per cent move
 * over twelve days annualises to eighty, and the number describes the calendar
 * rather than the investment.
 */
const MEANINGFUL_DAYS = 90;

/** A commitment is a promise, not a payment; it never enters a return. */
const NOT_CASH: CashflowType[] = ['Commitment'];

/**
 * Which side of the multiples a flow nets against.
 *
 * By what it is, not by which way it points. A negative capital call is capital
 * coming back out of what was paid in — a reversal of that side — and not a
 * distribution of profit; a refunded fee reduces the fee paid rather than
 * paying the holder a dividend. Splitting on the sign instead puts the same
 * amount into the numerator and the denominator at once, which moves both
 * multiples and moves them away from what the source workbook states.
 *
 * The identity survives either way: TVPI is still DPI plus RVPI, because all
 * three are over the same denominator.
 */
const PAID_IN: CashflowType[] = ['Capital Call', 'Equalisation', 'Fee', 'Expense'];

export interface BasisRequest {
  cashflows: Cashflow[];
  valuations: PositionValuation[];
  fxRates: FxRate[];
  positionId: string;
  /** The holding's own currency, which the first three bases are stated in. */
  currency: CurrencyCode;
  period: PeriodId;
  /** The currency the fourth basis restates into. Omitted, there are three. */
  restateIn?: CurrencyCode;
  /**
   * Report every basis in this currency, converting each flow at the rate of
   * its own day.
   *
   * Different from `restateIn`, which adds a basis. This changes the unit the
   * others are stated in — what a fund-level table needs, where four holdings
   * in three currencies have to be added up before they can be compared.
   */
  stateIn?: CurrencyCode;
  /**
   * Admit the rows that restate an earlier basis.
   *
   * False, and rightly, for anything reported: nothing was paid or received on
   * the day a basis changed. True only to reconstruct what the previous basis
   * said — which is worth doing exactly once, on the page that explains why
   * this quarter's figure differs from the one published last quarter.
   */
  includeRestatements?: boolean;
}

export function returnBases(request: BasisRequest): ReturnBasis[] {
  const { cashflows, valuations, positionId, currency, period, restateIn } = request;
  const end = periodEndDate(period);

  const mine = cashflows.filter(
    (flow) => (flow.positionId === positionId || flow.chargedFor === positionId)
      && flow.date <= end
      && flow.status !== 'Draft'
      && (request.includeRestatements || !flow.restatement)
      && !NOT_CASH.includes(flow.type),
  );

  // The holding's value at the measurement date, as the latest thing said about
  // it. A basis with no valuation still has multiples; it has no IRR, because
  // an IRR without a terminal value is a return on a fund that ended.
  const valued = valuations
    .filter((row) => row.positionId === positionId && row.period <= period)
    .sort((a, b) => (a.period === b.period
      ? a.recordedAt.localeCompare(b.recordedAt)
      : a.period.localeCompare(b.period)));
  const residual = valued[valued.length - 1]?.nav ?? 0;

  const admits: Array<{ key: BasisKey; label: string; takes: (flow: Cashflow) => boolean }> = [
    {
      key: 'on-commitment',
      label: 'On commitment',
      takes: (flow) => flow.positionId === positionId && ON_COMMITMENT.includes(flow.type),
    },
    {
      key: 'with-off-commitment',
      label: 'Including off-commitment',
      takes: (flow) => flow.positionId === positionId,
    },
    {
      key: 'after-fees',
      label: 'After the adviser’s fee',
      takes: () => true,
    },
  ];

  const { stateIn } = request;
  const inOwn = !stateIn || stateIn === currency;
  const shown = inOwn ? undefined : convert(mine, residual, stateIn, request, end);

  const bases = admits.map(({ key, label, takes }) => (
    inOwn
      ? measure(key, label, currency, mine.filter(takes), residual, end)
      : measure(key, label, stateIn!, shown!.flows.filter((flow) => takes(flow.of)),
        shown!.residual, end, shown!.missing)
  ));

  if (restateIn && restateIn !== (stateIn ?? currency)) {
    bases.push(restate(mine, residual, request, end));
  }
  return bases;
}

function measure(
  key: BasisKey, label: string, currency: CurrencyCode,
  flows: Array<{ date: string; amount: number; type: CashflowType; description?: string }>,
  residual: number, end: string, missing: string[] = [],
): ReturnBasis {
  const dated: DatedFlow[] = flows.map((flow) => ({ date: new Date(flow.date), amount: flow.amount }));
  const paidIn = -flows.filter((flow) => PAID_IN.includes(flow.type))
    .reduce((sum, flow) => sum + flow.amount, 0);
  const distributed = flows.filter((flow) => !PAID_IN.includes(flow.type))
    .reduce((sum, flow) => sum + flow.amount, 0);

  const first = dated.reduce<number | undefined>(
    (earliest, flow) => (earliest === undefined || flow.date.getTime() < earliest
      ? flow.date.getTime()
      : earliest),
    undefined,
  );
  const days = first === undefined
    ? 0
    : Math.round((new Date(end).getTime() - first) / 86_400_000);
  const tooShort = dated.length > 0 && days < MEANINGFUL_DAYS;

  return {
    key,
    label,
    currency,
    irr: tooShort || (residual === 0 && dated.length === 0)
      ? undefined
      : irrWithTerminalValue(dated, residual, new Date(end)),
    irrNote: tooShort
      ? `${days} day(s) from the first flow — too short for an annualised rate to mean anything`
      : undefined,
    paidIn,
    distributed,
    residual,
    ...multiples({ paidIn, distributed, nav: residual }),
    flows: dated.length,
    missing,
  };
}

/**
 * The same flows in another currency, each at the rate recorded against it.
 *
 * Not at one rate. A return restated at the closing rate is the dollar return
 * with a currency movement painted over it; what the holder actually earned
 * depends on the rate the day each call was paid. The book keeps a rate beside
 * every line for exactly this, and a line that has none is left out and named
 * rather than converted at whatever rate is nearest.
 */
interface Converted {
  flows: Array<{ date: string; amount: number; type: CashflowType; description?: string; of: Cashflow }>;
  residual: number;
  missing: string[];
}

/** Every flow at the rate of its own day, and the valuation at the closing one. */
function convert(
  flows: Cashflow[], residual: number, into: CurrencyCode, request: BasisRequest, end: string,
): Converted {
  const { fxRates, currency, period } = request;

  const converted: Converted['flows'] = [];
  const missing: string[] = [];
  for (const flow of flows) {
    const rate = rateOn(fxRates, flow.currency, into, flow.date, kindFor(flow));
    if (rate === undefined) {
      missing.push(`${flow.description ?? flow.type} on ${flow.date}`);
      continue;
    }
    converted.push({
      date: flow.date, amount: flow.amount * rate, type: flow.type,
      description: flow.description, of: flow,
    });
  }

  // The valuation is a stock and is restated at the closing rate — never at
  // whichever other rate happens to carry the same date. A quarter end is
  // exactly where several do: the last fee of the quarter is invoiced at the
  // quarter's average and settled on the same day the book is struck, and
  // taking that one would move the whole residual value by the spread between
  // them.
  const closing = rateOn(fxRates, currency, into, end, 'closing')
    ?? lastRate(fxRates, currency, into, periodEndDate(period));
  if (closing === undefined && residual !== 0) {
    missing.push(`the closing valuation at ${end}`);
  }

  return {
    flows: converted,
    residual: closing === undefined ? 0 : residual * closing,
    missing,
  };
}

function restate(
  flows: Cashflow[], residual: number, request: BasisRequest, end: string,
): ReturnBasis {
  const into = request.restateIn!;
  const shown = convert(flows, residual, into, request, end);
  return measure('restated', `In ${into}, at each flow’s own rate`, into,
    shown.flows, shown.residual, end, shown.missing);
}

/**
 * Which rate a flow is restated at: the one its own kind was recorded under.
 *
 * A fee is invoiced against a quarter and converted at that quarter's average;
 * a call or a distribution is money moving on a day and converted at that day's
 * rate. The book files them under exactly those two kinds, so this only has to
 * ask for the right one back.
 */
function kindFor(flow: Cashflow): 'closing' | 'average' {
  return flow.type === 'Fee' || flow.type === 'Expense' ? 'average' : 'closing';
}

/**
 * The rate recorded for this exact date, in either direction.
 *
 * The kind is asked for first and only then relaxed: a date can carry more than
 * one rate, and choosing between them by which was loaded first is no rule at
 * all.
 */
function rateOn(
  rates: FxRate[], from: CurrencyCode, to: CurrencyCode, date: string,
  want?: 'closing' | 'average',
): number | undefined {
  if (from === to) return 1;
  const onDate = rates.filter((row) => row.date === date);
  const preferred = want ? onDate.filter((row) => row.kind === want) : [];
  for (const rows of [preferred, onDate]) {
    if (rows.length === 0) continue;
    const direct = rows.filter((row) => row.base === from && row.quote === to);
    if (direct.length > 0) return newest(direct).rate;
    const inverse = rows.filter((row) => row.base === to && row.quote === from);
    if (inverse.length > 0) return 1 / newest(inverse).rate;
  }
  return undefined;
}

/** The last rate recorded on or before a date, for the closing valuation. */
function lastRate(
  rates: FxRate[], from: CurrencyCode, to: CurrencyCode, date: string,
): number | undefined {
  if (from === to) return 1;
  const upTo = rates.filter((row) => row.date <= date
    && ((row.base === from && row.quote === to) || (row.base === to && row.quote === from)));
  if (upTo.length === 0) return undefined;
  const last = upTo.sort((a, b) => (a.date === b.date
    ? a.recordedAt.localeCompare(b.recordedAt)
    : a.date.localeCompare(b.date)))[upTo.length - 1];
  return last.base === from ? last.rate : 1 / last.rate;
}

function newest(rows: FxRate[]): FxRate {
  return rows.reduce((best, row) => (row.recordedAt > best.recordedAt ? row : best), rows[0]);
}

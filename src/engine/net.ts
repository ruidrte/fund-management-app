/**
 * Net analysis — what the investor actually gets, at two levels.
 *
 *   product level : the vehicle as a whole, after its fees, expenses and carry
 *   investor level: one LP's capital account inside that vehicle
 *
 * The product-level NAV is not the portfolio NAV. It is the portfolio plus the
 * vehicle's own cash and receivables, less its liabilities and accrued costs.
 * Conflating the two is the single most common error in fund-of-funds reporting,
 * so the two figures are computed separately and the bridge between them is
 * reported explicitly rather than assumed away.
 */

import { periodEndDate, previousPeriod, type PeriodId } from '../domain/period';
import type {
  Cashflow,
  CurrencyCode,
  Investor,
  Metric,
  Provenance,
  ReportingConventions,
  Vehicle,
  VehicleBalanceSheet,
} from '../domain/types';
import { forPeriod, latestThrough, throughPeriod, visibleAt } from './asof';
import { flowRateKind, type RateLookup } from './fx';
import { irrWithTerminalValue, multiples, type DatedFlow, type Multiples, moved } from './metrics';
import type { GrossResult } from './gross';

export interface NavComponents {
  portfolio: number;
  cash: number;
  otherAssets: number;
  currentLiabilities: number;
  accruedExpenses: number;
  /** The four above, netted. This is the vehicle NAV investors own. */
  vehicleNav: number;
}

export interface ProductNetResult {
  period: PeriodId;
  currency: CurrencyCode;
  components: NavComponents;
  componentsPrior: NavComponents;
  commitment: number;
  called: number;
  distributed: number;
  undrawn: number;
  percentCalled: number;
  calledInPeriod: number;
  distributedInPeriod: number;
  /** Fees and expenses charged this period, and since inception. */
  feesInPeriod: number;
  feesCumulative: number;
  multiples: Multiples;
  irr?: number;
  provenance: Provenance;
  /** True when the balance sheet for the period was not available. */
  balanceSheetEstimated: boolean;
  /**
   * Shares in issue and what one is worth, for a vehicle that is unitised.
   *
   * Absent for one that is not, which is most of them: a closed-end fund has
   * commitments and capital accounts and no share price at all, and inventing
   * one for it would be a figure nobody could reconcile to anything.
   */
  units?: ProductUnits;
}

export interface ProductUnits {
  /** Shares in issue at the period end, where the register states them. */
  units: number;
  /** The fund's net asset value divided by them. */
  navPerShare: number;
  /**
   * True where every investor's shares are stated for this period. False means
   * the register has not been rolled and the price is carried by whoever is in
   * it — which is a number to look at rather than to publish.
   */
  complete: boolean;
}

export interface InvestorNetResult {
  investor: Investor;
  currency: CurrencyCode;
  commitment: number;
  called: number;
  distributed: number;
  undrawn: number;
  nav: number;
  navPrior: number;
  /** Share of the vehicle, by units where it is unitised, else by capital account. */
  ownership: number;
  /** Shares held at the period end, where the register states them. */
  units?: number;
  /** What one share is worth on this account. */
  navPerShare?: number;
  /** True where the net asset value is the administrator's confirmed account. */
  navStated: boolean;
  multiples: Multiples;
  irr?: number;
  provenance: Provenance;
  /** True when the capital account was allocated pro rata, not booked directly. */
  allocated: boolean;
}

export interface NetInputs {
  gross: GrossResult;
  investors: Investor[];
  /**
   * The vehicles in scope — one normally, several on a consolidated view.
   *
   * Their `investorCommitment` is the authoritative total; deriving it by
   * summing the investor rows breaks the moment the list is incomplete, which
   * is exactly what happens for an investor login. Taking a set rather than one
   * vehicle is what keeps a consolidated view coherent: the balance sheets and
   * the investor flows have to come from the same vehicles the portfolio did,
   * or the numerator and denominator of every multiple describe different funds.
   */
  vehicles: Vehicle[];
  cashflows: Cashflow[];
  balanceSheets: VehicleBalanceSheet[];
  /**
   * What the book states beside the flows — for a unitised vehicle, the shares
   * each investor holds and the capital account the administrator confirmed.
   * Where they exist an account is stated rather than allocated.
   */
  metrics: Metric[];
  period: PeriodId;
  presentationCurrency: CurrencyCode;
  rates: RateLookup;
  conventions: ReportingConventions;
  knowledgeDate?: string;
}

export interface NetResult {
  product: ProductNetResult;
  investors: InvestorNetResult[];
  /**
   * True when the investor list is incomplete — an investor login sees only its
   * own account. Ownership is then taken on commitment against the vehicle's
   * stated total, and the product-level called and distributed figures are that
   * investor's, not the fund's. Screens must say so rather than presenting them
   * as fund totals.
   */
  restricted: boolean;
}

export function computeNet(inputs: NetInputs): NetResult {
  const product = computeProductNet(inputs);
  product.units = productUnits(inputs, product);
  const investors = computeInvestorNet(inputs, product);
  return { product, investors, restricted: isRestricted(inputs) };
}

/**
 * The fund's total investor commitment, in presentation currency.
 *
 * Prefers the vehicle's own figure over the sum of the rows on screen. A fund's
 * size is a property of the fund, not an artefact of who is allowed to see the
 * register — and treating it as the latter inflates every multiple built on it
 * the moment one investor is looking.
 */
function totalCommitmentOf(
  inputs: NetInputs,
  convert: (amount: number, currency: CurrencyCode, period: PeriodId) => number,
): number {
  const visible = sum(inputs.investors.map((i) => convert(i.commitment, i.currency, inputs.period)));
  const stated = sum(inputs.vehicles.map(
    (v) => convert(v.investorCommitment, v.currency, inputs.period),
  ));
  return Math.max(visible, stated);
}

/** True when the visible investors do not account for the vehicle's commitment. */
function isRestricted(inputs: NetInputs): boolean {
  // Compared in the vehicles' own currencies, which is where both figures are
  // stated; a consolidated scope across currencies falls back to not restricted
  // rather than reporting a currency difference as a missing investor.
  const currencies = new Set(inputs.vehicles.map((v) => v.currency));
  if (currencies.size > 1) return false;

  const stated = sum(inputs.vehicles.map((v) => v.investorCommitment));
  if (stated <= 0) return false;
  const visible = sum(inputs.investors.map((i) => i.commitment));
  // A small tolerance: rounding in the register should not read as a restriction.
  return visible < stated * 0.999;
}

function computeProductNet(inputs: NetInputs): ProductNetResult {
  const {
    gross, cashflows, balanceSheets, vehicles, period,
    presentationCurrency, rates, conventions, knowledgeDate,
  } = inputs;

  const prior = previousPeriod(period);
  const flowKind = flowRateKind(conventions);
  const convert = (amount: number, currency: CurrencyCode, p: PeriodId) =>
    amount * (rates.tryRate(currency, presentationCurrency, p, flowKind) ?? 1);

  // One balance sheet per vehicle, summed. A consolidated view that took only
  // the first vehicle's would report three portfolios against one fund's cash.
  const inScope = new Set(vehicles.map((v) => v.id));
  const selectSheets = (target: PeriodId) => vehicles.map((vehicle) => {
    const own = balanceSheets.filter((b) => b.vehicleId === vehicle.id);
    const exact = forPeriod(own, target, knowledgeDate)
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
    return {
      vehicle,
      sheet: exact ?? latestThrough(own, target, knowledgeDate),
      exact: Boolean(exact),
    };
  });

  const current = selectSheets(period);
  const components = buildComponents(gross.totals.nav, current, rates, presentationCurrency, period);
  const componentsPrior = buildComponents(
    gross.totals.navPrior, selectSheets(prior), rates, presentationCurrency, prior,
  );

  const investorFlows = cashflows.filter(
    (c) => inScope.has(c.vehicleId) && c.investorId !== undefined,
  );
  const toDate = throughPeriod(investorFlows, period, knowledgeDate)
    .filter((c) => moved(c));
  const inPeriod = forPeriod(investorFlows, period, knowledgeDate)
    .filter((c) => moved(c));

  // Investor flows are signed from the vehicle's side, as every flow here is: a
  // capital call is money in and positive, a distribution money out and
  // negative. So each figure is the signed sum, turned round only where the
  // direction it is quoted in differs from the direction it is stored in.
  //
  // Summing absolute values instead is wrong the moment a register holds a
  // transfer between two investors, which is one investor's call reversed and
  // another's made. Netted, the pair moves capital between accounts and leaves
  // the fund's called capital unchanged; taken absolutely, both legs add and
  // the fund appears to have called twice the transferred amount that it did.
  const called = sum(toDate.filter(isInvestorCall).map((c) => convert(c.amount, c.currency, c.period)));
  const distributed = -sum(toDate.filter(isInvestorDistribution).map((c) => convert(c.amount, c.currency, c.period)));

  const feeFlows = cashflows.filter((c) => inScope.has(c.vehicleId) && isCost(c));
  const feesCumulative = sum(
    throughPeriod(feeFlows, period, knowledgeDate)
      .filter((c) => moved(c))
      .map((c) => convert(Math.abs(c.amount), c.currency, c.period)),
  );
  const feesInPeriod = sum(
    forPeriod(feeFlows, period, knowledgeDate)
      .filter((c) => moved(c))
      .map((c) => convert(Math.abs(c.amount), c.currency, c.period)),
  );

  const commitment = totalCommitmentOf(inputs, convert);

  const flows: DatedFlow[] = toDate
    .filter((c) => isInvestorCall(c) || isInvestorDistribution(c))
    .map((c) => ({
      date: new Date(c.date),
      amount: isInvestorCall(c)
        ? -convert(Math.abs(c.amount), c.currency, c.period)
        : convert(Math.abs(c.amount), c.currency, c.period),
    }));

  // A vehicle with no balance sheet for the period still reports, but the
  // provenance drops so the omission is visible rather than assumed to be zero.
  // Estimated when any vehicle in scope is missing its own filed sheet.
  const balanceSheetEstimated = current.some((entry) => !entry.exact);
  const provenance: Provenance = balanceSheetEstimated && gross.provenance === 'reported'
    ? 'estimated'
    : gross.provenance;

  return {
    period,
    currency: presentationCurrency,
    components,
    componentsPrior,
    commitment,
    called,
    distributed,
    // Unclamped, for the same reason as the portfolio side.
    undrawn: commitment - called,
    percentCalled: commitment > 0 ? called / commitment : 0,
    calledInPeriod: sum(inPeriod.filter(isInvestorCall).map((c) => convert(Math.abs(c.amount), c.currency, c.period))),
    distributedInPeriod: sum(inPeriod.filter(isInvestorDistribution).map((c) => convert(Math.abs(c.amount), c.currency, c.period))),
    feesInPeriod,
    feesCumulative,
    multiples: multiples({ paidIn: called, distributed, nav: components.vehicleNav }),
    irr: irrWithTerminalValue(flows, components.vehicleNav, new Date(periodEndDate(period))),
    provenance,
    balanceSheetEstimated,
  };
}

/**
 * Sums the vehicles' own balance sheets, each translated from its own currency.
 * A vehicle reporting in CHF and one in EUR cannot simply be added.
 */
function buildComponents(
  portfolio: number,
  entries: Array<{ vehicle: Vehicle; sheet?: VehicleBalanceSheet }>,
  rates: RateLookup,
  presentationCurrency: CurrencyCode,
  period: PeriodId,
): NavComponents {
  let cash = 0;
  let otherAssets = 0;
  let currentLiabilities = 0;
  let accruedExpenses = 0;

  for (const { vehicle, sheet } of entries) {
    if (!sheet) continue;
    // Balance-sheet items are stocks, so they translate at the closing rate.
    const rate = rates.tryRate(vehicle.currency, presentationCurrency, period) ?? 1;
    cash += sheet.cash * rate;
    otherAssets += sheet.otherAssets * rate;
    currentLiabilities += sheet.currentLiabilities * rate;
    accruedExpenses += sheet.accruedExpenses * rate;
  }

  return {
    portfolio,
    cash,
    otherAssets,
    currentLiabilities,
    accruedExpenses,
    vehicleNav: portfolio + cash + otherAssets - currentLiabilities - accruedExpenses,
  };
}

/**
 * Per-investor capital accounts.
 *
 * When an investor's own flows are booked, the account is built from them and
 * the residual NAV is allocated on the investor's share of net capital
 * contributed. When they are not, the whole account is allocated pro rata on
 * commitment and flagged — an allocated account is an approximation of an
 * equalised one and must not be presented as a statement of account.
 */
/**
 * The shares an investor holds at a period end, and the account the
 * administrator confirmed for it, as the book states them.
 *
 * Only for the period asked about: a share count is a position at a date, and
 * carrying last quarter's forward across a quarter in which shares were issued
 * splits the fund by a register that no longer describes it.
 */
function stated(
  metrics: Metric[], investorId: string, period: PeriodId, name: string, knowledgeDate?: string,
): number | undefined {
  const rows = visibleAt(
    metrics.filter(
      (m) => m.scope.kind === 'investor' && m.scope.id === investorId
        && m.period === period && m.metric === name,
    ),
    knowledgeDate,
  );
  return rows.length > 0 ? rows[rows.length - 1].value : undefined;
}

/**
 * The shares in issue and the price of one.
 *
 * Summed from the register rather than kept as a figure of its own: a share
 * count that is stored and a share count that is the sum of the accounts are
 * two numbers that will one day disagree, and the register is the one an
 * investor's statement is written from.
 */
export function productUnits(
  inputs: NetInputs, product: ProductNetResult,
): ProductUnits | undefined {
  const held = inputs.investors.map(
    (investor) => stated(inputs.metrics, investor.id, inputs.period, 'units', inputs.knowledgeDate),
  );
  const counted = held.filter((units): units is number => units !== undefined && units > 0);
  if (counted.length === 0) return undefined;
  const units = counted.reduce((total, value) => total + value, 0);

  // An investor who has been called and holds no shares is the register being
  // behind. One who has committed and not been called holds none because there
  // are none to hold, which is not the same thing and is not a gap.
  const missing = inputs.investors.filter((investor, index) => {
    if (held[index] !== undefined) return false;
    return throughPeriod(
      inputs.cashflows.filter((c) => c.investorId === investor.id && moved(c)),
      inputs.period,
      inputs.knowledgeDate,
    ).some(isInvestorCall);
  });

  return {
    units,
    navPerShare: product.components.vehicleNav / units,
    complete: missing.length === 0,
  };
}

function computeInvestorNet(inputs: NetInputs, product: ProductNetResult): InvestorNetResult[] {
  // No vehicle filter here: `cashflows` and `investors` are already narrowed to
  // the vehicles in scope before they reach the engine, so matching on the
  // investor alone is both correct and one fewer place to get the set wrong.
  const {
    investors, cashflows, metrics, period,
    presentationCurrency, rates, conventions, knowledgeDate,
  } = inputs;

  const prior = previousPeriod(period);
  const flowKind = flowRateKind(conventions);
  const convert = (amount: number, currency: CurrencyCode, p: PeriodId) =>
    amount * (rates.tryRate(currency, presentationCurrency, p, flowKind) ?? 1);

  const totalCommitment = totalCommitmentOf(inputs, convert);
  // With an incomplete register the net-contributed denominator is unknowable,
  // so ownership falls back to commitment against the vehicle's stated total.
  const restricted = isRestricted(inputs);

  // Net capital contributed per investor drives the NAV split. Commitment alone
  // would misallocate whenever investors entered at different times.
  const accounts = investors.map((investor) => {
    const own = cashflows.filter(
      (c) => c.investorId === investor.id && moved(c),
    );
    const toDate = throughPeriod(own, period, knowledgeDate);
    const toPrior = throughPeriod(own, prior, knowledgeDate);

    // Signed, as at product level above. An investor who transferred part of
    // their commitment away has that leg deducted from their own called
    // capital, which is what happened to it.
    const called = sum(toDate.filter(isInvestorCall).map((c) => convert(c.amount, c.currency, c.period)));
    const distributed = -sum(toDate.filter(isInvestorDistribution).map((c) => convert(c.amount, c.currency, c.period)));
    const calledPrior = sum(toPrior.filter(isInvestorCall).map((c) => convert(c.amount, c.currency, c.period)));
    const distributedPrior = -sum(toPrior.filter(isInvestorDistribution).map((c) => convert(c.amount, c.currency, c.period)));

    return {
      investor,
      hasOwnFlows: toDate.length > 0,
      commitment: convert(investor.commitment, investor.currency, period),
      called,
      distributed,
      netContributed: called - distributed,
      netContributedPrior: calledPrior - distributedPrior,
      flows: toDate
        .filter((c) => isInvestorCall(c) || isInvestorDistribution(c))
        .map((c) => ({
          date: new Date(c.date),
          amount: isInvestorCall(c)
            ? -convert(Math.abs(c.amount), c.currency, c.period)
            : convert(Math.abs(c.amount), c.currency, c.period),
        })),
    };
  });

  const totalNetContributed = sum(accounts.map((a) => a.netContributed));
  const totalNetContributedPrior = sum(accounts.map((a) => a.netContributedPrior));
  const anyOwnFlows = accounts.some((a) => a.hasOwnFlows);

  // A unitised vehicle is owned in shares, not in proportion to money paid in.
  // Where the register states the shares held at this period end for everybody,
  // that is the split — and the price of a share falls out of it rather than
  // being another figure to keep.
  const units = accounts.map(
    (a) => stated(metrics, a.investor.id, period, 'units', knowledgeDate),
  );
  const unitsPrior = accounts.map(
    (a) => stated(metrics, a.investor.id, prior, 'units', knowledgeDate),
  );
  const unitised = units.every((held) => held !== undefined && held > 0);
  const totalUnits = unitised ? sum(units as number[]) : 0;
  const unitisedPrior = unitsPrior.every((held) => held !== undefined && held > 0);
  const totalUnitsPrior = unitisedPrior ? sum(unitsPrior as number[]) : 0;

  return accounts.map((account, index) => {
    // Allocating is what to do when the book has no investors' ledger at all
    // and there is no other way to give anybody a capital account. It is not
    // what to do for one investor in a register that holds everybody else's
    // movements: there, an investor with no movements has made none, and giving
    // them a share of the fund's called capital invents a call they never
    // received. It also breaks the sum, because the invented amounts are added
    // on top of the real ones.
    const allocated = !anyOwnFlows;

    const byCommitment = totalCommitment > 0 ? account.commitment / totalCommitment : 0;

    const byUnits = unitised && totalUnits > 0 ? (units[index] as number) / totalUnits : undefined;
    const byUnitsPrior = unitisedPrior && totalUnitsPrior > 0
      ? (unitsPrior[index] as number) / totalUnitsPrior
      : undefined;

    const share = byUnits ?? (restricted || allocated || totalNetContributed <= 0
      ? byCommitment
      : account.netContributed / totalNetContributed);

    const sharePrior = byUnitsPrior ?? (restricted || allocated || totalNetContributedPrior <= 0
      ? byCommitment
      : account.netContributedPrior / totalNetContributedPrior);

    // A confirmed capital account outranks any split of the fund: it is what
    // the administrator told this investor they have. Where the two disagree
    // the identity check says so rather than either quietly winning.
    const confirmed = stated(metrics, account.investor.id, period, 'capitalAccount', knowledgeDate);
    const confirmedPrior = stated(metrics, account.investor.id, prior, 'capitalAccount', knowledgeDate);

    const nav = confirmed ?? product.components.vehicleNav * share;
    const navPrior = confirmedPrior ?? product.componentsPrior.vehicleNav * sharePrior;

    const called = allocated ? product.called * share : account.called;
    const distributed = allocated ? product.distributed * share : account.distributed;

    const flows: DatedFlow[] = allocated ? [] : account.flows;

    return {
      investor: account.investor,
      currency: presentationCurrency,
      commitment: account.commitment,
      called,
      distributed,
      undrawn: account.commitment - called,
      nav,
      navPrior,
      ownership: share,
      units: units[index],
      // What one share is worth, from the account the register states or from
      // the share of the fund it carries. Reported per investor because a
      // register that has not been rolled for the quarter gives one investor a
      // stated price and another a derived one, and the difference is the thing
      // worth seeing.
      navPerShare: units[index] ? nav / (units[index] as number) : undefined,
      navStated: confirmed !== undefined,
      multiples: multiples({ paidIn: called, distributed, nav }),
      irr: flows.length > 0
        ? irrWithTerminalValue(flows, nav, new Date(periodEndDate(period)))
        : undefined,
      provenance: allocated && anyOwnFlows ? 'estimated' : product.provenance,
      allocated,
    };
  });
}

function isInvestorCall(c: Cashflow): boolean {
  return c.type === 'Capital Call' || c.type === 'Equalisation';
}

function isInvestorDistribution(c: Cashflow): boolean {
  return c.type === 'Distribution' || c.type === 'Return of Capital';
}

function isCost(c: Cashflow): boolean {
  return c.type === 'Fee' || c.type === 'Expense';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

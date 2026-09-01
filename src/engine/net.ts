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
  Provenance,
  ReportingConventions,
  VehicleBalanceSheet,
} from '../domain/types';
import { forPeriod, latestThrough, throughPeriod } from './asof';
import { flowRateKind, type RateLookup } from './fx';
import { irrWithTerminalValue, multiples, type DatedFlow, type Multiples } from './metrics';
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
  /** Share of the vehicle, by capital account rather than by commitment. */
  ownership: number;
  multiples: Multiples;
  irr?: number;
  provenance: Provenance;
  /** True when the capital account was allocated pro rata, not booked directly. */
  allocated: boolean;
}

export interface NetInputs {
  gross: GrossResult;
  investors: Investor[];
  cashflows: Cashflow[];
  balanceSheets: VehicleBalanceSheet[];
  vehicleId: string;
  period: PeriodId;
  presentationCurrency: CurrencyCode;
  rates: RateLookup;
  conventions: ReportingConventions;
  knowledgeDate?: string;
}

export interface NetResult {
  product: ProductNetResult;
  investors: InvestorNetResult[];
}

export function computeNet(inputs: NetInputs): NetResult {
  const product = computeProductNet(inputs);
  const investors = computeInvestorNet(inputs, product);
  return { product, investors };
}

function computeProductNet(inputs: NetInputs): ProductNetResult {
  const {
    gross, cashflows, balanceSheets, vehicleId, period,
    presentationCurrency, rates, conventions, knowledgeDate,
  } = inputs;

  const prior = previousPeriod(period);
  const flowKind = flowRateKind(conventions);
  const convert = (amount: number, currency: CurrencyCode, p: PeriodId) =>
    amount * (rates.tryRate(currency, presentationCurrency, p, flowKind) ?? 1);

  const sheets = balanceSheets.filter((b) => b.vehicleId === vehicleId);
  const exact = forPeriod(sheets, period, knowledgeDate)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  const sheet = exact ?? latestThrough(sheets, period, knowledgeDate);
  const priorSheet = latestThrough(sheets, prior, knowledgeDate);

  const components = buildComponents(gross.totals.nav, sheet);
  const componentsPrior = buildComponents(gross.totals.navPrior, priorSheet);

  const investorFlows = cashflows.filter(
    (c) => c.vehicleId === vehicleId && c.investorId !== undefined,
  );
  const toDate = throughPeriod(investorFlows, period, knowledgeDate)
    .filter((c) => c.status !== 'Draft');
  const inPeriod = forPeriod(investorFlows, period, knowledgeDate)
    .filter((c) => c.status !== 'Draft');

  // Investor flows are signed from the vehicle's side: a capital call is money
  // in, a distribution money out. From the investor's side the signs reverse,
  // which is what the IRR below needs.
  const called = sum(toDate.filter(isInvestorCall).map((c) => convert(Math.abs(c.amount), c.currency, c.period)));
  const distributed = sum(toDate.filter(isInvestorDistribution).map((c) => convert(Math.abs(c.amount), c.currency, c.period)));

  const feeFlows = cashflows.filter(
    (c) => c.vehicleId === vehicleId && isCost(c),
  );
  const feesCumulative = sum(
    throughPeriod(feeFlows, period, knowledgeDate)
      .filter((c) => c.status !== 'Draft')
      .map((c) => convert(Math.abs(c.amount), c.currency, c.period)),
  );
  const feesInPeriod = sum(
    forPeriod(feeFlows, period, knowledgeDate)
      .filter((c) => c.status !== 'Draft')
      .map((c) => convert(Math.abs(c.amount), c.currency, c.period)),
  );

  const commitment = sum(
    inputs.investors.map((i) => convert(i.commitment, i.currency, period)),
  );

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
  const balanceSheetEstimated = !exact;
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

function buildComponents(portfolio: number, sheet?: VehicleBalanceSheet): NavComponents {
  const cash = sheet?.cash ?? 0;
  const otherAssets = sheet?.otherAssets ?? 0;
  const currentLiabilities = sheet?.currentLiabilities ?? 0;
  const accruedExpenses = sheet?.accruedExpenses ?? 0;
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
function computeInvestorNet(inputs: NetInputs, product: ProductNetResult): InvestorNetResult[] {
  const {
    investors, cashflows, vehicleId, period,
    presentationCurrency, rates, conventions, knowledgeDate,
  } = inputs;

  const prior = previousPeriod(period);
  const flowKind = flowRateKind(conventions);
  const convert = (amount: number, currency: CurrencyCode, p: PeriodId) =>
    amount * (rates.tryRate(currency, presentationCurrency, p, flowKind) ?? 1);

  const totalCommitment = sum(investors.map((i) => convert(i.commitment, i.currency, period)));

  // Net capital contributed per investor drives the NAV split. Commitment alone
  // would misallocate whenever investors entered at different times.
  const accounts = investors.map((investor) => {
    const own = cashflows.filter(
      (c) => c.vehicleId === vehicleId && c.investorId === investor.id && c.status !== 'Draft',
    );
    const toDate = throughPeriod(own, period, knowledgeDate);
    const toPrior = throughPeriod(own, prior, knowledgeDate);

    const called = sum(toDate.filter(isInvestorCall).map((c) => convert(Math.abs(c.amount), c.currency, c.period)));
    const distributed = sum(toDate.filter(isInvestorDistribution).map((c) => convert(Math.abs(c.amount), c.currency, c.period)));
    const calledPrior = sum(toPrior.filter(isInvestorCall).map((c) => convert(Math.abs(c.amount), c.currency, c.period)));
    const distributedPrior = sum(toPrior.filter(isInvestorDistribution).map((c) => convert(Math.abs(c.amount), c.currency, c.period)));

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

  return accounts.map((account) => {
    const allocated = !account.hasOwnFlows;

    const share = allocated || totalNetContributed <= 0
      ? (totalCommitment > 0 ? account.commitment / totalCommitment : 0)
      : account.netContributed / totalNetContributed;

    const sharePrior = allocated || totalNetContributedPrior <= 0
      ? (totalCommitment > 0 ? account.commitment / totalCommitment : 0)
      : account.netContributedPrior / totalNetContributedPrior;

    const nav = product.components.vehicleNav * share;
    const navPrior = product.componentsPrior.vehicleNav * sharePrior;

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

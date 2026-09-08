/**
 * The engine's single entry point.
 *
 * `analyse(dataset, scope)` takes a client's data and a scope — client, vehicle,
 * period, as-at date, presentation currency — and returns everything the
 * dashboards and reports need. Nothing downstream recomputes; the UI formats
 * what it is given. That is what keeps a report and the screen it was generated
 * from telling the same story.
 */

import {
  comparePeriods,
  previousPeriod,
  sortPeriods,
  type PeriodId,
} from '../domain/period';
import {
  DEFAULT_CONVENTIONS,
  type Asset,
  type AssetValuation,
  type CurrencyCode,
  type DataSet,
  type Position,
  type Provenance,
  type ReportingConventions,
  type Scope,
  type Vehicle,
} from '../domain/types';
import { latestThrough } from './asof';
import { buildRateLookup, type RateLookup } from './fx';
import { computeGross, type GrossResult } from './gross';
import { computeNet, type NetResult } from './net';
import { commitmentsBridge, describeQuarter, navBridge, productNavBridge, type Bridge } from './bridge';
import { unitScaleOf } from '../domain/types';
import {
  currencyExposure,
  lookThroughExposure,
  positionExposure,
  type ExposureBreakdown,
  type ExposureDimension,
} from './exposure';
import { runChecks, type CheckReport } from './checks';
import { knownPeriods, restatementDates } from './asof';

export * from './asof';
export * from './fx';
export * from './metrics';
export * from './basis';
export * from './completeness';
export * from './gross';
export * from './net';
export * from './bridge';
export * from './exposure';
export * from './checks';
export * from './inventory';

/** One look-through holding, as at the period. */
export interface UnderlyingHolding {
  asset: Asset;
  /** The holding it sits inside, and whether that holding is its own level. */
  position: Position;
  period?: PeriodId;
  /** What it cost, what has come back, and what is still held. */
  invested: number;
  realised: number;
  unrealised: number;
  /**
   * The gross multiple as the manager publishes it: everything the investment
   * has produced — what is still held plus what has come back — over what it
   * cost. The workbook's own column computes it this way, and its gain-or-loss
   * column is the same numerator less cost.
   */
  grossMultiple?: number;
  /**
   * What is still held, over cost.
   *
   * Both are shown because neither answers the other's question. Fund V's
   * properties are worth 0.92 of what they cost and have returned 33.6m
   * besides, which brings them to 0.99 — and a single column has to drop one
   * of those two facts.
   */
  fairValueMultiple?: number;
  /** True where the figures are the underlying fund's whole portfolio, at 100%. */
  whole: boolean;
  provenance: Provenance;
}

export interface QuarterView {
  scope: Scope;
  vehicles: Vehicle[];
  currency: CurrencyCode;
  period: PeriodId;
  priorPeriod: PeriodId;
  conventions: ReportingConventions;

  gross: GrossResult;
  net: NetResult;
  bridges: {
    portfolioNav: Bridge;
    commitments: Bridge;
    productNav: Bridge;
  };
  exposure: Record<string, ExposureBreakdown>;
  lookThrough: Record<string, ExposureBreakdown>;
  /**
   * The look-through holdings themselves, valued at the period.
   *
   * The breakdowns above answer where the money is; this answers what it is
   * in. For a fund-of-funds the two are close enough that the register of
   * holdings suffices — but where the assets are the underlying fund's own
   * portfolio, they are the thing being monitored, and their multiple over
   * cost is the figure the reader came for.
   */
  underlying: UnderlyingHolding[];
  checks: CheckReport;
  /**
   * The rate table as it applied to this view, so a screen can answer "which
   * rate did you use, and what did it displace" without rebuilding the lookup
   * from the dataset and risking a different knowledge date.
   */
  rates: RateLookup;
  /** Currencies translated into the presentation currency for this view. */
  sourceCurrencies: CurrencyCode[];

  /** One sentence describing the quarter, generated from the NAV bridge. */
  summary: string;
  /** Weakest provenance anywhere in the view. */
  provenance: Provenance;
  /** True when the quarter is complete and every check passed. */
  isFinal: boolean;
  /** Why it is not final. Empty when it is. */
  qualifications: string[];
}

const DEFAULT_DIMENSIONS: ExposureDimension[] = [
  'assetClass',
  'subAssetClass',
  'region',
  'vintage',
  'currency',
  'manager',
  'positionKind',
];

const LOOK_THROUGH_DIMENSIONS: ExposureDimension[] = [
  'sector',
  'country',
  'region',
  'assetClass',
];

export function analyse(dataset: DataSet, scope: Scope): QuarterView {
  const vehicles = selectVehicles(dataset, scope);
  const conventions = resolveConventions(dataset, vehicles);
  const currency = scope.presentationCurrency
    ?? vehicles[0]?.currency
    ?? dataset.client.reportingCurrency;

  const vehicleIds = new Set(vehicles.map((v) => v.id));

  let positions = dataset.positions.filter((p) => vehicleIds.has(p.vehicleId));
  if (scope.positionId) positions = positions.filter((p) => p.id === scope.positionId);

  const positionIds = new Set(positions.map((p) => p.id));
  let assets = dataset.assets.filter((a) => positionIds.has(a.positionId));
  if (scope.assetId) assets = assets.filter((a) => a.id === scope.assetId);

  const valuations = dataset.positionValuations.filter((v) => positionIds.has(v.positionId));
  const assetIds = new Set(assets.map((a) => a.id));
  const assetValuations = dataset.assetValuations.filter((v) => assetIds.has(v.assetId));

  // A flow naming a holding or an investor the book no longer has is a
  // dangling reference, not a narrower view: it survived a record being
  // replaced under a new identifier, and counting it would put a retired
  // investor's fees into the fund's total with nobody to attribute them to.
  //
  // Judged against the whole book rather than against what is in scope, since
  // an investor login sees one investor and every other investor's flows are
  // in the book, not dangling. Which of those a restricted view should count
  // is a different question, and `restricted` is where it is answered.
  const knownInvestors = new Set(dataset.investors.map((i) => i.id));
  const cashflows = dataset.cashflows.filter(
    (c) => vehicleIds.has(c.vehicleId)
      && (!c.positionId || positionIds.has(c.positionId))
      && (!c.investorId || knownInvestors.has(c.investorId)),
  );
  const investors = dataset.investors.filter((i) => vehicleIds.has(i.vehicleId));
  const balanceSheets = dataset.balanceSheets.filter((b) => vehicleIds.has(b.vehicleId));

  const rates = buildRateLookup(dataset.fxRates, scope.knowledgeDate);

  const gross = computeGross({
    positions,
    valuations,
    cashflows,
    period: scope.period,
    presentationCurrency: currency,
    rates,
    conventions,
    knowledgeDate: scope.knowledgeDate,
  });

  const net = computeNet({
    gross,
    investors,
    vehicles,
    cashflows,
    balanceSheets,
    metrics: dataset.metrics,
    period: scope.period,
    presentationCurrency: currency,
    rates,
    conventions,
    knowledgeDate: scope.knowledgeDate,
  });

  const bridges = {
    portfolioNav: navBridge(gross),
    commitments: commitmentsBridge(gross),
    productNav: productNavBridge(gross, net.product),
  };

  const exposure: Record<string, ExposureBreakdown> = {};
  for (const dimension of DEFAULT_DIMENSIONS) {
    exposure[dimension] = dimension === 'currency'
      ? currencyExposure(gross.positions, currency)
      : positionExposure(gross.positions, dimension, currency);
  }

  const lookThrough: Record<string, ExposureBreakdown> = {};
  if (assets.length > 0) {
    for (const dimension of LOOK_THROUGH_DIMENSIONS) {
      lookThrough[dimension] = lookThroughExposure(
        gross.positions, assets, assetValuations, dimension,
        scope.period, currency, rates, scope.knowledgeDate,
      );
    }
  }

  const checks = runChecks(gross, net, Object.values(bridges), Object.values(exposure));

  const qualifications = [
    ...gross.qualifications,
    ...(net.product.balanceSheetEstimated
      ? ['No vehicle balance sheet for the period — net NAV carries the last known one']
      : []),
    ...(vehicles.length > 1
      ? [`Consolidated across ${vehicles.length} vehicles — balance sheets and investor flows are summed`]
      : []),
    ...checks.results
      .filter((r) => r.status === 'fail')
      .map((r) => `Check failed: ${r.label}`),
  ];

  return {
    scope,
    vehicles,
    currency,
    period: scope.period,
    priorPeriod: previousPeriod(scope.period),
    conventions,
    gross,
    net,
    bridges,
    exposure,
    lookThrough,
    underlying: underlyingHoldings(assets, assetValuations, positions, scope),
    checks,
    rates,
    sourceCurrencies: [...new Set([
      ...vehicles.map((v) => v.currency),
      ...positions.map((p) => p.currency),
    ])].filter((code) => code !== currency).sort(),
    summary: describeQuarter(bridges.portfolioNav, scope.period, unitScaleOf(vehicles) ?? 1000),
    provenance: gross.provenance,
    isFinal: gross.coverage.complete && checks.ok && qualifications.length === 0,
    qualifications,
  };
}

/**
 * Every look-through holding in scope, with its latest valuation at the period.
 *
 * Latest at or before, not exactly at: a property valued in March and not since
 * is still held in June, and dropping it would shrink the portfolio rather than
 * report it stale. The period it was actually valued at travels with it, so a
 * screen can say which.
 */
function underlyingHoldings(
  assets: Asset[], valuations: AssetValuation[], positions: Position[], scope: Scope,
): UnderlyingHolding[] {
  const positionOf = new Map(positions.map((position) => [position.id, position]));
  return assets.flatMap((asset) => {
    const position = positionOf.get(asset.positionId);
    if (!position) return [];
    const latest = latestThrough(
      valuations.filter((row) => row.assetId === asset.id), scope.period, scope.knowledgeDate,
    );
    const invested = latest?.invested ?? 0;
    const realised = latest?.realised ?? 0;
    const unrealised = latest?.unrealised ?? 0;
    return [{
      asset,
      position,
      period: latest?.period,
      invested,
      realised,
      unrealised,
      grossMultiple: invested > 0 ? (unrealised + realised) / invested : undefined,
      fairValueMultiple: invested > 0 ? unrealised / invested : undefined,
      whole: position.lookThrough === 'underlying',
      provenance: latest === undefined
        ? 'missing'
        : (latest.period === scope.period ? 'reported' : 'stale'),
    }];
  });
}

function selectVehicles(dataset: DataSet, scope: Scope): Vehicle[] {
  const ofClient = dataset.vehicles.filter((v) => v.clientId === scope.clientId);
  if (!scope.vehicleId) return ofClient;
  return ofClient.filter((v) => v.id === scope.vehicleId);
}

function resolveConventions(dataset: DataSet, vehicles: Vehicle[]): ReportingConventions {
  return vehicles[0]?.conventions
    ?? dataset.client.conventions
    ?? DEFAULT_CONVENTIONS;
}

/** Periods that can be selected for a scope — those with any data at all. */
export function availablePeriods(dataset: DataSet, scope: Pick<Scope, 'clientId' | 'vehicleId'>): PeriodId[] {
  const vehicles = dataset.vehicles.filter(
    (v) => v.clientId === scope.clientId && (!scope.vehicleId || v.id === scope.vehicleId),
  );
  const vehicleIds = new Set(vehicles.map((v) => v.id));
  const positionIds = new Set(
    dataset.positions.filter((p) => vehicleIds.has(p.vehicleId)).map((p) => p.id),
  );

  const periods = new Set<PeriodId>([
    ...knownPeriods(dataset.positionValuations.filter((v) => positionIds.has(v.positionId))),
    ...knownPeriods(dataset.cashflows.filter((c) => vehicleIds.has(c.vehicleId))),
  ]);

  return sortPeriods([...periods], 'desc');
}

/**
 * Instants at which the visible picture changed, newest first. Offering these
 * as the "as at" choices stops a user reproducing a view nobody ever saw.
 */
export function availableKnowledgeDates(dataset: DataSet, upTo?: PeriodId): string[] {
  const rows = [
    ...dataset.positionValuations,
    ...dataset.cashflows,
    ...dataset.balanceSheets,
  ].filter((row) => !upTo || comparePeriods(row.period, upTo) <= 0);

  return restatementDates(rows).reverse();
}

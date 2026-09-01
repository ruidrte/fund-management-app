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
  type CurrencyCode,
  type DataSet,
  type Provenance,
  type ReportingConventions,
  type Scope,
  type Vehicle,
} from '../domain/types';
import { buildRateLookup } from './fx';
import { computeGross, type GrossResult } from './gross';
import { computeNet, type NetResult } from './net';
import { commitmentsBridge, describeQuarter, navBridge, productNavBridge, type Bridge } from './bridge';
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
export * from './completeness';
export * from './gross';
export * from './net';
export * from './bridge';
export * from './exposure';
export * from './checks';

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
  checks: CheckReport;

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

  const cashflows = dataset.cashflows.filter(
    (c) => vehicleIds.has(c.vehicleId) && (!c.positionId || positionIds.has(c.positionId)),
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
    vehicle: vehicles[0],
    cashflows,
    balanceSheets,
    // A consolidated view across several vehicles has no single balance sheet;
    // the first vehicle's is used and the check on NAV components catches it.
    vehicleId: vehicles[0]?.id ?? '',
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
      ? ['Consolidated across vehicles — net figures use the lead vehicle balance sheet']
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
    checks,
    summary: describeQuarter(bridges.portfolioNav, scope.period),
    provenance: gross.provenance,
    isFinal: gross.coverage.complete && checks.ok && qualifications.length === 0,
    qualifications,
  };
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

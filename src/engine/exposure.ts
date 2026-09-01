/**
 * Allocation and exposure.
 *
 * Exposure is measured on look-through assets where they exist and on positions
 * where they do not, because a fund-of-funds that only knows its underlying
 * funds still has a region and a strategy per fund. Both paths produce the same
 * shape, so the dashboard does not care which one it got — but it is told, since
 * a look-through breakdown and a fund-level one are not equally informative.
 */

import type { PeriodId } from '../domain/period';
import type {
  Asset,
  AssetValuation,
  Attribution,
  CurrencyCode,
  Position,
  Provenance,
} from '../domain/types';
import { latestThrough } from './asof';
import type { RateLookup } from './fx';
import type { PositionResult } from './gross';
import { weakest } from './completeness';

export interface ExposureSlice {
  label: string;
  value: number;
  /** Share of the total, as a fraction. */
  weight: number;
  priorWeight?: number;
  /** Positions or assets contributing to this slice. */
  count: number;
}

export interface ExposureBreakdown {
  dimension: string;
  basis: 'look-through' | 'position';
  currency: CurrencyCode;
  total: number;
  slices: ExposureSlice[];
  provenance: Provenance;
  /** Share of NAV the breakdown could actually classify. */
  coverage: number;
}

export type ExposureDimension =
  | 'assetClass'
  | 'subAssetClass'
  | 'region'
  | 'sector'
  | 'country'
  | 'currency'
  | 'vintage'
  | 'strategy'
  | 'manager'
  | 'positionKind';

/** Normalises a single label or a weighted split into weighted entries. */
export function splitAttribution(attribution: Attribution | undefined): Array<[string, number]> {
  if (attribution === undefined || attribution === null) return [['Unclassified', 1]];
  if (typeof attribution === 'string') {
    return attribution.trim() === '' ? [['Unclassified', 1]] : [[attribution, 1]];
  }
  const entries = Object.entries(attribution).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return [['Unclassified', 1]];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  // Weights are stated as fractions but arrive as percentages often enough that
  // normalising is worth more than rejecting the row.
  return entries.map(([label, weight]) => [label, weight / total]);
}

/** Exposure from position-level attributes — always available. */
export function positionExposure(
  results: PositionResult[],
  dimension: ExposureDimension,
  currency: CurrencyCode,
): ExposureBreakdown {
  const buckets = new Map<string, { value: number; prior: number; count: number }>();
  let total = 0;
  let priorTotal = 0;
  let classified = 0;

  for (const result of results) {
    const raw = positionDimension(result.position, dimension);
    total += result.nav;
    priorTotal += result.navPrior;

    for (const [label, weight] of splitAttribution(raw)) {
      const bucket = buckets.get(label) ?? { value: 0, prior: 0, count: 0 };
      bucket.value += result.nav * weight;
      bucket.prior += result.navPrior * weight;
      bucket.count += weight;
      buckets.set(label, bucket);
      if (label !== 'Unclassified') classified += result.nav * weight;
    }
  }

  return assemble(dimension, 'position', currency, total, priorTotal, classified, buckets,
    weakest(results.map((r) => r.provenance)));
}

/** Exposure from look-through assets, scaled to the vehicle's economic share. */
export function lookThroughExposure(
  results: PositionResult[],
  assets: Asset[],
  assetValuations: AssetValuation[],
  dimension: ExposureDimension,
  period: PeriodId,
  currency: CurrencyCode,
  rates: RateLookup,
  knowledgeDate?: string,
): ExposureBreakdown {
  const buckets = new Map<string, { value: number; prior: number; count: number }>();
  let total = 0;
  let classified = 0;
  const provenances: Provenance[] = [];

  for (const result of results) {
    const held = assets.filter((a) => a.positionId === result.position.id);
    if (held.length === 0) {
      // No look-through for this position — fall back to its own attributes so
      // the breakdown covers the whole portfolio rather than silently dropping it.
      const raw = positionDimension(result.position, dimension);
      total += result.nav;
      provenances.push('estimated');
      for (const [label, weight] of splitAttribution(raw)) {
        const bucket = buckets.get(label) ?? { value: 0, prior: 0, count: 0 };
        bucket.value += result.nav * weight;
        bucket.count += weight;
        buckets.set(label, bucket);
        if (label !== 'Unclassified') classified += result.nav * weight;
      }
      continue;
    }

    for (const asset of held) {
      const rows = assetValuations.filter((v) => v.assetId === asset.id);
      const latest = latestThrough(rows, period, knowledgeDate);
      if (!latest) {
        provenances.push('missing');
        continue;
      }
      provenances.push(latest.period === period ? 'reported' : 'stale');

      const rate = rates.tryRate(asset.currency, currency, period) ?? 1;
      // The vehicle's economic exposure: the asset's value, its share held by
      // the position, and the vehicle's share of the position.
      const value = latest.unrealised * asset.ownership * result.position.ownership * rate;
      total += value;

      for (const [label, weight] of splitAttribution(assetDimension(asset, dimension))) {
        const bucket = buckets.get(label) ?? { value: 0, prior: 0, count: 0 };
        bucket.value += value * weight;
        bucket.count += weight;
        buckets.set(label, bucket);
        if (label !== 'Unclassified') classified += value * weight;
      }
    }
  }

  return assemble(dimension, 'look-through', currency, total, 0, classified, buckets,
    weakest(provenances));
}

function assemble(
  dimension: string,
  basis: 'look-through' | 'position',
  currency: CurrencyCode,
  total: number,
  priorTotal: number,
  classified: number,
  buckets: Map<string, { value: number; prior: number; count: number }>,
  provenance: Provenance,
): ExposureBreakdown {
  const slices: ExposureSlice[] = [...buckets.entries()]
    .map(([label, bucket]) => ({
      label,
      value: bucket.value,
      weight: total > 0 ? bucket.value / total : 0,
      priorWeight: priorTotal > 0 ? bucket.prior / priorTotal : undefined,
      count: Math.round(bucket.count * 100) / 100,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    dimension,
    basis,
    currency,
    total,
    slices,
    provenance,
    coverage: total > 0 ? classified / total : 0,
  };
}

function positionDimension(position: Position, dimension: ExposureDimension): Attribution | undefined {
  switch (dimension) {
    case 'assetClass': return position.assetClass;
    case 'subAssetClass': return position.subAssetClass;
    case 'region': return position.region;
    case 'sector': return position.sector;
    case 'country': return position.region;
    case 'currency': return position.currency;
    case 'vintage': return String(position.vintage);
    case 'strategy': return position.strategy;
    case 'manager': return position.manager;
    case 'positionKind': return position.kind;
    default: return undefined;
  }
}

function assetDimension(asset: Asset, dimension: ExposureDimension): Attribution | undefined {
  switch (dimension) {
    case 'assetClass': return asset.assetClass;
    case 'subAssetClass': return asset.subAssetClass;
    case 'region': return asset.region;
    case 'sector': return asset.sector;
    case 'country': return asset.country;
    case 'currency': return asset.currency;
    default: return undefined;
  }
}

/**
 * Currency exposure before and after any hedge, at position level.
 * A vehicle reporting in EUR that holds a USD fund carries that USD exposure
 * whether or not it wants to; showing it is the whole point of the view.
 */
export function currencyExposure(
  results: PositionResult[],
  presentationCurrency: CurrencyCode,
): ExposureBreakdown {
  const breakdown = positionExposure(results, 'currency', presentationCurrency);
  return {
    ...breakdown,
    dimension: 'currency',
  };
}

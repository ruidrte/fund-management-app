/**
 * Bridges — what moved, and why.
 *
 * A bridge is the quarter's story in five numbers. It is also the strongest
 * check available: opening plus the steps must equal closing, exactly. When it
 * does not, one of the inputs is wrong, and the bridge says so rather than
 * absorbing the difference into a residual nobody reads.
 */

import { formatPeriod, previousPeriod, type PeriodId } from '../domain/period';
import type { CurrencyCode, Provenance } from '../domain/types';
import type { GrossResult } from './gross';
import type { ProductNetResult } from './net';

export interface BridgeStep {
  key: string;
  label: string;
  value: number;
  type: 'anchor' | 'delta';
  note?: string;
}

export interface Bridge {
  label: string;
  currency: CurrencyCode;
  steps: BridgeStep[];
  /** Opening + deltas - closing. Zero to within tolerance when the bridge ties. */
  residual: number;
  closes: boolean;
  provenance: Provenance;
}

const TOLERANCE = 0.5; // half a unit of the storage denomination

/**
 * Portfolio NAV bridge: opening NAV, net cashflow, value change, FX, closing.
 *
 * Keep these step keys. The narrative generator and the report layouts look for
 * `net_cashflow`, `delta_value` and `delta_fx` by name.
 */
export function navBridge(gross: GrossResult): Bridge {
  const prior = previousPeriod(gross.period);
  const t = gross.totals;
  const netCashflow = t.callsInPeriod - t.distributionsInPeriod;

  const steps: BridgeStep[] = [
    { key: 'opening', label: `NAV ${formatPeriod(prior)}`, value: t.navPrior, type: 'anchor' },
    {
      key: 'net_cashflow',
      label: 'Net cashflow',
      value: netCashflow,
      type: 'delta',
      note: 'Capital calls less distributions in the quarter',
    },
    {
      key: 'delta_value',
      label: 'Value change',
      value: t.valueChange,
      type: 'delta',
      note: 'Movement in local-currency valuations',
    },
    {
      key: 'delta_fx',
      label: 'FX translation',
      value: t.fxEffect,
      type: 'delta',
      note: 'Opening balances retranslated at the closing rate',
    },
    { key: 'closing', label: `NAV ${formatPeriod(gross.period)}`, value: t.nav, type: 'anchor' },
  ];

  return finalise('Portfolio NAV bridge', gross.currency, steps, gross.provenance);
}

/**
 * Commitments bridge: how undrawn commitment moved.
 *
 * New commitments increase it, calls consume it, recallable distributions
 * restore it where the house convention says they do.
 */
export function commitmentsBridge(gross: GrossResult): Bridge {
  const prior = previousPeriod(gross.period);
  const t = gross.totals;
  const newCommitments = t.commitments - t.commitmentsPrior;

  const steps: BridgeStep[] = [
    { key: 'opening', label: `Undrawn ${formatPeriod(prior)}`, value: t.undrawnPrior, type: 'anchor' },
    { key: 'new_commitments', label: 'New commitments', value: newCommitments, type: 'delta' },
    { key: 'calls', label: 'Capital calls', value: -t.callsInPeriod, type: 'delta' },
    { key: 'closing', label: `Undrawn ${formatPeriod(gross.period)}`, value: t.undrawn, type: 'anchor' },
  ];

  return finalise('Undrawn commitments bridge', gross.currency, steps, gross.provenance);
}

/**
 * Product NAV bridge — the investor's NAV, which moves for everything the
 * portfolio did plus the vehicle's own fees, expenses and cash.
 */
export function productNavBridge(gross: GrossResult, net: ProductNetResult): Bridge {
  const prior = previousPeriod(net.period);
  const t = gross.totals;

  const openingOther = net.componentsPrior.vehicleNav - net.componentsPrior.portfolio;
  const closingOther = net.components.vehicleNav - net.components.portfolio;

  const steps: BridgeStep[] = [
    { key: 'opening', label: `Net NAV ${formatPeriod(prior)}`, value: net.componentsPrior.vehicleNav, type: 'anchor' },
    { key: 'net_cashflow', label: 'Portfolio net cashflow', value: t.callsInPeriod - t.distributionsInPeriod, type: 'delta' },
    { key: 'delta_value', label: 'Value change', value: t.valueChange, type: 'delta' },
    { key: 'delta_fx', label: 'FX translation', value: t.fxEffect, type: 'delta' },
    {
      key: 'delta_other',
      label: 'Cash, receivables and accruals',
      value: closingOther - openingOther,
      type: 'delta',
      note: 'Movement in vehicle-level balance sheet items, including accrued fees',
    },
    { key: 'closing', label: `Net NAV ${formatPeriod(net.period)}`, value: net.components.vehicleNav, type: 'anchor' },
  ];

  return finalise('Net asset value bridge', net.currency, steps, net.provenance);
}

function finalise(
  label: string,
  currency: CurrencyCode,
  steps: BridgeStep[],
  provenance: Provenance,
): Bridge {
  const opening = steps.find((s) => s.key === 'opening')?.value ?? 0;
  const closing = steps.find((s) => s.key === 'closing')?.value ?? 0;
  const deltas = steps.filter((s) => s.type === 'delta').reduce((t, s) => t + s.value, 0);
  const residual = opening + deltas - closing;

  return {
    label,
    currency,
    steps,
    residual,
    closes: Math.abs(residual) <= TOLERANCE,
    provenance,
  };
}

/**
 * The sentence a reader wants first: how much of the quarter's gain was real
 * value creation rather than money paid in or a currency move.
 */
export function describeQuarter(bridge: Bridge, period: PeriodId): string {
  const value = (key: string) => bridge.steps.find((s) => s.key === key)?.value ?? 0;
  const opening = value('opening');
  const closing = value('closing');
  const move = closing - opening;

  if (Math.abs(move) < TOLERANCE) {
    return `Net asset value was broadly unchanged over ${formatPeriod(period)}.`;
  }

  const direction = move > 0 ? 'rose' : 'fell';
  const valueChange = value('delta_value');
  const fx = value('delta_fx');
  const cash = value('net_cashflow');

  const parts = [
    `${bridge.currency} ${fmt(Math.abs(move))} — of which ${fmt(valueChange)} value change`,
    `${fmt(fx)} FX`,
    `${fmt(cash)} net cashflow`,
  ];

  const share = Math.abs(move) > 0 ? Math.abs(valueChange / move) : 0;
  const emphasis = share < 0.4
    ? ' Most of the movement is cashflow and currency rather than value creation.'
    : '';

  return `Net asset value ${direction} by ${parts.join(', ')}.${emphasis}`;
}

function fmt(value: number): string {
  return value.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
}

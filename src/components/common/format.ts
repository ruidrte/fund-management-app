import type { CurrencyCode, Provenance } from '../../domain/types';

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };

export function currencySymbol(code: CurrencyCode): string {
  return SYMBOLS[code] ?? `${code} `;
}

/**
 * Money is stored in thousands and shown in millions, because a quarterly report
 * that prints nine significant figures is not read, it is scanned past.
 */
export function money(value: number, currency: CurrencyCode, decimals = 1): string {
  const millions = value / 1000;
  return `${currencySymbol(currency)}${millions.toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}m`;
}

export function moneyExact(value: number, currency: CurrencyCode): string {
  return `${currencySymbol(currency)}${value.toLocaleString('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}k`;
}

/** Signed, for bridge steps and deltas — the sign carries meaning, not just colour. */
export function signedMoney(value: number, currency: CurrencyCode, decimals = 1): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${money(Math.abs(value), currency, decimals)}`;
}

export function percent(value: number | undefined, decimals = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

export function signedPercent(value: number | undefined, decimals = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${percent(Math.abs(value), decimals)}`;
}

export function multiple(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}x`;
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  reported: 'Reported',
  'rolled-forward': 'Rolled forward',
  estimated: 'Estimated',
  stale: 'Stale',
  missing: 'Missing',
};

export const PROVENANCE_DESCRIPTION: Record<Provenance, string> = {
  reported: 'Traced to a source document for this period',
  'rolled-forward': 'Last known valuation, adjusted for cashflows since',
  estimated: 'Modelled — rolled forward and marked with an expected value change',
  stale: 'Reported, but for an earlier period than the one shown',
  missing: 'No data — contributes nothing and counts against coverage',
};

/** Status role, so provenance never rides on colour alone. */
export const PROVENANCE_STATUS: Record<Provenance, 'good' | 'warning' | 'serious' | 'critical'> = {
  reported: 'good',
  'rolled-forward': 'warning',
  estimated: 'serious',
  stale: 'warning',
  missing: 'critical',
};

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** Categorical series colour by slot, in the validated fixed order. Never cycled. */
export function seriesColor(index: number): string {
  return index < 8 ? `var(--series-${index + 1})` : 'var(--text-muted)';
}

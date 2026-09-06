import type { ReactNode } from 'react';
import type { Provenance } from '../../domain/types';
import { ProvenanceBadge } from './Badges';
import { useHouse } from '../../context/ScopeContext';
import { tierColour, type Tier } from './house';

/**
 * A stat tile, not a chart. One number, its comparative, and — where the number
 * is not a reported figure — the badge that says so. The value is the largest
 * thing in the tile because it is what the tile is for.
 */
export function KpiTile({
  label, value, comparison, provenance, note, tone = 'neutral', tier,
}: {
  label: string;
  value: ReactNode;
  comparison?: ReactNode;
  provenance?: Provenance;
  note?: string;
  tone?: 'neutral' | 'positive' | 'negative';
  /** Which tier the figure belongs to, where the tile is part of a tier. */
  tier?: Tier;
}) {
  // A rule along the top rather than a coloured number: the value has its own
  // meaning for colour — a gain is green and a loss red — and taking that away
  // to say which tier it belongs to would cost more than it buys.
  const edge = tierColour(useHouse(), tier);
  const valueColor = tone === 'positive'
    ? 'var(--diverge-positive)'
    : tone === 'negative' ? 'var(--diverge-negative)' : 'var(--text-primary)';

  return (
    <div
      className="card p-3.5"
      style={edge ? { borderTop: `3px solid ${edge}` } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        {provenance && provenance !== 'reported' && <ProvenanceBadge provenance={provenance} compact />}
      </div>
      <p className="mt-1.5 mb-0 text-xl font-semibold tabular" style={{ color: valueColor }}>
        {value}
      </p>
      {comparison && (
        <p className="mt-1 mb-0 text-xs tabular" style={{ color: 'var(--text-secondary)' }}>{comparison}</p>
      )}
      {note && (
        <p className="mt-1.5 mb-0 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>{note}</p>
      )}
    </div>
  );
}

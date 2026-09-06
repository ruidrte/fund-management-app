import { useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import type { Provenance } from '../../domain/types';
import { ProvenanceBadge } from './Badges';
import { useHouse } from '../../context/ScopeContext';
import { tierColour, type Tier } from './house';

interface CardProps {
  title: string;
  subtitle?: string;
  provenance?: Provenance;
  note?: string;
  actions?: ReactNode;
  /**
   * Which tier the card is about, where it is about one. The edge takes the
   * house's colour at the shade of that tier, so a card says whose book and
   * which question before anything in it is read.
   */
  tier?: Tier;
  children: ReactNode;
}

export function Card({ title, subtitle, provenance, note, actions, tier, children }: CardProps) {
  const edge = tierColour(useHouse(), tier);
  return (
    <section
      className="card p-4"
      style={edge ? { borderLeft: `3px solid ${edge}` } : undefined}
    >
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {provenance && <ProvenanceBadge provenance={provenance} />}
          {actions}
        </div>
      </header>
      {children}
      {note && (
        <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{note}</p>
      )}
    </section>
  );
}

/**
 * A chart and its table are the same card. Every value must be reachable without
 * hovering, so the table view is not an extra — it is the relief that lets a
 * low-contrast series colour be used at all.
 */
export function ChartCard({
  title, subtitle, provenance, note, tier, chart, table,
}: Omit<CardProps, 'children' | 'actions'> & { chart: ReactNode; table: ReactNode }) {
  const [showTable, setShowTable] = useState(false);

  return (
    <Card
      title={title}
      subtitle={subtitle}
      provenance={provenance}
      note={note}
      tier={tier}
      actions={
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs"
          style={{ color: 'var(--text-secondary)', background: 'var(--surface-2)' }}
          aria-pressed={showTable}
        >
          {showTable ? <BarChart3 size={13} aria-hidden /> : <Table2 size={13} aria-hidden />}
          {showTable ? 'Chart' : 'Table'}
        </button>
      }
    >
      {showTable ? <div className="scroll-x">{table}</div> : chart}
    </Card>
  );
}

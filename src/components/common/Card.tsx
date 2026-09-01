import { useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import type { Provenance } from '../../domain/types';
import { ProvenanceBadge } from './Badges';

interface CardProps {
  title: string;
  subtitle?: string;
  provenance?: Provenance;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Card({ title, subtitle, provenance, note, actions, children }: CardProps) {
  return (
    <section className="card p-4">
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
  title, subtitle, provenance, note, chart, table,
}: Omit<CardProps, 'children' | 'actions'> & { chart: ReactNode; table: ReactNode }) {
  const [showTable, setShowTable] = useState(false);

  return (
    <Card
      title={title}
      subtitle={subtitle}
      provenance={provenance}
      note={note}
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

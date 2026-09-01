import { AlertTriangle, CheckCircle2, CircleSlash, Clock, HelpCircle } from 'lucide-react';
import type { Provenance } from '../../domain/types';
import { PROVENANCE_DESCRIPTION, PROVENANCE_LABEL, PROVENANCE_STATUS } from './format';

const ICONS: Record<Provenance, typeof CheckCircle2> = {
  reported: CheckCircle2,
  'rolled-forward': Clock,
  estimated: HelpCircle,
  stale: AlertTriangle,
  missing: CircleSlash,
};

const STATUS_COLOR = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
} as const;

/**
 * Provenance carries an icon and a word, never a colour alone — the same rule
 * the report renderer follows, for the same reason.
 */
export function ProvenanceBadge({ provenance, compact = false }: { provenance: Provenance; compact?: boolean }) {
  const Icon = ICONS[provenance];
  const color = STATUS_COLOR[PROVENANCE_STATUS[provenance]];

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color, background: 'var(--surface-2)' }}
      title={PROVENANCE_DESCRIPTION[provenance]}
    >
      <Icon size={12} aria-hidden />
      {!compact && PROVENANCE_LABEL[provenance]}
      {compact && <span className="sr-only">{PROVENANCE_LABEL[provenance]}</span>}
    </span>
  );
}

export function StatusPill({
  tone, children,
}: { tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral'; children: React.ReactNode }) {
  const color = tone === 'neutral' ? 'var(--text-secondary)' : STATUS_COLOR[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium"
      style={{ color, background: 'var(--surface-2)' }}
    >
      {children}
    </span>
  );
}

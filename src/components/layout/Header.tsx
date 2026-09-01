import { Moon, Sun, Monitor, RefreshCw } from 'lucide-react';
import { useScope } from '../../context/ScopeContext';
import { useTheme } from '../../context/ThemeContext';
import { formatPeriod } from '../../domain/period';
import { StatusPill } from '../common/Badges';
import { formatTimestamp } from '../common/format';

export function Header() {
  const { view, sourceLabel, refresh, knowledgeDate, period } = useScope();
  const { theme, toggle } = useTheme();

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <header
      className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          {view?.vehicles.length === 1
            ? view.vehicles[0].name
            : view
              ? `${view.vehicles.length} vehicles consolidated`
              : 'Fund Reporting & Monitoring'}
        </h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span>{period ? formatPeriod(period) : '—'}</span>
          {view && (
            <>
              <span aria-hidden>·</span>
              <span>{view.currency}</span>
              <span aria-hidden>·</span>
              <span>{view.vehicles[0]?.kind === 'direct-fund' ? 'Direct fund' : 'Fund of funds'}</span>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {knowledgeDate && (
          <StatusPill tone="warning">
            Historical view — as known at {formatTimestamp(knowledgeDate)}
          </StatusPill>
        )}
        {view && (
          <StatusPill tone={view.isFinal ? 'good' : 'serious'}>
            {view.isFinal ? 'Final' : 'Draft'}
          </StatusPill>
        )}
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{sourceLabel}</span>

        <button
          type="button" onClick={refresh}
          className="rounded p-1.5" style={{ color: 'var(--text-secondary)', background: 'var(--surface-2)' }}
          aria-label="Reload data"
        >
          <RefreshCw size={14} aria-hidden />
        </button>
        <button
          type="button" onClick={toggle}
          className="rounded p-1.5" style={{ color: 'var(--text-secondary)', background: 'var(--surface-2)' }}
          aria-label={`Theme: ${theme}. Switch theme`}
        >
          <ThemeIcon size={14} aria-hidden />
        </button>
      </div>
    </header>
  );
}

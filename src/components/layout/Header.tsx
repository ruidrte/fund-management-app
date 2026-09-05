import { Moon, Sun, Monitor, RefreshCw, LogOut } from 'lucide-react';
import { useScope } from '../../context/ScopeContext';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { formatPeriod } from '../../domain/period';
import { VEHICLE_KIND } from '../../domain/types';
import { StatusPill } from '../common/Badges';
import { formatTimestamp } from '../common/format';

export function Header() {
  const { view, sourceLabel, refresh, knowledgeDate, period } = useScope();
  const { theme, toggle } = useTheme();
  const { user, requiresAuth, signOut } = useAuth();

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  // True when the presentation currency is not the one every product in scope
  // reports in. A consolidation of products with different currencies has no
  // single basis, so it is not a translation away from one.
  const bases = new Set(view?.vehicles.map((v) => v.currency) ?? []);
  const translated = Boolean(view) && bases.size === 1 && ![...bases].includes(view!.currency);

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
              <span>
                {view.currency}
                {/* Named as a translation whenever the screen is not on the
                    product's own reporting basis, so a figure copied from here
                    carries what it is. */}
                {translated && (
                  <span style={{ color: 'var(--status-warning)' }}>
                    {' '}— translated from {view.vehicles[0]?.currency}
                  </span>
                )}
              </span>
              <span aria-hidden>·</span>
              <span>{VEHICLE_KIND[view.vehicles[0]?.kind ?? 'fund-of-funds']}</span>
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
        {requiresAuth && user && (
          <button
            type="button" onClick={() => void signOut()}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px]"
            style={{ color: 'var(--text-secondary)', background: 'var(--surface-2)' }}
            title={user.email}
          >
            <LogOut size={13} aria-hidden />
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}

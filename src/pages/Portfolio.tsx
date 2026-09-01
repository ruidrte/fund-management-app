/**
 * The portfolio register — every holding, gross of fees, with the provenance of
 * each valuation on the row it affects. This is where a reader goes to find out
 * which fund is holding up the quarter.
 */

import { useMemo, useState } from 'react';
import type { QuarterView } from '../engine';
import { Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { ProvenanceBadge } from '../components/common/Badges';
import { money, multiple, percent, signedMoney } from '../components/common/format';
import { formatPeriod } from '../domain/period';
import { useScope } from '../context/ScopeContext';

type SortKey = 'name' | 'nav' | 'valueChange' | 'tvpi' | 'commitment';

export function Portfolio({ view }: { view: QuarterView }) {
  const { setPositionId } = useScope();
  const [sort, setSort] = useState<SortKey>('nav');
  const [onlyDrafted, setOnlyDrafted] = useState(false);

  const rows = useMemo(() => {
    const filtered = onlyDrafted
      ? view.gross.positions.filter((p) => p.provenance !== 'reported')
      : view.gross.positions;

    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'name': return a.position.name.localeCompare(b.position.name);
        case 'valueChange': return b.valueChange - a.valueChange;
        case 'tvpi': return (b.multiples.tvpi ?? 0) - (a.multiples.tvpi ?? 0);
        case 'commitment': return b.commitment - a.commitment;
        case 'nav':
        default: return b.nav - a.nav;
      }
    });
  }, [view.gross.positions, sort, onlyDrafted]);

  const t = view.gross.totals;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Portfolio register"
        subtitle={`${view.gross.positions.length} holdings at ${formatPeriod(view.period)}, gross of vehicle fees`}
        provenance={view.gross.provenance}
        note="Value change is the local-currency movement; FX is shown separately so a
              translation gain is never read as performance. Select a row to scope the whole
              application to that holding."
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox" checked={onlyDrafted}
                onChange={(event) => setOnlyDrafted(event.target.checked)}
              />
              Only unreported
            </label>
            <select
              className="field" value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              aria-label="Sort holdings"
            >
              <option value="nav">By NAV</option>
              <option value="valueChange">By value change</option>
              <option value="tvpi">By TVPI</option>
              <option value="commitment">By commitment</option>
              <option value="name">By name</option>
            </select>
          </div>
        }
      >
        <DataTable
          rows={rows}
          rowKey={(row) => row.position.id}
          dense
          emptyMessage={onlyDrafted ? 'Every holding reported for this quarter.' : 'No holdings in this scope.'}
          columns={[
            {
              key: 'name', header: 'Holding',
              render: (row) => (
                <button
                  type="button"
                  onClick={() => setPositionId(row.position.id)}
                  className="text-left underline-offset-2 hover:underline"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <span className="block font-medium">{row.position.name}</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {row.position.manager} · {row.position.subAssetClass ?? row.position.assetClass} · {row.position.vintage}
                  </span>
                </button>
              ),
            },
            { key: 'ccy', header: 'CCY', render: (row) => row.position.currency },
            {
              key: 'commitment', header: `Commitment`, align: 'right',
              render: (row) => money(row.commitment, view.currency),
              total: money(t.commitments, view.currency),
            },
            {
              key: 'drawn', header: 'Drawn', align: 'right',
              render: (row) => money(row.drawn, view.currency),
              total: money(t.drawn, view.currency),
            },
            {
              key: 'undrawn', header: 'Undrawn', align: 'right',
              render: (row) => money(row.undrawn, view.currency),
              total: money(t.undrawn, view.currency),
            },
            {
              key: 'distributed', header: 'Distributed', align: 'right',
              render: (row) => money(row.distributed, view.currency),
              total: money(t.distributed, view.currency),
            },
            {
              key: 'nav', header: 'NAV', align: 'right',
              render: (row) => money(row.nav, view.currency),
              total: money(t.nav, view.currency),
            },
            {
              key: 'value', header: 'Value change', align: 'right',
              render: (row) => (
                <span style={{ color: row.valueChange >= 0 ? 'var(--diverge-positive)' : 'var(--diverge-negative)' }}>
                  {signedMoney(row.valueChange, view.currency)}
                </span>
              ),
              total: signedMoney(t.valueChange, view.currency),
            },
            {
              key: 'fx', header: 'FX', align: 'right',
              render: (row) => (row.fxEffect === 0 ? '—' : signedMoney(row.fxEffect, view.currency)),
              total: signedMoney(t.fxEffect, view.currency),
            },
            {
              key: 'tvpi', header: 'TVPI', align: 'right',
              render: (row) => multiple(row.multiples.tvpi),
              total: multiple(t.multiples.tvpi),
            },
            {
              key: 'irr', header: 'IRR', align: 'right',
              render: (row) => percent(row.irr),
              total: percent(t.irr),
            },
            {
              key: 'basis', header: 'Basis',
              render: (row) => (
                <span title={row.state.note}>
                  <ProvenanceBadge provenance={row.provenance} />
                </span>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="How each unreported holding was filled"
        subtitle="The draft calculation, position by position"
        note="A holding that has not reported is never zero. It is rolled forward from its last
              known valuation for the cashflows since, and where the policy allows, marked with the
              value change the holdings that did report actually achieved."
      >
        <DataTable
          rows={view.gross.positions.filter((p) => p.provenance !== 'reported')}
          rowKey={(row) => row.position.id}
          dense
          emptyMessage="Every holding reported a valuation for this quarter."
          columns={[
            { key: 'name', header: 'Holding', render: (row) => row.position.name },
            {
              key: 'source', header: 'Last valued',
              render: (row) => (row.state.sourcePeriod ? formatPeriod(row.state.sourcePeriod) : 'Never'),
            },
            { key: 'lag', header: 'Lag', align: 'right', render: (row) => `${row.state.lagQuarters}Q` },
            {
              key: 'roll', header: 'Cashflow adjustment', align: 'right',
              render: (row) => signedMoney(row.state.rollForwardAdjustment, row.position.currency),
            },
            {
              key: 'return', header: 'Assumed return', align: 'right',
              render: (row) => (row.state.appliedReturn === 0 ? '—' : percent(row.state.appliedReturn)),
            },
            { key: 'nav', header: `NAV (${view.currency})`, align: 'right', render: (row) => money(row.nav, view.currency) },
            { key: 'basis', header: 'Basis', render: (row) => <ProvenanceBadge provenance={row.provenance} /> },
            { key: 'note', header: 'Treatment', render: (row) => row.state.note ?? '' },
          ]}
        />
      </Card>
    </div>
  );
}

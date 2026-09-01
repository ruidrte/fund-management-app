/**
 * Data quality.
 *
 * Coverage on the left, identity checks on the right. Between them they answer
 * the only two questions that matter before a quarter is issued: is enough of
 * the portfolio actually reported, and does the arithmetic tie.
 */

import type { QuarterView } from '../engine';
import { Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { KpiTile } from '../components/common/KpiTile';
import { ProvenanceBadge, StatusPill } from '../components/common/Badges';
import { DraftBanner } from '../components/common/DraftBanner';
import { money, percent, PROVENANCE_DESCRIPTION, PROVENANCE_LABEL } from '../components/common/format';
import { formatPeriod } from '../domain/period';
import type { Provenance } from '../domain/types';

const PROVENANCES: Provenance[] = ['reported', 'rolled-forward', 'estimated', 'stale', 'missing'];

export function DataQuality({ view }: { view: QuarterView }) {
  const c = view.gross.coverage;

  return (
    <div className="flex flex-col gap-4">
      <DraftBanner view={view} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Holdings reported" value={`${c.reported} / ${c.expected}`}
          comparison={`${c.expected - c.reported} outstanding`}
        />
        <KpiTile
          label="NAV coverage" value={percent(c.navCoverage, 0)}
          comparison={`Floor for this vehicle: ${percent(view.conventions.draftPolicy.minimumCoverage, 0)}`}
          tone={c.publishable ? 'positive' : 'negative'}
        />
        <KpiTile
          label="Checks passed" value={`${view.checks.passed} / ${view.checks.passed + view.checks.failed}`}
          comparison={`${view.checks.skipped} skipped for want of inputs`}
          tone={view.checks.ok ? 'positive' : 'negative'}
        />
        <KpiTile
          label="Weakest input" value={PROVENANCE_LABEL[view.provenance]}
          note={PROVENANCE_DESCRIPTION[view.provenance]}
        />
      </div>

      <Card
        title="Where each holding's value came from"
        subtitle={`${formatPeriod(view.period)}, by basis`}
        note="Every derived figure in the application inherits the weakest basis among its inputs.
              One estimated holding makes the portfolio total an estimate, and it is badged as one
              everywhere it appears."
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-5">
          {PROVENANCES.map((provenance) => {
            const rows = view.gross.positions.filter((p) => p.provenance === provenance);
            const value = rows.reduce((t, p) => t + p.nav, 0);
            return (
              <div key={provenance} className="rounded p-2.5" style={{ background: 'var(--surface-2)' }}>
                <ProvenanceBadge provenance={provenance} />
                <p className="mt-1.5 mb-0 text-lg font-semibold tabular" style={{ color: 'var(--text-primary)' }}>
                  {rows.length}
                </p>
                <p className="m-0 text-[11px] tabular" style={{ color: 'var(--text-muted)' }}>
                  {money(value, view.currency)}
                </p>
              </div>
            );
          })}
        </div>

        <DataTable
          rows={[...view.gross.positions].sort((a, b) => b.nav - a.nav)}
          rowKey={(row) => row.position.id}
          dense
          columns={[
            { key: 'name', header: 'Holding', render: (row) => row.position.name },
            {
              key: 'source', header: 'Valuation as at',
              render: (row) => (row.state.sourcePeriod ? formatPeriod(row.state.sourcePeriod) : 'Never valued'),
            },
            {
              key: 'lag', header: 'Lag', align: 'right',
              render: (row) => (row.state.lagQuarters === 0 ? '—' : `${row.state.lagQuarters}Q`),
            },
            { key: 'nav', header: `NAV (${view.currency})`, align: 'right', render: (row) => money(row.nav, view.currency) },
            {
              key: 'share', header: 'Share', align: 'right',
              render: (row) => percent(view.gross.totals.nav > 0 ? row.nav / view.gross.totals.nav : 0),
            },
            { key: 'basis', header: 'Basis', render: (row) => <ProvenanceBadge provenance={row.provenance} /> },
            { key: 'note', header: 'Treatment', render: (row) => row.state.note ?? 'Reported for this quarter' },
          ]}
        />
      </Card>

      <Card
        title="Identity checks"
        subtitle="What the arithmetic must satisfy before anything is issued"
        note="A passing check does not prove a figure is right; a failing one proves it is wrong.
              Checks are conditional on their inputs, so a partial quarter produces skips rather than
              failures — and a skip is reported, because a check that silently never ran is worse than
              one that failed."
      >
        <DataTable
          rows={view.checks.results}
          rowKey={(row) => row.id}
          dense
          columns={[
            { key: 'label', header: 'Identity', render: (row) => row.label },
            {
              key: 'status', header: 'Result',
              render: (row) => (
                <StatusPill tone={row.status === 'pass' ? 'good' : row.status === 'fail' ? 'critical' : 'neutral'}>
                  {row.status === 'pass' ? 'Pass' : row.status === 'fail' ? 'Fail' : 'Skipped'}
                </StatusPill>
              ),
            },
            {
              key: 'difference', header: 'Difference', align: 'right',
              render: (row) => (row.difference === undefined ? '—' : row.difference.toFixed(4)),
            },
            { key: 'detail', header: 'What it asserts', render: (row) => row.detail },
          ]}
        />
      </Card>
    </div>
  );
}

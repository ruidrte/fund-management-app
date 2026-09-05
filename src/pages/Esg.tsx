/**
 * ESG.
 *
 * The schema, the scope and the coverage discipline are in place from day one;
 * the metric library is not. What exists today is the SFDR classification the
 * positions carry and whatever metrics have been collected against them.
 *
 * The reason this page is deliberately thin rather than filled with plausible
 * charts: an ESG figure with no stated coverage is worse than none at all, and
 * coverage is exactly what a portfolio that has not been through a data
 * collection cycle does not have.
 */

import { useMemo } from 'react';
import type { QuarterView } from '../engine';
import { Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { AllocationBars } from '../components/charts/AllocationBars';
import { useMoney, useScope } from '../context/ScopeContext';
import { percent } from '../components/common/format';
import type { ExposureBreakdown } from '../engine/exposure';
import { forPeriod } from '../engine/asof';

export function Esg({ view }: { view: QuarterView }) {
  const { money } = useMoney();
  const { dataset } = useScope();

  const sfdr = useMemo<ExposureBreakdown>(() => {
    const buckets = new Map<string, number>();
    let total = 0;
    for (const result of view.gross.positions) {
      const label = result.position.esg?.sfdr ?? 'Not classified';
      buckets.set(label, (buckets.get(label) ?? 0) + result.nav);
      total += result.nav;
    }
    return {
      dimension: 'sfdr',
      basis: 'position',
      currency: view.currency,
      total,
      slices: [...buckets.entries()]
        .map(([label, value]) => ({ label, value, weight: total > 0 ? value / total : 0, count: 1 }))
        .sort((a, b) => b.value - a.value),
      provenance: view.gross.provenance,
      coverage: total > 0
        ? 1 - (buckets.get('Not classified') ?? 0) / total
        : 0,
    };
  }, [view]);

  const metrics = useMemo(() => {
    if (!dataset) return [];
    // The metric table holds everything measured about anything; this screen is
    // about the sustainability part of it, which is what the namespace is for.
    return forPeriod(dataset.metrics, view.period, view.scope.knowledgeDate)
      .filter((metric) => metric.metric.startsWith('esg.'));
  }, [dataset, view.period, view.scope.knowledgeDate]);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="SFDR classification"
        subtitle={`Share of ${money(sfdr.total, view.currency)} portfolio net asset value`}
        provenance={sfdr.provenance}
        note={sfdr.coverage < 1
          ? `${percent(1 - sfdr.coverage, 0)} of the portfolio carries no classification. That gap is stated rather than excluded from the denominator, because excluding it would inflate every share above.`
          : undefined}
      >
        <AllocationBars breakdown={sfdr} />
      </Card>

      <Card
        title="Collected metrics"
        subtitle={`Metrics recorded against this scope for ${view.period}`}
        note="Every metric carries the coverage it was measured over. A carbon figure covering a
              third of the portfolio is a different claim from one covering all of it, and the
              difference does not survive being averaged away."
      >
        <DataTable
          rows={metrics}
          rowKey={(row) => row.id}
          dense
          emptyMessage="No ESG metrics have been collected for this scope and period."
          columns={[
            { key: 'metric', header: 'Metric', render: (row) => row.metric },
            { key: 'scope', header: 'Level', render: (row) => row.scope.kind },
            {
              key: 'value', header: 'Value', align: 'right',
              render: (row) => (row.value === undefined
                ? row.text ?? '—'
                : row.value.toLocaleString('en-GB')),
            },
            { key: 'unit', header: 'Unit', render: (row) => row.unit ?? '' },
            {
              key: 'coverage', header: 'Coverage', align: 'right',
              render: (row) => (row.coverage === undefined ? 'Not stated' : percent(row.coverage, 0)),
            },
            { key: 'source', header: 'Source', render: (row) => row.source },
          ]}
        />
      </Card>

      <Card title="What is not built yet" subtitle="So the gap is explicit rather than discovered later">
        <ul className="m-0 list-disc space-y-1.5 pl-4 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          <li>
            <strong>Principal adverse impact indicators.</strong> The schema holds arbitrary
            metrics keyed by scope and period; the PAI definitions, their units and their
            aggregation rules are not yet encoded.
          </li>
          <li>
            <strong>Look-through aggregation.</strong> Metrics collected at asset level should roll
            up weighted by the vehicle&rsquo;s economic share, the same way exposure does. The
            weighting exists in the exposure engine and needs pointing at the metric table.
          </li>
          <li>
            <strong>Taxonomy alignment and exclusions.</strong> Both fields exist on the position
            record and neither is populated or reported on.
          </li>
          <li>
            <strong>Period-on-period comparatives.</strong> Metrics are bitemporal like everything
            else, so a restated emissions figure is already recoverable — the comparison is simply
            not drawn yet.
          </li>
        </ul>
      </Card>
    </div>
  );
}

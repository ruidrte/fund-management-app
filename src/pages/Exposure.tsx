/**
 * Allocation and exposure.
 *
 * Position-level breakdowns are always available; look-through breakdowns exist
 * only where the underlying assets have been collected. Both are shown, labelled
 * with their basis, because "35% technology" measured on fund labels and the same
 * figure measured on portfolio companies are not the same claim.
 */

import { useMemo, useState } from 'react';
import type { QuarterView } from '../engine';
import { ChartCard, Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { AllocationBars } from '../components/charts/AllocationBars';
import { money, percent } from '../components/common/format';
import type { ExposureBreakdown } from '../engine/exposure';

const POSITION_DIMENSIONS: Array<[string, string]> = [
  ['assetClass', 'Asset class'],
  ['subAssetClass', 'Sub-asset class'],
  ['region', 'Region'],
  ['vintage', 'Vintage year'],
  ['currency', 'Currency'],
  ['manager', 'Manager'],
  ['positionKind', 'Position type'],
];

const LOOK_THROUGH_DIMENSIONS: Array<[string, string]> = [
  ['sector', 'Sector'],
  ['country', 'Country'],
  ['region', 'Region'],
  ['assetClass', 'Asset class'],
];

export function Exposure({ view }: { view: QuarterView }) {
  const [basis, setBasis] = useState<'position' | 'look-through'>(
    Object.keys(view.lookThrough).length > 0 ? 'look-through' : 'position',
  );

  const hasLookThrough = Object.keys(view.lookThrough).length > 0;
  const dimensions = basis === 'look-through' ? LOOK_THROUGH_DIMENSIONS : POSITION_DIMENSIONS;
  const source = basis === 'look-through' ? view.lookThrough : view.exposure;

  const concentration = useMemo(() => {
    const sorted = [...view.gross.positions].sort((a, b) => b.nav - a.nav);
    const total = view.gross.totals.nav || 1;
    return {
      top1: (sorted[0]?.nav ?? 0) / total,
      top3: sorted.slice(0, 3).reduce((t, p) => t + p.nav, 0) / total,
      top5: sorted.slice(0, 5).reduce((t, p) => t + p.nav, 0) / total,
      // Herfindahl on NAV weights: 1 means a single holding, 1/n means perfectly even.
      hhi: sorted.reduce((t, p) => t + Math.pow(p.nav / total, 2), 0),
    };
  }, [view.gross.positions, view.gross.totals.nav]);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Basis"
        subtitle="What the percentages are measured on"
        actions={
          <div className="flex gap-1 rounded p-0.5" style={{ background: 'var(--surface-2)' }}>
            {(['look-through', 'position'] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={option === 'look-through' && !hasLookThrough}
                onClick={() => setBasis(option)}
                aria-pressed={basis === option}
                className="rounded px-2.5 py-1 text-xs disabled:opacity-40"
                style={{
                  background: basis === option ? 'var(--surface-1)' : 'transparent',
                  color: basis === option ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {option === 'look-through' ? 'Look-through' : 'Position level'}
              </button>
            ))}
          </div>
        }
      >
        <p className="m-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {basis === 'look-through'
            ? `Measured on the underlying assets, scaled to the vehicle's economic share of each. Holdings with no asset detail fall back to their own attributes so the breakdown still covers the whole portfolio.`
            : `Measured on each holding's own attributes. Always available, but a fund labelled "Europe" may hold assets outside it.`}
        </p>
      </Card>

      <Card title="Concentration" subtitle="How much of the portfolio sits in its largest holdings">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Largest holding" value={percent(concentration.top1)} />
          <Stat label="Top three" value={percent(concentration.top3)} />
          <Stat label="Top five" value={percent(concentration.top5)} />
          <Stat
            label="Herfindahl index" value={concentration.hhi.toFixed(3)}
            note={`Evenly spread would be ${(1 / Math.max(1, view.gross.positions.length)).toFixed(3)}`}
          />
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {dimensions.map(([key, label]) => {
          const breakdown = source[key];
          if (!breakdown || breakdown.slices.length === 0) return null;
          return (
            <ChartCard
              key={`${basis}-${key}`}
              title={label}
              subtitle={`Share of ${money(breakdown.total, view.currency)}`}
              provenance={breakdown.provenance}
              chart={<AllocationBars breakdown={breakdown} />}
              table={<BreakdownTable breakdown={breakdown} />}
            />
          );
        })}
      </div>
    </div>
  );
}

function BreakdownTable({ breakdown }: { breakdown: ExposureBreakdown }) {
  return (
    <DataTable
      rows={breakdown.slices}
      rowKey={(slice) => slice.label}
      dense
      columns={[
        { key: 'label', header: 'Category', render: (s) => s.label },
        { key: 'value', header: breakdown.currency, align: 'right', render: (s) => money(s.value, breakdown.currency) },
        { key: 'weight', header: 'Share', align: 'right', render: (s) => percent(s.weight), total: percent(1) },
        {
          key: 'prior', header: 'Prior', align: 'right',
          render: (s) => (s.priorWeight === undefined ? '—' : percent(s.priorWeight)),
        },
      ]}
    />
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <p className="m-0 text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="mt-1 mb-0 text-lg font-semibold tabular" style={{ color: 'var(--text-primary)' }}>{value}</p>
      {note && <p className="mt-0.5 mb-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>{note}</p>}
    </div>
  );
}

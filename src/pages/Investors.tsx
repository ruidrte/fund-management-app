/**
 * The net tier, at both levels it exists at.
 *
 * The product view is the vehicle as a whole; the register below it is one row
 * per investor. An account built by allocation rather than from booked flows is
 * marked as such — it is an approximation of an equalised account, and issuing
 * one as a statement of account would be wrong.
 */

import type { QuarterView } from '../engine';
import { Card, ChartCard } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { KpiTile } from '../components/common/KpiTile';
import { ProvenanceBadge, StatusPill } from '../components/common/Badges';
import { Waterfall } from '../components/charts/Waterfall';
import { money, multiple, percent, signedMoney } from '../components/common/format';
import { formatPeriod } from '../domain/period';

export function Investors({ view }: { view: QuarterView }) {
  const net = view.net.product;
  const components = net.components;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Net asset value" value={money(components.vehicleNav, view.currency)}
          comparison={`${signedMoney(components.vehicleNav - view.net.product.componentsPrior.vehicleNav, view.currency)} on the quarter`}
          provenance={net.provenance}
        />
        <KpiTile
          label="Net TVPI" value={multiple(net.multiples.tvpi)}
          comparison={`DPI ${multiple(net.multiples.dpi)} · RVPI ${multiple(net.multiples.rvpi)}`}
          provenance={net.provenance}
        />
        <KpiTile label="Net IRR" value={percent(net.irr)} comparison="After fees and expenses" provenance={net.provenance} />
        <KpiTile
          label="Fees since inception" value={money(net.feesCumulative, view.currency)}
          comparison={`${money(net.feesInPeriod, view.currency)} this quarter`}
        />
      </div>

      <Card
        title="From portfolio to net asset value"
        subtitle="The bridge between the gross and net tiers"
        provenance={net.provenance}
        note={net.balanceSheetEstimated
          ? 'No balance sheet was filed for this period — the last known one is carried forward, and every net figure is badged accordingly.'
          : undefined}
      >
        <DataTable
          rows={[
            { label: 'Portfolio net asset value', value: components.portfolio, kind: 'anchor' as const },
            { label: 'Cash and equivalents', value: components.cash, kind: 'add' as const },
            { label: 'Other assets and receivables', value: components.otherAssets, kind: 'add' as const },
            { label: 'Current liabilities', value: -components.currentLiabilities, kind: 'add' as const },
            { label: 'Accrued fees and expenses', value: -components.accruedExpenses, kind: 'add' as const },
            { label: 'Net asset value', value: components.vehicleNav, kind: 'total' as const },
          ]}
          rowKey={(row) => row.label}
          columns={[
            {
              key: 'label', header: 'Component',
              render: (row) => (
                <span style={{ fontWeight: row.kind === 'total' ? 600 : 400 }}>{row.label}</span>
              ),
            },
            {
              key: 'value', header: view.currency, align: 'right',
              render: (row) => (
                <span style={{ fontWeight: row.kind === 'total' ? 600 : 400 }}>
                  {row.kind === 'add' ? signedMoney(row.value, view.currency) : money(row.value, view.currency)}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <ChartCard
        title={view.bridges.productNav.label}
        subtitle={`${formatPeriod(view.priorPeriod)} to ${formatPeriod(view.period)}, net of everything the vehicle charges`}
        provenance={view.bridges.productNav.provenance}
        chart={<Waterfall bridge={view.bridges.productNav} />}
        table={
          <DataTable
            rows={view.bridges.productNav.steps}
            rowKey={(step) => step.key}
            columns={[
              { key: 'label', header: 'Step', render: (s) => s.label },
              {
                key: 'value', header: view.currency, align: 'right',
                render: (s) => (s.type === 'anchor' ? money(s.value, view.currency) : signedMoney(s.value, view.currency)),
              },
              { key: 'note', header: 'Note', render: (s) => s.note ?? '' },
            ]}
          />
        }
      />

      <Card
        title="Capital accounts"
        subtitle={`${view.net.investors.length} investors at ${formatPeriod(view.period)}`}
        note="Ownership is the share of net capital contributed, not of commitment — the two differ
              whenever investors entered at different times."
      >
        <DataTable
          rows={view.net.investors}
          rowKey={(row) => row.investor.id}
          dense
          emptyMessage="No investors recorded for this vehicle."
          columns={[
            {
              key: 'name', header: 'Investor',
              render: (row) => (
                <span>
                  <span className="block font-medium">{row.investor.name}</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {row.investor.type}{row.investor.country ? ` · ${row.investor.country}` : ''}
                  </span>
                </span>
              ),
            },
            {
              key: 'commitment', header: 'Commitment', align: 'right',
              render: (row) => money(row.commitment, view.currency),
              total: money(view.net.investors.reduce((t, i) => t + i.commitment, 0), view.currency),
            },
            {
              key: 'called', header: 'Called', align: 'right',
              render: (row) => money(row.called, view.currency),
              total: money(view.net.investors.reduce((t, i) => t + i.called, 0), view.currency),
            },
            {
              key: 'undrawn', header: 'Undrawn', align: 'right',
              render: (row) => money(row.undrawn, view.currency),
              total: money(view.net.investors.reduce((t, i) => t + i.undrawn, 0), view.currency),
            },
            {
              key: 'distributed', header: 'Distributed', align: 'right',
              render: (row) => money(row.distributed, view.currency),
              total: money(view.net.investors.reduce((t, i) => t + i.distributed, 0), view.currency),
            },
            {
              key: 'nav', header: 'NAV', align: 'right',
              render: (row) => money(row.nav, view.currency),
              total: money(view.net.investors.reduce((t, i) => t + i.nav, 0), view.currency),
            },
            {
              key: 'ownership', header: 'Share', align: 'right',
              render: (row) => percent(row.ownership),
              total: percent(view.net.investors.reduce((t, i) => t + i.ownership, 0)),
            },
            { key: 'tvpi', header: 'TVPI', align: 'right', render: (row) => multiple(row.multiples.tvpi) },
            { key: 'irr', header: 'IRR', align: 'right', render: (row) => percent(row.irr) },
            {
              key: 'basis', header: 'Basis',
              render: (row) => (
                row.allocated
                  ? <StatusPill tone="warning">Allocated pro rata</StatusPill>
                  : <ProvenanceBadge provenance={row.provenance} />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

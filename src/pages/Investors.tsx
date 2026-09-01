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
import { useCan } from '../context/AuthContext';
import { useScope } from '../context/ScopeContext';

export function Investors({ view }: { view: QuarterView }) {
  const { clientId } = useScope();
  const seesAll = useCan('investors.read.all', { clientId });
  const net = view.net.product;
  const components = net.components;
  const restricted = view.net.restricted;
  const own = view.net.investors[0];

  // With a restricted register the product tier's called and distributed are
  // this investor's, not the fund's. Showing the fund's whole net asset value
  // against one investor's paid-in capital produces a multiple several times
  // the real one — so the tiles report the account, and say so.
  const headline = restricted && own
    ? {
      nav: own.nav, navPrior: own.navPrior,
      tvpi: own.multiples.tvpi, dpi: own.multiples.dpi, rvpi: own.multiples.rvpi,
      irr: own.irr, called: own.called, commitment: own.commitment,
      percentCalled: own.commitment > 0 ? own.called / own.commitment : 0,
    }
    : {
      nav: components.vehicleNav, navPrior: view.net.product.componentsPrior.vehicleNav,
      tvpi: net.multiples.tvpi, dpi: net.multiples.dpi, rvpi: net.multiples.rvpi,
      irr: net.irr, called: net.called, commitment: net.commitment,
      percentCalled: net.percentCalled,
    };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={restricted ? 'Your net asset value' : 'Net asset value'}
          value={money(headline.nav, view.currency)}
          comparison={`${signedMoney(headline.nav - headline.navPrior, view.currency)} on the quarter`}
          provenance={net.provenance}
        />
        <KpiTile
          label={restricted ? 'Your net TVPI' : 'Net TVPI'} value={multiple(headline.tvpi)}
          comparison={`DPI ${multiple(headline.dpi)} · RVPI ${multiple(headline.rvpi)}`}
          provenance={net.provenance}
        />
        <KpiTile
          label={restricted ? 'Your net IRR' : 'Net IRR'} value={percent(headline.irr)}
          comparison="After fees and expenses" provenance={net.provenance}
        />
        <KpiTile
          label={restricted ? 'Your commitment' : 'Fees since inception'}
          value={money(restricted ? headline.commitment : net.feesCumulative, view.currency)}
          comparison={restricted
            ? `${percent(headline.percentCalled)} called`
            : `${money(net.feesInPeriod, view.currency)} this quarter`}
        />
      </div>

      {restricted && (
        <p className="m-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Figures above are your capital account. The fund-level composition and movement below are the
          vehicle&rsquo;s, which is what your quarterly report also shows.
        </p>
      )}

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
        subtitle={seesAll.allowed
          ? `${view.net.investors.length} investors at ${formatPeriod(view.period)}`
          : `Your capital account at ${formatPeriod(view.period)}`}
        note={seesAll.allowed
          ? `Ownership is the share of net capital contributed, not of commitment — the two differ whenever investors entered at different times.`
          : `${seesAll.reason} Ownership is your share of net capital contributed, not of commitment.`}
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

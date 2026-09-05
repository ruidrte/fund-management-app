/**
 * The dashboard.
 *
 * Two KPI tiers, gross and net, because the investor's return and the
 * portfolio's return are different questions and a single row of tiles
 * invites the reader to confuse them. Then what moved, then where the money is.
 */

import { useMemo } from 'react';
import { analyse, type QuarterView } from '../engine';
import { formatPeriod, sortPeriods } from '../domain/period';
import { useMoney, useScope } from '../context/ScopeContext';
import { KpiTile } from '../components/common/KpiTile';
import { Card, ChartCard } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { DraftBanner } from '../components/common/DraftBanner';
import { Waterfall } from '../components/charts/Waterfall';
import { AllocationBars } from '../components/charts/AllocationBars';
import { TrendLine, type TrendPoint } from '../components/charts/TrendLine';
import { multiple, percent } from '../components/common/format';

export function Dashboard({ view }: { view: QuarterView }) {
  const { money, signedMoney } = useMoney();
  const { dataset, clientId, vehicleId, periods, currency, knowledgeDate } = useScope();
  const gross = view.gross.totals;
  const net = view.net.product;

  // NAV history, recomputed through the same engine so a drafted quarter in the
  // series is marked as one rather than sitting in the line looking reported.
  const history = useMemo<TrendPoint[]>(() => {
    if (!dataset) return [];
    const ordered = sortPeriods(periods, 'asc');
    const window = ordered.slice(Math.max(0, ordered.indexOf(view.period) - 8), ordered.indexOf(view.period) + 1);
    return window.map((period) => {
      const point = analyse(dataset, {
        clientId, vehicleId, period, knowledgeDate, presentationCurrency: currency,
      });
      return {
        period,
        value: point.gross.totals.nav,
        estimated: point.gross.provenance !== 'reported',
      };
    });
  }, [dataset, clientId, vehicleId, periods, view.period, knowledgeDate, currency]);

  const navMove = gross.nav - gross.navPrior;

  return (
    <div className="flex flex-col gap-4">
      <DraftBanner view={view} />

      <Card
        title="The quarter in one sentence"
        subtitle={`${formatPeriod(view.period)} against ${formatPeriod(view.priorPeriod)}`}
        provenance={view.provenance}
      >
        <p className="m-0 text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
          {view.summary}
        </p>
      </Card>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Gross — the portfolio, before anything the vehicle charges
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Portfolio NAV" value={money(gross.nav, view.currency)}
            comparison={`${signedMoney(navMove, view.currency)} on the quarter`}
            tone={navMove >= 0 ? 'positive' : 'negative'}
            provenance={view.gross.provenance}
          />
          <KpiTile
            label="Gross TVPI" value={multiple(gross.multiples.tvpi)}
            comparison={`DPI ${multiple(gross.multiples.dpi)} · RVPI ${multiple(gross.multiples.rvpi)}`}
            provenance={view.gross.provenance}
          />
          <KpiTile
            label="Gross IRR" value={percent(gross.irr)}
            comparison="Since inception, money-weighted"
            provenance={view.gross.provenance}
          />
          <KpiTile
            label="Invested" value={percent(gross.percentInvested)}
            comparison={`${money(gross.drawn, view.currency)} of ${money(gross.commitments, view.currency)}`}
            note={`${money(gross.openCommitment, view.currency)} still open`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Net — what the investor holds, after fees and expenses
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Net asset value" value={money(net.components.vehicleNav, view.currency)}
            comparison={`Portfolio ${money(net.components.portfolio, view.currency)} + cash and accruals`}
            provenance={net.provenance}
          />
          <KpiTile
            label="Net TVPI" value={multiple(net.multiples.tvpi)}
            comparison={`DPI ${multiple(net.multiples.dpi)} · RVPI ${multiple(net.multiples.rvpi)}`}
            provenance={net.provenance}
          />
          <KpiTile
            label="Net IRR" value={percent(net.irr)}
            comparison="After management fees and expenses"
            provenance={net.provenance}
          />
          <KpiTile
            label="Called" value={percent(net.percentCalled)}
            comparison={`${money(net.called, view.currency)} of ${money(net.commitment, view.currency)}`}
            note={`${money(net.feesInPeriod, view.currency)} of fees this quarter`}
          />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title={view.bridges.portfolioNav.label}
          subtitle="Where the quarter's movement came from"
          provenance={view.bridges.portfolioNav.provenance}
          note={
            view.bridges.portfolioNav.closes
              ? undefined
              : `Bridge does not close — residual ${money(view.bridges.portfolioNav.residual, view.currency)}. Do not publish.`
          }
          chart={<Waterfall bridge={view.bridges.portfolioNav} />}
          table={
            <DataTable
              rows={view.bridges.portfolioNav.steps}
              rowKey={(step) => step.key}
              columns={[
                { key: 'label', header: 'Step', render: (s) => s.label },
                { key: 'type', header: 'Type', render: (s) => (s.type === 'anchor' ? 'Balance' : 'Movement') },
                {
                  key: 'value', header: view.currency, align: 'right',
                  render: (s) => (s.type === 'anchor' ? money(s.value, view.currency) : signedMoney(s.value, view.currency)),
                },
                { key: 'note', header: 'Note', render: (s) => s.note ?? '' },
              ]}
            />
          }
        />

        <ChartCard
          title="Portfolio net asset value"
          subtitle="Last nine quarters, drafted quarters marked"
          provenance={view.gross.provenance}
          chart={<TrendLine points={history} currency={view.currency} label="Portfolio net asset value" />}
          table={
            <DataTable
              rows={history}
              rowKey={(point) => point.period}
              columns={[
                { key: 'period', header: 'Quarter', render: (p) => formatPeriod(p.period) },
                { key: 'value', header: `NAV (${view.currency})`, align: 'right', render: (p) => money(p.value, view.currency) },
                { key: 'basis', header: 'Basis', render: (p) => (p.estimated ? 'Drafted' : 'Reported') },
              ]}
            />
          }
        />

        <ChartCard
          title="Allocation by sub-asset class"
          subtitle={`Share of ${money(view.exposure.subAssetClass.total, view.currency)} portfolio NAV`}
          provenance={view.exposure.subAssetClass.provenance}
          chart={<AllocationBars breakdown={view.exposure.subAssetClass} />}
          table={<ExposureTable view={view} dimension="subAssetClass" />}
        />

        <ChartCard
          title="Currency exposure"
          subtitle={`Before hedging, presented in ${view.currency}`}
          provenance={view.exposure.currency.provenance}
          note="Exposure the vehicle carries whether or not it intends to. FX translation contributed
                the amount shown in the bridge above."
          chart={<AllocationBars breakdown={view.exposure.currency} />}
          table={<ExposureTable view={view} dimension="currency" />}
        />
      </div>

      <ChartCard
        title={view.bridges.commitments.label}
        subtitle="Undrawn commitment, and what consumed it"
        provenance={view.bridges.commitments.provenance}
        chart={<Waterfall bridge={view.bridges.commitments} />}
        table={
          <DataTable
            rows={view.bridges.commitments.steps}
            rowKey={(step) => step.key}
            columns={[
              { key: 'label', header: 'Step', render: (s) => s.label },
              {
                key: 'value', header: view.currency, align: 'right',
                render: (s) => (s.type === 'anchor' ? money(s.value, view.currency) : signedMoney(s.value, view.currency)),
              },
            ]}
          />
        }
      />
    </div>
  );
}

function ExposureTable({ view, dimension }: { view: QuarterView; dimension: string }) {
  const { money } = useMoney();
  const breakdown = view.exposure[dimension];
  return (
    <DataTable
      rows={breakdown.slices}
      rowKey={(slice) => slice.label}
      columns={[
        { key: 'label', header: 'Category', render: (s) => s.label },
        { key: 'value', header: view.currency, align: 'right', render: (s) => money(s.value, view.currency) },
        { key: 'weight', header: 'Share', align: 'right', render: (s) => percent(s.weight) },
        {
          key: 'prior', header: 'Prior', align: 'right',
          render: (s) => (s.priorWeight === undefined ? '—' : percent(s.priorWeight)),
        },
      ]}
    />
  );
}

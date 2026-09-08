/**
 * The dashboard.
 *
 * Two KPI tiers, gross and net, because the investor's return and the
 * portfolio's return are different questions and a single row of tiles
 * invites the reader to confuse them. Then what moved, then where the money is.
 */

import { useMemo } from 'react';
import { analyse, returnBases, type QuarterView, type ReturnBasis } from '../engine';
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
import { useHouse } from '../context/ScopeContext';
import { levelsOf } from '../components/common/levels';

export function Dashboard({ view }: { view: QuarterView }) {
  const { money, signedMoney } = useMoney();
  const house = useHouse();
  const { dataset, clientId, vehicleId, periods, currency, knowledgeDate } = useScope();
  const gross = view.gross.totals;
  const net = view.net.product;

  /**
   * The holder's return on each basis, per holding.
   *
   * One holding, four answers, and all four are correct — they differ in which
   * flows the question admits. Where the answers do not differ there is nothing
   * to show, so the section only appears for a book that has flows outside the
   * commitment, a fee charged for a holding, or a currency to restate into.
   */
  const bases = useMemo<Array<{ name: string; rows: ReturnBasis[] }>>(() => {
    if (!dataset) return [];
    const held = dataset.positions.filter((position) => position.vehicleId === vehicleId);
    // The currency the holder reports in: whatever the book keeps a rate out of
    // the product's currency into. Two and it does not say which, so neither.
    const into = [...new Set(
      dataset.fxRates.filter((rate) => rate.base === currency).map((rate) => rate.quote),
    )];

    return held
      .map((position) => ({
        name: position.name,
        rows: returnBases({
          cashflows: dataset.cashflows,
          valuations: dataset.positionValuations,
          fxRates: dataset.fxRates,
          positionId: position.id,
          currency: position.currency,
          period: view.period,
          restateIn: into.length === 1 ? into[0] : undefined,
        }),
      }))
      // Where every basis gives the same answer, the four are one and the table
      // says nothing the tiles above have not.
      .filter(({ rows }) => rows.length > 1
        && new Set(rows.map((row) => row.irr?.toFixed(6) ?? '—')).size > 1);
  }, [dataset, vehicleId, currency, view.period]);

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

  // What the two tiers are about, from the holdings themselves. For most
  // products this is the generic wording; for a mandate it names the vehicle
  // the interest is held through and the holder's own position in it.
  const levels = useMemo(
    () => levelsOf((dataset?.positions ?? []).filter((p) => p.vehicleId === vehicleId)),
    [dataset, vehicleId],
  );

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
        <h2
          className="mb-2 border-l-[3px] pl-2 text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-secondary)', borderColor: house.gross }}
        >
          Gross — {levels.gross}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile tier="gross"
            label="Portfolio NAV" value={money(gross.nav, view.currency)}
            comparison={`${signedMoney(navMove, view.currency)} on the quarter`}
            tone={navMove >= 0 ? 'positive' : 'negative'}
            provenance={view.gross.provenance}
          />
          <KpiTile tier="gross"
            label="Gross TVPI" value={multiple(gross.multiples.tvpi)}
            comparison={`DPI ${multiple(gross.multiples.dpi)} · RVPI ${multiple(gross.multiples.rvpi)}`}
            provenance={view.gross.provenance}
          />
          <KpiTile tier="gross"
            label="Gross IRR" value={percent(gross.irr)}
            comparison="Since inception, money-weighted"
            provenance={view.gross.provenance}
          />
          <KpiTile tier="gross"
            label="Invested" value={percent(gross.percentInvested)}
            comparison={`${money(gross.drawn, view.currency)} of ${money(gross.commitments, view.currency)}`}
            note={`${money(gross.openCommitment, view.currency)} still open`}
          />
        </div>
      </section>

      <section>
        <h2
          className="mb-2 border-l-[3px] pl-2 text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-secondary)', borderColor: house.net }}
        >
          Net — {levels.net}
        </h2>
        {/*
          Narrowed to one holding, the net tier either narrows with it or says
          it cannot. An LP commits to the fund of funds, not to what the fund of
          funds holds, so for most books there is no called capital to put
          beside a single holding — and the mandate's own called capital divided
          into one holding's value is a multiple describing neither.
        */}
        {view.net.about === 'unattributed' ? (
          <p
            className="rounded border p-3 text-xs"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border)' }}
          >
            The net figures are the whole vehicle&rsquo;s and this view is one holding&rsquo;s.
            An investor commits to the vehicle rather than to what it holds, so its called
            capital and its multiples cannot be attributed to a single holding — clear the
            holding filter to see them.
          </p>
        ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile tier="net"
            label="Net asset value" value={money(net.components.vehicleNav, view.currency)}
            comparison={`Portfolio ${money(net.components.portfolio, view.currency)} + cash and accruals`}
            provenance={net.provenance}
          />
          <KpiTile tier="net"
            label="Net TVPI" value={multiple(net.multiples.tvpi)}
            comparison={`DPI ${multiple(net.multiples.dpi)} · RVPI ${multiple(net.multiples.rvpi)}`}
            provenance={net.provenance}
          />
          <KpiTile tier="net"
            label="Net IRR" value={percent(net.irr)}
            comparison="After management fees and expenses"
            provenance={net.provenance}
          />
          <KpiTile tier="net"
            label="Called" value={percent(net.percentCalled)}
            comparison={`${money(net.called, view.currency)} of ${money(net.commitment, view.currency)}`}
            note={`${money(net.feesInPeriod, view.currency)} of fees this quarter`}
          />
          {/*
            Only for a vehicle that is owned in shares. A closed-end fund has
            capital accounts and no share price, and a tile showing one for it
            would be a figure that reconciles to nothing.
          */}
          {net.units && (
            <KpiTile tier="net"
              label="Net asset value per share"
              value={net.units.navPerShare.toLocaleString('en-GB', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
              })}
              comparison={`${net.units.units.toLocaleString('en-GB', {
                maximumFractionDigits: 4,
              })} shares in issue`}
              note={net.units.complete
                ? undefined
                : 'The register does not yet hold shares for everybody who has been called'}
              provenance={net.units.complete ? net.provenance : 'estimated'}
            />
          )}
        </div>
        )}
      </section>

      {bases.length > 0 && (
        <Card
          title="What the holder earned, on each basis"
          subtitle={
            'The four differ in which flows the question admits, and they are cumulative — '
            + 'the gap between any two is exactly what the wider one takes in.'
          }
        >
          <div className="flex flex-col gap-4">
            {bases.map(({ name, rows }) => (
              <div key={name}>
                <div className="mb-1 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  {name}
                </div>
                <DataTable
                  rows={rows}
                  rowKey={(row) => row.key}
                  columns={[
                    { key: 'basis', header: 'Basis', render: (row) => row.label },
                    { key: 'ccy', header: 'Currency', render: (row) => row.currency },
                    { key: 'irr', header: 'IRR', align: 'right', render: (row) => percent(row.irr) },
                    {
                      key: 'paidIn', header: 'Paid in', align: 'right',
                      render: (row) => money(row.paidIn, row.currency),
                    },
                    {
                      key: 'distributed', header: 'Distributed', align: 'right',
                      render: (row) => money(row.distributed, row.currency),
                    },
                    { key: 'dpi', header: 'DPI', align: 'right', render: (row) => multiple(row.dpi) },
                    { key: 'rvpi', header: 'RVPI', align: 'right', render: (row) => multiple(row.rvpi) },
                    { key: 'tvpi', header: 'TVPI', align: 'right', render: (row) => multiple(row.tvpi) },
                    {
                      key: 'missing', header: 'Left out',
                      // A basis that could not admit every flow says so where
                      // the figure is read, not in a footnote somewhere else.
                      render: (row) => (row.missing.length === 0 ? '' : row.missing.join('; ')),
                    },
                  ]}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

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

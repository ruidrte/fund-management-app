/**
 * The close.
 *
 * Every screen in this application answers a question about one product. This
 * one answers the question that comes before all of them: across everything a
 * person is responsible for, what is ready, what is waiting, and on what.
 *
 * It exists because the work is not "produce a report" — it is "produce seven
 * reports, in the same fortnight, from data that arrives at seven different
 * times". Opening each product in turn to find out which are short is the part
 * that does not scale, and it is the part a machine should do.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, Download, Loader2, RefreshCw,
} from 'lucide-react';
import { zipSync, strToU8 } from 'fflate';
import { analyse, type QuarterView } from '../engine';
import { formatPeriod } from '../domain/period';
import type { DataSet, Vehicle } from '../domain/types';
import { useScope } from '../context/ScopeContext';
import { useDataSource } from '../context/DataSourceContext';
import { useAuth } from '../context/AuthContext';
import { boundInvestorId } from '../auth/permissions';
import { restrictToInvestor } from '../auth/restrict';
import { Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { KpiTile } from '../components/common/KpiTile';
import { StatusPill } from '../components/common/Badges';
import { money, percent } from '../components/common/format';
import { layoutsFor } from '../reports/layouts';
import { renderReport } from '../reports/render';
import { NO_PROFILE, type ReportLayout } from '../domain/report';
import { download } from '../export/serialise';

interface Row {
  key: string;
  clientId: string;
  clientName: string;
  vehicle: Vehicle;
  view: QuarterView;
  layout?: ReportLayout;
  dataset: DataSet;
}

type Standing = 'ready' | 'draft' | 'blocked' | 'empty';

const STANDING: Record<Standing, { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral' }> = {
  ready: { label: 'Ready to issue', tone: 'good' },
  draft: { label: 'Draft', tone: 'warning' },
  blocked: { label: 'Below floor', tone: 'critical' },
  empty: { label: 'Nothing filed', tone: 'neutral' },
};

function standingOf(view: QuarterView): Standing {
  if (view.gross.coverage.expected === 0) return 'empty';
  if (!view.gross.coverage.publishable) return 'blocked';
  return view.isFinal ? 'ready' : 'draft';
}

export function Close() {
  const {
    clients, clientId, period, setClientId, setVehicleId, sourceLabel,
  } = useScope();
  const { repository } = useDataSource();
  const { principal } = useAuth();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [token, setToken] = useState(0);

  const load = useCallback(async (): Promise<Row[]> => {
    const collected: Row[] = [];
    for (const client of clients) {
      // Loaded through the same restriction the rest of the application uses,
      // so this screen cannot become the one place another investor's account
      // reaches the engine.
      const dataset = restrictToInvestor(
        await repository.loadClient(client.id),
        boundInvestorId(principal, client.id),
      );
      const profile = dataset.reporting ?? NO_PROFILE;

      for (const vehicle of dataset.vehicles) {
        const view = analyse(dataset, { clientId: client.id, vehicleId: vehicle.id, period });
        const layouts = layoutsFor(view, profile);
        collected.push({
          key: `${client.id}:${vehicle.id}`,
          clientId: client.id,
          clientName: client.shortName,
          vehicle,
          view,
          dataset,
          layout: layouts.find((l) => l.id === profile.defaultLayoutId) ?? layouts[0],
        });
      }
    }
    return collected;
  }, [clients, repository, principal, period]);

  useEffect(() => {
    if (clients.length === 0 || !period) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    load()
      .then((collected) => { if (!cancelled) setRows(collected); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, clients.length, period, token]);

  const [chosen, setChosen] = useState<Set<string>>(new Set());

  // Anything issuable is proposed; anything below the floor is not, and has to
  // be chosen deliberately.
  useEffect(() => {
    setChosen(new Set(rows.filter((r) => standingOf(r.view) !== 'blocked'
      && standingOf(r.view) !== 'empty').map((r) => r.key)));
  }, [rows]);

  const counts = useMemo(() => {
    const tally: Record<Standing, number> = { ready: 0, draft: 0, blocked: 0, empty: 0 };
    for (const row of rows) tally[standingOf(row.view)] += 1;
    return tally;
  }, [rows]);

  const outstanding = useMemo(
    () => rows.reduce((total, row) =>
      total + (row.view.gross.coverage.expected - row.view.gross.coverage.reported), 0),
    [rows],
  );

  const generate = () => {
    setBusy(true);
    setDone(undefined);
    try {
      const files: Record<string, Uint8Array> = {};
      const index: string[] = [`Reporting pack — ${formatPeriod(period)}`, ''];

      for (const row of rows.filter((r) => chosen.has(r.key))) {
        if (!row.layout) continue;
        const html = renderReport({
          layout: row.layout,
          view: row.view,
          sourceLabel,
          branding: row.dataset.reporting?.branding,
        });
        const name = `${slug(row.clientName)}/${slug(row.vehicle.shortName)}_${period}.html`;
        files[name] = strToU8(html);
        index.push(
          `${name}  —  ${row.layout.name}  —  ${STANDING[standingOf(row.view)].label}`
          + `, ${row.view.gross.coverage.reported}/${row.view.gross.coverage.expected} reported`
          + `, ${row.view.checks.failed} check(s) failed`,
        );
      }

      if (Object.keys(files).length === 0) {
        setDone('Nothing was selected.');
        return;
      }

      index.push('', `Generated ${new Date().toISOString()} from ${sourceLabel}.`);
      files['INDEX.txt'] = strToU8(index.join('\n'));
      download(zipSync(files, { level: 6 }), `reporting_${period}.zip`, 'application/zip');
      setDone(`${Object.keys(files).length - 1} report(s) generated.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const open = (row: Row) => {
    if (row.clientId !== clientId) setClientId(row.clientId);
    setVehicleId(row.vehicle.id);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Products" value={String(rows.length)}
          comparison={`${clients.length} client(s), ${formatPeriod(period)}`}
        />
        <KpiTile
          label="Ready to issue" value={`${counts.ready} / ${rows.length}`}
          comparison={`${counts.draft} draft, ${counts.blocked} below floor`}
          tone={counts.ready === rows.length && rows.length > 0 ? 'positive' : undefined}
        />
        <KpiTile
          label="Holdings outstanding" value={String(outstanding)}
          comparison="Across every product, for this quarter"
          tone={outstanding > 0 ? 'negative' : 'positive'}
        />
        <KpiTile
          label="Checks failing"
          value={String(rows.reduce((total, r) => total + r.view.checks.failed, 0))}
          comparison="A failing identity is a wrong figure, not a warning"
          tone={rows.some((r) => r.view.checks.failed > 0) ? 'negative' : 'positive'}
        />
      </div>

      <Card
        title="The quarter, across every product"
        subtitle={`${formatPeriod(period)} · each product on its own terms and in its own currency`}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button" onClick={() => setToken((n) => n + 1)}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              {loading ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
              Refresh
            </button>
            <button
              type="button" onClick={generate} disabled={busy || chosen.size === 0}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--series-1)', color: '#fff' }}
            >
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Download size={13} aria-hidden />}
              Generate {chosen.size} report(s)
            </button>
          </div>
        }
        note="Each report uses its own client's pack — the layout and branding kept in that client's book —
              and carries its own coverage on the cover. A product below its coverage floor is left
              unselected: it can still be generated, and says on its cover that it must not be issued."
      >
        {error && (
          <p className="m-0 mb-2 flex items-start gap-2 text-xs" style={{ color: 'var(--status-critical)' }}>
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden /> {error}
          </p>
        )}

        <DataTable
          rows={rows}
          rowKey={(row) => row.key}
          dense
          columns={[
            {
              key: 'select', header: '',
              render: (row) => (
                <input
                  type="checkbox"
                  checked={chosen.has(row.key)}
                  onChange={(event) => setChosen((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(row.key);
                    else next.delete(row.key);
                    return next;
                  })}
                  aria-label={`Include ${row.vehicle.shortName}`}
                />
              ),
            },
            { key: 'client', header: 'Client', render: (row) => row.clientName },
            {
              key: 'product', header: 'Product',
              render: (row) => (
                <span className="flex flex-col">
                  <span>{row.vehicle.shortName}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {row.vehicle.kind === 'direct-fund' ? 'Direct fund' : 'Fund of funds'} · {row.vehicle.currency}
                  </span>
                </span>
              ),
            },
            {
              key: 'reported', header: 'Reported', align: 'right',
              render: (row) => `${row.view.gross.coverage.reported} / ${row.view.gross.coverage.expected}`,
            },
            {
              key: 'coverage', header: 'NAV coverage', align: 'right',
              render: (row) => (
                <span style={{
                  color: row.view.gross.coverage.publishable ? 'var(--text-primary)' : 'var(--status-critical)',
                }}>
                  {percent(row.view.gross.coverage.navCoverage, 0)}
                </span>
              ),
            },
            {
              key: 'nav', header: 'NAV', align: 'right',
              render: (row) => money(row.view.net.product.components.vehicleNav, row.view.currency),
            },
            {
              key: 'checks', header: 'Checks', align: 'right',
              render: (row) => (row.view.checks.failed > 0
                ? <span style={{ color: 'var(--status-critical)' }}>{row.view.checks.failed} failing</span>
                : <span style={{ color: 'var(--text-muted)' }}>{row.view.checks.passed} pass</span>),
            },
            {
              key: 'status', header: 'Standing',
              render: (row) => {
                const standing = STANDING[standingOf(row.view)];
                return <StatusPill tone={standing.tone}>{standing.label}</StatusPill>;
              },
            },
            {
              key: 'layout', header: 'Pack',
              render: (row) => (row.layout
                ? <span title={row.layout.description}>{row.layout.name}</span>
                : <span style={{ color: 'var(--status-warning)' }}>No layout applies</span>),
            },
            {
              key: 'open', header: '',
              render: (row) => (
                <button
                  type="button" onClick={() => open(row)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px]"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
                  title="Open this product"
                >
                  Open <ArrowRight size={11} aria-hidden />
                </button>
              ),
            },
          ]}
        />

        {done && (
          <p className="mt-3 mb-0 flex items-start gap-1.5 text-xs" style={{ color: 'var(--status-good)' }}>
            <Check size={13} className="mt-px" aria-hidden /> {done}
          </p>
        )}
      </Card>

      <Card
        title="What is holding each product up"
        subtitle="Only the products that are not ready"
        note="A holding that has not reported is never left at zero — it is rolled forward, or marked with
              what the reporting cohort of its own vehicle achieved, and every figure derived from it
              carries that basis. This list is what would have to arrive for the quarter to be final."
      >
        {rows.every((row) => standingOf(row.view) === 'ready') && rows.length > 0 ? (
          <p className="m-0 text-xs" style={{ color: 'var(--status-good)' }}>
            Every product is complete for {formatPeriod(period)}.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {rows.filter((row) => standingOf(row.view) !== 'ready').map((row) => (
              <li key={row.key}>
                <p className="m-0 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  {row.clientName} · {row.vehicle.shortName}
                </p>
                <ul className="m-0 mt-1 list-disc pl-4 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {row.view.gross.positions
                    .filter((p) => p.provenance !== 'reported')
                    .map((p) => (
                      <li key={p.position.id}>
                        {p.position.name} — {p.state.note ?? 'not reported'}
                      </li>
                    ))}
                  {row.view.checks.results.filter((c) => c.status === 'fail').map((c) => (
                    <li key={c.id} style={{ color: 'var(--status-critical)' }}>
                      Check failed: {c.label}
                    </li>
                  ))}
                  {row.view.gross.coverage.expected === 0 && (
                    <li>No holdings are expected to report for this quarter yet.</li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
}

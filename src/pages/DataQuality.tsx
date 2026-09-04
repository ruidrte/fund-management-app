/**
 * Data quality.
 *
 * Coverage on the left, identity checks on the right. Between them they answer
 * the only two questions that matter before a quarter is issued: is enough of
 * the portfolio actually reported, and does the arithmetic tie.
 */

import type { QuarterView, RateExplanation } from '../engine';
import { AUTHORITY_LABEL, authorityOf } from '../engine/fx';
import { Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { KpiTile } from '../components/common/KpiTile';
import { ProvenanceBadge, StatusPill } from '../components/common/Badges';
import { DraftBanner } from '../components/common/DraftBanner';
import { money, percent, PROVENANCE_DESCRIPTION, PROVENANCE_LABEL } from '../components/common/format';
import { formatPeriod } from '../domain/period';
import { Conventions } from '../components/quality/Conventions';
import { ProductTerms } from '../components/quality/ProductTerms';
import type { CurrencyCode, Provenance } from '../domain/types';

const PROVENANCES: Provenance[] = ['reported', 'rolled-forward', 'estimated', 'stale', 'missing'];

interface RateRow {
  key: string;
  currency: CurrencyCode;
  kind: 'closing' | 'average';
  explanation: RateExplanation;
}

/**
 * The rate actually applied for a currency, described in the direction it is
 * stored in.
 *
 * A CHF book reported in euro asks for CHF/EUR, which is the inverse of the
 * stored EUR/CHF row — and an inverted rate has no source to name. Falling back
 * to the stored direction keeps the answer specific: the reader wants to know
 * which row won, not which way it was multiplied.
 */
function effective(
  view: QuarterView, from: CurrencyCode, to: CurrencyCode, kind: 'closing' | 'average',
): RateExplanation | undefined {
  const direct = view.rates.explain(from, to, view.period, kind);
  if (direct && !direct.derived) return direct;
  const stored = view.rates.explain(to, from, view.period, kind);
  return stored && !stored.derived ? stored : direct;
}

/** The rate rows that actually bear on this view's figures. */
function rateRows(view: QuarterView): RateRow[] {
  const kinds: ('closing' | 'average')[] = view.conventions.flowRate === 'average'
    ? ['closing', 'average']
    : ['closing'];
  const rows: RateRow[] = [];
  for (const currency of view.sourceCurrencies) {
    for (const kind of kinds) {
      const explanation = effective(view, currency, view.currency, kind);
      if (explanation) rows.push({ key: `${currency}-${kind}`, currency, kind, explanation });
    }
  }
  return rows;
}

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

      <FxCard view={view} />

      <ProductTerms />

      <Conventions />

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

/**
 * Which rate was applied, and what it displaced.
 *
 * The rule is the one the books follow: rates come from the ECB, and are
 * replaced by whatever the administrator's financials imply once those arrive.
 * That replacement is by authority, not by arrival — so a later correction to a
 * published fixing does not quietly move a NAV that has already been signed.
 */
function FxCard({ view }: { view: QuarterView }) {
  const rows = rateRows(view);
  if (rows.length === 0) return null;

  const overridden = rows.filter(
    (row) => row.explanation.applied && authorityOf(row.explanation.applied) === 'administrator',
  ).length;

  return (
    <Card
      title="Rates applied"
      subtitle={`Into ${view.currency} for ${formatPeriod(view.period)}`}
      actions={
        <StatusPill tone={overridden > 0 ? 'good' : 'neutral'}>
          {overridden > 0
            ? `${overridden} from the financials`
            : 'Market fixings throughout'}
        </StatusPill>
      }
      note="Stocks translate at the closing rate, flows at the rate of their own date. A rate implied by
            the administrator's trial balance outranks the published fixing for the same quarter, because
            the reported net asset value has to tie to the books it came from — and it outranks it on
            authority, so a fixing filed or corrected afterwards cannot displace it."
    >
      <DataTable
        rows={rows}
        rowKey={(row) => row.key}
        dense
        columns={[
          { key: 'pair', header: 'Pair', render: (row) => row.explanation.pair },
          {
            key: 'kind', header: 'Basis',
            render: (row) => (row.kind === 'closing' ? 'Closing' : 'Period average'),
          },
          {
            key: 'rate', header: 'Rate', align: 'right',
            render: (row) => <span className="tabular">{row.explanation.rate.toFixed(4)}</span>,
          },
          {
            key: 'authority', header: 'Authority',
            render: (row) => (row.explanation.applied
              ? (
                <StatusPill tone={authorityOf(row.explanation.applied) === 'administrator' ? 'good' : 'neutral'}>
                  {AUTHORITY_LABEL[authorityOf(row.explanation.applied)]}
                </StatusPill>
              )
              : <StatusPill tone="warning">Derived</StatusPill>),
          },
          {
            key: 'source', header: 'Source',
            render: (row) => row.explanation.applied?.source
              ?? 'Crossed through another pair — no single filed rate',
          },
          {
            key: 'displaced', header: 'Displaced',
            render: (row) => (row.explanation.superseded.length === 0
              ? '—'
              : row.explanation.superseded
                .map((r) => `${r.rate.toFixed(4)} (${r.source})`)
                .join(', ')),
          },
          {
            key: 'asat', header: 'Filed for',
            render: (row) => (row.explanation.fallbackFrom
              ? (
                <span style={{ color: 'var(--status-warning)' }}>
                  {formatPeriod(row.explanation.fallbackFrom)} — nothing filed for this quarter
                </span>
              )
              : formatPeriod(view.period)),
          },
        ]}
      />
    </Card>
  );
}

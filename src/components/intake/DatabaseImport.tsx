/**
 * Importing a portfolio database.
 *
 * A different screen from the review list on purpose. That one exists to hold
 * a dozen candidates up for confirmation; this one carries thousands of rows
 * that mean nothing individually — nobody confirms a capital call from 2018 one
 * at a time. What is worth a person's attention here is the *shape* of what is
 * about to be written, the rows the reader could not read, and the assumptions
 * it had to make. All three are on this panel before anything is committed.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Database, Info, Loader2, X } from 'lucide-react';
import type { QuarterView } from '../../engine';
import { formatPeriod } from '../../domain/period';
import { planImport, type DatabaseOutcome, type ImportPlan } from '../../ingest';
import { useImport } from '../../context/filing';
import { useScope } from '../../context/ScopeContext';
import { Card } from '../common/Card';
import { StatusPill } from '../common/Badges';
import { DataTable } from '../common/DataTable';
import { money, percent } from '../common/format';

export function DatabaseImport({
  outcome, view, onClose, onImported,
}: {
  outcome: DatabaseOutcome;
  view: QuarterView;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const { vehicles } = useScope();
  const { apply, canImport, destination } = useImport();

  // Portfolios first; a limited partner's own book is picked as the investor
  // beside one, not imported as a portfolio of its own.
  const portfolios = outcome.programs.filter((p) => !p.investorIn);
  const partners = outcome.programs.filter((p) => p.investorIn);

  const [program, setProgram] = useState(portfolios[0]?.program ?? '');
  const [vehicleId, setVehicleId] = useState(view.vehicles[0]?.id ?? vehicles[0]?.id ?? '');
  const [investorProgram, setInvestorProgram] = useState(
    partners.find((p) => p.investorIn === portfolios[0]?.program)?.program ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const plan = useMemo<ImportPlan | undefined>(() => {
    if (!program || !vehicleId) return undefined;
    try {
      return planImport(outcome.sheets, {
        program,
        vehicleId,
        investorProgram: investorProgram || undefined,
        investorName: investorProgram || undefined,
      });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  }, [outcome.sheets, program, vehicleId, investorProgram]);

  const commit = async () => {
    if (!plan) return;
    setBusy(true);
    setFailure(undefined);
    try {
      onImported(await apply(plan, outcome.document, outcome.bytes));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const vehicle = vehicles.find((v) => v.id === vehicleId);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="This is a portfolio database, not a document"
        subtitle={outcome.document.name}
        actions={
          <div className="flex items-center gap-2">
            <StatusPill tone="serious">{outcome.programs.length} programme(s)</StatusPill>
            <button
              type="button" onClick={onClose}
              className="rounded px-2 py-1 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              Close
            </button>
          </div>
        }
        note="Five related sheets rather than a list of facts, so it is imported as a whole rather than
              reviewed row by row. Every figure still carries this file's hash, and the file itself is
              kept beside them."
      >
        <DataTable
          rows={outcome.programs}
          rowKey={(row) => row.program}
          dense
          columns={[
            { key: 'program', header: 'Programme', render: (row) => row.program },
            {
              key: 'what', header: 'What it is',
              render: (row) => (row.investorIn
                ? <span style={{ color: 'var(--text-secondary)' }}>The limited partner of {row.investorIn}</span>
                : 'A portfolio'),
            },
            { key: 'funds', header: 'Funds', align: 'right', render: (row) => row.funds },
            { key: 'tx', header: 'Movements', align: 'right', render: (row) => row.transactions },
            { key: 'companies', header: 'Companies', align: 'right', render: (row) => row.companies },
            {
              key: 'span', header: 'Covering',
              render: (row) => (row.first && row.last
                ? `${formatPeriod(row.first)} — ${formatPeriod(row.last)}`
                : '—'),
            },
          ]}
        />
      </Card>

      <Card
        title="What to import"
        subtitle={vehicle ? `Into ${vehicle.name}` : 'Choose a vehicle'}
        actions={
          <button
            type="button" onClick={commit}
            disabled={!plan || busy || !canImport}
            title={canImport ? undefined : 'Connect a folder under Storage to import into it'}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Database size={13} aria-hidden />}
            Import {program || 'nothing'}
          </button>
        }
      >
        {!canImport && (
          <p className="m-0 mb-3 flex items-start gap-2 text-xs" style={{ color: 'var(--status-warning)' }}>
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            Nothing is persisted in the sample dataset. Connect a folder under Storage first — you can
            still see below exactly what would be written.
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Field label="Programme">
            <select className="field" value={program} onChange={(e) => setProgram(e.target.value)}>
              {portfolios.map((p) => (
                <option key={p.program} value={p.program}>
                  {p.program} — {p.funds} fund(s)
                </option>
              ))}
            </select>
          </Field>

          <Field label="Into which product">
            <select className="field" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>

          <Field label="Its limited partner">
            <select
              className="field" value={investorProgram}
              onChange={(e) => setInvestorProgram(e.target.value)}
            >
              <option value="">None — portfolio only</option>
              {partners.map((p) => (
                <option key={p.program} value={p.program}>
                  {p.program}{p.investorIn ? ` (of ${p.investorIn})` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <p className="mt-2 mb-0 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The limited partner&rsquo;s programme is that vehicle seen from the investor&rsquo;s side: its rows
          become the capital account and the fees charged to it, never portfolio holdings. Choosing it
          fills the net tier as well as the gross one.
        </p>

        {plan && (
          <>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Count label="Holdings" value={plan.positions.length} />
              <Count label="Valuations" value={plan.valuations.length} />
              <Count label="Cashflows" value={plan.cashflows.length} />
              <Count label="Companies" value={plan.assets.length} />
              <Count label="Company values" value={plan.assetValuations.length} />
              <Count label="Rates" value={plan.fxRates.length} />
            </div>

            <p className="mt-3 mb-0 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {plan.periods.length > 0 && (
                <>Covering {formatPeriod(plan.periods[0])} to {formatPeriod(plan.periods[plan.periods.length - 1])}. </>
              )}
              {plan.investors.length > 0 && (
                <>
                  {plan.investors[0].name} committed{' '}
                  {money(plan.investors[0].commitment, plan.investors[0].currency)}.
                </>
              )}
            </p>

            <h4 className="mt-4 mb-1.5 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              Holdings, and the share of each fund this vehicle holds
            </h4>
            <DataTable
              rows={[...plan.positions].sort((a, b) => b.commitment - a.commitment)}
              rowKey={(row) => row.id}
              dense
              columns={[
                { key: 'name', header: 'Fund', render: (row) => row.name },
                { key: 'ccy', header: 'CCY', render: (row) => row.currency },
                {
                  key: 'commitment', header: 'Commitment', align: 'right',
                  render: (row) => money(row.commitment, row.currency),
                },
                {
                  key: 'share', header: 'Share of fund', align: 'right',
                  render: (row) => (row.ownership === 1
                    ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                    : percent(row.ownership, 2)),
                },
                { key: 'kind', header: 'Kind', render: (row) => row.kind },
                { key: 'class', header: 'Sector', render: (row) => row.assetClass },
                { key: 'vintage', header: 'Vintage', align: 'right', render: (row) => row.vintage },
              ]}
            />

            {plan.problems.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"
                  style={{ color: 'var(--status-critical)' }}>
                  <AlertTriangle size={12} aria-hidden />
                  {plan.problems.length} row(s) the reader could not use
                </h4>
                <ul className="m-0 max-h-48 list-disc overflow-y-auto pl-5 text-[11px]"
                  style={{ color: 'var(--text-secondary)' }}>
                  {plan.problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
              </div>
            )}

            {plan.notes.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"
                  style={{ color: 'var(--text-secondary)' }}>
                  <Info size={12} aria-hidden /> What the reader had to assume
                </h4>
                <ul className="m-0 max-h-48 list-disc overflow-y-auto pl-5 text-[11px]"
                  style={{ color: 'var(--text-muted)' }}>
                  {plan.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              </div>
            )}
          </>
        )}

        {failure && (
          <p className="mt-3 mb-0 flex items-start gap-1.5 text-xs" style={{ color: 'var(--status-critical)' }}>
            <X size={13} className="mt-px shrink-0" aria-hidden /> {failure}
          </p>
        )}

        {canImport && destination && (
          <p className="mt-3 mb-0 flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <Check size={12} className="mt-px shrink-0" aria-hidden />
            Importing the same programme again replaces its holdings rather than duplicating them; the
            movements are appended, so a second import of the same file would double them. Import once.
          </p>
        )}
      </Card>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded p-2.5" style={{ background: 'var(--surface-2)' }}>
      <p className="m-0 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className="m-0 text-lg font-semibold tabular" style={{ color: 'var(--text-primary)' }}>
        {value.toLocaleString('en-GB')}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * Importing a portfolio database.
 *
 * A different screen from the review list on purpose. That one exists to hold
 * a dozen candidates up for confirmation; this one carries thousands of rows
 * that mean nothing individually — nobody confirms a capital call from 2018 one
 * at a time. What is worth a person's attention here is the *shape* of what is
 * about to be written, the rows the reader could not read, and the assumptions
 * it had to make. All three are on this panel before anything is committed.
 *
 * One workbook usually holds every product a house runs, so every programme in
 * it is offered at once and they commit together. Loading them one at a time
 * files the same rate table twice and leaves the book half-migrated if the
 * second pass never happens.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Database, Info, Loader2, X } from 'lucide-react';
import { formatPeriod } from '../../domain/period';
import { planImport, similarity, type DatabaseOutcome, type ImportPlan, type ProgramSummary } from '../../ingest';
import { useImport } from '../../context/filing';
import { useScope } from '../../context/ScopeContext';
import type { Vehicle } from '../../domain/types';
import { Card } from '../common/Card';
import { StatusPill } from '../common/Badges';
import { DataTable } from '../common/DataTable';
import { money, percent } from '../common/format';

/** One programme in the workbook, and where it is going. */
interface Target {
  program: string;
  include: boolean;
  vehicleId: string;
  investorProgram: string;
}

/**
 * The product a programme most plausibly belongs to.
 *
 * A programme code and a product name are written by different people for
 * different purposes — "ABIF" and "Abendrot Impulse Fund" — so the short name
 * is tried as well, and a weak match is left unset rather than guessed: filing
 * a portfolio into the wrong product is worse than picking from a list.
 */
function suggest(program: string, vehicles: Vehicle[], taken: Set<string>): string {
  let best: { id: string; score: number } | undefined;
  for (const vehicle of vehicles) {
    if (taken.has(vehicle.id)) continue;
    const score = Math.max(
      similarity(program, vehicle.name),
      similarity(program, vehicle.shortName ?? ''),
    );
    if (!best || score > best.score) best = { id: vehicle.id, score };
  }
  return best && best.score >= 0.5 ? best.id : '';
}

export function DatabaseImport({
  outcome, onClose, onImported,
}: {
  outcome: DatabaseOutcome;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const { vehicles } = useScope();
  const { apply, canImport, destination } = useImport();

  // Portfolios first; a limited partner's own book is picked as the investor
  // beside one, not imported as a portfolio of its own.
  const portfolios = outcome.programs.filter((p) => !p.investorIn);
  const partners = outcome.programs.filter((p) => p.investorIn);

  const [targets, setTargets] = useState<Target[]>(() => {
    const taken = new Set<string>();
    return portfolios.map((program) => {
      const vehicleId = suggest(program.program, vehicles, taken);
      if (vehicleId) taken.add(vehicleId);
      return {
        program: program.program,
        include: Boolean(vehicleId),
        vehicleId,
        // The workbook already says which portfolio a limited partner belongs
        // to, so the pairing is read rather than guessed.
        investorProgram: partners.find((p) => p.investorIn === program.program)?.program ?? '',
      };
    });
  });

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const set = (program: string, patch: Partial<Target>) =>
    setTargets((current) => current.map((t) => (t.program === program ? { ...t, ...patch } : t)));

  const chosen = targets.filter((t) => t.include && t.vehicleId);

  const plans = useMemo<ImportPlan[]>(() => {
    try {
      return chosen.map((target) => planImport(outcome.sheets, {
        program: target.program,
        vehicleId: target.vehicleId,
        investorProgram: target.investorProgram || undefined,
        investorName: target.investorProgram || undefined,
      }));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      return [];
    }
    // `chosen` is derived from targets; depending on it directly would replan
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome.sheets, JSON.stringify(chosen)]);

  // A product can only hold one portfolio, and two programmes filed into the
  // same one would silently replace each other's holdings.
  const clash = new Set(
    chosen.map((t) => t.vehicleId).filter((id, i, all) => all.indexOf(id) !== i),
  );

  const commit = async () => {
    if (plans.length === 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      onImported(await apply(plans, outcome.document, outcome.bytes));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const total = (pick: (plan: ImportPlan) => unknown[]) =>
    plans.reduce((sum, plan) => sum + pick(plan).length, 0);

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
          rowKey={(row: ProgramSummary) => row.program}
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
        title="Where each programme goes"
        subtitle={chosen.length === 0
          ? 'Nothing selected'
          : `${chosen.length} of ${portfolios.length} programme(s), in one write`}
        actions={
          <button
            type="button" onClick={commit}
            disabled={plans.length === 0 || busy || !canImport || clash.size > 0}
            title={canImport ? undefined : 'Connect a folder under Storage to import into it'}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Database size={13} aria-hidden />}
            {chosen.length > 1 ? `Import ${chosen.length} programmes` : `Import ${chosen[0]?.program ?? 'nothing'}`}
          </button>
        }
      >
        {!canImport && (
          <p className="m-0 mb-3 flex items-start gap-2 text-xs" style={{ color: 'var(--status-warning)' }}>
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            No book is connected, so there is nowhere to write. Connect a folder under Storage
            first — you can still see below exactly what would be written.
          </p>
        )}

        <DataTable
          rows={targets}
          rowKey={(row) => row.program}
          dense
          columns={[
            {
              key: 'include', header: '',
              render: (row) => (
                <input
                  type="checkbox"
                  checked={row.include}
                  aria-label={`Import ${row.program}`}
                  onChange={(event) => set(row.program, { include: event.target.checked })}
                />
              ),
            },
            { key: 'program', header: 'Programme', render: (row) => row.program },
            {
              key: 'vehicle', header: 'Into which product',
              render: (row) => (
                <select
                  className="field" value={row.vehicleId}
                  style={clash.has(row.vehicleId)
                    ? { borderColor: 'var(--status-critical)' }
                    : undefined}
                  onChange={(event) => set(row.program, {
                    vehicleId: event.target.value,
                    include: Boolean(event.target.value),
                  })}
                >
                  <option value="">Choose a product…</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              ),
            },
            {
              key: 'investor', header: 'Its limited partner',
              render: (row) => (
                <select
                  className="field" value={row.investorProgram}
                  onChange={(event) => set(row.program, { investorProgram: event.target.value })}
                >
                  <option value="">None — portfolio only</option>
                  {partners.map((p) => (
                    <option key={p.program} value={p.program}>
                      {p.program}{p.investorIn ? ` (of ${p.investorIn})` : ''}
                    </option>
                  ))}
                </select>
              ),
            },
          ]}
        />

        {clash.size > 0 && (
          <p className="mt-2 mb-0 flex items-start gap-1.5 text-xs" style={{ color: 'var(--status-critical)' }}>
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            Two programmes are pointed at the same product. One product holds one portfolio, so the
            second would replace the first.
          </p>
        )}

        <p className="mt-2 mb-0 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The limited partner&rsquo;s programme is that vehicle seen from the investor&rsquo;s side: its rows
          become the capital account and the fees charged to it, never portfolio holdings. Choosing it
          fills the net tier as well as the gross one.
        </p>

        {plans.length > 0 && (
          <>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Count label="Holdings" value={total((p) => p.positions)} />
              <Count label="Valuations" value={total((p) => p.valuations)} />
              <Count label="Cashflows" value={total((p) => p.cashflows)} />
              <Count label="Companies" value={total((p) => p.assets)} />
              <Count label="Company values" value={total((p) => p.assetValuations)} />
              <Count label="Rates" value={plans[0].fxRates.length} />
            </div>

            {plans.map((plan) => (
              <PlanDetail
                key={plan.program}
                plan={plan}
                vehicle={vehicles.find((v) => v.id === plan.vehicleId)?.name ?? plan.vehicleId}
                only={plans.length === 1}
              />
            ))}
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

function PlanDetail({ plan, vehicle, only }: { plan: ImportPlan; vehicle: string; only: boolean }) {
  return (
    <div className="mt-4">
      <h4 className="mb-1.5 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
        {only
          ? 'Holdings, and the share of each fund this vehicle holds'
          : `${plan.program} → ${vehicle}`}
      </h4>
      <p className="mt-0 mb-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
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
        <div className="mt-3">
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"
            style={{ color: 'var(--status-critical)' }}>
            <AlertTriangle size={12} aria-hidden />
            {plan.problems.length} row(s) the reader could not use
          </h5>
          <ul className="m-0 max-h-48 list-disc overflow-y-auto pl-5 text-[11px]"
            style={{ color: 'var(--text-secondary)' }}>
            {plan.problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        </div>
      )}

      {plan.notes.length > 0 && (
        <div className="mt-3">
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"
            style={{ color: 'var(--text-secondary)' }}>
            <Info size={12} aria-hidden /> What the reader had to assume
          </h5>
          <ul className="m-0 max-h-48 list-disc overflow-y-auto pl-5 text-[11px]"
            style={{ color: 'var(--text-muted)' }}>
            {plan.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      )}
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

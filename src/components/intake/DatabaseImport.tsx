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
import {
  planAllocationImport, planImport, planMandateImport, planSupportImport, similarity,
  type DatabaseOutcome, type ImportPlan, type ProgramSummary,
} from '../../ingest';
import { useImport } from '../../context/filing';
import { useMoney, useScope } from '../../context/ScopeContext';
import { Card } from '../common/Card';
import { StatusPill } from '../common/Badges';
import { DataTable } from '../common/DataTable';
import { percent } from '../common/format';

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
function suggest(
  program: string, candidates: Array<{ id: string; name: string; shortName?: string }>,
  taken: Set<string>,
): string {
  let best: { id: string; score: number } | undefined;
  for (const vehicle of candidates) {
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
  const { vehicles, vehicleId, dataset } = useScope();
  const { apply, canImport, destination } = useImport();

  // An allocation database is different from the other two: it says what is
  // inside holdings the book already has, so it is matched against those rather
  // than against products, and it needs a product chosen before it can be read.
  const allocation = outcome.allocation;
  const holdings = useMemo(
    () => (dataset?.positions ?? []).filter((p) => !vehicleId || p.vehicleId === vehicleId),
    [dataset, vehicleId],
  );

  // A quarterly reporting workbook describes one product; an advisory
  // monitoring workbook describes one mandate; a portfolio database describes
  // every programme a manager runs. The screen is the same — choose where each
  // thing goes, see what would be written, commit once — because the question a
  // person is answering is the same. The first two answer it once, so they
  // share a branch and differ only in what the screen says they are.
  const support = outcome.support;
  const mandate = outcome.mandate;
  const single = support ?? mandate;

  // Portfolios first; a limited partner's own book is picked as the investor
  // beside one, not imported as a portfolio of its own.
  const portfolios = allocation
    ? allocation.funds.map((fund) => ({
      program: fund.name, funds: 0, transactions: 0, companies: fund.companies,
      first: allocation.first, last: allocation.last,
    } as ProgramSummary))
    : single
      ? [{ program: single.fund, funds: single.holdings, transactions: single.movements,
        companies: mandate?.companies ?? 0, first: single.first, last: single.last } as ProgramSummary]
      : outcome.programs.filter((p) => !p.investorIn);
  const partners = single ? [] : outcome.programs.filter((p) => p.investorIn);

  const [targets, setTargets] = useState<Target[]>(() => {
    const taken = new Set<string>();
    const against = allocation
      ? holdings.map((p) => ({ id: p.id, name: p.name }))
      : vehicles;
    // A fund is named "MA 22" here and "Equitix MA22" in the book, so the
    // manager is put in front before matching: on its own the code matches
    // nothing.
    const managerOf = new Map(allocation?.funds.map((f) => [f.name, f.manager]) ?? []);
    return portfolios.map((program) => {
      // A mandate is named after the funds it holds and the product after
      // whose mandate it is, so the two never match. The holder is the name
      // they have in common, and is what the product is called.
      const searchFor = mandate
        ? mandate.holder
        : managerOf.get(program.program)
          ? `${managerOf.get(program.program)} ${program.program}`
          : program.program;
      const vehicleId = suggest(searchFor, against, taken);
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
      if (allocation) {
        if (!vehicleId) return [];
        // What each matched holding is worth at the sheet's last quarter, so
        // the reader can settle the units against the book rather than assume.
        const reference: Record<string, number> = {};
        for (const target of chosen) {
          const filed = (dataset?.positionValuations ?? [])
            .filter((v) => v.positionId === target.vehicleId && v.period === allocation.last)
            .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
          if (filed) reference[target.vehicleId] = filed.nav;
        }
        const read = planAllocationImport(outcome.sheets, {
          holdings: Object.fromEntries(chosen.map((t) => [t.program, t.vehicleId])),
          reference,
        });
        return [{
          program: allocation.product,
          vehicleId,
          positions: [], valuations: [], cashflows: [], investors: [],
          assets: read.assets, assetValuations: read.assetValuations, balanceSheets: [],
          metrics: [], fxRates: [],
          problems: read.problems, periods: read.periods, notes: read.notes,
        }];
      }
      return chosen.map((target) => (mandate
        ? planMandateImport(outcome.sheets, { vehicleId: target.vehicleId })
        : support
          ? planSupportImport(outcome.sheets, { vehicleId: target.vehicleId })
          : planImport(outcome.sheets, {
            program: target.program,
            vehicleId: target.vehicleId,
            investorProgram: target.investorProgram || undefined,
            investorName: target.investorProgram || undefined,
          })));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      return [];
    }
    // `chosen` is derived from targets; depending on it directly would replan
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome.sheets, support, mandate, allocation, vehicleId, dataset, JSON.stringify(chosen)]);

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
        title={allocation
          ? 'This is an asset allocation database, not a document'
          : mandate
            ? 'This is an advisory monitoring workbook, not a document'
            : support
              ? 'This is a quarterly reporting workbook, not a document'
              : 'This is a portfolio database, not a document'}
        subtitle={allocation
          ? `${allocation.product} — ${allocation.companies} companies inside ${allocation.funds.length} funds`
          : mandate
            ? `${mandate.holder} — ${mandate.fund}`
              + `${mandate.reportingDate ? `, as at ${mandate.reportingDate}` : ''}`
            : support
              ? `${support.fund}${support.reportingDate ? ` — as at ${support.reportingDate}` : ''}`
              : outcome.document.name}
        actions={
          <div className="flex items-center gap-2">
            <StatusPill tone="serious">
              {allocation
                ? `${allocation.rows} row(s), ${allocation.first} — ${allocation.last}`
                : mandate
                  ? `${mandate.holdings} fund(s), ${mandate.companies} propert(ies)`
                  : support
                    ? `${support.holdings} holding(s), ${support.investors} investor(s)`
                    : `${outcome.programs.length} programme(s)`}
            </StatusPill>
            <button
              type="button" onClick={onClose}
              className="rounded px-2 py-1 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              Close
            </button>
          </div>
        }
        note={allocation
          ? `What is inside the holdings this book already has: one row per company, per fund, per `
            + `quarter. It is what makes look-through possible — the portfolio stops at the funds, `
            + `and this is what is in them. The exposure is read as the sheet files it, so the `
            + `totals sum to the holdings rather than to a second calculation of the same thing.`
          : mandate
            ? `The book an adviser keeps about funds somebody else runs. There is no product to `
            + `value here: what the mandate is worth is what the capital account says, and the `
            + `adviser's own fee is filed against the holder rather than against the funds. Every `
            + `figure keeps the level it was reported at, so the look-through scales down to the `
            + `holder's share instead of being added across levels that do not add.`
            : support
              ? `Read as a whole rather than row by row: the ledger of movements, the balance sheet `
              + `quarter by quarter, and the investors' own ledger. It carries the two things a `
              + `portfolio database cannot — the cash and accruals outside the portfolio, and the `
              + `capital accounts.`
              : `Five related sheets rather than a list of facts, so it is imported as a whole rather `
              + `than reviewed row by row. Every figure still carries this file's hash, and the file `
              + `itself is kept beside them.`}
      >
        {!allocation && !single && (
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
              ...(support ? [] : [{
                key: 'companies', header: 'Companies', align: 'right' as const,
                render: (row: ProgramSummary) => row.companies,
              }]),
              {
                key: 'span', header: 'Covering',
                render: (row) => (row.first && row.last
                  ? `${formatPeriod(row.first)} — ${formatPeriod(row.last)}`
                  : '—'),
              },
            ]}
          />
        )}

      </Card>

      <Card
        title={allocation
          ? 'Which holding each fund is'
          : mandate
            ? 'Which mandate this is'
            : single ? 'Which product this is' : 'Where each programme goes'}
        subtitle={chosen.length === 0
          ? 'Nothing selected'
          : allocation
            ? `${chosen.length} of ${portfolios.length} fund(s) matched, in one write`
            : single
              ? 'One product, in one write'
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
            {allocation
              ? 'Import the look-through'
              : chosen.length > 1
                ? `Import ${chosen.length} programmes`
                : single ? 'Import this workbook' : `Import ${chosen[0]?.program ?? 'nothing'}`}
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
            {
              key: 'program',
              header: allocation
                ? 'Fund, as this sheet names it'
                : single ? 'Workbook' : 'Programme',
              render: (row) => row.program,
            },
            {
              key: 'vehicle', header: allocation ? 'Which holding it is' : 'Into which product',
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
                  <option value="">{allocation ? 'Leave out…' : 'Choose a product…'}</option>
                  {(allocation ? holdings : vehicles).map(
                    (v) => <option key={v.id} value={v.id}>{v.name}</option>,
                  )}
                </select>
              ),
            },
            ...(single || allocation ? [] : [{
              key: 'investor',
              header: 'Its limited partner',
              render: (row: Target) => (
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
            }]),
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
          {allocation
            ? 'A fund left out keeps whatever the book already knows about it: the holding shows on '
              + 'its own attributes instead of the companies inside it.'
            : mandate
              ? 'The holder’s capital account comes from the workbook itself, so the return net of '
              + 'the advisory fee fills alongside the funds — and the properties inside them fill '
              + 'the look-through.'
              : support
                ? 'The investors come from the workbook itself, with their commitments and their calls, '
                + 'so the net tier and the capital accounts fill alongside the portfolio.'
                : 'The limited partner’s programme is that vehicle seen from the investor’s side: its rows '
                + 'become the capital account and the fees charged to it, never portfolio holdings. '
                + 'Choosing it fills the net tier as well as the gross one.'}
        </p>

        {plans.length > 0 && (
          <>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {allocation
                ? <Count label="Companies" value={total((p) => p.assets)} />
                : <Count label="Holdings" value={total((p) => p.positions)} />}
              <Count
                label={allocation ? 'Company values' : 'Valuations'}
                value={total((p) => (allocation ? p.assetValuations : p.valuations))}
              />
              {!allocation && <Count label="Cashflows" value={total((p) => p.cashflows)} />}
              {!allocation && (
                <>
                  <Count label={mandate ? 'Properties' : support ? 'Investors' : 'Companies'}
                    value={support ? total((p) => p.investors) : total((p) => p.assets)} />
                  <Count label={support ? 'Balance sheets' : 'Company values'}
                    value={support ? total((p) => p.balanceSheets) : total((p) => p.assetValuations)} />
                  {total((p) => p.metrics) > 0
                    ? <Count label="Reported figures" value={total((p) => p.metrics)} />
                    : <Count label="Rates" value={plans[0].fxRates.length} />}
                </>
              )}
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
  const { money } = useMoney();
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

/**
 * Manual event entry.
 *
 * The fallback for anything no reader handles — a capital account statement in
 * a layout nobody has seen before, a scanned notice, a correction agreed on the
 * phone.
 *
 * It goes through exactly the same pipeline as a parsed file: a document record
 * is created, candidates are validated, and the same warnings appear. A typed
 * figure is therefore as traceable, and as checked, as a parsed one. The
 * alternative — a form writing straight to the fact tables — would make manual
 * entry the one path with no provenance, which is precisely the path most
 * likely to carry a mistake.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import type { QuarterView } from '../../engine';
import { formatPeriod, periodForDate, periodEndDate } from '../../domain/period';
import { useScope } from '../../context/ScopeContext';
import { useAuth } from '../../context/AuthContext';
import { useFiling } from '../../context/filing';
import { Card } from '../common/Card';
import {
  canCommit, validateAll,
  type Candidate, type CandidateKind, type SourceDocument,
} from '../../ingest';

type EventKind = 'valuation' | 'cashflow' | 'balance-sheet';

const EVENT_LABEL: Record<EventKind, string> = {
  valuation: 'Valuation',
  cashflow: 'Cashflow',
  'balance-sheet': 'Vehicle balance sheet',
};

const CANDIDATE_KIND: Record<EventKind, CandidateKind> = {
  valuation: 'position-valuation',
  cashflow: 'cashflow',
  'balance-sheet': 'balance-sheet',
};

export function ManualEvent({
  view, onClose, onSubmitted,
}: {
  view: QuarterView;
  onClose: () => void;
  onSubmitted: (message: string) => void;
}) {
  const { dataset } = useScope();
  const { file } = useFiling();
  const { user } = useAuth();

  const [kind, setKind] = useState<EventKind>('valuation');
  const [positionId, setPositionId] = useState('');
  const [date, setDate] = useState(periodEndDate(view.period));
  const [values, setValues] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState<Candidate>();
  const [failure, setFailure] = useState<string>();

  const positions = useMemo(
    () => (dataset?.positions ?? []).filter(
      (p) => !view.vehicles[0] || p.vehicleId === view.vehicles[0].id,
    ),
    [dataset, view.vehicles],
  );

  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const num = (name: string) => {
    const parsed = Number(values[name]);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const build = (): Candidate | undefined => {
    if (!dataset) return undefined;

    const position = positions.find((p) => p.id === positionId);
    const period = kind === 'cashflow' ? periodForDate(date) : view.period;

    const fields: Candidate['fields'] = {};
    const confident = (value: string | number | boolean | null) =>
      ({ value, confidence: 1, locator: 'entered by hand' });

    if (kind === 'valuation') {
      fields.period = confident(period);
      fields.nav = confident(num('nav') ?? Number.NaN);
      if (values.drawnCumulative) fields.drawnCumulative = confident(num('drawnCumulative')!);
      if (values.distributedCumulative) fields.distributedCumulative = confident(num('distributedCumulative')!);
      fields.source = confident(reference || 'Manual entry');
    } else if (kind === 'cashflow') {
      const type = values.type || 'Capital Call';
      const magnitude = Math.abs(num('amount') ?? Number.NaN);
      fields.type = confident(type);
      // Signed from the vehicle's perspective, so the person entering it never
      // has to remember the convention.
      fields.amount = confident(type === 'Capital Call' || type === 'Fee' || type === 'Expense'
        ? -magnitude : magnitude);
      fields.currency = confident((values.currency || position?.currency || view.currency).toUpperCase());
      fields.date = confident(date);
      fields.period = confident(period);
      fields.affectsCommitment = confident(type === 'Capital Call');
      fields.description = confident(reference || 'Manual entry');
    } else {
      fields.period = confident(view.period);
      fields.cash = confident(num('cash') ?? 0);
      fields.otherAssets = confident(num('otherAssets') ?? 0);
      fields.currentLiabilities = confident(num('currentLiabilities') ?? 0);
      fields.accruedExpenses = confident(num('accruedExpenses') ?? 0);
      fields.source = confident(reference || 'Manual entry');
    }

    const target = kind === 'balance-sheet'
      ? view.vehicles[0]
      : position;

    return {
      id: `manual-${Date.now()}`,
      documentId: 'pending',
      kind: CANDIDATE_KIND[kind],
      fields,
      match: target
        ? {
          kind: kind === 'balance-sheet' ? 'vehicle' : 'position',
          id: target.id,
          sourceName: target.name,
          matchedName: target.name,
          confidence: 1,
          alternatives: [],
        }
        : undefined,
      issues: [],
      state: 'pending',
    };
  };

  const check = (event: FormEvent) => {
    event.preventDefault();
    if (!dataset) return;
    const candidate = build();
    if (!candidate) return;
    setPreview(validateAll([candidate], dataset)[0]);
  };

  const commit = () => {
    if (!dataset || !preview || !canCommit(preview)) return;

    // A manual entry is a document too, so the figure is as traceable as a
    // parsed one.
    const document: SourceDocument = {
      id: `manual-${Date.now()}`,
      clientId: dataset.client.id,
      kind: 'manual-entry',
      name: reference || `${EVENT_LABEL[kind]} entered ${new Date().toISOString().slice(0, 10)}`,
      mimeType: 'text/plain',
      sizeBytes: 0,
      contentHash: 'manual',
      period: view.period,
      uploadedAt: new Date().toISOString(),
      uploadedBy: user?.id,
      status: 'committed',
    };

    void (async () => {
      try {
        const result = await file([{ ...preview, state: 'accepted' }], document);
        onSubmitted(`${EVENT_LABEL[kind]} — ${result.message}`);
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  };

  const errors = preview?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = preview?.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <Card
      title="New event"
      subtitle={`Recorded against ${formatPeriod(view.period)} and validated exactly like a parsed file`}
      actions={
        <button
          type="button" onClick={onClose}
          className="rounded px-2 py-1 text-xs"
          style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
        >
          Close
        </button>
      }
    >
      <form onSubmit={check} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <Field label="Event">
            <select className="field" value={kind}
              onChange={(event) => { setKind(event.target.value as EventKind); setPreview(undefined); }}>
              {(Object.keys(EVENT_LABEL) as EventKind[]).map((option) => (
                <option key={option} value={option}>{EVENT_LABEL[option]}</option>
              ))}
            </select>
          </Field>

          {kind !== 'balance-sheet' && (
            <Field label="Holding">
              <select className="field" value={positionId} required
                onChange={(event) => setPositionId(event.target.value)}>
                <option value="">Select…</option>
                {positions.map((position) => (
                  <option key={position.id} value={position.id}>{position.name}</option>
                ))}
              </select>
            </Field>
          )}

          {kind === 'cashflow' && (
            <>
              <Field label="Type">
                <select className="field" value={values.type ?? 'Capital Call'}
                  onChange={(event) => set('type', event.target.value)}>
                  {['Capital Call', 'Distribution', 'Return of Capital', 'Equalisation',
                    'Fee', 'Expense', 'Income', 'Commitment'].map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </Field>
              <Field label="Date">
                <input type="date" className="field" value={date} required
                  onChange={(event) => setDate(event.target.value)} />
              </Field>
              <Field label="Amount (positive)">
                <input type="number" step="any" className="field tabular" required
                  value={values.amount ?? ''} onChange={(event) => set('amount', event.target.value)} />
              </Field>
              <Field label="Currency">
                <input className="field" maxLength={3} placeholder={view.currency}
                  value={values.currency ?? ''} onChange={(event) => set('currency', event.target.value)} />
              </Field>
            </>
          )}

          {kind === 'valuation' && (
            <>
              <Field label={`NAV (${view.currency})`}>
                <input type="number" step="any" className="field tabular" required
                  value={values.nav ?? ''} onChange={(event) => set('nav', event.target.value)} />
              </Field>
              <Field label="Drawn to date">
                <input type="number" step="any" className="field tabular"
                  value={values.drawnCumulative ?? ''}
                  onChange={(event) => set('drawnCumulative', event.target.value)} />
              </Field>
              <Field label="Distributed to date">
                <input type="number" step="any" className="field tabular"
                  value={values.distributedCumulative ?? ''}
                  onChange={(event) => set('distributedCumulative', event.target.value)} />
              </Field>
            </>
          )}

          {kind === 'balance-sheet' && (
            <>
              <Field label="Cash"><NumberInput name="cash" values={values} set={set} /></Field>
              <Field label="Other assets"><NumberInput name="otherAssets" values={values} set={set} /></Field>
              <Field label="Current liabilities"><NumberInput name="currentLiabilities" values={values} set={set} /></Field>
              <Field label="Accrued expenses"><NumberInput name="accruedExpenses" values={values} set={set} /></Field>
            </>
          )}

          <Field label="Reference or source">
            <input className="field" placeholder="e.g. GP statement 31.03.2026"
              value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
        </div>

        {kind === 'balance-sheet' && (
          <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Liabilities and accruals are entered positive; the engine subtracts them.
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          >
            Check
          </button>
          {preview && (
            <button
              type="button" onClick={commit} disabled={errors.length > 0}
              className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--series-1)', color: '#fff' }}
            >
              File it
            </button>
          )}
        </div>
      </form>

      {failure && (
        <p className="mt-3 mb-0 flex items-start gap-1.5 text-xs" style={{ color: 'var(--status-critical)' }}>
          <XCircle size={12} className="mt-px shrink-0" aria-hidden />
          Nothing was filed: {failure}
        </p>
      )}

      {preview && (
        <div className="mt-3">
          {errors.length === 0 && warnings.length === 0 && (
            <p className="m-0 text-xs" style={{ color: 'var(--status-good)' }}>
              Nothing objectionable found. Filing it appends a new observation — it does not overwrite
              anything, so an earlier report stays reproducible.
            </p>
          )}
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
            {preview.issues.map((issue, index) => (
              <li
                key={`${issue.message}-${index}`}
                className="flex items-start gap-1.5"
                style={{ color: issue.severity === 'error' ? 'var(--status-critical)' : 'var(--status-warning)' }}
              >
                {issue.severity === 'error'
                  ? <XCircle size={13} className="mt-px shrink-0" aria-hidden />
                  : <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />}
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function NumberInput({
  name, values, set,
}: { name: string; values: Record<string, string>; set: (name: string, value: string) => void }) {
  return (
    <input
      type="number" step="any" className="field tabular w-32"
      value={values[name] ?? ''} onChange={(event) => set(name, event.target.value)}
    />
  );
}

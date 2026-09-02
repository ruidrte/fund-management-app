/**
 * House conventions.
 *
 * The handful of decisions that are a house's to make rather than the
 * application's, and that change published figures. Each is stated with what it
 * does, because "roll forward: portfolio" means nothing to somebody reading a
 * report and everything to the number in it.
 *
 * They are saved with the client, in the client's own book, beside its figures.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, RotateCcw, Save } from 'lucide-react';
import { useConventions } from '../../context/filing';
import { useScope } from '../../context/ScopeContext';
import { DEFAULT_CONVENTIONS, type DraftPolicy, type ReportingConventions } from '../../domain/types';
import { Card } from '../common/Card';
import { StatusPill } from '../common/Badges';

export function Conventions() {
  const { clients, clientId } = useScope();
  const { conventions, save, canSave, reason, destination } = useConventions();

  const [draft, setDraft] = useState<ReportingConventions>(conventions);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => { setDraft(conventions); }, [conventions, clientId]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(conventions);
  const client = clients.find((c) => c.id === clientId);

  const set = (patch: Partial<ReportingConventions>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const setPolicy = (patch: Partial<DraftPolicy>) =>
    setDraft((current) => ({ ...current, draftPolicy: { ...current.draftPolicy, ...patch } }));

  const commit = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await save(draft);
      setSaved(`Saved to ${destination ?? 'the book'}. Every figure recomputes on the new basis.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="House conventions"
      subtitle={client ? `${client.name} — kept in its own book` : 'Kept with the client'}
      actions={
        <div className="flex items-center gap-2">
          {dirty && <StatusPill tone="warning">Unsaved</StatusPill>}
          <button
            type="button" onClick={() => setDraft(DEFAULT_CONVENTIONS)}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            <RotateCcw size={13} aria-hidden /> Defaults
          </button>
          <button
            type="button" onClick={commit} disabled={!canSave || !dirty || busy}
            title={reason}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            <Save size={13} aria-hidden /> Save
          </button>
        </div>
      }
      note="These change published figures. A holding that has not reported carried flat rather than
            marked with the cohort's value change moved one real quarter's net asset value by six
            thousand euros — small against a hundred and twenty million, and still a number somebody
            has to explain. Set them to match the house, not the other way round."
    >
      {!canSave && (
        <p className="m-0 mb-3 flex items-start gap-2 text-xs" style={{ color: 'var(--status-warning)' }}>
          <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
          {reason} You can still see the effect below; it will not survive a reload.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Choice
          label="A holding that has not reported this quarter"
          value={draft.draftPolicy.rollForward
            ? draft.draftPolicy.valueChange
            : 'stale'}
          onChange={(value) => (value === 'stale'
            ? setPolicy({ rollForward: false })
            : setPolicy({ rollForward: true, valueChange: value as DraftPolicy['valueChange'] }))}
          options={[
            ['none', 'Carried at its last value, adjusted for cashflows since'],
            ['portfolio', 'Marked with the value change the holdings that did report achieved'],
            ['fixed', 'Marked with a fixed assumed return'],
            ['stale', 'Carried at its last value, untouched — not even for cashflows'],
          ]}
        />

        {draft.draftPolicy.rollForward && draft.draftPolicy.valueChange === 'fixed' && (
          <Quantity
            label="Assumed return each quarter"
            suffix="%"
            value={(draft.draftPolicy.fixedReturn ?? 0) * 100}
            onChange={(value) => setPolicy({ fixedReturn: value / 100 })}
          />
        )}

        <Choice
          label="Cashflows are translated at"
          value={draft.flowRate}
          onChange={(value) => set({ flowRate: value as ReportingConventions['flowRate'] })}
          options={[
            ['transaction', 'The rate on the day of the flow'],
            ['average', 'The period average'],
          ]}
        />

        <Choice
          label="Money-weighted return is computed on"
          value={draft.irrBasis}
          onChange={(value) => set({ irrBasis: value as ReportingConventions['irrBasis'] })}
          options={[
            ['daily', 'Flows on their own dates'],
            ['quarterly', 'Flows at the end of the quarter they fall in'],
          ]}
        />

        <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-primary)' }}>
          <input
            type="checkbox" className="mt-0.5"
            checked={draft.recallableRestoresCommitment}
            onChange={(event) => set({ recallableRestoresCommitment: event.target.checked })}
          />
          <span>
            A recallable distribution restores undrawn commitment
            <span className="block" style={{ color: 'var(--text-muted)' }}>
              Open commitment then reads as undrawn plus recallable, which is what the vehicle may
              still have to fund.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-4">
          <Quantity
            label="Refuse a quarter below this coverage"
            suffix="%"
            value={draft.draftPolicy.minimumCoverage * 100}
            onChange={(value) => setPolicy({ minimumCoverage: Math.min(100, Math.max(0, value)) / 100 })}
          />
          <Quantity
            label="A valuation is stale after"
            suffix="quarters"
            value={draft.draftPolicy.staleAfterQuarters}
            onChange={(value) => setPolicy({ staleAfterQuarters: Math.max(0, Math.round(value)) })}
          />
        </div>
      </div>

      {(saved || failure) && (
        <p className="mt-3 mb-0 flex items-start gap-1.5 text-xs"
          style={{ color: failure ? 'var(--status-critical)' : 'var(--status-good)' }}>
          {failure
            ? <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            : <Check size={13} className="mt-px shrink-0" aria-hidden />}
          {failure ?? saved}
        </p>
      )}
    </Card>
  );
}

function Choice({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[11px] font-medium uppercase tracking-wide"
        style={{ color: 'var(--text-muted)' }}>
        {label}
      </legend>
      <div className="flex flex-col gap-1">
        {options.map(([option, description]) => (
          <label key={option} className="flex items-start gap-2 text-xs"
            style={{ color: 'var(--text-primary)' }}>
            <input
              type="radio" className="mt-0.5" name={label}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Quantity({
  label, value, suffix, onChange,
}: { label: string; value: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="number" className="field w-24"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{suffix}</span>
      </span>
    </label>
  );
}

/**
 * Data intake.
 *
 * Upload, review, commit. The review step is the point of the screen: every
 * candidate shows what it was read from, how confident the reader was, what it
 * was matched to and what validation found. Nothing commits without someone
 * having looked at it.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, FileUp, Loader2, Plus, X, XCircle,
} from 'lucide-react';
import type { QuarterView } from '../engine';
import { formatPeriod } from '../domain/period';
import { useScope } from '../context/ScopeContext';
import { useAuth, useCan } from '../context/AuthContext';
import { Card } from '../components/common/Card';
import { StatusPill } from '../components/common/Badges';
import { DataTable } from '../components/common/DataTable';
import { ManualEvent } from '../components/intake/ManualEvent';
import {
  DOCUMENT_KIND_LABEL, EXTRACTORS, MAX_FILE_BYTES, canCommit, ingest,
  type Candidate, type DocumentKind, type IngestOutcome,
} from '../ingest';
import { useFiling } from '../context/filing';

const UPLOADABLE: DocumentKind[] = [
  'historical-workbook', 'transaction-notice', 'nav-pack',
  'capital-account-statement', 'financial-statements',
];

export function Intake({ view }: { view: QuarterView }) {
  const { dataset, clientId, vehicleId } = useScope();
  const { file: fileFacts } = useFiling();
  const { user } = useAuth();
  const upload = useCan('documents.upload', { clientId, vehicleId });
  const commitRight = useCan('facts.commit', { clientId, vehicleId });
  const fileInput = useRef<HTMLInputElement>(null);
  // Held so the file itself can be kept alongside the figures it produced.
  const uploaded = useRef<File>();

  const [kind, setKind] = useState<DocumentKind>('historical-workbook');
  const [outcome, setOutcome] = useState<IngestOutcome>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [committed, setCommitted] = useState<string>();
  const [manualOpen, setManualOpen] = useState(false);
  const [createMissing, setCreateMissing] = useState(false);
  const [sheet, setSheet] = useState<string>();

  const extractor = EXTRACTORS.find((e) => e.kind === kind);

  const handleFile = useCallback(async (file: File, sheetName?: string) => {
    if (!dataset) return;
    uploaded.current = file;
    setBusy(true);
    setError(undefined);
    setCommitted(undefined);
    try {
      const result = await ingest(
        {
          file, kind, clientId, vehicleId, period: view.period,
          sheetName, createMissing, uploadedBy: user?.id,
        },
        dataset,
      );
      // Anything clean is pre-accepted; anything with a warning or an error is
      // left pending, so the reviewer's attention goes where it is needed.
      setSheet(sheetName);
      setOutcome({
        ...result,
        candidates: result.candidates.map((candidate) => ({
          ...candidate,
          state: candidate.issues.length === 0 && canCommit(candidate) ? 'accepted' : 'pending',
        })),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setOutcome(undefined);
    } finally {
      setBusy(false);
    }
  }, [dataset, kind, clientId, vehicleId, view.period, createMissing, user]);

  /**
   * Accepting or rejecting one candidate, carrying the decision to the ones
   * tied to it. A valuation whose holding was rejected has nothing to be filed
   * against; accepting it without the holding would drop it silently.
   */
  const setState = (id: string, state: Candidate['state']) => {
    setOutcome((current) => {
      if (!current) return current;
      const dependencies = new Set<string>();
      const dependents = new Set<string>();
      for (const c of current.candidates) {
        if (c.id === id && c.dependsOn) dependencies.add(c.dependsOn);
        if (c.dependsOn === id) dependents.add(c.id);
      }
      return {
        ...current,
        candidates: current.candidates.map((c) => {
          if (c.id === id) return { ...c, state };
          if (state === 'rejected' && dependents.has(c.id)) return { ...c, state };
          if (state === 'accepted' && dependencies.has(c.id) && canCommit(c)) {
            return { ...c, state };
          }
          return c;
        }),
      };
    });
  };

  /** Everything without an error, in one go — the first load of a book is not 40 clicks. */
  const acceptAll = () => {
    setOutcome((current) => current && {
      ...current,
      candidates: current.candidates.map((c) =>
        (canCommit(c) && c.state !== 'rejected' ? { ...c, state: 'accepted' as const } : c)),
    });
  };

  const chooseMatch = (id: string, matchId: string, matchedName: string) => {
    setOutcome((current) => current && {
      ...current,
      candidates: current.candidates.map((c) =>
        c.id === id && c.match
          ? {
            ...c,
            match: { ...c.match, id: matchId, matchedName, confidence: 1 },
            // A corrected match clears the matching error it caused; other
            // issues stand until they are separately resolved.
            issues: c.issues.filter((issue) => issue.field !== 'match'),
          }
          : c),
    });
  };

  const accepted = outcome?.candidates.filter((c) => c.state === 'accepted') ?? [];
  const blocked = outcome?.candidates.filter((c) => !canCommit(c)) ?? [];

  const commit = async () => {
    if (!outcome || !dataset || accepted.length === 0 || !commitRight.allowed) return;
    setBusy(true);
    setError(undefined);
    try {
      // The file's own bytes go with it when there is a folder to keep them in,
      // so a figure filed today can be traced to the document years from now.
      const bytes = uploaded.current
        ? new Uint8Array(await uploaded.current.arrayBuffer())
        : undefined;
      const result = await fileFacts(accepted, outcome.document, bytes);
      setCommitted(result.message);
      setOutcome(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Load a document"
        subtitle={`Into ${view.vehicles[0]?.name ?? 'this client'}, for ${formatPeriod(view.period)}`}
        note={extractor?.capability}
        actions={
          <button
            type="button"
            onClick={() => setManualOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            <Plus size={13} aria-hidden /> New event
          </button>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="doc-kind" className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}>
              Document type
            </label>
            <select
              id="doc-kind" className="field" value={kind}
              onChange={(event) => { setKind(event.target.value as DocumentKind); setOutcome(undefined); }}
            >
              {UPLOADABLE.map((option) => (
                <option key={option} value={option}>{DOCUMENT_KIND_LABEL[option]}</option>
              ))}
            </select>
          </div>

          <input
            ref={fileInput} type="file" className="hidden"
            accept=".csv,.tsv,.txt,.xlsx,.pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = '';
            }}
          />
          <button
            type="button" onClick={() => fileInput.current?.click()}
            disabled={busy || !upload.allowed}
            title={upload.reason}
            className="inline-flex items-center gap-2 rounded px-3 py-2 text-xs font-medium disabled:opacity-60"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileUp size={14} aria-hidden />}
            {busy ? 'Reading…' : 'Choose file'}
          </button>

          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            CSV, XLSX or PDF, up to {MAX_FILE_BYTES / 1024 / 1024} MB
          </span>

          {kind === 'historical-workbook' && (
            <label className="flex items-start gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox" className="mt-0.5"
                checked={createMissing}
                onChange={(event) => { setCreateMissing(event.target.checked); setOutcome(undefined); }}
              />
              <span className="max-w-[22rem]">
                Create holdings this book does not have.
                <span className="block" style={{ color: 'var(--text-muted)' }}>
                  For the first load of a book, when there is nothing to match against yet. Leave it off
                  afterwards: a name that matches nothing is then a typo, not a new fund, and each one is
                  still shown for confirmation.
                </span>
              </span>
            </label>
          )}
        </div>

        {!upload.allowed && (
          <p className="mt-3 mb-0 text-xs" style={{ color: 'var(--status-warning)' }} role="status">
            {upload.reason}
          </p>
        )}

        {!extractor && upload.allowed && (
          <p className="mt-3 mb-0 text-xs" style={{ color: 'var(--status-warning)' }}>
            No reader is registered for {DOCUMENT_KIND_LABEL[kind]} yet. Use <em>New event</em> to enter the
            figures manually — they stay just as traceable, because a manual entry is recorded as a document too.
          </p>
        )}

        {error && (
          <p className="mt-3 mb-0 flex items-start gap-2 text-xs" style={{ color: 'var(--status-critical)' }} role="alert">
            <XCircle size={14} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        )}

        {committed && (
          <p className="mt-3 mb-0 flex items-start gap-2 text-xs" style={{ color: 'var(--status-good)' }} role="status">
            <Check size={14} className="mt-px shrink-0" aria-hidden />
            {committed}
          </p>
        )}
      </Card>

      {manualOpen && (
        <ManualEvent
          view={view}
          onClose={() => setManualOpen(false)}
          onSubmitted={(message) => { setCommitted(message); setManualOpen(false); }}
        />
      )}

      {outcome && (
        <>
          <Card
            title="What was read"
            subtitle={outcome.document.name}
            actions={
              <div className="flex items-center gap-2">
                <StatusPill tone={blocked.length > 0 ? 'serious' : 'good'}>
                  {accepted.length} of {outcome.candidates.length} accepted
                </StatusPill>
                <button
                  type="button" onClick={commit}
                  disabled={accepted.length === 0 || !commitRight.allowed}
                  title={commitRight.reason}
                  className="rounded px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                  style={{ background: 'var(--series-1)', color: '#fff' }}
                >
                  Commit {accepted.length}
                </button>
              </div>
            }
            note={commitRight.allowed
              ? `Content hash ${outcome.document.contentHash.slice(0, 16)}… — every figure filed from this document carries it, so any number on any report traces back to the file it came from.`
              : `${commitRight.reason} You can still review what was read and pass it on.`}
          >
            <p className="m-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {outcome.summary}
            </p>

            {outcome.availableSheets && outcome.availableSheets.length > 1 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label htmlFor="sheet" className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Sheet read — the one with the most tabular content, unless you say otherwise:
                </label>
                <select
                  id="sheet" className="field max-w-[16rem] text-xs"
                  value={sheet ?? ''}
                  disabled={busy}
                  onChange={(event) => {
                    const file = uploaded.current;
                    if (file) void handleFile(file, event.target.value || undefined);
                  }}
                >
                  <option value="">Whichever looks like data</option>
                  {outcome.availableSheets.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            )}
          </Card>

          {outcome.candidates.length > 0 && (
            <Card
              title="Review"
              subtitle="Nothing is filed until it is accepted here"
              actions={
                <button
                  type="button" onClick={acceptAll}
                  className="rounded px-2.5 py-1.5 text-xs"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
                >
                  Accept everything without an error
                </button>
              }
            >
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {outcome.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <CandidateRow
                      candidate={candidate}
                      onAccept={() => setState(candidate.id, 'accepted')}
                      onReject={() => setState(candidate.id, 'rejected')}
                      onChooseMatch={(id, name) => chooseMatch(candidate.id, id, name)}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {outcome.unparsed.length > 0 && (
            <Card
              title="Not read"
              subtitle={`${outcome.unparsed.length} item(s) the reader could not interpret`}
              note="Listed rather than dropped. A row silently skipped is a row nobody knows is missing."
            >
              <ul className="m-0 max-h-64 list-none overflow-y-auto p-0 text-xs"
                style={{ color: 'var(--text-secondary)' }}>
                {outcome.unparsed.map((line, index) => (
                  <li key={`${line}-${index}`} className="border-b py-1" style={{ borderColor: 'var(--border)' }}>
                    {line}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <Card
        title="What each reader can do"
        subtitle="Stated plainly, because the confidence you should place in a figure depends on how it got here"
      >
        <DataTable
          rows={EXTRACTORS}
          rowKey={(row) => row.kind}
          dense
          columns={[
            { key: 'label', header: 'Document', render: (row) => DOCUMENT_KIND_LABEL[row.kind] },
            { key: 'accepts', header: 'Formats', render: (row) => row.accepts.filter((a) => a.startsWith('.')).join(', ') },
            { key: 'capability', header: 'What it does', render: (row) => row.capability },
          ]}
        />
        <p className="mt-3 mb-0 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          A scanned PDF with no text layer cannot be read at all and says so rather than appearing to
          succeed with nothing in it. Capital account statements and financial statements have no
          structural reader yet: extract their text, then enter the figures through <em>New event</em>,
          which records them against the document exactly as a parsed figure would be.
        </p>
      </Card>
    </div>
  );
}

function CandidateRow({
  candidate, onAccept, onReject, onChooseMatch,
}: {
  candidate: Candidate;
  onAccept: () => void;
  onReject: () => void;
  onChooseMatch: (id: string, name: string) => void;
}) {
  const errors = candidate.issues.filter((i) => i.severity === 'error');
  const warnings = candidate.issues.filter((i) => i.severity === 'warning');
  const committable = canCommit(candidate);

  const tone = candidate.state === 'rejected' ? 'var(--border-strong)'
    : errors.length > 0 ? 'var(--status-critical)'
    : warnings.length > 0 ? 'var(--status-warning)'
    : 'var(--status-good)';

  const primary = useMemo(() => {
    const entries = Object.entries(candidate.fields)
      .filter(([name]) => !['source', 'description'].includes(name));
    return entries.slice(0, 6);
  }, [candidate.fields]);

  return (
    <div
      className="rounded p-3"
      style={{
        border: '1px solid var(--border)',
        borderLeftWidth: 3,
        borderLeftColor: tone,
        opacity: candidate.state === 'rejected' ? 0.55 : 1,
      }}
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {candidate.match?.matchedName
              ?? candidate.match?.sourceName
              ?? CANDIDATE_LABEL[candidate.kind]
              ?? candidate.kind}
          </p>
          {candidate.match && candidate.match.matchedName !== candidate.match.sourceName && (
            <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              read as “{candidate.match.sourceName}”
              {candidate.match.id && ` · matched at ${(candidate.match.confidence * 100).toFixed(0)}%`}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button" onClick={onAccept} disabled={!committable}
            aria-pressed={candidate.state === 'accepted'}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] disabled:opacity-40"
            style={{
              background: candidate.state === 'accepted' ? 'var(--status-good)' : 'var(--surface-2)',
              color: candidate.state === 'accepted' ? '#fff' : 'var(--text-secondary)',
            }}
          >
            <Check size={12} aria-hidden /> Accept
          </button>
          <button
            type="button" onClick={onReject}
            aria-pressed={candidate.state === 'rejected'}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]"
            style={{
              background: candidate.state === 'rejected' ? 'var(--border-strong)' : 'var(--surface-2)',
              color: 'var(--text-secondary)',
            }}
          >
            <X size={12} aria-hidden /> Skip
          </button>
        </div>
      </div>

      <dl className="m-0 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {primary.map(([name, value]) => (
          <div key={name}>
            <dt className="m-0 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              {fieldLabel(name)}
            </dt>
            <dd className="m-0 tabular" style={{ color: 'var(--text-primary)' }}>
              {formatValue(value.value, name)}
              {value.locator && (
                <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {value.locator}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {candidate.match && !candidate.match.id && candidate.match.alternatives.length > 0 && (
        <div className="mt-2">
          <p className="m-0 mb-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Closest matches — pick one rather than searching:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {candidate.match.alternatives.map((alternative) => (
              <button
                key={alternative.id}
                type="button"
                onClick={() => onChooseMatch(alternative.id, alternative.name)}
                className="rounded px-2 py-1 text-[11px]"
                style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
              >
                {alternative.name}
                <span className="ml-1.5" style={{ color: 'var(--text-muted)' }}>
                  {(alternative.score * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {candidate.issues.length > 0 && (
        <ul className="mt-2 mb-0 flex list-none flex-col gap-1 p-0 text-[11px]">
          {candidate.issues.map((issue, index) => (
            <li
              key={`${issue.message}-${index}`}
              className="flex items-start gap-1.5"
              style={{ color: issue.severity === 'error' ? 'var(--status-critical)' : 'var(--status-warning)' }}
            >
              {issue.severity === 'error'
                ? <XCircle size={12} className="mt-px shrink-0" aria-hidden />
                : <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Field names are stored camelCase; a reviewer should not have to read that. */
/** What a candidate with no matched entity is called. */
const CANDIDATE_LABEL: Record<string, string> = {
  'fx-rate': 'Exchange rate declared in the pack',
  'balance-sheet': 'Vehicle balance sheet',
  'position-valuation': 'Holding valuation',
  cashflow: 'Cash movement',
  position: 'New holding',
  'asset-valuation': 'Underlying asset valuation',
};

const FIELD_LABEL: Record<string, string> = {
  nav: 'NAV',
  drawnCumulative: 'Drawn to date',
  distributedCumulative: 'Distributed to date',
  recallableCumulative: 'Recallable to date',
  affectsCommitment: 'Affects commitment',
  currentLiabilities: 'Current liabilities',
  accruedExpenses: 'Accrued expenses',
  otherAssets: 'Other assets',
  base: 'From',
  quote: 'To',
  rate: 'Rate',
  kind: 'Basis',
};

function fieldLabel(name: string): string {
  if (FIELD_LABEL[name]) return FIELD_LABEL[name];
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(value: string | number | boolean | null, name?: string): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    // A rate rounded to two places is a different rate. Everything else here
    // is an amount in thousands, where two places is already more than anyone
    // reads.
    const digits = name === 'rate' ? 6 : 2;
    return value.toLocaleString('en-GB', { maximumFractionDigits: digits });
  }
  return value;
}

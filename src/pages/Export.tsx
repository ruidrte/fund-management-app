/**
 * Historical export.
 *
 * The two questions this screen answers are "give me this quarter" and "give me
 * everything since inception". Both produce the raw facts, not the presentation
 * — with `recorded_at` on every row, because an extract that cannot reproduce a
 * past quarter is useless for the audit it was usually requested for.
 */

import { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, FileArchive } from 'lucide-react';
import type { QuarterView } from '../engine';
import { formatPeriod, sortPeriods, type PeriodId } from '../domain/period';
import { useScope } from '../context/ScopeContext';
import { useCan } from '../context/AuthContext';
import { Card } from '../components/common/Card';
import { DataTable } from '../components/common/DataTable';
import { StatusPill } from '../components/common/Badges';
import { formatTimestamp } from '../components/common/format';
import { buildExtract, type ExtractWindow } from '../export/extract';
import { toCsvBundle, toXlsx, download } from '../export/serialise';

type WindowKind = 'since-inception' | 'period' | 'range';

export function Export({ view }: { view: QuarterView }) {
  const { dataset, clientId, vehicleId, periods, knowledgeDate, currency, sourceLabel } = useScope();
  const allowed = useCan('export', { clientId, vehicleId });

  const ascending = useMemo(() => sortPeriods(periods, 'asc'), [periods]);
  const [kind, setKind] = useState<WindowKind>('since-inception');
  const [from, setFrom] = useState<PeriodId>(ascending[0] ?? view.period);
  const [includeDerived, setIncludeDerived] = useState(true);
  const [busy, setBusy] = useState(false);

  const window: ExtractWindow = useMemo(() => {
    if (kind === 'period') return { kind: 'period', period: view.period };
    if (kind === 'range') return { kind: 'range', from, period: view.period };
    return { kind: 'since-inception', period: view.period };
  }, [kind, from, view.period]);

  const extract = useMemo(() => {
    if (!dataset) return undefined;
    return buildExtract({
      dataset, window, vehicleId, knowledgeDate,
      presentationCurrency: currency, includeDerived,
    });
  }, [dataset, window, vehicleId, knowledgeDate, currency, includeDerived]);

  const emit = (format: 'xlsx' | 'csv') => {
    if (!extract || !allowed.allowed) return;
    setBusy(true);
    try {
      if (format === 'xlsx') {
        download(
          toXlsx(extract),
          `${extract.filename}.xlsx`,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      } else {
        download(toCsvBundle(extract), `${extract.filename}.zip`, 'application/zip');
      }
    } finally {
      setBusy(false);
    }
  };

  const totalRows = extract?.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Historical extract"
        subtitle={`${view.vehicles[0]?.name ?? 'All vehicles'} · ${extract?.periods.length ?? 0} quarter(s) · ${totalRows.toLocaleString('en-GB')} rows`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button" onClick={() => emit('csv')} disabled={busy || !extract || !allowed.allowed}
              title={allowed.reason}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:opacity-50"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <FileArchive size={13} aria-hidden /> CSV bundle
            </button>
            <button
              type="button" onClick={() => emit('xlsx')} disabled={busy || !extract || !allowed.allowed}
              title={allowed.reason}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--series-1)', color: '#fff' }}
            >
              <FileSpreadsheet size={13} aria-hidden /> Excel workbook
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="export-window" className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}>
              Window
            </label>
            <select
              id="export-window" className="field" value={kind}
              onChange={(event) => setKind(event.target.value as WindowKind)}
            >
              <option value="since-inception">Since inception, through {formatPeriod(view.period)}</option>
              <option value="period">{formatPeriod(view.period)} only</option>
              <option value="range">From a chosen quarter to {formatPeriod(view.period)}</option>
            </select>
          </div>

          {kind === 'range' && (
            <div className="flex flex-col gap-1">
              <label htmlFor="export-from" className="text-[11px] font-medium uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}>
                From
              </label>
              <select
                id="export-from" className="field" value={from}
                onChange={(event) => setFrom(event.target.value)}
              >
                {ascending.map((period) => (
                  <option key={period} value={period}>{formatPeriod(period)}</option>
                ))}
              </select>
            </div>
          )}

          <label className="flex items-center gap-2 pb-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox" checked={includeDerived}
              onChange={(event) => setIncludeDerived(event.target.checked)}
            />
            Include the engine&rsquo;s own figures per quarter
          </label>

          {knowledgeDate && (
            <StatusPill tone="warning">
              As known at {formatTimestamp(knowledgeDate)}
            </StatusPill>
          )}
        </div>

        <p className="mt-3 mb-0 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The extract carries raw observations rather than the rounded figures on the screens, and every
          fact sheet carries <code>recorded_at</code> — when the figure entered the system, as distinct
          from the period it describes. Superseded valuations are included and flagged, so a restatement
          history is recoverable. Amounts are in the units the system stores; cashflows are signed from
          the vehicle&rsquo;s perspective, so money out is negative.
          {knowledgeDate
            ? ' This extract reproduces the position as known at the selected instant; later restatements are excluded.'
            : ''}
        </p>
      </Card>

      {extract && (
        <>
          <Card
            title="What the extract contains"
            subtitle={`${extract.filename}.xlsx or .zip`}
            note="The derived sheets are the engine's own output per quarter, so a reconstruction from the raw sheets can be checked against ours rather than guessed at."
          >
            <DataTable
              rows={extract.sheets}
              rowKey={(sheet) => sheet.name}
              dense
              columns={[
                { key: 'name', header: 'Sheet', render: (sheet) => sheet.name },
                {
                  key: 'rows', header: 'Rows', align: 'right',
                  render: (sheet) => sheet.rows.length.toLocaleString('en-GB'),
                  total: totalRows.toLocaleString('en-GB'),
                },
                { key: 'columns', header: 'Columns', align: 'right', render: (sheet) => sheet.columns.length },
                { key: 'description', header: 'What it is', render: (sheet) => sheet.description },
              ]}
            />
          </Card>

          <Card title="Manifest" subtitle="Travels with the extract, as MANIFEST.txt and as the first sheet">
            <pre
              className="scroll-x m-0 rounded p-3 text-[11px] leading-relaxed"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              {extract.manifest}
            </pre>
          </Card>
        </>
      )}

      <Card title="Two formats, because two different people ask" >
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}>
          <li className="flex items-start gap-2">
            <FileArchive size={14} className="mt-0.5 shrink-0" aria-hidden style={{ color: 'var(--series-1)' }} />
            <span>
              <strong>CSV bundle</strong> — one file per table plus the manifest, zipped. Canonical and
              lossless; what you hand to whoever is loading it into another system.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <FileSpreadsheet size={14} className="mt-0.5 shrink-0" aria-hidden style={{ color: 'var(--series-1)' }} />
            <span>
              <strong>Excel workbook</strong> — one sheet per table, header row frozen. What a person opens.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Download size={14} className="mt-0.5 shrink-0" aria-hidden style={{ color: 'var(--text-muted)' }} />
            <span>
              Text beginning <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> is prefixed with
              an apostrophe in both formats. Fund names come from documents this system did not write, and a
              spreadsheet executes such a cell as a formula on open.
            </span>
          </li>
        </ul>
        <p className="mt-3 mb-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Generated in the browser from {sourceLabel.toLowerCase()}; nothing is uploaded anywhere to produce it.
        </p>
      </Card>
    </div>
  );
}

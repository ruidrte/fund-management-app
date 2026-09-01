/**
 * Report generation.
 *
 * A layout is picked, previewed inline, and downloaded as one self-contained
 * HTML file. The preview is the same renderer that produces the file, so what
 * is reviewed on screen is exactly what gets sent.
 */

import { useMemo, useState } from 'react';
import { Download, Eye, Printer, Settings2 } from 'lucide-react';
import type { QuarterView } from '../engine';
import { Card } from '../components/common/Card';
import { StatusPill } from '../components/common/Badges';
import { layoutsFor, type ReportLayout } from '../reports/layouts';
import { LayoutEditor } from '../components/reports/LayoutEditor';
import { useReportingProfile } from '../context/filing';
import { renderReport } from '../reports/render';
import { useScope } from '../context/ScopeContext';
import { formatPeriod } from '../domain/period';
import { formatTimestamp } from '../components/common/format';

export function Reports({ view }: { view: QuarterView }) {
  const { sourceLabel } = useScope();
  const { profile } = useReportingProfile();

  const layouts = useMemo(() => layoutsFor(view, profile), [view, profile]);
  // The client's own default leads, because it is the one that goes out.
  const [layoutId, setLayoutId] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [editing, setEditing] = useState(false);

  const layout = layouts.find((l) => l.id === layoutId)
    ?? layouts.find((l) => l.id === profile.defaultLayoutId)
    ?? layouts[0];

  const html = useMemo(
    () => (layout
      ? renderReport({ layout, view, sourceLabel, branding: profile.branding })
      : ''),
    [layout, view, sourceLabel, profile.branding],
  );

  const filename = useMemo(() => {
    const vehicle = view.vehicles[0]?.shortName ?? 'consolidated';
    const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${slug(vehicle)}_${view.period}_${slug(layout?.id ?? 'report')}.html`;
  }, [view, layout]);

  const download = () => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openForPrint = () => {
    const window_ = window.open('', '_blank');
    if (!window_) return;
    window_.document.write(html);
    window_.document.close();
  };

  if (!layout) {
    return <Card title="Reports"><p className="m-0 text-xs">No layout applies to this scope.</p></Card>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Report layouts"
        subtitle={`${formatPeriod(view.period)} · ${view.vehicles[0]?.name ?? 'Consolidated'} · ${view.currency}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={view.isFinal ? 'good' : view.gross.coverage.publishable ? 'serious' : 'critical'}>
              {view.isFinal ? 'Final' : view.gross.coverage.publishable ? 'Draft' : 'Not publishable'}
            </StatusPill>
            <button
              type="button" onClick={() => setEditing((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <Settings2 size={13} aria-hidden /> {editing ? 'Close' : 'Layouts for this client'}
            </button>
            <button
              type="button" onClick={() => setPreviewing((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <Eye size={13} aria-hidden /> {previewing ? 'Hide preview' : 'Preview'}
            </button>
            <button
              type="button" onClick={openForPrint}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <Printer size={13} aria-hidden /> Print
            </button>
            <button
              type="button" onClick={download}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium"
              style={{ background: 'var(--series-1)', color: '#fff' }}
            >
              <Download size={13} aria-hidden /> Download
            </button>
          </div>
        }
      >
        <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
          {layouts.map((option) => (
            <li key={option.id}>
              <LayoutOption
                layout={option}
                selected={option.id === layout.id}
                onSelect={() => setLayoutId(option.id)}
              />
            </li>
          ))}
        </ul>

        <p className="mt-3 mb-0 text-xs" style={{ color: 'var(--text-muted)' }}>
          Output is a single self-contained HTML file — inline styles, hand-drawn SVG, no external
          requests. It opens from a local disk or an email attachment and will keep doing so.
          {view.scope.knowledgeDate &&
            ` This one reproduces the position as known at ${formatTimestamp(view.scope.knowledgeDate)}; later restatements are excluded.`}
        </p>

        {!view.gross.coverage.publishable && (
          <p className="mt-2 mb-0 text-xs font-medium" style={{ color: 'var(--status-critical)' }}>
            Coverage is below the floor set for this vehicle. The report can be generated for review,
            and says on its cover that it must not be issued.
          </p>
        )}
      </Card>

      {editing && (
        <LayoutEditor
          view={view}
          selectedId={layout.id}
          onSelect={setLayoutId}
          onClose={() => setEditing(false)}
        />
      )}

      {previewing && (
        <Card title="Preview" subtitle={filename}>
          <iframe
            title="Report preview"
            srcDoc={html}
            className="h-[70vh] w-full rounded"
            style={{ border: '1px solid var(--border)', background: '#fff' }}
            sandbox=""
          />
        </Card>
      )}
    </div>
  );
}

function LayoutOption({
  layout, selected, onSelect,
}: { layout: ReportLayout; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="w-full rounded p-3 text-left transition-colors"
      style={{
        border: `1px solid ${selected ? 'var(--series-1)' : 'var(--border)'}`,
        background: selected ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <span className="block text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        {layout.name}
      </span>
      <span className="mt-1 block text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {layout.description}
      </span>
      <span className="mt-1.5 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {layout.sections.length} sections
        {layout.appliesTo.length > 0 && ` · ${layout.appliesTo.join(', ')} only`}
      </span>
    </button>
  );
}

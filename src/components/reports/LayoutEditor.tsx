/**
 * The client's own report.
 *
 * Every client's pack looks and reads differently — a different house on the
 * cover, a different order, different prose, a disclaimer their legal team
 * wrote — while the figures behind them come from the same engine. So a layout
 * is data belonging to the client, kept in the client's own book, and this is
 * where it is edited.
 *
 * Deliberately not a page designer. Sections are chosen and ordered, and each
 * carries a heading and an introduction; what a section *contains* is the
 * engine's business, and a report that let its author reshape a bridge would
 * stop being a report of the same thing.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, Copy, Plus, Save, Trash2, X,
} from 'lucide-react';
import type { QuarterView } from '../../engine';
import { Card } from '../common/Card';
import { StatusPill } from '../common/Badges';
import { useReportingProfile } from '../../context/filing';
import { useScope } from '../../context/ScopeContext';
import { LAYOUTS } from '../../reports/layouts';
import {
  SECTION_LABEL, SECTION_ORDER,
  type ReportLayout, type ReportingProfile, type Section, type SectionId,
} from '../../domain/report';

export function LayoutEditor({
  view, selectedId, onSelect, onClose,
}: {
  view: QuarterView;
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { clients, clientId } = useScope();
  const { profile, save, canSave, reason, destination } = useReportingProfile();

  const [draft, setDraft] = useState<ReportingProfile>(profile);
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [failure, setFailure] = useState<string>();

  // A different client is a different profile; keeping the draft would edit
  // one client's report with another's changes.
  useEffect(() => {
    setDraft(profile);
    setEditingId(undefined);
  }, [profile, clientId]);

  const client = clients.find((c) => c.id === clientId);
  const editing = draft.layouts.find((l) => l.id === editingId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);

  const update = (next: Partial<ReportingProfile>) => setDraft((current) => ({ ...current, ...next }));

  const replace = (layout: ReportLayout) => update({
    layouts: draft.layouts.map((l) => (l.id === layout.id ? layout : l)),
  });

  const addFrom = (base: ReportLayout) => {
    const id = uniqueId(base.id === 'blank' ? `${clientId}-report` : `${clientId}-${base.id}`, draft.layouts);
    const layout: ReportLayout = {
      ...base,
      id,
      clientId,
      name: base.id === 'blank'
        ? `${client?.shortName ?? 'Client'} report`
        : `${client?.shortName ?? 'Client'} — ${base.name}`,
      sections: base.sections.map((section) => ({ ...section })),
    };
    update({
      layouts: [...draft.layouts, layout],
      defaultLayoutId: draft.defaultLayoutId ?? id,
    });
    setEditingId(id);
    onSelect(id);
  };

  const remove = (id: string) => {
    update({
      layouts: draft.layouts.filter((l) => l.id !== id),
      defaultLayoutId: draft.defaultLayoutId === id ? undefined : draft.defaultLayoutId,
    });
    if (editingId === id) setEditingId(undefined);
  };

  const commit = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await save(draft);
      setSaved(`Saved to ${destination ?? 'the book'}.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`Report layouts for ${client?.name ?? 'this client'}`}
      subtitle="Kept in this client's own book, beside its figures"
      actions={
        <div className="flex items-center gap-2">
          {dirty && <StatusPill tone="warning">Unsaved</StatusPill>}
          <button
            type="button" onClick={commit} disabled={!canSave || !dirty || busy}
            title={reason}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            <Save size={13} aria-hidden /> Save
          </button>
          <button
            type="button" onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </div>
      }
      note="The engine is the same for every product; only the pack differs. What a section contains is
            not editable here — a report whose author could reshape a bridge would stop being a report
            of the same thing."
    >
      {!canSave && (
        <p className="m-0 mb-3 flex items-start gap-2 text-xs" style={{ color: 'var(--status-warning)' }}>
          <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
          {reason} You can still build a layout here and preview it; it will not survive a reload.
        </p>
      )}

      <Branding profile={draft} onChange={update} />

      <h4 className="mt-4 mb-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
        This client&rsquo;s layouts
      </h4>

      {draft.layouts.length === 0 && (
        <p className="m-0 mb-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          None yet. Start from one of the built-in packs below and change it, or from a blank one.
        </p>
      )}

      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {draft.layouts.map((option) => (
          <li key={option.id} className="flex flex-wrap items-center gap-2 rounded px-2.5 py-2"
            style={{ background: 'var(--surface-2)' }}>
            <button
              type="button"
              onClick={() => { setEditingId(option.id === editingId ? undefined : option.id); onSelect(option.id); }}
              className="min-w-0 flex-1 text-left text-xs"
              style={{ color: 'var(--text-primary)' }}
            >
              <span className="font-medium">{option.name}</span>
              <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                {option.sections.length} section(s)
                {option.id === selectedId ? ' · selected' : ''}
              </span>
            </button>

            <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="radio" name="default-layout"
                checked={draft.defaultLayoutId === option.id}
                onChange={() => update({ defaultLayoutId: option.id })}
              />
              Default
            </label>
            <button
              type="button" onClick={() => remove(option.id)}
              className="rounded p-1" title="Remove this layout"
              style={{ color: 'var(--status-critical)' }}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <SectionEditor layout={editing} onChange={replace} view={view} />
      )}

      <h4 className="mt-4 mb-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
        Start from
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {[BLANK, ...LAYOUTS].map((base) => (
          <button
            key={base.id}
            type="button"
            onClick={() => addFrom(base)}
            title={base.description}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            {base.id === 'blank' ? <Plus size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {base.name}
          </button>
        ))}
      </div>

      {(saved || failure) && (
        <p className="mt-3 mb-0 flex items-start gap-1.5 text-xs"
          style={{ color: failure ? 'var(--status-critical)' : 'var(--status-good)' }}>
          {failure ? <X size={13} className="mt-px" aria-hidden /> : <Check size={13} className="mt-px" aria-hidden />}
          {failure ?? saved}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function Branding({
  profile, onChange,
}: { profile: ReportingProfile; onChange: (next: Partial<ReportingProfile>) => void }) {
  const branding = profile.branding ?? {};
  const set = (patch: Partial<typeof branding>) =>
    onChange({ branding: { ...branding, ...patch } });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <Field label="House on the cover">
          <input
            className="field" placeholder="e.g. EBG Investment Solutions"
            value={branding.house ?? ''}
            onChange={(event) => set({ house: event.target.value })}
          />
        </Field>
        <Field label="Accent">
          <div className="flex items-center gap-2">
            <input
              type="color" className="h-8 w-12 rounded border-0 bg-transparent p-0"
              value={/^#[0-9a-fA-F]{6}$/.test(branding.accent ?? '') ? branding.accent : '#52514e'}
              onChange={(event) => set({ accent: event.target.value })}
            />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Cover rule and eyebrow only — never a chart
            </span>
          </div>
        </Field>
      </div>

      <Field label="Note under the cover title">
        <input
          className="field" placeholder="Optional"
          value={branding.coverNote ?? ''}
          onChange={(event) => set({ coverNote: event.target.value })}
        />
      </Field>

      <Field label="Standing footer text">
        <textarea
          className="field" rows={2} placeholder="A disclaimer, usually"
          value={branding.footerNote ?? ''}
          onChange={(event) => set({ footerNote: event.target.value })}
        />
      </Field>
    </div>
  );
}

function SectionEditor({
  layout, onChange, view,
}: { layout: ReportLayout; onChange: (next: ReportLayout) => void; view: QuarterView }) {
  const present = new Set(layout.sections.map((s) => s.id));

  const setSections = (sections: Section[]) => onChange({ ...layout, sections });

  const move = (index: number, delta: number) => {
    const next = [...layout.sections];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSections(next);
  };

  const toggle = (id: SectionId) => {
    setSections(present.has(id)
      ? layout.sections.filter((s) => s.id !== id)
      : [...layout.sections, { id }]);
  };

  return (
    <div className="mt-3 rounded p-3" style={{ background: 'var(--surface-2)' }}>
      <div className="flex flex-wrap gap-3">
        <Field label="Layout name">
          <input
            className="field" value={layout.name}
            onChange={(event) => onChange({ ...layout, name: event.target.value })}
          />
        </Field>
        <Field label="What it is for">
          <input
            className="field" value={layout.description}
            onChange={(event) => onChange({ ...layout, description: event.target.value })}
          />
        </Field>
      </div>

      <p className="mt-3 mb-1.5 text-[11px] font-medium uppercase tracking-wide"
        style={{ color: 'var(--text-muted)' }}>
        Sections, in order
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {layout.sections.map((section, index) => (
          <li key={`${section.id}-${index}`} className="rounded p-2"
            style={{ background: 'var(--surface-1)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                {SECTION_LABEL[section.id]}
              </span>
              <button type="button" onClick={() => move(index, -1)} className="rounded p-1"
                title="Move up" style={{ color: 'var(--text-secondary)' }}>
                <ArrowUp size={12} aria-hidden />
              </button>
              <button type="button" onClick={() => move(index, 1)} className="rounded p-1"
                title="Move down" style={{ color: 'var(--text-secondary)' }}>
                <ArrowDown size={12} aria-hidden />
              </button>
              <button type="button" onClick={() => toggle(section.id)} className="rounded p-1"
                title="Remove" style={{ color: 'var(--status-critical)' }}>
                <Trash2 size={12} aria-hidden />
              </button>
            </div>
            {section.id !== 'cover' && (
              <div className="mt-1.5 flex flex-wrap gap-2">
                <input
                  className="field flex-1 text-xs" placeholder="Heading (blank uses none)"
                  value={section.title ?? ''}
                  onChange={(event) => setSections(layout.sections.map((s, i) =>
                    (i === index ? { ...s, title: event.target.value || undefined } : s)))}
                />
                <input
                  className="field flex-1 text-xs" placeholder="Introduction (optional)"
                  value={section.intro ?? ''}
                  onChange={(event) => setSections(layout.sections.map((s, i) =>
                    (i === index ? { ...s, intro: event.target.value || undefined } : s)))}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 mb-1.5 text-[11px] font-medium uppercase tracking-wide"
        style={{ color: 'var(--text-muted)' }}>
        Add a section
      </p>
      <div className="flex flex-wrap gap-1.5">
        {SECTION_ORDER.filter((id) => !present.has(id)).map((id) => (
          <button
            key={id} type="button" onClick={() => toggle(id)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]"
            style={{ background: 'var(--surface-1)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            <Plus size={11} aria-hidden /> {SECTION_LABEL[id]}
          </button>
        ))}
      </div>

      {layout.sections.some((s) => s.id === 'capital-accounts') && view.net.restricted && (
        <p className="mt-2 mb-0 text-[11px]" style={{ color: 'var(--status-warning)' }}>
          This layout includes capital accounts, and the signed-in role sees only one. The section will
          render what the role may see and nothing else.
        </p>
      )}
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

/** An empty layout to start from — a cover and nothing else assumed. */
const BLANK: ReportLayout = {
  id: 'blank',
  name: 'A blank layout',
  description: 'Cover only, to build up from',
  appliesTo: [],
  sections: [{ id: 'cover' }],
};

function uniqueId(base: string, existing: ReportLayout[]): string {
  const taken = new Set(existing.map((l) => l.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

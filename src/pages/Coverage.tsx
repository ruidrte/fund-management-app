/**
 * What is loaded.
 *
 * A map of the book: every quarter across, every kind of data down, and the
 * state of each cell. It exists because "the dashboard is empty" has at least
 * four different causes — nothing loaded, the manager has not reported, the
 * administrator's pack has not arrived, only the investor side came in — and
 * they need four different phone calls.
 *
 * Filed rows come from documents; derived rows are what the engine can build
 * from them. Keeping the two apart is the point: a gap in the top half is
 * somebody else's to fix, a gap in the bottom half is explained by the top.
 */

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { takeInventory, type InventoryCell, type Presence } from '../engine/inventory';
import { useScope } from '../context/ScopeContext';
import { formatPeriod, type PeriodId } from '../domain/period';
import { Card } from '../components/common/Card';

/** How many quarters fit before the grid stops being readable. */
const WINDOW = 14;

const TONE: Record<Presence, { fill: string; text: string; label: string }> = {
  reported: { fill: 'var(--status-good)', text: '#fff', label: 'Filed for the quarter' },
  partial: { fill: 'var(--status-warning)', text: '#1a1a18', label: 'Partly filed' },
  carried: { fill: 'var(--border-strong)', text: 'var(--text-primary)', label: 'Carried from earlier' },
  quiet: { fill: 'var(--surface-2)', text: 'var(--text-muted)', label: 'No movement — complete' },
  none: { fill: 'transparent', text: 'var(--text-muted)', label: 'Nothing' },
};

export function Coverage() {
  const { dataset, clientId, vehicleId, vehicles, knowledgeDate } = useScope();

  const inventory = useMemo(
    () => (dataset ? takeInventory(dataset, { clientId, vehicleId, knowledgeDate }) : undefined),
    [dataset, clientId, vehicleId, knowledgeDate],
  );

  // Newest quarters first is what a reader wants; the window slides back.
  const [offset, setOffset] = useState(0);

  if (!inventory || inventory.periods.length === 0) {
    return (
      <Card
        title="What is loaded"
        subtitle={vehicleId ? undefined : 'Every product of this client'}
      >
        <p className="m-0 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Nothing has been filed for this scope, so there is no quarter to describe. Load a portfolio
          database or a document under Data intake.
        </p>
      </Card>
    );
  }

  const total = inventory.periods.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - WINDOW);
  const shown = inventory.periods.slice(start, end);

  const product = vehicles.find((v) => v.id === vehicleId);
  const filed = inventory.rows.filter((row) => row.tier === 'filed');
  const derived = inventory.rows.filter((row) => row.tier === 'derived');

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="What is loaded"
        subtitle={product
          ? `${product.name} — ${formatPeriod(inventory.first!)} to ${formatPeriod(inventory.last!)}`
          : `Every product of this client — ${formatPeriod(inventory.first!)} to ${formatPeriod(inventory.last!)}`}
        actions={
          <div className="flex items-center gap-1">
            <Step
              icon={ChevronLeft} label="Earlier quarters"
              disabled={start === 0}
              onClick={() => setOffset((n) => Math.min(total - WINDOW, n + WINDOW))}
            />
            <span className="px-1 text-[11px] tabular" style={{ color: 'var(--text-muted)' }}>
              {shown.length > 0 && `${formatPeriod(shown[0])} — ${formatPeriod(shown[shown.length - 1])}`}
            </span>
            <Step
              icon={ChevronRight} label="Later quarters"
              disabled={offset === 0}
              onClick={() => setOffset((n) => Math.max(0, n - WINDOW))}
            />
          </div>
        }
        note="A cell says what is there, not whether it is right — the identity checks under Data
              quality do that. Hover any cell for the count behind it."
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 p-1.5 text-left text-[11px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)', background: 'var(--surface-1)' }}>
                  Kind
                </th>
                {shown.map((period) => (
                  <th key={period} className="p-1 text-center text-[11px] font-medium"
                    style={{ color: 'var(--text-muted)' }}>
                    {formatPeriod(period).replace(' 20', ' ’')}
                  </th>
                ))}
              </tr>
            </thead>

            <Section label="Filed — somebody sent it" rows={filed} shown={shown} />
            <Section label="Derived — the engine builds it" rows={derived} shown={shown} />
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {(Object.keys(TONE) as Presence[]).map((state) => (
            <span key={state} className="flex items-center gap-1.5 text-[11px]"
              style={{ color: 'var(--text-secondary)' }}>
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{
                  background: TONE[state].fill,
                  border: state === 'none' || state === 'quiet'
                    ? '1px dashed var(--border-strong)' : 'none',
                }}
                aria-hidden
              />
              {TONE[state].label}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Section({
  label, rows, shown,
}: {
  label: string;
  rows: ReturnType<typeof takeInventory>['rows'];
  shown: PeriodId[];
}) {
  return (
    <tbody>
      <tr>
        <td colSpan={shown.length + 1} className="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-muted)' }}>
          {label}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
          <th scope="row"
            className="sticky left-0 z-10 max-w-[14rem] p-1.5 text-left align-top font-normal"
            style={{ background: 'var(--surface-1)' }}>
            <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {row.label}
            </span>
            <span className="block text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              {row.description}
            </span>
          </th>
          {shown.map((period) => {
            const cell = row.cells.find((c) => c.period === period);
            return <Cell key={period} cell={cell} label={row.label} counted={row.counted} />;
          })}
        </tr>
      ))}
    </tbody>
  );
}

function Cell({
  cell, label, counted,
}: { cell?: InventoryCell; label: string; counted: boolean }) {
  const state = cell?.state ?? 'none';
  const tone = TONE[state];
  const title = cell
    ? `${label} · ${formatPeriod(cell.period)}\n${cell.note}`
    : undefined;

  return (
    <td className="p-1 text-center align-middle">
      <span
        title={title}
        aria-label={title}
        className="inline-flex h-6 w-full min-w-[2.25rem] items-center justify-center rounded-sm text-[10px] font-medium tabular"
        style={{
          background: tone.fill,
          color: tone.text,
          border: state === 'none' ? '1px dashed var(--border)' : 'none',
          boxShadow: state === 'quiet' ? 'inset 0 0 0 1px var(--border)' : undefined,
        }}
      >
        {cell?.of !== undefined && cell.of > 0
          ? `${cell.count}/${cell.of}`
          : state === 'none' ? '·'
            : state === 'quiet' ? '–'
              : counted && cell && cell.count > 0 ? cell.count : ''}
      </span>
    </td>
  );
}

function Step({
  icon: Icon, label, disabled, onClick,
}: {
  icon: typeof ChevronLeft;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="rounded p-1 disabled:opacity-30"
      style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
    >
      <Icon size={14} aria-hidden />
    </button>
  );
}

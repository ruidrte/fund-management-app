/**
 * The scope bar.
 *
 * Six selections define every figure on screen. The two that change most often —
 * which client and which product — are tabs, because there are few of each and
 * a person moves between them constantly; the rest are dropdowns.
 *
 * The client row appears only for someone who can reach more than one client. A
 * client's own team sees their products and no indication that other clients
 * exist, which is what their membership already entitles them to; showing a
 * disabled row of other people's names would leak the client list.
 */

import { useMemo } from 'react';
import { CalendarDays, Boxes, Coins, History } from 'lucide-react';
import { formatPeriod } from '../../domain/period';
import { useScope, usePositions } from '../../context/ScopeContext';
import { formatTimestamp } from '../common/format';

export function ScopeBar() {
  const {
    clients, clientId, setClientId,
    vehicles, vehicleId, setVehicleId,
    positionId, setPositionId,
    periods, period, setPeriod,
    knowledgeDate, setKnowledgeDate, knowledgeDates,
    currency, setCurrency, currencies,
  } = useScope();

  const positions = usePositions();
  const viewingPast = knowledgeDate !== undefined;
  const showClients = clients.length > 1;

  // The currency the product itself reports in — the basis, set with the
  // product and kept in the book. Undefined on a consolidated view across
  // products that do not share one, where there is no single basis to name.
  const selected = vehicles.filter((v) => !vehicleId || v.id === vehicleId);
  const bases = new Set(selected.map((v) => v.currency));
  const reportingCurrency = bases.size === 1 ? [...bases][0] : undefined;
  const translating = currency !== undefined && currency !== reportingCurrency;

  const vehicleTabs = useMemo(
    () => vehicles.map((vehicle) => ({
      id: vehicle.id,
      label: vehicle.shortName,
      title: `${vehicle.name} · ${vehicle.kind === 'fund-of-funds' ? 'Fund of funds' : 'Direct fund'} · ${vehicle.currency}`,
      kind: vehicle.kind,
    })),
    [vehicles],
  );

  return (
    <div style={{ background: 'var(--surface-1)', borderBottom: '1px solid var(--border)' }}>
      {showClients && (
        <TabRow
          label="Client"
          tabs={clients.map((client) => ({
            id: client.id,
            label: client.shortName,
            title: client.name,
          }))}
          selected={clientId}
          onSelect={setClientId}
          emphasis
        />
      )}

      {vehicleTabs.length > 0 && (
        <TabRow
          label="Product"
          tabs={[
            // Consolidation is a product view of its own, not the absence of one.
            ...(vehicleTabs.length > 1
              ? [{ id: '', label: 'All', title: `All ${vehicleTabs.length} products, consolidated` }]
              : []),
            ...vehicleTabs,
          ]}
          selected={vehicleId ?? ''}
          onSelect={(id) => setVehicleId(id || undefined)}
        />
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-6 py-3">
        <Selector
          icon={<Boxes size={13} aria-hidden />}
          label="Holding"
          value={positionId ?? ''}
          onChange={(value) => setPositionId(value || undefined)}
        >
          <option value="">Whole portfolio</option>
          {positions.map((position) => (
            <option key={position.id} value={position.id}>{position.name}</option>
          ))}
        </Selector>

        <Selector
          icon={<CalendarDays size={13} aria-hidden />}
          label="Quarter"
          value={period}
          onChange={setPeriod}
        >
          {periods.map((id) => (
            <option key={id} value={id}>{formatPeriod(id)}</option>
          ))}
        </Selector>

        <Selector
          icon={<History size={13} aria-hidden />}
          label="As at"
          value={knowledgeDate ?? ''}
          onChange={(value) => setKnowledgeDate(value || undefined)}
          highlighted={viewingPast}
        >
          <option value="">Today — everything known</option>
          {knowledgeDates.map((date) => (
            <option key={date} value={date}>{formatTimestamp(date)}</option>
          ))}
        </Selector>

        <Selector
          icon={<Coins size={13} aria-hidden />}
          label="Currency"
          value={currency ?? ''}
          onChange={(value) => setCurrency(value || undefined)}
          // A currency other than the product's own restates every figure on
          // screen away from the basis the fund actually reports on. That is a
          // simulation, and it is highlighted like the "as at" selector for the
          // same reason: nobody should copy a number off a translated screen
          // believing it is the published one.
          highlighted={translating}
        >
          <option value="">
            {reportingCurrency ? `${reportingCurrency} — as reported` : 'As reported'}
          </option>
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}{code === reportingCurrency ? '' : ' — translated'}
            </option>
          ))}
        </Selector>
      </div>
    </div>
  );
}

interface Tab {
  id: string;
  label: string;
  title?: string;
}

/**
 * A row of tabs.
 *
 * Selection is carried by weight and an underline as well as colour, and the
 * row is a real tablist so arrow keys move between tabs — with this many of
 * them, reaching for the mouse each time is the difference between a tool and a
 * form.
 */
function TabRow({
  label, tabs, selected, onSelect, emphasis = false,
}: {
  label: string;
  tabs: Tab[];
  selected: string;
  onSelect: (id: string) => void;
  emphasis?: boolean;
}) {
  const move = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + tabs.length) % tabs.length;
    onSelect(tabs[next].id);
    // Move focus with the selection, or the next arrow press starts over.
    const row = event.currentTarget.parentElement;
    (row?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <div
      className="flex items-center gap-3 px-6"
      style={{
        borderBottom: '1px solid var(--border)',
        background: emphasis ? 'var(--surface-2)' : 'transparent',
      }}
    >
      <span
        className="shrink-0 text-[10px] font-medium uppercase tracking-wide"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>

      <div className="scroll-x flex" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const active = tab.id === selected;
          return (
            <button
              key={tab.id || '__all'}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.title}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => move(event, index)}
              className="whitespace-nowrap px-3 py-2 text-xs transition-colors"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: active ? 600 : 400,
                // The underline is what carries selection where colour cannot.
                boxShadow: active ? 'inset 0 -2px 0 0 var(--series-1)' : 'none',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Selector({
  icon, label, value, onChange, children, highlighted = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  highlighted?: boolean;
}) {
  const id = `scope-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide"
        style={{ color: 'var(--text-muted)' }}
      >
        {icon}
        {label}
      </label>
      <select
        id={id}
        className="field max-w-[15rem]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={highlighted ? { borderColor: 'var(--status-warning)', borderWidth: 2 } : undefined}
      >
        {children}
      </select>
    </div>
  );
}

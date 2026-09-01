/**
 * The scope bar.
 *
 * Client, vehicle, holding, quarter, as-at date and presentation currency —
 * the six selections that define every figure on screen, in one row, always
 * visible. A user who cannot see what they are looking at will eventually
 * mistake one quarter's report for another's.
 */

import { History, Layers, Building2, Coins, CalendarDays, Boxes } from 'lucide-react';
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

  return (
    <div
      className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b px-6 py-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <Selector icon={<Building2 size={13} aria-hidden />} label="Client" value={clientId} onChange={setClientId}>
        {clients.map((client) => (
          <option key={client.id} value={client.id}>{client.name}</option>
        ))}
      </Selector>

      <Selector
        icon={<Layers size={13} aria-hidden />}
        label="Vehicle"
        value={vehicleId ?? ''}
        onChange={(value) => setVehicleId(value || undefined)}
      >
        <option value="">All vehicles (consolidated)</option>
        {vehicles.map((vehicle) => (
          <option key={vehicle.id} value={vehicle.id}>
            {vehicle.name} · {vehicle.kind === 'fund-of-funds' ? 'FoF' : 'Direct'}
          </option>
        ))}
      </Selector>

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
      >
        <option value="">Vehicle currency</option>
        {currencies.map((code) => (
          <option key={code} value={code}>{code}</option>
        ))}
      </Selector>
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

/**
 * The scope every screen reads from.
 *
 * Four selections define what the user is looking at: which client, which
 * vehicle (or all of them), which quarter, and — separately — the date as at
 * which the data is being viewed. Everything else on screen is derived. The
 * analysis is memoised on those selections alone, so changing the quarter
 * recomputes exactly once and no screen holds its own copy of a number.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { analyse, availableKnowledgeDates, availablePeriods, type QuarterView } from '../engine';
import type { ClientSummary } from '../data';
import { useDataSource } from './DataSourceContext';
import { useAuth } from './AuthContext';
import { boundInvestorId, visibleClientIds } from '../auth/permissions';
import { restrictToInvestor } from '../auth/restrict';
import type { CurrencyCode, DataSet, PositionKind, Scope, Vehicle } from '../domain/types';
import { periodForDate, type PeriodId } from '../domain/period';

interface ScopeValue {
  loading: boolean;
  error?: string;
  sourceLabel: string;

  clients: ClientSummary[];
  clientId: string;
  setClientId: (id: string) => void;

  dataset?: DataSet;
  vehicles: Vehicle[];
  /** Undefined means every vehicle of the client, consolidated. */
  vehicleId?: string;
  setVehicleId: (id: string | undefined) => void;

  /** Narrows the portfolio to one holding; undefined means the whole portfolio. */
  positionId?: string;
  setPositionId: (id: string | undefined) => void;

  periods: PeriodId[];
  period: PeriodId;
  setPeriod: (period: PeriodId) => void;

  /** Undefined means "as things stand now". */
  knowledgeDate?: string;
  setKnowledgeDate: (value: string | undefined) => void;
  knowledgeDates: string[];

  currency?: CurrencyCode;
  setCurrency: (value: CurrencyCode | undefined) => void;
  currencies: CurrencyCode[];

  view?: QuarterView;
  refresh: () => void;
}

const ScopeContext = createContext<ScopeValue | undefined>(undefined);

export function ScopeProvider({ children }: { children: ReactNode }) {
  // The source can change while the application is running — connecting a
  // folder puts a book behind the same screens — so it is read from context
  // rather than resolved once.
  const { repository } = useDataSource();
  const { principal } = useAuth();

  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [clientId, setClientIdState] = useState<string>('');
  const [dataset, setDataset] = useState<DataSet>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  const [vehicleId, setVehicleId] = useState<string>();
  const [positionId, setPositionId] = useState<string>();
  const [period, setPeriod] = useState<PeriodId>();
  const [knowledgeDate, setKnowledgeDate] = useState<string>();
  const [currency, setCurrency] = useState<CurrencyCode>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(undefined);
        const list = await repository.listClients();
        if (cancelled) return;
        // The database returns only what the principal may read; this narrows
        // the picker to match, so a client never appears and then opens empty.
        const allowed = visibleClientIds(principal);
        const visible = allowed ? list.filter((c) => allowed.includes(c.id)) : list;
        setClients(visible);
        setClientIdState((current) =>
          (current && visible.some((c) => c.id === current) ? current : visible[0]?.id || ''));
      } catch (cause) {
        if (!cancelled) setError(describe(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repository, principal]);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(undefined);
        const loaded = await repository.loadClient(clientId);
        if (cancelled) return;
        // An investor login must not have other accounts reach the engine at
        // all. Filtering here rather than in a component means no screen, chart
        // or export can reintroduce them by reading the dataset directly.
        setDataset(restrictToInvestor(loaded, boundInvestorId(principal, clientId)));

        // Default to the latest quarter that has any data at all, and to the
        // client's single vehicle when there is only one. A book with no facts
        // yet falls back to the current quarter rather than to nothing —
        // otherwise a new book has no scope, and no way to reach the screen
        // that would load its first document.
        const available = availablePeriods(loaded, { clientId });
        setPeriod((current) => (current && available.includes(current)
          ? current
          : available[0] ?? periodForDate(new Date())));
        setVehicleId((current) => {
          if (current && loaded.vehicles.some((v) => v.id === current)) return current;
          return loaded.vehicles.length === 1 ? loaded.vehicles[0].id : undefined;
        });
        setPositionId(undefined);
      } catch (cause) {
        if (!cancelled) setError(describe(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repository, clientId, reloadToken, principal]);

  const setClientId = useCallback((id: string) => {
    // A new client invalidates every narrower selection; carrying a vehicle id
    // across clients is how cross-tenant leakage starts.
    setClientIdState(id);
    setVehicleId(undefined);
    setPositionId(undefined);
    setKnowledgeDate(undefined);
    setCurrency(undefined);
  }, []);

  const periods = useMemo(() => {
    if (!dataset) return [];
    const available = availablePeriods(dataset, { clientId, vehicleId });
    return available.length > 0 ? available : [periodForDate(new Date())];
  }, [dataset, clientId, vehicleId]);

  const knowledgeDates = useMemo(
    () => (dataset && period ? availableKnowledgeDates(dataset, period) : []),
    [dataset, period],
  );

  const currencies = useMemo(() => {
    if (!dataset) return [];
    const set = new Set<CurrencyCode>([dataset.client.reportingCurrency]);
    for (const vehicle of dataset.vehicles) set.add(vehicle.currency);
    for (const position of dataset.positions) set.add(position.currency);
    return [...set].sort();
  }, [dataset]);

  const view = useMemo(() => {
    if (!dataset || !period) return undefined;
    const scope: Scope = {
      clientId,
      vehicleId,
      positionId,
      period,
      knowledgeDate,
      presentationCurrency: currency,
    };
    try {
      return analyse(dataset, scope);
    } catch (cause) {
      // A scope that cannot be analysed is a reportable condition, not a crash.
      setError(describe(cause));
      return undefined;
    }
  }, [dataset, clientId, vehicleId, positionId, period, knowledgeDate, currency]);

  const value: ScopeValue = {
    loading,
    error,
    sourceLabel: repository.label,
    clients,
    clientId,
    setClientId,
    dataset,
    vehicles: dataset?.vehicles ?? [],
    vehicleId,
    setVehicleId: useCallback((id: string | undefined) => {
      setVehicleId(id);
      setPositionId(undefined);
    }, []),
    positionId,
    setPositionId,
    periods,
    period: period ?? periods[0] ?? '',
    setPeriod: useCallback((next: PeriodId) => setPeriod(next), []),
    knowledgeDate,
    setKnowledgeDate,
    knowledgeDates,
    currency,
    setCurrency,
    currencies,
    view,
    refresh: useCallback(() => setReloadToken((n) => n + 1), []),
  };

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext);
  if (!value) throw new Error('useScope must be used inside a ScopeProvider');
  return value;
}

/** The positions available for the current scope, for the position selector. */
export function usePositions(): Array<{ id: string; name: string; kind: PositionKind }> {
  const { dataset, vehicleId } = useScope();
  return useMemo(() => {
    if (!dataset) return [];
    return dataset.positions
      .filter((p) => !vehicleId || p.vehicleId === vehicleId)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [dataset, vehicleId]);
}

/**
 * Reduces a dataset to one investor's view.
 *
 * The vehicle's own commitment stays whole — an investor is entitled to know
 * the size of the fund they are in — but every other investor and their
 * cashflows are removed. Portfolio flows carry no investor and are kept, since
 * they are the reporting the investor receives.
 */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

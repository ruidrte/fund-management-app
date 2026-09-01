/**
 * Supabase-backed repository.
 *
 * Column names are snake_case in the database and camelCase in the domain, so
 * every table gets an explicit mapper rather than a generic transformer. The
 * explicitness is deliberate: a silently mis-mapped numeric column produces a
 * plausible wrong number, which is the worst failure mode this application has.
 */

import { getSupabase } from '../lib/supabase';
import type { ClientSummary, Repository } from './repository';
import type {
  Asset, AssetValuation, Cashflow, Client, DataSet, EsgMetric, FxRate,
  Investor, Position, PositionValuation, Vehicle, VehicleBalanceSheet,
} from '../domain/types';

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => {
  const parsed = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const opt = <T,>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));

export const supabaseRepository: Repository = {
  label: 'Supabase',

  async listClients(): Promise<ClientSummary[]> {
    const db = requireClient();
    const { data, error } = await db.from('clients').select('id, name, short_name').order('name');
    if (error) throw new Error(`Could not list clients: ${error.message}`);
    return (data ?? []).map((row: Row) => ({
      id: str(row.id),
      name: str(row.name),
      shortName: str(row.short_name, str(row.name)),
    }));
  },

  async loadClient(clientId: string): Promise<DataSet> {
    const db = requireClient();

    const clientResult = await db.from('clients').select('*').eq('id', clientId).single();
    if (clientResult.error) throw new Error(`Could not load client: ${clientResult.error.message}`);

    const vehicles = await select('vehicles', (q) => q.eq('client_id', clientId));
    const vehicleIds = vehicles.map((v: Row) => str(v.id));
    if (vehicleIds.length === 0) {
      return emptyDataSet(toClient(clientResult.data as Row));
    }

    const positions = await select('positions', (q) => q.in('vehicle_id', vehicleIds));
    const positionIds = positions.map((p: Row) => str(p.id));

    const [assets, investors, cashflows, balanceSheets, fxRates, valuations] = await Promise.all([
      positionIds.length ? select('assets', (q) => q.in('position_id', positionIds)) : [],
      select('investors', (q) => q.in('vehicle_id', vehicleIds)),
      select('cashflows', (q) => q.in('vehicle_id', vehicleIds)),
      select('vehicle_balance_sheets', (q) => q.in('vehicle_id', vehicleIds)),
      select('fx_rates', (q) => q.eq('client_id', clientId)),
      positionIds.length ? select('position_valuations', (q) => q.in('position_id', positionIds)) : [],
    ]);

    const assetIds = assets.map((a: Row) => str(a.id));
    const [assetValuations, esgMetrics] = await Promise.all([
      assetIds.length ? select('asset_valuations', (q) => q.in('asset_id', assetIds)) : [],
      select('esg_metrics', (q) => q.eq('client_id', clientId)),
    ]);

    return {
      client: toClient(clientResult.data as Row),
      vehicles: vehicles.map(toVehicle),
      positions: positions.map(toPosition),
      assets: assets.map(toAsset),
      investors: investors.map(toInvestor),
      positionValuations: valuations.map(toPositionValuation),
      assetValuations: assetValuations.map(toAssetValuation),
      cashflows: cashflows.map(toCashflow),
      balanceSheets: balanceSheets.map(toBalanceSheet),
      fxRates: fxRates.map(toFxRate),
      esgMetrics: esgMetrics.map(toEsgMetric),
    };
  },
};

function requireClient() {
  const db = getSupabase();
  if (!db) throw new Error('Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  return db;
}

type QueryShape = { eq: (c: string, v: unknown) => unknown; in: (c: string, v: unknown[]) => unknown };

async function select(table: string, narrow: (q: QueryShape) => unknown): Promise<Row[]> {
  const db = requireClient();
  const query = db.from(table).select('*');
  const { data, error } = await (narrow(query as unknown as QueryShape) as Promise<{ data: Row[] | null; error: { message: string } | null }>);
  if (error) throw new Error(`Could not load ${table}: ${error.message}`);
  return data ?? [];
}

function emptyDataSet(client: Client): DataSet {
  return {
    client, vehicles: [], positions: [], assets: [], investors: [],
    positionValuations: [], assetValuations: [], cashflows: [],
    balanceSheets: [], fxRates: [], esgMetrics: [],
  };
}

function toClient(row: Row): Client {
  return {
    id: str(row.id),
    name: str(row.name),
    shortName: str(row.short_name, str(row.name)),
    reportingCurrency: str(row.reporting_currency, 'EUR'),
    conventions: opt(row.conventions),
  };
}

function toVehicle(row: Row): Vehicle {
  return {
    id: str(row.id),
    clientId: str(row.client_id),
    kind: str(row.kind, 'fund-of-funds') as Vehicle['kind'],
    name: str(row.name),
    shortName: str(row.short_name, str(row.name)),
    currency: str(row.currency, 'EUR'),
    inceptionDate: str(row.inception_date),
    investorCommitment: num(row.investor_commitment),
    manager: opt(row.manager),
    administrator: opt(row.administrator),
    domicile: opt(row.domicile),
    status: str(row.status, 'Investing') as Vehicle['status'],
    conventions: opt(row.conventions),
  };
}

function toPosition(row: Row): Position {
  return {
    id: str(row.id),
    vehicleId: str(row.vehicle_id),
    kind: str(row.kind, 'fund') as Position['kind'],
    name: str(row.name),
    manager: opt(row.manager),
    currency: str(row.currency, 'EUR'),
    vintage: num(row.vintage),
    commitmentDate: str(row.commitment_date),
    investmentPeriodEnd: opt(row.investment_period_end),
    commitment: num(row.commitment),
    ownership: num(row.ownership),
    assetClass: str(row.asset_class),
    subAssetClass: opt(row.sub_asset_class),
    region: str(row.region),
    sector: opt(row.sector),
    strategy: opt(row.strategy),
    status: str(row.status, 'Investing') as Position['status'],
    terminatedPeriod: opt(row.terminated_period),
    esg: opt(row.esg),
  };
}

function toAsset(row: Row): Asset {
  return {
    id: str(row.id),
    positionId: str(row.position_id),
    name: str(row.name),
    currency: str(row.currency, 'EUR'),
    investmentDate: str(row.investment_date),
    ownership: num(row.ownership),
    assetClass: str(row.asset_class),
    subAssetClass: opt(row.sub_asset_class),
    sector: (row.sector ?? 'Unclassified') as Asset['sector'],
    region: (row.region ?? 'Unclassified') as Asset['region'],
    country: (row.country ?? 'Unclassified') as Asset['country'],
    status: str(row.status, 'Held') as Asset['status'],
    esg: opt(row.esg),
  };
}

function toInvestor(row: Row): Investor {
  return {
    id: str(row.id),
    vehicleId: str(row.vehicle_id),
    name: str(row.name),
    type: str(row.type, 'Institution') as Investor['type'],
    country: opt(row.country),
    currency: str(row.currency, 'EUR'),
    commitment: num(row.commitment),
    shareClass: opt(row.share_class),
    entryDate: str(row.entry_date),
  };
}

function toPositionValuation(row: Row): PositionValuation {
  return {
    id: str(row.id),
    positionId: str(row.position_id),
    period: str(row.period),
    recordedAt: str(row.recorded_at),
    nav: num(row.nav),
    drawnCumulative: opt(row.drawn_cumulative),
    distributedCumulative: opt(row.distributed_cumulative),
    recallableCumulative: opt(row.recallable_cumulative),
    source: str(row.source),
    supersededBy: opt(row.superseded_by),
  };
}

function toAssetValuation(row: Row): AssetValuation {
  return {
    id: str(row.id),
    assetId: str(row.asset_id),
    period: str(row.period),
    recordedAt: str(row.recorded_at),
    invested: num(row.invested),
    realised: num(row.realised),
    unrealised: num(row.unrealised),
    source: str(row.source),
  };
}

function toCashflow(row: Row): Cashflow {
  return {
    id: str(row.id),
    positionId: opt(row.position_id),
    investorId: opt(row.investor_id),
    vehicleId: str(row.vehicle_id),
    type: str(row.type, 'Capital Call') as Cashflow['type'],
    amount: num(row.amount),
    currency: str(row.currency, 'EUR'),
    date: str(row.date),
    period: str(row.period),
    recordedAt: str(row.recorded_at),
    affectsCommitment: Boolean(row.affects_commitment),
    recallable: opt(row.recallable),
    description: opt(row.description),
    status: str(row.status, 'Settled') as Cashflow['status'],
  };
}

function toBalanceSheet(row: Row): VehicleBalanceSheet {
  return {
    vehicleId: str(row.vehicle_id),
    period: str(row.period),
    recordedAt: str(row.recorded_at),
    cash: num(row.cash),
    otherAssets: num(row.other_assets),
    currentLiabilities: num(row.current_liabilities),
    accruedExpenses: num(row.accrued_expenses),
    source: str(row.source),
  };
}

function toFxRate(row: Row): FxRate {
  return {
    id: str(row.id),
    base: str(row.base),
    quote: str(row.quote),
    rate: num(row.rate),
    date: str(row.date),
    period: str(row.period),
    recordedAt: str(row.recorded_at),
    kind: str(row.kind, 'closing') as FxRate['kind'],
    source: str(row.source),
    // Without these two the override is lost on the way out of the database:
    // every rate would read as a market fixing and the administrator's rate
    // would win or lose on arrival order again.
    authority: str(row.authority, 'market') as FxRate['authority'],
    documentId: opt<string>(row.document_id),
  };
}

function toEsgMetric(row: Row): EsgMetric {
  return {
    id: str(row.id),
    scope: {
      kind: str(row.scope_kind, 'vehicle') as EsgMetric['scope']['kind'],
      id: str(row.scope_id),
    },
    period: str(row.period),
    recordedAt: str(row.recorded_at),
    metric: str(row.metric),
    value: num(row.value),
    unit: str(row.unit),
    coverage: opt(row.coverage),
    source: str(row.source),
  };
}

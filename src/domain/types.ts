import type { PeriodId } from './period';
import type { ReportingProfile } from './report';

/* ------------------------------------------------------------------ *
 * Scope: client -> vehicle -> position -> asset
 *
 * Every read in the application is scoped. A client sees their vehicles;
 * a vehicle resolves to a portfolio; a portfolio resolves to positions and,
 * by look-through, to assets. The scope is the first argument to the engine,
 * never an ambient global.
 * ------------------------------------------------------------------ */

export type CurrencyCode = string; // ISO 4217, e.g. "EUR"

/** A reporting client — the tenant boundary and the top of the hierarchy. */
export interface Client {
  id: string;
  name: string;
  shortName: string;
  /** Currency the client's consolidated views are presented in. */
  reportingCurrency: CurrencyCode;
  /** House conventions that travel with the client's reports. */
  conventions?: ReportingConventions;
}

/**
 * A vehicle is the reporting product: a fund-of-funds, a direct fund, or a
 * mandate. The distinction changes what a "position" is, not how the engine
 * works.
 *
 * `mandate` is the case where the client runs nothing: an adviser monitors and
 * reports on funds somebody else manages. It has positions and a capital
 * account like any other, and no net asset value of its own, because there is
 * no vehicle of the client's own between the holder and the funds.
 */
export type VehicleKind = 'fund-of-funds' | 'direct-fund' | 'mandate';

export const VEHICLE_KIND: Record<VehicleKind, string> = {
  'fund-of-funds': 'Fund of funds',
  'direct-fund': 'Direct fund',
  mandate: 'Advisory mandate',
};

export interface Vehicle {
  id: string;
  clientId: string;
  kind: VehicleKind;
  name: string;
  shortName: string;
  /** Currency the vehicle books in. Positions are translated into it. */
  currency: CurrencyCode;
  inceptionDate: string; // ISO date
  /** Total commitment investors have made to the vehicle. */
  investorCommitment: number;
  manager?: string;
  administrator?: string;
  domicile?: string;
  status: 'Fundraising' | 'Investing' | 'Harvesting' | 'Liquidating' | 'Closed';
  conventions?: ReportingConventions;
}

/**
 * A position is what the vehicle holds directly.
 *  - fund-of-funds: an underlying fund commitment
 *  - direct-fund:   a portfolio company / asset held directly
 *
 * Both carry commitments and drawdowns, so one shape serves both. A direct
 * position simply has no undrawn commitment once fully funded.
 */
export type PositionKind = 'fund' | 'direct-investment' | 'co-investment' | 'secondary';

export interface Position {
  id: string;
  vehicleId: string;
  kind: PositionKind;
  name: string;
  manager?: string;
  currency: CurrencyCode;
  vintage: number;
  commitmentDate: string; // ISO date
  investmentPeriodEnd?: string; // ISO date
  /** Vehicle's commitment to this position, in the position's own currency. */
  commitment: number;
  /** Vehicle's share of the position, as a fraction (0..1). */
  ownership: number;
  assetClass: string;
  subAssetClass?: string;
  region: string;
  sector?: string;
  strategy?: string;
  status: 'Committed' | 'Investing' | 'Harvesting' | 'Realised' | 'Written Off';
  /** Set when the position is no longer expected to report — excluded from coverage. */
  terminatedPeriod?: PeriodId;
  esg?: EsgClassification;
}

/**
 * An asset is a look-through holding: a portfolio company inside an underlying
 * fund, or the operating asset behind a direct investment. Assets drive the
 * exposure views; they never drive NAV, which comes from the position.
 */
export interface Asset {
  id: string;
  positionId: string;
  name: string;
  currency: CurrencyCode;
  investmentDate: string; // ISO date
  /** Position's stake in the asset, as a fraction (0..1). */
  ownership: number;
  assetClass: string;
  subAssetClass?: string;
  /** Single label, or a weighted split summing to 1. */
  sector: Attribution;
  region: Attribution;
  country: Attribution;
  status: 'Held' | 'Partially Realised' | 'Realised' | 'Written Off';
  esg?: EsgClassification;
}

/**
 * Either a single label ("Germany") or a weighted split
 * ({ Germany: 0.6, Austria: 0.4 }). Weights are fractions and must sum to 1.
 */
export type Attribution = string | Record<string, number>;

/* ------------------------------------------------------------------ *
 * Investors — the net-of-fee view at LP level
 * ------------------------------------------------------------------ */

export interface Investor {
  id: string;
  vehicleId: string;
  name: string;
  type: 'Individual' | 'Institution' | 'Family Office' | 'Feeder' | 'Seed';
  country?: string;
  currency: CurrencyCode;
  commitment: number;
  /** Fee terms applied to this investor. Absent means the vehicle default. */
  shareClass?: string;
  entryDate: string; // ISO date
}

/* ------------------------------------------------------------------ *
 * Observations — the bitemporal fact layer
 *
 * Every fact says two things: which period it describes (`period`) and when we
 * came to know it (`recordedAt`). Filtering on `recordedAt <= knowledgeDate`
 * reproduces exactly what the desk could have reported on that date, which is
 * what makes a past quarter reviewable rather than merely re-derivable.
 * ------------------------------------------------------------------ */

/**
 * How a figure came to be. This is carried through every aggregate and rendered
 * on screen, so an estimate is never mistaken for a reported number.
 */
export type Provenance =
  /** Traced to a source document for this exact period. */
  | 'reported'
  /** Prior NAV rolled forward for cashflows only — no new valuation. */
  | 'rolled-forward'
  /** Modelled: rolled forward and marked with an expected value change. */
  | 'estimated'
  /** Reported, but for an earlier period than requested. */
  | 'stale'
  /** Nothing known. Contributes zero and is counted against coverage. */
  | 'missing';

export interface Observed<T> {
  value: T;
  provenance: Provenance;
  /** Period the reported figure actually belongs to; differs when `stale`. */
  sourcePeriod?: PeriodId;
  note?: string;
}

/** A position valuation for one period, as reported by one source. */
export interface PositionValuation {
  id: string;
  positionId: string;
  period: PeriodId;
  /** When this figure entered the system. Drives point-in-time queries. */
  recordedAt: string; // ISO timestamp
  /** NAV in the position's own currency. */
  nav: number;
  /** Cumulative amounts in the position's own currency, since inception. */
  drawnCumulative?: number;
  distributedCumulative?: number;
  /** Portion of distributions the GP may recall. */
  recallableCumulative?: number;
  source: string;
  /** Superseded rows stay in the table so restatements remain visible. */
  supersededBy?: string;
}

export type CashflowType =
  | 'Commitment'
  | 'Capital Call'
  | 'Distribution'
  | 'Return of Capital'
  | 'Equalisation'
  | 'Fee'
  | 'Expense'
  | 'Income';

export interface Cashflow {
  id: string;
  /** Set for portfolio (gross) flows: vehicle <-> position. */
  positionId?: string;
  /** Set for product (net) flows: investor <-> vehicle. */
  investorId?: string;
  vehicleId: string;
  type: CashflowType;
  /** Signed from the vehicle's perspective: calls out negative, receipts positive. */
  amount: number;
  currency: CurrencyCode;
  date: string; // ISO date
  period: PeriodId;
  recordedAt: string; // ISO timestamp
  /** Whether this flow moves undrawn commitment. */
  affectsCommitment: boolean;
  recallable?: boolean;
  description?: string;
  status: 'Draft' | 'Confirmed' | 'Settled';
}

/** Asset-level look-through figures, in the asset's own currency. */
export interface AssetValuation {
  id: string;
  assetId: string;
  period: PeriodId;
  recordedAt: string;
  invested: number;
  realised: number;
  unrealised: number;
  source: string;
}

/** Vehicle-level balance sheet items that sit outside the portfolio. */
export interface VehicleBalanceSheet {
  vehicleId: string;
  period: PeriodId;
  recordedAt: string;
  cash: number;
  otherAssets: number;
  currentLiabilities: number;
  /** Accrued but unpaid management fee, carry and running costs. */
  accruedExpenses: number;
  source: string;
}

/* ------------------------------------------------------------------ *
 * FX
 * ------------------------------------------------------------------ */

/**
 * Where a rate came from, and therefore which one wins.
 *
 * The reported net asset value has to tie to the administrator's statement. If
 * the administrator translated a position at 1.1520 and the ECB fixing was
 * 1.1498, using the ECB rate creates a reconciliation difference against the
 * books — so an administrator-derived rate supersedes a market one for the same
 * pair, period and kind, whenever it arrives.
 *
 * Ranked, worst to best: `market` (ECB or another published fixing), `manual`
 * (entered by hand where nothing else covers the pair), `administrator`
 * (implied by the financials or the trial balance).
 */
export type FxAuthority = 'market' | 'manual' | 'administrator';

/**
 * Quoted as `1 base = rate quote`. So EUR/USD 1.0850 means one euro buys
 * 1.0850 dollars, and a rise means the quote currency weakened.
 */
export interface FxRate {
  id: string;
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  date: string; // ISO date
  period: PeriodId;
  recordedAt: string; // ISO timestamp
  kind: 'closing' | 'average';
  source: string;
  /**
   * Defaults to `market`. Precedence is by authority first and only then by
   * recency, so a later backfill of ECB rates cannot silently displace what the
   * administrator's books say.
   */
  authority?: FxAuthority;
  /** The document the rate was derived from, for an administrator rate. */
  documentId?: string;
}

/* ------------------------------------------------------------------ *
 * ESG — the schema is present from day one; the analytics come later
 * ------------------------------------------------------------------ */

export interface EsgClassification {
  sfdr?: 'Article 6' | 'Article 8' | 'Article 9' | 'Not Classified';
  sdgs?: number[];
  taxonomyAligned?: number; // fraction 0..1
  exclusionsBreached?: string[];
}

export interface EsgMetric {
  id: string;
  /** Whichever level the metric was collected at. */
  scope: { kind: 'vehicle' | 'position' | 'asset'; id: string };
  period: PeriodId;
  recordedAt: string;
  metric: string; // e.g. "scope1_tco2e"
  value: number;
  unit: string;
  coverage?: number; // fraction of the portfolio the metric covers
  source: string;
}

/* ------------------------------------------------------------------ *
 * Conventions and reporting configuration
 * ------------------------------------------------------------------ */

export interface ReportingConventions {
  /** Stock items (NAV, commitments) translated at the period closing rate. */
  stockRate: 'closing';
  /** Flows translated at the transaction-date rate or the period average. */
  flowRate: 'transaction' | 'average';
  /** Whether IRR is computed on daily-dated flows or period-end flows. */
  irrBasis: 'daily' | 'quarterly';
  /** Whether recallable distributions restore undrawn commitment. */
  recallableRestoresCommitment: boolean;
  /** How a position with no valuation for the period is treated in a draft. */
  draftPolicy: DraftPolicy;
}

export interface DraftPolicy {
  /** Roll the last known NAV forward for cashflows. Always the first step. */
  rollForward: boolean;
  /**
   * Apply an expected value change to rolled-forward NAVs. `none` leaves the
   * NAV at cost-adjusted; `portfolio` applies the reported cohort's return;
   * `fixed` applies `fixedReturn`.
   */
  valueChange: 'none' | 'portfolio' | 'fixed';
  fixedReturn?: number; // decimal, e.g. 0.02
  /** A quarter below this reported-NAV coverage is refused, not drafted. */
  minimumCoverage: number; // fraction 0..1
  /** Periods a valuation may lag before it counts as `stale` rather than fresh. */
  staleAfterQuarters: number;
}

export const DEFAULT_CONVENTIONS: ReportingConventions = {
  stockRate: 'closing',
  flowRate: 'transaction',
  irrBasis: 'daily',
  recallableRestoresCommitment: true,
  draftPolicy: {
    rollForward: true,
    valueChange: 'portfolio',
    minimumCoverage: 0.5,
    staleAfterQuarters: 1,
  },
};

/* ------------------------------------------------------------------ *
 * The scope object every engine entry point takes
 * ------------------------------------------------------------------ */

export interface Scope {
  clientId: string;
  /** Absent means "all vehicles of the client", consolidated. */
  vehicleId?: string;
  /** Narrows the portfolio to one position and its assets. */
  positionId?: string;
  /** Narrows further to a single look-through asset. */
  assetId?: string;
  /** The period being reported. */
  period: PeriodId;
  /**
   * Point-in-time: only facts recorded at or before this instant are visible.
   * Absent means "everything we know now".
   */
  knowledgeDate?: string; // ISO timestamp
  /** Currency the results are presented in. Defaults to the vehicle currency. */
  presentationCurrency?: CurrencyCode;
}

/** Everything the engine needs, already narrowed to one client. */
export interface DataSet {
  client: Client;
  /**
   * How this client's reports look and read. Absent for a client that has not
   * been given one, which behaves exactly like an empty one.
   */
  reporting?: ReportingProfile;
  vehicles: Vehicle[];
  positions: Position[];
  assets: Asset[];
  investors: Investor[];
  positionValuations: PositionValuation[];
  assetValuations: AssetValuation[];
  cashflows: Cashflow[];
  balanceSheets: VehicleBalanceSheet[];
  fxRates: FxRate[];
  esgMetrics: EsgMetric[];
}

/**
 * Historical extract.
 *
 * Two questions get asked of a reporting system when someone wants to leave it,
 * audit it, or reconcile it against something else: "give me this quarter" and
 * "give me everything since inception". Both are the same operation over a
 * different period window, so both are one function.
 *
 * Three principles:
 *
 *  1. The extract carries the raw facts, not the presentation. Someone
 *     rebuilding these numbers elsewhere needs the observations and the rates,
 *     not the millions-rounded strings that went on a page.
 *  2. `recorded_at` travels with every fact. An extract without it cannot
 *     reproduce a past quarter, which makes it useless for exactly the audit it
 *     was requested for.
 *  3. A derived sheet is included as well, so the extract can be checked
 *     against the application without anyone re-implementing the engine.
 */

import {
  comparePeriods, formatPeriod, periodEndDate, sortPeriods, type PeriodId,
} from '../domain/period';
import type { CurrencyCode, DataSet, Scope } from '../domain/types';
import type { ReportingProfile } from '../domain/report';
import { analyse } from '../engine';
import { throughPeriod, visibleAt } from '../engine/asof';

export type ExtractWindow =
  /** Every period on record, from the first observation to `period`. */
  | { kind: 'since-inception'; period: PeriodId }
  /** A single quarter. */
  | { kind: 'period'; period: PeriodId }
  /** An inclusive span. */
  | { kind: 'range'; from: PeriodId; period: PeriodId };

export interface ExtractOptions {
  dataset: DataSet;
  window: ExtractWindow;
  /** Restricts to one vehicle. Absent means every vehicle of the client. */
  vehicleId?: string;
  /** Point-in-time: only facts recorded at or before this instant. */
  knowledgeDate?: string;
  /** Currency the derived sheet is presented in. */
  presentationCurrency?: CurrencyCode;
  /** Include the derived per-quarter figures alongside the raw facts. */
  includeDerived?: boolean;
}

export interface Sheet {
  name: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  /** One line explaining what the sheet is, written into the manifest. */
  description: string;
}

export interface Extract {
  sheets: Sheet[];
  /** Human-readable description of exactly what was extracted. */
  manifest: string;
  /** Base filename, without an extension. */
  filename: string;
  periods: PeriodId[];
  /**
   * The client's report layouts and branding, verbatim.
   *
   * Not a sheet: it is nested configuration, and flattening it into rows would
   * make it unreadable and unrestorable. It travels in the CSV bundle as its
   * own file so that an export is a complete backup of the book — losing the
   * folder should not mean rebuilding every client's pack by hand.
   */
  reporting?: ReportingProfile;
}

export function buildExtract(options: ExtractOptions): Extract {
  const { dataset, window, vehicleId, knowledgeDate, includeDerived = true } = options;

  const vehicles = dataset.vehicles.filter((v) => !vehicleId || v.id === vehicleId);
  const vehicleIds = new Set(vehicles.map((v) => v.id));
  const positions = dataset.positions.filter((p) => vehicleIds.has(p.vehicleId));
  const positionIds = new Set(positions.map((p) => p.id));
  const assets = dataset.assets.filter((a) => positionIds.has(a.positionId));
  const assetIds = new Set(assets.map((a) => a.id));
  const investors = dataset.investors.filter((i) => vehicleIds.has(i.vehicleId));

  const inWindow = (period: PeriodId) => {
    if (comparePeriods(period, window.period) > 0) return false;
    if (window.kind === 'period') return period === window.period;
    if (window.kind === 'range') return comparePeriods(period, window.from) >= 0;
    return true;
  };

  const valuations = visibleAt(
    dataset.positionValuations.filter((v) => positionIds.has(v.positionId)),
    knowledgeDate,
  ).filter((v) => inWindow(v.period));

  const assetValuations = visibleAt(
    dataset.assetValuations.filter((v) => assetIds.has(v.assetId)),
    knowledgeDate,
  ).filter((v) => inWindow(v.period));

  const cashflows = visibleAt(
    dataset.cashflows.filter((c) => vehicleIds.has(c.vehicleId)),
    knowledgeDate,
  ).filter((c) => inWindow(c.period));

  const balanceSheets = visibleAt(
    dataset.balanceSheets.filter((b) => vehicleIds.has(b.vehicleId)),
    knowledgeDate,
  ).filter((b) => inWindow(b.period));

  const fxRates = visibleAt(dataset.fxRates, knowledgeDate).filter((r) => inWindow(r.period));
  const esgMetrics = visibleAt(dataset.esgMetrics, knowledgeDate).filter((m) => inWindow(m.period));

  const periods = sortPeriods(
    [...new Set([
      ...valuations.map((v) => v.period),
      ...cashflows.map((c) => c.period),
      ...balanceSheets.map((b) => b.period),
    ])],
    'asc',
  );

  const positionName = new Map(positions.map((p) => [p.id, p.name]));
  const assetName = new Map(assets.map((a) => [a.id, a.name]));
  const investorName = new Map(investors.map((i) => [i.id, i.name]));
  const vehicleName = new Map(vehicles.map((v) => [v.id, v.name]));

  const sheets: Sheet[] = [
    {
      name: 'vehicles',
      description: 'The reporting vehicles covered by this extract.',
      columns: ['vehicle_id', 'kind', 'name', 'short_name', 'currency', 'inception_date',
        'investor_commitment', 'manager', 'administrator', 'domicile', 'status'],
      rows: vehicles.map((v) => [
        v.id, v.kind, v.name, v.shortName, v.currency, v.inceptionDate,
        v.investorCommitment, v.manager ?? null, v.administrator ?? null,
        v.domicile ?? null, v.status,
      ]),
    },
    {
      name: 'positions',
      description: 'Holdings: underlying funds for a fund-of-funds, direct investments otherwise.',
      columns: ['position_id', 'vehicle_id', 'vehicle_name', 'kind', 'name', 'manager', 'currency',
        'vintage', 'commitment_date', 'investment_period_end', 'commitment', 'ownership_fraction',
        'asset_class', 'sub_asset_class', 'region', 'sector', 'strategy', 'status', 'sfdr'],
      rows: positions.map((p) => [
        p.id, p.vehicleId, vehicleName.get(p.vehicleId) ?? null, p.kind, p.name, p.manager ?? null,
        p.currency, p.vintage, p.commitmentDate, p.investmentPeriodEnd ?? null,
        p.commitment, p.ownership, p.assetClass, p.subAssetClass ?? null, p.region,
        typeof p.sector === 'string' ? p.sector : null, p.strategy ?? null, p.status,
        p.esg?.sfdr ?? null,
      ]),
    },
    {
      name: 'assets',
      description: 'Look-through holdings inside each position.',
      columns: ['asset_id', 'position_id', 'position_name', 'name', 'currency', 'investment_date',
        'ownership_fraction', 'asset_class', 'sub_asset_class', 'sector', 'region', 'country', 'status'],
      rows: assets.map((a) => [
        a.id, a.positionId, positionName.get(a.positionId) ?? null, a.name, a.currency,
        a.investmentDate, a.ownership, a.assetClass, a.subAssetClass ?? null,
        stringifyAttribution(a.sector), stringifyAttribution(a.region),
        stringifyAttribution(a.country), a.status,
      ]),
    },
    {
      name: 'investors',
      description: 'Investors in each vehicle.',
      columns: ['investor_id', 'vehicle_id', 'vehicle_name', 'name', 'type', 'country',
        'currency', 'commitment', 'share_class', 'entry_date'],
      rows: investors.map((i) => [
        i.id, i.vehicleId, vehicleName.get(i.vehicleId) ?? null, i.name, i.type,
        i.country ?? null, i.currency, i.commitment, i.shareClass ?? null, i.entryDate,
      ]),
    },
    {
      name: 'position_valuations',
      description: 'Every reported valuation, including superseded ones. `recorded_at` is when the figure was learned.',
      columns: ['valuation_id', 'position_id', 'position_name', 'period', 'period_label',
        'period_end', 'recorded_at', 'nav', 'currency', 'drawn_cumulative',
        'distributed_cumulative', 'recallable_cumulative', 'source', 'superseded'],
      rows: valuations
        .sort(byPeriodThenRecorded)
        .map((v) => {
          const position = positions.find((p) => p.id === v.positionId);
          return [
            v.id, v.positionId, positionName.get(v.positionId) ?? null, v.period,
            formatPeriod(v.period), periodEndDate(v.period), v.recordedAt, v.nav,
            position?.currency ?? null, v.drawnCumulative ?? null,
            v.distributedCumulative ?? null, v.recallableCumulative ?? null,
            v.source, v.supersededBy ? 'yes' : 'no',
          ];
        }),
    },
    {
      name: 'asset_valuations',
      description: 'Look-through asset values by period.',
      columns: ['valuation_id', 'asset_id', 'asset_name', 'period', 'period_label',
        'recorded_at', 'invested', 'realised', 'unrealised', 'source'],
      rows: assetValuations.sort(byPeriodThenRecorded).map((v) => [
        v.id, v.assetId, assetName.get(v.assetId) ?? null, v.period, formatPeriod(v.period),
        v.recordedAt, v.invested, v.realised, v.unrealised, v.source,
      ]),
    },
    {
      name: 'cashflows',
      description: 'Portfolio and investor cashflows. Amounts are signed from the vehicle’s perspective: money out negative.',
      columns: ['cashflow_id', 'vehicle_id', 'vehicle_name', 'position_id', 'position_name',
        'investor_id', 'investor_name', 'type', 'amount', 'currency', 'date', 'period',
        'period_label', 'recorded_at', 'affects_commitment', 'recallable', 'status', 'description'],
      rows: cashflows
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((c) => [
          c.id, c.vehicleId, vehicleName.get(c.vehicleId) ?? null,
          c.positionId ?? null, c.positionId ? positionName.get(c.positionId) ?? null : null,
          c.investorId ?? null, c.investorId ? investorName.get(c.investorId) ?? null : null,
          c.type, c.amount, c.currency, c.date, c.period, formatPeriod(c.period),
          c.recordedAt, c.affectsCommitment ? 'yes' : 'no',
          c.recallable === undefined ? null : c.recallable ? 'yes' : 'no',
          c.status, c.description ?? null,
        ]),
    },
    {
      name: 'balance_sheets',
      description: 'Vehicle-level items that sit outside the portfolio and separate gross NAV from net.',
      columns: ['vehicle_id', 'vehicle_name', 'period', 'period_label', 'recorded_at',
        'cash', 'other_assets', 'current_liabilities', 'accrued_expenses', 'source'],
      rows: balanceSheets.sort(byPeriodThenRecorded).map((b) => [
        b.vehicleId, vehicleName.get(b.vehicleId) ?? null, b.period, formatPeriod(b.period),
        b.recordedAt, b.cash, b.otherAssets, b.currentLiabilities, b.accruedExpenses, b.source,
      ]),
    },
    {
      name: 'fx_rates',
      description:
        'Quoted as 1 base = rate quote. Stocks use closing rates, flows the rate of their own date. '
        + 'Several rows can exist for one pair and quarter; the one that applied is the highest authority '
        + '(administrator over manual over market), and only then the most recent.',
      columns: ['base', 'quote', 'rate', 'kind', 'date', 'period', 'period_label', 'recorded_at',
        'authority', 'source', 'document_id'],
      rows: fxRates.sort(byPeriodThenRecorded).map((r) => [
        r.base, r.quote, r.rate, r.kind, r.date, r.period, formatPeriod(r.period),
        r.recordedAt, r.authority ?? 'market', r.source, r.documentId ?? null,
      ]),
    },
  ];

  if (esgMetrics.length > 0) {
    sheets.push({
      name: 'esg_metrics',
      description: 'Sustainability metrics, each with the share of the scope it actually covers.',
      columns: ['metric_id', 'scope_kind', 'scope_id', 'period', 'period_label',
        'recorded_at', 'metric', 'value', 'unit', 'coverage_fraction', 'source'],
      rows: esgMetrics.sort(byPeriodThenRecorded).map((m) => [
        m.id, m.scope.kind, m.scope.id, m.period, formatPeriod(m.period), m.recordedAt,
        m.metric, m.value, m.unit, m.coverage ?? null, m.source,
      ]),
    });
  }

  if (includeDerived && periods.length > 0) {
    sheets.push(derivedSheet(options, periods));
    sheets.push(positionHistorySheet(options, periods));
  }

  return {
    reporting: dataset.reporting,
    sheets,
    manifest: buildManifest(options, sheets, periods, vehicles.map((v) => v.name)),
    filename: buildFilename(options, vehicles.map((v) => v.shortName)),
    periods,
  };
}

/**
 * The engine's own output, quarter by quarter. Its presence is what lets a
 * recipient check their reconstruction against ours instead of guessing which
 * of two different answers is the intended one.
 */
function derivedSheet(options: ExtractOptions, periods: PeriodId[]): Sheet {
  const { dataset, vehicleId, knowledgeDate, presentationCurrency } = options;

  const rows = periods.map((period) => {
    const scope: Scope = {
      clientId: dataset.client.id,
      vehicleId,
      period,
      knowledgeDate,
      presentationCurrency,
    };
    const view = analyse(dataset, scope);
    const g = view.gross.totals;
    const n = view.net.product;

    return [
      period, formatPeriod(period), periodEndDate(period), view.currency,
      g.nav, g.commitments, g.drawn, g.undrawn, g.distributed, g.recallable,
      g.openCommitment, g.percentInvested,
      g.callsInPeriod, g.distributionsInPeriod, g.valueChange, g.fxEffect,
      g.multiples.tvpi ?? null, g.multiples.dpi ?? null, g.multiples.rvpi ?? null, g.irr ?? null,
      n.components.vehicleNav, n.components.cash, n.components.otherAssets,
      n.components.currentLiabilities, n.components.accruedExpenses,
      n.commitment, n.called, n.undrawn, n.distributed, n.feesInPeriod, n.feesCumulative,
      n.multiples.tvpi ?? null, n.multiples.dpi ?? null, n.multiples.rvpi ?? null, n.irr ?? null,
      view.gross.coverage.expected, view.gross.coverage.reported,
      view.gross.coverage.navCoverage, view.provenance,
      view.isFinal ? 'final' : 'draft',
      view.checks.passed, view.checks.failed, view.checks.skipped,
    ];
  });

  return {
    name: 'derived_by_quarter',
    description:
      'The engine’s own output for each quarter, so a reconstruction from the raw sheets can be checked against it rather than guessed at.',
    columns: [
      'period', 'period_label', 'period_end', 'currency',
      'gross_nav', 'gross_commitments', 'gross_drawn', 'gross_undrawn', 'gross_distributed',
      'gross_recallable', 'gross_open_commitment', 'gross_percent_invested',
      'calls_in_period', 'distributions_in_period', 'value_change', 'fx_effect',
      'gross_tvpi', 'gross_dpi', 'gross_rvpi', 'gross_irr',
      'net_nav', 'net_cash', 'net_other_assets', 'net_current_liabilities', 'net_accrued_expenses',
      'investor_commitment', 'investor_called', 'investor_undrawn', 'investor_distributed',
      'fees_in_period', 'fees_cumulative',
      'net_tvpi', 'net_dpi', 'net_rvpi', 'net_irr',
      'positions_expected', 'positions_reported', 'nav_coverage_fraction', 'weakest_provenance',
      'status', 'checks_passed', 'checks_failed', 'checks_skipped',
    ],
    rows,
  };
}

/** One row per holding per quarter — the shape most reconciliations want. */
function positionHistorySheet(options: ExtractOptions, periods: PeriodId[]): Sheet {
  const { dataset, vehicleId, knowledgeDate, presentationCurrency } = options;
  const rows: Array<Array<string | number | null>> = [];

  for (const period of periods) {
    const view = analyse(dataset, {
      clientId: dataset.client.id, vehicleId, period, knowledgeDate, presentationCurrency,
    });

    for (const result of view.gross.positions) {
      rows.push([
        period, formatPeriod(period), result.position.id, result.position.name,
        result.position.currency, view.currency,
        result.commitment, result.drawn, result.undrawn, result.distributed,
        result.nav, result.navPrior, result.valueChange, result.fxEffect,
        result.multiples.tvpi ?? null, result.multiples.dpi ?? null, result.irr ?? null,
        result.provenance, result.state.sourcePeriod ?? null, result.state.lagQuarters,
        result.state.rollForwardAdjustment, result.state.appliedReturn,
        result.state.note ?? null,
      ]);
    }
  }

  return {
    name: 'position_history',
    description:
      'One row per holding per quarter, carrying the basis on which its value was arrived at — reported, rolled forward or estimated.',
    columns: [
      'period', 'period_label', 'position_id', 'position_name',
      'local_currency', 'presentation_currency',
      'commitment', 'drawn', 'undrawn', 'distributed',
      'nav', 'nav_prior', 'value_change', 'fx_effect',
      'tvpi', 'dpi', 'irr',
      'basis', 'valuation_source_period', 'lag_quarters',
      'roll_forward_adjustment', 'assumed_return', 'treatment',
    ],
    rows,
  };
}

function buildManifest(
  options: ExtractOptions, sheets: Sheet[], periods: PeriodId[], vehicleNames: string[],
): string {
  const { dataset, window, knowledgeDate, presentationCurrency } = options;

  const scopeLine = window.kind === 'since-inception'
    ? `Since inception through ${formatPeriod(window.period)}`
    : window.kind === 'period'
      ? formatPeriod(window.period)
      : `${formatPeriod(window.from)} to ${formatPeriod(window.period)}`;

  const lines = [
    `Historical extract — ${dataset.client.name}`,
    '',
    `Scope        ${scopeLine}`,
    `Vehicles     ${vehicleNames.length > 0 ? vehicleNames.join(', ') : 'none'}`,
    `Periods      ${periods.length} quarter(s)${periods.length > 0 ? `: ${formatPeriod(periods[0])} to ${formatPeriod(periods[periods.length - 1])}` : ''}`,
    `Currency     ${presentationCurrency ?? 'vehicle currency'} (derived sheets only; raw facts are in their own currency)`,
    knowledgeDate
      ? `As at        ${knowledgeDate} — reproduces what was known at that instant; later restatements are excluded`
      : 'As at        everything known at the time of extraction',
    `Generated    ${new Date().toISOString()}`,
    '',
    'Sheets',
    ...sheets.map((sheet) => `  ${sheet.name.padEnd(22)} ${sheet.rows.length} row(s) — ${sheet.description}`),
    '',
    'Notes',
    '  Amounts are in the units the source system stores (normally thousands of the stated currency).',
    '  Cashflow amounts are signed from the vehicle’s perspective: money out is negative.',
    '  Ownership is a fraction between 0 and 1, not a percentage.',
    '  `recorded_at` is when a figure entered the system, not the period it describes. Filtering',
    '  on it reproduces a past quarter as it was published rather than as it was later restated;',
    '  an extract without it cannot support that, which is usually the point of asking for one.',
    '  Superseded valuations are included and flagged, so a restatement history is recoverable.',
  ];

  return lines.join('\n');
}

function buildFilename(options: ExtractOptions, shortNames: string[]): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const who = shortNames.length === 1 ? slug(shortNames[0]) : slug(options.dataset.client.shortName);
  const when = options.window.kind === 'since-inception'
    ? `inception-to-${options.window.period}`
    : options.window.kind === 'period'
      ? options.window.period
      : `${options.window.from}-to-${options.window.period}`;
  const asAt = options.knowledgeDate ? `_asat-${options.knowledgeDate.slice(0, 10)}` : '';
  return `${who}_${when}${asAt}_extract`;
}

function stringifyAttribution(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, number>)
      .map(([label, weight]) => `${label}:${weight}`)
      .join('; ');
  }
  return '';
}

function byPeriodThenRecorded(
  a: { period: PeriodId; recordedAt: string },
  b: { period: PeriodId; recordedAt: string },
): number {
  const byPeriod = comparePeriods(a.period, b.period);
  return byPeriod !== 0 ? byPeriod : a.recordedAt.localeCompare(b.recordedAt);
}

/** Re-exported so callers can narrow a dataset without importing the engine. */
export { throughPeriod };

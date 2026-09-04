/**
 * What is actually in the book, by quarter and by kind.
 *
 * Every other screen answers "what do the figures say". This one answers the
 * question that comes before it: what is there to say anything with. A quarter
 * that looks empty on the dashboard might be a quarter nobody loaded, a quarter
 * where the administrator's pack is missing, or a quarter where only the
 * limited partner's side arrived — three different problems with three
 * different owners, and the dashboard shows the same blank for all of them.
 *
 * Two tiers, kept apart because they fail differently:
 *
 *   Filed     rows that exist because a document was loaded. Nothing derives
 *             them; if they are absent, somebody has to send something.
 *   Derived   what the engine can produce from the filed rows. Absent here
 *             means an input is missing, and the row says which.
 *
 * It is deliberately cheap: counts over the fact tables rather than a full
 * analysis per quarter, because a book covering forty quarters would otherwise
 * make this the slowest screen in the application.
 */

import {
  comparePeriods, periodRange, sortPeriods, type PeriodId,
} from '../domain/period';
import type { CurrencyCode, DataSet } from '../domain/types';
import { isExpectedToReport } from './completeness';
import { visibleAt } from './asof';

/** How much of a thing is present for one quarter. */
export type Presence =
  /** Filed for this exact quarter, and complete. */
  | 'reported'
  /** Filed for this quarter, but not for everything that was expected. */
  | 'partial'
  /** Nothing new this quarter; what is shown comes from an earlier one. */
  | 'carried'
  /**
   * Nothing this quarter, and nothing was due. A quarter with no capital call
   * in it is complete, not missing — reading it as a gap sends somebody looking
   * for a document that does not exist.
   */
  | 'quiet'
  /** Nothing, and nothing to carry. */
  | 'none';

export interface InventoryCell {
  period: PeriodId;
  state: Presence;
  /** What is present — rows filed, or holdings covered. */
  count: number;
  /** What was expected, where that is a meaningful number. */
  of?: number;
  /** One line, for a tooltip. Always says what the cell means. */
  note: string;
}

export interface InventoryRow {
  id: string;
  label: string;
  /** What this row is, in a sentence a reader can act on. */
  description: string;
  tier: 'filed' | 'derived';
  /**
   * Whether the number in a cell means anything. A balance sheet is present or
   * it is not; showing "1" for it invites a reader to wonder what the other
   * ones would have been.
   */
  counted: boolean;
  cells: InventoryCell[];
}

export interface Inventory {
  periods: PeriodId[];
  rows: InventoryRow[];
  /** Quarters the book covers at all, oldest first. */
  first?: PeriodId;
  last?: PeriodId;
}

const ORDER: Record<Presence, number> = {
  none: 0, carried: 1, partial: 2, quiet: 3, reported: 3,
};

/** The weakest of several presences — a derived row is only as good as its inputs. */
function weakestOf(states: Presence[]): Presence {
  return states.reduce((worst, state) => (ORDER[state] < ORDER[worst] ? state : worst), 'reported');
}

export interface InventoryScope {
  clientId: string;
  vehicleId?: string;
  knowledgeDate?: string;
  /** Quarters to report on. Defaults to every quarter the book touches. */
  periods?: PeriodId[];
}

export function takeInventory(dataset: DataSet, scope: InventoryScope): Inventory {
  const vehicles = dataset.vehicles.filter(
    (v) => v.clientId === scope.clientId && (!scope.vehicleId || v.id === scope.vehicleId),
  );
  const vehicleIds = new Set(vehicles.map((v) => v.id));
  const positions = dataset.positions.filter((p) => vehicleIds.has(p.vehicleId));
  const positionIds = new Set(positions.map((p) => p.id));
  const assets = dataset.assets.filter((a) => positionIds.has(a.positionId));
  const assetIds = new Set(assets.map((a) => a.id));
  const investors = dataset.investors.filter((i) => vehicleIds.has(i.vehicleId));

  const at = <T extends { period: PeriodId; recordedAt: string }>(rows: T[]): T[] =>
    visibleAt(rows, scope.knowledgeDate);

  const valuations = at(dataset.positionValuations.filter((v) => positionIds.has(v.positionId)));
  const assetValuations = at(dataset.assetValuations.filter((v) => assetIds.has(v.assetId)));
  const cashflows = at(dataset.cashflows.filter((c) => vehicleIds.has(c.vehicleId)));
  const balanceSheets = at(dataset.balanceSheets.filter((b) => vehicleIds.has(b.vehicleId)));
  const rates = at(dataset.fxRates);
  const esg = at(dataset.esgMetrics).filter(
    (m) => positionIds.has(m.scope.id) || assetIds.has(m.scope.id) || vehicleIds.has(m.scope.id),
  );

  const portfolioFlows = cashflows.filter((c) => c.positionId);
  const investorFlows = cashflows.filter((c) => c.investorId);

  const touched = sortPeriods([...new Set([
    ...valuations.map((v) => v.period),
    ...assetValuations.map((v) => v.period),
    ...cashflows.map((c) => c.period),
    ...balanceSheets.map((b) => b.period),
  ])], 'asc');

  // Every quarter between the first and the last, not only the ones with
  // something in them: a gap is the most important thing this screen has to
  // show, and an axis that skips the empty quarters hides exactly that.
  const covered = touched.length > 0
    ? periodRange(touched[0], touched[touched.length - 1])
    : [];
  const periods = scope.periods ?? covered;

  /** Currencies the portfolio is stated in, which are the rates that matter. */
  const currencies = new Set<CurrencyCode>();
  for (const position of positions) currencies.add(position.currency);
  for (const vehicle of vehicles) currencies.add(vehicle.currency);
  const needed = [...currencies].filter(
    (code) => !vehicles.every((v) => v.currency === code),
  );

  /** Positions whose first valuation is at or before a period — something to carry. */
  const firstSeen = new Map<string, PeriodId>();
  for (const row of valuations) {
    const seen = firstSeen.get(row.positionId);
    if (!seen || comparePeriods(row.period, seen) < 0) firstSeen.set(row.positionId, row.period);
  }

  const countIn = <T extends { period: PeriodId }>(rows: T[], period: PeriodId): number =>
    rows.filter((row) => row.period === period).length;
  const anyBefore = <T extends { period: PeriodId }>(rows: T[], period: PeriodId): boolean =>
    rows.some((row) => comparePeriods(row.period, period) <= 0);

  /**
   * A row whose presence is simply "were any filed for this quarter".
   *
   * `flow` separates the two ways of being empty. A quarter with no capital
   * call in it is a complete quarter; a quarter with no valuation in it is a
   * quarter waiting on somebody.
   */
  const simple = (
    id: string, label: string, description: string,
    rows: Array<{ period: PeriodId }>, unit: string, flow = false,
  ): InventoryRow => ({
    id,
    label,
    description,
    tier: 'filed',
    counted: true,
    cells: periods.map((period) => {
      const count = countIn(rows, period);
      const before = anyBefore(rows, period);
      const empty: Presence = flow ? (before ? 'quiet' : 'none') : (before ? 'carried' : 'none');
      return {
        period,
        count,
        state: count > 0 ? 'reported' : empty,
        note: count > 0
          ? `${count} ${unit} filed for this quarter`
          : empty === 'quiet'
            ? 'No movement this quarter, which is a complete answer'
            : empty === 'carried'
              ? `Nothing filed for this quarter; an earlier one has ${unit}`
              : `No ${unit} at all, up to this quarter`,
      };
    }),
  });

  /* --- the portfolio, which is the row everything else leans on --- */

  const portfolio: InventoryCell[] = periods.map((period) => {
    const expected = positions.filter((p) => isExpectedToReport(p, period));
    const reportedIds = new Set(
      valuations.filter((v) => v.period === period).map((v) => v.positionId),
    );
    const reported = expected.filter((p) => reportedIds.has(p.id)).length;
    const carried = expected.filter((p) => {
      const seen = firstSeen.get(p.id);
      return seen !== undefined && comparePeriods(seen, period) <= 0;
    }).length;

    if (expected.length === 0) {
      return {
        period, count: 0, of: 0, state: 'none',
        note: 'No holding was expected to report this quarter',
      };
    }
    const state: Presence = reported === expected.length ? 'reported'
      : reported > 0 ? 'partial'
        : carried > 0 ? 'carried'
          : 'none';
    return {
      period,
      count: reported,
      of: expected.length,
      state,
      note: state === 'carried'
        ? `No valuation filed this quarter; ${carried} of ${expected.length} holding(s) carry an earlier one`
        : `${reported} of ${expected.length} holding(s) valued for this quarter`,
    };
  });

  const cellAt = (cells: InventoryCell[], period: PeriodId) =>
    cells.find((cell) => cell.period === period)!;

  const balanceCells: InventoryCell[] = periods.map((period) => {
    const count = countIn(balanceSheets, period);
    const carried = count === 0 && anyBefore(balanceSheets, period);
    return {
      period,
      count,
      state: count > 0 ? 'reported' : carried ? 'carried' : 'none',
      note: count > 0
        ? 'Cash, other assets and liabilities filed for this quarter'
        : carried
          ? 'No balance sheet this quarter; the last known one is carried'
          : 'No balance sheet — the net tier is the portfolio alone',
    };
  });

  const rows: InventoryRow[] = [
    {
      id: 'valuations',
      counted: true,
      label: 'Holding valuations',
      description: 'A net asset value per holding, from the manager’s report or the administrator’s pack.',
      tier: 'filed',
      cells: portfolio,
    },
    simple(
      'portfolio-flows', 'Portfolio cashflows',
      'Calls, distributions and expenses between the product and its holdings.',
      portfolioFlows, 'movement(s)', true,
    ),
    simple(
      'company-values', 'Company valuations',
      'What each underlying company is worth. Only these make look-through possible.',
      assetValuations, 'company value(s)',
    ),
    {
      id: 'balance-sheet',
      counted: false,
      label: 'Balance sheet',
      description: 'Cash, other assets, liabilities and accruals at product level — everything outside the portfolio.',
      tier: 'filed',
      cells: balanceCells,
    },
    simple(
      'investor-flows', 'Investor cashflows',
      'Calls and distributions between the product and its limited partners.',
      investorFlows, 'movement(s)', true,
    ),
    {
      id: 'rates',
      counted: true,
      label: 'Exchange rates',
      description: 'One closing rate per currency the portfolio is stated in.',
      tier: 'filed',
      cells: periods.map((period) => {
        const filed = new Set(
          rates.filter((r) => r.period === period).flatMap((r) => [r.base, r.quote]),
        );
        const have = needed.filter((code) => filed.has(code)).length;
        const carried = have === 0 && anyBefore(rates, period);
        const state: Presence = needed.length === 0 ? 'reported'
          : have === needed.length ? 'reported'
            : have > 0 ? 'partial'
              : carried ? 'carried' : 'none';
        return {
          period,
          count: have,
          of: needed.length,
          state,
          note: needed.length === 0
            ? 'Every holding is in the product’s own currency; no rate is needed'
            : state === 'carried'
              ? 'No rate filed for this quarter; the last known one is carried'
              : `${have} of ${needed.length} currency(ies) have a rate for this quarter`,
        };
      }),
    },
    simple(
      'esg', 'ESG metrics',
      'Sustainability figures per holding or company. Nothing else depends on them.',
      esg.map((m) => ({ period: m.period })), 'metric(s)',
    ),

    /* --- what can be produced --- */

    {
      id: 'gross',
      counted: true,
      label: 'Portfolio, gross',
      description: 'The portfolio on its own terms: NAV, commitments, multiples, before anything the product charges.',
      tier: 'derived',
      cells: periods.map((period) => {
        const source = cellAt(portfolio, period);
        return {
          period,
          count: source.count,
          of: source.of,
          state: source.state,
          note: source.state === 'reported' ? 'Every holding reported — final'
            : source.state === 'partial' ? 'A draft: some holdings are carried or estimated'
              : source.state === 'carried' ? 'A draft built entirely on earlier valuations'
                : 'Nothing to compute from',
        };
      }),
    },
    {
      id: 'exposure',
      counted: true,
      label: 'Allocation and currency',
      description: 'How the portfolio is spread by sector, region, currency and vintage. Needs the holdings only.',
      tier: 'derived',
      cells: periods.map((period) => {
        const source = cellAt(portfolio, period);
        return {
          period, count: source.count, of: source.of, state: source.state,
          note: source.state === 'none'
            ? 'No portfolio to allocate'
            : 'Follows the portfolio: allocation needs no more than the holdings',
        };
      }),
    },
    {
      id: 'look-through',
      counted: true,
      label: 'Look-through',
      description: 'The same exposure at company level, seen through the funds. Needs company valuations.',
      tier: 'derived',
      cells: periods.map((period) => {
        const count = countIn(assetValuations, period);
        const carried = count === 0 && anyBefore(assetValuations, period);
        const state: Presence = count > 0 ? 'reported' : carried ? 'carried' : 'none';
        return {
          period,
          count,
          state,
          note: state === 'none'
            ? 'No company valuations — the portfolio is shown on its holdings’ own attributes'
            : state === 'carried'
              ? 'Built on company valuations from an earlier quarter'
              : `${count} company value(s) for this quarter`,
        };
      }),
    },
    {
      id: 'net',
      counted: false,
      label: 'Net, at product level',
      description: 'The portfolio plus cash and other assets, less liabilities and accruals — what the product is worth.',
      tier: 'derived',
      cells: periods.map((period) => {
        const gross = cellAt(portfolio, period);
        const balance = cellAt(balanceCells, period);
        if (gross.state === 'none') {
          return { period, count: 0, state: 'none', note: 'No portfolio, so no net asset value' };
        }
        const state = weakestOf([gross.state, balance.state === 'none' ? 'partial' : balance.state]);
        return {
          period,
          count: balance.count,
          state,
          note: balance.state === 'none'
            ? 'Portfolio only — no cash or accruals filed, so this will not tie to the financials'
            : balance.state === 'carried'
              ? 'Cash and accruals carried from an earlier quarter'
              : gross.state === 'reported'
                ? 'Portfolio and balance sheet both filed for this quarter'
                : 'Balance sheet filed; the portfolio underneath it is a draft',
        };
      }),
    },
    {
      id: 'capital-accounts',
      counted: true,
      label: 'Capital accounts',
      description: 'Each limited partner’s position: called, distributed, and their share of the net asset value.',
      tier: 'derived',
      cells: periods.map((period) => {
        if (investors.length === 0) {
          return {
            period, count: 0, state: 'none',
            note: 'No investor is on file for this product',
          };
        }
        const flows = countIn(investorFlows, period);
        const before = anyBefore(investorFlows, period);
        const gross = cellAt(portfolio, period);
        const state: Presence = gross.state === 'none' ? 'none'
          : flows > 0 ? weakestOf([gross.state, 'reported'])
            : before ? weakestOf([gross.state, 'quiet']) : 'none';
        return {
          period,
          count: flows,
          state,
          note: state === 'none' ? 'Nothing to allocate to investors yet'
            : flows > 0
              ? `${investors.length} investor(s), ${flows} movement(s) this quarter`
              : `${investors.length} investor(s), no movement this quarter`,
        };
      }),
    },
    {
      id: 'report',
      counted: false,
      label: 'Report',
      description: 'A pack can be produced for this quarter. Its basis is the weakest of everything above it.',
      tier: 'derived',
      cells: periods.map((period) => {
        const gross = cellAt(portfolio, period);
        const balance = cellAt(balanceCells, period);
        if (gross.state === 'none') {
          return { period, count: 0, state: 'none', note: 'Nothing to report on' };
        }
        const state = weakestOf([gross.state, balance.state === 'none' ? 'partial' : balance.state]);
        return {
          period,
          count: 1,
          state,
          note: state === 'reported'
            ? 'Everything this quarter needs is filed — the pack would be final'
            : 'The pack would carry a draft banner, and say what is missing',
        };
      }),
    },
  ];

  return {
    periods,
    rows,
    first: touched[0],
    last: touched[touched.length - 1],
  };
}

/** Which quarter each row was last filed for. Used for the summary line. */
export function lastFiled(inventory: Inventory, rowId: string): PeriodId | undefined {
  const row = inventory.rows.find((r) => r.id === rowId);
  if (!row) return undefined;
  const filed = row.cells.filter((cell) => cell.state === 'reported' || cell.state === 'partial');
  return filed[filed.length - 1]?.period;
}

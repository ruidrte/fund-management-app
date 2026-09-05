/**
 * Proving the workbook carries the book.
 *
 * The emitted workbook is what the report is built from, so the question that
 * matters about it is not whether it opens — it is whether anything in the book
 * failed to reach it. A figure that quietly does not survive the write is worse
 * than one that fails loudly, because the report is built from the file and
 * nobody looks at the book again.
 *
 * So the file is written, read back with the same reader that reads the
 * manager's own, and the two are compared. What comes back has different
 * identifiers — they are derived, and the emitted workbook is not the file that
 * was imported — so everything is matched on what it says rather than on what
 * it is called. A difference is reported as the thing it is about, in the words
 * of the screen rather than of the schema.
 *
 * This is the same comparison the tests make. Deliberately: a check that runs
 * in the build and a check somebody can run on their own book have to agree, or
 * the one that passes is the one nobody believes.
 */

import type { DataSet, Metric } from '../domain/types';
import type { PeriodId } from '../domain/period';
import { formatPeriod } from '../domain/period';
import type { ImportPlan } from '../ingest/pfdb';
import type { WorkbookShape } from './workbooks';

export interface Difference {
  /** What the difference is about, in a person's terms. */
  what: string;
  /** How many of that thing differ. */
  count: number;
  /** Up to a handful of examples, so the cause is findable without a diff. */
  examples: string[];
}

export interface Verification {
  ok: boolean;
  /** Facts compared, so "no differences" is distinguishable from "nothing checked". */
  compared: number;
  differences: Difference[];
  /** Anything that stopped the check running at all. */
  failure?: string;
}

/* ------------------------------------------------------------------ *
 * What each kind of fact says about itself
 *
 * A fact is compared on its content and never on its identifier, because the
 * identifier of a re-read fact belongs to the file it was read from. The name a
 * holding or a property goes by is what carries across, which is also what a
 * person would use to find it.
 * ------------------------------------------------------------------ */

interface Facts {
  positions: string[];
  valuations: string[];
  cashflows: string[];
  investors: string[];
  assets: string[];
  assetValuations: string[];
  metrics: string[];
  balanceSheets: string[];
  rates: string[];
}

const KIND: Array<[keyof Facts, string]> = [
  ['positions', 'holding'],
  ['valuations', 'valuation'],
  ['cashflows', 'movement'],
  ['investors', 'investor'],
  ['assets', 'company or property'],
  ['assetValuations', 'company value'],
  ['metrics', 'reported figure'],
  ['balanceSheets', 'balance sheet'],
  ['rates', 'exchange rate'],
];

const round = (value: number | undefined): string =>
  (value === undefined ? '—' : String(Math.round(value * 1e6) / 1e6));

function describe(metric: Metric): string {
  return `${metric.scope.kind} ${metric.period} ${metric.metric} = `
    + `${metric.value !== undefined ? round(metric.value) : JSON.stringify(metric.text)}`;
}

/**
 * The book, reduced to the facts about one product that a workbook can carry.
 *
 * Names rather than identifiers throughout, and a property's name qualified by
 * the holding it sits in: two funds can hold a company of the same name, and
 * they are two positions in it rather than one.
 */
function factsOfBook(dataset: DataSet, vehicleId: string, periods: Set<PeriodId>): Facts {
  const positions = dataset.positions.filter((p) => p.vehicleId === vehicleId);
  const byPosition = new Map(positions.map((p) => [p.id, p.name]));
  const assets = dataset.assets.filter((a) => byPosition.has(a.positionId));
  const byAsset = new Map(assets.map((a) => [a.id, `${byPosition.get(a.positionId)}/${a.name}`]));
  const investors = dataset.investors.filter((i) => i.vehicleId === vehicleId);

  const within = (period: PeriodId) => periods.size === 0 || periods.has(period);

  return {
    positions: positions.map(
      (p) => `${p.name} · ${p.currency} · ${round(p.commitment)} · ${round(p.ownership)} · ${p.commitmentDate}`,
    ).sort(),
    valuations: newest(
      dataset.positionValuations.filter((v) => byPosition.has(v.positionId) && within(v.period)),
      (v) => `${v.positionId}/${v.period}`,
    ).map(
      (v) => `${byPosition.get(v.positionId)} · ${v.period} · ${round(v.nav)} · `
        + `${round(v.drawnCumulative)} · ${round(v.distributedCumulative)}`,
    ).sort(),
    cashflows: dataset.cashflows.filter((c) => c.vehicleId === vehicleId).map(
      (c) => `${c.type} · ${c.date} · ${round(c.amount)} · ${c.investorId ? 'holder' : 'portfolio'}`,
    ).sort(),
    investors: investors.map((i) => `${i.name} · ${round(i.commitment)}`).sort(),
    assets: assets.map(
      (a) => `${byAsset.get(a.id)} · ${a.region} · ${a.country} · ${round(a.ownership)}`,
    ).sort(),
    assetValuations: newest(
      dataset.assetValuations.filter((v) => byAsset.has(v.assetId) && within(v.period)),
      (v) => `${v.assetId}/${v.period}`,
    ).map(
      (v) => `${byAsset.get(v.assetId)} · ${v.period} · ${round(v.invested)} · `
        + `${round(v.realised)} · ${round(v.unrealised)}`,
    ).sort(),
    // Vehicle-scoped metrics are compared as well as the others: a figure filed
    // against the product itself has no column in this workbook, and a check
    // that ignored it would be silent about exactly the case it exists for.
    metrics: newest(
      dataset.metrics.filter(
        (m) => (byAsset.has(m.scope.id) || byPosition.has(m.scope.id) || m.scope.id === vehicleId)
          && within(m.period),
      ),
      (m) => `${m.scope.id}/${m.metric}/${m.period}`,
    ).map(
      (m) => `${byAsset.get(m.scope.id) ?? byPosition.get(m.scope.id) ?? 'the product'} · ${describe(m)}`,
    ).sort(),
    balanceSheets: newest(
      dataset.balanceSheets.filter((b) => b.vehicleId === vehicleId && within(b.period)),
      (b) => b.period,
    ).map(
      (b) => `${b.period} · ${round(b.cash)} · ${round(b.otherAssets)} · `
        + `${round(b.currentLiabilities)} · ${round(b.accruedExpenses)}`,
    ).sort(),
    rates: dataset.fxRates.filter((r) => within(r.period)).map(
      (r) => `${r.base}/${r.quote} · ${r.date} · ${r.kind} · ${round(r.rate)}`,
    ).sort(),
  };
}

/** The same reduction over what came back out of the emitted workbook. */
function factsOfPlan(plan: ImportPlan, periods: Set<PeriodId>): Facts {
  return factsOfBook(
    {
      positions: plan.positions,
      assets: plan.assets,
      investors: plan.investors,
      positionValuations: plan.valuations,
      assetValuations: plan.assetValuations,
      cashflows: plan.cashflows,
      metrics: plan.metrics,
      fxRates: plan.fxRates,
      balanceSheets: plan.balanceSheets,
      client: { id: '', name: '', shortName: '', reportingCurrency: '' },
      vehicles: [],
    },
    plan.vehicleId,
    periods,
  );
}

function newest<T extends { recordedAt: string }>(rows: T[], key: (row: T) => string): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const at = key(row);
    const held = best.get(at);
    if (!held || Date.parse(row.recordedAt) >= Date.parse(held.recordedAt)) best.set(at, row);
  }
  return [...best.values()];
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

export interface VerifyOptions {
  dataset: DataSet;
  vehicleId: string;
  period: PeriodId;
  knowledgeDate?: string;
  /** The reader and writer to put back to back. */
  shape: WorkbookShape;
}

export function verifyWorkbook(options: VerifyOptions): Verification {
  const { dataset, vehicleId, period, knowledgeDate, shape } = options;

  let plan: ImportPlan;
  try {
    const written = shape.write({ dataset, vehicleId, period, knowledgeDate });
    plan = shape.read(written.sheets, vehicleId);
  } catch (cause) {
    return {
      ok: false,
      compared: 0,
      differences: [],
      failure: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // The workbook is written for one quarter and the histories behind it, so it
  // is compared over the quarters it actually carries. A quarter the book knows
  // about and the workbook does not reach is a difference; a quarter neither
  // has is not.
  const periods = new Set<PeriodId>(plan.periods);

  const mine = factsOfBook(dataset, vehicleId, periods);
  const theirs = factsOfPlan(plan, periods);

  const differences: Difference[] = [];
  let compared = 0;

  for (const [key, noun] of KIND) {
    const expected = mine[key];
    const found = new Set(theirs[key]);
    compared += expected.length;

    const lost = expected.filter((row) => !found.has(row));
    if (lost.length > 0) {
      differences.push({
        what: `${noun}${lost.length === 1 ? '' : 's'} the workbook does not carry`,
        count: lost.length,
        examples: lost.slice(0, 5),
      });
    }

    const held = new Set(expected);
    const extra = theirs[key].filter((row) => !held.has(row));
    if (extra.length > 0) {
      differences.push({
        what: `${noun}${extra.length === 1 ? '' : 's'} the workbook states that the book does not`,
        count: extra.length,
        examples: extra.slice(0, 5),
      });
    }
  }

  return { ok: differences.length === 0, compared, differences };
}

/** One line for a screen, saying what was checked and how it went. */
export function summariseVerification(result: Verification, period: PeriodId): string {
  if (result.failure) return `The check could not run: ${result.failure}`;
  if (result.ok) {
    return `${result.compared.toLocaleString('en-GB')} facts written and read back unchanged, `
      + `covering ${formatPeriod(period)} and the history behind it.`;
  }
  const total = result.differences.reduce((sum, row) => sum + row.count, 0);
  return `${total.toLocaleString('en-GB')} of ${result.compared.toLocaleString('en-GB')} facts `
    + 'did not survive being written and read back.';
}

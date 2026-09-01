/**
 * Point-in-time selection.
 *
 * Two independent axes run through the fact tables:
 *
 *   period        — which quarter a figure describes
 *   recordedAt    — when the figure entered the system
 *
 * A quarterly report is a slice of the first axis. Reproducing what was
 * *published* for that quarter is a slice of both: pin `knowledgeDate` to the
 * publication date and every later restatement disappears. Without the second
 * axis a historical quarter silently drifts as corrections arrive, and the
 * report you re-run in March no longer matches the one you signed in January.
 */

import { comparePeriods, type PeriodId } from '../domain/period';

interface Temporal {
  period: PeriodId;
  recordedAt: string;
}

/** Rows visible at `knowledgeDate`. Undefined means "everything known now". */
export function visibleAt<T extends Temporal>(rows: T[], knowledgeDate?: string): T[] {
  if (!knowledgeDate) return rows;
  const cutoff = Date.parse(knowledgeDate);
  if (Number.isNaN(cutoff)) throw new Error(`Not a timestamp: ${knowledgeDate}`);
  return rows.filter((row) => Date.parse(row.recordedAt) <= cutoff);
}

/** Rows describing exactly `period`, restricted to what was known at `knowledgeDate`. */
export function forPeriod<T extends Temporal>(
  rows: T[],
  period: PeriodId,
  knowledgeDate?: string,
): T[] {
  return visibleAt(rows, knowledgeDate).filter((row) => row.period === period);
}

/** Rows describing `period` or anything earlier — the inception-to-date set. */
export function throughPeriod<T extends Temporal>(
  rows: T[],
  period: PeriodId,
  knowledgeDate?: string,
): T[] {
  return visibleAt(rows, knowledgeDate).filter(
    (row) => comparePeriods(row.period, period) <= 0,
  );
}

/**
 * The single row that stands for `period` — the latest recorded row for the
 * latest period at or before `period`. Returns undefined when nothing qualifies.
 *
 * This is what makes a late-arriving restatement win over the original filing
 * while a *future* restatement stays invisible behind `knowledgeDate`.
 */
export function latestThrough<T extends Temporal>(
  rows: T[],
  period: PeriodId,
  knowledgeDate?: string,
): T | undefined {
  const candidates = throughPeriod(rows, period, knowledgeDate);
  if (candidates.length === 0) return undefined;

  return candidates.reduce((best, row) => {
    const byPeriod = comparePeriods(row.period, best.period);
    if (byPeriod !== 0) return byPeriod > 0 ? row : best;
    return Date.parse(row.recordedAt) >= Date.parse(best.recordedAt) ? row : best;
  });
}

/** Every period for which at least one row exists, chronological. */
export function knownPeriods<T extends Temporal>(rows: T[], knowledgeDate?: string): PeriodId[] {
  const seen = new Set(visibleAt(rows, knowledgeDate).map((row) => row.period));
  return [...seen].sort(comparePeriods);
}

/**
 * Timestamps at which the visible picture changes. Offering these as the
 * selectable "as-at" values keeps the user from picking a date that reproduces
 * a view nobody ever saw.
 */
export function restatementDates<T extends Temporal>(rows: T[]): string[] {
  const seen = new Set(rows.map((row) => row.recordedAt));
  return [...seen].sort();
}

/**
 * Quarter arithmetic.
 *
 * The canonical identifier is `YYYYQn` ("2026Q1"). It sorts lexicographically in
 * chronological order, which is why it — and not "Q1 2026" — is what gets stored,
 * keyed and compared. "Q1 2026" is a display form produced by `formatPeriod`.
 */

export type PeriodId = string; // `${year}Q${quarter}`, e.g. "2026Q1"

export interface Period {
  id: PeriodId;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Last calendar day of the quarter, ISO `YYYY-MM-DD`. */
  endDate: string;
  /** First calendar day of the quarter, ISO `YYYY-MM-DD`. */
  startDate: string;
  label: string; // "Q1 2026"
  longLabel: string; // "31 March 2026"
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const QUARTER_END_MONTH_DAY: Record<number, [number, number]> = {
  1: [3, 31],
  2: [6, 30],
  3: [9, 30],
  4: [12, 31],
};

const PERIOD_RE = /^(\d{4})Q([1-4])$/;
const LEGACY_RE = /^Q([1-4])\s+(\d{4})$/;

/** Parses "2026Q1" or the legacy "Q1 2026" display form. Throws on anything else. */
export function parsePeriodId(value: string): Period {
  const trimmed = value.trim();
  let year: number;
  let quarter: number;

  const canonical = PERIOD_RE.exec(trimmed);
  if (canonical) {
    year = Number(canonical[1]);
    quarter = Number(canonical[2]);
  } else {
    const legacy = LEGACY_RE.exec(trimmed);
    if (!legacy) throw new Error(`Not a quarter identifier: "${value}"`);
    quarter = Number(legacy[1]);
    year = Number(legacy[2]);
  }

  return makePeriod(year, quarter as 1 | 2 | 3 | 4);
}

export function makePeriod(year: number, quarter: 1 | 2 | 3 | 4): Period {
  const [endMonth, endDay] = QUARTER_END_MONTH_DAY[quarter];
  const startMonth = endMonth - 2;
  const pad = (n: number) => String(n).padStart(2, '0');

  return {
    id: `${year}Q${quarter}`,
    year,
    quarter,
    startDate: `${year}-${pad(startMonth)}-01`,
    endDate: `${year}-${pad(endMonth)}-${pad(endDay)}`,
    label: `Q${quarter} ${year}`,
    longLabel: `${endDay} ${MONTH_NAMES[endMonth - 1]} ${year}`,
  };
}

/** Negative when `a` is earlier, positive when later, zero when equal. */
export function comparePeriods(a: PeriodId, b: PeriodId): number {
  const pa = parsePeriodId(a);
  const pb = parsePeriodId(b);
  return pa.year !== pb.year ? pa.year - pb.year : pa.quarter - pb.quarter;
}

export function previousPeriod(id: PeriodId, count = 1): PeriodId {
  return shiftPeriod(id, -count);
}

export function nextPeriod(id: PeriodId, count = 1): PeriodId {
  return shiftPeriod(id, count);
}

export function shiftPeriod(id: PeriodId, quarters: number): PeriodId {
  const { year, quarter } = parsePeriodId(id);
  const absolute = year * 4 + (quarter - 1) + quarters;
  const newYear = Math.floor(absolute / 4);
  const newQuarter = (absolute % 4) + 1;
  return `${newYear}Q${newQuarter}`;
}

/** Inclusive range from `from` to `to`, chronological. Empty when `from` is after `to`. */
export function periodRange(from: PeriodId, to: PeriodId): PeriodId[] {
  if (comparePeriods(from, to) > 0) return [];
  const out: PeriodId[] = [];
  let cursor = from;
  // Bounded so a malformed input can never spin: 200 years of quarters.
  for (let i = 0; i < 800; i += 1) {
    out.push(cursor);
    if (cursor === to) return out;
    cursor = nextPeriod(cursor);
  }
  throw new Error(`Period range ${from}..${to} exceeds the supported span`);
}

/** How many quarters separate the two periods (`to` minus `from`). */
export function periodsBetween(from: PeriodId, to: PeriodId): number {
  const a = parsePeriodId(from);
  const b = parsePeriodId(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

export function formatPeriod(id: PeriodId): string {
  return parsePeriodId(id).label;
}

export function periodEndDate(id: PeriodId): string {
  return parsePeriodId(id).endDate;
}

/** The quarter a calendar date falls in. */
export function periodForDate(date: string | Date): PeriodId {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${String(date)}`);
  const quarter = (Math.floor(d.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  return `${d.getUTCFullYear()}Q${quarter}`;
}

/** Sorts period ids chronologically without mutating the input. */
export function sortPeriods(ids: PeriodId[], direction: 'asc' | 'desc' = 'asc'): PeriodId[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...ids].sort((a, b) => sign * comparePeriods(a, b));
}

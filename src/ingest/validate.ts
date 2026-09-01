/**
 * Validating candidates before they become facts.
 *
 * This is the last point at which a bad figure is cheap to stop. After commit
 * it is a row in an append-only table that every subsequent report reads, and
 * correcting it means a restatement.
 *
 * The rules divide into three:
 *
 *   errors    the candidate cannot be committed at all
 *   warnings  it can, but somebody should look
 *   duplicates it already exists, so committing would double-count
 *
 * A warning is not a weaker error. It exists for the cases where the system
 * genuinely cannot know — a NAV that moved 60% in a quarter is either a
 * write-down or a typo, and only a person can say which.
 */

import { comparePeriods, parsePeriodId, type PeriodId } from '../domain/period';
import type { Cashflow, DataSet, PositionValuation } from '../domain/types';
import { latestThrough } from '../engine/asof';
import { CONFIDENT } from './match';
import { REVIEW_THRESHOLD, type Candidate, type Issue } from './types';

/** A period-on-period move beyond this is flagged for a human to confirm. */
const LARGE_MOVE = 0.4;

export interface ValidationContext {
  dataset: DataSet;
  /** Candidates being committed together, so duplicates within a batch are caught. */
  batch: Candidate[];
}

export function validate(candidate: Candidate, context: ValidationContext): Candidate {
  const issues: Issue[] = [];

  checkMatch(candidate, issues);
  checkFieldConfidence(candidate, issues);

  switch (candidate.kind) {
    case 'position-valuation':
      checkValuation(candidate, context, issues);
      break;
    case 'cashflow':
      checkCashflow(candidate, context, issues);
      break;
    case 'balance-sheet':
      checkBalanceSheet(candidate, issues);
      break;
    default:
      break;
  }

  const duplicateOf = findDuplicate(candidate, context);
  if (duplicateOf) {
    issues.push({
      severity: 'warning',
      message:
        'An identical record already exists for this period. Committing would double-count it; '
        + 'commit only if this is genuinely a second movement.',
    });
  }

  return { ...candidate, issues, duplicateOf };
}

export function validateAll(candidates: Candidate[], dataset: DataSet): Candidate[] {
  const context: ValidationContext = { dataset, batch: candidates };
  return candidates.map((candidate) => validate(candidate, context));
}

export function canCommit(candidate: Candidate): boolean {
  return candidate.issues.every((issue) => issue.severity !== 'error');
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

function checkMatch(candidate: Candidate, issues: Issue[]): void {
  const match = candidate.match;
  if (!match) return;

  if (!match.id) {
    issues.push({
      severity: 'error',
      field: 'match',
      message: match.alternatives.length > 0
        ? `"${match.sourceName}" did not match any known ${match.kind} confidently. Choose one, or the row cannot be filed.`
        : `"${match.sourceName}" matches no known ${match.kind}. Create it first, or correct the name.`,
    });
    return;
  }

  if (match.confidence < CONFIDENT) {
    issues.push({
      severity: 'warning',
      field: 'match',
      message:
        `"${match.sourceName}" was matched to "${match.matchedName}" at ${(match.confidence * 100).toFixed(0)}% confidence. `
        + 'Confirm it — a valuation filed against the wrong holding is worse than one not filed.',
    });
  }
}

function checkFieldConfidence(candidate: Candidate, issues: Issue[]): void {
  for (const [name, value] of Object.entries(candidate.fields)) {
    if (value.confidence < REVIEW_THRESHOLD) {
      issues.push({
        severity: 'warning',
        field: name,
        message: `"${name}" was read at ${(value.confidence * 100).toFixed(0)}% confidence`
          + (value.locator ? ` from ${value.locator}` : '')
          + '. Confirm the value.',
      });
    }
  }
}

function checkValuation(candidate: Candidate, context: ValidationContext, issues: Issue[]): void {
  const period = stringField(candidate, 'period');
  const nav = numberField(candidate, 'nav');

  if (!period || !isPeriod(period)) {
    issues.push({ severity: 'error', field: 'period', message: 'A valid quarter is required.' });
    return;
  }
  if (nav === undefined) {
    issues.push({ severity: 'error', field: 'nav', message: 'A net asset value is required.' });
    return;
  }
  if (nav < 0) {
    issues.push({
      severity: 'warning', field: 'nav',
      message: 'Net asset value is negative. Legitimate for a fund carrying a liability, unusual otherwise.',
    });
  }

  // A period ahead of the calendar is nearly always a mistyped year.
  const now = new Date();
  const currentPeriod = `${now.getUTCFullYear()}Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  if (comparePeriods(period, currentPeriod) > 0) {
    issues.push({
      severity: 'error', field: 'period',
      message: `${period} is in the future. Check the year.`,
    });
  }

  const positionId = candidate.match?.id;
  if (!positionId) return;

  // Compare against what this holding was last worth. A large unexplained move
  // is the single most common symptom of a units error or a wrong column.
  const priorRows = context.dataset.positionValuations.filter(
    (v) => v.positionId === positionId && !v.supersededBy && comparePeriods(v.period, period) < 0,
  );
  const prior = latestThrough(priorRows, period);
  if (prior && prior.nav !== 0) {
    const move = (nav - prior.nav) / Math.abs(prior.nav);
    if (Math.abs(move) > LARGE_MOVE) {
      issues.push({
        severity: 'warning', field: 'nav',
        message:
          `Net asset value moves ${(move * 100).toFixed(0)}% from ${prior.period} `
          + `(${prior.nav.toLocaleString('en-GB')} to ${nav.toLocaleString('en-GB')}). `
          + 'Confirm this is a real revaluation and not a units or column error.',
      });
    }
  }

  const drawn = numberField(candidate, 'drawnCumulative');
  const position = context.dataset.positions.find((p) => p.id === positionId);
  if (drawn !== undefined && position && drawn > position.commitment * 1.05) {
    issues.push({
      severity: 'warning', field: 'drawnCumulative',
      message:
        `Cumulative drawn (${drawn.toLocaleString('en-GB')}) exceeds the recorded commitment `
        + `(${position.commitment.toLocaleString('en-GB')}). Either the commitment is stale or this is recycling.`,
    });
  }
}

function checkCashflow(candidate: Candidate, context: ValidationContext, issues: Issue[]): void {
  const amount = numberField(candidate, 'amount');
  const date = stringField(candidate, 'date');
  const period = stringField(candidate, 'period');
  const currency = stringField(candidate, 'currency');

  if (amount === undefined || amount === 0) {
    issues.push({ severity: 'error', field: 'amount', message: 'A non-zero amount is required.' });
  }
  if (!date || Number.isNaN(Date.parse(date))) {
    issues.push({ severity: 'error', field: 'date', message: 'A valid date is required.' });
  }
  if (!period || !isPeriod(period)) {
    issues.push({ severity: 'error', field: 'period', message: 'A valid quarter is required.' });
  }
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    issues.push({ severity: 'error', field: 'currency', message: 'A three-letter currency code is required.' });
  }

  // The date and the period must agree, or the flow lands in a quarter its own
  // date contradicts and every bridge built on it stops closing.
  if (date && period && isPeriod(period) && !Number.isNaN(Date.parse(date))) {
    const derived = periodOf(date);
    if (derived !== period) {
      issues.push({
        severity: 'error', field: 'period',
        message: `The date ${date} falls in ${derived}, but the period says ${period}.`,
      });
    }
  }

  const type = stringField(candidate, 'type');
  if (type === 'Capital Call' && amount !== undefined && amount > 0) {
    issues.push({
      severity: 'warning', field: 'amount',
      message: 'A capital call is money leaving the vehicle and should be negative.',
    });
  }
  if (type === 'Distribution' && amount !== undefined && amount < 0) {
    issues.push({
      severity: 'warning', field: 'amount',
      message: 'A distribution is money arriving and should be positive.',
    });
  }

  // A currency that disagrees with the holding it is filed against is usually a
  // column misread, and translating it would bury the error in an FX effect.
  const positionId = candidate.match?.id;
  const position = context.dataset.positions.find((p) => p.id === positionId);
  if (position && currency && currency !== position.currency) {
    issues.push({
      severity: 'warning', field: 'currency',
      message: `${currency} differs from the holding's own currency (${position.currency}). Confirm before filing.`,
    });
  }
}

function checkBalanceSheet(candidate: Candidate, issues: Issue[]): void {
  const period = stringField(candidate, 'period');
  if (!period || !isPeriod(period)) {
    issues.push({ severity: 'error', field: 'period', message: 'A valid quarter is required.' });
  }

  for (const name of ['currentLiabilities', 'accruedExpenses'] as const) {
    const value = numberField(candidate, name);
    if (value !== undefined && value < 0) {
      issues.push({
        severity: 'warning', field: name,
        message:
          `${name} is negative. Liabilities are stored positive and subtracted by the engine; `
          + 'a negative here subtracts twice.',
      });
    }
  }

  const total = (['cash', 'otherAssets', 'currentLiabilities', 'accruedExpenses'] as const)
    .map((name) => numberField(candidate, name) ?? 0)
    .reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    issues.push({
      severity: 'warning',
      message: 'Every balance-sheet line is zero. Confirm the pack was read correctly before filing it.',
    });
  }
}

/* ------------------------------------------------------------------ *
 * Duplicates
 * ------------------------------------------------------------------ */

function findDuplicate(candidate: Candidate, context: ValidationContext): string | undefined {
  if (candidate.kind === 'position-valuation') {
    const positionId = candidate.match?.id;
    const period = stringField(candidate, 'period');
    const nav = numberField(candidate, 'nav');
    if (!positionId || !period || nav === undefined) return undefined;

    // A *restatement* is a new row and is expected. Only an identical figure
    // for the same period is a duplicate worth stopping.
    const existing = context.dataset.positionValuations.find(
      (v: PositionValuation) =>
        v.positionId === positionId && v.period === period && closeEnough(v.nav, nav),
    );
    return existing?.id;
  }

  if (candidate.kind === 'cashflow') {
    const positionId = candidate.match?.id;
    const amount = numberField(candidate, 'amount');
    const date = stringField(candidate, 'date');
    if (amount === undefined || !date) return undefined;

    const existing = context.dataset.cashflows.find(
      (c: Cashflow) =>
        c.positionId === positionId && c.date === date && closeEnough(c.amount, amount),
    );
    return existing?.id;
  }

  return undefined;
}

function closeEnough(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale < 1e-6;
}

/* ------------------------------------------------------------------ *
 * Field access
 * ------------------------------------------------------------------ */

export function stringField(candidate: Candidate, name: string): string | undefined {
  const value = candidate.fields[name]?.value;
  return typeof value === 'string' ? value : undefined;
}

export function numberField(candidate: Candidate, name: string): number | undefined {
  const value = candidate.fields[name]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function booleanField(candidate: Candidate, name: string): boolean | undefined {
  const value = candidate.fields[name]?.value;
  return typeof value === 'boolean' ? value : undefined;
}

function isPeriod(value: string): value is PeriodId {
  try {
    parsePeriodId(value);
    return true;
  } catch {
    return false;
  }
}

function periodOf(date: string): PeriodId {
  const parsed = new Date(date);
  return `${parsed.getUTCFullYear()}Q${Math.floor(parsed.getUTCMonth() / 3) + 1}`;
}

/**
 * Entity matching.
 *
 * A document says "Nordic Growth Partners IV"; the database has
 * "Nordic Growth Partners IV SCSp". A GP writes "NGP IV". An administrator's
 * trial balance writes "NORDIC GROWTH IV (EUR)". All four mean the same
 * holding, and none of them is an exact string match.
 *
 * The scoring below is deliberately simple and deterministic — normalise, then
 * combine token overlap with an edit-distance ratio. A cleverer matcher that
 * nobody can reason about is worse here than a plain one whose mistakes are
 * predictable, because every match is reviewed anyway and the reviewer needs to
 * understand why something scored the way it did.
 *
 * What matters more than the algorithm is what happens at the margins: a
 * confident match is proposed, an unconfident one is proposed *with its
 * alternatives*, and no match at all blocks the candidate rather than inventing
 * an entity.
 */

import type { EntityMatch, MatchContext } from './types';

/** At or above this, a match is presented as settled. */
export const CONFIDENT = 0.88;
/** Below this, no match is proposed at all. */
export const FLOOR = 0.45;

/**
 * Legal-form suffixes and wrappers that carry no identifying information.
 * Stripping them is what makes "Fund IV SCSp" match "Fund IV".
 */
const NOISE = new Set([
  'lp', 'llp', 'llc', 'ltd', 'limited', 'plc', 'inc', 'corp', 'sa', 'sarl',
  'scsp', 'sca', 'sicav', 'sif', 'raif', 'fcp', 'kg', 'gmbh', 'ag', 'bv', 'nv',
  'ab', 'as', 'oy', 'spa', 'srl', 'cv', 'fund', 'funds', 'the', 'of', 'and',
  'partners', 'capital', 'investments', 'investment', 'holdings', 'holding',
]);

/** Roman numerals map to digits, so "Fund IV" and "Fund 4" are the same fund. */
const ROMAN: Record<string, string> = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8',
  ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15',
};

export function normalise(value: string): string {
  return value
    .toLowerCase()
    // Strip accents so "Société" matches "Societe".
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // A parenthesised currency or share class is noise for matching purposes.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(value: string): string[] {
  return normalise(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => ROMAN[token] ?? token);
}

/** Tokens that actually distinguish one fund from another. */
function significant(value: string): string[] {
  const all = tokens(value);
  const kept = all.filter((token) => !NOISE.has(token));
  // A name made entirely of noise words still has to match on something.
  return kept.length > 0 ? kept : all;
}

/**
 * 0..1. Combines how much of the shorter name's vocabulary is present in the
 * longer one with a character-level similarity, so neither a reordering nor a
 * spelling variation alone defeats it.
 */
export function similarity(a: string, b: string): number {
  const left = significant(a);
  const right = significant(b);
  if (left.length === 0 || right.length === 0) return 0;

  const rightSet = new Set(right);
  const shared = left.filter((token) => rightSet.has(token)).length;
  const overlap = shared / Math.min(left.length, right.length);

  const edit = ratio(left.join(' '), right.join(' '));

  // A version number that disagrees is disqualifying, not a small penalty:
  // Fund III and Fund IV are different funds that otherwise score identically.
  const leftNumbers = left.filter(isNumeric);
  const rightNumbers = right.filter(isNumeric);
  if (leftNumbers.length > 0 && rightNumbers.length > 0) {
    const agrees = leftNumbers.some((n) => rightNumbers.includes(n));
    if (!agrees) return Math.min(0.4, overlap * 0.5 + edit * 0.5);
  }

  return overlap * 0.65 + edit * 0.35;
}

function isNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

/** Levenshtein similarity, 0..1. */
export function ratio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Single-row dynamic programming: these strings are short and there are many
  // of them, so allocating a full matrix per comparison is wasteful.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    previous = current;
  }

  const distance = previous[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

export type MatchTarget = 'position' | 'investor' | 'vehicle' | 'asset';

/**
 * Proposes a match, always with its alternatives. Returning the runners-up is
 * what lets a reviewer correct a wrong match by clicking rather than by
 * searching, which is the difference between a review step people do and one
 * they skip.
 */
export function matchEntity(
  sourceName: string,
  target: MatchTarget,
  context: MatchContext,
  /** Restricts the search, e.g. to one vehicle's positions. */
  within?: { vehicleId?: string; positionId?: string },
): EntityMatch {
  const pool = candidatePool(target, context, within);

  const scored = pool
    .map((entry) => ({ ...entry, score: similarity(sourceName, entry.name) }))
    .filter((entry) => entry.score >= FLOOR)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  // Two candidates within a hair of each other is not a confident match, it is
  // an ambiguous one, and reporting it as confident is how a valuation ends up
  // on the wrong fund.
  const runnerUp = scored[1];
  const ambiguous = best && runnerUp && best.score - runnerUp.score < 0.06;

  return {
    kind: target,
    id: best && !ambiguous ? best.id : undefined,
    sourceName,
    matchedName: best && !ambiguous ? best.name : undefined,
    confidence: best ? (ambiguous ? Math.min(best.score, CONFIDENT - 0.01) : best.score) : 0,
    alternatives: scored.slice(0, 5).map((entry) => ({
      id: entry.id,
      name: entry.name,
      score: Number(entry.score.toFixed(3)),
    })),
  };
}

function candidatePool(
  target: MatchTarget,
  context: MatchContext,
  within?: { vehicleId?: string; positionId?: string },
): Array<{ id: string; name: string }> {
  switch (target) {
    case 'position':
      return context.positions
        .filter((p) => !within?.vehicleId || p.vehicleId === within.vehicleId)
        .map((p) => ({ id: p.id, name: p.name }));
    case 'investor':
      return context.investors
        .filter((i) => !within?.vehicleId || i.vehicleId === within.vehicleId)
        .map((i) => ({ id: i.id, name: i.name }));
    case 'asset':
      return context.assets
        .filter((a) => !within?.positionId || a.positionId === within.positionId)
        .map((a) => ({ id: a.id, name: a.name }));
    case 'vehicle':
    default:
      return context.vehicles.flatMap((v) => [
        { id: v.id, name: v.name },
        // A short code is often what appears in an administrator's pack.
        { id: v.id, name: v.shortName },
      ]);
  }
}

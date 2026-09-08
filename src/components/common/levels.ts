/**
 * Naming the two tiers a screen shows.
 *
 * "Gross" and "net" are what the tiers measure, not what they are about, and
 * for most products the difference does not matter: a fund-of-funds holds a
 * fund, the gross figures are that fund's and the net ones are the vehicle's
 * share of it, and naming either would repeat the holding's own name back.
 *
 * A mandate is where it matters. Pensionskasse Thurgau's interest in Rose
 * Affordable Housing Preservation Fund V is held through Fund V REIT LP: the
 * gross figures the manager publishes are the REIT LP's, the holder's own
 * position is a fraction of that, and the properties underneath are the whole
 * fund's. Three levels — and until the screen said so it called all three by
 * the fund's name, which is how somebody comes to read the REIT LP's return as
 * their own.
 *
 * The names come from the holdings in scope, so a screen naming them cannot
 * drift from the book. Where the holdings do not agree on a name there is no
 * one level to name, and the generic wording is the honest answer rather than
 * the first holding's name standing for all of them.
 */

import type { Position } from '../../domain/types';

export interface LevelNames {
  gross: string;
  net: string;
}

/** `a`, `a and b`, `a, b and c` — and nothing past a handful. */
function listed(names: string[]): string | undefined {
  if (names.length === 0 || names.length > 3) return undefined;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const GENERIC: LevelNames = {
  gross: 'the portfolio, before anything the vehicle charges',
  net: 'what the investor holds, after fees and expenses',
};

/**
 * What to call each tier for the holdings in scope.
 *
 * Falls back to the generic wording per tier rather than as a pair: a book
 * where the gross level has a name and the net one does not should say the
 * name it has.
 */
export function levelsOf(positions: Position[]): LevelNames {
  const distinct = (pick: (level: LevelNames) => string) => listed([...new Set(
    positions.map((position) => position.levels).filter(Boolean).map((level) => pick(level!)),
  )]);

  // Only where every holding says so. One of three holdings naming its level
  // would put that one name over figures that are mostly about the others.
  const named = positions.filter((position) => position.levels).length;
  if (named === 0 || named !== positions.length) return GENERIC;

  return {
    gross: distinct((level) => level.gross) ?? GENERIC.gross,
    net: distinct((level) => level.net) ?? GENERIC.net,
  };
}

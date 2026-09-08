/**
 * Naming the two tiers.
 *
 * Until the screen named them, a mandate's dashboard called three levels by
 * the fund's name: the REIT LP's gross figures, the holder's own position, and
 * the fund's whole property register, all under "Rose Affordable Housing
 * Preservation Fund V". That is how somebody comes to read a vehicle's return
 * as their own.
 */

import { describe, expect, it } from 'vitest';
import { levelsOf } from '../src/components/common/levels';
import type { Position } from '../src/domain/types';

const held = (name: string, levels?: { gross: string; net: string }): Position => ({
  id: `pos-${name}`, vehicleId: 'v', kind: 'fund', name, currency: 'USD',
  vintage: 2021, commitmentDate: '2021-01-01', commitment: 20_000_000, ownership: 1,
  assetClass: 'Real Estate', region: 'US', status: 'Investing', levels,
});

const GENERIC_GROSS = 'the portfolio, before anything the vehicle charges';
const GENERIC_NET = 'what the investor holds, after fees and expenses';

describe('what to call the two tiers', () => {
  it('names the vehicle the interest is held through, and the holder’s own position', () => {
    const names = levelsOf([
      held('RAHPF V', { gross: 'Fund V REIT LP', net: 'PK TG V' }),
      held('RAHPF VI', { gross: 'Fund VI REIT LP', net: 'PK TG VI' }),
    ]);
    expect(names.gross).toBe('Fund V REIT LP and Fund VI REIT LP');
    expect(names.net).toBe('PK TG V and PK TG VI');
  });

  it('says the ordinary thing where a holding is its own level', () => {
    // Which is nearly every product: naming the level would repeat the
    // holding's name back at the reader.
    const names = levelsOf([held('Baltic Wind II'), held('Nordic Fibre III')]);
    expect(names.gross).toBe(GENERIC_GROSS);
    expect(names.net).toBe(GENERIC_NET);
  });

  it('refuses to let one holding’s level stand for holdings that have none', () => {
    // Two of three named would put "Fund V REIT LP" over figures that are
    // mostly about something else.
    const names = levelsOf([
      held('RAHPF V', { gross: 'Fund V REIT LP', net: 'PK TG V' }),
      held('Something else'),
    ]);
    expect(names.gross).toBe(GENERIC_GROSS);
    expect(names.net).toBe(GENERIC_NET);
  });

  it('collapses a name every holding agrees on', () => {
    const names = levelsOf([
      held('A', { gross: 'One Feeder LP', net: 'Holder A' }),
      held('B', { gross: 'One Feeder LP', net: 'Holder B' }),
    ]);
    expect(names.gross).toBe('One Feeder LP');
    expect(names.net).toBe('Holder A and Holder B');
  });

  it('gives up on a list too long to read, per tier', () => {
    // Four vehicles named in a heading is a paragraph, not a label — but the
    // net tier, where they agree, keeps its name.
    const many = ['I', 'II', 'III', 'IV'].map((n) =>
      held(`Fund ${n}`, { gross: `Fund ${n} Feeder LP`, net: 'The holder' }));
    expect(levelsOf(many).gross).toBe(GENERIC_GROSS);
    expect(levelsOf(many).net).toBe('The holder');
  });

  it('says the ordinary thing for a book with no holdings at all', () => {
    expect(levelsOf([])).toEqual({ gross: GENERIC_GROSS, net: GENERIC_NET });
  });
});

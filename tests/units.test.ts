/**
 * The unit a product's books are written in.
 *
 * Nothing in a figure says which unit it is in: 165,000 is a book kept in
 * thousands and 27,900,000 one kept in whole euros, and the two are the same
 * kind of number to look at. So the unit is recorded against the product, and
 * what is pinned here is that recording it changes nothing for the books that
 * predate it, that it changes everything for the ones written in full, and
 * that two products which disagree are refused rather than added.
 */

import { describe, expect, it } from 'vitest';
import { money, currencySymbol } from '../src/components/common/format';
import { unitScaleOf } from '../src/domain/types';
import { CLIENT_DEFINITIONS } from '../src/data/structure';

/** What a screen does: apply the product's unit, then format. */
const shown = (filed: number, scale: number | undefined, currency = 'EUR') =>
  (scale === undefined ? '—' : money(filed * scale, currency));

describe('the unit a book is written in', () => {
  it('is thousands for a book that predates the unit being recorded', () => {
    expect(unitScaleOf([{}])).toBe(1000);
    expect(unitScaleOf([{ unitScale: undefined }, {}])).toBe(1000);
  });

  it('leaves a book kept in thousands showing exactly what it showed before', () => {
    // 165,000 filed against a book in thousands is 165 million.
    expect(shown(165_000, 1000)).toBe('€165.0m');
    expect(shown(122_088.1, 1000)).toBe('€122.1m');
  });

  it('stops showing a book kept in whole units a thousandfold out', () => {
    expect(shown(27_900_000, 1)).toBe('€27.9m');
    expect(shown(40_000_000, 1, 'USD')).toBe('$40.0m');
    // What it did before the unit was recorded, and why it had to be.
    expect(shown(40_000_000, 1000, 'USD')).toBe('$40,000.0m');
  });

  it('has no answer for products that disagree, and says so instead of guessing', () => {
    expect(unitScaleOf([{ unitScale: 1000 }, { unitScale: 1 }])).toBeUndefined();
    expect(shown(1_000, undefined)).toBe('—');
  });

  it('agrees with the two products whose books are known to be written in full', () => {
    const inFull = CLIENT_DEFINITIONS
      .flatMap((client) => client.vehicles)
      .filter((vehicle) => vehicle.unitScale === 1)
      .map((vehicle) => vehicle.shortName)
      .sort();
    expect(inFull).toEqual(['PAS Infra', 'PK TG']);
  });

  it('keeps the currency symbol in front of the amount, whatever the unit', () => {
    expect(currencySymbol('CHF')).toBe('CHF ');
    expect(shown(1_000_000, 1, 'CHF')).toBe('CHF 1.0m');
  });
});

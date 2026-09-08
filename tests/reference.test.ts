/**
 * What an import replaces, and what it must leave alone.
 *
 * The bug this is about: a reader changed how it named an investor, the new
 * record went in beside the old one because nothing collided, and the capital
 * accounts screen showed Pensionskasse Thurgau twice with the commitment
 * counted once each.
 */

import { describe, expect, it } from 'vitest';
import { statedAt, supersede } from '../src/ingest/reference';

const investor = (id: string, vehicleId: string, name = 'Pensionskasse Thurgau') =>
  ({ id, vehicleId, name });
const company = (id: string, positionId: string, name = 'Rowan Court') =>
  ({ id, positionId, name });

describe('what an import supersedes', () => {
  it('replaces a record whose identifier collides', () => {
    const kept = supersede(
      [investor('inv-holder', 'veh-pk-tg')],
      [investor('inv-holder', 'veh-pk-tg')],
      (row) => row.vehicleId,
    );
    expect(kept).toHaveLength(1);
  });

  it('retires a record the import renamed out from under', () => {
    // The whole point. Two identifiers, one investor, and the old one has
    // nothing to collide with.
    const kept = supersede(
      [investor('inv-fund-v-reit-lp-holder', 'veh-pk-tg')],
      [investor('inv-pensionskasse-th-holder', 'veh-pk-tg')],
      (row) => row.vehicleId,
    );
    expect(kept.map((row) => row.id)).toEqual(['inv-pensionskasse-th-holder']);
  });

  it('leaves every other vehicle exactly as it was', () => {
    const kept = supersede(
      [investor('inv-old', 'veh-pk-tg'), investor('inv-abif', 'veh-abif', 'Nordhaven')],
      [investor('inv-new', 'veh-pk-tg')],
      (row) => row.vehicleId,
    );
    expect(kept.map((row) => row.id)).toEqual(['inv-abif', 'inv-new']);
  });

  it('says nothing about a group the import did not speak about', () => {
    // An allocation workbook files companies against holdings it never read.
    // Clearing a holding it said nothing about would delete it by silence.
    const held = [company('ast-a', 'pos-1'), company('ast-b', 'pos-2')];
    expect(supersede(held, [], (row) => row.positionId)).toEqual(held);
  });

  it('restates one holding’s companies without touching another’s', () => {
    const kept = supersede(
      [company('ast-old', 'pos-1'), company('ast-keep', 'pos-2', 'Alder Place')],
      [company('ast-new', 'pos-1')],
      (row) => row.positionId,
    );
    expect(kept.map((row) => row.id)).toEqual(['ast-keep', 'ast-new']);
  });

  it('is stable: importing the same thing again changes nothing', () => {
    const first = supersede([], [investor('inv-a', 'veh-1')], (row) => row.vehicleId);
    const again = supersede(first, [investor('inv-a', 'veh-1')], (row) => row.vehicleId);
    expect(again).toEqual(first);
  });

  it('keeps the incoming record when both rules would fire on it', () => {
    // Same id and same vehicle: it must be replaced once, not dropped.
    const kept = supersede(
      [investor('inv-a', 'veh-1', 'Old name')],
      [investor('inv-a', 'veh-1', 'New name')],
      (row) => row.vehicleId,
    );
    expect(kept).toEqual([investor('inv-a', 'veh-1', 'New name')]);
  });
});

describe('when a reading happened', () => {
  const at = (recordedAt: string) => ({ recordedAt });

  it('is the reading’s own instant, not the moment somebody confirmed it', () => {
    // The bug this exists for. A workbook is read, reviewed, and then
    // imported; the facts carry the instant they were read at, and the clock
    // at the moment of confirming is later by however long the review took.
    // Stamping the restatement with the second one made the import supersede
    // itself: PK TG lost every movement it had just filed, and kept only the
    // valuations, which carry no vehicle and are never judged.
    const read = '2026-09-08T01:00:00.000Z';
    const confirmed = '2026-09-08T01:04:37.000Z';
    expect(statedAt([at(read), at(read)])).toBe(read);
    expect(statedAt([at(read)])! < confirmed).toBe(true);
  });

  it('takes the earliest, so no fact of the reading falls before its own statement', () => {
    const earliest = '2026-09-08T01:00:00.000Z';
    expect(statedAt([
      at('2026-09-08T01:00:02.000Z'), at(earliest), at('2026-09-08T01:00:01.000Z'),
    ])).toBe(earliest);
  });

  it('is undefined for a reading that produced nothing', () => {
    // Nothing read is not a statement about anything, and recording it as one
    // would supersede a book with an empty file.
    expect(statedAt([])).toBeUndefined();
  });
});

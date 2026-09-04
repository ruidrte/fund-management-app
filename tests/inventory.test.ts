/**
 * What is loaded.
 *
 * The screen that answers "is this quarter empty because nobody sent anything,
 * or because I have not loaded it". Both look identical on the dashboard, and
 * they are somebody else's problem and mine respectively.
 */

import { describe, expect, it } from 'vitest';
import { takeInventory, type InventoryRow } from '../src/engine/inventory';
import { buildDemoDataSet, DEMO_TIMELINE } from './fixtures/portfolio';
import type { DataSet } from '../src/domain/types';

const ebg = buildDemoDataSet('client-ebg');
const scope = { clientId: 'client-ebg', vehicleId: 'veh-abif' };

const row = (rows: InventoryRow[], id: string): InventoryRow => {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`No row ${id}`);
  return found;
};
const at = (rows: InventoryRow[], id: string, period: string) => {
  const cell = row(rows, id).cells.find((c) => c.period === period);
  if (!cell) throw new Error(`No cell ${id}/${period}`);
  return cell;
};

describe('the shape of the inventory', () => {
  const { rows, periods, first, last } = takeInventory(ebg, scope);

  it('covers every quarter the book touches, oldest first', () => {
    expect(periods.length).toBeGreaterThan(4);
    expect(periods[0]).toBe(first);
    expect(periods[periods.length - 1]).toBe(last);
  });

  it('separates what was filed from what is derived from it', () => {
    const filed = rows.filter((r) => r.tier === 'filed').map((r) => r.id);
    const derived = rows.filter((r) => r.tier === 'derived').map((r) => r.id);

    expect(filed).toContain('valuations');
    expect(filed).toContain('balance-sheet');
    expect(derived).toContain('net');
    expect(derived).toContain('report');
    // A derived row is never also a filed one; that is the whole distinction.
    expect(filed.filter((id) => derived.includes(id))).toEqual([]);
  });

  it('gives every row a cell for every quarter shown', () => {
    for (const r of rows) expect(r.cells.map((c) => c.period)).toEqual(periods);
  });
});

describe('holdings that did not report', () => {
  it('counts the quarter as partly filed, and says how partly', () => {
    const { rows } = takeInventory(ebg, scope);
    const cell = at(rows, 'valuations', '2026Q1');

    expect(cell.state).toBe('partial');
    expect(cell.count).toBeLessThan(cell.of!);
    expect(cell.note).toContain(`${cell.count} of ${cell.of}`);
  });

  it('carries the same verdict into the portfolio it feeds', () => {
    const { rows } = takeInventory(ebg, scope);

    expect(at(rows, 'gross', '2026Q1').state).toBe(at(rows, 'valuations', '2026Q1').state);
  });
});

describe('a derived row is only as good as its inputs', () => {
  const stripped: DataSet = { ...ebg, balanceSheets: [] };

  it('marks the net tier as partial when no balance sheet was ever filed', () => {
    const { rows } = takeInventory(stripped, scope);
    const cell = at(rows, 'net', '2025Q3');

    expect(cell.state).toBe('partial');
    expect(cell.note).toContain('not tie');
  });

  it('is reported only when the portfolio and the balance sheet both are', () => {
    const { rows } = takeInventory(ebg, scope);
    const complete = row(rows, 'net').cells.filter((c) => c.state === 'reported');

    for (const cell of complete) {
      expect(at(rows, 'valuations', cell.period).state).toBe('reported');
      expect(at(rows, 'balance-sheet', cell.period).state).toBe('reported');
    }
    expect(complete.length).toBeGreaterThan(0);
  });

  it('says there is nothing to allocate to investors when none is on file', () => {
    const { rows } = takeInventory({ ...ebg, investors: [] }, scope);

    expect(row(rows, 'capital-accounts').cells.every((c) => c.state === 'none')).toBe(true);
    expect(at(rows, 'capital-accounts', '2026Q1').note).toContain('No investor');
  });

  it('has no look-through without company valuations', () => {
    const { rows } = takeInventory({ ...ebg, assetValuations: [] }, scope);

    expect(row(rows, 'look-through').cells.every((c) => c.state === 'none')).toBe(true);
    expect(row(rows, 'exposure').cells.some((c) => c.state !== 'none')).toBe(true);
  });
});

describe('as at an earlier date', () => {
  it('shows the book as it stood then, not as it stands now', () => {
    const now = takeInventory(ebg, scope);
    const then = takeInventory(ebg, { ...scope, knowledgeDate: DEMO_TIMELINE.EARLY });

    const filled = (inv: typeof now) => inv.rows
      .flatMap((r) => r.cells)
      .filter((c) => c.state === 'reported').length;

    expect(filled(then)).toBeLessThan(filled(now));
  });
});

/**
 * What makes a fact the same fact.
 *
 * An identifier decides whether re-importing a quarter restates what it filed
 * or files it again. These are the two ways that goes wrong: an identifier that
 * moves when nothing about the fact moved, and one identifier over two facts.
 */

import { describe, expect, it } from 'vitest';
import { distinctly, factId, slug } from '../src/ingest/ids';

describe('an identifier derived from the fact', () => {
  it('is the same for the same fact, whatever order it was read in', () => {
    const one = factId('cf', 'ut', 'pos-northwind', 'Capital Call', '2026-03-31', -200_000);
    const again = factId('cf', 'ut', 'pos-northwind', 'Capital Call', '2026-03-31', -200_000);
    expect(again).toBe(one);
  });

  it('separates facts that differ in any one thing they say', () => {
    const base = ['cf', 'ut', 'pos-northwind', 'Capital Call', '2026-03-31', -200_000] as const;
    const said = new Set([
      factId(...base),
      factId('cf', 'ut', 'pos-harbour', 'Capital Call', '2026-03-31', -200_000),
      factId('cf', 'ut', 'pos-northwind', 'Distribution', '2026-03-31', -200_000),
      factId('cf', 'ut', 'pos-northwind', 'Capital Call', '2026-06-30', -200_000),
      factId('cf', 'ut', 'pos-northwind', 'Capital Call', '2026-03-31', -200_001),
    ]);
    expect(said.size).toBe(5);
  });

  it('tells a part that says nothing from one that is not there', () => {
    // Slugging collapses the joins, so a note written "—" and no note at all
    // would otherwise both contribute nothing. Within one reader the arity is
    // fixed and this is the only way the two can be confused — and it is the
    // way that varies from row to row.
    const absent = factId('cf', 'ut', 'inv-a', '2026-03-31', 50_000, undefined);
    const empty = factId('cf', 'ut', 'inv-a', '2026-03-31', 50_000, '—');
    expect(empty).not.toBe(absent);
  });

  it('leaves an identifier alone when its optional part is simply absent', () => {
    // The common case by far, and the one already written into books.
    expect(factId('cf', 'ut', 'inv-a', 50_000, undefined))
      .toBe(factId('cf', 'ut', 'inv-a', 50_000, undefined));
    expect(factId('val', 'pos-a', '2026Q1')).toBe(`val-${slug('pos-a|2026Q1', 56)}`);
  });

  it('keeps its prefix legible and its length bounded', () => {
    const long = factId('cf', 'x'.repeat(400), 'y'.repeat(400));
    expect(long.startsWith('cf-')).toBe(true);
    expect(long.length).toBeLessThan(80);
    // Bounded by shortening, not by collapsing: two long facts stay two.
    expect(long).not.toBe(factId('cf', 'x'.repeat(400), 'z'.repeat(400)));
  });
});

describe('two facts that say exactly the same thing', () => {
  it('stay two, because a ledger can mean it twice', () => {
    const distinct = distinctly();
    const said = factId('cf', 'ut', 'inv-northwind', 'Capital Call', '2026-03-31', 50_000);
    expect(distinct(said)).toBe(said);
    expect(distinct(said)).toBe(`${said}-2`);
    expect(distinct(said)).toBe(`${said}-3`);
  });

  it('leave everything that is not duplicated exactly as it was', () => {
    // The point of the suffix is that it is local. A repeat of one fact must
    // not shift the identifier of any other, which is what a running sequence
    // over the whole file did.
    const distinct = distinctly();
    const first = factId('cf', 'a');
    const second = factId('cf', 'b');
    expect(distinct(first)).toBe(first);
    expect(distinct(first)).toBe(`${first}-2`);
    expect(distinct(second)).toBe(second);
  });

  it('counts per reading, so a second pass over the same file agrees with the first', () => {
    const said = factId('cf', 'ut', 'inv-northwind', 'Capital Call', '2026-03-31', 50_000);
    const once = [distinctly()].flatMap((d) => [d(said), d(said)]);
    const again = [distinctly()].flatMap((d) => [d(said), d(said)]);
    expect(again).toEqual(once);
  });
});

describe('slugging a name', () => {
  it('is what factId is built on, so the two agree on what a name is', () => {
    expect(factId('val', 'Northwind Capital')).toBe(`val-${slug('Northwind Capital', 56)}`);
  });
});

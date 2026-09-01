import { describe, expect, it } from 'vitest';
import {
  comparePeriods, formatPeriod, makePeriod, nextPeriod, parsePeriodId,
  periodForDate, periodRange, periodsBetween, previousPeriod, sortPeriods,
} from '../src/domain/period';

describe('period arithmetic', () => {
  it('parses the canonical and the legacy display form to the same period', () => {
    expect(parsePeriodId('2026Q1')).toEqual(parsePeriodId('Q1 2026'));
  });

  it('rejects anything that is not a quarter', () => {
    expect(() => parsePeriodId('2026Q5')).toThrow();
    expect(() => parsePeriodId('March 2026')).toThrow();
  });

  it('places quarter ends on the right calendar day', () => {
    expect(makePeriod(2026, 1).endDate).toBe('2026-03-31');
    expect(makePeriod(2026, 2).endDate).toBe('2026-06-30');
    expect(makePeriod(2026, 3).endDate).toBe('2026-09-30');
    expect(makePeriod(2026, 4).endDate).toBe('2026-12-31');
  });

  it('crosses the year boundary in both directions', () => {
    expect(previousPeriod('2026Q1')).toBe('2025Q4');
    expect(nextPeriod('2025Q4')).toBe('2026Q1');
    expect(previousPeriod('2026Q1', 5)).toBe('2024Q4');
  });

  it('orders periods chronologically', () => {
    expect(comparePeriods('2025Q4', '2026Q1')).toBeLessThan(0);
    expect(comparePeriods('2026Q1', '2026Q1')).toBe(0);
    expect(sortPeriods(['2026Q2', '2025Q1', '2026Q1'])).toEqual(['2025Q1', '2026Q1', '2026Q2']);
  });

  it('counts the quarters between two periods', () => {
    expect(periodsBetween('2025Q1', '2026Q1')).toBe(4);
    expect(periodsBetween('2026Q1', '2025Q1')).toBe(-4);
  });

  it('builds an inclusive range and an empty one when reversed', () => {
    expect(periodRange('2025Q3', '2026Q2')).toEqual(['2025Q3', '2025Q4', '2026Q1', '2026Q2']);
    expect(periodRange('2026Q2', '2025Q3')).toEqual([]);
  });

  it('maps a date into its quarter', () => {
    expect(periodForDate('2026-03-31')).toBe('2026Q1');
    expect(periodForDate('2026-04-01')).toBe('2026Q2');
  });

  it('formats for display', () => {
    expect(formatPeriod('2026Q1')).toBe('Q1 2026');
  });
});

/**
 * Allocation bars.
 *
 * A horizontal bar per slice, sorted by weight, direct-labelled with both the
 * share and the amount. The direct labels are what let the light-mode series
 * colours be used at all: three of them sit below 3:1 against the surface, so
 * the label carries the value and the colour only carries identity.
 *
 * Prior-quarter weight, where known, is marked as a tick — a second mark rather
 * than a second bar, so the current allocation stays the thing being read.
 */

import { useState } from 'react';
import type { ExposureBreakdown } from '../../engine/exposure';
import { money, percent, seriesColor, signedPercent } from '../common/format';

const MAX_SLICES = 8;

export function AllocationBars({ breakdown }: { breakdown: ExposureBreakdown }) {
  const [hovered, setHovered] = useState<string>();
  const slices = foldTail(breakdown);
  const largest = Math.max(...slices.map((s) => s.weight), 0.0001);

  return (
    <figure className="m-0">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {slices.map((slice, index) => {
          const active = hovered === slice.label;
          const drift = slice.priorWeight !== undefined ? slice.weight - slice.priorWeight : undefined;

          return (
            <li
              key={slice.label}
              onMouseEnter={() => setHovered(slice.label)}
              onMouseLeave={() => setHovered(undefined)}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: slice.color ?? seriesColor(index) }}
                  />
                  <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                    {slice.label}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3 tabular text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {money(slice.value, breakdown.currency)}
                  </span>
                  <span className="w-12 text-right font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {percent(slice.weight)}
                  </span>
                </span>
              </div>

              <div
                className="relative h-2.5 w-full overflow-hidden rounded-sm"
                style={{ background: 'var(--surface-2)' }}
              >
                <div
                  className="h-full rounded-sm transition-[width] duration-200"
                  style={{
                    width: `${(slice.weight / largest) * 100}%`,
                    background: slice.color ?? seriesColor(index),
                    outline: active ? '2px solid var(--surface-1)' : 'none',
                    outlineOffset: -2,
                  }}
                />
                {slice.priorWeight !== undefined && (
                  <span
                    aria-hidden
                    className="absolute top-0 h-full w-0.5"
                    style={{
                      left: `${Math.min(100, (slice.priorWeight / largest) * 100)}%`,
                      background: 'var(--text-primary)',
                      opacity: 0.45,
                    }}
                    title={`Prior quarter ${percent(slice.priorWeight)}`}
                  />
                )}
              </div>

              {active && drift !== undefined && Math.abs(drift) > 0.0005 && (
                <p className="mt-1 text-[11px] tabular" style={{ color: 'var(--text-muted)' }}>
                  {signedPercent(drift)} versus the prior quarter
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <figcaption className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        {breakdown.basis === 'look-through'
          ? lookThroughNote(breakdown)
          : 'Measured on position attributes — no look-through available.'}
        {breakdown.coverage < 0.995 && ` ${percent(1 - breakdown.coverage, 0)} unclassified.`}
        {breakdown.slices.length > MAX_SLICES &&
          ` ${breakdown.slices.length - (MAX_SLICES - 1)} smaller slices folded into Other.`}
      </figcaption>
    </figure>
  );
}

/**
 * Asset detail seldom accounts for the whole of a portfolio's value. Saying by
 * how much it falls short is the difference between a breakdown of the
 * portfolio and a breakdown of the part of it somebody happened to collect.
 */
function lookThroughNote(breakdown: ExposureBreakdown): string {
  const base = 'Look-through to underlying assets, at the vehicle’s economic share.';
  if (!breakdown.benchmarkTotal || breakdown.benchmarkTotal <= 0) return base;
  const share = breakdown.total / breakdown.benchmarkTotal;
  if (share > 0.98) return base;
  return `${base} Asset detail covers ${money(breakdown.total, breakdown.currency)} of ${money(breakdown.benchmarkTotal, breakdown.currency)} portfolio NAV (${percent(share, 0)}); the rest is fund-level cash, undeployed capital and holdings with no asset data.`;
}

/**
 * Never a ninth generated hue: everything past the eighth slot folds into a
 * single neutral "Other" that keeps the breakdown summing to the whole.
 */
function foldTail(breakdown: ExposureBreakdown) {
  const sorted = [...breakdown.slices].sort((a, b) => b.weight - a.weight);
  if (sorted.length <= MAX_SLICES) return sorted.map((s) => ({ ...s, color: undefined as string | undefined }));

  const head = sorted.slice(0, MAX_SLICES - 1).map((s) => ({ ...s, color: undefined as string | undefined }));
  const tail = sorted.slice(MAX_SLICES - 1);
  head.push({
    label: 'Other',
    value: tail.reduce((t, s) => t + s.value, 0),
    weight: tail.reduce((t, s) => t + s.weight, 0),
    priorWeight: tail.every((s) => s.priorWeight !== undefined)
      ? tail.reduce((t, s) => t + (s.priorWeight ?? 0), 0)
      : undefined,
    count: tail.reduce((t, s) => t + s.count, 0),
    color: 'var(--text-muted)',
  });
  return head;
}

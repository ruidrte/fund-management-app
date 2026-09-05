/**
 * NAV and multiple over time.
 *
 * One measure per chart — never two y-scales. A crosshair reads the whole
 * series at one period, and the marker size stays above 8px so it can be hit.
 */

import { useMemo, useState } from 'react';
import { formatPeriod, type PeriodId } from '../../domain/period';

import type { CurrencyCode } from '../../domain/types';
import { useMoney } from '../../context/ScopeContext';

export interface TrendPoint {
  period: PeriodId;
  value: number;
  /** Drawn hollow when the point is not a reported figure. */
  estimated?: boolean;
}

const WIDTH = 720;
const HEIGHT = 220;
const MARGIN = { top: 16, right: 20, bottom: 34, left: 76 };

export function TrendLine({
  points, currency, label,
}: { points: TrendPoint[]; currency: CurrencyCode; label: string }) {
  const { money } = useMoney();
  const [active, setActive] = useState<number>();

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const { min, max } = useMemo(() => {
    const values = points.map((p) => p.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    return { min: lo - pad, max: hi + pad };
  }, [points]);

  if (points.length === 0) {
    return <p className="py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No history for this scope.</p>;
  }

  const x = (index: number) =>
    MARGIN.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number) =>
    MARGIN.top + plotHeight - ((value - min) / (max - min || 1)) * plotHeight;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const ticks = Array.from({ length: 4 }, (_, i) => min + ((max - min) / 3) * i);
  // Show at most eight period labels, so they never collide.
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <figure className="m-0">
      <div className="scroll-x">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%"
          style={{ minWidth: 520, display: 'block' }}
          role="img"
          aria-label={`${label} by quarter, from ${formatPeriod(points[0].period)} to ${formatPeriod(points[points.length - 1].period)}`}
          onMouseLeave={() => setActive(undefined)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke="var(--grid)" />
              <text
                x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle"
                fontSize={11} fill="var(--text-muted)" className="tabular"
              >
                {money(tick, currency, 0)}
              </text>
            </g>
          ))}

          {active !== undefined && (
            <line
              x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight}
              stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3"
            />
          )}

          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />

          {points.map((point, index) => (
            <g key={point.period}>
              <rect
                x={x(index) - plotWidth / (points.length * 2)} y={MARGIN.top}
                width={plotWidth / points.length} height={plotHeight}
                fill="transparent" onMouseEnter={() => setActive(index)}
              />
              <circle
                cx={x(index)} cy={y(point.value)}
                r={active === index ? 6 : 4.5}
                fill={point.estimated ? 'var(--surface-1)' : 'var(--series-1)'}
                stroke="var(--series-1)" strokeWidth={2}
              />
            </g>
          ))}

          {points.map((point, index) => (
            index % labelEvery === 0 || index === points.length - 1 ? (
              <text
                key={`x-${point.period}`}
                x={x(index)} y={HEIGHT - MARGIN.bottom + 18}
                textAnchor="middle" fontSize={11}
                fill={active === index ? 'var(--text-primary)' : 'var(--text-muted)'}
              >
                {formatPeriod(point.period)}
              </text>
            ) : null
          ))}
        </svg>
      </div>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--series-1)' }} />
          Reported
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden className="inline-block h-2 w-2 rounded-full"
            style={{ background: 'var(--surface-1)', boxShadow: 'inset 0 0 0 2px var(--series-1)' }}
          />
          Drafted or estimated
        </span>
        {active !== undefined && (
          <span className="tabular" style={{ color: 'var(--text-primary)' }}>
            {formatPeriod(points[active].period)}: {money(points[active].value, currency)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

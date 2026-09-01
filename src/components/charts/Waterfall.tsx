/**
 * Bridge waterfall.
 *
 * Anchors are drawn from the baseline; deltas float between the running totals.
 * Sign is carried three ways — position relative to the zero line, a signed
 * printed value, and the diverging blue/red pair — so it never rests on colour.
 *
 * The value axis is truncated, because a 2m quarterly step against a 120m base
 * is invisible on a zero-based axis. Truncation is stated on the card rather
 * than hidden, which is the price of using it.
 */

import { useId, useState } from 'react';
import type { Bridge } from '../../engine/bridge';
import { money, signedMoney } from '../common/format';

const WIDTH = 720;
const HEIGHT = 260;
const MARGIN = { top: 16, right: 16, bottom: 52, left: 76 };

export function Waterfall({ bridge }: { bridge: Bridge }) {
  const clipId = useId();
  const [hovered, setHovered] = useState<number>();

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  // Running totals give each floating delta its start and end.
  let running = 0;
  const bars = bridge.steps.map((step) => {
    if (step.type === 'anchor') {
      running = step.value;
      return { step, from: 0, to: step.value };
    }
    const from = running;
    running += step.value;
    return { step, from, to: running };
  });

  // The band the data occupies. An anchor contributes only its own value: its
  // notional foot at zero would drag the axis down to zero and squash every
  // delta into an invisible sliver against a large base — which is exactly the
  // failure this truncation exists to prevent.
  const values = bars.flatMap((b) => (b.step.type === 'anchor' ? [b.to] : [b.from, b.to]));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.abs(rawMax) || 1;

  const min = rawMin - span * 0.35;
  const max = rawMax + span * 0.18;
  // A bridge that crosses zero is shown against zero; only a band clear of it
  // is truncated, and the caption says so.
  const floor = rawMin > 0 ? min : Math.min(0, min);
  const truncated = floor > 0;

  const y = (value: number) => MARGIN.top + plotHeight - ((value - floor) / (max - floor)) * plotHeight;
  const bandWidth = plotWidth / bars.length;
  const barWidth = Math.min(64, bandWidth * 0.6);

  const ticks = axisTicks(floor, max, 4);

  return (
    <figure className="m-0">
      <div className="scroll-x">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          style={{ minWidth: 520, display: 'block' }}
          role="img"
          aria-label={`${bridge.label}: ${bridge.steps.map((s) => `${s.label} ${money(s.value, bridge.currency)}`).join(', ')}`}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={MARGIN.left} y={MARGIN.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>

          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                y1={y(tick)} y2={y(tick)}
                stroke="var(--grid)" strokeWidth={1}
              />
              <text
                x={MARGIN.left - 8} y={y(tick)}
                textAnchor="end" dominantBaseline="middle"
                fontSize={11} fill="var(--text-muted)" className="tabular"
              >
                {money(tick, bridge.currency, 0)}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            {bars.map((bar, index) => {
              const centre = MARGIN.left + bandWidth * index + bandWidth / 2;
              const isAnchorBar = bar.step.type === 'anchor';
              const base = isAnchorBar ? floor : bar.from;
              const top = y(Math.max(base, bar.to));
              const bottom = y(Math.min(base, bar.to));
              const height = Math.max(2, bottom - top);
              const isAnchor = isAnchorBar;
              const rising = bar.to >= bar.from;

              const fill = isAnchor
                ? 'var(--text-secondary)'
                : rising ? 'var(--diverge-positive)' : 'var(--diverge-negative)';

              return (
                <g
                  key={bar.step.key}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(undefined)}
                >
                  {/* A hit target larger than the mark, so thin deltas stay hoverable. */}
                  <rect
                    x={centre - bandWidth / 2} y={MARGIN.top}
                    width={bandWidth} height={plotHeight}
                    fill="transparent"
                  />
                  <rect
                    x={centre - barWidth / 2} y={top}
                    width={barWidth} height={height}
                    rx={4}
                    fill={fill}
                    stroke="var(--surface-1)" strokeWidth={hovered === index ? 2 : 0}
                  />
                  {/* Connector to the next bar, so the eye follows the running total. */}
                  {index < bars.length - 1 && (
                    <line
                      x1={centre + barWidth / 2} x2={MARGIN.left + bandWidth * (index + 1) + bandWidth / 2 - barWidth / 2}
                      y1={y(bar.to)} y2={y(bar.to)}
                      stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3"
                    />
                  )}
                  <text
                    x={centre} y={top - 6}
                    textAnchor="middle" fontSize={11} fontWeight={600}
                    fill="var(--text-primary)" className="tabular"
                  >
                    {isAnchor
                      ? money(bar.step.value, bridge.currency)
                      : signedMoney(bar.step.value, bridge.currency)}
                  </text>
                </g>
              );
            })}
          </g>

          {bars.map((bar, index) => {
            const centre = MARGIN.left + bandWidth * index + bandWidth / 2;
            return (
              <text
                key={`label-${bar.step.key}`}
                x={centre} y={HEIGHT - MARGIN.bottom + 16}
                textAnchor="middle" fontSize={11}
                fill={hovered === index ? 'var(--text-primary)' : 'var(--text-secondary)'}
              >
                {wrap(bar.step.label).map((line, lineIndex) => (
                  <tspan key={line} x={centre} dy={lineIndex === 0 ? 0 : 12}>{line}</tspan>
                ))}
              </text>
            );
          })}

          <line
            x1={MARGIN.left} x2={WIDTH - MARGIN.right}
            y1={MARGIN.top + plotHeight} y2={MARGIN.top + plotHeight}
            stroke="var(--border-strong)" strokeWidth={1}
          />
        </svg>
      </div>

      <figcaption className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        {truncated && 'Value axis truncated so quarterly steps stay legible against the base. '}
        {hovered !== undefined && bars[hovered].step.note}
      </figcaption>
    </figure>
  );
}

function axisTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

/** Two lines maximum — a third would collide with the next label. */
function wrap(label: string): string[] {
  if (label.length <= 16) return [label];
  const words = label.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((`${current} ${word}`).trim().length > 16 && current) {
      lines.push(current);
      current = word;
    } else {
      current = (`${current} ${word}`).trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

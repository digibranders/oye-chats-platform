import { type ReactElement, useId, useRef, useState } from 'react';
import { formatCredits, formatDate, type TrendPoint } from '../usage-model';

/** Fixed viewBox coordinate space; the SVG scales to its container via CSS. */
const W = 720;
const H = 168;
const PAD = { top: 14, right: 10, bottom: 24, left: 10 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

interface Geometry {
  readonly linePath: string;
  readonly areaPath: string;
  readonly baselineY: number;
  readonly x: (index: number) => number;
  readonly y: (value: number) => number;
}

function buildGeometry(points: TrendPoint[], maxY: number): Geometry {
  const n = points.length;
  const x = (index: number): number =>
    n <= 1 ? PAD.left + PLOT_W / 2 : PAD.left + (PLOT_W * index) / (n - 1);
  const y = (value: number): number => PAD.top + PLOT_H * (1 - value / maxY);
  const baselineY = y(0);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.creditsUsed).toFixed(1)}`);
  const linePath = line.join(' ');
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${baselineY.toFixed(1)} L${x(0).toFixed(1)},${baselineY.toFixed(1)} Z`;
  return { linePath, areaPath, baselineY, x, y };
}

export interface ConsumptionTrendProps {
  points: TrendPoint[];
}

/**
 * ConsumptionTrend - a single-series 30-day credit-consumption line (magnitude
 * over time). One accent hue, a soft area fill, recessive axis labels, and a
 * crosshair + tooltip on hover. No legend (the title names the series) and no
 * chart library - a hand-built, theme-aware SVG. An sr-only summary + peak/
 * total captions keep it legible without color.
 */
export function ConsumptionTrend({ points }: ConsumptionTrendProps): ReactElement {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const total = points.reduce((sum, p) => sum + p.creditsUsed, 0);
  const peak = points.reduce((max, p) => Math.max(max, p.creditsUsed), 0);

  if (total === 0) {
    return (
      <div className="flex h-[168px] items-center justify-center rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[13px] text-[var(--ds-text-subtle)]">
        No consumption in the last 30 days.
      </div>
    );
  }

  const maxY = Math.max(1, peak);
  const geo = buildGeometry(points, maxY);
  const activePoint = active !== null ? points[active] : null;

  const handleMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setActive(Math.round(ratio * (points.length - 1)));
  };

  const firstLabel = formatDate(points[0]?.date ?? null);
  const lastLabel = formatDate(points[points.length - 1]?.date ?? null);

  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-[var(--ds-text-muted)]">Consumption</span>
          <span className="text-[12px] text-[var(--ds-text-subtle)]">last 30 days</span>
        </div>
        <span className="text-[12px] tabular-nums text-[var(--ds-text-subtle)]">
          Peak {formatCredits(peak)} · {formatCredits(total)} total
        </span>
      </div>

      <p className="sr-only">
        Daily credit consumption over the last 30 days: {formatCredits(total)} credits total, peaking at{' '}
        {formatCredits(peak)} in a day.
      </p>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label={`Consumption trend, last 30 days. ${formatCredits(total)} credits total, peak ${formatCredits(peak)}.`}
          onPointerMove={handleMove}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ds-accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--ds-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Baseline - recessive. */}
          <line
            x1={PAD.left}
            y1={geo.baselineY}
            x2={W - PAD.right}
            y2={geo.baselineY}
            stroke="var(--ds-border)"
            strokeWidth="1"
          />

          <path d={geo.areaPath} fill={`url(#${gradientId})`} />
          <path
            d={geo.linePath}
            fill="none"
            stroke="var(--ds-accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Active crosshair + marker. */}
          {activePoint && active !== null && (
            <>
              <line
                x1={geo.x(active)}
                y1={PAD.top}
                x2={geo.x(active)}
                y2={geo.baselineY}
                stroke="var(--ds-border-strong)"
                strokeWidth="1"
              />
              <circle
                cx={geo.x(active)}
                cy={geo.y(activePoint.creditsUsed)}
                r="4"
                fill="var(--ds-accent)"
                stroke="var(--ds-bg-surface)"
                strokeWidth="2"
              />
            </>
          )}
        </svg>

        {/* Tooltip - pinned to the top of the plot and clamped within the
            card so a peak near an edge never clips the label. */}
        {activePoint && active !== null && (
          <div
            className="pointer-events-none absolute top-1 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-elevated)] px-2.5 py-1.5 text-[12px] shadow-[var(--ds-shadow-md)]"
            style={{
              left: `${Math.min(90, Math.max(10, (active / Math.max(1, points.length - 1)) * 100))}%`,
            }}
          >
            <span className="block font-medium text-[var(--ds-text)]">{formatDate(activePoint.date)}</span>
            <span className="tabular-nums text-[var(--ds-text-muted)]">
              {formatCredits(activePoint.creditsUsed)} credits
            </span>
          </div>
        )}
      </div>

      {/* Sparse date axis. */}
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-[var(--ds-text-subtle)]">
        <span>{firstLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </div>
  );
}

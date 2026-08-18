/* eslint-disable react-refresh/only-export-components */
/**
 * Branded chart primitives (Shopeers-grade, violet/paper theme).
 *
 * These wrap Recharts with the OyeChats design tokens so every chart across
 * the app reads as one system: violet line + soft gradient fill, dashed
 * comparison series, tabular-num tooltips, muted grid. Import these instead
 * of hand-rolling Recharts per page.
 *
 *   <AreaTrendChart data={rows} dataKey="value" compareKey="prev" />
 *   <MiniBarChart   data={rows} dataKey="value" highlightIndex={2} />
 *   <RadialGauge    value={68} label="On track for 80% target" />
 *   <SegmentedStat  segments={[{label,value,color}, ...]} />
 */
import {
  Area, AreaChart, Bar, BarChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, CartesianGrid, Cell,
} from 'recharts';
import { cn } from '../../lib/utils';

// Brand palette for data-viz. Primary = violet; series scale for multi-line.
export const CHART_COLORS = {
  primary: '#7C3AED',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  grid: 'rgba(16,24,40,0.06)',
  axis: '#a79f8c',
  series: ['#7C3AED', '#10B981', '#F59E0B', '#F43F5E', '#0EA5E9'],
};

const AXIS_TICK = { fontSize: 11, fill: CHART_COLORS.axis, fontWeight: 500 };

/** Branded tooltip card used by all charts. */
export function BrandTooltip({ active, payload, label, valueFormatter }) {
  if (!active || !payload?.length) return null;
  const fmt = valueFormatter || ((v) => v?.toLocaleString?.() ?? v);
  return (
    <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-[var(--bg-card)] dark:bg-surface-900 shadow-lg px-3 py-2 min-w-[120px]">
      {label != null && (
        <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-400 mb-1.5">{label}</p>
      )}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color || p.stroke || p.fill }} />
          <span className="text-surface-500 dark:text-surface-400 capitalize">{p.name}</span>
          <span className="ml-auto font-bold text-surface-900 dark:text-surface-50 tabular-nums">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Area trend chart - violet line + soft gradient fill, optional dashed
 * comparison series (compareKey).
 */
export function AreaTrendChart({
  data = [],
  dataKey = 'value',
  compareKey,
  xKey = 'label',
  height = 220,
  color = CHART_COLORS.primary,
  valueFormatter,
  showGrid = true,
  showAxes = true,
  className,
}) {
  const gid = `area-${dataKey}-${color.replace('#', '')}`;
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {showGrid && <CartesianGrid strokeDasharray="0" stroke={CHART_COLORS.grid} vertical={false} />}
          {showAxes && <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} dy={6} />}
          {showAxes && <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} />}
          <Tooltip content={<BrandTooltip valueFormatter={valueFormatter} />} cursor={{ stroke: color, strokeOpacity: 0.25, strokeWidth: 1 }} />
          {compareKey && (
            <Area
              type="monotone" dataKey={compareKey} stroke={CHART_COLORS.axis}
              strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} isAnimationActive
            />
          )}
          <Area
            type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5}
            fill={`url(#${gid})`} dot={false}
            activeDot={{ r: 4, fill: color, stroke: 'var(--bg-card)', strokeWidth: 2.5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Bar chart with one highlighted (violet) bar; the rest muted. */
export function MiniBarChart({
  data = [],
  dataKey = 'value',
  xKey = 'label',
  highlightIndex,
  height = 180,
  valueFormatter,
  className,
}) {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
          <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} dy={6} />
          <Tooltip content={<BrandTooltip valueFormatter={valueFormatter} />} cursor={{ fill: 'rgba(162,28,175,0.05)' }} />
          <Bar dataKey={dataKey} radius={[6, 6, 0, 0]} maxBarSize={30}>
            {data.map((_, i) => (
              <Cell key={i} fill={i === highlightIndex ? CHART_COLORS.primary : 'rgba(162,28,175,0.14)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Semicircular radial gauge with a big centered value.
 * `value` is 0 to 100. Renders a ticked arc (muted track + colored progress).
 */
export function RadialGauge({
  value = 0,
  label,
  sublabel,
  color = CHART_COLORS.primary,
  size = 180,
  ticks = 44,
}) {
  const pct = Math.max(0, Math.min(100, value));
  const filled = Math.round((pct / 100) * ticks);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter - size * 0.11;
  // Half-circle sweep: 180° (left) → 360° (right)
  const tickEls = Array.from({ length: ticks }, (_, i) => {
    const t = i / (ticks - 1);
    const ang = Math.PI + t * Math.PI; // π .. 2π
    const x1 = cx + rInner * Math.cos(ang);
    const y1 = cy + rInner * Math.sin(ang);
    const x2 = cx + rOuter * Math.cos(ang);
    const y2 = cy + rOuter * Math.sin(ang);
    return (
      <line
        key={i} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={i < filled ? color : 'rgba(16,24,40,0.10)'}
        strokeWidth={2.5} strokeLinecap="round"
      />
    );
  });
  return (
    <div className="flex flex-col items-center">
      <div style={{ width: size, height: size / 2 + 8 }} className="relative">
        <svg width={size} height={size / 2 + 8} viewBox={`0 0 ${size} ${size / 2 + 8}`}>
          {tickEls}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-1">
          <span className="text-[30px] font-bold text-surface-900 dark:text-surface-50 leading-none tabular-nums">{pct}%</span>
          {label && <span className="text-[11px] text-surface-400 mt-1 text-center px-2">{label}</span>}
        </div>
      </div>
      {sublabel}
    </div>
  );
}

/**
 * Segmented stat row - the colored-bottom-border sub-cards from the reference
 * (e.g. Retailers / Distributors / Wholesalers).
 */
export function SegmentedStat({ segments = [], className }) {
  return (
    <div className={cn('grid gap-px rounded-xl overflow-hidden bg-surface-200 dark:bg-surface-800', className)}
      style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}>
      {segments.map((s, i) => (
        <div key={i} className="bg-[var(--bg-card)] dark:bg-surface-900 p-3.5 relative">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color || CHART_COLORS.series[i % 5] }} />
            <span className="text-[18px] font-bold text-surface-900 dark:text-surface-50 tabular-nums leading-none">{s.value}</span>
          </div>
          <p className="text-[11px] text-surface-500 dark:text-surface-400 mt-1.5">{s.label}</p>
          <span className="absolute left-0 bottom-0 h-[3px] w-full" style={{ background: s.color || CHART_COLORS.series[i % 5] }} />
        </div>
      ))}
    </div>
  );
}

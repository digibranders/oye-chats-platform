import { type ReactElement } from 'react';
import { type TooltipProps } from 'recharts';

// Recharts' tooltip generic params, declared locally to avoid a deep
// 'recharts/types/component/DefaultTooltipContent' import the bundler can't
// resolve. These match Recharts' own ValueType / NameType unions.
export type ValueType = number | string | Array<number | string>;
export type NameType = number | string;

/**
 * Chart colors, sourced from design-system CSS custom properties so every
 * SVG mark tracks the active light/dark theme automatically (Recharts renders
 * `fill`/`stroke` straight to SVG attributes, which resolve `var(--…)`).
 * Volt-violet (`--ds-accent`) stays the single lead accent per the mandate.
 */
export const CHART = {
  accent: 'var(--ds-accent)',
  grid: 'var(--ds-border)',
  axis: 'var(--ds-text-subtle)',
  success: 'var(--ds-success)',
  warning: 'var(--ds-warning)',
  danger: 'var(--ds-danger)',
  info: 'var(--ds-info)',
  muted: 'var(--ds-text-subtle)',
} as const;

type ChartTooltipProps = TooltipProps<ValueType, NameType> & {
  /** Suffix appended to the value, e.g. "messages". */
  unit?: string;
};

/**
 * ChartTooltip — a design-system-styled Recharts tooltip. Renders the hovered
 * label and value on a raised surface so it reads in both themes (the default
 * white Recharts tooltip is invisible in dark mode).
 */
export function ChartTooltip({ active, payload, label, unit }: ChartTooltipProps): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const value = payload[0]?.value;
  const display =
    typeof value === 'number' ? value.toLocaleString() : value != null ? String(value) : '';
  return (
    <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2 shadow-[var(--ds-shadow-md)]">
      {label !== undefined && label !== null && (
        <p className="mb-0.5 text-[11px] font-medium text-[var(--ds-text-muted)]">{String(label)}</p>
      )}
      <p className="text-[15px] font-bold tabular-nums text-[var(--ds-text)]">
        {display}
        {unit ? <span className="ml-1 text-[12px] font-normal text-[var(--ds-text-muted)]">{unit}</span> : null}
      </p>
    </div>
  );
}

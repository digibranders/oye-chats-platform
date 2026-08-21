import { ChartTooltip, formatDate } from '../ui';

/**
 * The panel this console's three time series show on hover.
 *
 * All three passed no `content` at all, which leaves Recharts' own default: an
 * unthemed white box in a browser font that ignores the palette entirely, so it
 * stayed white on the dark theme.
 *
 * Not a `src/ui` component — `ChartTooltip` is the primitive and already lives
 * there. This is the adapter that unwraps Recharts' payload for it, which is
 * exactly what each of the customer console's three charts writes for itself.
 */
export interface SeriesTooltipProps {
  /** What one point measures, e.g. "Revenue". Named because the axis cannot be. */
  name: string;
  /** Pre-formats the value; the tooltip never knows the unit. */
  format: (value: number) => string;
  /* Supplied by Recharts. */
  active?: boolean;
  label?: string;
  payload?: { value?: number | string }[];
}

export function SeriesTooltip({ name, format, active, label, payload }: SeriesTooltipProps) {
  const point = payload?.[0];
  if (!active || point?.value === undefined) return null;
  const value = typeof point.value === 'number' ? point.value : Number(point.value);
  return (
    <ChartTooltip
      label={label ? formatDate(`${label}T00:00:00`) : undefined}
      rows={[
        {
          name,
          value: Number.isFinite(value) ? format(value) : String(point.value),
          seriesIndex: 0,
        },
      ]}
    />
  );
}

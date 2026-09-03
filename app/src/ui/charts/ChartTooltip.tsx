import { type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { seriesColor } from './theme';

export interface ChartTooltipRow {
  name: string;
  /** Pre-formatted. The tooltip never formats — it does not know the unit. */
  value: ReactNode;
  /** Index into the shared series palette, for the swatch. */
  seriesIndex?: number;
}

export interface ChartTooltipProps {
  /** The point being read: a date, a bucket, a category. */
  label?: ReactNode;
  rows: readonly ChartTooltipRow[];
  className?: string;
}

/**
 * The panel a chart shows on hover.
 *
 * Written twice before this existed — in the analytics volume chart and in the
 * feedback trend chart — character for character, down to the same
 * `rounded-md border border-border bg-surface px-2.5 py-2 shadow-md`. Two copies
 * of one visual primitive inside two features is how the app this replaces
 * ended up with six chart palettes, so it lives here now and both charts pass a
 * `content` adapter to Recharts.
 *
 * `shadow-md` rather than a card's flat hairline, because this genuinely does
 * float above the page — which is what DESIGN.md §4 reserves elevation for.
 * Figures are mono so a value cannot jitter as the pointer moves along a series.
 */
export function ChartTooltip({ label, rows, className }: ChartTooltipProps) {
  return (
    <div
      className={cn(
        'pointer-events-none rounded-md border border-border bg-surface px-2.5 py-2 shadow-md',
        className,
      )}
    >
      {label ? <p className="mb-1 text-2xs font-medium text-text-tertiary">{label}</p> : null}
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-2 text-xs text-text-secondary">
            {row.seriesIndex === undefined ? null : (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: seriesColor(row.seriesIndex) }}
              />
            )}
            <span className="min-w-0 truncate">{row.name}</span>
            <span className="figure ms-auto font-medium text-text-primary">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

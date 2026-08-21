/**
 * Axis labels for this console's time series.
 *
 * The command centre, the visitor aggregate and the AI cost screen each drew an
 * `AreaChart` with a bare `<XAxis dataKey="date">`, so all three printed raw ISO
 * strings — `2026-08-06` — on the axis of a console where every other date reads
 * `6 Aug 2026`.
 *
 * Its own module rather than living beside `SeriesTooltip`: a file that exports
 * both a component and a constant loses fast refresh, and the lint rule that
 * says so is right.
 */

const TICK = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** `2026-08-06` → `6 Aug`. Falls back to the raw value for a non-date bucket. */
export function dayTick(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : TICK.format(parsed);
}

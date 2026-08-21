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

/**
 * Every nth label, so a daily axis labels evenly.
 *
 * Recharts' own `minTickGap` drops colliding labels by walking the axis from one
 * end, which on a 30-point series at 1440 produced eight consecutive days and
 * then every second day — an axis whose spacing changes halfway across it.
 * `interval` is deterministic: it takes every (n+1)th tick whatever the width,
 * so the same series labels the same way on every screen.
 *
 * Recharts counts an interval, not a label count, hence the `- 1`.
 */
export function tickInterval(count: number, target = 8): number {
  if (!Number.isFinite(count) || count <= target) return 0;
  return Math.max(0, Math.ceil(count / target) - 1);
}

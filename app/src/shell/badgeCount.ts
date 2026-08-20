/**
 * A count shown in the chrome.
 *
 * One helper because there were two rules: the bell capped at `9+` while the
 * rail's Inbox badge printed the raw number, so an operator with fourteen
 * conversations waiting saw "9+" in the top bar and "14" in the rail, for
 * overlapping facts. Nine is far too low a ceiling for a queue; ninety-nine is
 * the number every inbox in the category uses.
 *
 * Belongs in `src/ui/lib/formatters.ts` beside `formatNumber` — it is a
 * formatter, not chrome — and is here only because that file is owned by the
 * design-system pass. See the final report.
 */
export function formatBadgeCount(value: number, cap = 99): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value > cap ? `${cap}+` : String(Math.floor(value));
}

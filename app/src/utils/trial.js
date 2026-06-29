/**
 * Whole days left until an ISO-8601 trial-end timestamp, rounded UP.
 *
 * The single source of truth for every "N days left" surface (top banner,
 * billing badge) so they can never disagree. `ceil` — a trial ending in 2
 * hours still reads "1 day left", matching how customers count remaining
 * time and the backend's `trial_days_remaining` helper / day-N reminder cron.
 * A truncating diff would under-count by one for any partial day (10.4 days
 * left → 10, not 11).
 *
 * The ISO string carries its own UTC offset, so `Date.parse` is
 * timezone-safe regardless of the viewer's locale.
 *
 * @param {string} iso - ISO-8601 trial-end timestamp (with offset).
 * @param {number} [nowMs] - Reference instant in epoch ms; defaults to now.
 * @returns {number|null} Ceil day count (may be 0 or negative once lapsed),
 *   or `null` when `iso` is missing/unparseable.
 */
export function trialDaysLeft(iso, nowMs = Date.now()) {
  const endMs = Date.parse(iso);
  if (Number.isNaN(endMs)) return null;
  return Math.ceil((endMs - nowMs) / 86_400_000);
}

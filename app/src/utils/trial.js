/**
 * Whole days left until an ISO-8601 trial-end timestamp, rounded UP.
 *
 * The single source of truth for every "N days left" surface (top banner,
 * billing badge) so they can never disagree. `ceil` - a trial ending in 2
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

import { formatDate } from '../i18n/formatters';
export function trialDaysLeft(iso, nowMs = Date.now()) {
  const endMs = Date.parse(iso);
  if (Number.isNaN(endMs)) return null;
  return Math.ceil((endMs - nowMs) / 86_400_000);
}

/**
 * Whole days between now and an ISO-8601 timestamp, rounded UP. Same
 * ceiling rule as {@link trialDaysLeft} so every countdown across the app
 * agrees. Used for the post-trial data-retention grace window ("your
 * workspace will be deleted in X days").
 *
 * @param {string} iso - ISO-8601 target timestamp.
 * @param {number} [nowMs] - Reference instant in epoch ms; defaults to now.
 * @returns {number|null} Ceil day count (0 or negative once lapsed), or
 *   `null` when `iso` is missing/unparseable.
 */
export function daysUntil(iso, nowMs = Date.now()) {
  const endMs = Date.parse(iso);
  if (Number.isNaN(endMs)) return null;
  return Math.ceil((endMs - nowMs) / 86_400_000);
}

/**
 * Render a human-friendly absolute date from an ISO string, e.g.
 * "Jul 16, 2026". Returns the input unchanged when unparseable so we
 * never render "Invalid Date" in production.
 */
export function formatTrialDate(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso ?? '';
  return formatDate(new Date(ms), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

import { formatDate } from '../i18n/formatters';

/**
 * Render a human-friendly absolute date from an ISO string, e.g.
 * "Jul 16, 2026". Returns the input unchanged when unparseable so we
 * never render "Invalid Date" in production.
 *
 * `trialDaysLeft` and `daysUntil` lived here until the Admin 1.0 trial banner
 * was removed (62669c57) and took their only callers with it.
 */
export function formatTrialDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso ?? '';
  return formatDate(new Date(ms), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

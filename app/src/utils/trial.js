import { formatDate } from '../i18n/formatters';

/**
 * Render a human-friendly absolute date from an ISO string, e.g.
 * "Jul 16, 2026". Returns the input unchanged when unparseable so we
 * never render "Invalid Date" in production.
 *
 * Goes through `i18n/formatters` rather than `toLocaleDateString` so the
 * date follows the dashboard's UI locale like every other date in the app.
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

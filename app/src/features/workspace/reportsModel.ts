/**
 * Pure logic behind Workspace ▸ Reports.
 *
 * Kept free of React so the three things a customer actually reads - the
 * window label, the downloaded file's name, and which "nothing here" message
 * they get - can be pinned by tests. The numbers themselves are not derived
 * here: the backend rollup is the single source of truth for both the rows and
 * the totals, and re-deriving totals client-side would only create a second
 * implementation that can disagree with the CSV.
 */

/** Trailing windows the report offers. Values are the backend's `days` param. */
export const REPORT_RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

/** One of the offered windows, in days. */
export type ReportRange = (typeof REPORT_RANGES)[number]['days'];

export const DEFAULT_REPORT_RANGE: ReportRange = 30;

/** The `YYYY-MM-DD` UTC date part of an ISO timestamp, or null if unparseable. */
function utcDatePart(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * The filename the CSV download falls back to.
 *
 * Normally the server names the file (its `Content-Disposition` carries the
 * exact window it exported). This mirrors that format for the case where the
 * header can't be read - an API build that predates it being CORS-exposed -
 * so the customer still gets a dated file rather than `download.csv`.
 *
 * Dates are taken in UTC to match the server, not in the viewer's timezone: a
 * report pulled at 01:00 in Delhi must not claim a different day than the file
 * the server built.
 */
export function buildReportFilename(since: string, until: string): string {
  const from = utcDatePart(since);
  const to = utcDatePart(until);
  if (from === null || to === null) return 'oyechats-report.csv';
  return `oyechats-report-${from}-to-${to}.csv`;
}

/**
 * Why the table has nothing in it. The two cases need different words: a
 * brand-new account has nowhere to click yet, whereas an established account
 * looking at a quiet week just needs a wider window.
 *
 * `null` means there is data to show.
 */
export type ReportEmptyReason = 'no-agents' | 'no-activity-in-window';

export function reportEmptyReason(agentCount: number, rowCount: number): ReportEmptyReason | null {
  if (rowCount > 0) return null;
  return agentCount === 0 ? 'no-agents' : 'no-activity-in-window';
}

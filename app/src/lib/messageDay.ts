/**
 * Day-grouping helpers for conversation transcripts.
 *
 * A visitor who returns tomorrow keeps the same session (the widget stores the
 * session id in localStorage), so one conversation can span several calendar
 * days. Without a day marker every bubble shows only a clock time, and a
 * message from today is indistinguishable from one sent yesterday. These
 * helpers back the "Today / Yesterday / Aug 14, 2026" divider inserted whenever
 * the day rolls over. All comparisons are in the viewer's LOCAL timezone.
 */

import { formatDate } from '../i18n/formatters';
import { t as translateNow } from '../i18n/i18n';

/**
 * Stable local-day key ("2026-8-14") for a timestamp, or null when the
 * timestamp is missing/unparseable. Used to detect a day boundary between two
 * consecutive messages.
 */
export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Human day label for a divider: "Today", "Yesterday", or an absolute date
 * ("Aug 14" this year, "Aug 14, 2025" for a prior year). Empty string when the
 * timestamp is missing/unparseable, so callers can skip rendering the divider.
 */
export function formatDayLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  const d = new Date(parsed);

  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (key(d) === key(now)) return translateNow('app.today') || 'Today';
  if (key(d) === key(yesterday)) return translateNow('app.yesterday') || 'Yesterday';

  return formatDate(d, {
    month: 'short',
    day: 'numeric',
    // Explicit `undefined` rather than a conditional spread: `formatDate`
    // merges its own defaults, so an ABSENT year is not the same as a
    // suppressed one - the default would put the year back.
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * True when a day divider should be rendered before ``current`` — i.e. it falls
 * on a different local calendar day than ``previous`` (or it's the first
 * message with a valid timestamp). A missing/unparseable current timestamp
 * never triggers a divider.
 */
export function isNewDay(
  current: string | null | undefined,
  previous: string | null | undefined,
): boolean {
  const cur = dayKey(current);
  if (cur === null) return false;
  return cur !== dayKey(previous);
}

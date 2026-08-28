/**
 * Pure, framework-free helpers for the feedback log. Ported from the legacy
 * `pages/Feedback.jsx:18-77`, now typed and unit-testable in isolation from any
 * component.
 *
 * Two of them deliberately are *not* 1:1 ports any more, both because the
 * legacy behaviour was wrong rather than merely dated:
 *
 * - `buildTrend` took its fourteen buckets off the wrong end of a newest-first
 *   list, so the chart plotted the oldest fortnight in reverse and omitted the
 *   current week.
 * - The CSV export had no defence against spreadsheet formula injection, and
 *   stripped commas out of the data instead of relying on the quoting it
 *   already applied. The escape now lives in the shared `csvField`
 *   (`lib/csvSafe.ts`), alongside the one the lead export uses.
 */
import { csvField } from '../../lib/csvSafe';
import { formatDate } from '../../i18n/formatters';
import { downloadCsv } from '../../lib/downloadCsv';
import { csvFilename } from '../analytics/exportCsv';

import { type FeedbackFilter, type FeedbackItem } from './types';

const DAY_MS = 86_400_000;

/**
 * Keep only the ratings left inside the page's reporting window.
 *
 * Takes the window's start instant rather than a range key of its own, because
 * the key belongs to Analytics: `resolveRange` reads the clock once per
 * selection so every panel on the page measures from the same instant, and a
 * helper that re-derived the cutoff from `Date.now()` would quietly drift away
 * from the header's label between renders. `null` is all of history, and is a
 * passthrough. Named to match `filterVisitorsToWindow`, which does the same job
 * for the visitors tab.
 */
export function filterToWindow(
  items: readonly FeedbackItem[],
  since: Date | null,
): FeedbackItem[] {
  if (since === null) return [...items];
  const cutoff = since.getTime();
  return items.filter((item) => new Date(item.created_at).getTime() >= cutoff);
}

/** Keep only items matching the All / Positive / Negative filter tab. */
export function filterItems(
  items: readonly FeedbackItem[],
  filter: FeedbackFilter,
): FeedbackItem[] {
  if (filter === 'positive') return items.filter((item) => item.feedback === 1);
  if (filter === 'negative') return items.filter((item) => item.feedback !== 1);
  return [...items];
}

export interface FeedbackStats {
  total: number;
  positive: number;
  negative: number;
  /** Positive rate, 0-100, rounded. 0 when there are no ratings. */
  rate: number;
}

/** Summary counts for the stats bar and the filter-tab labels. */
export function computeStats(items: readonly FeedbackItem[]): FeedbackStats {
  const total = items.length;
  const positive = items.filter((item) => item.feedback === 1).length;
  const negative = total - positive;
  const rate = total > 0 ? Math.round((positive / total) * 100) : 0;
  return { total, positive, negative, rate };
}

export interface FeedbackTrendPoint {
  /** Short display label, e.g. "Jul 22". */
  date: string;
  /** Positive rate for the day, 0-100, rounded. */
  rate: number;
  total: number;
}

/** Days plotted on the trend chart, at most, a fortnight reads well at its width. */
const TREND_DAYS = 14;

/**
 * Daily positive-rate trend, bucketed by calendar day, ordered oldest-first and
 * capped to the most recent 14 buckets. `days` scopes the source set to the
 * page's reporting window; `0` is all of history.
 *
 * Buckets are sorted by their own timestamp rather than left in the order the
 * items arrived, which is the whole correctness argument here. The list this is
 * called with comes straight off `/analytics/feedback`, and that endpoint sorts
 * newest-first, so an insertion-ordered `Map` yields newest-first buckets, and
 * taking the *last* 14 of those keeps the fourteen OLDEST days. That was the
 * shipped behaviour: the chart plotted weeks-old history, in reverse, under a
 * heading that says "trend", and dropped the current week entirely. Nothing
 * about the rendered line looks wrong, so nobody would have caught it by
 * looking. Sorting explicitly also decouples this from the endpoint's `ORDER
 * BY`, which no one editing that route would think to check.
 *
 * Oldest-first is what the consumer needs: Recharts plots the array
 * left-to-right along a categorical axis, so index order *is* the time axis.
 *
 * Two points can therefore share a `date` label when the window spans a year
 * boundary, two distinct "Jul 21"s, a year apart. That is the honest rendering:
 * they are different days, and collapsing them into one averaged point is the
 * bug this keys around.
 */
export function buildTrend(items: readonly FeedbackItem[], days: number): FeedbackTrendPoint[] {
  const cutoff = days ? new Date(Date.now() - days * DAY_MS) : null;
  const filtered = cutoff ? items.filter((item) => new Date(item.created_at) >= cutoff) : items;

  const buckets = new Map<string, { date: string; at: number; positive: number; total: number }>();
  for (const item of filtered) {
    const ratedAt = new Date(item.created_at);
    const at = ratedAt.getTime();
    // Key on the absolute day, label with the short form. They cannot be the
    // same string: the label carries no year, so keying on it merges this
    // Jul 21 with last year's into a single averaged point. Reachable from the
    // "All" range on any workspace older than a year, and worse than it looks,
    // because the merged bucket inherits the OLDER timestamp below and can then
    // be dropped from the "most recent 14" entirely.
    const key = `${ratedAt.getFullYear()}-${ratedAt.getMonth()}-${ratedAt.getDate()}`;
    const date = formatDate(ratedAt, { month: 'short', day: 'numeric', year: undefined });
    const bucket = buckets.get(key) ?? { date, at, positive: 0, total: 0 };
    // Earliest instant in the day, so the sort key is the same whichever order
    // that day's ratings happen to arrive in.
    bucket.at = Math.min(bucket.at, at);
    bucket.total += 1;
    if (item.feedback === 1) bucket.positive += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.at - b.at)
    .slice(-TREND_DAYS)
    .map((bucket) => ({
      date: bucket.date,
      rate: bucket.total > 0 ? Math.round((bucket.positive / bucket.total) * 100) : 0,
      total: bucket.total,
    }));
}

export interface TopDownvotedItem {
  question: string;
  count: number;
  /** ISO timestamp of the most recent negative rating for this question. */
  lastAt: string;
}

/**
 * Groups negative ratings by normalized question text and returns the top
 * `limit` most frequently downvoted prompts - the answers to fix first.
 * Ported from the legacy `buildTopDownvoted`.
 */
export function buildTopDownvoted(
  items: readonly FeedbackItem[],
  limit = 5,
): TopDownvotedItem[] {
  const buckets = new Map<string, TopDownvotedItem>();
  for (const item of items) {
    if (item.feedback === 1) continue;
    const raw = item.question.trim();
    if (!raw) continue;
    const key = raw.toLowerCase().replace(/\s+/g, ' ');
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      if (new Date(item.created_at).getTime() > new Date(existing.lastAt).getTime()) {
        existing.lastAt = item.created_at;
      }
    } else {
      buckets.set(key, { question: raw, count: 1, lastAt: item.created_at });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count || new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())
    .slice(0, limit);
}

/** Normalize question text the same way `buildTopDownvoted` keys its buckets, for click-to-jump matching. */
export function normalizeQuestionKey(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the feedback CSV. Columns: `Date,User,Type,Question,Answer`.
 *
 * Every cell goes through the shared `csvField` funnel. Question and Answer are
 * raw chat content (whatever a website visitor typed, verbatim) so this file
 * is attacker-influenced by construction, and routing the whole row through one
 * escape is what keeps a column added later safe without its author having to
 * know that.
 *
 * Note what the funnel deliberately does *not* do: the previous implementation
 * deleted every comma from the data (`.replace(/,/g, '')`) before quoting it.
 * Quoting is what makes a comma safe. Stripping it silently corrupted every
 * answer that contained one, and left `user` quote-unescaped besides.
 *
 * Separated from the download so the file's contents can be tested without a
 * DOM, the same split `leadsCsv.ts` uses, and for the same reason: this is
 * the one path where the data leaves the product, so a regression here is
 * invisible until it is in a customer's spreadsheet.
 */
export function buildFeedbackCsv(items: readonly FeedbackItem[]): string {
  const header = ['Date', 'User', 'Type', 'Question', 'Answer'];
  const rows = items.map((item) =>
    [
      formatDate(item.created_at),
      item.user,
      item.feedback === 1 ? 'Positive' : 'Negative',
      item.question,
      item.answer,
    ]
      .map((value) => csvField(value))
      .join(','),
  );
  return [header.map((value) => csvField(value)).join(','), ...rows].join('\n');
}

/**
 * Download the feedback log as a CSV (there is no server export endpoint).
 *
 * The filename carries the window the rows were taken from, via the same
 * `csvFilename` every other export on Analytics uses. A file called
 * `feedback.csv` sitting in a downloads folder next to last month's is
 * indistinguishable from it, and this panel no longer owns its own period to
 * name it after.
 */
export function exportFeedbackCsv(items: readonly FeedbackItem[], windowLabel: string): void {
  downloadCsv(buildFeedbackCsv(items), csvFilename('feedback', windowLabel));
}

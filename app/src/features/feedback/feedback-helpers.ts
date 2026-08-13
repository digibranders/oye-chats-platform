/**
 * Pure, framework-free helpers for the feedback log. Bucketing and sorting are
 * a 1:1 port of the legacy `pages/Feedback.jsx:18-77`, now typed and
 * unit-testable in isolation from any component.
 *
 * The CSV export deliberately is *not* a 1:1 port any more: the legacy version
 * had no defence against spreadsheet formula injection, and stripped commas
 * out of the data instead of relying on the quoting it already applied. See
 * `csvField` below.
 */
import { csvSafe } from '../../lib/csvSafe';

import { type DateRange, type FeedbackFilter, type FeedbackItem } from './types';

const DAY_MS = 86_400_000;

/** Days represented by each date-range option. `all` has no cutoff. */
const DATE_RANGE_DAYS: Record<DateRange, number> = { '7d': 7, '30d': 30, all: 0 };

/** Keep only items within `range` of "now". `all` is a no-op passthrough. */
export function filterByDateRange(
  items: readonly FeedbackItem[],
  range: DateRange,
): FeedbackItem[] {
  const days = DATE_RANGE_DAYS[range];
  if (!days) return [...items];
  const cutoff = new Date(Date.now() - days * DAY_MS);
  return items.filter((item) => new Date(item.created_at) >= cutoff);
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

/**
 * Daily positive-rate trend, bucketed by calendar day and capped to the most
 * recent 14 buckets (matches the legacy `buildTrendData`). `days` scopes the
 * source set the same way the date-filter segmented control does (0 = all).
 */
export function buildTrend(items: readonly FeedbackItem[], days: number): FeedbackTrendPoint[] {
  const cutoff = days ? new Date(Date.now() - days * DAY_MS) : null;
  const filtered = cutoff ? items.filter((item) => new Date(item.created_at) >= cutoff) : items;

  const buckets = new Map<string, { date: string; positive: number; total: number }>();
  for (const item of filtered) {
    const date = new Date(item.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const bucket = buckets.get(date) ?? { date, positive: 0, total: 0 };
    bucket.total += 1;
    if (item.feedback === 1) bucket.positive += 1;
    buckets.set(date, bucket);
  }

  return Array.from(buckets.values())
    .slice(-14)
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
 * Escape one CSV field. Two independent defences, in order:
 *
 * 1. `csvSafe` stops a value from opening as a formula in the recipient's
 *    spreadsheet. Question and Answer are raw chat content — whatever a
 *    website visitor typed, verbatim — so this file is attacker-influenced by
 *    construction. Every cell goes through the same funnel, so a column added
 *    later is safe without its author having to know that.
 * 2. RFC-4180 quoting keeps commas, quotes and newlines from breaking the
 *    record apart. It does nothing for defence 1: Excel evaluates `"=1+1"`
 *    exactly as it evaluates `=1+1`.
 *
 * Note what is *not* here: the previous implementation deleted every comma
 * from the data (`.replace(/,/g, '')`) before quoting it. Quoting is what
 * makes a comma safe — stripping it silently corrupted every answer that
 * contained one, and left `user` quote-unescaped besides.
 */
function csvField(value: string): string {
  return `"${csvSafe(value).replace(/"/g, '""')}"`;
}

/**
 * Build the feedback CSV. Columns: `Date,User,Type,Question,Answer`.
 *
 * Separated from the download so the file's contents can be tested without a
 * DOM — the same split `leadsCsv.ts` uses, and for the same reason: this is
 * the one path where the data leaves the product, so a regression here is
 * invisible until it is in a customer's spreadsheet.
 */
export function buildFeedbackCsv(items: readonly FeedbackItem[]): string {
  const header = ['Date', 'User', 'Type', 'Question', 'Answer'];
  const rows = items.map((item) =>
    [
      new Date(item.created_at).toLocaleDateString(),
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

/** Download the feedback log as a CSV (there is no server export endpoint). */
export function exportFeedbackCsv(items: readonly FeedbackItem[]): void {
  const blob = new Blob([buildFeedbackCsv(items)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'feedback.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

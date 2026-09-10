import { describe, expect, it } from 'vitest';
import type { OperatorRating } from '../analytics/useAnalyticsData';
import {
  buildOperatorReportCsv,
  defaultReportMonth,
  operatorReportFilename,
  reportMonths,
} from './operator-report';

/**
 * The monthly report file.
 *
 * Nobody reviews a CSV by looking at the product, so the things that matter
 * are pinned here: the columns and their order, blanks where a number would
 * mislead, and which calendar month a given day belongs to.
 */

function operator(overrides: Partial<OperatorRating> = {}): OperatorRating {
  return {
    operatorId: 1,
    name: 'Ana',
    email: 'ana@example.com',
    disambiguator: null,
    handled: 12,
    total: 6,
    average: 4.5,
    unhappy: 1,
    stars: { 5: 4, 4: 1, 3: 0, 2: 1, 1: 0 },
    ...overrides,
  };
}

/** Cells of a CSV built by `csvField`, which quotes every cell and never embeds commas here. */
function cells(line: string): string[] {
  return line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"'));
}

describe('buildOperatorReportCsv', () => {
  it('writes the header in reading order: who, how many, how well', () => {
    const [header] = buildOperatorReportCsv([]).split('\n');
    expect(cells(header)).toEqual([
      'Operator ID',
      'Operator',
      'Email',
      'Chats handled',
      'Chats rated',
      'Average rating',
      '5 star',
      '4 star',
      '3 star',
      '2 star',
      '1 star',
      'Unhappy (1-2 stars)',
    ]);
  });

  it('puts chats handled before chats rated, and stars from 5 down to 1', () => {
    const [, row] = buildOperatorReportCsv([operator()]).split('\n');
    expect(cells(row)).toEqual([
      '1',
      'Ana',
      'ana@example.com',
      '12',
      '6',
      '4.5',
      '4',
      '1',
      '0',
      '1',
      '0',
      '1',
    ]);
  });

  it('leaves the average blank for an operator nobody rated, rather than a misleading zero', () => {
    const [, row] = buildOperatorReportCsv([
      operator({ handled: 3, total: 0, average: null, unhappy: 0, stars: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } }),
    ]).split('\n');
    const values = cells(row);
    expect(values[5]).toBe('');
  });

  it('neutralises a spreadsheet formula typed into an operator name', () => {
    const [, row] = buildOperatorReportCsv([operator({ name: '=HYPERLINK("https://evil.test")' })]).split(
      '\n',
    );
    expect(cells(row)[1]).toBe('\'=HYPERLINK("https://evil.test")');
  });
});

describe('report months', () => {
  it('offers the month in progress first, marked as unfinished, then a year back', () => {
    const months = reportMonths(new Date(2026, 8, 10));
    expect(months).toHaveLength(13);
    expect(months[0]).toEqual({ value: '2026-09', label: 'September 2026 (so far)' });
    expect(months[1]).toEqual({ value: '2026-08', label: 'August 2026' });
    expect(months[12].value).toBe('2025-09');
  });

  it('defaults to the last complete month, not the one still changing', () => {
    expect(defaultReportMonth(new Date(2026, 8, 10))).toBe('2026-08');
  });

  it('rolls back across a year boundary in January', () => {
    expect(defaultReportMonth(new Date(2026, 0, 15))).toBe('2025-12');
    expect(reportMonths(new Date(2026, 0, 15))[1].label).toBe('December 2025');
  });

  it('names the file after its month so a downloads folder sorts', () => {
    expect(operatorReportFilename('2026-08')).toBe('oyechats-operator-ratings-2026-08.csv');
  });
});

describe('buildOperatorReportCsv: row identity', () => {
  it('leads every row with the seat id, because names and even emails repeat', () => {
    const lines = buildOperatorReportCsv([
      operator({ operatorId: 228, name: 'Sam Rae', email: 'sam@example.com' }),
      operator({ operatorId: 238, name: 'Sam Rae', email: 'sam@example.com', total: 0, average: null }),
    ]).split('\n');
    expect(cells(lines[1]).slice(0, 3)).toEqual(['228', 'Sam Rae', 'sam@example.com']);
    expect(cells(lines[2]).slice(0, 3)).toEqual(['238', 'Sam Rae', 'sam@example.com']);
  });
});

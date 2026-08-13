import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_RANGE,
  REPORT_RANGES,
  buildReportFilename,
  reportEmptyReason,
} from './reportsModel';

/**
 * The report is the one screen whose output leaves the product: an agency
 * downloads it and forwards it to their own client. So the two things that
 * survive that hand-off - the filename, and whether the page told the truth
 * about having no data - are what these tests pin.
 */

describe('REPORT_RANGES', () => {
  it('offers exactly the three windows the backend accepts', () => {
    expect(REPORT_RANGES.map((range) => range.days)).toEqual([7, 30, 90]);
  });

  it('defaults to a window that is one of the offered ones', () => {
    expect(REPORT_RANGES.some((range) => range.days === DEFAULT_REPORT_RANGE)).toBe(true);
  });

  it('stays inside the backend`s 1-365 day bounds', () => {
    for (const range of REPORT_RANGES) {
      expect(range.days).toBeGreaterThanOrEqual(1);
      expect(range.days).toBeLessThanOrEqual(365);
    }
  });
});

describe('buildReportFilename', () => {
  it('names the file after the window it covers', () => {
    expect(
      buildReportFilename('2026-07-14T09:15:00+00:00', '2026-08-13T09:15:00+00:00'),
    ).toBe('oyechats-report-2026-07-14-to-2026-08-13.csv');
  });

  it('matches the format the server sends, so the fallback is invisible', () => {
    // The server builds `oyechats-report-{since:%Y-%m-%d}-to-{until:%Y-%m-%d}.csv`
    // (analytics_routes.get_per_bot_rollup_csv). Same shape, same separators.
    const name = buildReportFilename('2026-01-05T00:00:00Z', '2026-01-12T00:00:00Z');
    expect(name).toMatch(/^oyechats-report-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(name).toBe('oyechats-report-2026-01-05-to-2026-01-12.csv');
  });

  it('dates in UTC regardless of how the timestamp is offset', () => {
    // 23:30 on the 13th in +05:30 is 18:00 on the 13th UTC - the same day the
    // server used. A viewer-local formatter would have said the 14th.
    expect(
      buildReportFilename('2026-07-14T05:30:00+05:30', '2026-08-13T23:30:00+05:30'),
    ).toBe('oyechats-report-2026-07-14-to-2026-08-13.csv');
  });

  it('falls back to an undated name rather than emitting `NaN` at the user', () => {
    expect(buildReportFilename('not-a-date', '2026-08-13T00:00:00Z')).toBe(
      'oyechats-report.csv',
    );
    expect(buildReportFilename('2026-08-13T00:00:00Z', '')).toBe('oyechats-report.csv');
  });
});

describe('reportEmptyReason', () => {
  it('says nothing is empty when there are rows', () => {
    expect(reportEmptyReason(0, 3)).toBeNull();
    expect(reportEmptyReason(4, 1)).toBeNull();
  });

  it('sends a brand-new account to create an agent', () => {
    expect(reportEmptyReason(0, 0)).toBe('no-agents');
  });

  it('tells an established account to widen the window instead', () => {
    // The distinction matters: an agency with eight live agents and a quiet
    // week must not be told to "create your first chatbot".
    expect(reportEmptyReason(8, 0)).toBe('no-activity-in-window');
  });
});

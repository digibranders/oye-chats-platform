import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANGE,
  parseAgentFigures,
  parseRange,
  rangeLabel,
  windowActivity,
} from './overview-data';

describe('reporting range', () => {
  it('accepts only the ranges the control offers', () => {
    expect(parseRange('7')).toBe(7);
    expect(parseRange('30')).toBe(30);
    expect(parseRange('90')).toBe(90);
  });

  /* The range comes out of the URL, which anyone can type into. A junk value
     falls back rather than reaching the API as `?days=NaN`. */
  it('falls back on anything else, including a value the API would reject', () => {
    expect(parseRange(null)).toBe(DEFAULT_RANGE);
    expect(parseRange('')).toBe(DEFAULT_RANGE);
    expect(parseRange('1000')).toBe(DEFAULT_RANGE);
    expect(parseRange('drop table')).toBe(DEFAULT_RANGE);
  });

  it('labels the window it actually covers', () => {
    expect(rangeLabel(7)).toBe('Last 7 days');
  });
});

describe('activity windowing', () => {
  /* `/analytics/activity` takes no `days`, so the trim happens client-side.
     Comparing the backend's `YYYY-MM-DD` strings avoids `new Date("2026-07-20")`,
     which parses as UTC midnight and shifts a day for viewers west of UTC. */
  const now = new Date(2026, 7, 19); // 19 Aug 2026, local

  it('keeps the selected window inclusive of today', () => {
    const points = [
      { date: '2026-08-19', messages: 5 },
      { date: '2026-08-13', messages: 3 },
      { date: '2026-08-12', messages: 9 },
    ];
    expect(windowActivity(points, 7, now).map((point) => point.date)).toEqual([
      '2026-08-19',
      '2026-08-13',
    ]);
  });

  it('keeps everything inside a longer window', () => {
    const points = [{ date: '2026-06-01', messages: 1 }];
    expect(windowActivity(points, 90, now)).toHaveLength(1);
    expect(windowActivity(points, 30, now)).toHaveLength(0);
  });

  it('drops a row with no usable date instead of rendering it at the origin', () => {
    const points = [{ date: '', messages: 4 }] as { date: string; messages: number }[];
    expect(windowActivity(points, 30, now)).toHaveLength(0);
  });
});

describe('dashboard figures', () => {
  it('reads the demo-share funnel the app has never surfaced', () => {
    const figures = parseAgentFigures({
      total_conversations: 40,
      total_messages: 210,
      active_users: 2,
      demo_shares: 8,
      demo_opens: 6,
      demo_open_rate: 75,
    });
    expect(figures).toEqual({
      conversations: 40,
      messages: 210,
      activeVisitors: 2,
      demoShares: 8,
      demoOpens: 6,
      demoOpenRate: 75,
    });
  });

  /* The server sends `demo_open_rate: 0` when nothing has been shared, which
     would render an honest-looking "0%" for a chatbot nobody has ever shared. */
  it('reports an open rate over zero shares as absent, not as zero per cent', () => {
    expect(parseAgentFigures({ demo_shares: 0, demo_open_rate: 0 }).demoOpenRate).toBeNull();
  });

  it('survives a payload missing every key', () => {
    expect(parseAgentFigures({})).toEqual({
      conversations: 0,
      messages: 0,
      activeVisitors: 0,
      demoShares: 0,
      demoOpens: 0,
      demoOpenRate: null,
    });
  });
});

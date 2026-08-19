import { describe, expect, it } from 'vitest';
import { filterVisitorsToWindow, parseVisitors } from './visitors';

/**
 * `/analytics/visitors` has never had a client in the product, so nothing has
 * ever exercised its payload. It also has no date filter of its own, which is
 * why the page's window is applied here — and why a row that cannot be placed
 * in time must not be counted inside one.
 */

const RAW = [
  {
    session_id: 'a,b',
    all_session_ids: ['a', 'b'],
    visitor: 'user1',
    location: 'Mumbai, India',
    device: 'Mobile',
    chats: 14,
    last_active_at: '2026-08-18T10:00:00Z',
  },
  {
    session_id: 'c',
    all_session_ids: ['c'],
    visitor: 'user2',
    location: 'Unknown',
    device: 'Desktop',
    chats: 3,
    last_active_at: '2026-06-01T10:00:00Z',
  },
];

describe('parseVisitors', () => {
  it('reads one row per visitor, with their session count', () => {
    const [first] = parseVisitors(RAW);
    expect(first).toEqual({
      id: 'a,b',
      visitor: 'user1',
      location: 'Mumbai, India',
      device: 'Mobile',
      messages: 14,
      conversations: 2,
      lastActiveAt: '2026-08-18T10:00:00Z',
    });
  });

  it('drops a row with no session id rather than rendering a keyless one', () => {
    expect(parseVisitors([{ visitor: 'user9' }])).toEqual([]);
  });

  it('defaults the missing fields instead of showing "undefined"', () => {
    const [row] = parseVisitors([{ session_id: 'z' }]);
    expect(row.location).toBe('Unknown');
    expect(row.device).toBe('Unknown');
    expect(row.messages).toBe(0);
    expect(row.conversations).toBe(1);
    expect(row.lastActiveAt).toBeNull();
  });

  it('survives an empty or absent payload', () => {
    expect(parseVisitors(null)).toEqual([]);
    expect(parseVisitors([])).toEqual([]);
  });
});

describe('filterVisitorsToWindow', () => {
  const rows = parseVisitors(RAW);

  it('keeps only the visitors last seen inside the window', () => {
    const kept = filterVisitorsToWindow(rows, new Date('2026-08-01T00:00:00Z'));
    expect(kept.map((row) => row.visitor)).toEqual(['user1']);
  });

  it('keeps everyone on an all-time range', () => {
    expect(filterVisitorsToWindow(rows, null)).toHaveLength(2);
  });

  it('excludes a row with no timestamp from a windowed count', () => {
    // It cannot be placed in the window, and counting it inside one would
    // overstate every period on the page.
    const undated = parseVisitors([{ session_id: 'q', visitor: 'user5' }]);
    expect(filterVisitorsToWindow(undated, new Date('2020-01-01T00:00:00Z'))).toEqual([]);
    expect(filterVisitorsToWindow(undated, null)).toHaveLength(1);
  });
});

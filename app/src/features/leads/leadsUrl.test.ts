import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEADS_URL_STATE,
  hasActiveFilters,
  hasClientRefinement,
  leadsRangeLabel,
  leadsRangeWindow,
  readLeadsUrl,
  writeLeadsUrl,
} from './leadsUrl';

function read(search: string) {
  return readLeadsUrl(new URLSearchParams(search));
}

function write(search: string, patch: Parameters<typeof writeLeadsUrl>[1]): string {
  return writeLeadsUrl(read(search), patch).toString();
}

describe('readLeadsUrl', () => {
  it('answers the default view for an empty query string', () => {
    expect(read('')).toEqual(DEFAULT_LEADS_URL_STATE);
  });

  it('reads a fully specified view', () => {
    expect(
      read('q=priya&who=named&tier=sql&score=75&range=90d&page=3&sort=quality:desc&lead=s1&tab=conversation'),
    ).toEqual({
      query: 'priya',
      contact: 'named',
      tier: 'sql',
      minScore: 75,
      range: '90d',
      rangeFrom: null,
      rangeTo: null,
      page: 3,
      sort: { key: 'quality', direction: 'desc' },
      openLead: 's1',
      tab: 'conversation',
    });
  });

  it('reads a custom range with both bounds', () => {
    const state = read('range=custom&from=2026-08-01&to=2026-08-20');
    expect(state.range).toBe('custom');
    expect(state.rangeFrom).toBe('2026-08-01');
    expect(state.rangeTo).toBe('2026-08-20');
  });

  it('drops an unknown range, and from/to malformed or unpaired with custom', () => {
    expect(read('range=decade').range).toBe('all');
    expect(read('range=custom&from=not-a-date').rangeFrom).toBeNull();
    expect(read('range=custom&from=2026-13-40').rangeFrom).toBeNull();
    // from/to read regardless of `range` — `writeLeadsUrl` is what keeps them
    // from ever being written outside 'custom'; a hand-edited URL with a
    // stray `from=` on a preset range still parses the date, it just goes
    // unused by `leadsRangeWindow` once `range !== 'custom'`.
    expect(read('range=30d&from=2026-08-01').rangeFrom).toBe('2026-08-01');
  });

  it('drops a hand-edited score that is not one of the offered thresholds', () => {
    // Dropped rather than clamped: `?score=999` should show the unfiltered list,
    // not an empty one the reader cannot explain.
    expect(read('score=999').minScore).toBeNull();
  });

  it('drops an unknown tier, sort key and sort direction', () => {
    expect(read('tier=platinum').tier).toBeNull();
    expect(read('sort=salary:asc').sort).toBeNull();
    expect(read('sort=quality:sideways').sort).toBeNull();
  });

  it('refuses a page number below one', () => {
    expect(read('page=0').page).toBe(1);
    expect(read('page=-4').page).toBe(1);
    expect(read('page=two').page).toBe(1);
  });
});

describe('writeLeadsUrl', () => {
  it('omits every default, so an unfiltered view is a bare path', () => {
    expect(write('', {})).toBe('');
  });

  it('resets to page one whenever the set of matching rows changes', () => {
    // Page 4 of a newly filtered list is a different four leads, and usually
    // does not exist at all.
    expect(write('page=4', { tier: 'sql' })).toBe('tier=sql');
    expect(write('page=4', { minScore: 50 })).toBe('score=50');
    expect(write('page=4', { query: 'priya' })).toBe('q=priya');
    expect(write('page=4', { contact: 'named' })).toBe('who=named');
  });

  it('keeps the page when only the sort or the open lead changes', () => {
    expect(write('page=4', { sort: { key: 'chats', direction: 'asc' } })).toContain('page=4');
    expect(write('page=4', { openLead: 's1' })).toContain('page=4');
  });

  it('lets an explicit page win over the reset', () => {
    expect(write('page=4', { tier: 'sql', page: 2 })).toBe('tier=sql&page=2');
  });

  it('does not reset the page when a patch sets a filter to what it already was', () => {
    expect(write('page=4&tier=sql', { tier: 'sql' })).toContain('page=4');
  });

  it('drops a stale tab when the drawer closes', () => {
    // Otherwise a shared link carries `?tab=conversation` with no lead to open.
    expect(write('lead=s1&tab=conversation', { openLead: null })).toBe('');
  });

  it('trims the search text it stores', () => {
    expect(write('', { query: '  priya  ' })).toBe('q=priya');
  });

  it('round-trips through read', () => {
    const written = write('', { tier: 'mql', minScore: 25, sort: { key: 'lead', direction: 'asc' } });
    expect(read(written)).toMatchObject({
      tier: 'mql',
      minScore: 25,
      sort: { key: 'lead', direction: 'asc' },
    });
  });

  it('writes from/to only for a custom range', () => {
    expect(write('', { range: 'custom', rangeFrom: '2026-08-01', rangeTo: '2026-08-20' })).toBe(
      'range=custom&from=2026-08-01&to=2026-08-20',
    );
    expect(write('', { range: '30d' })).toBe('range=30d');
  });

  it('drops a stale from/to when the range leaves custom', () => {
    // Otherwise picking a preset after a custom range keeps the old bounds in
    // the URL, invisible until the reader switches back to 'custom'.
    expect(write('range=custom&from=2026-08-01&to=2026-08-20', { range: '7d' })).toBe('range=7d');
  });
});

describe('leadsRangeWindow', () => {
  it('resolves a preset to a trailing days count, with no from/to', () => {
    expect(leadsRangeWindow({ range: '30d', rangeFrom: null, rangeTo: null })).toEqual({
      days: 30,
      from: null,
      to: null,
    });
    expect(leadsRangeWindow({ range: 'all', rangeFrom: null, rangeTo: null })).toEqual({
      days: null,
      from: null,
      to: null,
    });
  });

  it('resolves custom to from/to, with no days', () => {
    expect(
      leadsRangeWindow({ range: 'custom', rangeFrom: '2026-08-01', rangeTo: '2026-08-20' }),
    ).toEqual({ days: null, from: '2026-08-01', to: '2026-08-20' });
  });
});

describe('leadsRangeLabel', () => {
  it('names a preset the same way Analytics does', () => {
    expect(leadsRangeLabel({ range: '7d', rangeFrom: null, rangeTo: null })).toBe('Last 7 days');
    expect(leadsRangeLabel({ range: 'all', rangeFrom: null, rangeTo: null })).toBe('All time');
  });

  it('names a custom range by its bounds, or by whichever bound is set', () => {
    expect(
      leadsRangeLabel({ range: 'custom', rangeFrom: '2026-08-01', rangeTo: '2026-08-20' }),
    ).toBe('1 Aug 2026 to 20 Aug 2026');
    expect(leadsRangeLabel({ range: 'custom', rangeFrom: '2026-08-01', rangeTo: null })).toBe(
      'Since 1 Aug 2026',
    );
    expect(leadsRangeLabel({ range: 'custom', rangeFrom: null, rangeTo: '2026-08-20' })).toBe(
      'Through 20 Aug 2026',
    );
    expect(leadsRangeLabel({ range: 'custom', rangeFrom: null, rangeTo: null })).toBe('Custom range');
  });
});

describe('filter predicates', () => {
  it('separates a filter from a sort', () => {
    // Sorting does not change which leads match, so it must not offer to be
    // cleared alongside the filters.
    expect(hasActiveFilters(read('sort=quality:desc'))).toBe(false);
    expect(hasActiveFilters(read('tier=sql'))).toBe(true);
  });

  it('knows which filters run in the browser', () => {
    // Only these two are applied to the fetched page rather than to every lead,
    // which is what the page tells the reader.
    expect(hasClientRefinement(read('tier=sql&score=75'))).toBe(false);
    expect(hasClientRefinement(read('q=priya'))).toBe(true);
    expect(hasClientRefinement(read('who=anonymous'))).toBe(true);
  });
});

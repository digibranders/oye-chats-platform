import { describe, expect, it } from 'vitest';
import {
  applySort,
  byDate,
  byNumber,
  byText,
  formatSort,
  includesText,
  isTruncated,
  pageSlice,
  parseSort,
} from './recordListState';
import { humanise, isFetchableSessionId } from './records/types';

/**
 * The pure half of the record lists.
 *
 * Everything here decides what a super-admin is looking at — which page, in what
 * order, filtered to what — and every one of them fails silently when it is
 * wrong: a mis-clamped page blanks a table that has rows, and a comparator that
 * treats a missing date as epoch zero puts the newest records last.
 */

describe('sort state in the URL', () => {
  it('round-trips a sort so a filtered list is a link', () => {
    expect(formatSort({ key: 'name', direction: 'asc' })).toBe('name:asc');
    expect(parseSort('name:asc')).toEqual({ key: 'name', direction: 'asc' });
    expect(formatSort(null)).toBeNull();
  });

  it('refuses a malformed or hand-edited sort rather than half-applying it', () => {
    expect(parseSort('')).toBeNull();
    expect(parseSort('name')).toBeNull();
    expect(parseSort('name:sideways')).toBeNull();
    expect(parseSort(':asc')).toBeNull();
  });
});

describe('applySort', () => {
  const rows = [{ n: 'b' }, { n: 'a' }, { n: 'c' }];
  const comparators = { n: byText((row: { n: string }) => row.n) };

  it('leaves the server ordering alone when nothing is sorted', () => {
    expect(applySort(rows, null, comparators)).toEqual(rows);
  });

  it('degrades to the server ordering for a column that no longer exists', () => {
    // A sort pasted in from an older URL must not blank the table.
    expect(applySort(rows, { key: 'gone', direction: 'asc' }, comparators)).toEqual(rows);
  });

  it('sorts both ways without mutating the input', () => {
    const asc = applySort(rows, { key: 'n', direction: 'asc' }, comparators);
    const desc = applySort(rows, { key: 'n', direction: 'desc' }, comparators);
    expect(asc.map((row) => row.n)).toEqual(['a', 'b', 'c']);
    expect(desc.map((row) => row.n)).toEqual(['c', 'b', 'a']);
    expect(rows.map((row) => row.n)).toEqual(['b', 'a', 'c']);
  });
});

describe('comparators', () => {
  it('keeps absent text last in BOTH directions, not just ascending', () => {
    // Negating a comparator that returns 1 for an absent value flips this rule
    // on the descending press and floats a column of em dashes to the top.
    const rows = [{ v: null }, { v: 'b' }, { v: 'a' }];
    const comparators = { v: byText((row: { v: string | null }) => row.v) };
    expect(applySort(rows, { key: 'v', direction: 'asc' }, comparators).map((row) => row.v)).toEqual([
      'a',
      'b',
      null,
    ]);
    expect(applySort(rows, { key: 'v', direction: 'desc' }, comparators).map((row) => row.v)).toEqual([
      'b',
      'a',
      null,
    ]);
  });

  it('sorts absent numbers last rather than as zero', () => {
    const rows = [{ v: 5 }, { v: null }, { v: 0 }];
    const comparators = { v: byNumber((row: { v: number | null }) => row.v) };
    expect(applySort(rows, { key: 'v', direction: 'asc' }, comparators).map((row) => row.v)).toEqual([
      0, 5, null,
    ]);
    expect(applySort(rows, { key: 'v', direction: 'desc' }, comparators).map((row) => row.v)).toEqual([
      5, 0, null,
    ]);
  });

  it('sorts an unparseable date last rather than as 1970', () => {
    const rows = [
      { at: '2026-08-19T10:00:00Z' },
      { at: null },
      { at: 'not a date' },
      { at: '2026-08-18T10:00:00Z' },
    ];
    const comparators = { at: byDate((row: { at: string | null }) => row.at) };
    expect(applySort(rows, { key: 'at', direction: 'asc' }, comparators).map((row) => row.at)).toEqual([
      '2026-08-18T10:00:00Z',
      '2026-08-19T10:00:00Z',
      null,
      'not a date',
    ]);
  });
});

describe('pageSlice', () => {
  const rows = Array.from({ length: 55 }, (_, index) => index);

  it('returns exactly the requested page, 1-based', () => {
    expect(pageSlice(rows, 1, 25)).toEqual(rows.slice(0, 25));
    expect(pageSlice(rows, 3, 25)).toEqual(rows.slice(50, 55));
  });

  it('clamps a page out of a shared URL instead of blanking the table', () => {
    expect(pageSlice(rows, 99, 25)).toEqual(rows.slice(50, 55));
    expect(pageSlice(rows, 0, 25)).toEqual(rows.slice(0, 25));
    expect(pageSlice(rows, -4, 25)).toEqual(rows.slice(0, 25));
  });

  it('survives an empty set', () => {
    expect(pageSlice([], 1, 25)).toEqual([]);
    expect(pageSlice([], 4, 25)).toEqual([]);
  });
});

describe('includesText', () => {
  it('matches case-insensitively across every supplied field', () => {
    expect(includesText(['Acme Ltd', 'ops@acme.com'], 'ACME')).toBe(true);
    expect(includesText(['Acme Ltd', null, 42], '42')).toBe(true);
    expect(includesText(['Acme Ltd'], 'zzz')).toBe(false);
  });

  it('treats an empty or whitespace query as no filter at all', () => {
    expect(includesText([null, undefined], '')).toBe(true);
    expect(includesText([null], '   ')).toBe(true);
  });
});

describe('isTruncated', () => {
  it('is true only when the response reached the endpoint cap', () => {
    // These endpoints give no other signal that rows were dropped.
    expect(isTruncated(499, 500)).toBe(false);
    expect(isTruncated(500, 500)).toBe(true);
  });
});

describe('session ids', () => {
  it('accepts a real conversation id, now that the endpoint does', () => {
    // The detail route declared its path parameter as `int` against a String
    // primary key, so it 422'd every UUID and this guard refused to call it.
    // Both halves are fixed; the guard now only mirrors the server's own
    // `Identifier` bounds so we skip a request it would reject on shape.
    expect(isFetchableSessionId('9f2c7a1e-4d5b-4c8a-9c11-2f3a4b5c6d7e')).toBe(true);
    expect(isFetchableSessionId('42')).toBe(true);
    expect(isFetchableSessionId('sess_a.b:c-d')).toBe(true);
  });

  it('rejects what the server would reject, without spending a request on it', () => {
    expect(isFetchableSessionId('')).toBe(false);
    expect(isFetchableSessionId('not a valid id')).toBe(false);
    expect(isFetchableSessionId('a/../b')).toBe(false);
    expect(isFetchableSessionId('x'.repeat(129))).toBe(false);
  });
});

describe('humanise', () => {
  it('renders an absent vocabulary value as an em dash, never as an empty cell', () => {
    expect(humanise(null)).toBe('—');
    expect(humanise('feature_request')).toBe('feature request');
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * One list endpoint answering oddly must not take down the page it sits on.
 *
 * `KnowledgeGapsCard` moved onto Experience ▸ UAQ, beside branding, messages,
 * voice, language and handoff. It hands `section.data` straight to `DataTable`,
 * which spreads its rows — so a non-array reached a spread, threw
 * `is not iterable` during render, and the error boundary replaced the ENTIRE
 * Experience page with "Something went wrong". Five working sections lost
 * because a sixth got an unexpected shape.
 *
 * The old guard was `rows ?? NO_GAPS`, which only catches null and undefined.
 * Anything else — an error envelope served with a 200, an HTML error page from
 * a proxy, an endpoint that grows an `{items: []}` envelope — sailed through.
 */
const queryResult = { data: undefined as unknown, isPending: false, isError: false, error: null, refetch: vi.fn() };

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryResult,
}));
vi.mock('../../../services/api', () => ({ getUnansweredQuestions: vi.fn() }));

import { useKnowledgeGaps } from './useKnowledgeGaps';

function dataFor(payload: unknown) {
  queryResult.data = payload;
  return renderHook(() => useKnowledgeGaps(7)).result.current.section.data;
}

beforeEach(() => {
  queryResult.isPending = false;
  queryResult.isError = false;
});

describe('useKnowledgeGaps', () => {
  it('passes a real list straight through', () => {
    const rows = [{ question: 'do you ship to Canada?', count: 3, last_asked: '2026-08-30T10:00:00Z' }];
    expect(dataFor(rows)).toEqual(rows);
  });

  it('is an empty list when the endpoint has answered nothing yet', () => {
    expect(dataFor(undefined)).toEqual([]);
  });

  it('is an empty list when the endpoint answers null', () => {
    expect(dataFor(null)).toEqual([]);
  });

  it('is an empty list when the endpoint answers an object', () => {
    // The exact shape that crashed the page: a 200 carrying `{}`.
    expect(dataFor({})).toEqual([]);
  });

  it('is an empty list when the endpoint grows an envelope', () => {
    // A plausible future break: the endpoint starts returning `{items: [...]}`.
    // The card should go empty and the page stay up, not die on a spread.
    expect(dataFor({ items: [{ question: 'x', count: 1, last_asked: null }] })).toEqual([]);
  });

  it('is an empty list when a proxy answers with HTML', () => {
    expect(dataFor('<!doctype html><title>502</title>')).toEqual([]);
  });

  it('always returns something DataTable can spread', () => {
    // The invariant stated directly: whatever arrives, the result is iterable.
    for (const payload of [undefined, null, {}, '', 0, false, 'text', { items: [] }]) {
      expect(() => [...(dataFor(payload) as unknown[])]).not.toThrow();
    }
  });
});

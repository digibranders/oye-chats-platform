import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, parseTab, tabFromPath, tabFromUrl, tabUrl } from './tabs';

/**
 * The URL contract, in both directions.
 *
 * Every view has a path now. `?tab=` is the one thing here that is not a path,
 * and it is kept for a single reason: it shipped, so it is in links and
 * bookmarks, and the index view redirects it rather than silently rendering
 * Overview under an address that asked for Feedback.
 */

describe('tabFromPath', () => {
  it('reads the view out of the path', () => {
    expect(tabFromPath('/analytics')).toBe('overview');
    expect(tabFromPath('/analytics/conversations')).toBe('conversations');
    expect(tabFromPath('/analytics/visitors')).toBe('visitors');
    expect(tabFromPath('/analytics/feedback')).toBe('feedback');
  });

  it('does not let the index claim a sibling by prefix', () => {
    // `/analytics` is a prefix of every other view's path, so a naive
    // `startsWith` walk returns Overview for all five.
    expect(tabFromPath('/analytics/visitors')).not.toBe('overview');
  });

  it('tolerates a trailing slash', () => {
    expect(tabFromPath('/analytics/visitors/')).toBe('visitors');
  });

  it('falls back to the index for a path it does not know', () => {
    expect(tabFromPath('/analytics/nonsense')).toBe(DEFAULT_TAB);
  });
});

describe('tabFromUrl', () => {
  it('still resolves the legacy query string, so an old link is not a 404', () => {
    expect(tabFromUrl('/analytics', new URLSearchParams('tab=visitors'))).toBe('visitors');
  });

  it('lets the path win over a stale tab parameter', () => {
    // A bookmark of `/analytics/visitors?tab=feedback` is a link to Visitors
    // with a leftover parameter on it, not a link to Feedback.
    expect(tabFromUrl('/analytics/visitors', new URLSearchParams('tab=feedback'))).toBe('visitors');
  });

  it('falls back to the first view for an unknown value', () => {
    expect(tabFromUrl('/analytics', new URLSearchParams('tab=nonsense'))).toBe(DEFAULT_TAB);
    expect(parseTab(null)).toBe(DEFAULT_TAB);
  });
});

describe('tabUrl', () => {
  it('keeps the range and every other filter when the view changes', () => {
    expect(tabUrl('visitors', new URLSearchParams('range=90d'))).toBe(
      '/analytics/visitors?range=90d',
    );
  });

  it('gives every view its own path', () => {
    expect(tabUrl('feedback', new URLSearchParams('range=7d'))).toBe('/analytics/feedback?range=7d');
    expect(tabUrl('conversations', new URLSearchParams())).toBe('/analytics/conversations');
  });

  it('leaves the index view at the section root', () => {
    expect(tabUrl('overview', new URLSearchParams())).toBe('/analytics');
  });

  it('drops the legacy tab parameter rather than carrying it forward', () => {
    // Otherwise every URL the row produces would wear a stale `?tab=` naming
    // whichever view the reader happened to arrive from.
    expect(tabUrl('visitors', new URLSearchParams('tab=feedback'))).toBe('/analytics/visitors');
    expect(tabUrl('overview', new URLSearchParams('tab=visitors&range=7d'))).toBe(
      '/analytics?range=7d',
    );
  });
});

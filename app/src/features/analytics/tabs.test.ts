import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, parseTab, tabFromUrl, tabUrl } from './tabs';

/**
 * Tab state used to be component-local, so a refresh, a Back press and a shared
 * link all landed on the first tab. These are the two directions of the URL
 * contract that replaced it — and the one legacy path, `/analytics/journey`,
 * that has to keep resolving because a redirect from the old top-level
 * `/journey` points at it.
 */

describe('tabFromUrl', () => {
  it('reads the tab out of the query string', () => {
    expect(tabFromUrl('/analytics', new URLSearchParams('tab=visitors'))).toBe('visitors');
  });

  it('treats the journey path as the journey tab, whatever the query says', () => {
    expect(tabFromUrl('/analytics/journey', new URLSearchParams())).toBe('journey');
    expect(tabFromUrl('/analytics/journey/', new URLSearchParams('tab=feedback'))).toBe('journey');
  });

  it('falls back to the first tab for an unknown value', () => {
    expect(tabFromUrl('/analytics', new URLSearchParams('tab=nonsense'))).toBe(DEFAULT_TAB);
    expect(parseTab(null)).toBe(DEFAULT_TAB);
  });
});

describe('tabUrl', () => {
  it('keeps the range and every other filter when the tab changes', () => {
    expect(tabUrl('visitors', new URLSearchParams('range=90d'))).toBe(
      '/analytics?range=90d&tab=visitors',
    );
  });

  it('sends journey to its own path rather than a query parameter', () => {
    expect(tabUrl('journey', new URLSearchParams('range=7d'))).toBe('/analytics/journey?range=7d');
  });

  it('leaves the default tab out of the URL entirely', () => {
    expect(tabUrl('overview', new URLSearchParams())).toBe('/analytics');
  });

  it('drops a stale tab parameter when moving to the journey path', () => {
    expect(tabUrl('journey', new URLSearchParams('tab=visitors'))).toBe('/analytics/journey');
  });
});

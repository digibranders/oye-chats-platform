/**
 * The tab set, and where each one lives in the URL.
 *
 * Tab state was component-local, so refresh and Back always landed on the first
 * tab and a link to "the funnel" could not be sent to anyone. It is in the URL
 * now — `/analytics?tab=visitors` — with one exception: Journey keeps its own
 * path, `/analytics/journey`, because that URL is already in the wild (the old
 * top-level `/journey` redirects to it) and a path that resolves is worth more
 * than a tidy query string.
 */

export type AnalyticsTab = 'overview' | 'conversations' | 'journey' | 'visitors' | 'feedback';

export const ANALYTICS_TABS: readonly { value: AnalyticsTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'journey', label: 'Journey' },
  { value: 'visitors', label: 'Visitors' },
  { value: 'feedback', label: 'Feedback' },
];

export const DEFAULT_TAB: AnalyticsTab = 'overview';

const JOURNEY_PATH = '/analytics/journey';
const ANALYTICS_PATH = '/analytics';

export function parseTab(raw: string | null | undefined): AnalyticsTab {
  return ANALYTICS_TABS.some((tab) => tab.value === raw) ? (raw as AnalyticsTab) : DEFAULT_TAB;
}

/** Which tab a URL means. The journey path wins over any `?tab=`. */
export function tabFromUrl(pathname: string, params: URLSearchParams): AnalyticsTab {
  if (pathname.replace(/\/$/, '').endsWith('/journey')) return 'journey';
  return parseTab(params.get('tab'));
}

/**
 * The URL for a tab, keeping every filter the reader already set.
 *
 * The range and the journey month travel with the tab so switching views never
 * silently re-scopes the page under someone.
 */
export function tabUrl(tab: AnalyticsTab, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete('tab');
  if (tab === 'journey') {
    const query = next.toString();
    return query ? `${JOURNEY_PATH}?${query}` : JOURNEY_PATH;
  }
  if (tab !== DEFAULT_TAB) next.set('tab', tab);
  const query = next.toString();
  return query ? `${ANALYTICS_PATH}?${query}` : ANALYTICS_PATH;
}

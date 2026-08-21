/**
 * The five analytics views, and the address of each.
 *
 * They were `Tabs` plus `navigate()` — a `role="tablist"` over five things that
 * are routes. `Tabs`' own docstring names the problem: "If switching tabs
 * changes the URL, the panels are not all in the document and a `tablist` is a
 * promise the surface cannot keep." Four of the five were distinguished only by
 * `?tab=`, which is why the row could not be `NavTabs` and why the note in
 * `AnalyticsPage` flagged this rather than fixing it.
 *
 * They are real paths now, matching the super-admin console, and the row is
 * `NavTabs`. Three things follow that the query-string version could not do:
 * a view can be middle-clicked, cmd-clicked or opened in a new tab; the current
 * one carries `aria-current="page"` instead of `aria-selected`; and Journey
 * stops remounting the whole page, because `/analytics/journey` used to resolve
 * to a *second* lazy chunk (`JourneyPage`) that re-exported `AnalyticsPage`.
 *
 * `?tab=` still resolves. It shipped, so it is in links, bookmarks and pasted
 * messages; the index view redirects it to the real path rather than silently
 * showing the wrong one. That is the only reason `tabFromUrl` still exists.
 */

export type AnalyticsTab = 'overview' | 'conversations' | 'journey' | 'visitors' | 'feedback';

/** The section's root. Every view's address is built from it. */
export const ANALYTICS_BASE = '/analytics';

export interface AnalyticsTabDef {
  value: AnalyticsTab;
  label: string;
  /** The view's path. */
  path: string;
  /** Only the index view matches on the exact path. */
  end?: boolean;
}

export const ANALYTICS_TABS: readonly AnalyticsTabDef[] = [
  { value: 'overview', label: 'Overview', path: ANALYTICS_BASE, end: true },
  { value: 'conversations', label: 'Conversations', path: `${ANALYTICS_BASE}/conversations` },
  { value: 'journey', label: 'Journey', path: `${ANALYTICS_BASE}/journey` },
  { value: 'visitors', label: 'Visitors', path: `${ANALYTICS_BASE}/visitors` },
  { value: 'feedback', label: 'Feedback', path: `${ANALYTICS_BASE}/feedback` },
];

export const DEFAULT_TAB: AnalyticsTab = 'overview';

export function parseTab(raw: string | null | undefined): AnalyticsTab {
  return ANALYTICS_TABS.some((tab) => tab.value === raw) ? (raw as AnalyticsTab) : DEFAULT_TAB;
}

/** Strip a trailing slash so `/analytics/journey/` matches `/analytics/journey`. */
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * Which view a pathname names.
 *
 * The longest matching path wins, so `/analytics` cannot claim
 * `/analytics/journey` by prefix.
 */
export function tabFromPath(pathname: string): AnalyticsTab {
  const path = normalize(pathname);
  const match = [...ANALYTICS_TABS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((tab) => path === tab.path || path.startsWith(`${tab.path}/`));
  return match?.value ?? DEFAULT_TAB;
}

/**
 * Which view a URL means, `?tab=` included.
 *
 * The path wins: a bookmark of `/analytics/journey?tab=feedback` is a link to
 * Journey with a stale parameter on it, not a link to Feedback. Only used to
 * resolve the legacy query string on the index view — everything else reads
 * `tabFromPath`.
 */
export function tabFromUrl(pathname: string, params: URLSearchParams): AnalyticsTab {
  const fromPath = tabFromPath(pathname);
  if (fromPath !== DEFAULT_TAB) return fromPath;
  return parseTab(params.get('tab'));
}

/**
 * The address of a view, keeping every filter the reader already set.
 *
 * The range and the journey month travel with the view so following a tab never
 * silently re-scopes the page under someone. `tab` is dropped on the way out —
 * it is the parameter these paths replace, and carrying it forward would leave
 * a stale one on every URL the row produces.
 */
export function tabUrl(tab: AnalyticsTab, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete('tab');
  const path = ANALYTICS_TABS.find((entry) => entry.value === tab)?.path ?? ANALYTICS_BASE;
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}

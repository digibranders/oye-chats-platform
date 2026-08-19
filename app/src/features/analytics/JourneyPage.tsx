import { AnalyticsPage } from './AnalyticsPage';

/**
 * `/analytics/journey`.
 *
 * Journey is a tab of Analytics now, not a destination of its own, but the path
 * is in bookmarks and in a redirect from the old top-level `/journey`, so it
 * still resolves — to the same page, which reads the tab out of the URL.
 */
export function JourneyPage() {
  return <AnalyticsPage />;
}

export default JourneyPage;

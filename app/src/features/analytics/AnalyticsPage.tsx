import { useMemo } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  TabPanel,
  Tabs,
  buttonClass,
} from '../../ui';
import { useBotContext } from '../../context/BotContext';
import { ANALYTICS_TABS, parseTab, tabFromUrl, tabUrl } from './tabs';
import { DEFAULT_RANGE, RANGE_OPTIONS, parseRange, resolveRange, type RangeKey } from './range';
import { monthOptions, parseMonth } from './month';
import { useAnalyticsRefresh } from './useAnalyticsData';
import { OverviewTab } from './OverviewTab';
import { ConversationsTab } from './ConversationsTab';
import { JourneyTab } from './JourneyTab';
import { VisitorsTab } from './VisitorsTab';
import { FeedbackTab } from './FeedbackTab';

/**
 * Analytics — one surface, one period.
 *
 * The page it replaces could not answer the question it existed for: how does
 * this month compare with the last one. Every figure on it was all-time,
 * because `?days=` has been supported by `/analytics/dashboard` and
 * `/analytics/unanswered-questions` since they were written and was never once
 * passed; the range control it did have changed a chart and nothing else, while
 * the delta glued to the same tile stayed a fixed seven-day figure. Two more
 * time controls lived inside individual cards, so three windows were on screen
 * at once with nothing saying they disagreed.
 *
 * So the whole surface takes one range, from the URL, and every query on every
 * tab is scoped by it. Journey is the exception the API forces — its endpoints
 * take a calendar month and nothing else — so that tab swaps the range control
 * for a month picker rather than pretending a ninety-day window is a month.
 *
 * The tab row wants to be `NavTabs` — these are routes, not panels, so a
 * `tablist` is a promise the surface cannot keep. `NavTabs` matches the active
 * tab on the *pathname*, and four of the five tabs here are distinguished only
 * by `?tab=`, so adopting it needs each tab to become a real child route under
 * `/analytics` in `src/app/routes.tsx` — outside this pass's scope. Flagged, not
 * patched around.
 */
export function AnalyticsPage() {
  const { bots, selectedBot, loading: botsLoading, error: botsError, refreshBots } = useBotContext();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const refresh = useAnalyticsRefresh();

  const tab = tabFromUrl(location.pathname, params);
  const rangeKey = parseRange(params.get('range'));
  // Resolved once per selection rather than per render: `resolveRange` reads
  // the clock, and a window that moves between two renders makes two panels on
  // the same page disagree about where it starts.
  const range = useMemo(() => resolveRange(rangeKey), [rangeKey]);
  const month = parseMonth(params.get('month'));
  const months = useMemo(() => monthOptions(), []);

  const botId = selectedBot?.id ?? null;

  function setParam(key: string, value: string, fallback: string) {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    // Replaced rather than pushed: changing a filter is refining one view, and
    // a reader who twiddles the range four times should not have to press Back
    // four times to leave the page.
    setParams(next, { replace: true });
  }

  const rangeControl =
    tab === 'journey' ? (
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-tertiary" id="journey-month-label">
          Month
        </span>
        <div className="w-40">
          <Select
            size="sm"
            aria-labelledby="journey-month-label"
            options={months}
            value={month}
            onChange={(event) => setParam('month', event.target.value, months[0]?.value ?? month)}
          />
        </div>
      </div>
    ) : (
      <SegmentedControl<RangeKey>
        size="sm"
        label="Reporting period"
        items={RANGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        value={rangeKey}
        onChange={(value) => setParam('range', value, DEFAULT_RANGE)}
      />
    );

  const actions = (
    <>
      {/* One slot, one width, so Refresh does not slide sideways when the
          period control swaps for the journey month picker. */}
      <div className="flex w-[19rem] justify-end">{rangeControl}</div>
      {/* In the header, so it exists in every state. The old one was rendered
          only once the page had already loaded, which is the one state in
          which nobody needs it. */}
      <Button size="sm" onClick={refresh} iconLeft={<RefreshCw aria-hidden />}>
        Refresh
      </Button>
    </>
  );

  // The chatbot list is still in flight, so `botId` is null and every query on
  // every tab is disabled — which used to render the whole page as a permanent
  // skeleton, and a *failed* bot list as a permanent skeleton forever.
  if (botsLoading) {
    return (
      <Page width="wide">
        <PageHeader title="Analytics" />
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      </Page>
    );
  }

  if (botsError) {
    return (
      <Page width="wide">
        <PageHeader title="Analytics" />
        <Card>
          <ErrorState
            title="Your chatbots could not be loaded"
            description="Analytics is scoped to one chatbot, and the list of them did not arrive."
            onRetry={() => void refreshBots()}
          />
        </Card>
      </Page>
    );
  }

  // No chatbots, so nothing has been measured yet. This is the one state that
  // replaces the whole page rather than one panel.
  if (bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader title="Analytics" />
        <Card>
          <EmptyState
            icon={BarChart3}
            title="Nothing measured yet"
            description="Create a chatbot and put it on your site. Conversations, leads and visitor journeys all start appearing here within minutes of the first visitor."
            action={
              <Link to="/chatbots?new=1" className={buttonClass('primary', 'sm')}>
                Create a chatbot
              </Link>
            }
          />
        </Card>
      </Page>
    );
  }

  return (
    <Page width="wide">
      {/* No description. The title says "Analytics", the tab row names the five
          views, the breadcrumb names the workspace and the control beside it
          states the period — a sentence restating all four was a fourth copy
          of one fact. */}
      <PageHeader title="Analytics" actions={actions} />

      <Tabs
        items={ANALYTICS_TABS}
        value={tab}
        onValueChange={(next) => navigate(tabUrl(parseTab(next), params))}
        label="Analytics views"
      >
        <TabPanel value="overview">
          <OverviewTab botId={botId} range={range} />
        </TabPanel>
        <TabPanel value="conversations">
          <ConversationsTab botId={botId} range={range} />
        </TabPanel>
        <TabPanel value="journey">
          <JourneyTab botId={botId} month={month} />
        </TabPanel>
        <TabPanel value="visitors">
          <VisitorsTab botId={botId} range={range} />
        </TabPanel>
        <TabPanel value="feedback">
          <FeedbackTab botId={botId} range={range} />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

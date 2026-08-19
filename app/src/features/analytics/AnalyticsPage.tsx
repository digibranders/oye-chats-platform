import { useMemo } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
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
 * Journey is also no longer a top-level destination. It was admitted to be a
 * temporary extra, and it is analytics: it is a tab here, and
 * `/analytics/journey` still resolves to it so every link already sent keeps
 * working.
 */
export function AnalyticsPage() {
  const { bots, selectedBot, loading: botsLoading } = useBotContext();
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
  const botName = selectedBot?.name ?? 'this chatbot';

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
      <div className="w-48">
        <Select
          size="sm"
          aria-label="Journey month"
          options={months}
          value={month}
          onChange={(event) => setParam('month', event.target.value, months[0]?.value ?? month)}
        />
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

  // No chatbots, so nothing has been measured yet. This is the one state that
  // replaces the whole page rather than one panel.
  if (!botsLoading && bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader
          title="Analytics"
          description="How your chatbot is doing, over a period you choose."
        />
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
      <PageHeader
        title="Analytics"
        description={`How ${botName} is doing, and how that compares with before.`}
        actions={
          <>
            {rangeControl}
            {/* In the header, so it exists in every state. The old one was
                rendered only once the page had already loaded, which is the
                one state in which nobody needs it. */}
            <Button size="sm" onClick={refresh} iconLeft={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}>
              Refresh
            </Button>
          </>
        }
      />

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
          <FeedbackTab botId={botId} />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

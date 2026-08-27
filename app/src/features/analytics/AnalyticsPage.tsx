import { useMemo, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  LoadingRows,
  NavTabs,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  buttonClass,
} from '../../ui';
import { useBotContext } from '../../context/BotContext';
import { ANALYTICS_BASE, ANALYTICS_TABS, DEFAULT_TAB, tabFromPath, tabFromUrl, tabUrl } from './tabs';
import { DEFAULT_RANGE, RANGE_OPTIONS, parseRange, resolveRange, type RangeKey } from './range';
import { monthOptions, parseMonth } from './month';
import { useAnalyticsRefresh, useLanguageBreakdown } from './useAnalyticsData';
import { OverviewTab } from './OverviewTab';
import { ConversationsTab } from './ConversationsTab';
import { JourneyTab } from './JourneyTab';
import { VisitorsTab } from './VisitorsTab';
import { FeedbackTab } from './FeedbackTab';
import { LanguagesTab } from './LanguagesTab';

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
 * The tab row is `NavTabs`, and each view is a real route. It was `Tabs` plus
 * `navigate()`: a `role="tablist"` over five things that change the URL, which
 * `Tabs`' own docstring calls a promise the surface cannot keep. Making the four
 * query-string views into paths bought middle-click, cmd-click and
 * open-in-new-tab on every view, `aria-current="page"` in place of
 * `aria-selected`, and the end of Journey remounting the page — `/analytics/journey`
 * used to resolve to a second lazy chunk that re-exported this component.
 *
 * Sub-routing lives here rather than in `src/app/routes.tsx`, the same shape the
 * super-admin console uses for its own record lists. One chunk, and — the reason
 * that matters — each view takes `botId`, `range` and `month` as typed props
 * instead of an `useOutletContext()` cast that no compiler checks.
 */
export function AnalyticsPage() {
  const { bots, selectedBot, loading: botsLoading, error: botsError, refreshBots } = useBotContext();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const refresh = useAnalyticsRefresh();

  // The path, not the query string. `?tab=` is resolved once, on the index
  // view, and turned into a redirect — see `LegacyTabRedirect`.
  const tab = tabFromPath(location.pathname);
  const rangeKey = parseRange(params.get('range'));
  // Resolved once per selection rather than per render: `resolveRange` reads
  // the clock, and a window that moves between two renders makes two panels on
  // the same page disagree about where it starts.
  const range = useMemo(() => resolveRange(rangeKey), [rangeKey]);
  const month = parseMonth(params.get('month'));
  const months = useMemo(() => monthOptions(), []);

  const botId = selectedBot?.id ?? null;

  // Whether the Languages tab is worth offering. Read from the same cached
  // query the view itself uses, so showing the tab costs no extra request.
  const { breakdown } = useLanguageBreakdown(botId, range.key);
  const multilingual = breakdown?.multilingualEnabled === true;

  function setParam(key: string, value: string, fallback: string) {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    // Replaced rather than pushed: changing a filter is refining one view, and
    // a reader who twiddles the range four times should not have to press Back
    // four times to leave the page.
    setParams(next, { replace: true });
  }

  // The row's links carry the current filters, so following one never
  // re-scopes the page under the reader.
  const tabItems = useMemo(
    () =>
      ANALYTICS_TABS.filter((entry) => !entry.conditional || multilingual).map((entry) => ({
        to: tabUrl(entry.value, params),
        label: entry.label,
        end: entry.end,
      })),
    [params, multilingual],
  );

  const rangeControl =
    tab === 'journey' ? (
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-tertiary">Month</span>
        <div className="w-40">
          <Select
            size="sm"
            label="Month"
            options={months}
            value={month}
            onValueChange={(value) => setParam('month', value, months[0]?.value ?? month)}
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
          of one fact.

          `toolbarBleed` runs the row's hairline to the edges of the content
          area. Inside the gutter it starts 32px in and stops 32px short, which
          reads as an underline on a paragraph rather than the division the
          views sit on — the same call every `NavTabs` row in the super-admin
          console makes. */}
      <PageHeader
        title="Analytics"
        actions={actions}
        toolbarBleed
        toolbar={<NavTabs label="Analytics views" items={tabItems} />}
      />

      <Routes>
        <Route index element={<LegacyTabRedirect><OverviewTab botId={botId} range={range} /></LegacyTabRedirect>} />
        <Route path="conversations" element={<ConversationsTab botId={botId} range={range} />} />
        <Route path="journey" element={<JourneyTab botId={botId} month={month} />} />
        <Route path="visitors" element={<VisitorsTab botId={botId} range={range} />} />
        <Route path="languages" element={<LanguagesTab botId={botId} range={range} />} />
        <Route path="feedback" element={<FeedbackTab botId={botId} range={range} />} />
        {/* An address under `/analytics` that names nothing is the section's
            own index, not a 404 in the shell: the reader asked for analytics
            and there is analytics to show them. */}
        <Route path="*" element={<Navigate to={ANALYTICS_BASE} replace />} />
      </Routes>
    </Page>
  );
}

/**
 * `?tab=` still resolves.
 *
 * The query string shipped this round, so it is in links, bookmarks and pasted
 * messages. Rather than 404 or — worse — silently render Overview under a URL
 * that asked for Feedback, the index view sends the reader to the real path and
 * keeps every other parameter on the way. `replace`, so Back leaves the section
 * instead of bouncing off the redirect.
 */
function LegacyTabRedirect({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const requested = tabFromUrl(location.pathname, params);
  if (requested !== DEFAULT_TAB || params.has('tab')) {
    return <Navigate to={tabUrl(requested, params)} replace />;
  }
  return <>{children}</>;
}

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Grid,
  LoadingRows,
  LockedState,
  Page,
  PageHeader,
  Select,
  SegmentedControl,
  Stack,
  StatTile,
  buttonClass,
  formatNumber,
} from '../../ui';
import { useBotContext } from '../../context/BotContext';
import { resolveScopedBotId } from '../../context/botScope';
import { monthLabel, monthOptions, parseMonth } from './month';
import { isFilterableOutcome, type FilterableOutcome } from './journeyModel';
import { errorMessage, isPlanGate } from './useAnalyticsData';
import { useJourneyData, useJourneyPaths } from './useJourneyData';
import { JourneyDiagram } from './JourneyDiagram';
import { JourneyFlow } from './JourneyFlow';
import { JourneyOutcomesDonut } from './JourneyOutcomesDonut';
import { JourneyPagesPanel } from './JourneyPagesPanel';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Journey — one month of one chatbot, fetched once.
 *
 * Its own top-level page, not a tab inside Analytics. It lived at
 * `/analytics/journey` for a while (see `REBUILD.md`'s Consolidations table for
 * why it moved there); it moved back out because the product wants it as a
 * full, standalone destination rather than one view among Analytics' others.
 *
 * That earlier move existed to fix a real bug — `/analytics/journey` used to
 * resolve to a *second* lazy chunk that re-exported `AnalyticsPage`, so
 * navigating to Journey and back remounted the whole surface and threw away
 * scroll position and every cached panel below the fold. Moving back out does
 * not reintroduce that: this page is its own single lazy chunk (registered
 * once in `src/app/routes.tsx`), and it still fetches its data exactly once
 * (`useJourneyData`, below) rather than the three independent mounts the
 * original `development` page made of the same hook.
 *
 * The plan gate lives in exactly one place: the 402 the API returns. The page
 * this replaces also kept a hard-coded set of plan slugs on the client, so any
 * drift between the two rendered a locked card inside a locked card, and adding
 * a plan on the server meant remembering to add it here too.
 */
export function JourneyPage() {
  const { t } = useTranslation();
  const { bots, selectedBot, loading: botsLoading, error: botsError, refreshBots } = useBotContext();
  const [params, setParams] = useSearchParams();
  // Not `selectedBot?.id ?? null`. This page cannot aggregate — its endpoints
  // require `bot_id` — and the shell scope had no writer at all after the
  // redesign dropped the switcher, so that expression was permanently null and
  // every query below stayed disabled. The page rendered empty for everyone.
  // See `resolveScopedBotId`.
  const botId = resolveScopedBotId(selectedBot, bots);

  const month = parseMonth(params.get('month'));
  const months = useMemo(() => monthOptions(), []);
  const rawOutcome = params.get('outcome');
  const outcome: FilterableOutcome | null =
    rawOutcome && isFilterableOutcome(rawOutcome) ? rawOutcome : null;
  const rawView = params.get('view');
  const view: 'list' | 'diagram' = rawView === 'list' ? 'list' : 'diagram';

  const journey = useJourneyData(botId, month);
  const paths = useJourneyPaths(botId, month, outcome);
  const label = monthLabel(month);

  function setParam(key: string, value: string, fallback: string) {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function selectOutcome(next: FilterableOutcome | null) {
    const updated = new URLSearchParams(params);
    if (next) updated.set('outcome', next);
    else updated.delete('outcome');
    setParams(updated, { replace: true });
  }

  function setView(next: 'list' | 'diagram') {
    const updated = new URLSearchParams(params);
    if (next === 'list') updated.set('view', next);
    else updated.delete('view');
    setParams(updated, { replace: true });
  }

  const actions = (
    <>
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-tertiary">{t('analytics.month') || 'Month'}</span>
        <div className="w-40">
          <Select
            size="sm"
            label={t('analytics.month') || 'Month'}
            options={months}
            value={month}
            onValueChange={(value) => setParam('month', value, months[0]?.value ?? month)}
          />
        </div>
      </div>
      <SegmentedControl<'list' | 'diagram'>
        size="sm"
        label={t('analytics.journeyView') || 'Journey view'}
        value={view}
        onChange={setView}
        items={[
          { value: 'list', label: t('analytics.list') || 'List' },
          { value: 'diagram', label: t('analytics.diagram') || 'Diagram' },
        ]}
      />
      <Button size="sm" onClick={() => void journey.refetch()} iconLeft={<RefreshCw aria-hidden />}>
        {t('analytics.refresh') || 'Refresh'}
      </Button>
    </>
  );

  // Same guard shape as `AnalyticsPage`: `botId` is null while the chatbot list
  // is in flight, so every query below stays disabled until it resolves.
  if (botsLoading) {
    return (
      <Page width="wide">
        <PageHeader title={t('analytics.journey') || 'Journey'} description={t('analytics.visitorJourneyFlow') || 'Visitor journey flow.'} titleVisuallyHidden />
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
        <PageHeader title={t('analytics.journey') || 'Journey'} description={t('analytics.visitorJourneyFlow') || 'Visitor journey flow.'} titleVisuallyHidden />
        <Card>
          <ErrorState
            title={t('analytics.yourChatbotsCouldNotBe') || 'Your chatbots could not be loaded'}
            description={t('analytics.journeyIsScopedToOne') || 'Journey is scoped to one chatbot, and the list of them did not arrive.'}
            onRetry={() => void refreshBots()}
          />
        </Card>
      </Page>
    );
  }

  if (bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader title={t('analytics.journey') || 'Journey'} description={t('analytics.visitorJourneyFlow') || 'Visitor journey flow.'} titleVisuallyHidden />
        <Card>
          <EmptyState
            icon={BarChart3}
            title={t('analytics.nothingMeasuredYet') || 'Nothing measured yet'}
            description={t('analytics.createAChatbotAndPut2') || 'Create a chatbot and put it on your site. Visitor journeys start appearing here within minutes of the first visitor.'}
            action={
              <Link to="/chatbots?new=1" className={buttonClass('primary', 'sm')}>
                {t('analytics.createAChatbot') || 'Create a chatbot'}
              </Link>
            }
          />
        </Card>
      </Page>
    );
  }

  // Several chatbots and none chosen. This page cannot aggregate, so there is
  // no honest figure to show — and picking one silently would put a single
  // chatbot's numbers under a control that reads "All chatbots". Ask instead.
  // Unreachable for a single-chatbot account: `resolveScopedBotId` uses the
  // sole chatbot, which is every plan below Enterprise.
  if (botId == null) {
    return (
      <Page width="wide">
        <PageHeader title={t('analytics.journey') || 'Journey'} description={t('analytics.visitorJourneyFlow') || 'Visitor journey flow.'} titleVisuallyHidden />
        <Card>
          <EmptyState
            icon={BarChart3}
            title={t('analytics.chooseAChatbot') || 'Choose a chatbot'}
            description={
              t('analytics.thisViewShowsOneChatbot') ||
              'This view reports on one chatbot at a time. Pick one from Showing, in the sidebar.'
            }
          />
        </Card>
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader title={t('analytics.journey') || 'Journey'} description={t('analytics.visitorJourneyFlow') || 'Visitor journey flow.'} titleVisuallyHidden actions={actions} />

      {journey.loading ? (
        <Card>
          <CardBody>
            <LoadingRows rows={6} />
          </CardBody>
        </Card>
      ) : journey.error ? (
        isPlanGate(journey.error) ? (
          <LockedState
            size="page"
            title={t('analytics.visitorJourneysAreOnStandard') || 'Visitor journeys are on Standard and above'}
            description={t('analytics.journeysShowThePagesSomeone') || 'Journeys show the pages someone read before they opened the chat and what they did afterwards. Collection is already running on your workspace, so the history appears the moment you upgrade.'}
            action={
              <Link to="/billing" className={buttonClass('primary', 'sm')}>
                {t('analytics.seePlans') || 'See plans'}
              </Link>
            }
          />
        ) : (
          <Card>
            <ErrorState
              title={t('analytics.journeysCouldNotBeLoaded') || 'Journeys could not be loaded'}
              description={errorMessage(journey.error, t('analytics.theRequestForVisitorJourneys') || 'The request for visitor journeys failed.')}
              onRetry={() => void journey.refetch()}
            />
          </Card>
        )
      ) : journey.data ? (
        (() => {
          const { summary, outcomes, preChatSequences, postChat, prePages } = journey.data;
          const conversions =
            summary.meeting_booked + summary.handoff_requested + summary.offline_message_sent;

          return (
            <Stack>
              <Card>
                <CardBody flush>
                  {/* Not `StatRow`: its caption states the window once for the
                      strip, which is exactly right when nothing else on the
                      page does — but here the header's own Month picker
                      already shows it, visibly, one line up. Repeating it in
                      a caption underneath would be the same fact twice, so
                      each tile suppresses its own line (`periodInherited`)
                      and none is printed anywhere in the strip. */}
                  <div
                    role="group"
                    aria-label={t('analytics.journeyTotals') || 'Journey totals'}
                    className="grid grid-cols-2 overflow-hidden lg:grid-cols-4"
                  >
                    {[
                      {
                        label: t('analytics.trackedJourneys') || 'Tracked journeys',
                        value: formatNumber(summary.sessions_with_journey),
                      },
                      {
                        label: t('analytics.reachedAnOutcome') || 'Reached an outcome',
                        value: formatNumber(conversions),
                        hint: t('analytics.bookedAMeetingHandedOff') || 'Booked a meeting, handed off, or messaged',
                      },
                      { label: t('analytics.leftTheirDetails') || 'Left their details', value: formatNumber(summary.leads_captured) },
                      {
                        label: t('analytics.startedOnAPage') || 'Started on a page',
                        value: formatNumber(preChatSequences.sessions_with_pre_chat),
                        hint: t('analytics.browsedAPageBeforeOpening') || 'Browsed a page before opening the chat',
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="-ml-px -mt-px border-l border-t border-border px-cell py-2.5"
                      >
                        <StatTile {...item} period={label} periodInherited />
                      </div>
                    ))}
                  </div>
                </CardBody>
              </Card>

              {view === 'list' ? (
                <JourneyFlow
                  summary={summary}
                  outcomes={outcomes}
                  sequences={preChatSequences}
                  postChat={postChat}
                  monthLabel={label}
                  selectedOutcome={outcome}
                  onSelectOutcome={selectOutcome}
                  paths={paths.paths}
                  pathsLoading={paths.loading}
                  pathsError={
                    paths.error
                      ? errorMessage(paths.error, t('analytics.theRequestForTheseRoutes') || 'The request for these routes failed.')
                      : null
                  }
                />
              ) : (
                <JourneyDiagram
                  sequences={preChatSequences}
                  centerLabel="Opened Chatbot"
                  centerValue={summary.sessions_with_journey}
                  selectedOutcome={outcome}
                  onSelectOutcome={selectOutcome}
                />
              )}

              <Grid cols={2}>
                <JourneyPagesPanel
                  rows={prePages.rows}
                  journeys={summary.sessions_with_journey}
                  monthLabel={label}
                />
                <Card>
                  <CardHeader
                    eyebrow="Outcomes"
                    title={t('analytics.journeyOutcomes') || 'Journey outcomes'}
                    titleAs="h2"
                    description={
                      t('analytics.whereVisitorJourneysEnded', { period: label }) ||
                      `Where visitor journeys ended · ${label}`
                    }
                  />
                  <CardBody>
                    <JourneyOutcomesDonut outcomes={outcomes} total={summary.sessions_with_journey} />
                  </CardBody>
                </Card>
              </Grid>
            </Stack>
          );
        })()
      ) : null}
    </Page>
  );
}

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
import { monthLabel, monthOptions, parseMonth } from './month';
import { isFilterableOutcome, type FilterableOutcome } from './journeyModel';
import { errorMessage, isPlanGate } from './useAnalyticsData';
import { useJourneyData, useJourneyPaths } from './useJourneyData';
import { JourneyDiagram } from './JourneyDiagram';
import { JourneyFlow } from './JourneyFlow';
import { JourneyOutcomesDonut } from './JourneyOutcomesDonut';
import { JourneyPagesPanel } from './JourneyPagesPanel';

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
  const { bots, selectedBot, loading: botsLoading, error: botsError, refreshBots } = useBotContext();
  const [params, setParams] = useSearchParams();
  const botId = selectedBot?.id ?? null;

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
      <SegmentedControl<'list' | 'diagram'>
        size="sm"
        label="Journey view"
        value={view}
        onChange={setView}
        items={[
          { value: 'list', label: 'List' },
          { value: 'diagram', label: 'Diagram' },
        ]}
      />
      <Button size="sm" onClick={() => void journey.refetch()} iconLeft={<RefreshCw aria-hidden />}>
        Refresh
      </Button>
    </>
  );

  // Same guard shape as `AnalyticsPage`: `botId` is null while the chatbot list
  // is in flight, so every query below stays disabled until it resolves.
  if (botsLoading) {
    return (
      <Page width="wide">
        <PageHeader title="Journey" description="Visitor journey flow." titleVisuallyHidden />
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
        <PageHeader title="Journey" description="Visitor journey flow." titleVisuallyHidden />
        <Card>
          <ErrorState
            title="Your chatbots could not be loaded"
            description="Journey is scoped to one chatbot, and the list of them did not arrive."
            onRetry={() => void refreshBots()}
          />
        </Card>
      </Page>
    );
  }

  if (bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader title="Journey" description="Visitor journey flow." titleVisuallyHidden />
        <Card>
          <EmptyState
            icon={BarChart3}
            title="Nothing measured yet"
            description="Create a chatbot and put it on your site. Visitor journeys start appearing here within minutes of the first visitor."
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
      <PageHeader title="Journey" description="Visitor journey flow." titleVisuallyHidden actions={actions} />

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
            title="Visitor journeys are on Standard and above"
            description="Journeys show the pages someone read before they opened the chat and what they did afterwards. Collection is already running on your workspace, so the history appears the moment you upgrade."
            action={
              <Link to="/billing" className={buttonClass('primary', 'sm')}>
                See plans
              </Link>
            }
          />
        ) : (
          <Card>
            <ErrorState
              title="Journeys could not be loaded"
              description={errorMessage(journey.error, 'The request for visitor journeys failed.')}
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
                    aria-label="Journey totals"
                    className="grid grid-cols-2 overflow-hidden lg:grid-cols-4"
                  >
                    {[
                      {
                        label: 'Tracked journeys',
                        value: formatNumber(summary.sessions_with_journey),
                      },
                      {
                        label: 'Reached an outcome',
                        value: formatNumber(conversions),
                        hint: 'Booked a meeting, handed off, or messaged',
                      },
                      { label: 'Left their details', value: formatNumber(summary.leads_captured) },
                      {
                        label: 'Started on a page',
                        value: formatNumber(preChatSequences.sessions_with_pre_chat),
                        hint: 'Browsed a page before opening the chat',
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
                      ? errorMessage(paths.error, 'The request for these routes failed.')
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
                    title="Journey outcomes"
                    titleAs="h2"
                    description={`Where visitor journeys ended · ${label}`}
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

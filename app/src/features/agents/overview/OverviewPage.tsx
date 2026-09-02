import { useCallback, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ABSENT,
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  Columns,
  CopyField,
  ErrorState,
  Grid,
  LockedState,
  Page,
  PageHeader,
  PropertyGrid,
  SegmentedControl,
  Skeleton,
  Stack,
  StatRow,
  buttonClass,
  formatDate,
  formatNumber,
  formatPercent,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { agentPath } from '../../../shell/nav';
import { agentHealth } from '../../home/agentHealth';
import type { Bot } from '../../../types/domain';
import { AgentHealthStrip } from '../AgentHealthStrip';
import {
  RANGE_OPTIONS,
  parseRange,
  rangeLabel,
  useOverviewData,
  type RangeDays,
  type Section as DataSection,
} from './overview-data';
import { ActivityChart } from './ActivityChart';
import { TopQuestions } from './TopQuestions';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * A chatbot's Overview.
 *
 * It answers, in order: is this chatbot healthy, how much work is it doing, is
 * anyone sharing it, and what is it being asked. Everything else is a link to
 * the page that owns it.
 *
 * **It is a grid, not a stack.** It was seven full-width blocks in a 1440px
 * column, four of which held two or three tiles — so a three-tile card was about
 * 40% ink and 60% empty right margin, and the fold at 1080p landed inside the
 * activity chart with the install state, the chatbot key and the ratings all
 * below it. Four rows now: the verdict, one figure strip, the chart beside the
 * question list, and three record cards. Everything above the chart fits a
 * 1024px fold.
 *
 * Five things the page it replaces got wrong, closed here.
 *
 * It rendered **two `h1`s** — the agent layout's chatbot name plus the page's
 * own title. That layout is gone: the rail names the chatbot and the top bar
 * breadcrumbs it, so this page owns exactly one heading, from `PageHeader`.
 *
 * Its fourth card was labelled **"7-day performance" and read all-time values**,
 * because no period was ever passed. The range is a control now, it is in the
 * URL, and every figure states the window it actually covers — once, on the
 * strip, with the two that have no window saying so themselves.
 *
 * **Not one figure carried a comparison**, so the page was a receipt rather than
 * an instrument: nothing told the reader whether 412 conversations was good. The
 * two figures that have a previous window now carry a delta.
 *
 * Its "View analytics" link pointed at `/agents/:id/analytics`, a route that
 * redirected back to the page the link was on. The deep dive is `/analytics`.
 *
 * And a failed section rendered a dead card with no way to retry it, while the
 * page-level retry called the narrow refetch that left the chatbot record stale.
 * Every section here retries itself; the page-level Refresh reloads the chatbot
 * record too.
 */

/** A section that failed, with the way back. */
function SectionError({ section, title }: { section: DataSection<unknown>; title: string }) {
  const { t } = useTranslation();
  if (!section.error) return null;
  return (
    <CardSection>
      <Alert
        tone="danger"
        title={title}
        action={
          <Button size="sm" onClick={section.retry}>
            {t('agents.tryAgain') || 'Try again'}
          </Button>
        }
      >
        {section.error}
      </Alert>
    </CardSection>
  );
}

/**
 * A figure out of a section that may not have one.
 *
 * `useOverviewData` falls back to `EMPTY_FIGURES` whenever its dashboard query
 * holds no data, so a request still in flight and a 500 both arrive here as a
 * complete set of zeros, indistinguishable from a chatbot nobody has shared or
 * chatted to. Only the section's own state separates the three, and every
 * caller of `figures.data` has to consult it.
 */
function sectionFigure(section: DataSection<unknown>, formatted: string | null): ReactNode {
  if (section.loading) return <Skeleton className="h-4 w-12" />;
  return formatted === null ? undefined : <span className="figure">{formatted}</span>;
}

function OverviewContent({ agent }: { agent: Bot }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const days = parseRange(params.get('days'));
  const { refresh: refreshAgent } = useAgent();
  const { figures, deltas, activity, questions, ratings, resolution, refreshing, refreshAll } =
    useOverviewData(agent.id, days);

  const health = agentHealth(agent);
  const indexed = Number(agent.indexed_chunk_count ?? 0);
  const installed = Boolean(agent.widget_installed_at);

  const setDays = useCallback(
    (next: RangeDays) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set('days', String(next));
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  /**
   * Refresh everything this page shows.
   *
   * Including the chatbot record — the health strip, the knowledge figure and
   * the install state all read the `Bot`, not the analytics payload, so
   * refetching metrics alone left a stale "nothing to answer from" on screen
   * that no amount of clicking could clear. That trap was documented in the code
   * it replaces and then wired to the wrong callback anyway.
   */
  const refreshEverything = useCallback(() => {
    void refreshAgent();
    refreshAll();
  }, [refreshAgent, refreshAll]);

  return (
    <Page width="wide">
      <PageHeader
        title={t('agents.overview') || 'Overview'}
        actions={
          <>
            <SegmentedControl
              label={t('agents.reportingPeriod') || 'Reporting period'}
              value={String(days)}
              onChange={(value) => setDays(parseRange(value))}
              items={RANGE_OPTIONS.map((option) => ({
                value: String(option),
                label: `${option} days`,
              }))}
            />
            {/* `Button loading` carries the spinner AND `aria-busy`. The
                hand-rolled `animate-spin` it replaces froze at 0° under
                `prefers-reduced-motion` and announced nothing at all. */}
            <Button loading={refreshing} onClick={refreshEverything}>
              {t('agents.refresh') || 'Refresh'}
            </Button>
          </>
        }
      />

      <Stack>
        <AgentHealthStrip
          agent={agent}
          health={health}
          aside={
            // "Right now" belongs beside the verdict, not inside a card stamped
            // with a 30-day window.
            //
            // The count is guarded, because `figures.data` is a zeroed stand-in
            // until the query answers: this line read "0 chatting right now" on
            // every first paint and stayed there through an outage, which is the
            // most reassuring thing a broken chatbot can say. The failure itself
            // is explained once, by the strip's own alert below.
            <span className="flex items-center gap-1.5 text-xs text-text-secondary">
              {figures.loading ? (
                <Skeleton className="h-4 w-8" />
              ) : (
                <span className="figure font-medium text-text-primary">
                  {figures.error ? ABSENT : formatNumber(figures.data.activeVisitors)}
                </span>
              )}
              {t('agents.chattingRightNow') || 'chatting right now'}
            </span>
          }
        />

        <Card>
          {/* No eyebrow. `StatRow` states the window itself, in a caption under
              the strip it belongs to — an eyebrow above the card repeated it, so
              one card said "Last 30 days" twice, 100px apart, about the same
              four numbers. */}
          <CardHeader
            title={t('agents.performance') || 'Performance'}
            titleAs="h2"
            actions={
              <Link to="/analytics" className={buttonClass('ghost', 'sm')}>
                {t('agents.fullAnalytics') || 'Full analytics'}
              </Link>
            }
          />
          <CardBody flush>
            <StatRow
              period={rangeLabel(days)}
              label={t('agents.conversationVolume') || 'Conversation volume'}
              columns={4}
              items={[
                {
                  label: t('agents.conversations') || 'Conversations',
                  value: formatNumber(figures.data.conversations),
                  size: 'lg',
                  delta: deltas.conversations ?? undefined,
                  loading: figures.loading,
                },
                {
                  label: t('agents.messages') || 'Messages',
                  value: formatNumber(figures.data.messages),
                  size: 'lg',
                  delta: deltas.messages ?? undefined,
                  loading: figures.loading,
                },
                {
                  label: t('agents.resolutionRate') || 'Resolution rate',
                  value:
                    resolution.data.rate === null
                      ? undefined
                      : formatPercent(resolution.data.rate / 100),
                  // The endpoint takes no window, so this tile states its own.
                  period: t('agents.allTime') || 'All time',
                  size: 'lg',
                  empty: resolution.loading ? undefined : t('agents.notRatedYet') || 'Not rated yet',
                  loading: resolution.loading,
                },
                {
                  label: t('agents.averageRating') || 'Average rating',
                  value:
                    ratings.data.average === null
                      ? undefined
                      : `${formatNumber(ratings.data.average)} / 5`,
                  period: t('agents.allTime') || 'All time',
                  size: 'lg',
                  empty: ratings.loading ? undefined : t('agents.notRatedYet') || 'Not rated yet',
                  loading: ratings.loading,
                },
              ]}
            />
          </CardBody>
          <SectionError section={figures} title={t('agents.weCouldNotLoadThese') || 'We could not load these figures'} />
          <SectionError section={resolution} title={t('agents.weCouldNotLoadThe5') || 'We could not load the resolution rate'} />
          <SectionError section={ratings} title={t('agents.weCouldNotLoadThe4') || 'We could not load the ratings'} />
        </Card>

        {/* The chart and the ranked list are one answer — what visitors did, and
            what they asked — so they share a row rather than sitting 700px
            apart with five blocks between them. */}
        <Columns
          asideWidth="md"
          asideLabel="Top questions"
          main={
            <Card>
              {/* The chart is trimmed to the selected range client-side, so it
                  states that range. Its neighbour states "All time", because
                  `/analytics/top-questions` takes no window at all — two cards
                  in one row, each honest about a different one. */}
              <CardHeader eyebrow={rangeLabel(days)} title={t('agents.activity') || 'Activity'} titleAs="h2" />
              <CardBody>
                <ActivityChart section={activity} days={days} />
              </CardBody>
            </Card>
          }
          aside={
            <Card className="h-full">
              <CardHeader eyebrow="All time" title={t('agents.topQuestions') || 'Top questions'} titleAs="h2" />
              <TopQuestions section={questions} />
            </Card>
          }
        />

        <Grid cols={3}>
          <Card className="flex flex-col">
            <CardHeader
              size="sm"
              title={t('agents.knowledge') || 'Knowledge'}
              titleAs="h2"
              actions={
                <Link to={agentPath(agent.id, 'knowledge')} className={buttonClass('ghost', 'sm')}>
                  {t('agents.manage') || 'Manage'}
                </Link>
              }
            />
            <CardBody>
              <PropertyGrid
                items={[
                  {
                    label: t('agents.passages') || 'Passages',
                    value:
                      indexed > 0 ? <span className="figure">{formatNumber(indexed)}</span> : undefined,
                    note: t('agents.thePiecesThisChatbotSearches') || 'The pieces this chatbot searches when it answers.',
                  },
                  {
                    label: t('agents.lastTrained') || 'Last trained',
                    value: agent.crawl_completed_at ? (
                      <span className="figure">{formatDate(agent.crawl_completed_at)}</span>
                    ) : undefined,
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Card className="flex flex-col">
            <CardHeader
              size="sm"
              title={t('agents.deployment') || 'Deployment'}
              titleAs="h2"
              actions={
                <Link to={agentPath(agent.id, 'deploy')} className={buttonClass('ghost', 'sm')}>
                  {t('agents.manage') || 'Manage'}
                </Link>
              }
            />
            <CardBody>
              {/* The chatbot key is a fourth fact, not a block with its own
                  eyebrow under a list that already had a label treatment. */}
              <PropertyGrid
                items={[
                  {
                    label: t('agents.websiteWidget') || 'Website widget',
                    value: (
                      <Badge tone={installed ? 'success' : 'neutral'} dot>
                        {installed ? t('agents.installed') || 'Installed' : t('agents.notInstalled') || 'Not installed'}
                      </Badge>
                    ),
                  },
                  { label: t('agents.website') || 'Website', value: agent.website || undefined },
                  {
                    label: t('agents.firstSeenLive') || 'First seen live',
                    value: agent.widget_installed_at ? (
                      <span className="figure">{formatDate(agent.widget_installed_at)}</span>
                    ) : undefined,
                  },
                  {
                    label: t('agents.chatbotKey2') || 'Chatbot key',
                    value: agent.bot_key ? (
                      <CopyField value={agent.bot_key} label={t('agents.chatbotKey') || 'chatbot key'} compact />
                    ) : undefined,
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Card className="flex flex-col">
            {/* These three are windowed by the range control exactly as the
                strip above is: switching 30 days to 7 turns "Links shared 8"
                into "2". The window went unstated because `CardHeader size="sm"`
                ignores an eyebrow by design (a widget card's whole header is
                40px), so it is stated on the header's description line instead
               , the only figures on this row that move with the control. */}
            <CardHeader
              size="sm"
              title={t('agents.demoShares') || 'Demo shares'}
              titleAs="h2"
              description={rangeLabel(days)}
            />
            <CardBody>
              {/* A dead dashboard call left all three of these reading zero, on
                  a card whose whole subject is whether anyone is sharing this
                  chatbot. The strip's alert above explains the same failure for
                  the same query; this card owns its own retry because it is a
                  screen away from it in a three-up row. */}
              {figures.error ? (
                <ErrorState
                  size="panel"
                  polite
                  description={figures.error}
                  onRetry={figures.retry}
                />
              ) : (
                <PropertyGrid
                  items={[
                    {
                      label: t('agents.linksShared') || 'Links shared',
                      value: sectionFigure(figures, formatNumber(figures.data.demoShares)),
                    },
                    {
                      label: t('agents.demosOpened') || 'Demos opened',
                      value: sectionFigure(figures, formatNumber(figures.data.demoOpens)),
                    },
                    {
                      label: t('agents.openRate') || 'Open rate',
                      value: sectionFigure(
                        figures,
                        // A rate over no shares is absent, not zero.
                        figures.data.demoOpenRate === null
                          ? null
                          : formatPercent(figures.data.demoOpenRate / 100),
                      ),
                    },
                  ]}
                />
              )}
            </CardBody>
          </Card>
        </Grid>
      </Stack>
    </Page>
  );
}

/** Shown while the chatbot itself is still resolving from the URL. */
function OverviewSkeleton() {
  const { t } = useTranslation();
  return (
    <Page width="wide">
      <PageHeader title={t('agents.overview') || 'Overview'} />
      <Stack>
        <Card>
          <CardBody className="flex items-center gap-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-64" />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </CardBody>
        </Card>
        <Columns
          asideWidth="md"
          main={
            <Card>
              <CardBody>
                <Skeleton className="h-56" />
              </CardBody>
            </Card>
          }
          aside={
            <Card>
              <CardBody>
                <Skeleton className="h-56" />
              </CardBody>
            </Card>
          }
        />
      </Stack>
    </Page>
  );
}

export function OverviewPage() {
  const { t } = useTranslation();
  const { agent, loading, error, refresh } = useAgent();

  if (agent) {
    // Keyed on the chatbot, so switching to another one remounts rather than
    // rendering one chatbot's numbers under another's name for a frame.
    return <OverviewContent key={agent.id} agent={agent} />;
  }

  if (loading) return <OverviewSkeleton />;

  // A 403 and a missing chatbot are different answers, and offering both at once
  // asked the reader to guess which one they got.
  if (error?.status === 403) {
    return (
      <Page width="wide">
        <PageHeader title={t('agents.overview') || 'Overview'} />
        <LockedState
          title={t('agents.thisChatbotIsNotYours') || 'This chatbot is not yours to see'}
          description={t('agents.askAnOwnerOrAdmin') || 'Ask an owner or admin of this workspace for access.'}
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'md')}>
              {t('agents.backToYourChatbots') || 'Back to your chatbots'}
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader title={t('agents.overview') || 'Overview'} />
      <Card>
        <ErrorState
          title={error ? t('agents.weCouldNotLoadThis') || 'We could not load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
          description={
            error
              ? error.message || t('agents.somethingWentWrongWhileLoading') || 'Something went wrong while loading this workspace.'
              : t('agents.thisChatbotDoesNotExist2') || 'This chatbot does not exist in this workspace.'
          }
          onRetry={() => void refresh()}
        />
      </Card>
    </Page>
  );
}

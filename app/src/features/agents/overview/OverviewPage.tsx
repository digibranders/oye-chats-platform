import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
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
  if (!section.error) return null;
  return (
    <CardSection>
      <Alert
        tone="danger"
        title={title}
        action={
          <Button size="sm" onClick={section.retry}>
            Try again
          </Button>
        }
      >
        {section.error}
      </Alert>
    </CardSection>
  );
}

function OverviewContent({ agent }: { agent: Bot }) {
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
        title="Overview"
        actions={
          // `Button loading` carries the spinner AND `aria-busy`. The hand-rolled
          // `animate-spin` it replaces froze at 0° under `prefers-reduced-motion`
          // and announced nothing at all.
          <Button loading={refreshing} onClick={refreshEverything}>
            Refresh
          </Button>
        }
        toolbar={
          <SegmentedControl
            label="Reporting period"
            value={String(days)}
            onChange={(value) => setDays(parseRange(value))}
            items={RANGE_OPTIONS.map((option) => ({
              value: String(option),
              label: `${option} days`,
            }))}
          />
        }
      />

      <Stack>
        <AgentHealthStrip
          agent={agent}
          health={health}
          aside={
            // "Right now" belongs beside the verdict, not inside a card stamped
            // with a 30-day window.
            <span className="text-xs text-text-secondary">
              <span className="figure font-medium text-text-primary">
                {formatNumber(figures.data.activeVisitors)}
              </span>{' '}
              chatting right now
            </span>
          }
        />

        <Card>
          {/* The window is stated here, once, for the whole strip — `StatRow`
              suppresses it on every tile that shares it. */}
          <CardHeader
            eyebrow={rangeLabel(days)}
            title="Performance"
            titleAs="h2"
            actions={
              <Link to="/analytics" className={buttonClass('ghost', 'sm')}>
                Full analytics
              </Link>
            }
          />
          <CardBody flush>
            <StatRow
              period={rangeLabel(days)}
              label="Conversation volume"
              columns={4}
              items={[
                {
                  label: 'Conversations',
                  value: formatNumber(figures.data.conversations),
                  size: 'lg',
                  delta: deltas.conversations ?? undefined,
                  loading: figures.loading,
                },
                {
                  label: 'Messages',
                  value: formatNumber(figures.data.messages),
                  size: 'lg',
                  delta: deltas.messages ?? undefined,
                  loading: figures.loading,
                },
                {
                  label: 'Resolution rate',
                  value:
                    resolution.data.rate === null
                      ? undefined
                      : formatPercent(resolution.data.rate / 100),
                  // The endpoint takes no window, so this tile states its own.
                  period: 'All time',
                  size: 'lg',
                  empty: resolution.loading ? undefined : 'Not rated yet',
                  loading: resolution.loading,
                },
                {
                  label: 'Average rating',
                  value:
                    ratings.data.average === null
                      ? undefined
                      : `${formatNumber(ratings.data.average)} / 5`,
                  period: 'All time',
                  size: 'lg',
                  empty: ratings.loading ? undefined : 'Not rated yet',
                  loading: ratings.loading,
                },
              ]}
            />
          </CardBody>
          <SectionError section={figures} title="We could not load these figures" />
          <SectionError section={resolution} title="We could not load the resolution rate" />
          <SectionError section={ratings} title="We could not load the ratings" />
        </Card>

        {/* The chart and the ranked list are one answer — what visitors did, and
            what they asked — so they share a row rather than sitting 700px
            apart with five blocks between them. */}
        <Columns
          asideWidth="md"
          asideLabel="Top questions"
          main={
            <Card>
              <CardHeader size="sm" title="Activity" titleAs="h2" />
              <CardBody>
                <ActivityChart section={activity} days={days} />
              </CardBody>
            </Card>
          }
          aside={
            <Card className="h-full">
              <CardHeader size="sm" title="Top questions" titleAs="h2" />
              <TopQuestions section={questions} />
            </Card>
          }
        />

        <Grid cols={3}>
          <Card className="flex flex-col">
            <CardHeader
              size="sm"
              title="Knowledge"
              titleAs="h2"
              actions={
                <Link to={agentPath(agent.id, 'knowledge')} className={buttonClass('ghost', 'sm')}>
                  Manage
                </Link>
              }
            />
            <CardBody>
              <PropertyGrid
                items={[
                  {
                    label: 'Passages',
                    value:
                      indexed > 0 ? <span className="figure">{formatNumber(indexed)}</span> : undefined,
                    note: 'The pieces this chatbot searches when it answers.',
                  },
                  {
                    label: 'Last trained',
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
              title="Deployment"
              titleAs="h2"
              actions={
                <Link to={agentPath(agent.id, 'deploy')} className={buttonClass('ghost', 'sm')}>
                  Manage
                </Link>
              }
            />
            <CardBody>
              {/* The chatbot key is a fourth fact, not a block with its own
                  eyebrow under a list that already had a label treatment. */}
              <PropertyGrid
                items={[
                  {
                    label: 'Website widget',
                    value: (
                      <Badge tone={installed ? 'success' : 'neutral'} dot>
                        {installed ? 'Installed' : 'Not installed'}
                      </Badge>
                    ),
                  },
                  { label: 'Website', value: agent.website || undefined },
                  {
                    label: 'First seen live',
                    value: agent.widget_installed_at ? (
                      <span className="figure">{formatDate(agent.widget_installed_at)}</span>
                    ) : undefined,
                  },
                  {
                    label: 'Chatbot key',
                    value: agent.bot_key ? (
                      <CopyField value={agent.bot_key} label="chatbot key" compact />
                    ) : undefined,
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Card className="flex flex-col">
            <CardHeader size="sm" title="Demo shares" titleAs="h2" />
            <CardBody>
              <PropertyGrid
                items={[
                  {
                    label: 'Links shared',
                    value: (
                      <span className="figure">{formatNumber(figures.data.demoShares)}</span>
                    ),
                  },
                  {
                    label: 'Demos opened',
                    value: <span className="figure">{formatNumber(figures.data.demoOpens)}</span>,
                  },
                  {
                    label: 'Open rate',
                    value:
                      figures.data.demoOpenRate === null ? undefined : (
                        <span className="figure">
                          {formatPercent(figures.data.demoOpenRate / 100)}
                        </span>
                      ),
                  },
                ]}
              />
            </CardBody>
          </Card>
        </Grid>
      </Stack>
    </Page>
  );
}

/** Shown while the chatbot itself is still resolving from the URL. */
function OverviewSkeleton() {
  return (
    <Page width="wide">
      <PageHeader title="Overview" />
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
        <PageHeader title="Overview" />
        <LockedState
          title="This chatbot is not yours to see"
          description="Ask an owner or admin of this workspace for access."
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'md')}>
              Back to your chatbots
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader title="Overview" />
      <Card>
        <ErrorState
          title={error ? 'We could not load this chatbot' : 'Chatbot not found'}
          description={
            error
              ? error.message || 'Something went wrong while loading this workspace.'
              : 'This chatbot does not exist in this workspace.'
          }
          onRetry={() => void refresh()}
        />
      </Card>
    </Page>
  );
}

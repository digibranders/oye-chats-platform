import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  CopyField,
  DefinitionList,
  ErrorState,
  Eyebrow,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  StatTile,
  buttonClass,
  formatDate,
  formatNumber,
  formatPercent,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { agentPath } from '../../../shell/nav';
import { agentHealth, type AgentHealth } from '../../home/agentHealth';
import type { Bot } from '../../../types/domain';
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
 * Five things the page it replaces got wrong, closed here.
 *
 * It rendered **two `h1`s** — the agent layout's chatbot name plus the page's
 * own title. That layout is gone: the rail names the chatbot and the top bar
 * breadcrumbs it, so this page owns exactly one heading, from `PageHeader`.
 *
 * Its fourth card was labelled **"7-day performance" and read all-time values**,
 * because no period was ever passed. The range is a control now, it is in the
 * URL, and every figure states the window it actually covers — including the
 * three that have no window and say so.
 *
 * **Resolution rate and average rating each appeared twice on one screen**, in
 * the metric row and again in that card. Each appears once.
 *
 * Its "View analytics" link pointed at `/agents/:id/analytics`, a route that
 * redirected back to the page the link was on. The deep dive is `/analytics`.
 *
 * And a failed section rendered a dead card with no way to retry it, while the
 * page-level retry called the narrow refetch that left the chatbot record stale.
 * Every section here retries itself; the page-level Refresh reloads the chatbot
 * record too.
 */

/** The severity word beside the specific state, so colour is never the signal. */
const SEVERITY: Record<AgentHealth['tone'], string> = {
  success: 'Healthy',
  warning: 'Needs you',
  danger: 'Not working',
  neutral: 'In progress',
};

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

function HealthCard({ agent, health }: { agent: Bot; health: AgentHealth }) {
  return (
    <Card>
      <CardBody className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <Eyebrow>Status</Eyebrow>
          <h2 className="mt-1.5 flex flex-wrap items-center gap-2 text-lg font-semibold text-text-primary">
            {health.label}
            <Badge tone={health.tone} dot>
              {SEVERITY[health.tone]}
            </Badge>
          </h2>
          <p className="mt-1.5 max-w-prose text-prose text-text-secondary">{health.detail}</p>
        </div>
        {health.action ? (
          <Link
            to={agentPath(agent.id, health.action.segment)}
            className={buttonClass('accent', 'md')}
          >
            {health.action.label}
          </Link>
        ) : null}
      </CardBody>
    </Card>
  );
}

function OverviewContent({ agent }: { agent: Bot }) {
  const [params, setParams] = useSearchParams();
  const days = parseRange(params.get('days'));
  const { refresh: refreshAgent } = useAgent();
  const { figures, activity, questions, ratings, resolution, refreshing, refreshAll } =
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
   * Including the chatbot record — the health card, the knowledge figure and the
   * install state all read the `Bot`, not the analytics payload, so refetching
   * metrics alone left a stale "nothing to answer from" on screen that no amount
   * of clicking could clear. That trap was documented in the code it replaces
   * and then wired to the wrong callback anyway.
   */
  const refreshEverything = useCallback(() => {
    void refreshAgent();
    refreshAll();
  }, [refreshAgent, refreshAll]);

  return (
    <Page width="wide">
      <PageHeader
        title="Overview"
        description="How this chatbot is doing, and what needs you next."
        actions={
          <Button
            iconLeft={<RefreshCw aria-hidden className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />}
            disabled={refreshing}
            onClick={refreshEverything}
          >
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
        <HealthCard agent={agent} health={health} />

        <Card>
          <CardHeader
            eyebrow={rangeLabel(days)}
            title="Conversations"
            titleAs="h2"
            description="What visitors did with this chatbot in the selected period."
            actions={
              <Link to="/analytics" className={buttonClass('ghost', 'sm')}>
                Full analytics
              </Link>
            }
          />
          <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            <StatTile
              label="Conversations"
              value={formatNumber(figures.data.conversations)}
              period={rangeLabel(days)}
              loading={figures.loading}
            />
            <StatTile
              label="Messages"
              value={formatNumber(figures.data.messages)}
              period={rangeLabel(days)}
              loading={figures.loading}
            />
            {/* Not windowed, and not pretended to be: the server answers this
                one from the last fifteen minutes whatever `days` says. */}
            <StatTile
              label="Visitors chatting"
              value={formatNumber(figures.data.activeVisitors)}
              period="Right now"
              loading={figures.loading}
            />
            <StatTile
              label="Resolution rate"
              value={
                resolution.data.rate === null ? undefined : formatPercent(resolution.data.rate / 100)
              }
              period="All time"
              hint={
                resolution.data.rate === null && !resolution.loading
                  ? 'No visitor has rated a conversation resolved yet'
                  : undefined
              }
              loading={resolution.loading}
            />
          </CardBody>
          <SectionError section={figures} title="We could not load these figures" />
          <SectionError section={resolution} title="We could not load the resolution rate" />
        </Card>

        <Section
          title="Activity"
          description="Messages a day. This series is not windowed by the server, so it is trimmed to your selected range."
        >
          <Card>
            <CardBody>
              <ActivityChart section={activity} days={days} />
            </CardBody>
          </Card>
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader
              title="Knowledge"
              titleAs="h2"
              description="What this chatbot can answer from."
              actions={
                <Link to={agentPath(agent.id, 'knowledge')} className={buttonClass('ghost', 'sm')}>
                  Manage
                </Link>
              }
            />
            <CardBody className="grid grid-cols-2 gap-6">
              <StatTile
                label="Passages"
                value={indexed > 0 ? formatNumber(indexed) : undefined}
                period="Indexed now"
                hint={indexed > 0 ? undefined : 'Add a website or upload documents'}
              />
              <StatTile
                label="Last trained"
                value={agent.crawl_completed_at ? formatDate(agent.crawl_completed_at) : undefined}
                period="Most recent successful run"
              />
            </CardBody>
          </Card>

          <Card className="flex flex-col">
            <CardHeader
              title="Deployment"
              titleAs="h2"
              description="Where visitors can reach it."
              actions={
                <Link to={agentPath(agent.id, 'deploy')} className={buttonClass('ghost', 'sm')}>
                  Manage
                </Link>
              }
            />
            <CardBody className="space-y-4">
              <DefinitionList
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
                    value: agent.widget_installed_at
                      ? formatDate(agent.widget_installed_at)
                      : undefined,
                  },
                ]}
              />
              <div className="space-y-1.5">
                <Eyebrow>Chatbot key</Eyebrow>
                {agent.bot_key ? (
                  <CopyField value={agent.bot_key} label="chatbot key" />
                ) : (
                  <p className="text-xs text-text-tertiary">Not issued yet.</p>
                )}
              </div>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            eyebrow={rangeLabel(days)}
            title="Demo shares"
            titleAs="h2"
            description="The demo link is a working copy of this chatbot you can send to anyone — a colleague, a client, the person who will install it. These count how often it was shared and opened."
          />
          <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-3">
            <StatTile
              label="Links shared"
              value={formatNumber(figures.data.demoShares)}
              period={rangeLabel(days)}
              loading={figures.loading}
            />
            <StatTile
              label="Demos opened"
              value={formatNumber(figures.data.demoOpens)}
              period={rangeLabel(days)}
              loading={figures.loading}
            />
            <StatTile
              label="Open rate"
              value={
                figures.data.demoOpenRate === null
                  ? undefined
                  : formatPercent(figures.data.demoOpenRate / 100)
              }
              period={rangeLabel(days)}
              hint={
                figures.data.demoOpenRate === null && !figures.loading
                  ? 'Nothing shared in this period'
                  : undefined
              }
              loading={figures.loading}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Visitor ratings"
            titleAs="h2"
            description="Ratings left after a conversation. This endpoint has no period, so it covers all time."
          />
          <CardBody className="grid grid-cols-2 gap-6">
            <StatTile
              label="Average rating"
              value={ratings.data.average === null ? undefined : `${formatNumber(ratings.data.average)} / 5`}
              period="All time"
              hint={
                ratings.data.average === null && !ratings.loading ? 'No ratings yet' : undefined
              }
              loading={ratings.loading}
            />
            <StatTile
              label="Ratings given"
              value={formatNumber(ratings.data.total)}
              period="All time"
              loading={ratings.loading}
            />
          </CardBody>
          <SectionError section={ratings} title="We could not load the ratings" />
        </Card>

        <Section title="Top questions" description="What visitors ask most. All time.">
          <TopQuestions section={questions} />
        </Section>
      </Stack>
    </Page>
  );
}

/** Shown while the chatbot itself is still resolving from the URL. */
function OverviewSkeleton() {
  return (
    <Page width="wide">
      <PageHeader title="Overview" description="How this chatbot is doing, and what needs you next." />
      <Stack>
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-full max-w-md" />
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

  return (
    <Page width="wide">
      <PageHeader title="Overview" />
      <Card>
        <ErrorState
          title={error ? 'We could not load this chatbot' : 'Chatbot not found'}
          description={
            error
              ? error.message || 'Something went wrong while loading this workspace.'
              : 'This chatbot does not exist, or it belongs to a workspace you cannot see.'
          }
          onRetry={() => void refresh()}
        />
      </Card>
    </Page>
  );
}

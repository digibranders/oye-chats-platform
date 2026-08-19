import { Link } from 'react-router-dom';
import { ArrowRight, Bot as BotIcon, Inbox, Plus, Users } from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
  Section,
  Stack,
  StatTile,
  buttonClass,
  cn,
  formatNumber,
} from '../../ui';
import { agentPath } from '../../shell/nav';
import { useSetupChecklist } from '../../onboarding/useSetupChecklist';
import { useHomeData, type HomeAgent } from './useHomeData';

/**
 * Home is today's work, not a dashboard.
 *
 * The page it replaces opened with four all-time counters over no stated period
 * and a "Recommended next steps" section whose only branch fired when a
 * workspace already had hot leads — so the single most important activation
 * surface in the product rendered an empty div for exactly the users who needed
 * it. Numbers are here, but they are not the point and they are not first.
 *
 * The order is: what is broken, what is waiting, then how things are going. A
 * chatbot that cannot answer is worth more of this page than a total is.
 */

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function AgentRow({ agent }: { agent: HomeAgent }) {
  const { bot, health } = agent;
  return (
    <li className="border-t border-border first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
        <Avatar name={bot.name ?? 'Chatbot'} shape="rounded" />
        <div className="min-w-0 flex-1">
          <Link
            to={agentPath(bot.id, 'overview')}
            className="block truncate text-base font-medium text-text-primary underline-offset-2 hover:underline"
          >
            {bot.name ?? `Chatbot ${bot.id}`}
          </Link>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {bot.website ?? 'No website set'}
          </p>
        </div>
        <Badge tone={health.tone} dot>
          {health.label}
        </Badge>
        <p className="figure w-20 text-right text-sm text-text-secondary">
          {formatNumber(agent.conversations)}
          <span className="ml-1 text-text-tertiary">chats</span>
        </p>
        {health.action ? (
          <Link
            to={agentPath(bot.id, health.action.segment)}
            className={buttonClass('secondary', 'sm')}
          >
            {health.action.label}
          </Link>
        ) : (
          <span className="w-[6.5rem]" />
        )}
      </div>
    </li>
  );
}

export function HomePage() {
  const now = new Date();
  const home = useHomeData();
  const setup = useSetupChecklist();

  const hasAgents = home.agents.length > 0;

  return (
    <Page width="wide">
      <PageHeader
        title={greeting(now)}
        description={
          hasAgents
            ? 'What needs you, and how your chatbots are doing.'
            : 'Let us get your first chatbot answering questions.'
        }
        actions={
          <Link to="/chatbots?new=1" className={buttonClass('primary', 'md')}>
            <Plus aria-hidden className="h-4 w-4" />
            New chatbot
          </Link>
        }
      />

      {home.error ? (
        <Card>
          <ErrorState
            title="We could not load your workspace"
            description={home.error.message}
            onRetry={() => void home.retry()}
          />
        </Card>
      ) : (
        <Stack>
          {/* Setup first, while it is incomplete. It is the only thing on this
              page that changes whether the product works at all. */}
          {!setup.complete && !setup.loading ? (
            <Card>
              <CardHeader
                eyebrow="Setup"
                title="Finish getting set up"
                titleAs="h2"
                description={`${setup.done} of ${setup.total} done. Each one takes a minute.`}
                actions={
                  <Link to="/setup" className={buttonClass('secondary', 'sm')}>
                    See all
                    <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                  </Link>
                }
              />
              <ul>
                {setup.steps
                  .filter((step) => !step.done)
                  .slice(0, 2)
                  .map((step) => (
                    <li key={step.id} className="border-t border-border first:border-t-0">
                      <Link
                        to={step.to}
                        className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-hover"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-medium text-text-primary">
                            {step.label}
                          </span>
                          <span className="mt-0.5 block text-prose text-text-secondary">
                            {step.description}
                          </span>
                        </span>
                        <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
                      </Link>
                    </li>
                  ))}
              </ul>
            </Card>
          ) : null}

          {/* What is broken. Named chatbots with a way to fix each one — not a
              count, because a count is not actionable. */}
          {home.needsAttention.length > 0 ? (
            <Section title="Needs attention">
              <div className="space-y-2">
                {home.needsAttention.map(({ bot, health }) => (
                  <Alert
                    key={bot.id}
                    tone={health.tone === 'danger' ? 'danger' : 'warning'}
                    title={`${bot.name ?? `Chatbot ${bot.id}`} — ${health.label.toLowerCase()}`}
                    action={
                      health.action ? (
                        <Link
                          to={agentPath(bot.id, health.action.segment)}
                          className={buttonClass('secondary', 'sm')}
                        >
                          {health.action.label}
                        </Link>
                      ) : undefined
                    }
                  >
                    {health.detail}
                  </Alert>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Then the numbers, each anchored to a period. */}
          <Card>
            <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <StatTile
                label="Conversations"
                value={formatNumber(home.conversations)}
                period="All time"
                loading={home.loading}
              />
              <StatTile
                label="Qualified leads"
                value={home.leadsLocked ? undefined : formatNumber(home.qualifiedLeads)}
                period="All time"
                hint={home.leadsLocked ? 'Available on Standard and above' : undefined}
                loading={home.loading}
              />
              <StatTile
                label="Unread messages"
                value={formatNumber(home.unreadMessages)}
                period="Waiting for a reply"
                tone={home.unreadMessages > 0 ? 'warning' : 'neutral'}
                loading={home.loading}
              />
              <StatTile
                label="Chatbots live"
                value={formatNumber(home.agents.filter((a) => a.health.state === 'live').length)}
                period={`of ${home.agents.length}`}
                loading={home.loading}
              />
            </CardBody>
            {home.statsIncomplete ? (
              <div className="border-t border-border px-5 py-3">
                <Alert tone="warning">
                  Some chatbots did not report their numbers, so these totals are lower than the
                  real ones.
                </Alert>
              </div>
            ) : null}
          </Card>

          <Section
            title="Your chatbots"
            actions={
              hasAgents ? (
                <Link to="/chatbots" className={buttonClass('ghost', 'sm')}>
                  See all
                </Link>
              ) : undefined
            }
          >
            <Card>
              {home.loading ? (
                <CardBody>
                  <LoadingRows rows={3} />
                </CardBody>
              ) : hasAgents ? (
                <ul>
                  {home.agents.map((agent) => (
                    <AgentRow key={agent.bot.id} agent={agent} />
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={BotIcon}
                  title="No chatbots yet"
                  description="Name one, point it at your website, and it will start reading. You can talk to it while it learns."
                  action={
                    <Link to="/chatbots?new=1" className={buttonClass('primary', 'sm')}>
                      Create your first chatbot
                    </Link>
                  }
                />
              )}
            </Card>
          </Section>

          {hasAgents ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Link
                to="/inbox"
                className={cn(
                  'flex items-center gap-3 rounded-lg border border-border bg-surface px-5 py-4',
                  'transition-colors hover:border-border-strong',
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-sunken">
                  <Inbox aria-hidden className="h-4 w-4 text-text-tertiary" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium text-text-primary">Inbox</span>
                  <span className="block text-xs text-text-secondary">
                    Take over a conversation, or answer what came in overnight.
                  </span>
                </span>
                <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
              </Link>
              <Link
                to="/leads"
                className={cn(
                  'flex items-center gap-3 rounded-lg border border-border bg-surface px-5 py-4',
                  'transition-colors hover:border-border-strong',
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-sunken">
                  <Users aria-hidden className="h-4 w-4 text-text-tertiary" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium text-text-primary">Leads</span>
                  <span className="block text-xs text-text-secondary">
                    Who asked about buying, and how ready they sounded.
                  </span>
                </span>
                <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
              </Link>
            </div>
          ) : null}
        </Stack>
      )}
    </Page>
  );
}

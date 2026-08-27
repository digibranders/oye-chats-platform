import { useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowRight, Bot as BotIcon, Plus, X } from 'lucide-react';
import {
  ABSENT,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  Columns,
  DataTable,
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  StatRow,
  StatusDot,
  BUTTON_ICON_SLOT,
  buttonClass,
  formatNumber,
  formatRelative,
  type Column,
} from '../../ui';
import { agentPath } from '../../shell/nav';
import { AgentAvatar } from '../agents/AgentAvatar';
import { useSetupChecklist } from '../../onboarding/useSetupChecklist';
import { wantsEmptyHome } from '../../onboarding/firstRun';
import { useWorkspace } from '../../context/WorkspaceContext';
import { leadDisplayName } from '../leads/leadModel';
import type { Lead } from '../../types/domain';
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
 * **It is a grid, not a scroll.** It was five full-width bands stacked down one
 * column — a setup card, three identical warning alerts, a strip of four
 * numbers, a fake table and two link tiles — so the first product figure sat a
 * thousand pixels below the fold. Now: one hairline-divided figure strip across
 * the top, then two tracks. The left track is *work* — what is broken, and how
 * every chatbot is doing. The right rail is *state* — what is left to set up and
 * what came in. That is Stripe's Home, and it is the shape this page always
 * wanted.
 *
 * **Each fact is stated on exactly one of the two tracks.** The first cut said
 * everything twice: "Nothing to answer from" appeared as a row in *Needs
 * attention* and again as the status badge of the same chatbot in the table
 * forty pixels below it, each with its own "Add knowledge" button. The table
 * carries the *state*, because a state is a column value and a healthy chatbot
 * needs one too; the attention list carries the *consequence and the fix*,
 * because that is the one thing a status badge cannot say.
 *
 * **`Columns` requires `main` to be the taller track**, and the first cut had it
 * backwards — the aside ran 785px past the bottom of the work column at 1440,
 * because it held an uncapped lead list and two link tiles that only repeated
 * rail rows. Recent leads is now a bounded sample with a way to the rest, and
 * the tiles are gone.
 */

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Per workspace, so dismissing it on one does not dismiss it on another. */
function setupDismissalKey(workspaceId: number | null): string {
  return `oyechats_home_setup_dismissed_${workspaceId ?? 'default'}`;
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function HomePage() {
  // Computed once. In the render body it changed on any unrelated re-render, so
  // the page's own byline could flip from "Good afternoon" to "Good evening"
  // while somebody was typing somewhere else on the screen.
  const hello = useMemo(() => greeting(new Date()), []);
  const home = useHomeData();
  const setup = useSetupChecklist();
  const { currentWorkspaceId } = useWorkspace();

  const dismissKey = setupDismissalKey(currentWorkspaceId);
  const [setupDismissed, setSetupDismissed] = useState(() => readDismissed(dismissKey));

  const hasAgents = home.agents.length > 0;

  // A workspace with no chatbot has nothing on this page but zeros. Send it to
  // the first run instead — and decide that here, from server state, rather than
  // guessing at the end of sign-up: a routing guess made on a registration
  // response is wrong for anyone who created an account days ago and is only now
  // getting round to it. The guard is off unless the list actually loaded, so a
  // failed fetch shows the error rather than pretending the account is new.
  //
  // "Skip for now" on the first run sets a flag for the session, and that flag
  // wins: the redirect used to be unconditional, so the empty Home below this
  // was unreachable code and the rail's Home item silently bounced.
  if (!home.loading && !home.error && !hasAgents && !wantsEmptyHome()) {
    return <Navigate to="/welcome" replace />;
  }

  const showSetup = !setup.complete && !setup.loading && !setupDismissed;

  return (
    <Page width="wide">
      <PageHeader
        eyebrow={hello}
        title="Home"
        actions={
          <Link
            to="/chatbots?new=1"
            className={buttonClass('primary', 'md', BUTTON_ICON_SLOT.md)}
          >
            <Plus aria-hidden />
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
        <>
          {/* The figures, anchored to one window and compared to the one before
              it. The window is stated once, by `StatRow`'s own caption — this
              header used to restate it on the right, so the card printed
              "Last 30 days" twice, sixteen pixels apart, the moment the strip
              learned to say it itself. A tile whose window genuinely differs
              still states its own. */}
          <Card className="mb-6">
            <CardHeader size="sm" title="Workspace" titleAs="h2" />
            <CardBody flush>
              <StatRow
                label="Workspace at a glance"
                period={`Last ${home.windowDays} days`}
                items={[
                  {
                    label: 'Conversations',
                    value: formatNumber(home.conversations),
                    delta: home.conversationsDelta ?? undefined,
                    size: 'lg',
                    loading: home.conversationsLoading,
                  },
                  {
                    label: 'Qualified leads',
                    value: home.leadsLocked ? undefined : formatNumber(home.qualifiedLeads),
                    period: 'All time',
                    hint: home.leadsLocked ? 'On Starter and above' : undefined,
                    loading: home.leadsLoading,
                  },
                  {
                    label: 'Unread messages',
                    value: formatNumber(home.unreadMessages),
                    period: 'Right now',
                    tone: home.unreadMessages > 0 ? 'warning' : 'neutral',
                    loading: home.unreadLoading,
                  },
                  {
                    label: 'Chatbots live',
                    value: `${home.live}/${home.agents.length}`,
                    period: 'Right now',
                    loading: home.loading,
                  },
                ]}
              />
            </CardBody>
            {home.statsIncomplete ? (
              <CardSection className="text-xs text-text-secondary">
                Some chatbots did not report — totals are low.
              </CardSection>
            ) : null}
          </Card>

          <Columns
            /* 18rem, not 24. `md` needs a 1024px page container, which a 1280
               laptop — the commonest desktop width there is — does not have
               after the rail and the gutter, so Home stacked to a single 2.5-fold
               column on it while 1440 got the grid. `sm` engages at 896 and the
               aside holds nothing wider than a name and a timestamp. */
            asideWidth="sm"
            asideLabel="Setup and recent activity"
            main={
              <div className="flex flex-col gap-6">
                <NeedsAttention agents={home.needsAttention} />
                <AgentTable agents={home.agents} loading={home.loading} hasAgents={hasAgents} />
              </div>
            }
            aside={
              <div className="flex flex-col gap-6">
                {showSetup ? (
                  <SetupCard
                    done={setup.done}
                    total={setup.total}
                    steps={setup.steps}
                    onDismiss={() => {
                      setSetupDismissed(true);
                      try {
                        window.localStorage.setItem(dismissKey, 'true');
                      } catch {
                        /* private mode: it stays dismissed for this session */
                      }
                    }}
                  />
                ) : null}
                {home.recentAvailable ? (
                  <RecentActivity leads={home.recentLeads} loading={home.recentLoading} />
                ) : null}
              </div>
            }
          />
        </>
      )}
    </Page>
  );
}

/**
 * What is broken, as a list of named chatbots.
 *
 * One card of hairline rows, not one `<Alert>` per chatbot. Four unhealthy
 * chatbots used to be four stacked tinted blocks — about 280px of warning ground
 * repeating almost the same sentence four times — where `Alert` is documented
 * for something the reader must read *in order to proceed*. A list of objects is
 * not that; it is a list.
 */
function NeedsAttention({ agents }: { agents: readonly HomeAgent[] }) {
  if (agents.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Needs attention"
        titleAs="h2"
        actions={<Badge tone="danger">{agents.length}</Badge>}
      />
      <ul data-card-band>
        {agents.map(({ bot, health }) => (
          <li
            key={bot.id}
            className="flex min-h-row-compact flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-cell py-2 first:border-t-0"
          >
            <StatusDot size="sm" tone={health.tone} label={health.label} />
            <Link
              to={agentPath(bot.id, 'overview')}
              className="min-w-0 flex-1 truncate text-base font-medium text-text-primary underline-offset-2 hover:underline"
            >
              {bot.name ?? `Chatbot ${bot.id}`}
            </Link>
            {/* `aria-hidden`: the dot beside it already carries this word for
                assistive tech, and reading it twice per row is noise. */}
            {/* The *consequence*, not the state. The state is a column in the
                table below — `health.label` on both surfaces printed "Nothing
                to answer from" six times on one screen, three of them beside a
                button that already said what to do about it. This row answers
                the question the badge does not: what is it costing me? */}
            <span className="shrink-0 text-xs text-text-secondary">{health.detail}</span>
            {health.action ? (
              <Link
                to={agentPath(bot.id, health.action.segment)}
                className={buttonClass('secondary', 'sm')}
              >
                {health.action.label}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Every chatbot, as a real table.
 *
 * It was a flex row faking columns with `w-20` for the chat count and an empty
 * `w-[6.5rem]` spacer standing in for a button — a width picked to match one
 * label, so "Retry training" and "Install it" left the right edge ragged and no
 * two rows agreed on where the status began. `DataTable` gives it real columns,
 * the four states, the row count and a keyboard path.
 */
function AgentTable({
  agents,
  loading,
  hasAgents,
}: {
  agents: readonly HomeAgent[];
  loading: boolean;
  hasAgents: boolean;
}) {
  const columns = useMemo<Column<HomeAgent>[]>(
    () => [
      {
        key: 'chatbot',
        header: 'Chatbot',
        rowHeader: true,
        render: ({ bot }) => (
          <span className="flex items-center gap-2.5">
            <AgentAvatar agent={bot} size="sm" />
            <span className="min-w-0">
              <Link
                to={agentPath(bot.id, 'overview')}
                className="block truncate font-medium text-text-primary underline-offset-2 hover:underline"
              >
                {bot.name ?? `Chatbot ${bot.id}`}
              </Link>
            </span>
          </span>
        ),
      },
      {
        key: 'website',
        header: 'Website',
        secondary: true,
        width: '11rem',
        render: ({ bot }) =>
          bot.website ? (
            <span className="text-text-secondary">{bot.website}</span>
          ) : (
            <span className="text-text-tertiary">{ABSENT}</span>
          ),
      },
      {
        // 13rem, because "Nothing to answer from" is the longest label
        // `agentHealth` produces and a `fit` table ellipsises rather than
        // scrolls — at 11rem the status this card exists to report read
        // "Nothing to answer from …".
        key: 'status',
        header: 'Status',
        width: '13rem',
        render: ({ health }) => (
          <Badge tone={health.tone} dot>
            {health.label}
          </Badge>
        ),
      },
      {
        key: 'chats',
        header: 'Chats',
        type: 'number',
        width: '5rem',
        render: (agent) =>
          agent.conversationsLoading ? ABSENT : formatNumber(agent.conversations),
      },
    ],
    [],
  );

  return (
    <Card as="section">
      <CardHeader
        title="Your chatbots"
        titleAs="h2"
        actions={
          hasAgents ? (
            <Link to="/chatbots" className={buttonClass('ghost', 'sm')}>
              See all
            </Link>
          ) : undefined
        }
      />
      <CardBody flush>
        <DataTable
          seated
          fit
          caption="Your chatbots and how each one is doing"
          columns={columns}
          rows={agents}
          rowKey={(agent) => String(agent.bot.id)}
          rowNoun="chatbot"
          loading={loading}
          empty={
            <EmptyState
              size="inline"
              icon={BotIcon}
              title="No chatbots yet"
              description="Point one at your website and it will start reading."
              action={
                <Link to="/welcome" className={buttonClass('primary', 'sm')}>
                  Create your first chatbot
                </Link>
              }
            />
          }
        />
      </CardBody>
    </Card>
  );
}

/**
 * The first two open steps, in the rail.
 *
 * Dismissible, and that is the point: "Capture your first lead" completes on its
 * own or never, so for a workspace with no traffic this card was permanent
 * furniture at the top of the landing page. The rail's progress ring is the
 * permanent home for setup and stays either way.
 */
function SetupCard({
  done,
  total,
  steps,
  onDismiss,
}: {
  done: number;
  total: number;
  steps: ReturnType<typeof useSetupChecklist>['steps'];
  onDismiss: () => void;
}) {
  return (
    <Card>
      <CardHeader
        size="sm"
        title={
          <>
            Finish getting set up · <span className="figure">{done}</span> of{' '}
            <span className="figure">{total}</span>
          </>
        }
        titleAs="h2"
        actions={
          <Button variant="ghost" size="icon-xs" aria-label="Hide setup" onClick={onDismiss}>
            <X aria-hidden />
          </Button>
        }
      />
      <ul data-card-band>
        {steps
          .filter((step) => !step.done)
          .slice(0, 2)
          .map((step) => (
            <li key={step.id} className="border-t border-border first:border-t-0">
              <Link
                to={step.to}
                className="flex min-h-row items-center gap-3 px-cell py-2 transition-colors hover:bg-surface-hover"
              >
                <span className="min-w-0 flex-1 truncate text-base font-medium text-text-primary">
                  {step.label}
                </span>
                <ArrowRight aria-hidden className="h-icon-md w-icon-md shrink-0 text-text-tertiary" />
              </Link>
            </li>
          ))}
      </ul>
      <CardSection className="py-2">
        <Link to="/setup" className={buttonClass('link', 'sm')}>
          See all steps
        </Link>
      </CardSection>
    </Card>
  );
}

/**
 * What actually happened, which nothing on this page said before.
 *
 * Home showed *state* — counts and health — and no events at all, so an operator
 * opening it thirty times a day had no reason to look at it twice. Each row deep
 * links into the lead's own drawer.
 */
function RecentActivity({ leads, loading }: { leads: readonly Lead[]; loading: boolean }) {
  return (
    <Card as="section">
      <CardHeader
        size="sm"
        title="Recent leads"
        titleAs="h2"
        actions={
          leads.length > 0 ? (
            <Link to="/leads" className={buttonClass('ghost', 'sm')}>
              See all
            </Link>
          ) : undefined
        }
      />
      {loading ? (
        <CardBody className="text-xs text-text-secondary">Loading…</CardBody>
      ) : leads.length === 0 ? (
        <CardBody>
          <EmptyState
            size="inline"
            title="Nothing yet"
            description="Visitors appear here as soon as they start a conversation."
          />
        </CardBody>
      ) : (
        <ul data-card-band>
          {leads.map((lead) => (
            <li key={lead.session_id} className="border-t border-border first:border-t-0">
              <Link
                to={`/leads?lead=${encodeURIComponent(lead.session_id)}`}
                className="flex min-h-row-compact items-center gap-2.5 px-cell py-1.5 transition-colors hover:bg-surface-hover"
              >
                <Avatar name={leadDisplayName(lead)} size="xs" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {leadDisplayName(lead)}
                </span>
                <span className="shrink-0 text-xs text-text-tertiary">
                  {formatRelative(lead.last_active_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// The list's search, filter, sort and summary rules are pure functions, tested
// directly, so they are exported from the page that renders them rather than
// duplicated in a test. That is the only reason fast refresh's one-export rule
// is off here.
/* eslint-disable react-refresh/only-export-components */
import { useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Bot as BotIcon, Plus, SearchX } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardSection,
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  StatTile,
  Toolbar,
  buttonClass,
  formatNumber,
} from '../../ui';
import { getDashboardStats } from '../../services/api';
import { keys } from '../../query/keys';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { agentPath } from '../../shell/nav';
import { agentHealth, type AgentHealth } from '../home/agentHealth';
import type { Bot } from '../../types/domain';
import { AgentCard } from './AgentCard';
import { CreateAgentDialog } from './CreateAgentDialog';
import { resolveAgentCreationGate } from './agentLimit';

/**
 * The chatbot list.
 *
 * It answers one question — "which chatbots do I have, and which one needs me?"
 * — and it has to keep answering it at twenty chatbots, not just at two. So the
 * page is a searchable, filterable, sortable collection rather than an
 * unordered grid, and every one of those controls lives in the URL: a support
 * conversation that ends "open the list, filter to needs-attention" should be a
 * link, and Back should undo a filter rather than leaving the page.
 *
 * Three things the page it replaces got wrong, closed here:
 *
 * Its loading skeleton drew a four-tile summary row that the loaded page never
 * rendered, so every visit flashed four tiles that then evaporated. There is a
 * real summary now, and the skeleton is shaped like it.
 *
 * It carried a permanently sticky "Resume setup" button, because the flag only
 * cleared on the final wizard step — anyone who installed the widget by hand
 * kept the button forever. Launch Studio is gone; the checklist lives in the
 * rail and at `/setup`, derived from server state.
 *
 * It had two contradictory ways to create the same object: a two-field dialog
 * here and a seven-step wizard elsewhere. There is one now, and `?new=1` opens
 * it, because the rail and Home both link straight to it.
 */

export type StatusFilter = 'all' | 'live' | 'attention' | 'training';
export type SortKey = 'status' | 'name' | 'newest' | 'busiest';

export interface AgentListItem {
  bot: Bot;
  health: AgentHealth;
  /**
   * All-time conversations, or `null` when that chatbot's statistics call has
   * not settled or failed. Never coerced to zero: a broken chatbot rendered as
   * a quiet one is the exact bug the workspace totals used to ship.
   */
  conversations: number | null;
  /** True while that call is still in flight, so a card can wait rather than
   *  render an em dash it is about to replace. */
  conversationsLoading: boolean;
}

export interface AgentListSummary {
  total: number;
  live: number;
  attention: number;
  training: number;
  /** Sum across chatbots that reported. `null` when none of them did. */
  conversations: number | null;
}

/**
 * Worst first, so the default order puts the chatbot that is failing customers
 * at the top of the page rather than wherever the API happened to return it.
 */
const HEALTH_RANK: Record<AgentHealth['state'], number> = {
  broken: 0,
  untrained: 1,
  stale: 2,
  ready: 3,
  training: 4,
  live: 5,
};

export const SORT_OPTIONS = [
  { value: 'status', label: 'Needs attention first' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'newest', label: 'Newest first' },
  { value: 'busiest', label: 'Busiest first' },
] as const satisfies readonly { value: SortKey; label: string }[];

/** Free-text match over the two identifiers a person actually remembers. */
export function matchesQuery(item: AgentListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.bot.name, item.bot.website, item.bot.bot_key];
  return haystack.some((value) => (value ?? '').toLowerCase().includes(needle));
}

export function matchesStatus(item: AgentListItem, status: StatusFilter): boolean {
  switch (status) {
    case 'live':
      return item.health.state === 'live';
    case 'attention':
      return item.health.needsAttention;
    case 'training':
      return item.health.state === 'training';
    default:
      return true;
  }
}

/** Roll a set of chatbots up into the figures shown above the grid. */
export function summarizeAgents(items: readonly AgentListItem[]): AgentListSummary {
  const reported = items.filter((item) => item.conversations !== null);
  return {
    total: items.length,
    live: items.filter((item) => item.health.state === 'live').length,
    attention: items.filter((item) => item.health.needsAttention).length,
    training: items.filter((item) => item.health.state === 'training').length,
    conversations: reported.length
      ? reported.reduce((total, item) => total + (item.conversations ?? 0), 0)
      : null,
  };
}

/**
 * Order the list. Every comparator falls back to the name so the result is
 * stable — an unstable sort makes a list appear to reshuffle itself on refetch.
 */
export function sortAgents(items: readonly AgentListItem[], sort: SortKey): AgentListItem[] {
  const byName = (a: AgentListItem, b: AgentListItem): number =>
    (a.bot.name ?? '').localeCompare(b.bot.name ?? '', 'en', { sensitivity: 'base' });

  return [...items].sort((a, b) => {
    switch (sort) {
      case 'name':
        return byName(a, b);
      case 'newest': {
        const left = Date.parse(a.bot.created_at ?? '');
        const right = Date.parse(b.bot.created_at ?? '');
        // A chatbot with no readable creation date sorts last rather than
        // first: `NaN` compares false against everything and would otherwise
        // scatter those rows through the list.
        if (!Number.isFinite(left) && !Number.isFinite(right)) return byName(a, b);
        if (!Number.isFinite(left)) return 1;
        if (!Number.isFinite(right)) return -1;
        return right - left || byName(a, b);
      }
      case 'busiest':
        return (b.conversations ?? -1) - (a.conversations ?? -1) || byName(a, b);
      default:
        return HEALTH_RANK[a.health.state] - HEALTH_RANK[b.health.state] || byName(a, b);
    }
  });
}

function isSortKey(value: string | null): value is SortKey {
  return SORT_OPTIONS.some((option) => option.value === value);
}

function isStatusFilter(value: string | null): value is StatusFilter {
  return value === 'all' || value === 'live' || value === 'attention' || value === 'training';
}

/** A grid placeholder shaped like the cards that replace it. */
function AgentsLoading() {
  return (
    <ul aria-busy className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Card as="li" key={index}>
          <div className="flex items-start gap-3 px-5 py-4">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <CardSection className="grid grid-cols-2 gap-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </CardSection>
          <CardSection>
            <Skeleton className="h-8" />
          </CardSection>
        </Card>
      ))}
    </ul>
  );
}

export function AgentsPage() {
  const { bots, loading, error, refreshBots } = useBotContext();
  const { limitFor, planName } = useEntitlements();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const query = params.get('q') ?? '';
  const statusParam = params.get('status');
  const status: StatusFilter = isStatusFilter(statusParam) ? statusParam : 'all';
  const sortParam = params.get('sort');
  const sort: SortKey = isSortKey(sortParam) ? sortParam : 'status';
  const createOpen = params.get('new') === '1';

  /**
   * One statistics call per chatbot, on the same key Home uses, so arriving
   * from Home costs nothing and the two surfaces can never disagree about how
   * busy a chatbot has been. It is what makes "busiest first" and the
   * conversations figure possible without a second endpoint.
   */
  const statQueries = useQueries({
    queries: bots.map((bot) => ({
      queryKey: keys.analytics.dashboard(bot.id, null),
      queryFn: () => getDashboardStats(bot.id),
      staleTime: 60_000,
    })),
  });

  // Derived plainly rather than memoised: `useQueries` returns a fresh array
  // every render, so any memo keyed on it would recompute anyway, and the work
  // is a handful of comparisons over a list bounded by what the plan sells.
  const items: AgentListItem[] = bots.map((bot, index) => {
    const stats = statQueries[index];
    const total = stats?.data?.total_conversations;
    return {
      bot,
      health: agentHealth(bot),
      conversations: typeof total === 'number' && Number.isFinite(total) ? total : null,
      conversationsLoading: stats?.isPending ?? false,
    };
  });

  // The counts on the filter reflect the search, so the number on a segment is
  // always what clicking it would show.
  const searched = items.filter((item) => matchesQuery(item, query));
  const summary = summarizeAgents(searched);
  const visible = sortAgents(
    searched.filter((item) => matchesStatus(item, status)),
    sort,
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        // Replace, so typing a search does not bury the previous page under a
        // keystroke's worth of history entries.
        { replace: true },
      );
    },
    [setParams],
  );

  // Advisory only. Whether the next chatbot is free or needs its own plan is
  // decided by the server's 402, which the dialog turns into a plan picker —
  // this just lets the form say so before the user fills it in. Counted from
  // the live list rather than from cached entitlement usage, which is only
  // refetched on mount and would still read zero right after a create.
  const creationGate = resolveAgentCreationGate(bots.length, limitFor('bots'));

  const closeCreate = useCallback(() => setParam('new', null), [setParam]);

  const handleCreated = useCallback(
    async (bot: Bot) => {
      closeCreate();
      // Refresh before navigating, so the destination resolves the new chatbot
      // from context instead of briefly rendering "chatbot not found".
      await refreshBots();
      navigate(agentPath(bot.id, 'overview'));
    },
    [closeCreate, refreshBots, navigate],
  );

  const handleCheckoutComplete = useCallback(
    async (botId: number) => {
      closeCreate();
      await refreshBots();
      // A zero id means the webhook is still materialising the chatbot; the
      // list is the honest place to wait for it.
      navigate(botId > 0 ? agentPath(botId, 'overview') : '/chatbots');
    },
    [closeCreate, refreshBots, navigate],
  );

  const handleChanged = useCallback(() => {
    void refreshBots();
  }, [refreshBots]);

  const hasAgents = bots.length > 0;
  const showToolbar = hasAgents && !error;

  return (
    <Page width="wide">
      <PageHeader
        title="Chatbots"
        description="Every chatbot in this workspace, what it knows, and whether it is answering visitors."
        actions={
          <Button variant="primary" iconLeft={<Plus aria-hidden className="h-4 w-4" />} onClick={() => setParam('new', '1')}>
            New chatbot
          </Button>
        }
        toolbar={
          showToolbar ? (
            <Toolbar>
              <div className="w-full sm:w-72">
                <SearchField
                  label="Search chatbots"
                  placeholder="Search by name, website or key"
                  value={query}
                  onValueChange={(value) => setParam('q', value)}
                />
              </div>
              <SegmentedControl
                label="Chatbot status"
                value={status}
                onChange={(value) => setParam('status', value === 'all' ? null : value)}
                items={[
                  { value: 'all', label: 'All', count: summary.total },
                  { value: 'live', label: 'Live', count: summary.live },
                  { value: 'attention', label: 'Needs attention', count: summary.attention },
                  { value: 'training', label: 'Training', count: summary.training },
                ]}
              />
              <div className="w-52">
                <Select
                  aria-label="Sort chatbots"
                  size="sm"
                  value={sort}
                  onChange={(event) => setParam('sort', event.target.value)}
                  options={SORT_OPTIONS}
                />
              </div>
              {/* The result of a filter, announced. A count that only changes
                  visually tells a screen-reader user nothing about whether
                  their search did anything. */}
              <p role="status" aria-live="polite" className="ml-auto text-xs text-text-secondary">
                {visible.length === summary.total
                  ? `${formatNumber(summary.total)} chatbots`
                  : `${formatNumber(visible.length)} of ${formatNumber(summary.total)} chatbots`}
              </p>
            </Toolbar>
          ) : undefined
        }
      />

      {error ? (
        <Card>
          <ErrorState
            title="We could not load your chatbots"
            description={error.message || 'Something went wrong while loading this workspace.'}
            onRetry={() => void refreshBots()}
          />
        </Card>
      ) : (
        <Stack>
          {hasAgents || loading ? (
            <Card>
              <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
                <StatTile
                  label="Chatbots"
                  value={formatNumber(summary.total)}
                  period="In this workspace"
                  loading={loading}
                />
                <StatTile
                  label="Live"
                  value={formatNumber(summary.live)}
                  period="Trained and installed"
                  loading={loading}
                />
                <StatTile
                  label="Needs attention"
                  value={formatNumber(summary.attention)}
                  period="Not answering properly"
                  tone={summary.attention > 0 ? 'warning' : 'neutral'}
                  loading={loading}
                />
                <StatTile
                  label="Conversations"
                  value={summary.conversations === null ? undefined : formatNumber(summary.conversations)}
                  period="All time"
                  hint={
                    summary.conversations === null && !loading
                      ? 'No chatbot reported its numbers'
                      : undefined
                  }
                  loading={loading || statQueries.some((stats) => stats.isPending)}
                />
              </CardBody>
            </Card>
          ) : null}

          {loading && !hasAgents ? (
            <AgentsLoading />
          ) : !hasAgents ? (
            <Card>
              <EmptyState
                icon={BotIcon}
                title="No chatbots yet"
                description="Name one and point it at your website. It starts reading straight away, and you can talk to it while it learns."
                action={
                  <Button variant="primary" onClick={() => setParam('new', '1')}>
                    Create your first chatbot
                  </Button>
                }
              />
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={SearchX}
                title="No chatbots match"
                description="Nothing in this workspace matches that search and filter. Clear them to see all of your chatbots again."
                action={
                  <Link
                    to="/chatbots"
                    replace
                    className={buttonClass('secondary', 'sm')}
                  >
                    Clear search and filters
                  </Link>
                }
              />
            </Card>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((item) => (
                <AgentCard key={item.bot.id} item={item} onChanged={handleChanged} />
              ))}
            </ul>
          )}
        </Stack>
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={(open) => setParam('new', open ? '1' : null)}
        onCreated={handleCreated}
        onCheckoutComplete={handleCheckoutComplete}
        gate={creationGate}
        planName={planName}
      />
    </Page>
  );
}

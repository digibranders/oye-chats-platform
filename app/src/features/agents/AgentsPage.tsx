// The list's search, filter, sort and summary rules are pure functions, tested
// directly, so they are exported from the page that renders them rather than
// duplicated in a test. That is the only reason fast refresh's one-export rule
// is off here.
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Bot as BotIcon, Plus, SearchX } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LockedState,
  Page,
  PageHeader,
  SearchField,
  SegmentedControl,
  Toolbar,
  buttonClass,
  formatDate,
  formatNumber,
  type Column,
  type SortState,
} from '../../ui';
import { getDashboardStats } from '../../services/api';
import { keys } from '../../query/keys';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { agentPath } from '../../shell/nav';
import { AgentAvatar } from './AgentAvatar';
import { agentHealth, type AgentHealth } from '../home/agentHealth';
import type { Bot } from '../../types/domain';
import { AgentActionsMenu } from './AgentActionsMenu';
import { CreateAgentDialog } from './CreateAgentDialog';
import { resolveAgentCreationGate } from './agentLimit';
import { useTranslation } from '../../i18n/useTranslation';

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
 * **It is a table, not a card grid.** The grid it replaces spent ~310px a
 * chatbot on four stacked bands, so twenty chatbots were 2,200px of scroll to
 * answer a question a single fold should answer. A card grid earns its height
 * when the object's identity is *visual* — a deploy preview, a Figma file. A
 * chatbot's identity is a name plus six scalars, none of which is a picture, and
 * the card could not offer a column set: there was no way to sort by "last
 * trained" or to run an eye down a column of install states. The card's one real
 * advantage, room for the `CopyField`, went to the place the key is actually
 * used — Overview, Deploy, and a menu item here.
 *
 * Three things the page it replaces got wrong, closed here:
 *
 * Its loading skeleton drew a four-tile summary row that the loaded page never
 * rendered, so every visit flashed four tiles that then evaporated. The table
 * owns its own skeleton, in its own shape.
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

/**
 * What the list can be ordered by.
 *
 * One per sortable column, because the column heads are the sort control now.
 * `status` is the health ranking below, not an alphabetical sort of the word.
 */
export type SortColumn =
  | 'status'
  | 'name'
  | 'created'
  | 'conversations'
  | 'messages'
  | 'passages'
  | 'trained';

export interface AgentSort {
  key: SortColumn;
  direction: 'asc' | 'desc';
}

export const DEFAULT_SORT: AgentSort = { key: 'status', direction: 'asc' };

export interface AgentListItem {
  bot: Bot;
  health: AgentHealth;
  /**
   * All-time conversations, or `null` when that chatbot's statistics call has
   * not settled or failed. Never coerced to zero: a broken chatbot rendered as
   * a quiet one is the exact bug the workspace totals used to ship.
   */
  conversations: number | null;
  /** All-time messages, on the same terms as `conversations`. */
  messages: number | null;
  /** True while that call is still in flight, so a row can wait rather than
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
  /**
   * At least one chatbot has finished trying and reported nothing, so the sum
   * above is a partial one.
   *
   * Without this the toolbar stated a confident "1,240 conversations all time"
   * over a total that had silently dropped every chatbot whose statistics call
   * failed. Home has always disclosed the same case in the same words; a total
   * that means one thing on one page and another on the next is worse than
   * either. A chatbot whose call is still in flight is not counted here: it has
   * not failed, it has not answered yet, and the row says so itself.
   */
  incomplete: boolean;
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
  // Last: a paused chatbot is deliberately silent, so it is the one state
  // nobody needs shown before a chatbot that is failing by accident.
  paused: 6,
};

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

/** Roll a set of chatbots up into the figures shown on the toolbar. */
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
    incomplete: items.some((item) => item.conversations === null && !item.conversationsLoading),
  };
}

/** A figure that never reported sorts below one that reported zero. */
function byFigure(left: number | null, right: number | null): number {
  return (left ?? -1) - (right ?? -1);
}

/** An unreadable or absent date sorts below every readable one. */
function byDate(left: string | null | undefined, right: string | null | undefined): number {
  const a = Date.parse(left ?? '');
  const b = Date.parse(right ?? '');
  if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
  if (!Number.isFinite(a)) return -1;
  if (!Number.isFinite(b)) return 1;
  return a - b;
}

/**
 * Order the list. Every comparator falls back to the name so the result is
 * stable — an unstable sort makes a list appear to reshuffle itself on refetch.
 *
 * Ascending is the *natural* reading of each column: A→Z for a name, worst-first
 * for health, smallest-first for a figure, oldest-first for a date. Descending
 * negates that comparison and nothing else.
 */
export function sortAgents(
  items: readonly AgentListItem[],
  sort: AgentSort = DEFAULT_SORT,
): AgentListItem[] {
  const byName = (a: AgentListItem, b: AgentListItem): number =>
    (a.bot.name ?? '').localeCompare(b.bot.name ?? '', 'en', { sensitivity: 'base' });

  const primary = (a: AgentListItem, b: AgentListItem): number => {
    switch (sort.key) {
      case 'name':
        return byName(a, b);
      case 'created':
        return byDate(a.bot.created_at, b.bot.created_at);
      case 'conversations':
        return byFigure(a.conversations, b.conversations);
      case 'messages':
        return byFigure(a.messages, b.messages);
      case 'passages':
        return Number(a.bot.indexed_chunk_count ?? 0) - Number(b.bot.indexed_chunk_count ?? 0);
      case 'trained':
        return byDate(a.bot.crawl_completed_at, b.bot.crawl_completed_at);
      default:
        return HEALTH_RANK[a.health.state] - HEALTH_RANK[b.health.state];
    }
  };

  // Only the primary comparison is negated for a descending sort — the name
  // tiebreak stays A→Z in both directions. Negating it too (or reversing the
  // sorted array, which is the same thing) means descending is not the mirror
  // of ascending, and a set of tied rows appears to shuffle every time the sort
  // is flipped and flipped back.
  return [...items].sort((a, b) => {
    const result = primary(a, b);
    return (sort.direction === 'desc' ? -result : result) || byName(a, b);
  });
}

const SORT_COLUMNS: readonly SortColumn[] = [
  'status',
  'name',
  'created',
  'conversations',
  'messages',
  'passages',
  'trained',
];

/**
 * The sort, out of one URL parameter.
 *
 * `?sort=name` ascends, `?sort=-conversations` descends. The four words the
 * previous `Select` wrote — `status`, `name`, `newest`, `busiest` — are still
 * read, so a link somebody pasted into a support thread last week still opens
 * the order it promised.
 */
export function parseAgentSort(raw: string | null): AgentSort {
  if (!raw) return DEFAULT_SORT;
  if (raw === 'newest') return { key: 'created', direction: 'desc' };
  if (raw === 'busiest') return { key: 'conversations', direction: 'desc' };
  const descending = raw.startsWith('-');
  const key = descending ? raw.slice(1) : raw;
  return SORT_COLUMNS.includes(key as SortColumn)
    ? { key: key as SortColumn, direction: descending ? 'desc' : 'asc' }
    : DEFAULT_SORT;
}

export function agentSortParam(sort: AgentSort): string | null {
  if (sort.key === DEFAULT_SORT.key && sort.direction === DEFAULT_SORT.direction) return null;
  return sort.direction === 'desc' ? `-${sort.key}` : sort.key;
}

/**
 * `DataTable`'s sort state as this page's own.
 *
 * The table hands back `null` on the third press — its way of asking for the
 * caller's natural order, which here is the health ranking.
 */
function toAgentSort(state: SortState | null): AgentSort {
  if (!state) return DEFAULT_SORT;
  return SORT_COLUMNS.includes(state.key as SortColumn)
    ? { key: state.key as SortColumn, direction: state.direction }
    : DEFAULT_SORT;
}

function isStatusFilter(value: string | null): value is StatusFilter {
  return value === 'all' || value === 'live' || value === 'attention' || value === 'training';
}

export function AgentsPage() {
  const { t } = useTranslation();
  const { bots, loading, error, refreshBots } = useBotContext();
  const { limitFor, planName } = useEntitlements();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const query = params.get('q') ?? '';
  const statusParam = params.get('status');
  const status: StatusFilter = isStatusFilter(statusParam) ? statusParam : 'all';
  const sort = parseAgentSort(params.get('sort'));
  const createOpen = params.get('new') === '1';

  /**
   * One statistics call per chatbot, on the same key Home uses, so arriving
   * from Home costs nothing and the two surfaces can never disagree about how
   * busy a chatbot has been. It is what makes the conversation and message
   * columns sortable without a second endpoint.
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
    const conversations = stats?.data?.total_conversations;
    const messages = stats?.data?.total_messages;
    return {
      bot,
      health: agentHealth(bot),
      conversations:
        typeof conversations === 'number' && Number.isFinite(conversations) ? conversations : null,
      messages: typeof messages === 'number' && Number.isFinite(messages) ? messages : null,
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

  const columns = useMemo<Column<AgentListItem>[]>(
    () => [
      {
        key: 'name',
        header: t('agents.chatbot') || 'Chatbot',
        pinned: true,
        rowHeader: true,
        sortable: true,
        render: ({ bot }) => {
          const name = bot.name || `Chatbot ${bot.id}`;
          return (
            <span className="flex min-w-0 items-center gap-2.5">
              <AgentAvatar agent={bot} size="sm" />
              <span className="min-w-0">
                <Link
                  to={agentPath(bot.id, 'overview')}
                  className="block truncate font-medium text-text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
                >
                  {name}
                </Link>
                <span className="block truncate text-xs text-text-tertiary">
                  {bot.website || t('agents.noWebsiteSet') || 'No website set'}
                </span>
              </span>
            </span>
          );
        },
      },
      {
        key: 'status',
        header: t('agents.statusColumn') || 'Status',
        width: '12rem',
        sortable: true,
        render: ({ health }) => (
          <Badge tone={health.tone} dot>
            {health.label}
          </Badge>
        ),
      },
      {
        key: 'conversations',
        header: t('agents.conversations') || 'Conversations',
        type: 'number',
        width: '9rem',
        sortable: true,
        render: (item) =>
          item.conversations === null ? '—' : formatNumber(item.conversations),
      },
      {
        key: 'passages',
        header: t('agents.passages') || 'Passages',
        type: 'number',
        width: '8rem',
        secondary: true,
        sortable: true,
        render: ({ bot }) => {
          const indexed = Number(bot.indexed_chunk_count ?? 0);
          return indexed > 0 ? formatNumber(indexed) : '—';
        },
      },
      {
        key: 'trained',
        header: t('agents.lastTrained') || 'Last trained',
        type: 'number',
        width: '8rem',
        secondary: true,
        sortable: true,
        render: ({ bot }) =>
          bot.crawl_completed_at ? formatDate(bot.crawl_completed_at) : '—',
      },
      {
        key: 'installed',
        header: t('agents.installed') || 'Installed',
        width: '8rem',
        render: ({ bot }) => (
          <Badge tone={bot.widget_installed_at ? 'success' : 'neutral'} dot>
            {bot.widget_installed_at ? t('agents.installed') || 'Installed' : t('agents.notInstalled') || 'Not installed'}
          </Badge>
        ),
      },
      {
        // The whole set is sized so that eight columns still fit a 1280 laptop
        // without the card clipping its last badge: `secondary` only hides a
        // column below `md`, so between 768 and ~1400 this table was 148px
        // wider than the page and the install state — the one column people
        // come here to scan — was the half sliced off at the card's edge.
        key: 'actions',
        // The word is the widest thing in the column: "Actions" plus the cell's
        // own padding measures 79px against a 28px menu button, and those 15px
        // were the difference between this table fitting a 1280 laptop and
        // clipping the install badge beside it. A column of row menus names
        // itself; the label stays for assistive tech.
        header: <span className="sr-only">{t('agents.actions') || 'Actions'}</span>,
        align: 'right',
        width: '4rem',
        render: ({ bot }) => <AgentActionsMenu bot={bot} onChanged={handleChanged} />,
      },
    ],
    [handleChanged, t],
  );

  const hasAgents = bots.length > 0;
  const showToolbar = hasAgents && !error;

  return (
    <Page width="wide">
      <PageHeader
        title={t('agents.chatbots') || 'Chatbots'}
        titleVisuallyHidden
        actions={
          <Button variant="primary" iconLeft={<Plus aria-hidden />} onClick={() => setParam('new', '1')}>
            {t('agents.newChatbot') || 'New chatbot'}
          </Button>
        }
        toolbar={
          showToolbar ? (
            <Toolbar>
              {/* Search and filter are one group, so the count is the only thing
                  that can drop to a second line when the bar runs out of room. */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div className="w-full sm:w-72">
                  <SearchField
                    label={t('agents.searchChatbots') || 'Search chatbots'}
                    size="sm"
                    placeholder={t('agents.searchByNameWebsiteOr') || 'Search by name, website or key'}
                    value={query}
                    onValueChange={(value) => setParam('q', value)}
                  />
                </div>
                <SegmentedControl
                  label={t('agents.chatbotStatus') || 'Chatbot status'}
                  size="sm"
                  value={status}
                  onChange={(value) => setParam('status', value === 'all' ? null : value)}
                  items={[
                    { value: 'all', label: t('agents.all') || 'All', count: summary.total },
                    { value: 'live', label: t('agents.live') || 'Live', count: summary.live },
                    { value: 'attention', label: t('agents.needsAttention') || 'Needs attention', count: summary.attention },
                    { value: 'training', label: t('agents.training') || 'Training', count: summary.training },
                  ]}
                />
              </div>
              {/* The result of a filter, announced. A count that only changes
                  visually tells a screen-reader user nothing about whether
                  their search did anything. */}
              <div
                role="status"
                aria-live="polite"
                className="ml-auto text-xs text-text-secondary sm:text-right"
              >
                <p className="whitespace-nowrap">
                  {visible.length === summary.total
                    ? t('agents.nChatbots', { count: formatNumber(summary.total) }) ||
                      `${formatNumber(summary.total)} chatbots`
                    : t('agents.nOfTotalChatbots', {
                        count: formatNumber(visible.length),
                        total: formatNumber(summary.total),
                      }) || `${formatNumber(visible.length)} of ${formatNumber(summary.total)} chatbots`}
                  {summary.conversations === null
                    ? ''
                    : t('agents.conversationsAllTime', {
                        count: formatNumber(summary.conversations),
                      }) || ` · ${formatNumber(summary.conversations)} conversations all time`}
                </p>
                {/* The sum drops every chatbot whose statistics call failed, so
                    a partial total says it is partial. Deliberately the same
                    sentence Home shows for the identical case, from the same
                    dictionary entry: one disclosure, changed in one place. */}
                {summary.incomplete ? (
                  <p className="text-text-tertiary">
                    {t('home.someChatbotsDidNotReport')
                      || 'Some chatbots did not report, so these totals are incomplete.'}
                  </p>
                ) : null}
              </div>
            </Toolbar>
          ) : undefined
        }
      />

      {error?.status === 403 ? (
        // Defence in depth: the router already keeps a plain operator out of
        // `/chatbots`, and CLAUDE.md's own wording is that hiding a rail row can
        // never be the only line of defence. Four states, on every surface.
        <LockedState
          title={t('agents.theseChatbotsAreNotYours') || 'These chatbots are not yours to see'}
          description={t('agents.askAnOwnerOrAdmin') || 'Ask an owner or admin of this workspace for access.'}
        />
      ) : error ? (
        <Card>
          <ErrorState
            title={t('agents.weCouldNotLoadYour') || 'We could not load your chatbots'}
            description={error.message || t('agents.somethingWentWrongWhileLoading') || 'Something went wrong while loading this workspace.'}
            onRetry={() => void refreshBots()}
          />
        </Card>
      ) : !hasAgents && !loading ? (
        <Card>
          <EmptyState
            icon={BotIcon}
            title={t('agents.noChatbotsYet') || 'No chatbots yet'}
            description={t('agents.nameItPointItAt') || 'Name it, point it at your website, and it starts reading.'}
            action={
              <Button variant="primary" onClick={() => setParam('new', '1')}>
                {t('agents.createYourFirstChatbot') || 'Create your first chatbot'}
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(item) => String(item.bot.id)}
          caption={t('agents.everyChatbotInThisWorkspace') || 'Every chatbot in this workspace'}
          loading={loading}
          rowNoun="chatbot"
          sort={sort}
          onSortChange={(next) => setParam('sort', agentSortParam(toAgentSort(next)))}
          empty={
            <EmptyState
              icon={SearchX}
              title={t('agents.noChatbotsMatch') || 'No chatbots match'}
              description={t('agents.noChatbotMatchesThatSearch') || 'No chatbot matches that search and filter.'}
              action={
                <Link to="/chatbots" replace className={buttonClass('secondary', 'sm')}>
                  {t('agents.clearSearchAndFilters') || 'Clear search and filters'}
                </Link>
              }
            />
          }
        />
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

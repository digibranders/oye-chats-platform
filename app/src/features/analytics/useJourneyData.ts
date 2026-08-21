import { useQuery } from '@tanstack/react-query';
import {
  getJourneyConversionPaths,
  getJourneyPostChat,
  getJourneyPreChatSequences,
  getJourneySummary,
  getJourneyTopPages,
  type JourneyConversionPathsResponse,
  type JourneyPostChatResponse,
  type JourneyPreChatSequencesResponse,
  type JourneySummary,
  type JourneyTopPagesResponse,
} from '../../services/api';
import { keys } from '../../query/keys';
import { buildOutcomes, type FilterableOutcome, type JourneyOutcome } from './journeyModel';

/**
 * One fetch for the journey view.
 *
 * The hook it replaces was mounted three times — once per panel — and each
 * mount fired ten requests, kept its own fifteen-second interval, and added its
 * own `focus` and `visibilitychange` listeners. That is about thirty requests to
 * open the page and thirty more every fifteen seconds, for one month of one
 * chatbot's data. This is a single query, shared by every panel through the
 * cache, refreshed when the reader asks or when the window regains focus.
 *
 * It also asks for less. The old set pulled top pages four times over (all,
 * pre, chat, post) when one phase was rendered, and pulled the conversion paths
 * for all three outcomes on load when at most one is ever shown. Paths are a
 * separate query now, and it only runs once an outcome is selected.
 */

/**
 * Every list these endpoints return, guaranteed to be a list.
 *
 * The journey hooks were the only readers in `features/analytics` that handed
 * a raw API payload straight to a component: `analytics-types.ts` narrows the
 * dashboard, the ratings and the lead funnel — "so a missing key never crashes
 * a card and never silently renders as `0`" — `visitors.ts` narrows the visitor
 * list, and `leadModel.readFunnel` narrows the funnel. These four were typed
 * and trusted.
 *
 * A build of the API that answers 200 without `sequences` therefore did not
 * degrade the flow diagram, it threw `Cannot read properties of undefined
 * (reading 'map')` out of a `useMemo` and took the whole route to the page
 * error boundary — the one panel on this surface that cannot fail softly. The
 * shapes are declared optional here on purpose: the compiler believes the
 * `.d.ts`, and the thing being defended against is the response disagreeing
 * with it.
 */
export function list<T>(value: readonly T[] | undefined | null): T[] {
  return Array.isArray(value) ? [...value] : [];
}

export function safeSequences(raw: JourneyPreChatSequencesResponse): JourneyPreChatSequencesResponse {
  return { ...raw, sequences: list(raw?.sequences) };
}

export function safePostChat(raw: JourneyPostChatResponse): JourneyPostChatResponse {
  return {
    ...raw,
    first_hops: list(raw?.first_hops),
    all_hops: list(raw?.all_hops),
    full_sequences: list(raw?.full_sequences),
  };
}

export function safePaths(raw: JourneyConversionPathsResponse): JourneyConversionPathsResponse {
  return { ...raw, paths: list(raw?.paths) };
}

export function safeTopPages(raw: JourneyTopPagesResponse): JourneyTopPagesResponse {
  return { ...raw, rows: list(raw?.rows) };
}

/** Pages ranked in the influence panel. The endpoint caps at 100. */
const TOP_PAGES_LIMIT = 20;

/** Pre-chat routes shown in the flow. Enough to page through, not to prune. */
const SEQUENCE_LIMIT = 20;

/** Post-chat destinations. */
const POST_CHAT_LIMIT = 10;

/** Paths behind one outcome. */
const PATH_LIMIT = 10;

export interface JourneyData {
  summary: JourneySummary;
  /** Pages visitors were on before opening chat. */
  prePages: JourneyTopPagesResponse;
  postChat: JourneyPostChatResponse;
  preChatSequences: JourneyPreChatSequencesResponse;
  /** The outcome column, derived once so no two panels can disagree. */
  outcomes: JourneyOutcome[];
}

export function useJourneyData(botId: number | null, month: string) {
  const query = useQuery({
    queryKey: keys.analytics.journey(botId, month),
    enabled: botId != null,
    queryFn: async (): Promise<JourneyData> => {
      const id = botId as number;
      const [summary, prePages, postChat, preChatSequences] = await Promise.all([
        getJourneySummary(id, month),
        getJourneyTopPages(id, { period: month, phase: 'pre', limit: TOP_PAGES_LIMIT }),
        getJourneyPostChat(id, { period: month, limit: POST_CHAT_LIMIT }),
        getJourneyPreChatSequences(id, { period: month, limit: SEQUENCE_LIMIT }),
      ]);
      const safePost = safePostChat(postChat);
      return {
        summary,
        prePages: safeTopPages(prePages),
        postChat: safePost,
        preChatSequences: safeSequences(preChatSequences),
        outcomes: buildOutcomes({ summary, postChat: safePost }),
      };
    },
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The pre-chat routes attributed to one outcome.
 *
 * Keyed under the month's own key, so refreshing the surface invalidates this
 * with everything else rather than leaving a filtered view showing figures from
 * before the refresh.
 */
export function useJourneyPaths(
  botId: number | null,
  month: string,
  outcome: FilterableOutcome | null,
) {
  const query = useQuery({
    queryKey: [...keys.analytics.journey(botId, month), 'paths', outcome],
    enabled: botId != null && outcome != null,
    queryFn: (): Promise<JourneyConversionPathsResponse> =>
      getJourneyConversionPaths(botId as number, outcome as FilterableOutcome, {
        period: month,
        limit: PATH_LIMIT,
      }).then(safePaths),
  });

  return {
    paths: query.data ?? null,
    loading: query.isPending && outcome != null,
    error: query.error,
  };
}

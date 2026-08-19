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
      return {
        summary,
        prePages,
        postChat,
        preChatSequences,
        outcomes: buildOutcomes({ summary, postChat }),
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
      }),
  });

  return {
    paths: query.data ?? null,
    loading: query.isPending && outcome != null,
    error: query.error,
  };
}

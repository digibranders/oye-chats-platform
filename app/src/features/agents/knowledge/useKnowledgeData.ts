import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  getDocuments,
  getKnowledgeState,
  getUnansweredQuestions,
} from '../../../services/api';
import { keys } from '../../../query/keys';
import type { KnowledgeSource, KnowledgeState, UnansweredQuestion } from '../../../types/domain';
import { errorMessage, fetchRecrawlStatus, isForbidden, type RecrawlStatus } from './knowledge-api';
import type { GapWindow } from './knowledge-model';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * Knowledge's reads, one query per section.
 *
 * Each section fails on its own. The page this replaces ran the source list and
 * the knowledge-state probe through one loader behind one status, so a failing
 * banner probe could blank the table of everything the chatbot knows — and the
 * customer, reading an empty table, would conclude their chatbot had lost its
 * training.
 *
 * `forbidden` is a first-class outcome, not an error string. A seat that may
 * read this chatbot but not manage it, and a chatbot in another workspace, both
 * answer 403 — and "you cannot do this" needs a different screen from "this
 * did not load", which is the whole point of the four states.
 */

export interface Section<T> {
  data: T;
  loading: boolean;
  /** Null when the section is fine or forbidden — never both an error and a lock. */
  error: string | null;
  forbidden: boolean;
  retry: () => void;
}

function toSection<TRaw, TData>(
  query: UseQueryResult<TRaw>,
  select: (raw: TRaw) => TData,
  fallback: TData,
  fallbackMessage: string,
): Section<TData> {
  const forbidden = query.isError && isForbidden(query.error);
  return {
    data: query.data === undefined ? fallback : select(query.data),
    loading: query.isPending,
    error: query.isError && !forbidden ? errorMessage(query.error, fallbackMessage) : null,
    forbidden,
    retry: () => void query.refetch(),
  };
}

const NO_SOURCES: KnowledgeSource[] = [];
const NO_GAPS: UnansweredQuestion[] = [];

/** The cap on the gaps list. It is a nudge toward what to add next, not a report. */
export const GAPS_LIMIT = 20;

const EMPTY_STATE: KnowledgeState = { active_count: 0, inactive_count: 0, deactivated: false };

export interface KnowledgeData {
  sources: Section<KnowledgeSource[]>;
  /** Whether a lapse to Free deactivated this chatbot's stored knowledge. */
  state: Section<KnowledgeState>;
  gaps: Section<UnansweredQuestion[]>;
  autoRetrain: Section<RecrawlStatus | null>;
  /** Refetch everything this page shows. */
  refreshAll: () => void;
  refreshing: boolean;
}

export function useKnowledgeData(agentId: number | null, gapWindow: GapWindow): KnowledgeData {
  const client = useQueryClient();

  const sourcesQuery = useQuery({
    queryKey: keys.agents.knowledge(agentId ?? -1),
    queryFn: () => getDocuments(agentId ?? undefined),
    enabled: agentId !== null,
  });

  const stateQuery = useQuery({
    queryKey: keys.agents.knowledgeState(agentId ?? -1),
    queryFn: () => getKnowledgeState(agentId ?? undefined),
    enabled: agentId !== null,
  });

  const gapsQuery = useQuery({
    queryKey: keys.analytics.unanswered(agentId, gapWindow),
    queryFn: () =>
      getUnansweredQuestions(agentId ?? undefined, {
        limit: GAPS_LIMIT,
        ...(gapWindow === null ? {} : { days: gapWindow }),
      }),
    enabled: agentId !== null,
  });

  const autoRetrainQuery = useQuery({
    queryKey: keys.agents.recrawl(agentId ?? -1),
    queryFn: () => fetchRecrawlStatus(agentId as number),
    enabled: agentId !== null,
  });

  const refreshAll = useCallback(() => {
    if (agentId === null) return;
    void client.invalidateQueries({ queryKey: keys.agents.knowledge(agentId) });
    void client.invalidateQueries({ queryKey: keys.agents.knowledgeState(agentId) });
    void client.invalidateQueries({ queryKey: keys.agents.recrawl(agentId) });
    void client.invalidateQueries({ queryKey: ['analytics', 'unanswered', agentId] });
  }, [agentId, client]);

  return {
    sources: toSection(
      sourcesQuery,
      (rows) => rows ?? NO_SOURCES,
      NO_SOURCES,
      translateNow('agents.weCouldNotLoadWhat') || 'We could not load what this chatbot knows.',
    ),
    state: toSection(
      stateQuery,
      (raw) => raw ?? EMPTY_STATE,
      EMPTY_STATE,
      translateNow('agents.weCouldNotCheckWhether') || 'We could not check whether this knowledge is active.',
    ),
    gaps: toSection(
      gapsQuery,
      (rows) => rows ?? NO_GAPS,
      NO_GAPS,
      translateNow('agents.weCouldNotLoadThe3') || 'We could not load the questions your chatbot could not answer.',
    ),
    autoRetrain: toSection(
      autoRetrainQuery,
      (status) => status,
      null,
      translateNow('agents.weCouldNotLoadThe2') || 'We could not load the weekly retrain setting.',
    ),
    refreshAll,
    refreshing:
      sourcesQuery.isFetching ||
      stateQuery.isFetching ||
      gapsQuery.isFetching ||
      autoRetrainQuery.isFetching,
  };
}

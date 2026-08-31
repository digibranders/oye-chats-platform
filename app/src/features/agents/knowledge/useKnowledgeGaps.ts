import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getUnansweredQuestions } from '../../../services/api';
import { keys } from '../../../query/keys';
import type { UnansweredQuestion } from '../../../types/domain';
import { DEFAULT_GAP_WINDOW, type GapWindow } from './knowledge-model';
import { GAPS_LIMIT, toSection, type Section } from './useKnowledgeData';
import { t as translateNow } from '../../../i18n/i18n';

const NO_GAPS: UnansweredQuestion[] = [];

export interface KnowledgeGaps {
  section: Section<UnansweredQuestion[]>;
  window: GapWindow;
  setWindow: (next: GapWindow) => void;
}

/**
 * The "questions it could not answer" list on its own, so the card can live
 * outside the Knowledge page (it now sits on Experience ▸ UAQ) without pulling
 * in the rest of `useKnowledgeData`'s reads. Same query and window semantics —
 * `days` omitted means all time — just scoped to this one section.
 */
export function useKnowledgeGaps(agentId: number | null): KnowledgeGaps {
  const [window, setWindow] = useState<GapWindow>(DEFAULT_GAP_WINDOW);

  const query = useQuery({
    queryKey: keys.analytics.unanswered(agentId, window),
    queryFn: () =>
      getUnansweredQuestions(agentId ?? undefined, {
        limit: GAPS_LIMIT,
        ...(window === null ? {} : { days: window }),
      }),
    enabled: agentId !== null,
  });

  const section = toSection(
    query,
    (rows) => rows ?? NO_GAPS,
    NO_GAPS,
    translateNow('agents.weCouldNotLoadThe3') || 'We could not load the questions your chatbot could not answer.',
  );

  return { section, window, setWindow };
}

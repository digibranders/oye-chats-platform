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
    // `Array.isArray`, not `?? NO_GAPS`. The nullish check only covers null and
    // undefined, so any other shape — an error envelope served with a 200, an
    // HTML page from a proxy, an endpoint that starts returning `{items: []}` —
    // reached `DataTable`, which spreads its rows and threw `is not iterable`.
    // That is an uncaught render error, so it took out the WHOLE Experience
    // page through the error boundary: branding, messages, voice, language and
    // handoff all replaced by "Something went wrong" because one list endpoint
    // answered oddly. A section that cannot load must degrade to an empty
    // section, never to a dead page.
    (rows) => (Array.isArray(rows) ? rows : NO_GAPS),
    NO_GAPS,
    translateNow('agents.weCouldNotLoadThe3') || 'We could not load the questions your chatbot could not answer.',
  );

  return { section, window, setWindow };
}

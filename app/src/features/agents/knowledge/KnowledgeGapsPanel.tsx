import { type ReactElement, useEffect, useRef, useState } from 'react';
import { CheckCircle2, MessageCircleQuestion } from 'lucide-react';
import { EmptyState, SectionHeader, Skeleton } from '../../../design-system';
import { DataTable, type Column } from '../../../design-system/components/DataTable';
import { getUnansweredQuestions } from '../../../services/api';
import type { UnansweredQuestion } from '../../../types/domain';
import { formatRelativeDate } from './knowledge-utils';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

// The panel is a nudge, not a report: cap it to the highest-frequency gaps so
// it stays scannable and the "add content" action below stays the focus.
const GAPS_LIMIT = 20;

/**
 * KnowledgeGapsPanel - the "Knowledge gaps" section of the agent's Knowledge
 * tab. Surfaces the questions visitors asked that the AI could NOT answer from
 * its knowledge base (the RAG no-info pivot), ranked by frequency. It sits
 * directly above the add-content panel so the insight and its fix - upload a
 * document or crawl a page - live in the same place.
 *
 * Self-loading and scoped to the current agent; a stale fetch from a previous
 * agent can never write into another agent's view.
 */
export function KnowledgeGapsPanel({
  agentId,
  reloadToken = 0,
}: {
  agentId: number | null;
  reloadToken?: number;
}): ReactElement | null {
  const { t } = useTranslation();
  const [gaps, setGaps] = useState<UnansweredQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeAgentIdRef = useRef<number | null>(agentId);

  useEffect(() => {
    activeAgentIdRef.current = agentId;
    if (agentId == null) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      setGaps(null);
      setError(null);
      try {
        const data = await getUnansweredQuestions(agentId, { limit: GAPS_LIMIT });
        if (!cancelled && activeAgentIdRef.current === agentId) setGaps(data ?? []);
      } catch (err) {
        if (!cancelled && activeAgentIdRef.current === agentId) {
          setError(err instanceof Error ? err.message : translateNow('agents.couldntLoadKnowledgeGaps') || 'We couldn\'t load your knowledge gaps.');
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, reloadToken]);

  // Nothing to anchor to without an agent - render nothing rather than an empty shell.
  if (agentId == null) return null;

  const columns: Column<UnansweredQuestion>[] = [
    {
      key: 'question',
      header: 'Question',
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
            <MessageCircleQuestion size={15} aria-hidden="true" />
          </span>
          <span className="truncate text-[13px] font-medium text-[var(--ds-text)]" title={row.question}>
            {row.question}
          </span>
        </div>
      ),
    },
    {
      key: 'count',
      header: t('agents.timesAsked') || 'Times asked',
      width: '8rem',
      render: (row) => (
        <span className="tabular-nums font-medium text-[var(--ds-text)]">
          {row.count.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'last_asked',
      header: t('agents.lastAsked') || 'Last asked',
      width: '9rem',
      render: (row) => (
        <span className="text-[var(--ds-text-subtle)]">
          {row.last_asked ? formatRelativeDate(row.last_asked) : '-'}
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby="knowledge-gaps-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="knowledge-gaps-heading">{t('agents.knowledgeGaps') || 'Knowledge gaps'}</span>
        }
        description="Questions visitors asked that your AI couldn't answer. Add a matching website or document below to close them."
      />
      {error !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-danger)]"
        >
          {error}
        </div>
      ) : gaps === null ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : gaps.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={t('agents.noGapsRecordedYet') || 'No gaps recorded yet'}
          description="Questions your AI can't answer from its knowledge will show up here as visitors ask them - so you always know what to add next."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={gaps}
          rowKey={(row) => row.question}
          caption="Questions your AI couldn't answer from its knowledge"
        />
      )}
    </section>
  );
}

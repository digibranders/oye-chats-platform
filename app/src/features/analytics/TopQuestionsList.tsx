import { type ReactElement } from 'react';
import { formatNumber } from '../../i18n/formatters';
import { MessageSquare } from 'lucide-react';
import { EmptyState } from '../../design-system';
import { type TopQuestion } from '../../types/domain';
import { useTranslation } from '../../i18n/useTranslation';

interface TopQuestionsListProps {
  questions: TopQuestion[];
}

/**
 * TopQuestionsList - the most-asked visitor questions across every agent,
 * ranked, each with a proportional volume bar. Semantic ordered list so the
 * ranking is announced to screen readers.
 */
export function TopQuestionsList({ questions }: TopQuestionsListProps): ReactElement {
  const { t } = useTranslation();
  if (questions.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title={t('analytics.noQuestionsYet') || 'No questions yet'}
        description={t('analytics.onceVisitorsStartChattingWith') || 'Once visitors start chatting with your chatbots, their most common questions will surface here.'}
      />
    );
  }

  const max = Math.max(...questions.map((q) => q.count), 1);

  return (
    <ol className="flex flex-col gap-1">
      {questions.map((question, index) => {
        const width = Math.max((question.count / max) * 100, 6);
        return (
          <li
            key={`${question.question}-${index}`}
            className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--ds-bg-hover)]"
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[11px] font-semibold text-[var(--ds-text-muted)]"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-[var(--ds-text)]" title={question.question}>
                {question.question}
              </p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                <div
                  className="h-full rounded-full bg-[var(--ds-accent)]"
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
            <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--ds-accent-text)]">
              {formatNumber(question.count)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

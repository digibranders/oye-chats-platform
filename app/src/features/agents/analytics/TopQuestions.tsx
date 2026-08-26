import { type ReactElement } from 'react';
import { formatNumber } from '../../../i18n/formatters';
import { MessagesSquare } from 'lucide-react';
import { Card, EmptyState, SectionHeader, Skeleton } from '../../../design-system';
import { type TopQuestion } from '../../../types/domain';
import { useTranslation } from '../../../i18n/useTranslation';

interface TopQuestionsProps {
  questions: TopQuestion[];
  loading: boolean;
}

/**
 * TopQuestions - the most-asked visitor questions, ranked, with a proportional
 * bar per row. Surfaces what people actually come to the AI for, so the owner
 * knows which answers matter most.
 */
export function TopQuestions({ questions, loading }: TopQuestionsProps): ReactElement {
  const { t } = useTranslation();
  const max = questions.reduce((m, q) => Math.max(m, q.count), 0) || 1;

  return (
    <Card className="p-5">
      <SectionHeader
        title={t('agents.topQuestions') || 'Top questions'}
        description={t('agents.whatVisitorsAskYourAi') || 'What visitors ask your AI most often.'}
      />

      <div className="mt-5">
        {loading ? (
          <ul className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i}>
                <Skeleton className="h-11 w-full rounded-lg" />
              </li>
            ))}
          </ul>
        ) : questions.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title={t('agents.noRecurringQuestionsYet') || 'No recurring questions yet'}
            description={t('agents.onceVisitorsStartChattingThe') || 'Once visitors start chatting, the questions they ask most will appear here.'}
          />
        ) : (
          <ol className="space-y-1">
            {questions.map((item, index) => {
              const width = Math.max((item.count / max) * 100, 6);
              return (
                <li
                  key={`${item.question}-${index}`}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--ds-bg-hover)]"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[12px] font-semibold text-[var(--ds-text-muted)]"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                      {item.question}
                    </p>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                      <div
                        className="h-full rounded-full bg-[var(--ds-accent)]"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                    {formatNumber(item.count)}
                    <span className="sr-only"> times asked</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
}

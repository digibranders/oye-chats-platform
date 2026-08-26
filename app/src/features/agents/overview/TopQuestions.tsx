import { type ReactElement } from 'react';
import { MessageSquare } from 'lucide-react';
import { Card, EmptyState, cn } from '../../../design-system';
import { type TopQuestion } from '../../../types/domain';
import { useTranslation } from '../../../i18n/useTranslation';

export interface TopQuestionsProps {
  readonly questions: readonly TopQuestion[];
  readonly className?: string;
}

/**
 * TopQuestions - a ranked list of what visitors ask most, each with a volume
 * bar scaled to the top question. Answers "what are people actually coming to
 * my AI for?" at a glance. Shows an empty state before any traffic.
 */
export function TopQuestions({ questions, className }: TopQuestionsProps): ReactElement {
  const { t } = useTranslation();
  if (questions.length === 0) {
    return (
      <Card className={cn('p-6', className)}>
        <EmptyState
          icon={MessageSquare}
          title={t('agents.noQuestionsYet') || 'No questions yet'}
          description="The questions visitors ask your AI most often will show up here."
        />
      </Card>
    );
  }

  const maxCount = questions[0]?.count || 1;

  return (
    <Card className={cn('divide-y divide-[var(--ds-border)]', className)}>
      <ol>
        {questions.map((item, index) => {
          const barWidth = Math.max((item.count / maxCount) * 100, 4);
          return (
            <li
              key={`${item.question}-${index}`}
              className="flex items-center gap-4 px-5 py-3.5 first:pt-5 last:pb-5"
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[12px] font-bold text-[var(--ds-text-muted)]"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[13px] font-medium text-[var(--ds-text)]"
                  title={item.question}
                >
                  {item.question}
                </p>
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full bg-[var(--ds-accent)]"
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </div>
              <span className="shrink-0 text-[13px] font-semibold text-[var(--ds-text-muted)]">
                {item.count.toLocaleString()}
                <span className="ml-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
                  {item.count === 1 ? 'ask' : 'asks'}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

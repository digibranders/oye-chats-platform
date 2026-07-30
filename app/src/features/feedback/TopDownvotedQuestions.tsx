import { type ReactElement } from 'react';
import { Card, SectionHeader } from '../../design-system';
import { type TopDownvotedItem } from './feedback-helpers';

interface TopDownvotedQuestionsProps {
  items: TopDownvotedItem[];
  /** Called with the question text when a row is activated (click-to-jump). */
  onSelect: (question: string) => void;
}

/**
 * TopDownvotedQuestions - the most-repeated negatively-rated questions,
 * ranked, with a proportional bar. Clicking a row jumps to a matching item in
 * the list below (handled by the caller - see `FeedbackPanel`). Restyled port
 * of the legacy "Top downvoted questions" panel (`pages/Feedback.jsx:246-294`).
 */
export function TopDownvotedQuestions({ items, onSelect }: TopDownvotedQuestionsProps): ReactElement {
  const max = items[0]?.count ?? 0;

  return (
    <Card className="p-5">
      <SectionHeader
        title="Top downvoted questions"
        actions={
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Fix these first
          </span>
        }
      />
      <ul className="mt-4 space-y-2.5">
        {items.map((item) => {
          const width = max > 0 ? Math.max(6, Math.round((item.count / max) * 100)) : 0;
          return (
            <li key={item.question}>
              <button
                type="button"
                onClick={() => onSelect(item.question)}
                className="group w-full text-left focus-visible:outline-none"
              >
                <div className="flex items-center gap-3">
                  <p className="flex-1 truncate text-[13px] text-[var(--ds-text)] transition-colors group-hover:text-[var(--ds-accent-text)] group-focus-visible:text-[var(--ds-accent-text)]">
                    {item.question}
                  </p>
                  <span className="shrink-0 text-[12px] font-bold tabular-nums text-[var(--ds-danger)]">
                    {item.count}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                  <div
                    className="h-full rounded-full bg-[var(--ds-danger)] opacity-80 transition-all duration-500 group-hover:opacity-100"
                    style={{ width: `${width}%` }}
                  />
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

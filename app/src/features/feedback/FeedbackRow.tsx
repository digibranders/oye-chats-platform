import { type ReactElement } from 'react';
import { ChevronDown, ChevronUp, ThumbsDown, ThumbsUp } from 'lucide-react';
import { cn } from '../../design-system';
import { type FeedbackItem } from './types';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

interface FeedbackRowProps {
  item: FeedbackItem;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * FeedbackRow - one expandable feedback card: 👍/👎, truncated question,
 * formatted date, anonymized user; expands to the full Q&A and, for
 * negatives, a "Copy issue to clipboard" action. Restyled port of the legacy
 * card (`pages/Feedback.jsx:301-375`).
 */
export function FeedbackRow({ item, expanded, onToggle }: FeedbackRowProps): ReactElement {
  const isPositive = item.feedback === 1;

  function copyIssue(): void {
    const text = `Issue: Poor chatbot response\n\nQuestion: ${item.question}\n\nBot Answer: ${item.answer}\n\nFeedback: Negative (thumbs down)`;
    void navigator.clipboard.writeText(text);
  }

  return (
    <div
      data-feedback-id={item.message_id}
      className="overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] transition-shadow hover:shadow-[var(--ds-shadow-sm)]"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-4 p-4 text-left focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        <div
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg p-2',
            isPositive ? 'bg-[var(--ds-success-soft)]' : 'bg-[var(--ds-danger-soft)]',
          )}
        >
          {isPositive ? (
            <ThumbsUp size={16} className="fill-current text-[var(--ds-success)]" aria-hidden="true" />
          ) : (
            <ThumbsDown size={16} className="fill-current text-[var(--ds-danger)]" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">{item.question}</p>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-[11px] text-[var(--ds-text-subtle)]">
              {dateFormatter.format(new Date(item.created_at))}
            </span>
            <span className="text-[11px] font-medium text-[var(--ds-accent-text)]">{item.user}</span>
          </div>
        </div>
        {expanded ? (
          <ChevronUp size={16} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
        ) : (
          <ChevronDown size={16} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
        )}
      </button>

      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-in-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 px-4 pb-4">
            <div className="rounded-lg bg-[var(--ds-bg-sunken)] p-3">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
                User Question
              </p>
              <p className="text-[13px] text-[var(--ds-text)]">{item.question}</p>
            </div>
            <div className="rounded-lg bg-[var(--ds-bg-sunken)] p-3">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
                Bot Answer
              </p>
              <p className="text-[13px] text-[var(--ds-text-muted)]">{item.answer}</p>
            </div>
            {!isPositive && (
              <button
                type="button"
                onClick={copyIssue}
                className="w-full rounded-lg border border-[var(--ds-danger)]/30 px-3 py-1.5 text-[12px] font-medium text-[var(--ds-danger)] transition-colors hover:bg-[var(--ds-danger-soft)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              >
                Copy issue to clipboard
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

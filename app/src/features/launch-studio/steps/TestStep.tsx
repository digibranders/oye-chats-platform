import { useEffect, useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { Card } from '../../../design-system';
import { getSeedQuestions } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { usePreview } from '../preview/preview-context';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

const FALLBACK_QUESTIONS = [
  'What do you offer?',
  'How much does it cost?',
  'How do I get started?',
];

/**
 * Step 6 — Test Agent. Ask a question (a suggested one or your own in the
 * widget) and watch the real agent answer in the live preview on the right —
 * streamed via previewChatStream. The aha moment.
 */
export function TestStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { ask, preview } = usePreview();
  const [questions, setQuestions] = useState<string[]>(FALLBACK_QUESTIONS);

  useEffect(() => {
    if (!selectedBot) return;
    let cancelled = false;
    getSeedQuestions(selectedBot.id)
      .then((data) => {
        if (!cancelled && data.length > 0) setQuestions(data);
      })
      .catch(() => {
        /* keep fallbacks */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBot]);

  const hasAsked = preview.messages.length > 0 || preview.pending;

  return (
    <StepShell
      title="Try it yourself"
      description="Ask your agent anything — it answers from what it just learned. Watch the preview on the right."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
    >
      <div className="space-y-3">
        <p className="text-[13px] font-medium text-[var(--ds-text)]">Suggested questions</p>
        <div className="flex flex-wrap gap-2">
          {questions.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => ask(question)}
              disabled={preview.pending}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-1.5 text-[13px] text-[var(--ds-text)] transition-colors hover:border-[var(--ds-accent)] hover:text-[var(--ds-accent-text)] disabled:opacity-50"
            >
              {question}
              <ArrowRight size={13} />
            </button>
          ))}
        </div>
        <Card className="flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
            <Sparkles size={17} />
          </div>
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {hasAsked
              ? 'Nice! Type follow-ups directly in the widget preview.'
              : 'Pick a question or type your own in the widget preview to see a real answer.'}
          </p>
        </Card>
      </div>
    </StepShell>
  );
}

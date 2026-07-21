import { FileText, CheckCircle2 } from 'lucide-react';
import { Card, StatusBadge } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

// Placeholder learned-knowledge summary.
// TODO(phase-2b): populate from getDocuments (pages, chunk counts, coverage).
const SAMPLE_SOURCES = [
  { title: 'Homepage', detail: '12 sections learned' },
  { title: 'Pricing', detail: '8 sections learned' },
  { title: 'Features', detail: '15 sections learned' },
  { title: 'About', detail: '6 sections learned' },
];

/**
 * Step 4 — Review Knowledge. NEW step (the legacy flow had none — the user
 * never saw what the AI learned, only a page count). Builds confidence that
 * coverage is right before testing.
 */
export function ReviewStep(props: StepProps) {
  return (
    <StepShell
      title="What your AI learned"
      description="A quick look at your agent's knowledge before you test it."
      {...props}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[13px] text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={16} />
          <span className="font-medium">Trained on {SAMPLE_SOURCES.length} sources</span>
        </div>
        <Card className="divide-y divide-[var(--ds-border)]">
          {SAMPLE_SOURCES.map((source) => (
            <div key={source.title} className="flex items-center gap-3 px-4 py-3">
              <FileText size={16} className="shrink-0 text-[var(--ds-text-subtle)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">{source.title}</p>
                <p className="text-[12px] text-[var(--ds-text-subtle)]">{source.detail}</p>
              </div>
              <StatusBadge tone="success" dot>
                Ready
              </StatusBadge>
            </div>
          ))}
        </Card>
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          Missing something? You can add more sources anytime from your agent's Knowledge tab.
        </p>
      </div>
    </StepShell>
  );
}

import { FileText, Loader2 } from 'lucide-react';
import { Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

// Placeholder discovery results. TODO(phase-2b): replace with discoverCrawlUrls.
const SAMPLE_PAGES = ['/', '/pricing', '/features', '/about', '/contact', '/blog'];

/**
 * Step 2 — Analyze Website. Shows what we found (a distinct surface the legacy
 * flow lacked — it folded analyze into training with no visible result).
 */
export function AnalyzeStep(props: StepProps) {
  return (
    <StepShell
      title="Analyzing your website"
      description="We're mapping your pages so your AI learns the right things."
      {...props}
    >
      <Card className="divide-y divide-[var(--ds-border)]">
        <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 size={15} className="animate-spin text-[var(--ds-accent)]" />
          Discovering pages…
        </div>
        {SAMPLE_PAGES.map((page) => (
          <div key={page} className="flex items-center gap-3 px-4 py-2.5">
            <FileText size={15} className="shrink-0 text-[var(--ds-text-subtle)]" />
            <span className="truncate text-[13px] text-[var(--ds-text)]">{page}</span>
          </div>
        ))}
      </Card>
      <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
        Found {SAMPLE_PAGES.length} pages. You'll be able to fine-tune the selection before training.
      </p>
    </StepShell>
  );
}

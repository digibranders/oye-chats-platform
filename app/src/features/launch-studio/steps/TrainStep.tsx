import { FileText, Loader2 } from 'lucide-react';
import { Progress, Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

// Placeholder data. TODO(phase-2b): discoverCrawlUrls for the page list and drive
// the bar from CrawlContext (crawl.status / indexed count), latching "trained" on
// the first embedded page for a fast aha (audit §3).
const DISCOVERED_PAGES = ['/', '/pricing', '/features', '/about', '/contact', '/blog'];
const TRAINED = 4;

/**
 * Step 4 — AI Training. Analyzes the site (discovers pages) and trains on them
 * in one step (the master flow folds Analyze into Training).
 */
export function TrainStep(props: StepProps) {
  const percent = Math.round((TRAINED / DISCOVERED_PAGES.length) * 100);

  return (
    <StepShell
      title="Teaching your AI"
      description="We're reading each page and turning it into knowledge your agent can use."
      continueLabel="Continue"
      {...props}
    >
      <div className="space-y-4">
        <Card className="p-5">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="font-medium text-[var(--ds-text)]">Training in progress</span>
            <span className="text-[var(--ds-text-muted)]">
              {TRAINED} of {DISCOVERED_PAGES.length} pages
            </span>
          </div>
          <Progress value={percent} label="Training progress" />
          <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
            Your agent can already answer from the pages it has learned — no need to wait for the rest.
          </p>
        </Card>

        <Card className="divide-y divide-[var(--ds-border)]">
          <div className="flex items-center gap-2 px-4 py-2.5 text-[12px] font-medium text-[var(--ds-text-muted)]">
            <Loader2 size={14} className="animate-spin text-[var(--ds-accent)]" />
            Discovered {DISCOVERED_PAGES.length} pages
          </div>
          {DISCOVERED_PAGES.map((page) => (
            <div key={page} className="flex items-center gap-3 px-4 py-2">
              <FileText size={14} className="shrink-0 text-[var(--ds-text-subtle)]" />
              <span className="truncate text-[13px] text-[var(--ds-text)]">{page}</span>
            </div>
          ))}
        </Card>
      </div>
    </StepShell>
  );
}

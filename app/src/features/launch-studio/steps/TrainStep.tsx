import { Progress, Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 3 — Train AI. Explains progress while the content is embedded.
 * TODO(phase-2b): drive the bar from CrawlContext (crawl.status / indexed count)
 * and latch "trained" on the first embedded page for a fast aha (audit §3).
 */
export function TrainStep(props: StepProps) {
  const trainedPages = 4;
  const totalPages = 6;
  const percent = Math.round((trainedPages / totalPages) * 100);

  return (
    <StepShell
      title="Teaching your AI"
      description="We're reading each page and turning it into knowledge your agent can use."
      continueLabel="Continue"
      {...props}
    >
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between text-[13px]">
          <span className="font-medium text-[var(--ds-text)]">Training in progress</span>
          <span className="text-[var(--ds-text-muted)]">
            {trainedPages} of {totalPages} pages
          </span>
        </div>
        <Progress value={percent} />
        <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
          Your agent can already answer from the pages it has learned — no need to wait for the rest.
        </p>
      </Card>
    </StepShell>
  );
}

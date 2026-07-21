import { FileText, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Progress, Card } from '../../../design-system';
import { useCrawl } from '../../../context/CrawlContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 4 — AI Training. Analyzes the site and trains on it, showing LIVE crawl
 * progress from CrawlContext (started on the Connect step). The user can advance
 * as soon as the first page is learned (fast-path aha, audit §3).
 */
export function TrainStep(props: StepProps) {
  const { crawl } = useCrawl();

  const pages = crawl.urls;
  const done = crawl.pagesCrawled;
  const total = crawl.discoveredTotal ?? (pages.length || null);
  const isDone = crawl.status === 'done';
  const isFailed = crawl.status === 'failed' || crawl.status === 'no_content';
  const isStarting = !isDone && !isFailed && done === 0 && pages.length === 0;

  const percent = isDone
    ? 100
    : total && total > 0
      ? Math.min(99, Math.round((done / total) * 100))
      : done > 0
        ? 60
        : 8;

  const canContinue = done > 0 || isDone;

  return (
    <StepShell
      title="Teaching your AI"
      description="We're reading each page and turning it into knowledge your agent can use."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={canContinue}
    >
      {isFailed ? (
        <Card className="flex items-start gap-3 p-5">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
          <div>
            <p className="text-[13px] font-medium text-[var(--ds-text)]">
              {crawl.status === 'no_content'
                ? "We couldn't read any content from that site"
                : "We couldn't finish reading your site"}
            </p>
            <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">
              {crawl.error ||
                'Some sites render with JavaScript we can’t read. Go back and try a different URL, or upload documents instead.'}
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-2 flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 font-medium text-[var(--ds-text)]">
                {isDone ? (
                  <CheckCircle2 size={15} className="text-[var(--ds-success)]" />
                ) : (
                  <Loader2 size={15} className="animate-spin text-[var(--ds-accent)]" />
                )}
                {isDone ? 'Training complete' : isStarting ? 'Starting…' : 'Training in progress'}
              </span>
              <span className="text-[var(--ds-text-muted)]">
                {total ? `${done} of ${total} pages` : `${done} page${done === 1 ? '' : 's'}`}
              </span>
            </div>
            <Progress value={percent} label="Training progress" />
            <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
              {canContinue
                ? 'Your agent can already answer from the pages it has learned — no need to wait for the rest.'
                : 'Hang tight — this usually takes a few seconds.'}
            </p>
          </Card>

          {pages.length > 0 && (
            <Card className="divide-y divide-[var(--ds-border)]">
              <div className="px-4 py-2.5 text-[12px] font-medium text-[var(--ds-text-muted)]">
                Discovered {pages.length} page{pages.length === 1 ? '' : 's'}
              </div>
              {pages.slice(0, 8).map((page) => (
                <div key={page} className="flex items-center gap-3 px-4 py-2">
                  <FileText size={14} className="shrink-0 text-[var(--ds-text-subtle)]" />
                  <span className="truncate text-[13px] text-[var(--ds-text)]">{page}</span>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}
    </StepShell>
  );
}

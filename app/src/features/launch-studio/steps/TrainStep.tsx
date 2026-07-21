import { useEffect, useState } from 'react';
import { FileText, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Progress, Card } from '../../../design-system';
import { getDocuments } from '../../../services/api';
import { useCrawl } from '../../../context/CrawlContext';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 4 — AI Training. Shows LIVE progress: a real crawl (from CrawlContext,
 * started on Connect) or, on the upload path (no crawl), document ingestion
 * polled from getDocuments. The user can advance as soon as the first page /
 * document is learned (fast-path aha).
 */
export function TrainStep(props: StepProps) {
  const { crawl } = useCrawl();
  const { selectedBot } = useBotContext();
  const usingCrawl = crawl.status !== 'idle';

  // Documents path (upload): poll getDocuments until content appears.
  const [docCount, setDocCount] = useState<number | null>(null);
  useEffect(() => {
    if (usingCrawl || !selectedBot) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const docs = await getDocuments(selectedBot.id);
        if (cancelled) return;
        setDocCount(docs.length);
        if (docs.length === 0) timer = window.setTimeout(poll, 3000);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [usingCrawl, selectedBot]);

  // ── Crawl path ───────────────────────────────────────────────────
  if (usingCrawl) {
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

    return (
      <StepShell
        title="Teaching your AI"
        description="We're reading each page and turning it into knowledge your agent can use."
        onBack={props.onBack}
        onContinue={props.onContinue}
        isFirst={props.isFirst}
        isLast={props.isLast}
        canContinue={done > 0 || isDone}
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
                {done > 0 || isDone
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

  // ── Documents path (upload) ──────────────────────────────────────
  const hasDocs = (docCount ?? 0) > 0;
  return (
    <StepShell
      title="Teaching your AI"
      description="We're processing your documents and turning them into knowledge your agent can use."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={hasDocs}
    >
      <Card className="p-5">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text)]">
          {hasDocs ? (
            <CheckCircle2 size={15} className="text-[var(--ds-success)]" />
          ) : (
            <Loader2 size={15} className="animate-spin text-[var(--ds-accent)]" />
          )}
          {hasDocs ? `Trained on ${docCount} source${docCount === 1 ? '' : 's'}` : 'Processing documents…'}
        </div>
        <Progress value={hasDocs ? 100 : 20} label="Training progress" />
        <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
          {hasDocs
            ? 'Your agent has learned from your documents and is ready to test.'
            : 'This usually takes a few seconds.'}
        </p>
      </Card>
    </StepShell>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Progress, Well, formatNumber } from '../../../ui';
import { fetchIngestStatus } from './knowledge-api';
import { ingestProgress } from './knowledge-model';
import { useTranslation } from '../../../i18n/useTranslation';

export interface IngestionProgressProps {
  /** Names the work: "Reading your website", "Reading your documents". */
  title: string;
  /** The current page, the file count — whatever moves while it works. */
  detail?: string | null;
  /**
   * An ARQ job to poll, from `POST /ingest`. `null` means the API is running
   * without the worker, so ingestion happens inline and there is no job.
   */
  jobId?: string | null;
  /** For work with a known denominator, e.g. a crawl of a discovered page set. */
  done?: number;
  total?: number | null;
  unit?: string;
  /** Fired once, when a polled job reaches a terminal state. */
  onFinished?: () => void;
  /**
   * The control that stops this work, seated inside the well.
   *
   * It used to sit loose beneath the well in a `space-y-3` while a disabled
   * "Train on N pages" stayed in the card footer — two action zones on screen at
   * once, one live and one dead.
   */
  action?: ReactNode;
}

/**
 * Work in flight, carried by motion rather than by colour.
 *
 * This system has four status tones and deliberately no fifth for "in
 * progress": an amber "processing" pill would put a warning hue on the single
 * most ordinary thing this page does, and a blue one would collide with the
 * interactive accent. So a job whose size is unknown gets an indeterminate bar
 * — a travelling sliver that never implies a percentage it does not have — and
 * one whose size is known gets a real proportion.
 *
 * The polling half exists because `POST /ingest` returns 202 the moment the
 * files are on disk, while the reading, chunking and embedding that make a
 * document answerable all happen afterwards. A spinner tied to the HTTP request
 * finished long before the chatbot knew anything, which is why an upload has
 * never reported honest progress in this product.
 */
export function IngestionProgress({
  title,
  detail,
  jobId = null,
  done,
  total = null,
  unit = 'pages',
  onFinished,
  action,
}: IngestionProgressProps) {
  const { t } = useTranslation();
  const job = useQuery({
    // A literal key, not one from `query/keys.ts`: a job id is ephemeral and
    // owned entirely by this component, and the shared registry is for keys two
    // surfaces have to agree on.
    queryKey: ['ingest', 'status', jobId],
    queryFn: () => fetchIngestStatus(jobId as string),
    enabled: jobId !== null,
    // Ingestion of a normal document lands inside a minute; two seconds is
    // often enough to see it move and cheap enough not to matter.
    refetchInterval: (query) => (ingestProgress(readStatus(query.state.data)).active ? 2000 : false),
  });

  const status = jobId === null ? null : readStatus(job.data);
  const phase = ingestProgress(status);
  const settled = jobId !== null && !job.isPending && !phase.active;

  // Once, on the transition. `onFinished` usually invalidates queries, and a
  // caller whose callback identity changes each render would otherwise be
  // refetching in a loop for as long as this stayed mounted.
  const announced = useRef(false);
  useEffect(() => {
    if (!settled || phase.phase === 'failed' || announced.current) return;
    announced.current = true;
    onFinished?.();
  }, [settled, phase.phase, onFinished]);

  if (phase.phase === 'failed') {
    return (
      <Alert tone="danger" live title={t('agents.weCouldNotReadThat') || 'We could not read that document'}>
        Nothing was added to this chatbot&apos;s knowledge. A scanned PDF with no text layer is the
        usual cause — try a text-based copy, or paste the content into a plain text file.
      </Alert>
    );
  }

  if (phase.phase === 'done') {
    return (
      <Alert tone="success" live>
        {t('agents.doneThisChatbotCanAnswer') || 'Done. This chatbot can answer from it now.'}
      </Alert>
    );
  }

  const percent =
    total !== null && total > 0 && done !== undefined
      ? Math.min(99, Math.round((done / total) * 100))
      : null;

  return (
    <Well>
      {/* The label is shown, which is `Progress`'s default. This is the one
          place on the page where something is happening that the customer
          cannot otherwise see, and naming it in the open — with the percentage
          beside it when there is one — is worth more than the two lines of
          space it costs. */}
      <Progress value={percent} label={title} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          {detail ? <p className="min-w-0 truncate text-xs text-text-tertiary">{detail}</p> : null}
          {done !== undefined ? (
            <p className="figure text-xs text-text-secondary">
              {formatNumber(done)}
              {total !== null && total > 0 ? ` of ${formatNumber(total)}` : ''} {unit}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {phase.phase === 'unknown' && done === undefined ? (
        <p className="mt-2 text-xs text-text-secondary">
          {t('agents.thisUsuallyTakesAMinute') || 'This usually takes a minute. You can leave this page; it carries on in the background.'}
        </p>
      ) : null}
    </Well>
  );
}

function readStatus(data: unknown): string | null {
  if (data === null || data === undefined || typeof data !== 'object') return null;
  const status = (data as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

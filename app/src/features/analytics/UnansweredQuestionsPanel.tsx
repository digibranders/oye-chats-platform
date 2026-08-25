import { type ReactElement, useEffect, useRef, useState } from 'react';
import { CheckCircle2, MessageCircleQuestion, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  SectionHeader,
  SegmentedControl,
  Skeleton,
} from '../../design-system';
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { getUnansweredQuestions } from '../../services/api';
import type { UnansweredQuestion } from '../../types/domain';

const LIMIT = 50;

const DAY_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;

type DayRange = (typeof DAY_OPTIONS)[number]['value'];

function formatRelativeDate(iso?: string | null): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const COLUMNS: Column<UnansweredQuestion>[] = [
  {
    key: 'question',
    header: 'Question',
    render: (row) => (
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <MessageCircleQuestion size={15} aria-hidden="true" />
        </span>
        <span
          className="truncate text-[13px] font-medium text-[var(--ds-text)]"
          title={row.question}
        >
          {row.question}
        </span>
      </div>
    ),
  },
  {
    key: 'count',
    header: 'Times asked',
    width: '8rem',
    render: (row) => (
      <span className="tabular-nums font-medium text-[var(--ds-text)]">
        {row.count.toLocaleString()}
      </span>
    ),
  },
  {
    key: 'last_asked',
    header: 'Last asked',
    width: '9rem',
    render: (row) => (
      <span className="text-[var(--ds-text-subtle)]">
        {formatRelativeDate(row.last_asked)}
      </span>
    ),
  },
];

export function UnansweredQuestionsPanel({
  botId,
}: {
  botId: number | null;
}): ReactElement {
  const [gaps, setGaps] = useState<UnansweredQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DayRange>('30');
  const [reloadToken, setReloadToken] = useState(0);
  const activeBotRef = useRef<number | null>(botId);

  useEffect(() => {
    activeBotRef.current = botId;
    let cancelled = false;
    const run = async (): Promise<void> => {
      setGaps(null);
      setError(null);
      try {
        const opts: { limit: number; days?: number } = { limit: LIMIT };
        if (range !== 'all') opts.days = Number(range);
        const data = await getUnansweredQuestions(botId, opts);
        if (!cancelled && activeBotRef.current === botId) setGaps(data ?? []);
      } catch (err) {
        if (!cancelled && activeBotRef.current === botId) {
          setError(
            err instanceof Error ? err.message : 'Failed to load unanswered questions.',
          );
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [botId, range, reloadToken]);

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title="Unanswered questions"
          description="Questions visitors asked that your AI couldn't answer from its knowledge base, ranked by frequency."
          actions={
            <div className="flex items-center gap-2">
              <SegmentedControl
                options={DAY_OPTIONS}
                value={range}
                onChange={(v) => setRange(v as DayRange)}
                ariaLabel="Time range for unanswered questions"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadToken((t) => t + 1)}
                disabled={gaps === null && error === null}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Refresh
              </Button>
            </div>
          }
        />
      </CardHeader>
      <CardContent className="pt-0">
        {error !== null ? (
          <EmptyState
            icon={TriangleAlert}
            title="Couldn't load unanswered questions"
            description={error}
            action={
              <Button variant="primary" onClick={() => setReloadToken((t) => t + 1)}>
                <RefreshCw size={16} aria-hidden="true" />
                Try again
              </Button>
            }
          />
        ) : gaps === null ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : gaps.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No unanswered questions"
            description="Your AI is answering everything visitors throw at it. Questions it can't answer will appear here so you know what content to add."
          />
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={gaps}
            rowKey={(row) => row.question}
            caption="Questions your AI couldn't answer from its knowledge base"
          />
        )}
      </CardContent>
    </Card>
  );
}

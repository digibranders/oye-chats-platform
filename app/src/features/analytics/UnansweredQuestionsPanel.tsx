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
import { useTranslation } from '../../i18n/useTranslation';
import { formatNumber } from '../../i18n/formatters';
import { t as translateNow } from '../../i18n/i18n';

const LIMIT = 50;

// @i18n-exempt: resolved at the render site from the option value
// (`analytics.range.<value>`); the labels here are that lookup's fallback.
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

// Module constant: evaluated at import, before a locale exists. Headers are
// resolved at the render site from the column key; the English here is the
// inline fallback.
// @i18n-exempt: resolved at the render site from the column key
// (`analytics.column.<key>`); the headers here are that lookup's fallback.
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
        {formatNumber(row.count)}
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
  const { t } = useTranslation();
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
        const data = await getUnansweredQuestions(botId ?? undefined, opts);
        if (!cancelled && activeBotRef.current === botId) setGaps(data ?? []);
      } catch (err) {
        if (!cancelled && activeBotRef.current === botId) {
          setError(
            err instanceof Error ? err.message : translateNow('analytics.failedToLoadUnansweredQuestions') || 'Failed to load unanswered questions.',
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
          title={t('analytics.unansweredQuestions') || 'Unanswered questions'}
          description={t('analytics.questionsVisitorsAskedThatYour') || 'Questions visitors asked that your AI couldn\'t answer from its knowledge base, ranked by frequency.'}
          actions={
            <div className="flex items-center gap-2">
              <SegmentedControl
                options={DAY_OPTIONS}
                value={range}
                onChange={(v) => setRange(v as DayRange)}
                ariaLabel={t('analytics.timeRangeForUnansweredQuestions') || 'Time range for unanswered questions'}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadToken((t) => t + 1)}
                disabled={gaps === null && error === null}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {t('analytics.refresh') || 'Refresh'}
              </Button>
            </div>
          }
        />
      </CardHeader>
      <CardContent className="pt-0">
        {error !== null ? (
          <EmptyState
            icon={TriangleAlert}
            title={t('analytics.couldntLoadUnansweredQuestions') || 'Couldn\'t load unanswered questions'}
            description={error}
            action={
              <Button variant="primary" onClick={() => setReloadToken((t) => t + 1)}>
                <RefreshCw size={16} aria-hidden="true" />
                {t('analytics.tryAgain') || 'Try again'}
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
            title={t('analytics.noUnansweredQuestions') || 'No unanswered questions'}
            description={t('analytics.yourAiIsAnsweringEverything') || 'Your AI is answering everything visitors throw at it. Questions it can\'t answer will appear here so you know what content to add.'}
          />
        ) : (
          <DataTable
            columns={COLUMNS.map((col) => ({
              ...col,
              header: t(`analytics.column.${col.key}`) || col.header,
            }))}
            rows={gaps}
            rowKey={(row) => row.question}
            caption={t('analytics.questionsYourAiCouldntAnswer') || 'Questions your AI couldn\'t answer from its knowledge base'}
          />
        )}
      </CardContent>
    </Card>
  );
}

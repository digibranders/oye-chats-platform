import { useCallback, useEffect, useState, memo } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  CardSection,
  EmptyState,
  ErrorState,
  LoadingRows,
  RankedBars,
  SegmentedControl,
  formatNumber,
} from '../../../ui';
import { getQualificationFunnel } from '../../../services/api';
import { type FunnelStage, parseFunnel } from './funnel';

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;

type Period = (typeof PERIODS)[number]['value'];

/**
 * The reading itself, keyed by request.
 *
 * Split out so the parent can remount it with `key={agentId:period:reload}`
 * rather than clearing its own state during render. The old version wrote
 * `setStages(null)` in the render body behind a request comparison; it worked,
 * but a render-phase side effect is the sort of thing the next reader has to
 * reason about under StrictMode double-invocation, and a key achieves the same
 * paint for free.
 */
function FunnelBody({
  agentId,
  period,
  retry,
}: {
  agentId: number;
  period: Period;
  retry: () => void;
}) {
  const [stages, setStages] = useState<FunnelStage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await getQualificationFunnel(agentId, period);
        if (cancelled) return;
        setStages(parseFunnel(payload));
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : 'We could not load the qualification funnel.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, period]);

  const total = stages?.[0]?.count ?? 0;

  if (error) {
    return (
      <ErrorState size="panel" title="We could not load the funnel" description={error} onRetry={retry} />
    );
  }
  if (stages === null) return <LoadingRows rows={6} />;
  if (total === 0) {
    return <EmptyState size="panel" title="Nothing scored in this period" />;
  }

  return (
    <RankedBars
      label="Qualification funnel"
      max={total}
      items={stages.map((stage) => ({
        id: stage.key,
        label: stage.label,
        value: stage.count,
        display: formatNumber(stage.count),
        meta: total > 0 ? `${Math.round((stage.count / total) * 100)}%` : undefined,
      }))}
    />
  );
}

/**
 * What the current thresholds have actually produced.
 *
 * Every other panel on this page is a promise; this one is the receipt — which
 * is why it sits in the right column, beside the thresholds it grades, rather
 * than 2,500px below them at the bottom of the page. Tuning an MQL threshold
 * without seeing how many conversations cleared it is guessing, and
 * `GET /analytics/qualification-funnel` has supported a period since it was
 * written without anything in the console ever passing one.
 */
function FunnelSectionInner({ agentId }: { agentId: number }) {
  const [period, setPeriod] = useState<Period>('30d');
  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return (
    <Card>
      <CardHeader
        title="What this scoring has produced"
        titleAs="h2"
        description="How far conversations actually got under these thresholds."
      />
      <CardSection>
        <SegmentedControl
          label="Reporting period"
          size="sm"
          fill
          value={period}
          onChange={(next) => setPeriod(next as Period)}
          items={PERIODS.map((option) => ({ value: option.value, label: option.label }))}
        />
      </CardSection>
      <CardBody>
        <FunnelBody key={`${agentId}:${period}:${reloadKey}`} agentId={agentId} period={period} retry={retry} />
      </CardBody>
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const FunnelSection = memo(FunnelSectionInner);

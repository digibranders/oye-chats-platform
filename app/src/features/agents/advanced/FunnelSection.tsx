import { useCallback, useEffect, useState, memo } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
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
 * What the current thresholds have actually produced.
 *
 * Every other panel on this page is a promise; this one is the receipt. Tuning
 * an MQL threshold without seeing how many conversations cleared it is guessing,
 * and `GET /analytics/qualification-funnel` has supported a period since it was
 * written without anything in the console ever passing one.
 */
function FunnelSectionInner({ agentId }: { agentId: number }) {
  const [period, setPeriod] = useState<Period>('30d');
  const [stages, setStages] = useState<FunnelStage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Clear during render rather than inside the effect, so changing the period
  // shows the skeleton on the same paint instead of leaving last period's bars
  // on screen under the new label for a frame.
  const request = `${agentId}:${period}:${reloadKey}`;
  const [loadedRequest, setLoadedRequest] = useState(request);
  if (request !== loadedRequest) {
    setLoadedRequest(request);
    setStages(null);
    setError(null);
  }

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
  }, [agentId, period, reloadKey]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);
  const total = stages?.[0]?.count ?? 0;

  return (
    <Card>
      <CardHeader
        title="What this scoring has produced"
        titleAs="h2"
        description="How far conversations actually got under the thresholds above."
        actions={
          <SegmentedControl
            label="Reporting period"
            size="sm"
            value={period}
            onChange={(next) => setPeriod(next as Period)}
            items={PERIODS.map((option) => ({ value: option.value, label: option.label }))}
          />
        }
      />
      <CardBody>
        {error ? (
          <ErrorState
            compact
            title="We could not load the funnel"
            description={error}
            onRetry={retry}
          />
        ) : stages === null ? (
          <LoadingRows rows={6} />
        ) : total === 0 ? (
          <EmptyState
            compact
            title="No conversations in this period"
            description="Nothing has been scored yet, so there is nothing to compare your thresholds against. Widen the period, or come back once visitors have used the chatbot."
          />
        ) : (
          <RankedBars
            label="Qualification funnel"
            tone="ink"
            max={total}
            items={stages.map((stage) => ({
              id: stage.key,
              label: stage.label,
              value: stage.count,
              display: formatNumber(stage.count),
              meta:
                total > 0 ? `${Math.round((stage.count / total) * 100)}% of conversations` : undefined,
            }))}
          />
        )}
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

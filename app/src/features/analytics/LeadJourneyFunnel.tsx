import { type ReactElement, useEffect, useState } from 'react';
import { cn } from '../../design-system';
import { getQualificationFunnel } from '../../services/api';
import { type FunnelStageView, funnelHasData, readFunnel } from '../leads/leadModel';
import { useTranslation } from '../../i18n/useTranslation';

/** Reporting windows the funnel selector offers (mirrors the backend params). */
type FunnelPeriod = '7d' | '30d' | '90d' | 'all';

// @i18n-exempt: both fields are resolved at the render site from the period
// value - the label as `analytics.range.<value>` on the button, the note as
// `analytics.rangeNote.<value>` in the description below. The English here is
// those lookups' fallback.
const FUNNEL_PERIOD_OPTIONS: ReadonlyArray<{ value: FunnelPeriod; label: string; note: string }> = [
  { value: '7d', label: '7 days', note: 'last 7 days' },
  { value: '30d', label: '30 days', note: 'last 30 days' },
  { value: '90d', label: '90 days', note: 'last 90 days' },
  { value: 'all', label: 'All time', note: 'all time' },
];

const DEFAULT_FUNNEL_PERIOD: FunnelPeriod = '30d';

/** Left-to-right funnel summary: each qualification stage with its drop-off. */
function FunnelSummary({ stages }: { stages: FunnelStageView[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <ol className="space-y-2.5">
      {stages.map((stage) => (
        <li key={stage.key} className="flex items-center gap-3">
          <div className="w-32 shrink-0">
            <p className="text-[13px] font-medium text-[var(--ds-text)]">
              {t(`analytics.funnelStage.${stage.key ?? stage.label}`) || stage.label}
            </p>
            <p className="text-[11px] text-[var(--ds-text-subtle)]">{stage.sublabel}</p>
          </div>
          <div className="relative h-7 flex-1">
            <div className="absolute inset-0 rounded-md bg-[var(--ds-bg-sunken)]" />
            {stage.count > 0 && (
              <div
                className="absolute inset-y-0 left-0 flex items-center rounded-md bg-[var(--ds-accent-soft)] px-2"
                style={{ width: `${stage.widthPct}%` }}
              >
                <span className="text-[12px] font-semibold tabular-nums text-[var(--ds-accent-text)]">
                  {stage.count.toLocaleString()}
                </span>
              </div>
            )}
          </div>
          <div className="w-16 shrink-0 text-right">
            {stage.conversionFromPrev !== null ? (
              <span className="text-[12px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                {stage.conversionFromPrev.toFixed(0)}%
              </span>
            ) : (
              <span className="text-[11px] uppercase tracking-wide text-[var(--ds-text-subtle)]">
                {t('analytics.top') || 'Top'}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface LeadJourneyFunnelProps {
  /** The agent whose funnel to show; `null`/`undefined` renders the empty state. */
  botId?: number | null;
}

/**
 * LeadJourneyFunnel - "How visitors become buyers": the visitor → booked-call
 * funnel for one agent, with a selectable reporting window. Self-contained - it
 * owns its period state and fetches the qualification funnel directly - so any
 * page can drop it in with just a `botId`. A failed fetch degrades to the empty
 * state; the funnel must never break the page hosting it.
 */
export function LeadJourneyFunnel({ botId }: LeadJourneyFunnelProps): ReactElement {
  const { t } = useTranslation();
  const [funnelPeriod, setFunnelPeriod] = useState<FunnelPeriod>(DEFAULT_FUNNEL_PERIOD);
  const [funnel, setFunnel] = useState<FunnelStageView[]>([]);

  useEffect(() => {
    // No agent in scope: nothing to fetch; the funnel stays at its empty value
    // and the empty state renders. (No synchronous setState in the effect body.)
    if (botId == null) return;

    let cancelled = false;
    void (async () => {
      try {
        const raw = await getQualificationFunnel(botId, funnelPeriod);
        if (!cancelled) setFunnel(readFunnel(raw));
      } catch {
        if (!cancelled) setFunnel([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId, funnelPeriod]);

  const activePeriod =
    FUNNEL_PERIOD_OPTIONS.find((option) => option.value === funnelPeriod) ?? FUNNEL_PERIOD_OPTIONS[1];

  const periodNote = t(`analytics.rangeNote.${activePeriod.value}`) || activePeriod.note;

  return (
    <section className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--ds-text)]">
            {t('analytics.howVisitorsBecomeBuyers') || 'How visitors become buyers'}
          </h2>
          <p className="text-[12px] text-[var(--ds-text-muted)]">
            {t('analytics.funnelDescription', { period: periodNote }) ||
              `Where people drop off on the way from a first visit to a booked call · ${periodNote}`}
          </p>
        </div>
        <div
          role="group"
          aria-label={t('analytics.funnelTimeRange') || 'Funnel time range'}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--ds-bg-sunken)] p-0.5"
        >
          {FUNNEL_PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={funnelPeriod === option.value}
              onClick={() => setFunnelPeriod(option.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                funnelPeriod === option.value
                  ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                  : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
              )}
            >
              {t(`analytics.range.${option.value}`) || option.label}
            </button>
          ))}
        </div>
      </div>
      {funnelHasData(funnel) ? (
        <FunnelSummary stages={funnel} />
      ) : (
        <p className="rounded-lg border border-dashed border-[var(--ds-border)] px-4 py-6 text-center text-[13px] text-[var(--ds-text-muted)]">
          {t('analytics.noFunnelActivityInThis') || 'No funnel activity in this period yet.'}
        </p>
      )}
    </section>
  );
}

export default LeadJourneyFunnel;

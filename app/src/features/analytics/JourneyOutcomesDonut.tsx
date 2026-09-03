import { useMemo } from 'react';
import type { JourneyOutcome } from './journeyModel';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Journey outcomes, as proportions rather than as a partition.
 *
 * This was a donut, and a donut is a claim: that the buckets are mutually
 * exclusive and together account for the whole. These are neither.
 * `summary_counts` in `api/app/services/journey_analytics_service.py`
 * increments `conversion_counts` once **per event type** a session produced, so
 * the ordinary out-of-hours flow, ask for a person, get nobody, leave a
 * message, lands in `handoff_requested` AND `offline_message_sent`. Drawing
 * those end to end around one circumference made later arcs overpaint earlier
 * ones, and the screen-reader shares summed past 100%.
 *
 * So each outcome gets its own bar, measured against the same denominator
 * (`sessions_with_journey`, arriving here as `total`), and the overlap is
 * stated in one line instead of being silently drawn as an impossibility. The
 * arithmetic that stays true is per row: "N of the M tracked conversations did
 * this". Nothing here asserts the rows add up, because they do not.
 *
 * `kept_browsing` and `exit` genuinely are exclusive of the conversions and of
 * each other, and they still read correctly as bars. Splitting the display into
 * "exclusive" and "overlapping" halves was considered and dropped: it teaches
 * the reader a distinction they cannot act on, and the note covers it.
 */

const TONE_FOR: Record<string, string> = {
  meeting_booked: '#10b981',
  kept_browsing: '#3b82f6',
  handoff_requested: '#f97316',
  offline_message_sent: '#a855f7',
  exit: '#ef4444',
};

export interface JourneyOutcomesDonutProps {
  outcomes: readonly JourneyOutcome[];
  /** Tracked journeys in the window: the denominator every bar is read against. */
  total: number;
}

export function JourneyOutcomesDonut({ outcomes = [], total = 0 }: JourneyOutcomesDonutProps) {
  const { t } = useTranslation();
  const safeTotal = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 0;

  const rows = useMemo(
    () =>
      (outcomes ?? []).map((outcome) => {
        const sessions = outcome?.sessions ?? 0;
        // Clamped, and it should never bind: a bucket cannot exceed the
        // journeys it was counted from. If one ever does, a bar that stops at
        // full is a smaller lie than one that runs off the row.
        const percent = safeTotal > 0 ? Math.min((sessions / safeTotal) * 100, 100) : 0;
        return { ...outcome, sessions, percent };
      }),
    [outcomes, safeTotal],
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        {/* No count-up. The donut animated its centre figure over 1.4s, which
            is 1.4s in which the headline number on an analytics card is wrong,
            and it is the number every bar below is read against. */}
        <span className="figure font-semibold text-text-primary">
          {safeTotal.toLocaleString()}
        </span>{' '}
        {safeTotal === 1 ? 'tracked conversation' : 'tracked conversations'}
      </p>

      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: TONE_FOR[row.id] ?? 'var(--color-text-tertiary)' }}
                />
                <span className="truncate text-text-secondary">{row.label}</span>
              </span>
              <span className="figure shrink-0 font-medium text-text-primary">
                {row.sessions.toLocaleString()}
              </span>
            </div>
            {/* Presentational: the figure beside the label and the sr-only table
                below already carry both numbers, so a second announcement of
                the same bar would only add noise. */}
            <div
              aria-hidden
              className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
            >
              <div
                className="h-full rounded-full transition-[width] duration-[var(--dur-slow)]"
                style={{
                  width: `${row.percent}%`,
                  background: TONE_FOR[row.id] ?? 'var(--color-text-tertiary)',
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      {/* The reason there is no pie here, said plainly and once. */}
      <p className="text-xs text-text-tertiary">
        {t('analytics.eachBarIsAShare') ||
          'Each bar is a share of all tracked conversations. One conversation can appear in more than one outcome, so these do not add up to the total.'}
      </p>

      {/* The same facts, for a screen reader. Shares are per outcome against the
          tracked total, which is exactly what the bars draw. */}
      <table className="sr-only">
        <caption>
          {t('analytics.journeyOutcomesCaption') ||
            'Journey outcomes. One conversation can appear in more than one outcome, so the shares do not add up to 100%.'}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('analytics.outcomeColumn') || 'Outcome'}</th>
            <th scope="col">{t('analytics.sessions') || 'Sessions'}</th>
            <th scope="col">{t('analytics.share') || 'Share'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.label}</td>
              <td>{row.sessions}</td>
              <td>{row.share != null ? `${Math.round(row.share * 100)}%` : t('analytics.noData') || 'No data'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

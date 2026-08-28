import { useMemo } from 'react';
import { useAnimatedProgress } from '../../hooks/useAnimatedProgress';
import type { JourneyOutcome } from './journeyModel';
import { useTranslation } from '../../i18n/useTranslation';

const DONUT_VB = 160;
const DONUT_R = 62;
const DONUT_STROKE = 20;
const DONUT_CIRC = 2 * Math.PI * DONUT_R;
const DONUT_PX = 160;

const TONE_FOR: Record<string, string> = {
  meeting_booked: '#10b981',
  kept_browsing: '#3b82f6',
  handoff_requested: '#f97316',
  offline_message_sent: '#a855f7',
  exit: '#ef4444',
};

export interface JourneyOutcomesDonutProps {
  outcomes: readonly JourneyOutcome[];
  total: number;
}

export function JourneyOutcomesDonut({ outcomes = [], total = 0 }: JourneyOutcomesDonutProps) {
  const { t } = useTranslation();
  const safeTotal = typeof total === 'number' && !isNaN(total) && total > 0 ? total : 0;
  const progress = useAnimatedProgress(1400, safeTotal);
  const animatedTotal = Math.round(safeTotal * progress);

  const segments = useMemo(() => {
    const positive = (outcomes ?? []).filter((o) => (o?.sessions ?? 0) > 0);
    const denom = safeTotal > 0 ? safeTotal : 1;
    return positive.reduce<Array<JourneyOutcome & { offset: number; length: number }>>(
      (acc, o) => {
        const prev = acc[acc.length - 1];
        const offset = prev ? prev.offset + prev.length : 0;
        const length = ((o.sessions ?? 0) / denom) * DONUT_CIRC;
        acc.push({ ...o, offset, length });
        return acc;
      },
      [],
    );
  }, [outcomes, safeTotal]);

  const usedArc = useMemo(() => segments.reduce((sum, seg) => sum + seg.length, 0), [segments]);
  const revealFront = progress * usedArc;

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div
        className="relative flex shrink-0 items-center justify-center"
        style={{ width: DONUT_PX, height: DONUT_PX }}
      >
        <svg
          viewBox={`0 0 ${DONUT_VB} ${DONUT_VB}`}
          width={DONUT_PX}
          height={DONUT_PX}
          aria-hidden="true"
        >
          <circle
            cx={DONUT_VB / 2}
            cy={DONUT_VB / 2}
            r={DONUT_R}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={DONUT_STROKE}
            opacity={0.35}
          />
          <g transform={`rotate(-90 ${DONUT_VB / 2} ${DONUT_VB / 2})`}>
            {segments.map((seg) => {
              const drawn = Math.max(0, Math.min(seg.length, revealFront - seg.offset));
              return (
                <circle
                  key={seg.id}
                  cx={DONUT_VB / 2}
                  cy={DONUT_VB / 2}
                  r={DONUT_R}
                  fill="none"
                  stroke={TONE_FOR[seg.id] ?? '#94a3b8'}
                  strokeWidth={DONUT_STROKE}
                  strokeDasharray={`${drawn} ${DONUT_CIRC}`}
                  strokeDashoffset={-seg.offset}
                  strokeLinecap="butt"
                />
              );
            })}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <p className="text-2xs font-medium uppercase tracking-wider text-text-tertiary">
            {t('analytics.total') || 'Total'}
          </p>
          <p className="tabular-nums text-lg font-semibold text-text-primary">
            {animatedTotal.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Visible legend, same as the original — already accessible as plain text */}
      <ul className="flex-1 space-y-2">
        {(outcomes ?? []).map((o) => (
          <li key={o.id} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ background: TONE_FOR[o.id] ?? '#94a3b8' }}
              />
              <span className="text-text-secondary">{o.label}</span>
            </span>
            <span className="tabular-nums font-medium text-text-primary">
              {(o.sessions ?? 0).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>

      {/* Accessible data table for screen readers */}
      <table className="sr-only">
        <caption>{t('analytics.journeyOutcomes') || 'Journey outcomes'}</caption>
        <thead>
          <tr>
            <th scope="col">{t('analytics.outcomeColumn') || 'Outcome'}</th>
            <th scope="col">{t('analytics.sessions') || 'Sessions'}</th>
            <th scope="col">{t('analytics.share') || 'Share'}</th>
          </tr>
        </thead>
        <tbody>
          {(outcomes ?? []).map((o) => (
            <tr key={o.id}>
              <td>{o.label}</td>
              <td>{o.sessions ?? 0}</td>
              <td>{o.share != null ? `${Math.round(o.share * 100)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { type ReactElement } from 'react';
import { Users } from 'lucide-react';
import { EmptyState } from '../../design-system';
import { type LeadFunnelStats } from './analytics-types';

interface LeadFunnelProps {
  stats: LeadFunnelStats;
}

interface FunnelStage {
  key: string;
  label: string;
  /** Plain-language explanation of the stage. */
  hint: string;
  count: number;
  /** Bar color token. */
  color: string;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * LeadFunnel — how visitors progress from first contact to sales-qualified,
 * across every agent. Cumulative funnel: each stage counts leads that reached
 * it *or beyond*, so the bars taper as qualification tightens.
 */
export function LeadFunnel({ stats }: LeadFunnelProps): ReactElement {
  if (stats.total === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No leads captured yet"
        description="When your agents qualify visitors, you’ll see how many became marketing- and sales-qualified leads here."
      />
    );
  }

  const mqlPlus = stats.mql + stats.sal + stats.sql;
  const salPlus = stats.sal + stats.sql;

  const stages: FunnelStage[] = [
    {
      key: 'total',
      label: 'All leads',
      hint: 'Everyone who started a conversation',
      count: stats.total,
      color: 'var(--ds-text-subtle)',
    },
    {
      key: 'mql',
      label: 'Marketing-qualified',
      hint: 'Showed genuine interest',
      count: mqlPlus,
      color: 'var(--ds-info)',
    },
    {
      key: 'sal',
      label: 'Sales-accepted',
      hint: 'Worth a sales follow-up',
      count: salPlus,
      color: 'var(--ds-warning)',
    },
    {
      key: 'sql',
      label: 'Sales-qualified',
      hint: 'Ready to buy',
      count: stats.sql,
      color: 'var(--ds-success)',
    },
  ];

  return (
    <ol className="flex flex-col gap-4">
      {stages.map((stage) => {
        const share = percent(stage.count, stats.total);
        return (
          <li key={stage.key}>
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-[var(--ds-text)]">{stage.label}</p>
                <p className="text-[12px] text-[var(--ds-text-muted)]">{stage.hint}</p>
              </div>
              <p className="shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                <span className="font-semibold text-[var(--ds-text)]">
                  {stage.count.toLocaleString()}
                </span>{' '}
                ({share}%)
              </p>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(share, 2)}%`, backgroundColor: stage.color }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

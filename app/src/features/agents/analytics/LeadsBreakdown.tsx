import { useMemo, type ReactElement } from 'react';
import { formatNumber } from '../../../i18n/formatters';
import { Users } from 'lucide-react';
import { Card, EmptyState, SectionHeader, Skeleton } from '../../../design-system';
import { type LeadStats } from './analytics.types';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

interface LeadsBreakdownProps {
  leads: LeadStats | null;
  loading: boolean;
}

interface FunnelStage {
  label: string;
  hint: string;
  value: number;
  color: string;
}

/**
 * LeadsBreakdown - the qualification funnel for this agent: how many
 * conversations became marketing-, sales-accepted-, and sales-qualified leads.
 * Bars are proportional to the total so drop-off between stages is visible.
 */
export function LeadsBreakdown({ leads, loading }: LeadsBreakdownProps): ReactElement {
  const { t } = useTranslation();
  const stages = useMemo<FunnelStage[]>(() => {
    if (!leads) return [];
    return [
      {
        label: translateNow('agents.allConversations') || 'All conversations',
        hint: translateNow('agents.everyoneWhoChatted') || 'Everyone who chatted',
        value: leads.total,
        color: 'var(--ds-text-subtle)',
      },
      {
        label: translateNow('agents.warmLead') || 'Warm lead',
        hint: translateNow('agents.showedEarlyInterest') || 'Showed early interest',
        value: leads.mql + leads.sal + leads.sql,
        color: 'var(--ds-info)',
      },
      {
        label: translateNow('agents.strongInterest') || 'Strong interest',
        hint: translateNow('agents.worthASalesFollowUp') || 'Worth a sales follow-up',
        value: leads.sal + leads.sql,
        color: 'var(--ds-warning)',
      },
      {
        label: translateNow('agents.readyToBuy') || 'Ready to buy',
        hint: translateNow('agents.readyToBuy') || 'Ready to buy',
        value: leads.sql,
        color: 'var(--ds-success)',
      },
    ];
  }, [leads]);

  const total = leads?.total ?? 0;

  return (
    <Card className="p-5">
      <SectionHeader
        title={t('agents.leadFunnel') || 'Lead funnel'}
        description={t('agents.howConversationsTurnIntoQualified') || 'How conversations turn into qualified leads.'}
      />

      <div className="mt-5">
        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : !leads || total === 0 ? (
          <EmptyState
            icon={Users}
            title={t('agents.noLeadsCapturedYet') || 'No leads captured yet'}
            description={t('agents.whenVisitorsShareTheirDetails') || 'When visitors share their details or show buying intent, they\'ll appear here as leads.'}
          />
        ) : (
          <ol className="space-y-4">
            {stages.map((stage) => {
              const pct = total > 0 ? Math.round((stage.value / total) * 100) : 0;
              return (
                <li key={stage.label}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[var(--ds-text)]">{stage.label}</p>
                      <p className="text-[12px] text-[var(--ds-text-subtle)]">{stage.hint}</p>
                    </div>
                    <p className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                      {formatNumber(stage.value)}
                      <span className="ml-1.5 text-[var(--ds-text-subtle)]">{pct}%</span>
                    </p>
                  </div>
                  <div
                    className="h-2.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: stage.color }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
}

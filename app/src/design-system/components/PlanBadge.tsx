import type { ReactElement } from 'react';
import { useTranslation } from '../../i18n/useTranslation';
import { StatusBadge, type StatusBadgeProps } from '../primitives/Badge';

export interface PlanBadgeProps {
  /** Plan display name from `entitlements.plan_name` (e.g. "Free", "Starter", "Standard", "Enterprise"). */
  planName?: string | null;
  className?: string;
}

/**
 * PlanBadge - compact plan-name pill (mandate shared component). Free
 * renders neutral; every paid plan renders accent, so the badge doubles as a
 * cheap "are they paying?" visual cue anywhere a plan needs a one-glance label.
 */
export function PlanBadge({ planName, className }: PlanBadgeProps): ReactElement {
  const { t } = useTranslation();
  const label = planName?.trim() || t('ds.free') || 'Free';
  const tone: StatusBadgeProps['tone'] = label.toLowerCase() === 'free' ? 'neutral' : 'accent';

  return (
    <StatusBadge tone={tone} className={className}>
      {t('ds.planBadge', { plan: label }) || `${label} plan`}
    </StatusBadge>
  );
}

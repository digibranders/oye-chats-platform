import { type ReactElement } from 'react';
import { MailCheck } from 'lucide-react';
import { Card, SectionHeader } from '../../../design-system';
import { Toggle } from './controls';

interface LeadEnrichmentSectionProps {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** True when the current plan (Standard / Professional) includes verification. */
  planAllows: boolean;
}

/**
 * Lead enrichment - the per-agent opt-in for metered Reoon email verification,
 * bound to the reused `email_verification_enabled` Bot field. Gated to Standard
 * / Professional plans: on lower tiers the switch is disabled with an inline
 * upgrade hint (the server enforces the same boundary, so this is guidance, not
 * the security gate). Defaults OFF, so an agent never spends credits on
 * verification until the customer turns it on here.
 */
export function LeadEnrichmentSection({
  enabled,
  onToggle,
  planAllows,
}: LeadEnrichmentSectionProps): ReactElement {
  return (
    <section aria-labelledby="enrichment-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="enrichment-heading" className="inline-flex items-center gap-2">
            <MailCheck size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Lead enrichment
          </span>
        }
        description="Automatically verify the emails your agent captures from visitors."
      />

      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
              aria-hidden="true"
            >
              <MailCheck size={15} />
            </div>
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-[var(--ds-text)]">Email verification</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
                When a visitor leaves an email, verify its deliverability in real time and score
                the lead. Costs 10 credits per verified lead.
                {!planAllows && (
                  <span className="font-medium text-[var(--ds-text-muted)]">
                    {' '}
                    Available on Standard and Professional plans.
                  </span>
                )}
              </p>
            </div>
          </div>
          <Toggle
            checked={planAllows && enabled}
            onChange={onToggle}
            disabled={!planAllows}
            label="Email verification"
          />
        </div>
      </Card>
    </section>
  );
}

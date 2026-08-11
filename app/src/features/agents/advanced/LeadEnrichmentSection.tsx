import { type ReactElement, type ComponentType } from 'react';
import { Building2, MailCheck } from 'lucide-react';
import { Card, SectionHeader } from '../../../design-system';
import { Toggle } from './controls';

interface EnrichmentToggleProps {
  readonly icon: ComponentType<{ size?: number }>;
  readonly title: string;
  readonly description: string;
  /** What this costs, phrased as the condition under which it is charged. */
  readonly cost: string;
  /** Named so the disabled hint can say WHICH plans, not just "upgrade". */
  readonly planName: string;
  readonly planAllows: boolean;
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
}

function EnrichmentToggle({
  icon: Icon,
  title,
  description,
  cost,
  planName,
  planAllows,
  enabled,
  onToggle,
}: EnrichmentToggleProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
          aria-hidden="true"
        >
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-[var(--ds-text)]">{title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
            {description} {cost}
            {!planAllows && (
              <span className="font-medium text-[var(--ds-text-muted)]"> Available on {planName}.</span>
            )}
          </p>
        </div>
      </div>
      <Toggle
        // `planAllows && enabled` deliberately: on a plan that doesn't include
        // the feature the switch reads OFF regardless of the stored value,
        // because it does nothing. The stored value is left untouched so it
        // comes back intact on upgrade rather than being silently cleared.
        checked={planAllows && enabled}
        onChange={onToggle}
        disabled={!planAllows}
        label={title}
      />
    </div>
  );
}

interface LeadEnrichmentSectionProps {
  readonly emailVerificationEnabled: boolean;
  readonly onToggleEmailVerification: (next: boolean) => void;
  /** True when the plan (Standard / Professional) includes verification. */
  readonly emailVerificationPlanAllows: boolean;
  readonly companyLookupEnabled: boolean;
  readonly onToggleCompanyLookup: (next: boolean) => void;
  /** True when the plan (Professional) includes Visitor Intelligence. */
  readonly companyLookupPlanAllows: boolean;
}

/**
 * Lead enrichment — the per-agent customer controls for the two METERED
 * enrichments, bound to `Bot.email_verification_enabled` and
 * `Bot.company_lookup_enabled`.
 *
 * Both default ON. The customer is already paying for a plan that includes
 * them, so the control that earns its place is an OFF switch for someone who
 * doesn't want the credits spent — not an OFF default that leaves a paid
 * feature invisible until they find this page.
 *
 * Each switch is the third of THREE independent gates, all enforced
 * server-side: the plan, the super-admin kill switch
 * (`feature.<name>_enabled`), and this toggle. Disabling a switch here is
 * guidance for the customer, not the security boundary — the charge is gated
 * in `chat_routes`, not by this component.
 */
export function LeadEnrichmentSection({
  emailVerificationEnabled,
  onToggleEmailVerification,
  emailVerificationPlanAllows,
  companyLookupEnabled,
  onToggleCompanyLookup,
  companyLookupPlanAllows,
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
        description="Extra detail added to the leads your agent captures. Both are on by default — turn either off to stop spending credits on it."
      />

      <Card className="divide-y divide-[var(--ds-border)] p-0">
        <div className="p-4">
          <EnrichmentToggle
            icon={MailCheck}
            title="Email verification"
            description="When a visitor leaves an email, verify its deliverability in real time and score the lead."
            cost="Costs 10 credits per verified lead."
            planName="Standard and Professional plans"
            planAllows={emailVerificationPlanAllows}
            enabled={emailVerificationEnabled}
            onToggle={onToggleEmailVerification}
          />
        </div>
        <div className="p-4">
          <EnrichmentToggle
            icon={Building2}
            title="Company lookup"
            description="Identify the company a visitor is browsing from, using their IP address."
            // Stated as a condition, not a flat price. Most visitors arrive on
            // home or mobile connections that name no employer, and those cost
            // nothing — a bare "10 credits" would read as 10 per visitor.
            cost="Costs 10 credits only when a company is found."
            planName="the Professional plan"
            planAllows={companyLookupPlanAllows}
            enabled={companyLookupEnabled}
            onToggle={onToggleCompanyLookup}
          />
        </div>
      </Card>
    </section>
  );
}

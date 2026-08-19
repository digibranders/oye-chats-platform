import { memo } from 'react';
import { Badge, Card, CardHeader, CardSection, Switch } from '../../../ui';

interface EnrichmentRowProps {
  readonly title: string;
  readonly description: string;
  /** The charge, phrased as the condition under which it is levied. */
  readonly cost: string;
  /** Named, so a locked row says WHICH plan rather than just "upgrade". */
  readonly planName: string;
  readonly planAllows: boolean;
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
}

function EnrichmentRow({
  title,
  description,
  cost,
  planName,
  planAllows,
  enabled,
  onToggle,
}: EnrichmentRowProps) {
  return (
    <CardSection>
      <Switch
        // `planAllows && enabled` deliberately: on a plan without the feature
        // the switch reads OFF whatever is stored, because it does nothing. The
        // stored value is left alone so it returns intact on upgrade instead of
        // being silently cleared.
        checked={planAllows && enabled}
        onCheckedChange={onToggle}
        disabled={!planAllows}
        label={title}
        description={
          <>
            {description} {cost}
          </>
        }
      />
      {!planAllows ? (
        <p className="mt-2">
          <Badge tone="plan">Included on {planName}</Badge>
        </p>
      ) : null}
    </CardSection>
  );
}

export interface LeadEnrichmentSectionProps {
  readonly emailVerificationEnabled: boolean;
  readonly onToggleEmailVerification: (next: boolean) => void;
  /** True when this chatbot's plan (Standard / Professional) includes verification. */
  readonly emailVerificationPlanAllows: boolean;
  readonly companyLookupEnabled: boolean;
  readonly onToggleCompanyLookup: (next: boolean) => void;
  /** True when this chatbot's plan (Professional) includes Visitor Intelligence. */
  readonly companyLookupPlanAllows: boolean;
}

/**
 * Lead enrichment — the two metered add-ons, bound to
 * `Bot.email_verification_enabled` and `Bot.company_lookup_enabled`.
 *
 * It belongs on Qualification because it is about the *lead*, not the widget:
 * both enrichments only ever run on a captured contact, and both feed the same
 * scoring decision the rest of this page configures.
 *
 * Both default OFF. Enrichment spends credits, so it is an explicit opt-in
 * rather than a paid feature left running until the customer finds this page.
 *
 * Each switch is the third of three independent gates, all enforced
 * server-side: the plan, the super-admin kill switch (`feature.<name>_enabled`),
 * and this toggle. Turning one off here is guidance for the customer, not the
 * security boundary — the charge is gated in `chat_routes`, not by this file.
 */
function LeadEnrichmentSectionInner({
  emailVerificationEnabled,
  onToggleEmailVerification,
  emailVerificationPlanAllows,
  companyLookupEnabled,
  onToggleCompanyLookup,
  companyLookupPlanAllows,
}: LeadEnrichmentSectionProps) {
  return (
    <Card>
      <CardHeader
        title="Lead enrichment"
        titleAs="h2"
        description="Extra detail added to the leads this chatbot captures. Both are off until you turn them on, because both spend credits."
      />
      <EnrichmentRow
        title="Email verification"
        description="When a visitor leaves an email, check in real time that it can actually receive mail."
        cost="Costs 10 credits per verified lead."
        planName="the Standard and Professional plans"
        planAllows={emailVerificationPlanAllows}
        enabled={emailVerificationEnabled}
        onToggle={onToggleEmailVerification}
      />
      <EnrichmentRow
        title="Company lookup"
        description="Identify the company a visitor is browsing from, using their IP address."
        // Stated as a condition, not a flat price. Most visitors arrive on home
        // or mobile connections that name no employer, and those cost nothing —
        // a bare "10 credits" would read as 10 per visitor.
        cost="Costs 10 credits only when a company is found."
        planName="the Professional plan"
        planAllows={companyLookupPlanAllows}
        enabled={companyLookupEnabled}
        onToggle={onToggleCompanyLookup}
      />
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const LeadEnrichmentSection = memo(LeadEnrichmentSectionInner);

import { memo } from 'react';
import { Badge, Card, CardBody, CardHeader, SettingRow, Switch } from '../../../ui';

interface EnrichmentRowProps {
  readonly title: string;
  readonly description: string;
  /** The charge, as a figure — the one fact that decides whether this goes on. */
  readonly cost: string;
  /**
   * The shortest plan name that includes it.
   *
   * One word, because `Badge` is `whitespace-nowrap` and "the Standard and
   * Professional plans" rendered as a ~290px unbreakable pill.
   */
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
    <SettingRow
      label={title}
      description={description}
      badge={
        planAllows ? (
          // The price is the fact that decides this, so it is a figure beside
          // the name rather than the tail of a 12px sentence.
          <span className="figure text-xs text-text-secondary">{cost}</span>
        ) : (
          <Badge tone="plan">{planName}</Badge>
        )
      }
      controlWidth="auto"
    >
      <Switch
        // `planAllows && enabled` deliberately: on a plan without the feature
        // the switch reads OFF whatever is stored, because it does nothing. The
        // stored value is left alone so it returns intact on upgrade instead of
        // being silently cleared.
        checked={planAllows && enabled}
        onCheckedChange={onToggle}
        disabled={!planAllows}
        label={title}
        hideLabel
      />
    </SettingRow>
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
 * It lives on the Experience ▸ Leads tab (the whole tab is gated to Standard and
 * up). Presentational only: the toggles read from and write to the Experience
 * draft, and this component holds no data source of its own.
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
    // A `Card` with a widget header, not a `SettingGroup`: this sits in an 18rem
    // aside beside two cards, and `SettingGroup`'s heading is `text-lg` — a
    // page-section register, four points above the `CardHeader`s above and below
    // it. Three blocks in one narrow column, three different heading sizes.
    <Card>
      <CardHeader
        size="sm"
        titleAs="h2"
        title="Lead enrichment"
        description="Both spend credits, so both are off by default."
      />
      <CardBody flush>
        <EnrichmentRow
          title="Email verification"
          description="Check the address can receive mail."
          cost="10 credits / verified lead"
          planName="Standard"
          planAllows={emailVerificationPlanAllows}
          enabled={emailVerificationEnabled}
          onToggle={onToggleEmailVerification}
        />
        <EnrichmentRow
          title="Company lookup"
          description="Identify the company from the visitor’s IP."
          // Stated as a condition, not a flat price. Most visitors arrive on home
          // or mobile connections that name no employer, and those cost nothing —
          // a bare "10 credits" would read as 10 per visitor.
          cost="10 credits only when a company is found"
          planName="Professional"
          planAllows={companyLookupPlanAllows}
          enabled={companyLookupEnabled}
          onToggle={onToggleCompanyLookup}
        />
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
export const LeadEnrichmentSection = memo(LeadEnrichmentSectionInner);

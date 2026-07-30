import { type ReactElement } from 'react';
import { KeyRound, Webhook as WebhookIcon } from 'lucide-react';
import { Card, SectionHeader } from '../../../design-system';
import { FeatureGate } from '../../../design-system/components/FeatureGate';
import { QuickAction } from '../../../design-system/components/QuickAction';

interface DeveloperAccessCardProps {
  icon: typeof WebhookIcon;
  title: string;
  description: string;
  linkTo: string;
  linkLabel: string;
}

/** Unlocked state: a compact pointer to where this capability is actually managed
 * (Workspace ▸ Integrations / API keys) rather than duplicating that UI here. */
function DeveloperAccessCard({
  icon: Icon,
  title,
  description,
  linkTo,
  linkLabel,
}: DeveloperAccessCardProps): ReactElement {
  return (
    <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
          aria-hidden="true"
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-[var(--ds-text)]">{title}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-subtle)]">
            {description}
          </p>
        </div>
      </div>
      <QuickAction icon={Icon} label={linkLabel} to={linkTo} className="shrink-0" />
    </Card>
  );
}

/**
 * Developer access - Webhooks and API access, gated on the `webhooks` and
 * `api_access` plan features. Advanced doesn't own the actual management UI
 * for either (Webhooks live on Workspace ▸ Integrations, API keys on
 * Workspace ▸ API keys); on an entitled plan this section is an honest
 * pointer to those pages, not a duplicate of them. On a plan without the
 * feature, each renders the standard locked upgrade card instead.
 */
export function DeveloperAccessSection(): ReactElement {
  return (
    <section aria-labelledby="developer-access-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="developer-access-heading" className="inline-flex items-center gap-2">
            <KeyRound size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Developer access
          </span>
        }
        description="Push events out and pull data in from your own systems."
      />

      <div className="grid gap-4 sm:grid-cols-1">
        <FeatureGate feature="webhooks" intent="webhooks_integration" requiredPlan="Standard">
          <DeveloperAccessCard
            icon={WebhookIcon}
            title="Webhooks"
            description="Send lead and conversation events to your CRM, Zapier, or Make in real time."
            linkTo="/workspace/integrations"
            linkLabel="Manage webhooks"
          />
        </FeatureGate>

        <FeatureGate feature="api_access" intent="view_integrations" requiredPlan="Standard">
          <DeveloperAccessCard
            icon={KeyRound}
            title="API access"
            description="Call the OyeChats API directly from your own app or backend using an API key."
            linkTo="/workspace/api-keys"
            linkLabel="Manage API keys"
          />
        </FeatureGate>
      </div>
    </section>
  );
}

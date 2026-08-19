import { memo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Webhook as WebhookIcon } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  ErrorState,
  LoadingRows,
  buttonClass,
} from '../../../ui';
import { agentPath } from '../../../shell/nav';
import { TIERS } from './qualification.config';
import { TIER_EVENT } from './tierOutcomes';
import type { TierOutcomesState } from './useTierOutcomes';

export interface TierOutcomesSectionProps {
  state: TierOutcomesState;
  agentId: number;
  /** True when the plan includes outbound webhooks. */
  webhooksAllowed: boolean;
}

function Outcome({
  icon,
  title,
  detail,
  tone,
}: {
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  tone: 'success' | 'warning' | 'neutral';
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-text-tertiary">{icon}</span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium text-text-primary">{title}</span>
          <Badge tone={tone} dot>
            {tone === 'success' ? 'Will fire' : tone === 'warning' ? 'Not configured' : 'Off'}
          </Badge>
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{detail}</span>
      </span>
    </li>
  );
}

/**
 * What actually fires when a lead crosses a tier.
 *
 * This section exists because of a real gap: a customer could set three
 * thresholds with no way to find out that **only SQL notifies anyone**. Both
 * halves of the answer are configured elsewhere — the email on Experience, the
 * webhook in Settings ▸ Integrations — so this reads their live state rather
 * than restating a promise, and links to the page that owns each one.
 */
function TierOutcomesSectionInner({ state, agentId, webhooksAllowed }: TierOutcomesSectionProps) {
  const { facts, loading, error, retry } = state;

  return (
    <Card>
      <CardHeader
        title="What happens at each tier"
        titleAs="h2"
        description="Promotion is recorded on every tier, but only sales-qualified sends anything. This is checked against your live settings."
      />

      {loading ? (
        <CardBody>
          <LoadingRows rows={3} />
        </CardBody>
      ) : error ? (
        <CardBody>
          <ErrorState
            compact
            title="We could not check what fires"
            description={error}
            onRetry={retry}
          />
        </CardBody>
      ) : facts ? (
        <>
          {TIERS.map((tier) => {
            const isSql = tier.key === 'sql';
            const emailWillFire = isSql && facts.emailEnabled && facts.recipients.length > 0;
            const webhookWillFire = isSql && facts.webhooks.length > 0;

            return (
              <CardSection key={tier.key}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-base font-semibold text-text-primary">{tier.label}</h3>
                  <span className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                    {tier.abbreviation}
                  </span>
                </div>

                {isSql ? (
                  <ul className="mt-3 space-y-3">
                    <Outcome
                      icon={<Mail aria-hidden className="h-4 w-4" />}
                      title="Qualified-lead email"
                      tone={emailWillFire ? 'success' : facts.emailEnabled ? 'warning' : 'neutral'}
                      detail={
                        emailWillFire ? (
                          <>
                            Sent once, the first time a conversation reaches this tier, to{' '}
                            <span className="figure">{facts.recipients.join(', ')}</span>.
                          </>
                        ) : facts.emailEnabled ? (
                          <>
                            The email is switched on but no recipient is set, so nothing is sent. Add
                            one under Experience.
                          </>
                        ) : (
                          <>
                            Switched off for this chatbot, so no email is sent however high a lead
                            scores.
                          </>
                        )
                      }
                    />
                    <Outcome
                      icon={<WebhookIcon aria-hidden className="h-4 w-4" />}
                      title={`${TIER_EVENT} webhook`}
                      tone={webhookWillFire ? 'success' : webhooksAllowed ? 'warning' : 'neutral'}
                      detail={
                        webhookWillFire ? (
                          <>
                            Delivered to{' '}
                            <span className="figure">
                              {facts.webhooks.map((hook) => hook.url).join(', ')}
                            </span>
                            , with the old tier, the new tier and the score. Retried five times on
                            failure.
                            {facts.silentWebhooks > 0 ? (
                              <>
                                {' '}
                                <span className="figure">{facts.silentWebhooks}</span> other webhook
                                {facts.silentWebhooks === 1 ? ' is' : 's are'} registered but not
                                subscribed to this event.
                              </>
                            ) : null}
                          </>
                        ) : webhooksAllowed ? (
                          <>
                            No active webhook subscribes to <span className="figure">{TIER_EVENT}</span>
                            , so nothing is delivered.
                            {facts.silentWebhooks > 0 ? (
                              <>
                                {' '}
                                You have <span className="figure">{facts.silentWebhooks}</span>{' '}
                                registered — add this event to one of them.
                              </>
                            ) : null}
                          </>
                        ) : (
                          <>Outbound webhooks are not included in this chatbot&rsquo;s plan.</>
                        )
                      }
                    />
                  </ul>
                ) : (
                  <p className="mt-2 max-w-2xl text-prose text-text-secondary">
                    The lead is stamped with this tier and appears in Leads and the Inbox at that
                    rank. Nothing is sent — no email, no webhook, no handoff. Only sales-qualified
                    notifies anyone.
                  </p>
                )}
              </CardSection>
            );
          })}

          {facts.recipients.length === 0 && facts.webhooks.length === 0 ? (
            <CardSection>
              <Alert tone="warning" title="Nothing is listening">
                No lead reaching any tier will notify anyone right now. Set a recipient for the
                qualified-lead email, or point a webhook at{' '}
                <span className="figure">{TIER_EVENT}</span>, or the scores below will only ever be
                seen by someone who opens Leads.
              </Alert>
            </CardSection>
          ) : null}

          <CardSection className="flex flex-wrap gap-2 bg-surface-sunken">
            <Link to={agentPath(agentId, 'experience')} className={buttonClass('secondary', 'sm')}>
              Email recipients
            </Link>
            {webhooksAllowed ? (
              <Link to="/settings/integrations" className={buttonClass('secondary', 'sm')}>
                Webhooks
              </Link>
            ) : null}
            <Button size="sm" variant="ghost" onClick={retry}>
              Re-check
            </Button>
          </CardSection>
        </>
      ) : null}
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const TierOutcomesSection = memo(TierOutcomesSectionInner);

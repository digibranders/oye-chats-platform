import { memo } from 'react';
import { Link } from 'react-router-dom';
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

/**
 * What actually fires when a lead crosses a tier.
 *
 * This section exists because of a real gap: a customer could set three
 * thresholds with no way to find out that **only SQL notifies anyone**. Both
 * halves of the answer are configured elsewhere — the email on Experience, the
 * webhook in Settings ▸ Integrations — so this reads their live state rather
 * than restating a promise, and links to the page that owns each one.
 *
 * Three hairline rows, not three `CardSection`s. The two non-firing tiers each
 * printed the same 33-word paragraph — verbatim, twice, about 200px apart, on a
 * card whose own header already said "only sales-qualified sends anything". A
 * tier that records and sends nothing is a `Recorded only` badge; the card is
 * about 180px tall now rather than 520.
 */
function TierOutcomesSectionInner({ state, agentId, webhooksAllowed }: TierOutcomesSectionProps) {
  const { facts, loading, error, retry } = state;

  return (
    <Card>
      <CardHeader
        title="What happens at each tier"
        titleAs="h2"
        description="Only sales-qualified notifies anyone. Checked against your live settings."
      />

      {loading ? (
        <CardBody>
          <LoadingRows rows={3} />
        </CardBody>
      ) : error ? (
        <CardBody>
          <ErrorState size="panel" title="We could not check what fires" description={error} onRetry={retry} />
        </CardBody>
      ) : facts ? (
        <>
          <CardBody flush>
            {TIERS.map((tier) => {
              const isSql = tier.key === 'sql';
              const emailWillFire = isSql && facts.emailEnabled && facts.recipients.length > 0;
              const webhookWillFire = isSql && facts.webhooks.length > 0;

              return (
                <div
                  key={tier.key}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-cell py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-base font-medium text-text-primary">{tier.label}</span>
                    <span className="figure text-2xs uppercase tracking-eyebrow text-text-tertiary">
                      {tier.abbreviation}
                    </span>
                  </span>

                  {isSql ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        tone={emailWillFire ? 'success' : facts.emailEnabled ? 'warning' : 'neutral'}
                        dot
                      >
                        Email
                      </Badge>
                      <Badge
                        tone={webhookWillFire ? 'success' : webhooksAllowed ? 'warning' : 'neutral'}
                        dot
                      >
                        Webhook
                      </Badge>
                    </span>
                  ) : (
                    <Badge tone="neutral">Recorded only</Badge>
                  )}

                  {isSql ? (
                    // One short line under the badges, not two 40-word
                    // paragraphs: who is told, or why nobody is.
                    <span className="w-full text-xs text-text-secondary">
                      {emailWillFire ? (
                        <span className="figure">{facts.recipients.join(', ')}</span>
                      ) : facts.emailEnabled ? (
                        'The email is on but no recipient is set.'
                      ) : (
                        'The email is switched off for this chatbot.'
                      )}
                      {' · '}
                      {webhookWillFire ? (
                        <>
                          <span className="figure break-all">
                            {facts.webhooks.map((hook) => hook.url).join(', ')}
                          </span>
                          {facts.silentWebhooks > 0
                            ? ` · ${facts.silentWebhooks} other not subscribed`
                            : ''}
                        </>
                      ) : webhooksAllowed ? (
                        <>
                          No webhook subscribes to <span className="figure">{TIER_EVENT}</span>
                          {facts.silentWebhooks > 0 ? '. Add this event to one of them.' : '.'}
                        </>
                      ) : (
                        'Webhooks are not on this plan.'
                      )}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </CardBody>

          {facts.emailEnabled && facts.recipients.length === 0 ? (
            <CardSection>
              <Alert
                tone="warning"
                title="No recipient set"
                action={
                  <Link
                    to={agentPath(agentId, 'experience')}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Email recipients
                  </Link>
                }
              >
                The qualified-lead email is switched on but has nowhere to go.
              </Alert>
            </CardSection>
          ) : null}

          {facts.recipients.length === 0 && facts.webhooks.length === 0 ? (
            <CardSection>
              <Alert tone="warning" title="Nothing is listening">
                Set an email recipient or point a webhook at{' '}
                <span className="figure">{TIER_EVENT}</span>.
                {facts.silentWebhooks > 0 ? ' Add this event to one of them.' : ''}
              </Alert>
            </CardSection>
          ) : null}

          <CardSection tone="sunken" className="flex flex-wrap gap-2">
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

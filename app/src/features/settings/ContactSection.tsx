import { Link } from 'react-router-dom';
import { Badge, Card, CardBody, CardHeader, CopyField, buttonClass } from '../../ui';
import { useEntitlements } from '../../hooks/useEntitlements';

/** Where questions that do not fit a self-serve flow land. */
const CONTACT_EMAIL = 'support@oyechats.com';

/**
 * Getting hold of us.
 *
 * The `online_support` plan flag is surfaced here rather than hidden in the
 * pricing table, because this is the moment it matters: someone reading this
 * card is about to ask for help and deserves to know which queue they are
 * joining. It was a ledger entry precisely because the flag was resolved on
 * every request and shown nowhere.
 */
export function ContactSection() {
  const { hasFeature } = useEntitlements();
  const priority = hasFeature('online_support');

  return (
    <Card>
      <CardHeader
        title="Getting help"
        titleAs="h2"
        description="Bespoke integrations, custom pricing, or something that is simply not working."
        actions={
          <Badge tone={priority ? 'plan' : 'neutral'}>
            {priority ? 'Priority support' : 'Email support'}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        <p className="text-prose text-text-secondary">
          {priority
            ? 'Your plan includes priority support, so your email is answered ahead of the general queue.'
            : 'Email support is included on every plan. Paid plans are answered ahead of the general queue.'}
        </p>

        <CopyField value={CONTACT_EMAIL} label="support email address" />

        <div className="flex flex-wrap gap-2">
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('OyeChats support')}`}
            className={buttonClass('primary', 'md')}
          >
            Email us
          </a>
          {!priority ? (
            <Link to="/billing" className={buttonClass('secondary', 'md')}>
              See what a plan includes
            </Link>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

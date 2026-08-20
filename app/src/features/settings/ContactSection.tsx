import { Link } from 'react-router-dom';
import { Badge, CopyField, SettingGroup, SettingRow, buttonClass } from '../../ui';
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
    <SettingGroup
      title="Getting help"
      actions={
        <Badge tone={priority ? 'plan' : 'neutral'}>
          {priority ? 'Priority support' : 'Email support'}
        </Badge>
      }
    >
      <SettingRow label="Support email" controlWidth="auto">
        <CopyField className="w-64" compact value={CONTACT_EMAIL} label="support email address" />
      </SettingRow>

      <SettingRow label="Email us" controlWidth="auto">
        <div className="flex flex-wrap items-center gap-2">
          {!priority ? (
            <Link to="/billing" className={buttonClass('ghost', 'sm')}>
              See what a plan includes
            </Link>
          ) : null}
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('OyeChats support')}`}
            className={buttonClass('secondary', 'sm')}
          >
            Email us
          </a>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Badge, Button, ConfirmDialog, SettingGroup, SettingRow, buttonClass } from '../../ui';
import { clearAuthStorage } from '../../utils/authStorage';
import { endImpersonationSession, isImpersonating } from '../../utils/impersonation';
import { useTranslation } from '../../i18n/useTranslation';

export interface AccountSessionsSectionProps {
  /** The signed-in address, shown against the current device. */
  email: string;
}

/**
 * Where you are signed in.
 *
 * Exactly one device, because that is all the backend can tell us: there is no
 * session table and no revoke-elsewhere endpoint. The card says so rather than
 * listing a "Two-factor authentication" row with a switch that does nothing —
 * a control that looks actionable and is not is worse than an honest absence,
 * because it makes the user believe they have protection they do not have.
 *
 * Rotating the workspace API key *does* end every other session, since the key
 * is the credential, so that is where a user who has lost a device is pointed.
 */
export function AccountSessionsSection({ email }: AccountSessionsSectionProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  function signOut(): void {
    // In an impersonated support tab this ends the *support* session only.
    // `clearAuthStorage()` wipes the shared localStorage bundle, which holds
    // the super-admin's own credentials for every other tab of this browser.
    if (isImpersonating()) {
      endImpersonationSession(
        t('settings.sessions.impersonationEnded') ||
          'Impersonation session ended. You can close this tab.',
      );
      return;
    }
    clearAuthStorage();
    navigate('/login');
  }

  return (
    <>
      <SettingGroup title="Signed in">
        <SettingRow
          label="This device"
          description={email || undefined}
          badge={
            <Badge tone="success" dot>
              Current
            </Badge>
          }
          controlWidth="auto"
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(true)}
            iconLeft={<LogOut aria-hidden />}
          >
            Sign out
          </Button>
        </SettingRow>

        <SettingRow
          label="Lost a device?"
          description="Rotating the workspace API key ends every session."
          controlWidth="auto"
        >
          {/* `secondary`, not `ghost`: it is the row's only control, and a
              borderless grey link at the right edge of a settings row reads as
              disabled text rather than as somewhere to go. */}
          <Link to="/settings/developers" className={buttonClass('secondary', 'sm')}>
            Open Developers
          </Link>
        </SettingRow>
      </SettingGroup>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out of this device?"
        description="Unsaved changes are lost and live conversations go back to the queue."
        confirmLabel="Sign out"
        onConfirm={signOut}
      />
    </>
  );
}

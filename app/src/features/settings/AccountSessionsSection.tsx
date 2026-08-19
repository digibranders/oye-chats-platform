import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Monitor } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ConfirmDialog } from '../../ui';
import { clearAuthStorage } from '../../utils/authStorage';
import { endImpersonationSession, isImpersonating } from '../../utils/impersonation';

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
  const [confirming, setConfirming] = useState(false);

  function signOut(): void {
    // In an impersonated support tab this ends the *support* session only.
    // `clearAuthStorage()` wipes the shared localStorage bundle, which holds
    // the super-admin's own credentials for every other tab of this browser.
    if (isImpersonating()) {
      endImpersonationSession('Impersonation session ended. You can close this tab.');
      return;
    }
    clearAuthStorage();
    navigate('/login');
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Signed in"
          titleAs="h2"
          description="This is the only session we can see — we do not keep a record of your other devices."
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken">
              <Monitor aria-hidden className="h-4 w-4 text-text-tertiary" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-text-primary">This device</p>
              {email ? <p className="figure truncate text-xs text-text-secondary">{email}</p> : null}
            </div>
            <Badge tone="success" dot>
              Current
            </Badge>
          </div>

          <Alert tone="neutral">
            Lost a device you were signed in on? We cannot end that session from here. Rotating the
            workspace API key in Settings ▸ Developers ends every session in the workspace, because
            the key is what a session is.
          </Alert>

          <Button
            variant="secondary"
            onClick={() => setConfirming(true)}
            iconLeft={<LogOut aria-hidden className="h-4 w-4" />}
          >
            Sign out
          </Button>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out of this device?"
        description="Anything you have typed and not saved is lost. Live conversations you are handling go back to the queue for a teammate to pick up, and the visitor is not told why."
        confirmLabel="Sign out"
        onConfirm={signOut}
      />
    </>
  );
}

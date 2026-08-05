import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Monitor } from 'lucide-react';
import { Button, Card, SectionHeader, StatusBadge } from '../../design-system';
import { clearAuthStorage } from '../../utils/authStorage';

export interface AccountSessionsSectionProps {
  /** The signed-in account's email, shown against the current device. */
  email: string;
}

/**
 * AccountSessionsSection - active sign-in sessions + the (not-yet-built)
 * two-factor / device-management surface. Moved here from the former Workspace
 * ▸ Security tab: this is account-level protection, so it belongs on Settings
 * beside Account security, not on a workspace-admin surface.
 *
 * What's real: the current device with a working `Sign out`. Two-factor auth
 * and multi-device management are stated plainly as not-yet-built rather than
 * rendered as controls that look actionable but do nothing.
 */
export function AccountSessionsSection({ email }: AccountSessionsSectionProps): ReactElement {
  const navigate = useNavigate();

  const handleSignOut = (): void => {
    // Clear both localStorage + sessionStorage so a session-only login leaves no
    // stale shadow that would auto-log the user back in. Mirrors the shell's
    // TopBar logout so behaviour is identical wherever the user signs out.
    clearAuthStorage();
    navigate('/login');
  };

  return (
    <div className="space-y-6">
      {/* ── Sessions - real: current device + working sign-out. ─────────────── */}
      <Card>
        <div className="p-5 sm:p-6">
          <SectionHeader
            title="Active sessions"
            description="Where you’re currently signed in to the dashboard."
          />

          <ul className="mt-4 overflow-hidden rounded-xl border border-[var(--ds-border)]">
            <li className="flex items-center gap-3 bg-[var(--ds-bg-surface)] px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                <Monitor size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                  This device
                  {email ? (
                    <span className="font-normal text-[var(--ds-text-subtle)]">
                      {' · '}
                      {email}
                    </span>
                  ) : null}
                </p>
              </div>
              <StatusBadge tone="success" dot>
                Current
              </StatusBadge>
            </li>
          </ul>

          <div className="mt-4">
            <Button variant="outline" onClick={handleSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

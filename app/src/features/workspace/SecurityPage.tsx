import { type ReactElement, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Clock, LogOut, Monitor, ShieldCheck } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '../../design-system';
import { InsightCard } from '../../design-system/components/InsightCard';
import { getCurrentUser } from '../../services/api';
import { clearAuthStorage } from '../../utils/authStorage';

// ── Local helpers ────────────────────────────────────────────────────────────

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Load state machine ───────────────────────────────────────────────────────

interface AccountIdentity {
  readonly email: string;
}

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly identity: AccountIdentity };

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * SecurityPage — the Workspace ▸ Security surface. One job: answer "How is my
 * access secured?".
 *
 * Password and email now live on Settings ▸ Account security
 * (`../settings/AccountSecuritySection`) — this page does not duplicate that
 * form, it points there. What's real here: the current sign-in session (this
 * device, with a working `Sign out`). Two-factor authentication and
 * multi-device session management are not built yet — that's stated plainly
 * rather than rendered as controls that look actionable but do nothing.
 */
export function SecurityPage(): ReactElement {
  const navigate = useNavigate();

  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);

  // Load account identity. The first setState always follows an await, so the
  // `loading` phase is genuinely derived — never set synchronously in-effect.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const user = await getCurrentUser();
        if (!active) return;
        setPhase({ status: 'ready', identity: { email: user.email ?? '' } });
      } catch (error) {
        if (!active) return;
        setPhase({
          status: 'error',
          message: toMessage(error, 'We couldn’t load your account. Please try again.'),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const retry = (): void => {
    setPhase({ status: 'loading' });
    setRefreshToken((token) => token + 1);
  };

  const identity = phase.status === 'ready' ? phase.identity : null;

  const handleSignOut = (): void => {
    // Clear both localStorage + sessionStorage so a session-only login leaves no
    // stale shadow that would auto-log the user back in. Mirrors the shell's
    // TopBar logout so behaviour is identical wherever the user signs out.
    clearAuthStorage();
    navigate('/login');
  };

  return (
    <PageContainer title="Security" description="How your account and access are protected.">
      {phase.status === 'loading' && <LoadingState />}

      {phase.status === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your account"
          description={phase.message}
          action={<Button onClick={retry}>Try again</Button>}
        />
      )}

      {phase.status === 'ready' && identity && (
        <div className="space-y-6">
          {/* Password + email moved to Settings — point there instead of duplicating the form. */}
          <InsightCard
            tone="neutral"
            icon={ShieldCheck}
            title="Password and email live in Settings"
            body="Change your sign-in password or email address from Settings ▸ Account security."
            action={
              <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>
                Go to Settings
                <ArrowRight size={14} aria-hidden="true" />
              </Button>
            }
          />

          {/* ── Sessions — real: current device + working sign-out. ─────────── */}
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
                      {identity.email ? (
                        <span className="font-normal text-[var(--ds-text-subtle)]">
                          {' · '}
                          {identity.email}
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">
                      The browser you’re using right now.
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

          {/* ── Two-factor authentication & device management — honestly not built. ── */}
          <Card>
            <div className="p-5 sm:p-6">
              <SectionHeader
                title="Two-factor authentication & device management"
                description="A second sign-in step, plus reviewing or revoking every device you're signed in on."
                actions={<StatusBadge tone="neutral">Coming soon</StatusBadge>}
              />
              <EmptyState
                className="mt-4"
                icon={Clock}
                title="Not built yet"
                description="You’ll be able to require an authenticator-app code at sign-in and manage every signed-in device from here. For now your password is your only sign-in factor, and Sign out above only ends the session on this device."
              />
            </div>
          </Card>
        </div>
      )}
    </PageContainer>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

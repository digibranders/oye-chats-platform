import { type FormEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Clock,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Monitor,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Input,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  cn,
} from '../../design-system';
import { InsightCard } from '../../design-system/components/InsightCard';
import { changeClientPassword, getCurrentUser } from '../../services/api';
import { clearAuthStorage, getAuthItem } from '../../utils/authStorage';

// ── Local helpers ────────────────────────────────────────────────────────────

const hasLetter = (value: string): boolean => /[a-zA-Z]/.test(value);
const hasNumber = (value: string): boolean => /\d/.test(value);

/** Registration-parity rule: ≥8 chars with at least one letter and one number. */
function isStrongPassword(value: string): boolean {
  return value.length >= 8 && hasLetter(value) && hasNumber(value);
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const labelClass = 'mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]';

// ── Load state machine ───────────────────────────────────────────────────────

interface AccountIdentity {
  readonly email: string;
  readonly isOperator: boolean;
}

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly identity: AccountIdentity };

type Feedback = { readonly tone: 'success' | 'error'; readonly message: string };

interface PasswordForm {
  readonly current: string;
  readonly next: string;
  readonly confirm: string;
}

const EMPTY_FORM: PasswordForm = { current: '', next: '', confirm: '' };

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * SecurityPage — the Workspace ▸ Security surface. One job: answer
 * "How is my access secured?". It lets the account owner rotate their password,
 * see and end the current sign-in, and understand where two-factor
 * authentication stands. Password changes are wired against the reused
 * `changeClientPassword` endpoint; sessions and 2FA are faithful scaffolds for
 * capabilities the backend does not yet expose (marked below).
 */
export function SecurityPage(): ReactElement {
  const navigate = useNavigate();

  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // Change-password form.
  const [form, setForm] = useState<PasswordForm>(EMPTY_FORM);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Load account identity. The first setState always follows an await, so the
  // `loading` phase is genuinely derived — never set synchronously in-effect.
  useEffect(() => {
    let active = true;
    // auth_type is a synchronous read from storage; the network call is what
    // gates the loading phase.
    const isOperator = getAuthItem('auth_type') === 'operator';
    void (async () => {
      try {
        const user = await getCurrentUser();
        if (!active) return;
        setPhase({
          status: 'ready',
          identity: { email: user.email ?? '', isOperator },
        });
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

  // On a successful change the form clears and the submit button disables, which
  // drops keyboard focus to <body>. Move focus to the confirmation banner so
  // keyboard/screen-reader users retain a sensible focus context.
  useEffect(() => {
    if (feedback?.tone === 'success') {
      feedbackRef.current?.focus();
    }
  }, [feedback]);

  const retry = (): void => {
    setFeedback(null);
    setPhase({ status: 'loading' });
    setRefreshToken((token) => token + 1);
  };

  const identity = phase.status === 'ready' ? phase.identity : null;

  const confirmMismatch = form.confirm.length > 0 && form.confirm !== form.next;
  const canSubmit =
    !saving && form.current.length > 0 && form.next.length > 0 && form.confirm.length > 0;

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError('');
    setFeedback(null);

    if (form.next !== form.confirm) {
      setFormError('New passwords do not match.');
      return;
    }
    if (!isStrongPassword(form.next)) {
      setFormError('New password must be at least 8 characters and include a letter and a number.');
      return;
    }

    setSaving(true);
    try {
      await changeClientPassword(form.current, form.next);
      setForm(EMPTY_FORM);
      setShowCurrent(false);
      setShowNext(false);
      setFeedback({ tone: 'success', message: 'Your password has been changed.' });
    } catch (error) {
      setFormError(toMessage(error, 'We couldn’t change your password. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = (): void => {
    // Clear both localStorage + sessionStorage so a session-only login leaves no
    // stale shadow that would auto-log the user back in. Mirrors the shell's
    // TopBar logout so behaviour is identical wherever the user signs out.
    clearAuthStorage();
    navigate('/login');
  };

  return (
    <PageContainer
      title="Security"
      description="How your account and access are protected."
    >
      {/* Live region for every mutation outcome. */}
      <div aria-live="polite" className="empty:hidden">
        {feedback && (
          <div
            ref={feedbackRef}
            tabIndex={-1}
            className={cn(
              'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-[13px] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              feedback.tone === 'success'
                ? 'border-[var(--ds-success)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                : 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
            )}
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              aria-label="Dismiss message"
              className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

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
          {/* Posture nudge — 2FA is the single most valuable next step. */}
          <InsightCard
            tone="info"
            icon={ShieldCheck}
            title="Two-factor authentication is coming soon"
            body="Your account is protected by your password today. Soon you’ll be able to add a second step at sign-in for stronger protection against stolen passwords."
          />

          {/* ── Change password ─────────────────────────────────────────────
              Owner/client-only. The reused endpoint is `changeClientPassword`
              (POST /client/change-password), authed with the client X-API-Key.
              An operator session carries X-Operator-Key and no client key, so
              the call would fail — and the backend exposes no operator
              password-change on this surface. Operators manage their password in
              their own console, so this card is simply not rendered for them
              rather than promising a capability that isn't wired. */}
          {!identity.isOperator && (
          <Card>
            <form onSubmit={handleChangePassword} className="p-5 sm:p-6">
              <SectionHeader
                title="Password"
                description="Update your sign-in password. Use at least 8 characters with a letter and a number."
              />

              {formError && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-danger)]"
                >
                  {formError}
                </div>
              )}

              <div className="mt-4 grid max-w-md gap-4">
                {/* Current password */}
                <div>
                  <label htmlFor="security-current-password" className={labelClass}>
                    Current password
                  </label>
                  <div className="relative">
                    <Input
                      id="security-current-password"
                      type={showCurrent ? 'text' : 'password'}
                      required
                      autoComplete="current-password"
                      placeholder="Your current password"
                      className="pr-10"
                      value={form.current}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, current: event.target.value }))
                      }
                    />
                    <PasswordToggle
                      shown={showCurrent}
                      onToggle={() => setShowCurrent((shown) => !shown)}
                    />
                  </div>
                </div>

                {/* New password */}
                <div>
                  <label htmlFor="security-new-password" className={labelClass}>
                    New password
                  </label>
                  <div className="relative">
                    <Input
                      id="security-new-password"
                      type={showNext ? 'text' : 'password'}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="At least 8 characters, a letter and a number"
                      aria-describedby="security-new-password-hint"
                      className="pr-10"
                      value={form.next}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, next: event.target.value }))
                      }
                    />
                    <PasswordToggle
                      shown={showNext}
                      onToggle={() => setShowNext((shown) => !shown)}
                    />
                  </div>
                  <p
                    id="security-new-password-hint"
                    className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]"
                  >
                    Must be at least 8 characters and include a letter and a number.
                  </p>
                </div>

                {/* Confirm new password */}
                <div>
                  <label htmlFor="security-confirm-password" className={labelClass}>
                    Confirm new password
                  </label>
                  <Input
                    id="security-confirm-password"
                    type="password"
                    required
                    autoComplete="new-password"
                    placeholder="Repeat your new password"
                    aria-invalid={confirmMismatch}
                    aria-describedby={confirmMismatch ? 'security-confirm-error' : undefined}
                    className={cn(
                      confirmMismatch &&
                        'border-[var(--ds-danger)] focus-visible:border-[var(--ds-danger)] focus-visible:ring-[var(--ds-danger-soft)]',
                    )}
                    value={form.confirm}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, confirm: event.target.value }))
                    }
                  />
                  {confirmMismatch && (
                    <p
                      id="security-confirm-error"
                      className="mt-1.5 text-[12px] text-[var(--ds-danger)]"
                    >
                      Passwords do not match.
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-5">
                <Button type="submit" disabled={!canSubmit}>
                  {saving ? (
                    'Saving…'
                  ) : (
                    <>
                      <KeyRound size={16} aria-hidden="true" />
                      Change password
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Card>
          )}

          {/* ── Sessions ────────────────────────────────────────────────── */}
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

              <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
                Signing out clears your session on this device. A full list of sessions across your
                devices is coming soon.
              </p>

              <div className="mt-4">
                <Button variant="outline" onClick={handleSignOut}>
                  <LogOut size={16} aria-hidden="true" />
                  Sign out
                </Button>
              </div>
            </div>
          </Card>

          {/* ── Two-factor authentication (scaffold) ─────────────────────── */}
          <Card>
            <div className="p-5 sm:p-6">
              <SectionHeader
                title="Two-factor authentication"
                description="Require a second step at sign-in so a stolen password isn’t enough to get in."
                actions={<StatusBadge tone="neutral">Not enabled</StatusBadge>}
              />

              <div className="mt-4 flex flex-col gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4 sm:flex-row sm:items-center">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-surface)] text-[var(--ds-text-subtle)]">
                  <Smartphone size={20} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-[var(--ds-text)]">
                    Authenticator app
                  </p>
                  <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
                    Use an app like Google Authenticator or 1Password to generate a one-time code
                    each time you sign in.
                  </p>
                </div>
                <Button variant="outline" disabled aria-disabled="true">
                  <Clock size={16} aria-hidden="true" />
                  Coming soon
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </PageContainer>
  );
}

// ── Small presentational pieces ──────────────────────────────────────────────

interface PasswordToggleProps {
  readonly shown: boolean;
  readonly onToggle: () => void;
}

/** Show/hide toggle pinned inside a password field. */
function PasswordToggle({ shown, onToggle }: PasswordToggleProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Hide password' : 'Show password'}
      aria-pressed={shown}
      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
    >
      {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
    </button>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

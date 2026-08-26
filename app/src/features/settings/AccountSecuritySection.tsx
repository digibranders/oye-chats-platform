import { type FormEvent, type ReactElement, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, EyeOff, KeyRound, Mail, ShieldAlert, X } from 'lucide-react';
import { Button, Card, Input, SectionHeader, StatusBadge, cn } from '../../design-system';
import {
  cancelClientEmailChange,
  changeClientPassword,
  confirmClientEmailChange,
  operatorChangePassword,
  requestClientEmailChange,
} from '../../services/api';
import { type CurrentUser } from '../../types/domain';
import { useTranslation } from '../../i18n/useTranslation';
import { Trans } from '../../i18n/Trans';
import { t as translateNow } from '../../i18n/i18n';

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const hasLetter = (value: string): boolean => /[a-zA-Z]/.test(value);
const hasNumber = (value: string): boolean => /\d/.test(value);

/** Registration-parity rule: ≥8 chars with at least one letter and one number. */
function isStrongPassword(value: string): boolean {
  return value.length >= 8 && hasLetter(value) && hasNumber(value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const labelClass = 'mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]';

interface PasswordForm {
  readonly current: string;
  readonly next: string;
  readonly confirm: string;
}

const EMPTY_PASSWORD_FORM: PasswordForm = { current: '', next: '', confirm: '' };

/** Live inline banner, shared by both cards. */
function InlineAlert({
  tone,
  children,
}: {
  readonly tone: 'success' | 'error';
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border px-3 py-2 text-[13px]',
        tone === 'success'
          ? 'border-[var(--ds-success)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
          : 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
      )}
    >
      {children}
    </div>
  );
}

function PasswordToggle({
  shown,
  onToggle,
}: {
  readonly shown: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? t('settings.security.hidePassword') || 'Hide password' : t('settings.security.showPassword') || 'Show password'}
      aria-pressed={shown}
      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
    >
      {shown ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
    </button>
  );
}

// ── Change password ──────────────────────────────────────────────────────────

interface ChangePasswordCardProps {
  readonly isOperator: boolean;
}

/**
 * Change-password card. Branches on account kind since the two principals
 * hit different endpoints: clients use `changeClientPassword`
 * (`POST /client/change-password`), operators use `operatorChangePassword`
 * (`POST /auth/operator-change-password`).
 */
export function ChangePasswordCard({ isOperator }: ChangePasswordCardProps): ReactElement {
  const { t } = useTranslation();
  const [form, setForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const confirmMismatch = form.confirm.length > 0 && form.confirm !== form.next;
  const canSubmit =
    !saving &&
    form.current.length > 0 &&
    form.confirm.length > 0 &&
    form.confirm === form.next &&
    isStrongPassword(form.next);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError('');
    setSuccess('');

    if (form.next !== form.confirm) {
      setError(t('settings.security.passwordsDoNotMatch') || 'New passwords do not match.');
      return;
    }
    if (!isStrongPassword(form.next)) {
      setError(
        translateNow('settings.security.passwordRule') ||
          'New password must be at least 8 characters and include a letter and a number.',
      );
      return;
    }

    setSaving(true);
    try {
      if (isOperator) {
        await operatorChangePassword(form.current, form.next);
      } else {
        await changeClientPassword(form.current, form.next);
      }
      setForm(EMPTY_PASSWORD_FORM);
      setShowCurrent(false);
      setShowNext(false);
      setSuccess(t('settings.security.passwordChanged') || 'Your password has been changed.');
    } catch (err) {
      setError(toMessage(err, t('settings.security.passwordChangeFailed') || 'We couldn’t change your password. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={handleSubmit} className="p-5 sm:p-6">
        <SectionHeader
          title={t('settings.security.password') || 'Password'}
          description={
            t('settings.security.passwordDescription') ||
            'Update your sign-in password. Use at least 8 characters with a letter and a number.'
          }
          actions={
            // Recovery for a password you can't remember. The public
            // /forgot-password page already owns the full email-OTP reset flow;
            // its `requestPasswordReset` / `resetPassword` api.js functions are
            // not present in api.d.ts, so we can't safely inline that OTP flow
            // here under strict types - we route to that page instead of
            // reaching for untyped imports. Clients only: operators reset via
            // their workspace owner (same as the standalone page).
            !isOperator ? (
              <Link
                to="/forgot-password"
                className="text-[12px] font-medium text-[var(--ds-accent-text)] transition-colors hover:underline"
              >
                {t('settings.security.forgotPassword') || 'Forgot your password?'}
              </Link>
            ) : undefined
          }
        />

        {!isOperator && (
          <p className="mt-2 text-[12px] text-[var(--ds-text-subtle)]">
            {t('settings.security.forgotHintPrefix') || 'Don’t remember your current password? Use'}{' '}
            <Link to="/forgot-password" className="font-medium text-[var(--ds-accent-text)] hover:underline">
              {t('settings.security.forgotPassword') || 'Forgot your password?'}
            </Link>{' '}
            {t('settings.security.forgotHintSuffix') || 'to reset it with a code sent to your email.'}
          </p>
        )}

        <div aria-live="polite" className="mt-4 empty:hidden">
          {error && <InlineAlert tone="error">{error}</InlineAlert>}
          {success && <InlineAlert tone="success">{success}</InlineAlert>}
        </div>

        <div className="mt-4 grid max-w-md gap-4">
          <div>
            <label htmlFor="account-security-current-password" className={labelClass}>
              {t('settings.security.currentPassword') || 'Current password'}
            </label>
            <div className="relative">
              <Input
                id="account-security-current-password"
                type={showCurrent ? 'text' : 'password'}
                required
                autoComplete="current-password"
                placeholder={t('settings.security.currentPasswordPlaceholder') || 'Your current password'}
                className="pr-10"
                value={form.current}
                onChange={(event) => setForm((prev) => ({ ...prev, current: event.target.value }))}
              />
              <PasswordToggle shown={showCurrent} onToggle={() => setShowCurrent((v) => !v)} />
            </div>
          </div>

          <div>
            <label htmlFor="account-security-new-password" className={labelClass}>
              {t('settings.security.newPassword') || 'New password'}
            </label>
            <div className="relative">
              <Input
                id="account-security-new-password"
                type={showNext ? 'text' : 'password'}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder={t('settings.security.newPasswordPlaceholder') || 'At least 8 characters, a letter and a number'}
                aria-describedby="account-security-new-password-hint"
                className="pr-10"
                value={form.next}
                onChange={(event) => setForm((prev) => ({ ...prev, next: event.target.value }))}
              />
              <PasswordToggle shown={showNext} onToggle={() => setShowNext((v) => !v)} />
            </div>
            <p id="account-security-new-password-hint" className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]">
              {t('settings.security.passwordRuleHint') ||
                'Must be at least 8 characters and include a letter and a number.'}
            </p>
          </div>

          <div>
            <label htmlFor="account-security-confirm-password" className={labelClass}>
              {t('settings.security.confirmNewPassword') || 'Confirm new password'}
            </label>
            <Input
              id="account-security-confirm-password"
              type="password"
              required
              autoComplete="new-password"
              placeholder={t('settings.security.confirmPlaceholder') || 'Repeat your new password'}
              aria-invalid={confirmMismatch}
              aria-describedby={confirmMismatch ? 'account-security-confirm-error' : undefined}
              className={cn(
                confirmMismatch &&
                  'border-[var(--ds-danger)] focus-visible:border-[var(--ds-danger)] focus-visible:shadow-[0_0_0_1px_var(--ds-danger)]',
              )}
              value={form.confirm}
              onChange={(event) => setForm((prev) => ({ ...prev, confirm: event.target.value }))}
            />
            {confirmMismatch && (
              <p id="account-security-confirm-error" className="mt-1.5 text-[12px] text-[var(--ds-danger)]">
                {t('settings.security.passwordsDoNotMatchShort') || 'Passwords do not match.'}
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
                {t('settings.security.changePassword') || 'Change password'}
              </>
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Change email ─────────────────────────────────────────────────────────────

type EmailStep = 'idle' | 'request' | 'verify';

interface ChangeEmailCardProps {
  readonly user: CurrentUser;
  readonly onEmailChange: (patch: { email?: string; pending_email?: string | null }) => void;
}

/**
 * Change-email card, client accounts only. Three steps: idle (show current
 * email) → request (new email + current password, `requestClientEmailChange`)
 * → verify (OTP, `confirmClientEmailChange`). If the account already has a
 * pending change on load (`user.pending_email`, restored across page
 * reloads) we resume straight into `verify`.
 *
 * "Resend" re-uses the same request call, but the current password isn't
 * cached across reloads (it's never persisted, only held in memory for the
 * lifetime of this component) - so resuming a pending change from a fresh
 * load routes Resend back through the request step, pre-filled, honestly
 * asking for the password again rather than faking a passwordless resend.
 */
export function ChangeEmailCard({ user, onEmailChange }: ChangeEmailCardProps): ReactElement {
  const { t } = useTranslation();
  const [step, setStep] = useState<EmailStep>(user.pending_email ? 'verify' : 'idle');
  const [newEmail, setNewEmail] = useState(user.pending_email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const pendingEmail = user.pending_email ?? null;

  const startRequest = (): void => {
    setNewEmail('');
    setCurrentPassword('');
    setError('');
    setSuccess('');
    setStep('request');
  };

  const startResend = (): void => {
    // We don't have a cached password to resend silently - route back
    // through the request form, pre-filled with the pending address.
    setNewEmail(pendingEmail ?? '');
    setCurrentPassword('');
    setError('');
    setSuccess('');
    setStep('request');
  };

  const cancel = async (): Promise<void> => {
    const hadPending = step === 'verify' || Boolean(pendingEmail);
    setStep('idle');
    setError('');
    setSuccess('');
    setOtp('');
    setCurrentPassword('');
    if (!hadPending) return;
    setBusy(true);
    try {
      await cancelClientEmailChange();
      onEmailChange({ pending_email: null });
    } catch (err) {
      setError(toMessage(err, t('settings.security.emailCancelFailed') || 'Failed to cancel the email change.'));
      setStep('verify');
    } finally {
      setBusy(false);
    }
  };

  const handleRequest = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError('');
    const email = newEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setError(t('settings.security.emailInvalid') || 'Enter a valid email address.');
      return;
    }
    if (email.toLowerCase() === (user.email ?? '').toLowerCase()) {
      setError(t('settings.security.emailSame') || 'That’s already your current email address.');
      return;
    }
    if (!currentPassword) {
      setError(t('settings.security.emailNeedPassword') || 'Enter your current password to confirm this change.');
      return;
    }
    setBusy(true);
    try {
      const result = await requestClientEmailChange(email, currentPassword);
      onEmailChange({ pending_email: result.pending_email });
      setCurrentPassword('');
      setOtp('');
      setSuccess('');
      setStep('verify');
    } catch (err) {
      setError(toMessage(err, t('settings.security.emailStartFailed') || 'Failed to start the email change.'));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError('');
    if (!otp.trim()) {
      setError(t('settings.security.emailNeedCode') || 'Enter the verification code.');
      return;
    }
    setBusy(true);
    try {
      const updated = await confirmClientEmailChange(otp.trim());
      onEmailChange({ email: updated.email, pending_email: null });
      setOtp('');
      setStep('idle');
      setSuccess(t('settings.security.emailUpdated') || 'Email address updated.');
    } catch (err) {
      setError(
        toMessage(
          err,
          translateNow('settings.security.emailConfirmFailed') ||
            'Failed to confirm the email change.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="p-5 sm:p-6">
        <SectionHeader
          title={t('settings.security.emailAddress') || 'Email address'}
          description={t('settings.changingYourLoginEmailRequires') || 'Changing your login email requires your current password and a code sent to the new address.'}
          actions={
            step === 'idle' ? (
              <Button variant="outline" size="sm" onClick={startRequest}>
                <Mail size={14} aria-hidden="true" />
                {t('settings.security.change') || 'Change'}
              </Button>
            ) : undefined
          }
        />

        <div aria-live="polite" className="mt-4 empty:hidden">
          {error && <InlineAlert tone="error">{error}</InlineAlert>}
          {success && <InlineAlert tone="success">{success}</InlineAlert>}
        </div>

        {step === 'idle' && (
          <div className="mt-4 flex items-center justify-between gap-4 py-1">
            <span className="text-[13px] text-[var(--ds-text-muted)]">
              {t('settings.security.currentEmail') || 'Current email'}
            </span>
            <span className="truncate text-[13px] font-medium text-[var(--ds-text)]">
              {user.email ?? '-'}
            </span>
          </div>
        )}

        {step === 'request' && (
          <form onSubmit={handleRequest} className="mt-4 grid max-w-md gap-4">
            <div>
              <label htmlFor="account-security-new-email" className={labelClass}>
                {t('settings.security.newEmail') || 'New email'}
              </label>
              <Input
                id="account-security-new-email"
                type="email"
                required
                autoComplete="email"
                // @i18n-exempt: an example address showing the expected FORMAT.
                // The shape is the same in every language.
                placeholder="you@example.com"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="account-security-email-password" className={labelClass}>
                {t('settings.security.currentPassword') || 'Current password'}
              </label>
              <Input
                id="account-security-email-password"
                type="password"
                required
                autoComplete="current-password"
                placeholder={t('settings.security.confirmItsYou') || "Confirm it's you"}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? (
                  'Sending…'
                ) : (
                  <>
                    <Mail size={16} aria-hidden="true" />
                    {t('settings.security.sendCode') || 'Send verification code'}
                  </>
                )}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                <X size={16} aria-hidden="true" />
                {t('common.cancel') || 'Cancel'}
              </Button>
            </div>
          </form>
        )}

        {step === 'verify' && (
          <form onSubmit={handleConfirm} className="mt-4 grid max-w-md gap-4">
            <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-warning)]">
              <ShieldAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>
                <Trans
                  k="settings.security.verificationPending"
                  fallback="Verification pending for {pending}. Enter the code we emailed there to finish the change - your login email stays {current} until then."
                  values={{
                    pending: <strong>{pendingEmail ?? newEmail}</strong>,
                    current: <strong>{user.email ?? 'unchanged'}</strong>,
                  }}
                />
              </span>
            </div>
            <div>
              <label htmlFor="account-security-email-otp" className={labelClass}>
                {t('settings.security.verificationCode') || 'Verification code'}
              </label>
              <Input
                id="account-security-email-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t('settings.security.codePlaceholder') || '6-digit code'}
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
              />
              <button
                type="button"
                onClick={startResend}
                disabled={busy}
                className="mt-1.5 text-[12px] font-medium text-[var(--ds-accent-text)] transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('settings.security.resendCode') || 'Didn’t receive a code? Resend'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? (
                  'Confirming…'
                ) : (
                  <>
                    <Check size={16} aria-hidden="true" />
                    {t('settings.security.confirmChange') || 'Confirm change'}
                  </>
                )}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                <X size={16} aria-hidden="true" />
                {t('settings.security.cancelChange') || 'Cancel change'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

export interface AccountSecuritySectionProps {
  readonly user: CurrentUser;
  /** Bubbles email/pending_email changes up so the profile section above stays in sync. */
  readonly onEmailChange: (patch: { email?: string; pending_email?: string | null }) => void;
}

/**
 * AccountSecuritySection - the Settings ▸ Account security surface: change
 * password (both account kinds) and change email (client accounts only).
 * Operators don't own an in-app email-change flow - the backend has no
 * endpoint for it - so they see an honest disabled note instead of a faked
 * form.
 */
export function AccountSecuritySection({ user, onEmailChange }: AccountSecuritySectionProps): ReactElement {
  const { t } = useTranslation();
  const isOperator = user.kind === 'operator';

  return (
    <section aria-labelledby="account-security-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="account-security-heading">{t('settings.security.title') || 'Account security'}</span>
        }
        description={t('settings.manageHowYouSignIn') || 'Manage how you sign in.'}
      />
      <div className="space-y-4">
        <ChangePasswordCard isOperator={isOperator} />

        {isOperator ? (
          <Card>
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ds-text)]">
                  <Mail size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                  {t('settings.security.emailAddress') || 'Email address'}
                </p>
                <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                  {t('settings.security.operatorEmailNote') ||
                    'Contact your workspace owner to change your email - operator accounts don’t have a self-serve email change.'}
                </p>
              </div>
              <StatusBadge tone="neutral" className="shrink-0">
                {t('settings.security.notAvailable') || 'Not available'}
              </StatusBadge>
            </div>
          </Card>
        ) : (
          <ChangeEmailCard user={user} onEmailChange={onEmailChange} />
        )}
      </div>
    </section>
  );
}

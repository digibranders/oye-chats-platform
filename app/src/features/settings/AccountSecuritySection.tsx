import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  toast,
  validateEmail,
} from '../../ui';
import {
  cancelClientEmailChange,
  changeClientPassword,
  confirmClientEmailChange,
  operatorChangePassword,
  requestClientEmailChange,
} from '../../services/api';
import type { CurrentUser } from '../../types/domain';
import { OtpField } from '../../pages/auth/OtpField';
import { PasswordRules } from '../../pages/auth/PasswordRules';
import { errorMessage, passwordMeetsRules } from '../../pages/auth/authFlow';

/**
 * The two credentials the account signs in with.
 *
 * They live in one card rather than two because they are one subject, and
 * because splitting them gave the previous page two independent "success"
 * banners that could both be on screen saying different things.
 */

// ── Password ────────────────────────────────────────────────────────────────

function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Hide password' : 'Show password'}
      className="rounded-sm p-1 text-text-tertiary transition-colors hover:text-text-primary"
    >
      {shown ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
    </button>
  );
}

export function ChangePasswordCard({ isOperator }: { isOperator: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});

  const change = useMutation({
    mutationFn: async (): Promise<void> => {
      // The two endpoints answer with different shapes; neither is used, and
      // widening the mutation's result type would only invite someone to.
      if (isOperator) await operatorChangePassword(current, next);
      else await changeClientPassword(current, next);
    },
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setShowCurrent(false);
      setShowNext(false);
      setErrors({});
      toast.success('Password changed', {
        description: 'Use the new one next time you sign in.',
      });
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Field-level, not one shared banner: the previous card put "passwords do
    // not match" above the form, where it was nowhere near either field.
    const found: typeof errors = {};
    if (!current) found.current = 'Enter your current password.';
    if (!passwordMeetsRules(next)) {
      found.next = 'Your new password needs 8 characters, a letter and a number.';
    }
    if (confirm !== next) found.confirm = 'This does not match the new password.';
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    change.mutate();
  }

  return (
    <Card>
      <CardHeader
        title="Password"
        titleAs="h2"
        description="Changing it here does not sign you out of this browser."
      />
      <form onSubmit={submit}>
        <CardBody className="space-y-5">
          {change.isError ? (
            <Alert tone="danger" live title="We could not change your password">
              {errorMessage(change.error, 'Please check your current password and try again.')}
            </Alert>
          ) : null}

          <Field
            label="Current password"
            required
            error={errors.current}
            hint={
              isOperator ? undefined : (
                <>
                  Cannot remember it?{' '}
                  <Link
                    to="/forgot-password"
                    className="font-medium text-accent-600 underline-offset-2 hover:underline"
                  >
                    Reset it by email
                  </Link>
                  .
                </>
              )
            }
          >
            <Input
              type={showCurrent ? 'text' : 'password'}
              autoComplete="current-password"
              value={current}
              onChange={(event) => {
                setCurrent(event.target.value);
                setErrors((found) => ({ ...found, current: undefined }));
              }}
              trailing={
                <PasswordToggle
                  shown={showCurrent}
                  onToggle={() => setShowCurrent((value) => !value)}
                />
              }
            />
          </Field>

          <Field
            label="New password"
            required
            error={errors.next}
            hint={<PasswordRules value={next} />}
          >
            <Input
              type={showNext ? 'text' : 'password'}
              autoComplete="new-password"
              value={next}
              onChange={(event) => {
                setNext(event.target.value);
                setErrors((found) => ({ ...found, next: undefined }));
              }}
              trailing={
                <PasswordToggle shown={showNext} onToggle={() => setShowNext((value) => !value)} />
              }
            />
          </Field>

          <Field label="Confirm new password" required error={errors.confirm}>
            <Input
              type={showNext ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
                setErrors((found) => ({ ...found, confirm: undefined }));
              }}
            />
          </Field>
        </CardBody>
        <div className="flex justify-end gap-2 rounded-b-[inherit] border-t border-border bg-surface-sunken px-5 py-3">
          <Button type="submit" loading={change.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Email ───────────────────────────────────────────────────────────────────

type EmailStep = 'idle' | 'request' | 'verify';

export interface ChangeEmailCardProps {
  user: CurrentUser;
  onEmailChange: (patch: { email?: string; pending_email?: string | null }) => void;
}

/**
 * Moving the sign-in address.
 *
 * Three steps, and it survives a reload: `pending_email` on the profile is what
 * says a change is already in flight, so someone who closed the tab before
 * entering the code comes back to the code step rather than to a form that
 * would start a second change.
 *
 * Resending routes back through the request form on purpose. The current
 * password is held in memory and never persisted, so a "resend" after a reload
 * has nothing to resend with — asking for the password again is honest, where
 * a silent resend button that 401s is not.
 */
export function ChangeEmailCard({ user, onEmailChange }: ChangeEmailCardProps) {
  const pending = user.pending_email ?? null;
  const [step, setStep] = useState<EmailStep>(pending ? 'verify' : 'idle');
  const [email, setEmail] = useState(pending ?? '');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const request = useMutation({
    mutationFn: () => requestClientEmailChange(email.trim(), password),
    onSuccess: (result) => {
      onEmailChange({ pending_email: result.pending_email });
      setPassword('');
      setOtp('');
      setStep('verify');
    },
  });

  const confirmChange = useMutation({
    mutationFn: () => confirmClientEmailChange(otp.trim()),
    onSuccess: (updated) => {
      onEmailChange({ email: updated.email, pending_email: null });
      setOtp('');
      setStep('idle');
      toast.success('Email address updated', {
        description: 'Sign in with the new address from now on.',
      });
    },
  });

  const cancelChange = useMutation({
    mutationFn: cancelClientEmailChange,
    onSuccess: () => {
      onEmailChange({ pending_email: null });
      setConfirmingCancel(false);
      setStep('idle');
      setOtp('');
      setPassword('');
      toast.success('Email change cancelled');
    },
  });

  function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    const reason = trimmed ? validateEmail(trimmed) : 'Enter the new email address.';
    if (reason) {
      setEmailError(reason);
      return;
    }
    if (trimmed.toLowerCase() === (user.email ?? '').toLowerCase()) {
      setEmailError('That is already your address.');
      return;
    }
    if (!password) {
      setPasswordError('Enter your current password to confirm this change.');
      return;
    }
    setEmailError(null);
    setPasswordError(null);
    request.mutate();
  }

  function submitConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (!otp.trim()) {
      setOtpError('Enter the code we emailed to the new address.');
      return;
    }
    setOtpError(null);
    confirmChange.mutate();
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Sign-in email"
          titleAs="h2"
          description="Your address only moves once you have proved you can read the new inbox."
          actions={
            step === 'idle' ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEmail('');
                  setPassword('');
                  setEmailError(null);
                  setPasswordError(null);
                  setStep('request');
                }}
              >
                Change
              </Button>
            ) : undefined
          }
        />

        {step === 'idle' ? (
          <CardBody>
            <p className="text-xs text-text-tertiary">Current address</p>
            <p className="figure mt-0.5 text-base text-text-primary">{user.email ?? '—'}</p>
          </CardBody>
        ) : null}

        {step === 'request' ? (
          <form onSubmit={submitRequest}>
            <CardBody className="space-y-5">
              {request.isError ? (
                <Alert tone="danger" live title="We could not start that change">
                  {errorMessage(request.error, 'Please check the address and your password.')}
                </Alert>
              ) : null}

              <Field
                label="New email address"
                required
                hint="We send a code there. Your sign-in address does not move until you enter it."
                error={emailError}
              >
                <Input
                  type="email"
                  value={email}
                  autoComplete="off"
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setEmailError(null);
                  }}
                />
              </Field>

              <Field
                label="Current password"
                required
                hint="Proves it is you, not somebody who found your screen unlocked."
                error={passwordError}
              >
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError(null);
                  }}
                />
              </Field>
            </CardBody>
            <div className="flex justify-end gap-2 rounded-b-[inherit] border-t border-border bg-surface-sunken px-5 py-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep(pending ? 'verify' : 'idle');
                  setEmailError(null);
                  setPasswordError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={request.isPending}>
                Send the code
              </Button>
            </div>
          </form>
        ) : null}

        {step === 'verify' ? (
          <form onSubmit={submitConfirm}>
            <CardBody className="space-y-5">
              <Alert tone="neutral" title="Check the new inbox">
                We sent a code to{' '}
                <strong className="text-text-primary">{pending ?? email}</strong>. Until you enter
                it, keep signing in with {user.email ?? 'your current address'}.
              </Alert>

              {confirmChange.isError ? (
                <Alert tone="danger" live title="That code did not work">
                  {errorMessage(confirmChange.error, 'Check the code and try again.')}
                </Alert>
              ) : null}

              <OtpField
                value={otp}
                onChange={setOtp}
                label="Verification code"
                error={otpError}
                autoFocus
              />
            </CardBody>
            <div className="flex flex-wrap justify-end gap-2 rounded-b-[inherit] border-t border-border bg-surface-sunken px-5 py-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingCancel(true)}
                disabled={cancelChange.isPending}
              >
                Cancel the change
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEmail(pending ?? email);
                  setPassword('');
                  setStep('request');
                }}
              >
                Send it again
              </Button>
              <Button type="submit" loading={confirmChange.isPending}>
                Confirm new address
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      <ConfirmDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        title="Cancel this email change?"
        description={
          <>
            Your sign-in address stays {user.email ?? 'as it is'} and the code we sent to{' '}
            {pending ?? email} stops working. Nothing else changes, and you can start again
            whenever you like.
          </>
        }
        confirmLabel="Cancel the change"
        cancelLabel="Keep it pending"
        onConfirm={async () => {
          await cancelChange.mutateAsync();
        }}
      />
    </>
  );
}

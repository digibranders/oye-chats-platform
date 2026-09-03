import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  ABSENT,
  Alert,
  Button,
  CardBody,
  CardFooter,
  ConfirmDialog,
  Input,
  SettingBand,
  SettingGroup,
  SettingRow,
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
import { useTranslation } from '../../i18n/useTranslation';

/**
 * The two credentials the account signs in with.
 *
 * They live in one card rather than two because they are one subject, and
 * because splitting them gave the previous page two independent "success"
 * banners that could both be on screen saying different things.
 */

// ── Password ────────────────────────────────────────────────────────────────

export function ChangePasswordCard({ isOperator }: { isOperator: boolean }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{
    current?: string;
    next?: string;
    confirm?: string;
  }>({});

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
      setErrors({});
      toast.success(t('settings.passwordChanged') || 'Password changed', {
        description: t('settings.useTheNewOneNext') || 'Use the new one next time you sign in.',
      });
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Field-level, not one shared banner: the previous card put "passwords do
    // not match" above the form, where it was nowhere near either field.
    const found: typeof errors = {};
    if (!current) found.current = t('settings.enterYourCurrentPassword') || 'Enter your current password.';
    if (!passwordMeetsRules(next)) {
      found.next = t('settings.yourNewPasswordNeeds8') || 'Your new password needs 8 characters, a letter and a number.';
    }
    if (confirm !== next) found.confirm = t('settings.thisDoesNotMatchThe') || 'This does not match the new password.';
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    change.mutate();
  }

  return (
    <SettingGroup title={t('settings.password') || 'Password'}>
      <form onSubmit={submit}>
        {change.isError ? (
          <SettingBand>
            <Alert tone="danger" live title={t('settings.weCouldNotChangeYour') || 'We could not change your password'}>
              {errorMessage(change.error, t('settings.pleaseCheckYourCurrentPassword') || 'Please check your current password and try again.')}
            </Alert>
          </SettingBand>
        ) : null}

        <SettingRow
          label={t('settings.currentPassword') || 'Current password'}
          htmlFor={`${fieldId}-current`}
          error={errors.current}
          description={
            isOperator ? undefined : (
              <>
                {t('settings.cannotRememberIt') || 'Cannot remember it?'}{' '}
                <Link
                  to="/forgot-password"
                  className="font-medium text-accent-600 underline-offset-2 hover:underline"
                >
                  {t('settings.resetItByEmail') || 'Reset it by email'}
                </Link>
                .
              </>
            )
          }
        >
          {/* `Input revealable` owns the toggle. This file and the affiliate
              invite shipped byte-identical `PasswordToggle`s, both 24px inside
              a 34px control and neither reporting its own state. */}
          <Input
            id={`${fieldId}-current`}
            type="password"
            revealable
            required
            autoComplete="current-password"
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
              setErrors((found) => ({ ...found, current: undefined }));
            }}
          />
        </SettingRow>

        {/* Not `stacked`. The rules are a description, and a description
            belongs in the label column: stacking put a full-width input under
            them, so the middle one of three password fields was 672px wide
            while the two around it were 256px. The rules sit under the label
            like every other row's hint and the three controls line up. */}
        <SettingRow
          label={t('settings.newPassword') || 'New password'}
          htmlFor={`${fieldId}-next`}
          error={errors.next}
          description={<PasswordRules value={next} />}
        >
          <Input
            id={`${fieldId}-next`}
            type="password"
            revealable
            required
            autoComplete="new-password"
            value={next}
            onChange={(event) => {
              setNext(event.target.value);
              setErrors((found) => ({ ...found, next: undefined }));
            }}
          />
        </SettingRow>

        <SettingRow
          label={t('settings.confirmNewPassword') || 'Confirm new password'}
          htmlFor={`${fieldId}-confirm`}
          error={errors.confirm}
        >
          <Input
            id={`${fieldId}-confirm`}
            type="password"
            revealable
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => {
              setConfirm(event.target.value);
              setErrors((found) => ({ ...found, confirm: undefined }));
            }}
          />
        </SettingRow>

        <CardFooter>
          <Button type="submit" loading={change.isPending}>
            {t('settings.changePassword') || 'Change password'}
          </Button>
        </CardFooter>
      </form>
    </SettingGroup>
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
  const { t } = useTranslation();
  const emailFieldId = useId();
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
      toast.success(t('settings.emailAddressUpdated') || 'Email address updated', {
        description: t('settings.signInWithTheNew') || 'Sign in with the new address from now on.',
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
      toast.success(t('settings.emailChangeCancelled') || 'Email change cancelled');
    },
  });

  function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    const reason = trimmed ? validateEmail(trimmed) : t('settings.enterTheNewEmailAddress') || 'Enter the new email address.';
    if (reason) {
      setEmailError(reason);
      return;
    }
    if (trimmed.toLowerCase() === (user.email ?? '').toLowerCase()) {
      setEmailError(t('settings.thatIsAlreadyYourAddress') || 'That is already your address.');
      return;
    }
    if (!password) {
      setPasswordError(t('settings.enterYourCurrentPasswordTo') || 'Enter your current password to confirm this change.');
      return;
    }
    setEmailError(null);
    setPasswordError(null);
    request.mutate();
  }

  function submitConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (!otp.trim()) {
      setOtpError(t('settings.enterTheCodeWeEmailed') || 'Enter the code we emailed to the new address.');
      return;
    }
    setOtpError(null);
    confirmChange.mutate();
  }

  return (
    <>
      <SettingGroup
        title={t('settings.signInEmail') || 'Sign-in email'}
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
              {t('settings.change') || 'Change'}
            </Button>
          ) : undefined
        }
      >
        {step === 'idle' ? (
          <SettingRow label={t('settings.currentAddress') || 'Current address'} controlWidth="auto">
            <span className="figure text-base text-text-primary">{user.email ?? ABSENT}</span>
          </SettingRow>
        ) : null}

        {step === 'request' ? (
          <form onSubmit={submitRequest}>
            {request.isError ? (
              <SettingBand>
                <Alert tone="danger" live title={t('settings.weCouldNotStartThat') || 'We could not start that change'}>
                  {errorMessage(request.error, t('settings.pleaseCheckTheAddressAnd') || 'Please check the address and your password.')}
                </Alert>
              </SettingBand>
            ) : null}

            <SettingRow
              label={t('settings.newEmailAddress') || 'New email address'}
              htmlFor={`${emailFieldId}-new`}
              description={t('settings.yourAddressDoesNotMove') || 'Your address does not move until you enter the code.'}
              error={emailError ?? undefined}
            >
              <Input
                id={`${emailFieldId}-new`}
                type="email"
                required
                value={email}
                autoComplete="off"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(null);
                }}
              />
            </SettingRow>

            <SettingRow
              label={t('settings.currentPassword') || 'Current password'}
              htmlFor={`${emailFieldId}-password`}
              error={passwordError ?? undefined}
            >
              <Input
                id={`${emailFieldId}-password`}
                type="password"
                revealable
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setPasswordError(null);
                }}
              />
            </SettingRow>

            <CardFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep(pending ? 'verify' : 'idle');
                  setEmailError(null);
                  setPasswordError(null);
                }}
              >
                {t('settings.cancel') || 'Cancel'}
              </Button>
              <Button type="submit" loading={request.isPending}>
                {t('settings.sendTheCode') || 'Send the code'}
              </Button>
            </CardFooter>
          </form>
        ) : null}

        {step === 'verify' ? (
          <form onSubmit={submitConfirm}>
            <CardBody className="space-y-5">
              <Alert tone="neutral" title={t('settings.checkTheNewInbox') || 'Check the new inbox'}>
                We sent a code to <strong className="text-text-primary">{pending ?? email}</strong>.
                Until you enter it, keep signing in with {user.email ?? 'your current address'}.
              </Alert>

              {confirmChange.isError ? (
                <Alert tone="danger" live title={t('settings.thatCodeDidNotWork') || 'That code did not work'}>
                  {errorMessage(confirmChange.error, t('settings.checkTheCodeAndTry') || 'Check the code and try again.')}
                </Alert>
              ) : null}

              <OtpField
                value={otp}
                onChange={setOtp}
                label={t('settings.verificationCode') || 'Verification code'}
                error={otpError}
                autoFocus
              />
            </CardBody>
            <CardFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingCancel(true)}
                disabled={cancelChange.isPending}
              >
                {t('settings.cancelTheChange') || 'Cancel the change'}
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
                {t('settings.sendItAgain') || 'Send it again'}
              </Button>
              <Button type="submit" loading={confirmChange.isPending}>
                {t('settings.confirmNewAddress') || 'Confirm new address'}
              </Button>
            </CardFooter>
          </form>
        ) : null}
      </SettingGroup>

      <ConfirmDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        title={t('settings.cancelThisEmailChange') || 'Cancel this email change?'}
        description={
          <>
            Your sign-in address stays {user.email ?? 'as it is'} and the code we sent to{' '}
            {pending ?? email} stops working. You can start again whenever you like.
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

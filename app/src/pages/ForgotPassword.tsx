import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { CheckCircle2, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { Alert, Button, Field, Input, buttonClass, validateEmail } from '../ui';
import { requestPasswordReset, resetPassword } from '../services/api';
import { AuthShell } from './auth/AuthShell';
import { OtpField } from './auth/OtpField';
import { PasswordRules } from './auth/PasswordRules';
import { useResendCooldown } from './auth/useResendCooldown';
import { OTP_LENGTH, digitsOnly, errorMessage, maskEmail, passwordMeetsRules } from './auth/authFlow';

const requestSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .refine((value) => validateEmail(value) === null, 'That does not look like an email address.'),
});

const resetSchema = z.object({
  code: z
    .string()
    .trim()
    .length(OTP_LENGTH, `The code is ${OTP_LENGTH} digits.`),
  password: z
    .string()
    .refine(passwordMeetsRules, 'Your password needs 8 characters, a letter and a number.'),
});

type RequestValues = z.infer<typeof requestSchema>;
type ResetValues = z.infer<typeof resetSchema>;

type Stage = 'request' | 'reset' | 'done';

/**
 * Reset a forgotten password.
 *
 * The screen it replaces was the odd one out among the two OTP flows in this
 * product. It had no resend cooldown at all while verification enforced thirty
 * seconds, so the same rate limiter behaved differently depending on which door
 * you came through. Its second step never showed which address had been sent a
 * code and offered no way back to change it, so a typo was a dead end. Its code
 * box was free text with no numeric keyboard and no length. And it revealed the
 * password rules only as an error after a failed submit, while the signup form
 * listed them up front. All four now come from the same shared pieces as
 * verification, which is the only way they stay the same next time.
 */
export default function ForgotPassword() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('request');
  const [email, setEmail] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const cooldown = useResendCooldown();
  // Stage 3 replaces the whole screen, so without this focus falls to `<body>`
  // and a keyboard user tabs from the top of the document to reach "Sign in".
  // Stage 2 moves focus on its own, through `OtpField autoFocus`.
  const doneRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (stage === 'done') doneRef.current?.focus();
  }, [stage]);

  const requestForm = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    mode: 'onTouched',
    defaultValues: { email: '' },
  });

  const resetForm = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    mode: 'onTouched',
    defaultValues: { code: '', password: '' },
  });

  // `useWatch` rather than `resetForm.watch`: it subscribes to one field, and
  // it is the form of the API the compiler can reason about.
  const code = useWatch({ control: resetForm.control, name: 'code' });
  const newPassword = useWatch({ control: resetForm.control, name: 'password' });

  // Read during render so the form-state proxy actually subscribes to it.
  const resetAttempted = resetForm.formState.isSubmitted;

  const requestCode = useMutation({
    mutationFn: (address: string) => requestPasswordReset(address),
    onSuccess: (_data, address) => {
      setEmail(address);
      setStage('reset');
      cooldown.start();
    },
  });

  const commitReset = useMutation({
    mutationFn: (values: ResetValues) => resetPassword(email, values.code, values.password),
    onSuccess: () => setStage('done'),
  });

  /** Carry the address to sign-in so the last step is one field, not two. */
  const signInHref = email ? `/login?email=${encodeURIComponent(email)}` : '/login';

  if (stage === 'done') {
    return (
      <AuthShell title="Password changed">
        <div className="space-y-4">
          <Alert tone="success" live icon={<CheckCircle2 aria-hidden className="h-4 w-4" />}>
            Every other session on this account has been signed out.
          </Alert>
          {/* No timed redirect. The screen this replaces called `setTimeout`
              with no cleanup, so the navigation fired even after the component
              had gone — and it moved the page out from under anyone still
              reading it. */}
          <Link ref={doneRef} to={signInHref} className={buttonClass('primary', 'lg', 'w-full')}>
            Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (stage === 'reset') {
    return (
      <AuthShell
        title="Choose a new password"
        description={
          <>
            We sent a six-digit code to{' '}
            <span className="figure text-text-primary">{maskEmail(email)}</span>.
          </>
        }
        back={{ to: '/login', label: 'Back to sign in' }}
        secondary={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => requestCode.mutate(email)}
            loading={requestCode.isPending}
            disabled={cooldown.active}
            iconLeft={<RotateCcw aria-hidden />}
          >
            {cooldown.active ? `Resend in ${cooldown.remaining}s` : 'Resend code'}
          </Button>
        }
        footer={
          <>
            Wrong address?{' '}
            <button
              type="button"
              onClick={() => {
                setStage('request');
                requestCode.reset();
                commitReset.reset();
                resetForm.reset();
                requestForm.setValue('email', email);
              }}
              className={buttonClass('link')}
            >
              Use a different email
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {commitReset.isError ? (
            <Alert tone="danger" live>
              {errorMessage(commitReset.error, 'We could not reset your password. Please try again.')}
            </Alert>
          ) : null}

          {requestCode.isSuccess && !commitReset.isError ? (
            <Alert tone="success" live>
              Code sent. Check your spam folder too.
            </Alert>
          ) : null}

          <form
            onSubmit={resetForm.handleSubmit((values) => commitReset.mutate(values))}
            noValidate
            className="space-y-4"
          >
            <OtpField
              value={code}
              // Re-validate on every keystroke only once the form has been
              // submitted: telling someone the code is six digits while they
              // are typing the first one is not help.
              onChange={(raw) =>
                resetForm.setValue('code', digitsOnly(raw), { shouldValidate: resetAttempted })
              }
              error={resetForm.formState.errors.code?.message}
              disabled={commitReset.isPending}
              autoFocus
            />

            <Field
              label="New password"
              error={resetForm.formState.errors.password?.message}
              hint={<PasswordRules value={newPassword} />}
              required
            >
              <Input
                type={revealPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Choose a password"
                trailing={
                  <button
                    type="button"
                    onClick={() => setRevealPassword((shown) => !shown)}
                    aria-label={revealPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={revealPassword}
                    className="grid h-6 w-6 place-items-center rounded-xs text-text-tertiary transition-colors hover:text-text-primary"
                  >
                    {revealPassword ? (
                      <EyeOff aria-hidden className="h-4 w-4" />
                    ) : (
                      <Eye aria-hidden className="h-4 w-4" />
                    )}
                  </button>
                }
                {...resetForm.register('password')}
              />
            </Field>

            <Button type="submit" variant="primary" size="lg" block loading={commitReset.isPending}>
              Set new password
            </Button>
          </form>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      description="We will send a six-digit code."
      back={{ to: '/login', label: 'Back to sign in' }}
      footer={
        <>
          Remembered it?{' '}
          <button
            type="button"
            onClick={() => navigate('/login')}
            className={buttonClass('link')}
          >
            Sign in
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {requestCode.isError ? (
          <Alert tone="danger" live>
            {errorMessage(requestCode.error, 'We could not send a code. Please try again.')}
          </Alert>
        ) : null}

        <form
          onSubmit={requestForm.handleSubmit((values) => requestCode.mutate(values.email))}
          noValidate
          className="space-y-4"
        >
          <Field label="Email address" error={requestForm.formState.errors.email?.message} required>
            <Input
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              {...requestForm.register('email')}
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" block loading={requestCode.isPending}>
            Send code
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}

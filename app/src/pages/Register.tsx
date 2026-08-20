import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { Eye, EyeOff } from 'lucide-react';
import { Alert, Button, Field, Input, buttonClass, validateEmail } from '../ui';
import { registerClient } from '../services/api';
import { getAuthItem, isSessionExpired, setAuthBundle } from '../utils/authStorage';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { GoogleAuthButton } from '../components/GoogleAuthButton';
import { AuthDivider, AuthShell } from './auth/AuthShell';
import { PasswordRules } from './auth/PasswordRules';
import { useGoogleAuthAvailable } from './auth/useGoogleAuth';
import {
  currentSessionDoor,
  errorMessage,
  isEmailTakenError,
  passwordMeetsRules,
  postAuthDestination,
  safeRelativePath,
} from './auth/authFlow';

const PROMO_STORAGE_KEY = 'oyechats_promo_code';

const schema = z.object({
  name: z.string().trim().min(2, 'Enter your name — at least two characters.'),
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .refine((value) => validateEmail(value) === null, 'That does not look like an email address.'),
  password: z
    .string()
    .refine(passwordMeetsRules, 'Your password needs 8 characters, a letter and a number.'),
});

type RegisterValues = z.infer<typeof schema>;

/**
 * Read the campaign code, preferring a fresh one in the URL.
 *
 * The query string is fragile — hopping to sign-in and back drops it, and two
 * live campaigns lost their attribution exactly that way — so a code seen once
 * is kept for the session. First touch wins: a new `?code=` always replaces a
 * stored one.
 */
function readPromoCode(fromUrl: string): string {
  if (fromUrl) return fromUrl;
  try {
    return window.sessionStorage.getItem(PROMO_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Create an account.
 *
 * Three fields, down from seven. Company and website were optional and are
 * asked again where they matter — the workspace settings and the chatbot's
 * first run, which needs the website anyway in order to crawl it. Billing
 * country was asked before the visitor had been shown a single price, and the
 * server already resolves it from the request's edge headers when the field is
 * absent, so the question bought nothing. Confirm-password is gone with the
 * reveal toggle in its place: one field the user can read back is more reliable
 * than two they cannot, and the single show/hide control here used to drive
 * both boxes at once, which defeated the point of the second one entirely.
 */
export default function Register() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const next = safeRelativePath(searchParams.get('next'));
  const affiliateToken = searchParams.get('affiliate_token') ?? '';
  const invitedEmail = (searchParams.get('email') ?? '').trim();
  const urlPromoCode = searchParams.get('code') ?? '';
  const promoCode = readPromoCode(urlPromoCode);

  const [arrivedSignedIn] = useState(
    () => Boolean(getAuthItem('admin_token')) && !isSessionExpired(),
  );
  const [revealPassword, setRevealPassword] = useState(false);
  // See `Login`: the button renders nothing without an OAuth client, so the
  // divider cannot be unconditional.
  const googleAvailable = useGoogleAuthAvailable();

  // In an effect, not in the component body. This write used to run during
  // render — on every render, and twice per mount under StrictMode.
  useEffect(() => {
    if (!urlPromoCode) return;
    try {
      window.sessionStorage.setItem(PROMO_STORAGE_KEY, urlPromoCode);
    } catch {
      /* private mode: the URL parameter still carries the code for this visit */
    }
  }, [urlPromoCode]);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { name: '', email: invitedEmail, password: '' },
  });

  // `useWatch` rather than `form.watch`: it subscribes to one field instead of
  // re-rendering the form on every keystroke in any of them.
  const password = useWatch({ control: form.control, name: 'password' });

  const signUp = useMutation({
    mutationFn: (values: RegisterValues) =>
      registerClient(
        values.name,
        values.email,
        values.password,
        null,
        null,
        null,
        promoCode || null,
      ),
    onSuccess: (data, values) => {
      clearTrialBannerDismissals();

      // Signup stays remembered by default — someone who has just created an
      // account did not ask to be signed out tomorrow.
      setAuthBundle({
        admin_token: data.access_token,
        admin_name: data.name,
        admin_client_id: String(data.client_id),
        admin_is_verified: data.is_verified ? 'true' : 'false',
        admin_pending_email: values.email,
        auth_type: 'client',
        is_superadmin: 'false',
        company_name: data.company_name || '',
        company_website: data.website || '',
      });

      // An email/password signup proves it owns the address before it can use
      // the product: unverified accounts were farming trial credits and crawl
      // compute. Google accounts are exempt — the provider verified the address
      // at source. Any deep link rides through the OTP screen as `next`.
      const afterVerify = postAuthDestination({ next, affiliateToken, door: 'client' });
      if (data.is_verified) {
        navigate(afterVerify, { replace: true });
      } else {
        navigate(`/verify-email?next=${encodeURIComponent(afterVerify)}`, { replace: true });
      }
    },
  });

  // Decided once, at mount. Registering writes a token before it navigates, so
  // a guard that re-reads storage every render would fire on the render after a
  // successful signup and send the new account to its default destination
  // rather than to the verification screen.
  if (arrivedSignedIn) {
    return (
      <Navigate
        to={postAuthDestination({ next, affiliateToken, door: currentSessionDoor() })}
        replace
      />
    );
  }

  const emailTaken = signUp.isError && isEmailTakenError(signUp.error);
  // Carry the address and any deep link across, so signing in continues the
  // journey the person was actually on.
  const signInParams = new URLSearchParams();
  if (form.getValues('email')) signInParams.set('email', form.getValues('email'));
  if (next) signInParams.set('next', next);

  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent-600 hover:text-accent-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <GoogleAuthButton
        label="Continue with Google"
        mode="register"
        promoCode={promoCode}
        next={postAuthDestination({ next, affiliateToken, door: 'client' })}
      />

      {googleAvailable ? <AuthDivider /> : null}

      {/* The address is already taken. This used to navigate silently to the
          sign-in page with the error cleared, so from the visitor's side
          "Create account" simply moved them somewhere else with no explanation.
          The answer stays here, beside the button that produced it. */}
      {signUp.isError ? (
        <Alert
          tone={emailTaken ? 'warning' : 'danger'}
          live
          className="mb-4"
          title={emailTaken ? 'That email already has an account' : undefined}
          action={
            emailTaken ? (
              <Link to={`/login?${signInParams.toString()}`} className={buttonClass('secondary', 'sm')}>
                Sign in
              </Link>
            ) : undefined
          }
        >
          {emailTaken
            ? 'Sign in instead, or use a different address.'
            : errorMessage(signUp.error, 'We could not create your account. Please try again.')}
        </Alert>
      ) : null}

      <form onSubmit={form.handleSubmit((values) => signUp.mutate(values))} noValidate className="space-y-4">
        <Field label="Your name" error={form.formState.errors.name?.message} required>
          <Input
            type="text"
            autoComplete="name"
            autoFocus
            placeholder="Priya Sharma"
            {...form.register('name')}
          />
        </Field>

        <Field label="Work email" error={form.formState.errors.email?.message} required>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            {...form.register('email')}
          />
        </Field>

        <Field
          label="Password"
          error={form.formState.errors.password?.message}
          hint={<PasswordRules value={password} />}
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
            {...form.register('password')}
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={signUp.isPending}>
          Create account
        </Button>

        {/* One consent statement covering both paths, under the primary submit.
            It used to sit between the Google button and the divider, where it
            read as a footnote to Google sign-in while "Create account" 100px
            below had no legal text near it at all. Signing up is the consenting
            act; there is no checkbox to forget to tick. */}
        <p className="text-xs leading-relaxed text-text-secondary">
          By creating an account you agree to our{' '}
          <a
            href="https://www.oyechats.com/legal/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent-600 hover:text-accent-700 hover:underline"
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            href="https://www.oyechats.com/legal/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent-600 hover:text-accent-700 hover:underline"
          >
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </AuthShell>
  );
}

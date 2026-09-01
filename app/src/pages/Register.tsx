import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { Eye, EyeOff } from 'lucide-react';
import { Alert, Button, Combobox, Field, Input, buttonClass, validateEmail } from '../ui';
import { detectCountry, registerClient } from '../services/api';
import { COUNTRY_OPTIONS } from '../data/countries';
import { getAuthItem, isSessionExpired, setAuthBundle } from '../utils/authStorage';
import { GoogleAuthButton } from './auth/GoogleAuthButton';
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
import { useTranslation } from '../i18n/useTranslation';
import { Trans } from '../i18n/Trans';

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
  /**
   * Required, and asked here rather than inferred later.
   *
   * It sets the account's tax rail: IN bills in INR with GST, everywhere else
   * is an export in USD. The charge gate refuses to resolve that from an IP
   * signal alone -- it 409s `billing_country_required` -- because a VPN or a
   * corporate egress choosing the wrong rail is a money bug, not a display
   * one. Detection prefills this field, but what makes the value usable is
   * that a person saw it and submitted it. A confirmed country here is also
   * what stops a customer meeting that 409 mid-checkout, on the one screen
   * where an interruption costs the most.
   */
  billing_country: z
    .string()
    .trim()
    .length(2, 'Choose the country you are billed in.'),
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
  const { t } = useTranslation();
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
    // `billing_country: ''` rather than left undefined: the schema's own
    // message ("Choose the country you are billed in.") only fires on a string,
    // and an undefined value reports a type error instead, which is the wrong
    // sentence for someone who simply has not picked yet.
    defaultValues: { name: '', email: invitedEmail, password: '', billing_country: '' },
  });

  // `useWatch` rather than `form.watch`: it subscribes to one field instead of
  // re-rendering the form on every keystroke in any of them.
  const password = useWatch({ control: form.control, name: 'password' });
  const billingCountry = useWatch({ control: form.control, name: 'billing_country' });

  /**
   * Prefill the country from the edge headers, once, and never over a choice.
   *
   * `detectCountry` returns null on a direct origin hit (local dev, no CDN in
   * front), which is why the field falls back to an unselected placeholder
   * rather than defaulting to India: silently pre-picking the primary market
   * for someone the edge could not place is how a US customer ends up on the
   * INR rail without ever having been asked.
   *
   * `getValues` rather than the watched value, and no dependency on it: this
   * must not re-run and overwrite a country the person has already chosen if
   * the request resolves late.
   */
  useEffect(() => {
    let cancelled = false;
    void detectCountry()
      .then((code) => {
        if (cancelled || !code) return;
        if (form.getValues('billing_country')) return;
        form.setValue('billing_country', code, { shouldValidate: true });
      })
      // A convenience that failed is still a convenience. The field is
      // required, so an unreachable detect leaves the person choosing from
      // the picker -- which is the same thing they do when the edge cannot
      // place them. Swallowing beats an unhandled rejection on the one screen
      // where an error boundary would cost a signup.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [form]);

  const signUp = useMutation({
    mutationFn: (values: RegisterValues) =>
      registerClient(
        values.name,
        values.email,
        values.password,
        null,
        null,
        values.billing_country,
        promoCode || null,
      ),
    onSuccess: (data, values) => {
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
      title={t('auth.createYourAccount') || 'Create your account'}
      footer={
        <>
          <Trans
            k="auth.alreadyHaveAccount"
            fallback="Already have an account? {link}"
            values={{
              link: (
                <Link
                  to="/login"
                  className="font-medium text-accent-600 hover:text-accent-700 hover:underline"
                >
                  {t('auth.signIn') || 'Sign in'}
                </Link>
              ),
            }}
          />
        </>
      }
    >
      <GoogleAuthButton
        label={t('auth.continueWithGoogle') || 'Continue with Google'}
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
          title={emailTaken ? t('auth.thatEmailAlreadyHasAn') || 'That email already has an account' : undefined}
          action={
            emailTaken ? (
              <Link to={`/login?${signInParams.toString()}`} className={buttonClass('secondary', 'sm')}>
                {t('auth.signIn') || 'Sign in'}
              </Link>
            ) : undefined
          }
        >
          {emailTaken
            ? t('auth.signInInsteadOrUse') || 'Sign in instead, or use a different address.'
            : errorMessage(signUp.error, t('auth.weCouldNotCreateYour') || 'We could not create your account. Please try again.')}
        </Alert>
      ) : null}

      <form onSubmit={form.handleSubmit((values) => signUp.mutate(values))} noValidate className="space-y-4">
        <Field label={t('auth.yourName') || 'Your name'} error={form.formState.errors.name?.message} required>
          <Input
            type="text"
            autoComplete="name"
            autoFocus
            placeholder={t('auth.priyaSharma') || 'Priya Sharma'}
            {...form.register('name')}
          />
        </Field>

        <Field label={t('auth.workEmail') || 'Work email'} error={form.formState.errors.email?.message} required>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            {...form.register('email')}
          />
        </Field>

        <Field
          label={t('auth.country') || 'Country'}
          error={form.formState.errors.billing_country?.message}
          hint={t('auth.thisSetsYourCurrency') || 'This sets your currency and tax. You can change it later in Billing.'}
          required
        >
          <Combobox
            label={t('auth.country') || 'Country'}
            options={COUNTRY_OPTIONS}
            value={billingCountry || null}
            onValueChange={(next) =>
              form.setValue('billing_country', next ?? '', { shouldValidate: true })
            }
          />
        </Field>

        <Field
          label={t('auth.password') || 'Password'}
          error={form.formState.errors.password?.message}
          hint={<PasswordRules value={password} />}
          required
        >
          <Input
            type={revealPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('auth.chooseAPassword') || 'Choose a password'}
            trailing={
              <button
                type="button"
                onClick={() => setRevealPassword((shown) => !shown)}
                aria-label={revealPassword ? t('auth.hidePassword') || 'Hide password' : t('auth.showPassword') || 'Show password'}
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
          {t('auth.createAccount') || 'Create account'}
        </Button>

        {/* One consent statement covering both paths, under the primary submit.
            It used to sit between the Google button and the divider, where it
            read as a footnote to Google sign-in while "Create account" 100px
            below had no legal text near it at all. Signing up is the consenting
            act; there is no checkbox to forget to tick. */}
        <p className="text-xs leading-relaxed text-text-secondary">
          <Trans
            k="auth.byCreatingAccount"
            fallback="By creating an account you agree to our {terms} and {privacy}."
            values={{
              terms: (
                <a
                  href="https://www.oyechats.com/legal/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent-600 hover:text-accent-700 hover:underline"
                >
                  {t('auth.terms') || 'Terms'}
                </a>
              ),
              privacy: (
                <a
                  href="https://www.oyechats.com/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent-600 hover:text-accent-700 hover:underline"
                >
                  {t('auth.privacyPolicy') || 'Privacy Policy'}
                </a>
              ),
            }}
          />
        </p>
      </form>
    </AuthShell>
  );
}

import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { Eye, EyeOff } from 'lucide-react';
import { Alert, Button, Checkbox, Field, Input, validateEmail } from '../ui';
import { loginAdmin, loginOperator } from '../services/api';
import { getAuthItem, isSessionExpired, setAuthBundle } from '../utils/authStorage';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { GoogleAuthButton } from './auth/GoogleAuthButton';
import { AuthDivider, AuthShell } from './auth/AuthShell';
import { useGoogleAuthAvailable } from './auth/useGoogleAuth';
import {
  currentSessionDoor,
  errorMessage,
  otherDoor,
  postAuthDestination,
  readPreferredDoor,
  rememberDoor,
  safeRelativePath,
  type SignInDoor,
} from './auth/authFlow';

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .refine((value) => validateEmail(value) === null, 'That does not look like an email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

type LoginValues = z.infer<typeof schema>;

/** The HTTP status the backend uses for "wrong credentials", and only that. */
const UNAUTHORIZED = 401;

const DOOR_PROMPT: Record<SignInDoor, { hint: string; action: string }> = {
  client: {
    hint: 'Invited as a team member? Your password is on the team sign-in.',
    action: 'Team sign-in',
  },
  operator: {
    hint: 'Own the workspace? Use the owner sign-in.',
    action: 'Owner sign-in',
  },
};

/**
 * Sign in.
 *
 * Two things worth knowing before changing anything here.
 *
 * **One request per attempt.** Customers and team members authenticate against
 * two different endpoints with two different passwords, and a wrong password
 * looks identical from both. The screen this replaces resolved that by trying
 * the customer endpoint and then the operator endpoint on every failure, so a
 * mistyped customer password cost two round trips before the error appeared and
 * spent a failed-attempt count against an operator account with the same
 * address. Now the door that last worked on this device is tried, once, and the
 * other one is offered as an explicit action on the error.
 *
 * **No tab order of our own.** Every control here used to carry a positive
 * `tabIndex`, which puts it ahead of everything with `tabIndex={0}` in the
 * document — so the primary Google button was reached last, after "Sign up
 * free". Source order is the tab order.
 */
export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const next = safeRelativePath(searchParams.get('next'));
  const affiliateToken = searchParams.get('affiliate_token') ?? '';
  // The invite airlock sends invitees here as `?email=…`, pre-filled but not
  // locked: someone may genuinely want to sign in under a different address,
  // and the airlock re-checks the match on the way back.
  const invitedEmail = (searchParams.get('email') ?? '').trim();

  const [arrivedSignedIn] = useState(
    () => Boolean(getAuthItem('admin_token')) && !isSessionExpired(),
  );
  const [door, setDoor] = useState<SignInDoor>(readPreferredDoor);
  // The button renders nothing on a deployment with no OAuth client, so the
  // divider above it has to ask the same question rather than always drawing a
  // rule with the word OR and nothing over it.
  const googleAvailable = useGoogleAuthAvailable();
  const [revealPassword, setRevealPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    // Errors appear once a field has been visited and left, not while the user
    // is still typing the value that would clear them.
    mode: 'onTouched',
    defaultValues: { email: invitedEmail, password: '' },
  });

  /** The persisted session, shaped for whichever door answered. */
  interface SignInResult {
    door: SignInDoor;
    bundle: Record<string, string>;
  }

  const signIn = useMutation<SignInResult, unknown, LoginValues & { as: SignInDoor }>({
    mutationFn: async ({ email, password, as }) => {
      if (as === 'operator') {
        const data = await loginOperator(email, password);
        const bundle: Record<string, string> = {
          admin_token: data.access_token,
          admin_name: data.name,
          admin_client_id: String(data.client_id),
          auth_type: 'operator',
          operator_role: data.role,
          operator_id: String(data.operator_id),
          is_superadmin: 'false',
          company_name: data.company_name ?? '',
          company_website: data.website ?? '',
          // An operator never sees the setup checklist: it is the workspace
          // owner's, and the steps deep-link into surfaces a team member has no
          // access to.
          onboarding_complete: 'true',
        };
        if (data.default_bot_id != null) bundle.selected_bot_id = String(data.default_bot_id);
        return { door: 'operator', bundle };
      }

      const data = await loginAdmin(email, password);
      return {
        door: 'client',
        bundle: {
          admin_token: data.access_token,
          admin_name: data.name,
          admin_client_id: String(data.client_id),
          // Verification is not a wall for an organic sign-in: an unverified
          // customer carries on to their destination, and the server holds the
          // mutations that genuinely require a confirmed address.
          admin_is_verified: data.is_verified ? 'true' : 'false',
          auth_type: 'client',
          is_superadmin: data.is_superadmin ? 'true' : 'false',
          company_name: data.company_name ?? '',
          company_website: data.website ?? '',
        },
      };
    },
    onSuccess: ({ door: opened, bundle }) => {
      // A fresh sign-in clears banner dismissals carried over from whichever
      // account used this browser last.
      clearTrialBannerDismissals();
      rememberDoor(opened);
      setAuthBundle(bundle, rememberMe);
      navigate(postAuthDestination({ next, affiliateToken, door: opened }), { replace: true });
    },
  });

  // A live session never sees this form. A *lapsed* one does: keying off the
  // mere presence of a token sent an expired session to the dashboard, where it
  // 401'd straight back here.
  //
  // Decided once, at mount, and never re-read. Signing in writes a token, so a
  // guard that re-reads storage on every render fires on the render that
  // follows a successful sign-in and sends the user to the default destination
  // instead of the one the sign-in chose.
  if (arrivedSignedIn) {
    return (
      <Navigate
        to={postAuthDestination({ next, affiliateToken, door: currentSessionDoor() })}
        replace
      />
    );
  }

  const submit = form.handleSubmit((values) => signIn.mutate({ ...values, as: door }));

  const retryOtherDoor = () => {
    const alternate = otherDoor(door);
    setDoor(alternate);
    signIn.mutate({ ...form.getValues(), as: alternate });
  };

  const failedCredentials =
    signIn.isError && (signIn.error as { status?: number })?.status === UNAUTHORIZED;

  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          New to OyeChats?{' '}
          <Link to="/register" className="font-medium text-accent-600 hover:text-accent-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <GoogleAuthButton
        label="Continue with Google"
        mode="login"
        next={postAuthDestination({ next, affiliateToken, door: 'client' })}
      />

      {googleAvailable ? <AuthDivider /> : null}

      {signIn.isError ? (
        // Two lines, one of them scannable. It used to glue two sentences into
        // one 160-character run with a literal leading space, while `Alert`'s
        // own `title` slot sat unused.
        <Alert
          tone="danger"
          live
          className="mb-4"
          title={
            failedCredentials
              ? 'Email or password is incorrect'
              : undefined
          }
          action={
            failedCredentials ? (
              <Button size="sm" onClick={retryOtherDoor} loading={signIn.isPending}>
                {DOOR_PROMPT[door].action}
              </Button>
            ) : undefined
          }
        >
          {failedCredentials
            ? DOOR_PROMPT[door].hint
            : errorMessage(signIn.error, 'We could not sign you in. Please try again.')}
        </Alert>
      ) : null}

      {/* `noValidate`: the browser's own bubbles are unstyled, disappear on
          blur and are not reachable by a screen reader. Every rule here is
          enforced in the resolver and rendered by the field. */}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Email address" error={form.formState.errors.email?.message} required>
          <Input
            type="email"
            autoComplete="email"
            autoFocus={!invitedEmail}
            placeholder="you@company.com"
            {...form.register('email')}
          />
        </Field>

        <div>
          <Field label="Password" error={form.formState.errors.password?.message} required>
            <Input
              type={revealPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Your password"
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
          <div className="mt-1.5 text-right">
            <Link
              to="/forgot-password"
              className="text-xs font-medium text-accent-600 hover:text-accent-700 hover:underline"
            >
              Forgot your password?
            </Link>
          </div>
        </div>

        <Checkbox
          checked={rememberMe}
          onCheckedChange={(checked) => setRememberMe(checked === true)}
          label="Stay signed in"
        />

        <Button type="submit" variant="primary" size="lg" block loading={signIn.isPending}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

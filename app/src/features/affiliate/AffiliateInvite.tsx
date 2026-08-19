import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff } from 'lucide-react';
import { Alert, Button, Field, Input, Spinner, buttonClass } from '../../ui';
import {
  acceptAffiliateInvite,
  acceptAffiliateInviteExisting,
  lookupAffiliateInvite,
} from '../../services/api';
import { clearAuthStorage, getAuthItem, setAuthBundle } from '../../utils/authStorage';
import { endImpersonationSessionFromSignOut } from '../../utils/impersonation';
import { AuthShell } from '../../pages/auth/AuthShell';
import { PasswordRules } from '../../pages/auth/PasswordRules';
import { errorMessage, passwordMeetsRules } from '../../pages/auth/authFlow';

/**
 * `/affiliate-invite?token=…` — the partner magic link.
 *
 * Three arrivals, and the page has to tell them apart before it can be useful:
 *
 * 1. **Signed in, right account** — wire the affiliate row onto the existing
 *    client and say so.
 * 2. **Signed in, wrong account** — a 403 means the token was issued to a
 *    different address, so offer the way out rather than the error.
 * 3. **Not signed in at all** — and this is the case the console this replaces
 *    could not serve. It offered "Sign in" and "Create your account", the
 *    second of which sent the invitee to the ordinary signup, created a plain
 *    customer, and bounced them back here to accept a second time — except the
 *    token is one-shot, so a stumble anywhere in that round trip burned the
 *    invitation. `POST /affiliate-invites/accept` exists precisely to avoid
 *    that: it creates the Client and the Affiliate atomically and returns a
 *    session token. The client function had been written and never called
 *    (ledger: `acceptAffiliateInvite`). It is the form below.
 */

const schema = z.object({
  name: z.string().trim().min(2, 'Enter your name — at least two characters.'),
  password: z
    .string()
    .refine(passwordMeetsRules, 'Your password needs 8 characters, a letter and a number.'),
  companyName: z.string().trim().optional(),
  website: z.string().trim().optional(),
});

type SignupValues = z.infer<typeof schema>;

function statusOf(error: unknown): number | undefined {
  const withStatus = error as { response?: { status?: number }; status?: number } | null;
  return withStatus?.response?.status ?? withStatus?.status;
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function AffiliateInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const signedIn = Boolean(getAuthItem('admin_token'));

  const [lookup, setLookup] = useState<
    | { status: 'loading' }
    | { status: 'invalid'; message: string }
    | { status: 'ready'; email: string; expiresAt: string | null }
  >(() =>
    token
      ? { status: 'loading' }
      : { status: 'invalid', message: 'This link is missing its invitation token.' },
  );

  const [accepted, setAccepted] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // 1) Resolve the token. Never fires without one, so the "invalid" state above
  //    is a real derived state rather than a flash of loading.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    lookupAffiliateInvite(token)
      .then((data) => {
        if (cancelled) return;
        setLookup({ status: 'ready', email: data.email, expiresAt: data.expires_at ?? null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLookup({
          status: 'invalid',
          message:
            statusOf(error) === 410
              ? 'This invitation has expired or has already been used. Ask your OyeChats contact for a fresh link.'
              : errorMessage(error, 'This invitation link is not valid.'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2) Signed in already — accept against the current account.
  useEffect(() => {
    if (lookup.status !== 'ready' || !signedIn || !token) return undefined;
    let cancelled = false;
    acceptAffiliateInviteExisting(token)
      .then(() => {
        if (!cancelled) setAccepted(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = statusOf(error);
        // 409 is "already an affiliate", which is the state we were trying to
        // reach. Treating it as a failure told partners their acceptance had
        // not worked when it had.
        if (status === 409) setAccepted(true);
        else if (status === 403) setMismatch(true);
        else setAcceptError(errorMessage(error, 'We could not add you to the partner programme.'));
      });
    return () => {
      cancelled = true;
    };
  }, [lookup.status, signedIn, token]);

  const form = useForm<SignupValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', password: '', companyName: '', website: '' },
    mode: 'onSubmit',
  });
  const password = useWatch({ control: form.control, name: 'password' }) ?? '';

  const signup = useMutation({
    mutationFn: (values: SignupValues) =>
      acceptAffiliateInvite({
        token,
        name: values.name.trim(),
        password: values.password,
        companyName: values.companyName?.trim() || null,
        website: values.website?.trim() || null,
      }),
    onSuccess: (data) => {
      // The response is shaped like `/auth/register`, so the invitee is signed
      // in here rather than being asked to log in with a password they typed
      // ten seconds ago.
      setAuthBundle({
        admin_token: data.access_token,
        admin_name: data.name,
        admin_client_id: String(data.client_id),
        auth_type: 'client',
        is_superadmin: 'false',
      });
      navigate('/settings/affiliate', { replace: true });
    },
  });

  const returnTo = `/affiliate-invite?token=${encodeURIComponent(token)}`;

  // ── Token could not be resolved ─────────────────────────────────────────────
  if (lookup.status === 'invalid') {
    return (
      <AuthShell
        title="This invitation is not available"
        description={lookup.message}
        footer={
          <>
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-accent-600 hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <Link to="/login" className={buttonClass('secondary', 'md')}>
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  // ── Resolving ───────────────────────────────────────────────────────────────
  if (lookup.status === 'loading') {
    return (
      <AuthShell title="Checking your invitation">
        <p className="flex items-center gap-2 text-prose text-text-secondary">
          <Spinner />
          One moment.
        </p>
      </AuthShell>
    );
  }

  const expiry = formatExpiry(lookup.expiresAt);

  // ── Signed in ───────────────────────────────────────────────────────────────
  if (signedIn) {
    if (accepted) {
      return (
        <AuthShell
          title="You are in the partner programme"
          description="Create referral codes, share their links, and earn a share of what everyone who signs up through them pays."
        >
          <Button block onClick={() => navigate('/settings/affiliate')}>
            Open your partner dashboard
          </Button>
        </AuthShell>
      );
    }

    if (mismatch) {
      return (
        <AuthShell
          title="This invitation is for a different account"
          description={
            <>
              It was sent to <strong className="text-text-primary">{lookup.email}</strong>, and you
              are signed in as someone else. Sign out and come back to this link with the invited
              address.
            </>
          }
        >
          <Button
            block
            variant="secondary"
            onClick={() => {
              // In an impersonated support session this must end the support
              // session only — the shared storage holds the super-admin's own
              // credentials for every other tab.
              if (endImpersonationSessionFromSignOut()) return;
              clearAuthStorage();
              // A full navigation so the guards re-read the now-empty storage
              // and this page falls through to the signed-out branch.
              window.location.assign(returnTo);
            }}
          >
            Sign out and use {lookup.email}
          </Button>
        </AuthShell>
      );
    }

    if (acceptError) {
      return (
        <AuthShell title="We could not accept the invitation">
          <Alert tone="danger" live className="mb-4">
            {acceptError}
          </Alert>
          <Button block variant="secondary" onClick={() => window.location.assign(returnTo)}>
            Try again
          </Button>
        </AuthShell>
      );
    }

    return (
      <AuthShell title="Adding you to the partner programme">
        <p className="flex items-center gap-2 text-prose text-text-secondary">
          <Spinner />
          One moment.
        </p>
      </AuthShell>
    );
  }

  // ── Not signed in — create the account and accept in one step ───────────────
  return (
    <AuthShell
      title="You are invited to partner with OyeChats"
      description={
        <>
          This invitation is for <strong className="text-text-primary">{lookup.email}</strong>.
          Choose a password and your partner account is ready.
          {expiry ? ` It is valid until ${expiry}.` : ''}
        </>
      }
      footer={
        <>
          Already have an OyeChats account?{' '}
          <Link
            to={`/login?next=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(lookup.email)}`}
            className="font-medium text-accent-600 hover:underline"
          >
            Sign in to accept
          </Link>
        </>
      }
    >
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => signup.mutate(values))}
        className="space-y-4"
      >
        {signup.isError ? (
          <Alert tone="danger" live title="We could not create your account">
            {errorMessage(
              signup.error,
              'Something went wrong. If this invitation has already been used, ask your OyeChats contact for a fresh link.',
            )}
          </Alert>
        ) : null}

        <Field label="Email" hint="Set by the invitation. It is the address we invited.">
          <Input value={lookup.email} readOnly disabled autoComplete="username" />
        </Field>

        <Field label="Your name" required error={form.formState.errors.name?.message}>
          <Input
            {...form.register('name')}
            placeholder="Priya Sharma"
            autoComplete="name"
            autoFocus
          />
        </Field>

        <Field
          label="Password"
          required
          error={form.formState.errors.password?.message}
          hint={<PasswordRules value={password} />}
        >
          <Input
            {...form.register('password')}
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            trailing={
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="rounded-sm p-1 text-text-tertiary transition-colors hover:text-text-primary"
              >
                {showPassword ? (
                  <EyeOff aria-hidden className="h-4 w-4" />
                ) : (
                  <Eye aria-hidden className="h-4 w-4" />
                )}
              </button>
            }
          />
        </Field>

        <Field label="Company" hint="Optional. Appears on the invoices we issue you.">
          <Input {...form.register('companyName')} placeholder="Acme Corporation" />
        </Field>

        <Field label="Website" hint="Optional.">
          <Input {...form.register('website')} placeholder="acme.com" inputMode="url" />
        </Field>

        <Button type="submit" block loading={signup.isPending}>
          Accept and create my account
        </Button>
      </form>
    </AuthShell>
  );
}

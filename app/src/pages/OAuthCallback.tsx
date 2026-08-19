import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, CardBody, Spinner } from '../ui';
import { getCurrentUser } from '../services/api';
import { clearAuthStorage, setAuthBundle, setAuthItem } from '../utils/authStorage';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { keys } from '../query/keys';
import { safeRelativePath } from './auth/authFlow';

/**
 * The backend's machine-readable OAuth failures, in words.
 *
 * Codes outside this table fall back to the generic message: an unrecognised
 * code is as likely to be a probe as a real failure, and echoing it back would
 * turn this page into a reflection point.
 */
const ERROR_MESSAGES: Record<string, string> = {
  oauth_unavailable: 'Google sign-in is not configured. Please use your email and password.',
  oauth_cancelled: 'Sign-in was cancelled. You can try again any time.',
  oauth_provider_error: 'Google reported an error while signing you in. Please try again.',
  oauth_missing_params: 'The sign-in link was incomplete. Please start again from the sign-in page.',
  oauth_state_mismatch: 'Your sign-in session expired or was tampered with. Please try again.',
  oauth_state_invalid: 'Your sign-in session expired. Please try again.',
  oauth_exchange_failed: 'We could not verify your sign-in with Google. Please try again.',
  oauth_email_unverified:
    'Your Google account’s email is not verified. Verify it with Google and try again.',
  oauth_email_has_password:
    'An account with this email already exists. Sign in with your password first, then link Google from your account settings.',
  oauth_internal_error: 'Something went wrong on our end. Please try again.',
};

const GENERIC_ERROR = ERROR_MESSAGES.oauth_internal_error;

/** How long the spinner is allowed to say nothing before it explains itself. */
const SLOW_AFTER_MS = 10_000;

type Callback =
  | { kind: 'error'; message: string }
  | { kind: 'working'; apiKey: string; next: string; isNew: boolean; isSuperadmin: boolean };

/**
 * Classify the landing URL synchronously, so the first paint is already the
 * right branch rather than a spinner that becomes an error.
 */
function classifyCallback(searchParams: URLSearchParams): Callback {
  const errorCode = searchParams.get('error');
  if (errorCode) {
    return { kind: 'error', message: ERROR_MESSAGES[errorCode] ?? GENERIC_ERROR };
  }

  const rawHash = typeof window === 'undefined' ? '' : window.location.hash;
  const fragment = new URLSearchParams(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash);
  const apiKey = fragment.get('api_key');
  if (!apiKey) {
    return { kind: 'error', message: ERROR_MESSAGES.oauth_missing_params };
  }

  return {
    kind: 'working',
    apiKey,
    next: safeRelativePath(searchParams.get('next')),
    isNew: searchParams.get('new') === '1',
    isSuperadmin: searchParams.get('superadmin') === '1',
  };
}

/**
 * Where Google drops the browser after a successful sign-in.
 *
 * The credential arrives in the URL fragment, which never reaches a server and
 * is scrubbed from history before anything else runs. Then one request for
 * `/auth/me`, because the shell needs a name and a role before it can draw a
 * rail, and the answer is cached under the same key the shell reads.
 *
 * **A failed `/auth/me` no longer routes to `/`.** It used to, on the theory
 * that a bad token would be caught by the 401 interceptor — which sent the user
 * straight back to the sign-in page with no explanation, so a genuinely broken
 * token looked exactly like a sign-in button that did nothing. Now the failure
 * is a screen with two ways out. Nor can the spinner run forever: after ten
 * seconds it says so and offers the same two.
 */
export default function OAuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [callback] = useState<Callback>(() => classifyCallback(searchParams));
  const [slow, setSlow] = useState(false);
  const scrubbed = useRef(false);

  useEffect(() => {
    if (callback.kind !== 'working' || scrubbed.current) return;
    scrubbed.current = true;
    // The fragment never reaches a server, but it is a live credential and it
    // has no business sitting in the browser's history either.
    window.history.replaceState({}, '', '/auth/callback');
  }, [callback]);

  const me = useQuery({
    queryKey: keys.session.me(),
    // Establishing the session is part of the fetch, not a step before it: the
    // API client reads the token out of storage on every request, so writing it
    // anywhere other than immediately ahead of the first call leaves the two
    // depending on the order two effects happen to run in. Every write is the
    // same value, so a retry costs nothing.
    queryFn: () => {
      if (callback.kind !== 'working') throw new Error('No credential to sign in with.');
      clearTrialBannerDismissals();
      // Google sign-ins stay signed in across restarts, the way Google's own
      // sessions do. The address is provider-verified, so the email gate is
      // already satisfied.
      setAuthBundle({
        admin_token: callback.apiKey,
        auth_type: 'client',
        admin_is_verified: 'true',
        is_superadmin: callback.isSuperadmin ? 'true' : 'false',
      });
      return getCurrentUser();
    },
    enabled: callback.kind === 'working',
  });

  useEffect(() => {
    if (!me.isPending) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [me.isPending]);

  useEffect(() => {
    const profile = me.data;
    if (callback.kind !== 'working' || !profile) return;

    if (profile.name) setAuthItem('admin_name', profile.name);
    if (typeof profile.id === 'number') setAuthItem('admin_client_id', String(profile.id));
    if (profile.company_name !== undefined) setAuthItem('company_name', profile.company_name ?? '');
    if (profile.website !== undefined) setAuthItem('company_website', profile.website ?? '');

    // A partner who is not a customer has no console to land in.
    // Otherwise: the deep link, or Home. Home is where a brand new account
    // belongs too — it opens with the setup checklist and with "create your
    // first chatbot" where the chatbot list would be, both derived from server
    // state. This page used to guess at that from `onboarding_complete` and
    // `bot_count` and send new accounts to a wizard, while the verification
    // screen sent every new account to the same wizard unconditionally. The two
    // disagreed about the same question; now neither one asks it.
    const destination = profile.is_affiliate_only ? '/settings/affiliate' : callback.next || '/';
    navigate(destination, { replace: true });
  }, [callback, me.data, navigate]);

  const abandon = () => {
    // The session was written before `/auth/me` was asked, so leaving here has
    // to take it with us — otherwise the sign-in page would bounce straight
    // back into a session we could not confirm.
    clearAuthStorage();
    navigate('/login', { replace: true });
  };

  if (callback.kind === 'error') {
    return <CallbackNotice tone="danger" title="Sign-in failed" message={callback.message} onBack={abandon} />;
  }

  if (me.isError) {
    return (
      <CallbackNotice
        tone="danger"
        title="We could not load your account"
        message="Google signed you in, but we could not reach OyeChats to finish. Your connection may have dropped."
        onBack={abandon}
        onRetry={() => void me.refetch()}
        retrying={me.isFetching}
      />
    );
  }

  if (slow && me.isPending) {
    return (
      <CallbackNotice
        tone="warning"
        title="This is taking longer than usual"
        message="We are still waiting on OyeChats. You can keep waiting, try again, or start over."
        onBack={abandon}
        onRetry={() => void me.refetch()}
        retrying={me.isFetching}
      />
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-4">
      <div className="flex items-center gap-2.5 text-base text-text-secondary">
        <Spinner label={null} />
        <p role="status">Signing you in…</p>
      </div>
    </main>
  );
}

function CallbackNotice({
  tone,
  title,
  message,
  onBack,
  onRetry,
  retrying = false,
}: {
  tone: 'danger' | 'warning';
  title: string;
  message: string;
  onBack: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        <img
          src="/new_dark.png"
          alt="OyeChats"
          className="mx-auto h-7 w-auto object-contain"
          draggable={false}
        />
        <Card className="mt-8">
          <CardBody className="p-5 sm:p-6">
            <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
            <Alert tone={tone} live className="mt-4">
              {message}
            </Alert>
            <div className="mt-5 flex flex-wrap gap-2">
              {onRetry ? (
                <Button variant="primary" onClick={onRetry} loading={retrying}>
                  Try again
                </Button>
              ) : null}
              <Button variant={onRetry ? 'secondary' : 'primary'} onClick={onBack}>
                Back to sign in
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck, RotateCcw } from 'lucide-react';
import { Alert, Button, Spinner } from '../ui';
import { getCurrentUser, resendVerification, verifyEmail } from '../services/api';
import {
  clearAuthStorage,
  getAuthItem,
  removeAuthItem,
  setAuthItem,
} from '../utils/authStorage';
import { endImpersonationSessionFromSignOut } from '../utils/impersonation';
import { keys } from '../query/keys';
import { AuthShell } from './auth/AuthShell';
import { OtpField } from './auth/OtpField';
import { useResendCooldown } from './auth/useResendCooldown';
import { OTP_LENGTH, digitsOnly, errorMessage, maskEmail, safeRelativePath } from './auth/authFlow';

/**
 * Confirm the email address.
 *
 * **Where a freshly verified account goes.** Home, or the deep link it was
 * reaching for — never a separate onboarding destination. Home already opens
 * with the setup checklist while it is incomplete and with "create your first
 * chatbot" where the list of chatbots would be, and every step of that
 * checklist is derived from server state, so it cannot be wrong about a brand
 * new account the way a routing guess can. This screen used to send *every*
 * verified signup to the wizard unconditionally while the OAuth callback made
 * the same decision from `onboarding_complete` and `bot_count`; the two
 * disagreed, and the wizard they disagreed about no longer exists. Sending both
 * to `/` removes the question rather than answering it twice, and it means the
 * first thing a new customer sees is the product with their work in it, not a
 * checklist about the product.
 *
 * **One navigation decision.** The screen it replaces ran two effects that both
 * asked "is this session already verified?" and both called `navigate` in the
 * same render pass. Here the two synchronous answers are render-level
 * redirects, the asynchronous one is a single effect, and all three funnel
 * through one `release()`.
 */
export default function VerifyEmail() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const destination = safeRelativePath(searchParams.get('next')) || '/';
  const hasSession = Boolean(getAuthItem('admin_token'));
  const alreadyVerified = getAuthItem('admin_is_verified') === 'true';

  /**
   * Ask the server who this session is.
   *
   * Two jobs, one request. It resolves the address when neither the URL nor
   * storage carries one — `admin_pending_email` is only ever written by the
   * signup form, so anyone who signs in on a second device arrives here with
   * nothing, and both verify and resend would refuse to act. And it reconciles
   * a stale `admin_is_verified: false`, which would otherwise be a closed loop:
   * gated in here, with nothing left to verify.
   */
  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    enabled: hasSession && !alreadyVerified,
    retry: false,
  });

  const email =
    (searchParams.get('email') ?? '').trim() ||
    getAuthItem('admin_pending_email') ||
    me.data?.email ||
    '';

  const [code, setCode] = useState('');
  const cooldown = useResendCooldown();
  // The last code this screen actually sent, so a complete value is submitted
  // once rather than on every keystroke that leaves it complete.
  const lastSubmitted = useRef('');

  const release = useCallback(() => {
    setAuthItem('admin_is_verified', 'true');
    removeAuthItem('admin_pending_email');
    // The shell reads the same `/auth/me` entry for the account menu; without
    // this it would keep serving the unverified snapshot from cache.
    void queryClient.invalidateQueries({ queryKey: keys.session.me() });
    navigate(destination, { replace: true });
  }, [destination, navigate, queryClient]);

  const resend = useMutation({
    mutationFn: () => resendVerification(email),
    onSuccess: () => {
      cooldown.start();
      setCode('');
      lastSubmitted.current = '';
    },
  });

  const verify = useMutation({
    mutationFn: (value: string) => verifyEmail(email, value),
    // Drop any standing "new code sent" notice: an expired-code error read as a
    // contradiction sitting directly underneath it.
    onMutate: () => resend.reset(),
    onSuccess: release,
    onError: () => {
      setCode('');
      lastSubmitted.current = '';
    },
  });

  // The one asynchronous navigation decision on this screen.
  useEffect(() => {
    if (me.data?.is_verified) release();
  }, [me.data?.is_verified, release]);

  if (!hasSession) return <Navigate to="/login" replace />;
  if (alreadyVerified) return <Navigate to={destination} replace />;

  const submit = (value: string) => {
    if (value.length < OTP_LENGTH || !email || verify.isPending) return;
    lastSubmitted.current = value;
    verify.mutate(value);
  };

  const handleCode = (raw: string) => {
    const digits = digitsOnly(raw);
    setCode(digits);
    // Submit as soon as the code is complete, however it got there — typed,
    // pasted, autofilled, or repaired after a backspace.
    if (digits.length === OTP_LENGTH && digits !== lastSubmitted.current) submit(digits);
  };

  const signOut = () => {
    // An impersonated tab ends only the support session; wiping the shared
    // bundle would take the super-admin's own credentials with it.
    if (endImpersonationSessionFromSignOut()) return;
    clearAuthStorage();
    navigate('/login', { replace: true });
  };

  // Nothing in the URL, nothing in storage, and the server could not tell us
  // either. Both actions on this screen need an address, so say so plainly and
  // give the way out as a real button — it used to be an eleven-pixel link at
  // the bottom of the page, under two controls that silently refused to work.
  const stranded = !email && me.isFetched;

  return (
    <AuthShell
      title="Confirm your email"
      description={
        email ? (
          <>
            We sent a six-digit code to{' '}
            <span className="figure text-text-primary">{maskEmail(email)}</span>. It is good for
            fifteen minutes.
          </>
        ) : (
          'Checking which account this is.'
        )
      }
    >
      {stranded ? (
        <div className="space-y-4">
          <Alert tone="danger" title="We could not tell which account to verify" live>
            This can happen when a sign-in link is opened in a different browser. Sign in again and
            we will send a fresh code.
          </Alert>
          <Button variant="primary" size="lg" block onClick={signOut}>
            Sign in again
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {verify.isError ? (
            <Alert tone="danger" live>
              {errorMessage(verify.error, 'That code was not accepted. Please try again.')}
            </Alert>
          ) : null}

          {resend.isSuccess ? (
            <Alert tone="success" live>
              New code sent — check your inbox, and your spam folder.
            </Alert>
          ) : null}

          {resend.isError ? (
            <Alert tone="danger" live>
              {errorMessage(resend.error, 'We could not send a new code. Please try again.')}
            </Alert>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(code);
            }}
            noValidate
            className="space-y-4"
          >
            <OtpField
              value={code}
              onChange={handleCode}
              disabled={verify.isPending || !email}
              autoFocus
              hint={
                !email && me.isPending ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner size="sm" label={null} />
                    Looking up your account…
                  </span>
                ) : (
                  'Paste it, or let your phone fill it in.'
                )
              }
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              loading={verify.isPending}
              disabled={code.length < OTP_LENGTH || !email}
              iconLeft={<MailCheck aria-hidden className="h-4 w-4" />}
            >
              Confirm email
            </Button>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => resend.mutate()}
              loading={resend.isPending}
              disabled={cooldown.active || !email}
              iconLeft={<RotateCcw aria-hidden className="h-3.5 w-3.5" />}
            >
              {cooldown.active ? `Resend in ${cooldown.remaining}s` : 'Resend code'}
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign in as someone else
            </Button>
          </div>
        </div>
      )}
    </AuthShell>
  );
}

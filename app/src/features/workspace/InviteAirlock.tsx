import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Spinner, buttonClass } from '../../ui';
import { acceptInvitePublic, getCurrentUser, getInvitePublic } from '../../services/api';
import { clearAuthStorage, getAuthItem, setAuthBundle } from '../../utils/authStorage';
import { endImpersonationSessionFromSignOut } from '../../utils/impersonation';
import { AuthShell } from '../../pages/auth/AuthShell';
import { errorMessage } from '../../pages/auth/authFlow';
import {
  RESOLVED_COPY,
  inviteRoleSentence,
  resolveAirlockState,
  type InviteMeta,
} from './inviteAirlockModel';

/**
 * `/invite/:token` — the team-invite airlock.
 *
 * A public page that has to work out who is standing in front of it before it
 * can do anything, so the whole decision lives in `resolveAirlockState` and is
 * tested there. What this file owns is what each answer looks like.
 *
 * The one rule it never breaks: it does not silently switch identities. A
 * visitor signed in as somebody else is asked to sign out, with the invited
 * address carried to the sign-in screen so they do not have to remember it.
 */

interface AcceptResult {
  workspace_id: number | string;
  workspace_name: string;
  role?: string;
}

export function InviteAirlock() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const signedIn = Boolean(getAuthItem('admin_token'));
  const operatorSession = getAuthItem('auth_type') === 'operator';
  const [accepted, setAccepted] = useState<AcceptResult | null>(null);

  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: async () => (await getInvitePublic(token)) as InviteMeta,
    enabled: token !== '',
    retry: false,
    staleTime: 60_000,
  });

  const me = useQuery({
    queryKey: ['invite', 'me'],
    queryFn: getCurrentUser,
    enabled: signedIn && !operatorSession,
    retry: false,
    staleTime: 60_000,
  });

  const accept = useMutation({
    mutationFn: async () => (await acceptInvitePublic(token)) as unknown as AcceptResult,
    onSuccess: (result) => {
      // The just-joined workspace becomes the active context *before* we
      // navigate, so the shell hydrates into it rather than into the invitee's
      // own empty workspace and then switching under them.
      setAuthBundle({
        current_workspace_id: String(result.workspace_id),
        current_workspace_name: result.workspace_name || '',
        current_workspace_role: result.role || 'operator',
      });
      setAccepted(result);
    },
  });

  // Land them in the product once the confirmation has been read. The legacy
  // `redirect_url` the API returns points at `/support`, a route that no longer
  // exists, so it is deliberately ignored in favour of one that always does.
  useEffect(() => {
    if (!accepted) return undefined;
    const timer = window.setTimeout(() => navigate('/inbox', { replace: true }), 1600);
    return () => window.clearTimeout(timer);
  }, [accepted, navigate]);

  if (accepted) {
    return (
      <AuthShell
        title={`Welcome to ${accepted.workspace_name || 'the workspace'}`}
        description="Taking you to the inbox, which is where your conversations arrive."
      >
        <p className="flex items-center gap-2 text-prose text-text-secondary">
          <Spinner />
          Setting things up.
        </p>
      </AuthShell>
    );
  }

  const state = resolveAirlockState({
    token,
    invite: invite.data ?? null,
    inviteFailed: invite.isError,
    signedIn,
    operatorSession,
    currentEmail: me.isPending && signedIn && !operatorSession ? undefined : (me.data?.email ?? null),
  });

  const meta = invite.data ?? {};
  const workspace = meta.workspace_name || 'this workspace';
  const invitedEmail = meta.email ?? '';
  const returnTo = `/invite/${encodeURIComponent(token)}`;

  function signOutAndSwitch(): void {
    // An impersonated tab must end only the support session — the shared
    // storage holds the super-admin's own credentials for every other tab.
    if (endImpersonationSessionFromSignOut()) return;
    clearAuthStorage();
    navigate(
      `/login?next=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(invitedEmail)}`,
    );
  }

  switch (state.kind) {
    case 'loading':
      return (
        <AuthShell title="Checking your invitation">
          <p className="flex items-center gap-2 text-prose text-text-secondary">
            <Spinner />
            One moment.
          </p>
        </AuthShell>
      );

    case 'identifying':
      return (
        <AuthShell title="Checking your account">
          <p className="flex items-center gap-2 text-prose text-text-secondary">
            <Spinner />
            One moment.
          </p>
        </AuthShell>
      );

    case 'invalid':
      return (
        <AuthShell
          title="This invitation link is not valid"
          description="It may have been mistyped, or it may have been replaced by a newer one. Ask whoever invited you to send it again."
        >
          <Link to="/login" className={buttonClass('secondary', 'md')}>
            Go to sign in
          </Link>
        </AuthShell>
      );

    case 'resolved': {
      const copy = RESOLVED_COPY[state.status];
      return (
        <AuthShell title={copy.title} description={copy.description}>
          <Link to="/login" className={buttonClass('secondary', 'md')}>
            Go to sign in
          </Link>
        </AuthShell>
      );
    }

    case 'anonymous':
      return (
        <AuthShell
          title={`Join ${workspace}`}
          description={
            <>
              {meta.inviter_name ? `${meta.inviter_name} invited ` : 'You have been invited to '}
              <strong className="text-text-primary">{invitedEmail}</strong>.{' '}
              {inviteRoleSentence(meta.role, workspace)}
            </>
          }
          footer="Use the invited address. The invitation only works for that one."
        >
          <div className="space-y-2">
            <Link
              to={`/register?next=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(invitedEmail)}`}
              className={`w-full ${buttonClass('primary', 'md')}`}
            >
              Create an account
            </Link>
            <Link
              to={`/login?next=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(invitedEmail)}`}
              className={`w-full ${buttonClass('secondary', 'md')}`}
            >
              I already have an account
            </Link>
          </div>
        </AuthShell>
      );

    case 'operator-session':
      return (
        <AuthShell
          title="Sign in with your own account"
          description={
            <>
              You are signed in with a team seat, which cannot accept an invitation. Sign out and
              sign in — or sign up — as{' '}
              <strong className="text-text-primary">{invitedEmail}</strong> to join {workspace}.
            </>
          }
        >
          <div className="space-y-2">
            <Button block onClick={signOutAndSwitch}>
              Sign out and switch
            </Button>
            <Button block variant="ghost" onClick={() => navigate('/inbox')}>
              Stay signed in
            </Button>
          </div>
        </AuthShell>
      );

    case 'mismatch':
      return (
        <AuthShell
          title="This invitation is for a different account"
          description={
            <>
              It was sent to <strong className="text-text-primary">{invitedEmail}</strong>, and you
              are signed in as{' '}
              <strong className="text-text-primary">{me.data?.email ?? 'another account'}</strong>.
              Sign out and use the invited address.
            </>
          }
        >
          <div className="space-y-2">
            <Button block onClick={signOutAndSwitch}>
              Sign out and switch
            </Button>
            <Button block variant="ghost" onClick={() => navigate('/')}>
              Stay signed in
            </Button>
          </div>
        </AuthShell>
      );

    case 'ready':
      return (
        <AuthShell
          title={`Join ${workspace}`}
          description={inviteRoleSentence(meta.role, workspace)}
        >
          <div className="space-y-4">
            {accept.isError ? (
              <Alert tone="danger" live title="We could not accept the invitation">
                {errorMessage(
                  accept.error,
                  'Something went wrong. If the invitation has since been revoked or has expired, ask for a fresh one.',
                )}
              </Alert>
            ) : null}
            <Button block loading={accept.isPending} onClick={() => accept.mutate()}>
              Accept invitation
            </Button>
            <p className="text-xs text-text-secondary">
              You keep your own account. Accepting adds {workspace} to the workspaces you can switch
              between.
            </p>
          </div>
        </AuthShell>
      );
  }
}

/**
 * InviteAirlock — the public team-invite landing at `/invite/:token`.
 *
 * Rebuilt from the legacy `pages/InviteAirlock.jsx` in the Admin 2.0 design
 * language. It resolves the invite token (`GET /invites/by-token/{token}`) and
 * renders one of six mutually-exclusive states based on the token's status,
 * whether a visitor is signed in, and whether that identity's email matches the
 * invited address:
 *
 *   Loading                         → spinner
 *   Not found / bad token           → InvalidInvite
 *   Accepted / revoked / expired     → ResolvedInvite
 *   Pending · anonymous              → ChooseSignInOrUp (token carried through auth)
 *   Pending · signed-in, email match → AcceptPanel
 *   Pending · signed-in, mismatch    → SwitchAccount
 *   Pending · legacy operator session→ SwitchAccount (operator variant)
 *
 * The airlock never silently switches identities: a signed-in visitor with the
 * wrong email is asked to sign out first. A legacy `X-Operator-Key` session
 * can't accept (the endpoint requires strict client auth) so it's caught before
 * the Accept button to avoid a dead-end 401 on click.
 *
 * Backend reused verbatim (typed in services/api.d.ts): getInvitePublic,
 * acceptInvitePublic, getCurrentUser. A public page outside the app shell, so
 * it owns a centered card built from design-system primitives — mirroring
 * `affiliate/AffiliateInvite`.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Building2, CheckCircle2, Clock, Loader2, LogIn, LogOut, UserPlus } from 'lucide-react';
import { Button, Card, cn } from '../../design-system';
import { acceptInvitePublic, getCurrentUser, getInvitePublic } from '../../services/api';
import { clearAuthStorage, getAuthItem, setAuthBundle } from '../../utils/authStorage';
import type { CurrentUser } from '../../types/domain';

/** Invite metadata as returned by `GET /invites/by-token/{token}`. */
interface InviteMeta {
  status?: string;
  workspace_name?: string;
  inviter_name?: string | null;
  email?: string;
  role?: string;
}

/** Result of `POST /invites/by-token/{token}/accept`. */
interface AcceptResult {
  workspace_id: number | string;
  workspace_name: string;
  redirect_url?: string | null;
  role?: string;
}

type InvitePhase =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ready'; readonly invite: InviteMeta };

type AcceptState =
  | { readonly status: 'idle' }
  | { readonly status: 'accepting' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'accepted'; readonly result: AcceptResult };

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function roleLabel(role: string | undefined): string {
  return role === 'admin' ? 'an admin' : 'an operator';
}

// ── Shell + shared chrome ──────────────────────────────────────────────────

/** Centers a single card on the canvas — mirrors the auth + affiliate pages. */
function InviteShell({ children }: { children: ReactElement }): ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ds-bg-canvas)] px-4 py-12">
      <Card className="w-full max-w-md p-8">{children}</Card>
    </div>
  );
}

function BrandHeader({ workspaceName }: { workspaceName: string }): ReactElement {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]">
        <Building2 size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
          Invitation
        </div>
        <div className="truncate text-sm font-semibold text-[var(--ds-text)]">{workspaceName}</div>
      </div>
    </div>
  );
}

/** A tinted status badge above a heading — success / neutral / warning / danger. */
function StatusIcon({
  tone,
  icon: Icon,
}: {
  tone: 'success' | 'neutral' | 'warning' | 'danger';
  icon: typeof CheckCircle2;
}): ReactElement {
  const toneClass: Record<typeof tone, string> = {
    success: 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]',
    neutral: 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
    warning: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]',
    danger: 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
  };
  return (
    <span className={cn('mb-4 flex h-10 w-10 items-center justify-center rounded-lg', toneClass[tone])}>
      <Icon size={20} aria-hidden="true" />
    </span>
  );
}

// ── Terminal / non-actionable states ───────────────────────────────────────

function InvalidInvite(): ReactElement {
  const navigate = useNavigate();
  return (
    <InviteShell>
      <div>
        <StatusIcon tone="danger" icon={AlertTriangle} />
        <h1 className="mb-2 text-lg font-semibold text-[var(--ds-text)]">This invite link is invalid</h1>
        <p className="mb-6 text-sm text-[var(--ds-text-muted)]">
          The link may have been copied incorrectly, or the invitation was already deleted. Ask the person
          who invited you to send a fresh one.
        </p>
        <Button className="w-full" onClick={() => navigate('/login')}>
          Go to sign in
        </Button>
      </div>
    </InviteShell>
  );
}

function ResolvedInvite({ invite }: { invite: InviteMeta }): ReactElement {
  const navigate = useNavigate();
  const status = invite.status;
  const heading =
    status === 'accepted'
      ? 'This invite has already been accepted.'
      : status === 'revoked'
        ? 'This invite has been revoked.'
        : status === 'expired'
          ? 'This invite has expired.'
          : 'This invite is no longer available.';
  return (
    <InviteShell>
      <div>
        <BrandHeader workspaceName={invite.workspace_name || 'OyeChats'} />
        <StatusIcon tone="neutral" icon={Clock} />
        <h1 className="mb-2 text-lg font-semibold text-[var(--ds-text)]">{heading}</h1>
        <p className="mb-6 text-sm text-[var(--ds-text-muted)]">
          {status === 'accepted'
            ? 'If you already joined this workspace, sign in to continue.'
            : 'Ask the workspace owner or admin to send a new invitation.'}
        </p>
        <Button className="w-full" onClick={() => navigate('/login')}>
          Go to sign in
        </Button>
      </div>
    </InviteShell>
  );
}

// ── Anonymous — choose sign in or sign up (token carried through) ───────────

function ChooseSignInOrUp({ invite, token }: { invite: InviteMeta; token: string }): ReactElement {
  const navigate = useNavigate();
  const next = encodeURIComponent(`/invite/${token}`);
  const email = encodeURIComponent(invite.email || '');
  return (
    <InviteShell>
      <div>
        <BrandHeader workspaceName={invite.workspace_name || 'this workspace'} />
        <h1 className="mb-2 text-lg font-semibold text-[var(--ds-text)]">
          Join {invite.workspace_name || 'the workspace'}
        </h1>
        <p className="mb-6 text-sm text-[var(--ds-text-muted)]">
          {invite.inviter_name ? (
            <>
              <strong className="text-[var(--ds-text)]">{invite.inviter_name}</strong> has invited{' '}
            </>
          ) : (
            'You’ve been invited '
          )}
          <code className="rounded bg-[var(--ds-bg-sunken)] px-1.5 py-0.5 text-xs">{invite.email}</code> to
          join as {roleLabel(invite.role)}.
        </p>
        <div className="space-y-2">
          <Button
            className="w-full"
            onClick={() => navigate(`/login?next=${next}&email=${email}`)}
          >
            <LogIn size={16} aria-hidden="true" />
            Sign in and accept
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => navigate(`/register?next=${next}&email=${email}`)}
          >
            <UserPlus size={16} aria-hidden="true" />
            Create an account
          </Button>
        </div>
        <p className="mt-4 text-xs text-[var(--ds-text-subtle)]">
          Your account will use the email <strong className="text-[var(--ds-text-muted)]">{invite.email}</strong>.
          To use a different address, ask the inviter to resend it there.
        </p>
      </div>
    </InviteShell>
  );
}

// ── Signed in, email matches — accept ──────────────────────────────────────

function AcceptPanel({
  invite,
  currentUser,
  accept,
  onAccept,
}: {
  invite: InviteMeta;
  currentUser: CurrentUser | null;
  accept: AcceptState;
  onAccept: () => void;
}): ReactElement {
  const isAccepting = accept.status === 'accepting';
  return (
    <InviteShell>
      <div>
        <BrandHeader workspaceName={invite.workspace_name || 'this workspace'} />
        <StatusIcon tone="success" icon={CheckCircle2} />
        <h1 className="mb-2 text-lg font-semibold text-[var(--ds-text)]">
          Join {invite.workspace_name || 'this workspace'} as {roleLabel(invite.role)}?
        </h1>
        <p className="mb-6 text-sm text-[var(--ds-text-muted)]">
          You’re signed in as{' '}
          <strong className="text-[var(--ds-text)]">{currentUser?.email || invite.email}</strong>. Accepting
          gives you access to this workspace’s inbox, team, and settings.
        </p>
        {accept.status === 'error' && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2 text-sm text-[var(--ds-danger)]"
          >
            {accept.message}
          </div>
        )}
        <Button className="w-full" onClick={onAccept} disabled={isAccepting}>
          {isAccepting ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Accepting…
            </>
          ) : (
            'Accept invitation'
          )}
        </Button>
      </div>
    </InviteShell>
  );
}

// ── Signed in, wrong account (or legacy operator) — sign out to switch ──────

function SwitchAccount({
  invite,
  currentUser,
  variant,
}: {
  invite: InviteMeta;
  currentUser: CurrentUser | null;
  variant: 'mismatch' | 'operator';
}): ReactElement {
  const navigate = useNavigate();
  const isOperator = variant === 'operator';
  const signOutAndSwitch = (): void => {
    clearAuthStorage();
    const next = encodeURIComponent(window.location.pathname);
    navigate(`/login?next=${next}&email=${encodeURIComponent(invite.email || '')}`);
  };
  return (
    <InviteShell>
      <div>
        <BrandHeader workspaceName={invite.workspace_name || 'this workspace'} />
        <StatusIcon tone="warning" icon={LogOut} />
        <h1 className="mb-2 text-lg font-semibold text-[var(--ds-text)]">
          {isOperator ? 'Sign in with your personal account' : 'Wrong account signed in'}
        </h1>
        <p className="mb-6 text-sm text-[var(--ds-text-muted)]">
          {isOperator ? (
            <>
              You’re signed in as an operator, which can’t accept invites. Sign out and sign in (or sign up)
              with your personal OyeChats account to join{' '}
              <strong className="text-[var(--ds-text)]">{invite.workspace_name}</strong> using{' '}
              <code className="rounded bg-[var(--ds-bg-sunken)] px-1.5 py-0.5 text-xs">{invite.email}</code>.
            </>
          ) : (
            <>
              This invite is for <strong className="text-[var(--ds-text)]">{invite.email}</strong> but you’re
              signed in as{' '}
              <strong className="text-[var(--ds-text)]">{currentUser?.email || 'a different account'}</strong>.
              Sign out and sign back in with the invited email to accept.
            </>
          )}
        </p>
        <div className="space-y-2">
          <Button className="w-full" onClick={signOutAndSwitch}>
            Sign out and switch
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
            Cancel — stay signed in
          </Button>
        </div>
      </div>
    </InviteShell>
  );
}

// ── Success ────────────────────────────────────────────────────────────────

function Accepted({ result }: { result: AcceptResult }): ReactElement {
  const navigate = useNavigate();
  // Brief confirmation, then land on Home scoped to the just-joined workspace.
  // The legacy `redirect_url` (often `/support`) doesn't exist in Admin 2.0, so
  // it's intentionally ignored in favour of a route that always exists.
  useEffect(() => {
    const timer = setTimeout(() => navigate('/', { replace: true }), 1500);
    return () => clearTimeout(timer);
  }, [navigate]);
  return (
    <InviteShell>
      <div>
        <BrandHeader workspaceName={result.workspace_name || 'OyeChats'} />
        <StatusIcon tone="success" icon={CheckCircle2} />
        <h1 className="mb-2 text-lg font-semibold text-[var(--ds-text)]">
          Welcome to {result.workspace_name}
        </h1>
        <p className="text-sm text-[var(--ds-text-muted)]">Setting up your workspace… taking you there now.</p>
      </div>
    </InviteShell>
  );
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export function InviteAirlock(): ReactElement {
  const { token = '' } = useParams();
  const isAuthenticated = Boolean(getAuthItem('admin_token'));
  const isLegacyOperator = getAuthItem('auth_type') === 'operator';

  // Derived initial phase — no token is invalid up front; otherwise we load.
  const [phase, setPhase] = useState<InvitePhase>(() =>
    token ? { status: 'loading' } : { status: 'invalid' },
  );
  // `undefined` = profile fetch still pending; `null` = anonymous/failed.
  const [currentUser, setCurrentUser] = useState<CurrentUser | null | undefined>(
    isAuthenticated && !isLegacyOperator ? undefined : null,
  );
  const [accept, setAccept] = useState<AcceptState>({ status: 'idle' });

  // 1) Resolve the invite metadata (public). setState only after the await.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const data = (await getInvitePublic(token)) as InviteMeta;
        if (!cancelled) setPhase({ status: 'ready', invite: data });
      } catch {
        if (!cancelled) setPhase({ status: 'invalid' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2) Resolve the signed-in identity — only when a client session exists.
  // A legacy operator session is handled without a profile fetch.
  useEffect(() => {
    if (!isAuthenticated || isLegacyOperator) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const user = await getCurrentUser();
        if (!cancelled) setCurrentUser(user);
      } catch {
        if (!cancelled) setCurrentUser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLegacyOperator]);

  async function handleAccept(): Promise<void> {
    setAccept({ status: 'accepting' });
    try {
      const result = (await acceptInvitePublic(token)) as unknown as AcceptResult;
      // Persist the just-joined workspace as the active context BEFORE
      // navigating, so WorkspaceContext hydrates into the invited workspace
      // (not the invitee's own empty one). Match the storage tier of
      // `admin_token` so a session-only login doesn't leak workspace keys into
      // localStorage past tab close.
      const persistent = window.localStorage.getItem('admin_token') !== null;
      setAuthBundle(
        {
          current_workspace_id: String(result.workspace_id),
          current_workspace_name: result.workspace_name || '',
          current_workspace_role: result.role || 'operator',
        },
        persistent,
      );
      setAccept({ status: 'accepted', result });
    } catch (error) {
      setAccept({ status: 'error', message: toMessage(error, 'Failed to accept the invite.') });
    }
  }

  // ── Render ──
  if (accept.status === 'accepted') return <Accepted result={accept.result} />;
  if (phase.status === 'loading') {
    return (
      <InviteShell>
        <div className="flex items-center gap-3 text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          <span className="text-sm">Loading invite…</span>
        </div>
      </InviteShell>
    );
  }
  if (phase.status === 'invalid') return <InvalidInvite />;

  const { invite } = phase;
  if (invite.status === 'accepted' || invite.status === 'revoked' || invite.status === 'expired') {
    return <ResolvedInvite invite={invite} />;
  }

  // Pending — branch on auth.
  if (!isAuthenticated) return <ChooseSignInOrUp invite={invite} token={token} />;
  if (isLegacyOperator) return <SwitchAccount invite={invite} currentUser={null} variant="operator" />;

  // Wait for the profile before deciding match vs mismatch (avoid a flash).
  if (currentUser === undefined) {
    return (
      <InviteShell>
        <div className="flex items-center gap-3 text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          <span className="text-sm">Checking your account…</span>
        </div>
      </InviteShell>
    );
  }

  const emailMatches =
    (currentUser?.email || '').trim().toLowerCase() === (invite.email || '').trim().toLowerCase();
  if (!emailMatches) return <SwitchAccount invite={invite} currentUser={currentUser} variant="mismatch" />;

  return <AcceptPanel invite={invite} currentUser={currentUser} accept={accept} onAccept={() => void handleAccept()} />;
}

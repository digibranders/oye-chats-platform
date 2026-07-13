/**
 * Invite airlock — the public page at ``/invite/:token``.
 *
 * Renders one of six mutually-exclusive states based on:
 *
 *   1. The token's own status (pending / accepted / revoked / expired / not
 *      found) — resolved via ``GET /invites/by-token/{token}``.
 *   2. Whether the visitor is currently authenticated.
 *   3. Whether the authenticated identity's email matches the invite target.
 *
 * The flow:
 *
 *  ┌────────────────────────────────────────────────────────────────────────┐
 *  │  Token state                Auth state              Render             │
 *  ├────────────────────────────────────────────────────────────────────────┤
 *  │  Loading                    —                       Skeleton           │
 *  │  Not found / bad             —                       InvalidInvite     │
 *  │  Revoked / expired / used    —                       RevokedInvite     │
 *  │  Pending                    Anonymous                ChooseSignInOrUp  │
 *  │  Pending                    Logged-in, email matches AcceptButton      │
 *  │  Pending                    Logged-in, email mismatched SignOutToSwitch │
 *  └────────────────────────────────────────────────────────────────────────┘
 *
 * The airlock never silently switches identities — a logged-in visitor with
 * the wrong email is told to sign out first (they explicitly consent). This
 * matches the security posture of the affiliate-invite page and prevents
 * "am I now signed in as someone else?" confusion after a token click.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, XCircle, Clock, LogIn, UserPlus, LogOut, Loader2, Building2 } from 'lucide-react';
import { getInvitePublic, acceptInvitePublic } from '../services/api';
import { getAuthItem, setAuthBundle, clearAuthStorage } from '../utils/authStorage';
import { getCurrentUser } from '../services/api';
import { cn } from '../lib/utils';

function _statusIsResolved(status) {
    return status === 'accepted' || status === 'revoked' || status === 'expired';
}

function CenteredCard({ children, className }) {
    return (
        <div className="min-h-screen bg-surface-50 dark:bg-surface-950 flex items-center justify-center px-4 py-12">
            <div className={cn(
                'w-full max-w-md rounded-2xl border shadow-sm p-8',
                'bg-white dark:bg-surface-900',
                'border-surface-200 dark:border-surface-800',
                className,
            )}>
                {children}
            </div>
        </div>
    );
}

function BrandHeader({ workspaceName }) {
    return (
        <div className="flex items-center gap-2 mb-6">
            <div className="w-9 h-9 rounded-lg bg-brand-50 dark:bg-brand-950/40 flex items-center justify-center">
                <Building2 size={18} className="text-brand-600 dark:text-brand-400" />
            </div>
            <div className="min-w-0">
                <div className="text-[11px] uppercase font-semibold tracking-wide text-surface-500">Invitation</div>
                <div className="text-sm font-semibold text-surface-900 dark:text-surface-100 truncate">
                    {workspaceName}
                </div>
            </div>
        </div>
    );
}

function LoadingState() {
    return (
        <CenteredCard>
            <div className="flex items-center gap-3 text-surface-500">
                <Loader2 size={18} className="animate-spin" />
                <span className="text-sm">Loading invite…</span>
            </div>
        </CenteredCard>
    );
}

function InvalidInvite() {
    const navigate = useNavigate();
    return (
        <CenteredCard>
            <div className="mb-4 w-10 h-10 rounded-lg bg-red-50 dark:bg-red-950/40 flex items-center justify-center">
                <XCircle size={20} className="text-red-600 dark:text-red-400" />
            </div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                This invite link is invalid
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400 mb-6">
                The link may have been copied incorrectly or the invitation was already deleted. Ask the person
                who invited you to send a fresh one.
            </p>
            <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full rounded-xl bg-surface-900 dark:bg-surface-100 dark:text-surface-900 text-white px-4 py-2 text-sm font-medium"
            >
                Go to sign in
            </button>
        </CenteredCard>
    );
}

function RevokedInvite({ status, workspaceName }) {
    const navigate = useNavigate();
    const labelByStatus = {
        accepted: 'This invite has already been accepted.',
        revoked: 'This invite has been revoked.',
        expired: 'This invite has expired.',
    };
    return (
        <CenteredCard>
            <BrandHeader workspaceName={workspaceName || 'OyeChats'} />
            <div className="mb-4 w-10 h-10 rounded-lg bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
                <Clock size={20} className="text-surface-500" />
            </div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                {labelByStatus[status] || 'This invite is no longer available.'}
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400 mb-6">
                {status === 'accepted'
                    ? 'If you already joined this workspace, sign in to continue.'
                    : 'Ask the workspace owner or admin to send a new invitation.'}
            </p>
            <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full rounded-xl bg-surface-900 dark:bg-surface-100 dark:text-surface-900 text-white px-4 py-2 text-sm font-medium"
            >
                Go to sign in
            </button>
        </CenteredCard>
    );
}

function ChooseSignInOrUp({ invite, token }) {
    const navigate = useNavigate();
    return (
        <CenteredCard>
            <BrandHeader workspaceName={invite.workspace_name} />
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                Join {invite.workspace_name}
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400 mb-6">
                {invite.inviter_name ? <><strong>{invite.inviter_name}</strong> has invited</> : 'You&rsquo;ve been invited'}
                {' '}<code className="px-1.5 py-0.5 bg-surface-100 dark:bg-surface-800 rounded text-xs">{invite.email}</code>
                {' '}to join as {invite.role === 'admin' ? 'an admin' : 'an operator'}.
            </p>
            {/* Preserve the invite token through the login/signup flow so we
                come back to /invite/{token} and auto-accept. */}
            <div className="space-y-2">
                <button
                    type="button"
                    onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(invite.email)}`)}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-surface-900 dark:bg-surface-100 dark:text-surface-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-surface-800 dark:hover:bg-white transition-colors"
                >
                    <LogIn size={16} />
                    Sign in and accept
                </button>
                <button
                    type="button"
                    onClick={() => navigate(`/register?next=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(invite.email)}`)}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-surface-200 dark:border-surface-800 px-4 py-2.5 text-sm font-medium text-surface-800 dark:text-surface-200 hover:bg-surface-50 dark:hover:bg-surface-800/40 transition-colors"
                >
                    <UserPlus size={16} />
                    Create an account
                </button>
            </div>
            <p className="mt-4 text-xs text-surface-500">
                Your account will be created with the email <strong>{invite.email}</strong>. If you want
                to use a different email, ask the inviter to resend to that address.
            </p>
        </CenteredCard>
    );
}

function AcceptButton({ invite, currentUser, onAccept, isAccepting, error }) {
    return (
        <CenteredCard>
            <BrandHeader workspaceName={invite.workspace_name} />
            <div className="mb-4 w-10 h-10 rounded-lg bg-green-50 dark:bg-green-950/40 flex items-center justify-center">
                <CheckCircle2 size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                Join {invite.workspace_name} as {invite.role === 'admin' ? 'an admin' : 'an operator'}?
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400 mb-6">
                You&rsquo;re signed in as <strong>{currentUser?.email || invite.email}</strong>. Accepting will
                give you access to this workspace&rsquo;s live chat, team, and settings.
            </p>
            {error && (
                <div className="mb-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-800 dark:text-red-300">
                    {error}
                </div>
            )}
            <button
                type="button"
                onClick={onAccept}
                disabled={isAccepting}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-surface-900 dark:bg-surface-100 dark:text-surface-900 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-60"
            >
                {isAccepting ? <><Loader2 size={16} className="animate-spin" /> Accepting…</> : 'Accept invitation'}
            </button>
        </CenteredCard>
    );
}

function SignOutToSwitch({ invite, currentUser }) {
    const navigate = useNavigate();
    return (
        <CenteredCard>
            <BrandHeader workspaceName={invite.workspace_name} />
            <div className="mb-4 w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center">
                <LogOut size={20} className="text-amber-600 dark:text-amber-400" />
            </div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                Wrong account signed in
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400 mb-6">
                This invite is for <strong>{invite.email}</strong> but you&rsquo;re signed in as
                {' '}<strong>{currentUser?.email || 'a different account'}</strong>. Sign out and sign back in
                with the invited email to accept.
            </p>
            <div className="space-y-2">
                <button
                    type="button"
                    onClick={() => {
                        clearAuthStorage();
                        // Preserve the airlock URL so post-login lands us back here.
                        navigate(`/login?next=${encodeURIComponent(window.location.pathname)}&email=${encodeURIComponent(invite.email)}`);
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-surface-900 dark:bg-surface-100 dark:text-surface-900 text-white px-4 py-2.5 text-sm font-medium"
                >
                    Sign out and switch
                </button>
                <button
                    type="button"
                    onClick={() => navigate('/')}
                    className="w-full rounded-xl border border-surface-200 dark:border-surface-800 px-4 py-2.5 text-sm font-medium text-surface-700 dark:text-surface-300"
                >
                    Cancel — stay signed in
                </button>
            </div>
        </CenteredCard>
    );
}

function LegacyOperatorSignOut({ invite }) {
    // Legacy X-Operator-Key sessions can't accept invites — the accept
    // endpoint uses ``get_current_client_strict`` and rejects X-Operator-Key
    // auth to avoid silently binding the linked-Operator row to the wrong
    // Client identity (that used to be Bug #8 before we tightened the auth
    // dep). Without this dedicated panel, a legacy operator whose email
    // happens to match the invite target would see the Accept button, click
    // it, and hit a confusing 401 — this branch catches them BEFORE the
    // dead-end and gives them a clear next action.
    const navigate = useNavigate();
    return (
        <CenteredCard>
            <BrandHeader workspaceName={invite.workspace_name} />
            <div className="mb-4 w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center">
                <LogOut size={20} className="text-amber-600 dark:text-amber-400" />
            </div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                Sign in with your personal account
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400 mb-6">
                You&rsquo;re currently signed in as an operator, which can&rsquo;t accept invites. Sign out
                and sign in (or sign up) with your personal OyeChats account to join
                {' '}<strong>{invite.workspace_name}</strong> using{' '}
                <code className="px-1.5 py-0.5 bg-surface-100 dark:bg-surface-800 rounded text-xs">{invite.email}</code>.
            </p>
            <div className="space-y-2">
                <button
                    type="button"
                    onClick={() => {
                        clearAuthStorage();
                        // Preserve the airlock URL so post-login lands back here.
                        navigate(`/login?next=${encodeURIComponent(window.location.pathname)}&email=${encodeURIComponent(invite.email)}`);
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-surface-900 dark:bg-surface-100 dark:text-surface-900 text-white px-4 py-2.5 text-sm font-medium"
                >
                    Sign out and switch account
                </button>
                <button
                    type="button"
                    onClick={() => navigate('/support')}
                    className="w-full rounded-xl border border-surface-200 dark:border-surface-800 px-4 py-2.5 text-sm font-medium text-surface-700 dark:text-surface-300"
                >
                    Cancel &mdash; stay signed in as operator
                </button>
            </div>
        </CenteredCard>
    );
}

function Accepted({ redirectUrl, workspaceName }) {
    const navigate = useNavigate();
    // Auto-redirect after 1500ms so the user sees confirmation before landing.
    useEffect(() => {
        const t = setTimeout(() => navigate(redirectUrl || '/support', { replace: true }), 1500);
        return () => clearTimeout(t);
    }, [navigate, redirectUrl]);
    return (
        <CenteredCard>
            <BrandHeader workspaceName={workspaceName || 'OyeChats'} />
            <div className="mb-4 w-10 h-10 rounded-lg bg-green-50 dark:bg-green-950/40 flex items-center justify-center">
                <CheckCircle2 size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                Welcome to {workspaceName}
            </h1>
            <p className="text-sm text-surface-600 dark:text-surface-400">
                Setting up your workspace… taking you there now.
            </p>
        </CenteredCard>
    );
}

export default function InviteAirlock() {
    const { token } = useParams();
    const [invite, setInvite] = useState(null);
    const [loadingInvite, setLoadingInvite] = useState(true);
    const [currentUser, setCurrentUser] = useState(null);
    const [isAccepting, setIsAccepting] = useState(false);
    const [acceptError, setAcceptError] = useState(null);
    const [accepted, setAccepted] = useState(null); // { workspace_name, redirect_url }

    const isAuthenticated = !!getAuthItem('admin_token');

    // Fetch invite metadata (public).
    useEffect(() => {
        let cancelled = false;
        setLoadingInvite(true);
        getInvitePublic(token)
            .then((data) => { if (!cancelled) setInvite(data); })
            .catch((err) => { if (!cancelled) { setInvite({ error: err.message || 'invalid' }); } })
            .finally(() => { if (!cancelled) setLoadingInvite(false); });
        return () => { cancelled = true; };
    }, [token]);

    // Fetch current user profile only when we're authenticated. Failures
    // (401 / network) collapse the state to "anonymous" so the airlock still
    // renders the choose-sign-in view instead of getting stuck.
    useEffect(() => {
        if (!isAuthenticated) return;
        let cancelled = false;
        getCurrentUser()
            .then((data) => { if (!cancelled) setCurrentUser(data); })
            .catch(() => { if (!cancelled) setCurrentUser(null); });
        return () => { cancelled = true; };
    }, [isAuthenticated]);

    async function handleAccept() {
        setAcceptError(null);
        setIsAccepting(true);
        try {
            const result = await acceptInvitePublic(token);
            // Persist the just-joined workspace as the active context BEFORE
            // navigating. Without this, WorkspaceContext mounts on ``/support``
            // with no persisted workspace, defaults to the invitee's OWN
            // workspace (their fresh, empty Client identity), and scopes the
            // whole app to zero chats — the operator would land on Support
            // and see nothing from Acme. Persisting here means the context
            // hydrates directly into the invited workspace on the next mount.
            //
            // Storage tier — match the tier of ``admin_token``. If the caller
            // logged in with "Remember me" off, their token is in
            // sessionStorage; hardcoding ``persistent=true`` here would leave
            // workspace keys in localStorage after tab close, surviving into
            // the next login session and pointing at a workspace the user's
            // fresh session may not even remember opting into.
            const persistent = window.localStorage.getItem('admin_token') !== null;
            setAuthBundle(
                {
                    current_workspace_id: String(result.workspace_id),
                    current_workspace_name: result.workspace_name,
                    current_workspace_role: 'operator',
                },
                persistent,
            );
            setAccepted(result);
        } catch (err) {
            setAcceptError(err.message || 'Failed to accept the invite.');
        } finally {
            setIsAccepting(false);
        }
    }

    if (loadingInvite) return <LoadingState />;
    if (!invite || invite.error) return <InvalidInvite />;
    if (accepted) return <Accepted workspaceName={accepted.workspace_name} redirectUrl={accepted.redirect_url} />;
    if (_statusIsResolved(invite.status)) {
        return <RevokedInvite status={invite.status} workspaceName={invite.workspace_name} />;
    }

    // Pending — decide branch based on auth.
    if (!isAuthenticated) return <ChooseSignInOrUp invite={invite} token={token} />;

    // Legacy X-Operator-Key session — accept endpoint requires strict Client
    // auth so the operator's key can't silently bind to the wrong Client
    // identity (fixed in Bug #8). We catch this case BEFORE the getCurrentUser
    // fetch resolves so the operator never sees a stale Accept button that
    // 401s on click. If they cancel and stay signed in, they stay in their
    // operator dashboard — the invite is not deleted, they can come back
    // to accept from a fresh session later.
    const legacyOperator = getAuthItem('auth_type') === 'operator';
    if (legacyOperator) return <LegacyOperatorSignOut invite={invite} />;

    // Wait until we know who's signed in before rendering (avoid a flash of
    // "wrong account" when the profile fetch is still pending).
    if (!currentUser) return <LoadingState />;

    const emailMatches = (currentUser.email || '').trim().toLowerCase() === (invite.email || '').trim().toLowerCase();
    if (!emailMatches) return <SignOutToSwitch invite={invite} currentUser={currentUser} />;
    return (
        <AcceptButton
            invite={invite}
            currentUser={currentUser}
            onAccept={handleAccept}
            isAccepting={isAccepting}
            error={acceptError}
        />
    );
}

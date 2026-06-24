import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
    Sparkles, Loader2, CheckCircle2, Mail, ArrowRight, AlertCircle, Gift,
    UserPlus, LogIn,
} from 'lucide-react';
import {
    lookupAffiliateInvite,
    acceptAffiliateInviteExisting,
} from '../services/api';
import { cn } from '../lib/utils';

/**
 * Unified invite landing page — replaces the old "set up account inside the
 * accept page" flow. Three branches:
 *
 *   1. Not logged in (no admin_token):
 *      Show two CTAs side-by-side — "Sign in" (existing customer) and
 *      "Create account" (new). Both buttons preserve the token in the
 *      destination URL so the respective auth pages can route back here
 *      after success.
 *
 *   2. Logged in:
 *      Auto-fire POST /affiliate-invites/accept-existing with the token.
 *      On 200 → "You're in" success card with a button to /affiliate.
 *      On 403 (email mismatch) → clear "this invite is for X" message with
 *      a Sign Out button so the user can retry as the right account.
 *      On 409 (already enrolled) → success-shaped "already a Partner" card.
 *
 *   3. Bad token (404/410):
 *      Surface a typed error (expired vs invalid vs used) with a link to
 *      contact support or open OyeChats normally.
 */
export default function AffiliateInvite() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get('token') || '';
    const isLoggedIn = !!localStorage.getItem('admin_token');

    // ── Lookup state (always runs) ──────────────────────────────────────
    const [invite, setInvite] = useState(null);
    const [lookupError, setLookupError] = useState(null);
    const [isLookingUp, setIsLookingUp] = useState(true);

    // ── Existing-client accept state (only when logged in) ──────────────
    const [acceptStatus, setAcceptStatus] = useState('idle'); // 'idle' | 'accepting' | 'accepted' | 'already' | 'mismatch' | 'error'
    const [acceptError, setAcceptError] = useState('');
    const [acceptMessage, setAcceptMessage] = useState('');
    // Tracks whether we've already fired the accept-existing call. Lives in
    // a ref (not state) so the auto-accept effect doesn't include it in
    // its dep array — if it did, every state transition inside the effect
    // would tear down its cleanup closure, set ``cancelled = true``, and
    // silently drop the eventual .then/.catch. Symptom: the page hung on
    // "Activating your Partner account…" forever because the 403 / 409 /
    // success state-setter never ran.
    const acceptFiredRef = useRef(false);

    // Lookup runs once per token. React Compiler's
    // ``set-state-in-effect`` rule flags the synchronous reset on the
    // empty-token branch, but the alternative pattern (deriving "is
    // looking up" from cached query state) needs a data layer this page
    // doesn't have. Suppressed locally rather than file-wide.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (!token) {
            setLookupError({ message: 'No invite token in the URL.', status: 400 });
            setIsLookingUp(false);
            return;
        }
        let cancelled = false;
        lookupAffiliateInvite(token)
            .then((data) => { if (!cancelled) setInvite(data); })
            .catch((err) => { if (!cancelled) setLookupError(err); })
            .finally(() => { if (!cancelled) setIsLookingUp(false); });
        return () => { cancelled = true; };
    }, [token]);

    // Once the invite resolves AND the user is logged in, auto-attempt the
    // existing-client acceptance. The "fire once" guard is a ref, NOT the
    // ``acceptStatus`` state — putting acceptStatus in the dep array used
    // to drop the response on the floor (see ``acceptFiredRef`` comment
    // above). The cleanup-cancellation is kept for genuine unmounts (e.g.
    // user navigates away mid-flight).
    useEffect(() => {
        if (!isLoggedIn || isLookingUp || lookupError || !invite) return;
        if (acceptFiredRef.current) return;
        acceptFiredRef.current = true;

        let cancelled = false;
        setAcceptStatus('accepting');
        acceptAffiliateInviteExisting(token)
            .then((res) => {
                if (cancelled) return;
                setAcceptStatus('accepted');
                setAcceptMessage(res?.message || 'Welcome to OyeChats Partners!');
            })
            .catch((err) => {
                if (cancelled) return;
                // 409 = already enrolled. Treat as success — the link was just
                // clicked twice (or by someone already on the program).
                if (err?.status === 409) {
                    setAcceptStatus('already');
                    setAcceptMessage(err?.message || "You're already a Partner.");
                    return;
                }
                // 403 = the token's email doesn't match the logged-in client.
                if (err?.status === 403) {
                    setAcceptStatus('mismatch');
                    setAcceptError(err?.message || 'This invite is for a different account.');
                    return;
                }
                setAcceptStatus('error');
                setAcceptError(err?.message || 'Could not accept the invite.');
            });
        return () => { cancelled = true; };
    }, [isLoggedIn, isLookingUp, lookupError, invite, token]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const handleSignOutRetry = () => {
        // Clear the token, redirect back through the same invite URL so the
        // not-logged-in branch can render. Keep the token in the URL so the
        // recipient doesn't have to find the email again.
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_name');
        localStorage.removeItem('admin_client_id');
        localStorage.removeItem('auth_type');
        localStorage.removeItem('is_superadmin');
        navigate(`/affiliate-invite?token=${encodeURIComponent(token)}`, { replace: true });
        // Soft reload so any in-flight auth-aware components reset cleanly.
        window.location.reload();
    };

    return (
        <div className="min-h-screen flex bg-[#030D1F]">
            <BrandPanel />
            <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-[#030D1F] overflow-y-auto">
                <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    className="w-full max-w-[440px] my-auto"
                >
                    <div className="flex items-center gap-3 mb-8 lg:hidden">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-blue-400 text-white flex items-center justify-center shadow-lg shadow-blue-500/30">
                            <Sparkles size={18} />
                        </div>
                        <span className="text-lg font-bold text-white">OyeChats</span>
                    </div>

                    {/* ── Lookup loading ── */}
                    {isLookingUp ? (
                        <div className="flex flex-col items-center justify-center py-16">
                            <Loader2 size={32} className="animate-spin text-blue-400" />
                            <p className="text-white/45 text-sm mt-3">Validating invite…</p>
                        </div>
                    ) : lookupError ? (
                        /* ── Bad token (expired / invalid / used) ── */
                        <BadTokenCard error={lookupError} />
                    ) : isLoggedIn ? (
                        /* ── Logged-in branch — auto-accept lifecycle ── */
                        <LoggedInAcceptCard
                            invite={invite}
                            status={acceptStatus}
                            message={acceptMessage}
                            error={acceptError}
                            onSignOutRetry={handleSignOutRetry}
                            onContinue={() => navigate('/affiliate')}
                        />
                    ) : (
                        /* ── Not logged in — pick sign-in or sign-up ── */
                        <NotLoggedInCard invite={invite} token={token} />
                    )}
                </motion.div>
            </div>
        </div>
    );
}

/* ──────────────────────────────────────────────────────────────────────
   Sub-components — kept in this file because they're 1:1 with the page.
   Splitting into siblings only adds import noise for no reuse value.
   ────────────────────────────────────────────────────────────────────── */

function BrandPanel() {
    return (
        <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden auth-dark-panel">
            <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.18) 0%, rgba(37,99,235,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />
            <div className="relative z-10 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600/80 backdrop-blur-md border border-blue-400/30 flex items-center justify-center shadow-lg shadow-blue-500/30">
                    <Sparkles size={20} className="text-white" />
                </div>
                <span className="text-xl font-bold text-white tracking-tight">OyeChats</span>
            </div>
            <div className="relative z-10 my-auto max-w-md">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/15 border border-blue-400/25 text-blue-300 text-[11px] font-bold uppercase tracking-wider mb-4">
                    <Gift size={11} /> Partners invite
                </div>
                <h2 className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4">
                    Welcome to
                    <br />
                    <span className="bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-400 bg-clip-text text-transparent">
                        OyeChats Partners
                    </span>
                </h2>
                <p className="text-white/45 text-lg max-w-md leading-relaxed">
                    Earn recurring commission on every customer you bring in. Create
                    referral codes, share them anywhere, and track every signup from
                    a single dashboard.
                </p>
            </div>
        </div>
    );
}

function BadTokenCard({ error }) {
    const expired = error?.status === 410;
    return (
        <div>
            <div className="mb-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
                <div className="flex items-start gap-2.5">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-medium">
                            {expired ? 'This invite has expired or already been used' : 'Invite link is invalid'}
                        </p>
                        <p className="text-[12px] mt-1 text-rose-300/80">{error?.message}</p>
                    </div>
                </div>
            </div>
            <p className="text-sm text-white/45 text-center">
                Need a fresh invite? Contact{' '}
                <a href="mailto:support@oyechats.com" className="font-semibold text-blue-400 hover:text-blue-300">
                    support@oyechats.com
                </a>
                {' '}or{' '}
                <Link to="/login" className="font-semibold text-blue-400 hover:text-blue-300">sign in</Link>
                {' '}to your existing account.
            </p>
        </div>
    );
}

function NotLoggedInCard({ invite, token }) {
    const tokenQs = `?affiliate_token=${encodeURIComponent(token)}`;
    return (
        <>
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-white tracking-tight">You&rsquo;re invited!</h1>
                <p className="text-white/45 mt-2 text-sm">
                    OyeChats Partners earn recurring commission on every customer they refer.
                    Pick how you&rsquo;d like to continue.
                </p>
            </div>

            <div className="mb-5 p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-blue-300/80">
                    <Mail size={12} /> Invite for
                </div>
                <p className="text-sm font-mono font-semibold text-blue-200 mt-1 truncate">{invite.email}</p>
                {invite.expires_at && (
                    <p className="text-[11px] text-blue-300/60 mt-1">
                        Expires {new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                )}
            </div>

            <div className="space-y-3">
                <Link
                    to={`/login${tokenQs}`}
                    className={cn(
                        'w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl',
                        'shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]',
                        'flex justify-center items-center gap-2 text-sm',
                    )}
                >
                    <LogIn size={16} />
                    I already have an OyeChats account
                </Link>
                <Link
                    to={`/register${tokenQs}`}
                    className={cn(
                        'w-full py-3 bg-white/[.04] hover:bg-white/[.07] text-white font-semibold rounded-xl',
                        'border border-white/10 hover:border-white/20 transition-all active:scale-[0.98]',
                        'flex justify-center items-center gap-2 text-sm',
                    )}
                >
                    <UserPlus size={16} />
                    Create a new OyeChats account
                </Link>
            </div>

            <p className="text-[11px] text-white/35 mt-5 text-center leading-relaxed">
                Either way, after signing in/up you&rsquo;ll automatically be enrolled
                and the <strong className="text-white/60">Affiliate</strong> menu will appear in your sidebar.
            </p>
        </>
    );
}

function LoggedInAcceptCard({ invite, status, message, error, onSignOutRetry, onContinue }) {
    if (status === 'accepting' || status === 'idle') {
        return (
            <div className="flex flex-col items-center justify-center py-12">
                <Loader2 size={32} className="animate-spin text-blue-400" />
                <p className="text-white/45 text-sm mt-3">Activating your Partner account…</p>
            </div>
        );
    }

    if (status === 'mismatch') {
        return (
            <div>
                <div className="mb-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300">
                    <div className="flex items-start gap-2.5">
                        <AlertCircle size={16} className="shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium">Wrong account</p>
                            <p className="text-[12px] mt-1 text-amber-300/80 leading-relaxed">
                                This invite was sent to{' '}
                                <span className="font-mono font-semibold text-amber-200">{invite?.email}</span>
                                {' '}but you&rsquo;re signed in as a different account.
                            </p>
                        </div>
                    </div>
                </div>
                <p className="text-[12px] text-white/45 leading-relaxed mb-4">
                    {error}
                </p>
                <button
                    type="button"
                    onClick={onSignOutRetry}
                    className={cn(
                        'w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl',
                        'shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]',
                        'flex justify-center items-center gap-2 text-sm',
                    )}
                >
                    <LogIn size={15} />
                    Sign out & try again
                </button>
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div>
                <div className="mb-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
                    <div className="flex items-start gap-2.5">
                        <AlertCircle size={16} className="shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium">Something went wrong</p>
                            <p className="text-[12px] mt-1 text-rose-300/80">{error}</p>
                        </div>
                    </div>
                </div>
                <p className="text-sm text-white/45 text-center">
                    Try again later or contact{' '}
                    <a href="mailto:support@oyechats.com" className="font-semibold text-blue-400 hover:text-blue-300">
                        support@oyechats.com
                    </a>.
                </p>
            </div>
        );
    }

    // Both 'accepted' and 'already' render the same success shape.
    const isFirstTime = status === 'accepted';
    return (
        <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center">
                <CheckCircle2 size={32} className="text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">
                {isFirstTime ? `You're in!` : `Already a Partner`}
            </h2>
            <p className="text-white/55 mt-2 text-sm leading-relaxed">{message}</p>
            <p className="text-white/40 mt-2 text-xs leading-relaxed">
                The <strong className="text-white/60">Affiliate</strong> menu is now in your sidebar.
                Open it to create your first referral code.
            </p>
            <button
                type="button"
                onClick={onContinue}
                className={cn(
                    'mt-6 w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl',
                    'shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]',
                    'flex justify-center items-center gap-2 text-sm',
                )}
            >
                Open my Affiliate dashboard <ArrowRight size={15} />
            </button>
        </div>
    );
}

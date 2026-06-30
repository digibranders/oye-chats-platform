import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { getCurrentUser } from '../services/api';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { setAuthBundle, setAuthItem } from '../utils/authStorage';

/**
 * Maps the machine-readable error codes returned by the backend OAuth
 * routes onto user-facing copy. Codes that aren't in this table fall
 * back to a generic message — keeps the surface area for accidental
 * disclosure tight.
 */
const ERROR_MESSAGES = {
    oauth_unavailable: 'Google sign-in is not configured. Please use your email and password.',
    oauth_cancelled: 'Sign-in was cancelled. You can try again any time.',
    oauth_provider_error: 'Google reported an error while signing you in. Please try again.',
    oauth_missing_params: 'The sign-in link was incomplete. Please start again from the login page.',
    oauth_state_mismatch: 'Your sign-in session expired or was tampered with. Please try again.',
    oauth_state_invalid: 'Your sign-in session expired. Please try again.',
    oauth_exchange_failed: 'We couldn’t verify your sign-in with Google. Please try again.',
    oauth_email_unverified:
        'Your Google account’s email isn’t verified. Please verify it with Google and try again.',
    oauth_email_has_password:
        'An account with this email already exists. Please sign in with your password first, then link Google from your account settings.',
    oauth_internal_error: 'Something went wrong on our end. Please try again.',
};

/**
 * Post-OAuth landing page. The backend lands the browser here with the
 * api_key in the URL fragment (e.g. `/auth/callback?new=1#api_key=…`).
 * We pull it out of the fragment, persist it the same way the
 * password-login codepath does, then fetch /auth/me to populate the
 * navbar widgets (name, role, trial banner). Finally we route the user
 * to the destination they requested via `?next=` — or the role-default
 * if no destination was supplied.
 *
 * Why a dedicated page instead of stuffing this into App.jsx:
 *  - Keeps the parsing logic + error UX in one place.
 *  - Survives full-page reloads (the fragment is what we read on mount).
 *  - Gives the user a visible "Signing you in…" state, which matters
 *    because /auth/me adds a noticeable round-trip before navigation.
 */
/**
 * Resolve the initial render state synchronously from the URL so the
 * component can paint the correct branch (error screen vs spinner)
 * without an extra render. The async sign-in finalisation still happens
 * in useEffect — only the *initial* classification is precomputed here.
 *
 * Returns one of:
 *   { kind: 'error', message }
 *   { kind: 'working', apiKey, next, isNew, isSuperadmin }
 */
function classifyCallback(searchParams) {
    const errorCode = searchParams.get('error');
    if (errorCode) {
        return {
            kind: 'error',
            message: ERROR_MESSAGES[errorCode] || ERROR_MESSAGES.oauth_internal_error,
        };
    }

    const rawHash = typeof window !== 'undefined' ? window.location.hash : '';
    const fragment = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
    const fragParams = new URLSearchParams(fragment);
    const apiKey = fragParams.get('api_key');
    if (!apiKey) {
        return { kind: 'error', message: ERROR_MESSAGES.oauth_missing_params };
    }

    return {
        kind: 'working',
        apiKey,
        next: searchParams.get('next') || '/',
        isNew: searchParams.get('new') === '1',
        isSuperadmin: searchParams.get('superadmin') === '1',
    };
}

export default function OAuthCallback() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // Lazy initializer runs once per mount — classifies the URL the
    // same instant the component is constructed so the first paint
    // already shows the right branch.
    const [classified] = useState(() => classifyCallback(searchParams));
    const handled = useRef(false);

    useEffect(() => {
        if (classified.kind !== 'working') return;
        // React 18 StrictMode double-mounts effects in dev — guard so we
        // don't post-process the same fragment twice (the second pass
        // would race against the navigate() call).
        if (handled.current) return;
        handled.current = true;

        const { apiKey, next, isNew, isSuperadmin } = classified;

        // Scrub the URL immediately — even though the fragment never
        // hits the server, we still don't want it sitting in the
        // browser's history.
        window.history.replaceState({}, '', '/auth/callback');

        // Persist the api_key + minimal session state the rest of the
        // app reads from localStorage. We deliberately mirror the
        // exact set of keys the password-login flow writes so every
        // downstream guard (ProtectedRoute, ClientOnlyPage, etc.)
        // keeps working without special-casing OAuth users.
        try {
            clearTrialBannerDismissals();
        } catch {
            // banner cleanup is best-effort
        }
        // OAuth defaults to ``persistent=true`` — Google sign-in users
        // expect to stay logged in across browser restarts (matches how
        // Google itself handles its own sessions).
        setAuthBundle({
            admin_token: apiKey,
            auth_type: 'client',
            admin_is_verified: 'true', // Google verified the email server-side.
            is_superadmin: isSuperadmin ? 'true' : 'false',
        });
        // Hint to the dashboard's toast surface — same key the
        // password-login flow uses so behaviour stays identical.
        sessionStorage.setItem('login_toast', isNew ? 'registered' : '1');

        // /auth/me gives us name, company, bot_count, affiliate flag, and
        // the trial snapshot — everything the topbar + sidebar need. We
        // await it before navigating so the dashboard doesn't paint with
        // a flash of empty state.
        getCurrentUser()
            .then((me) => {
                if (me?.name) setAuthItem('admin_name', me.name);
                if (typeof me?.id === 'number') setAuthItem('admin_client_id', String(me.id));
                if (me?.company_name !== undefined) {
                    setAuthItem('company_name', me.company_name || '');
                }
                if (me?.website !== undefined) {
                    setAuthItem('company_website', me.website || '');
                }

                // Routing precedence mirrors Login.jsx:
                //   affiliate-only → /affiliate
                //   explicit ?next= override
                //   else → "/"
                // Super-admins use the dedicated console at
                // admin.oyechats.com and do not route here.
                let destination = next;
                if (me?.is_affiliate_only) destination = '/affiliate';
                else if (!destination || destination === '/') destination = '/';

                navigate(destination, { replace: true });
            })
            .catch(() => {
                // /auth/me failed (network blip, token invalidated) — fall
                // back to "/" and let the standard 401 interceptor send
                // the user to /login if the token is actually bad.
                navigate('/', { replace: true });
            });
    }, [classified, navigate]);

    if (classified.kind === 'error') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#030D1F] p-6">
                <div className="max-w-md w-full text-center">
                    <div className="mx-auto w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mb-4">
                        <AlertCircle size={22} className="text-rose-400" />
                    </div>
                    <h1 className="text-xl font-semibold text-white mb-2">Sign-in failed</h1>
                    <p className="text-white/60 text-sm mb-6">{classified.message}</p>
                    <button
                        type="button"
                        onClick={() => navigate('/login', { replace: true })}
                        className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]"
                    >
                        Back to sign in
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-[#030D1F]">
            <div className="text-center">
                <Loader2 size={28} className="animate-spin text-blue-400 mx-auto mb-4" />
                <p className="text-white/60 text-sm">Signing you in…</p>
            </div>
        </div>
    );
}

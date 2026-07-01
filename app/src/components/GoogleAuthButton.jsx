import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

/**
 * Capability probe: the backend tells us whether Google OAuth is configured.
 * Cached on the module so login + register pages don't double-fetch on the
 * same paint. The probe is cheap (a JSON boolean) but doing it once keeps
 * the button render deterministic and avoids a brief flash where the
 * button appears, then vanishes.
 */
let cachedProbe = null;
let inflightProbe = null;

async function probeGoogleOAuth() {
    if (cachedProbe !== null) return cachedProbe;
    if (inflightProbe) return inflightProbe;
    inflightProbe = fetch(`${API_BASE_URL}/auth/google/status`, {
        method: 'GET',
        credentials: 'omit',
    })
        .then((r) => (r.ok ? r.json() : { enabled: false }))
        .then((data) => {
            cachedProbe = !!data?.enabled;
            return cachedProbe;
        })
        .catch(() => {
            // Network blip → hide the button rather than render a click
            // that 503s. Users still have email/password.
            cachedProbe = false;
            return false;
        })
        .finally(() => {
            inflightProbe = null;
        });
    return inflightProbe;
}

/**
 * "Sign in / Sign up with Google" button.
 *
 * Same component on both /login and /register — the `label` prop is the
 * only difference in copy. Clicking redirects to the backend's
 * `/auth/google/login` endpoint, which issues the CSRF state cookie and
 * 302s to Google. After Google → callback → success, the backend
 * redirects to `/auth/callback#api_key=…` which `OAuthCallback.jsx`
 * picks up.
 *
 * Props:
 *  - label?: string — visible button text. Defaults to "Continue with Google".
 *  - next?: string — relative path the user should land on after success.
 *      Passed through the OAuth round-trip via a signed state cookie so
 *      deep-link redirects survive (e.g. /billing).
 *  - mode?: "login" | "register" — telemetry only; behaviour is identical.
 *  - className?: string — appended to the button's base classes.
 *  - onBlockedClick?: () => boolean — optional pre-flight gate called before
 *      the OAuth redirect fires. Return `true` to cancel the redirect (the
 *      caller is responsible for surfacing why, e.g. a "please accept the
 *      Terms" error) or `false`/omit to proceed. Used by Register.jsx to
 *      require the Terms/Privacy checkbox before Google sign-up too — Google
 *      is a full-page redirect, so this has to run synchronously on click,
 *      before `window.location.href` navigates away.
 */
export default function GoogleAuthButton({
    label = 'Continue with Google',
    next = '/',
    mode = 'login',
    className,
    tabIndex,
    onBlockedClick,
}) {
    const [enabled, setEnabled] = useState(cachedProbe);
    const [clicking, setClicking] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (cachedProbe === null) {
            probeGoogleOAuth().then((v) => {
                if (!cancelled) setEnabled(v);
            });
        }
        return () => {
            cancelled = true;
        };
    }, []);

    if (enabled === false) return null;

    const handleClick = () => {
        if (clicking || enabled === null) return;
        if (onBlockedClick?.()) return;
        setClicking(true);
        // Full-page navigation — the OAuth dance has to happen at the
        // top level so Google's redirect lands back on a real URL the
        // router can interpret.
        const params = new URLSearchParams({ next, mode });
        window.location.href = `${API_BASE_URL}/auth/google/login?${params.toString()}`;
    };

    const loading = enabled === null;

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={loading || clicking}
            tabIndex={tabIndex}
            aria-label={label}
            className={cn(
                'w-full py-2.5 px-4 rounded-xl border bg-white text-[#1f1f1f]',
                'hover:bg-gray-50 active:scale-[0.99] transition-all',
                'border-white/[.08] shadow-sm',
                'flex items-center justify-center gap-2.5 text-sm font-medium',
                'disabled:opacity-70 disabled:cursor-not-allowed',
                className,
            )}
        >
            {clicking ? (
                <Loader2 size={16} className="animate-spin text-gray-500" />
            ) : (
                <GoogleMark className="w-[18px] h-[18px]" />
            )}
            <span>{loading ? 'Loading…' : label}</span>
        </button>
    );
}

/**
 * Official Google "G" mark. Inlined as SVG rather than fetched from a CDN
 * to (a) keep the auth pages working offline-of-Google, (b) avoid the
 * extra request, and (c) survive any future Google branding URL changes.
 * Pixel-faithful to https://developers.google.com/identity/branding-guidelines.
 */
function GoogleMark({ className }) {
    return (
        <svg
            className={className}
            viewBox="0 0 18 18"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                fill="#4285F4"
                d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9091c1.7018-1.5668 2.6832-3.8741 2.6832-6.615z"
            />
            <path
                fill="#34A853"
                d="M9 18c2.43 0 4.4673-.8059 5.9564-2.1809l-2.9091-2.2581c-.8059.5404-1.8368.86-3.0473.86-2.3441 0-4.3282-1.5832-5.0359-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
            />
            <path
                fill="#FBBC05"
                d="M3.9641 10.71c-.18-.5404-.2823-1.1186-.2823-1.71s.1023-1.1695.2823-1.71V4.9582H.9573C.3477 6.1727 0 7.5477 0 9s.3477 2.8273.9573 4.0418L3.9641 10.71z"
            />
            <path
                fill="#EA4335"
                d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.3459l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9641 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"
            />
        </svg>
    );
}

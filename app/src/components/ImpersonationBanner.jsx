import { useCallback, useEffect, useState } from 'react';
import { LogOut, ShieldAlert } from 'lucide-react';
import {
    IMPERSONATION_BODY_CLASS,
    IMPERSONATION_ENDED_EVENT,
    endImpersonationSession,
    getImpersonationProfile,
    isImpersonating,
} from '../utils/impersonation';
import ImpersonationNotice from './ImpersonationNotice.jsx';

/**
 * Persistent bar shown on every page while a super-admin is impersonating an
 * Account.
 *
 * Two jobs, both non-negotiable:
 *   1. Make it impossible to forget. Everything the super-admin sees belongs to
 *      someone else's Account, so the bar owns the top edge of the viewport
 *      (the app is offset beneath it - see `.oc-impersonating` in index.css)
 *      and is styled red, deliberately unlike the customer's own trial/billing
 *      banners, which are informational and dismissible. This one has no
 *      dismiss control.
 *   2. Give a way out. Exit clears the tab-scoped session and closes the tab;
 *      if the browser refuses to close a tab it didn't open, the terminal
 *      notice below takes over so the app is never left interactive with a
 *      half-dead session.
 *
 * Renders nothing when not impersonating, so it is safe to mount unconditionally
 * inside the authenticated boundary.
 */

/**
 * Parse the redeem endpoint's `expires_at`.
 *
 * The column is `TIMESTAMP WITH TIME ZONE`, so the wire value normally carries
 * an explicit offset. An offset-less ISO string still means UTC on this API,
 * but `new Date()` would read it as LOCAL time and skew the whole expiry by the
 * viewer's offset - a banner showing the wrong deadline and a shutdown timer
 * firing hours early or late. Pin the zone when it is missing.
 */
function parseExpiry(expiresAt) {
    if (typeof expiresAt !== 'string' || !expiresAt) return null;
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(expiresAt);
    const at = new Date(hasZone ? expiresAt : `${expiresAt}Z`);
    return Number.isNaN(at.getTime()) ? null : at;
}

/** Format the expiry as a local wall-clock time, e.g. "12:30". */
function formatExpiry(expiresAt) {
    const at = parseExpiry(expiresAt);
    return at ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
}

/** `setTimeout` saturates past this - clamp so a far-future expiry doesn't fire immediately. */
const MAX_TIMEOUT_MS = 2147483647;

export default function ImpersonationBanner() {
    // A tab holding the credential ALWAYS gets the bar, even if the stored
    // profile is missing or corrupt - an unlabelled impersonated session is the
    // one state this component exists to prevent. Empty object → the field
    // fallbacks below.
    const [profile, setProfile] = useState(() =>
        (isImpersonating() ? getImpersonationProfile() ?? {} : null),
    );
    const [endedMessage, setEndedMessage] = useState(null);

    const active = profile !== null && endedMessage === null;

    // The API client ends the session on a 401 (expired / revoked) and Exit
    // ends it locally. Both announce through the same event, so this is the one
    // place that flips the banner into its terminal state.
    useEffect(() => {
        function onEnded(event) {
            setProfile(null);
            setEndedMessage(event?.detail?.message || 'Impersonation session ended.');
        }
        window.addEventListener(IMPERSONATION_ENDED_EVENT, onEnded);
        return () => window.removeEventListener(IMPERSONATION_ENDED_EVENT, onEnded);
    }, []);

    // Offset the app below the bar. Scoped to <body> rather than a wrapper
    // element because the shell's rail and top bar are `fixed`/`sticky` and so
    // ignore any ancestor's layout.
    useEffect(() => {
        if (!active) return undefined;
        document.body.classList.add(IMPERSONATION_BODY_CLASS);
        return () => document.body.classList.remove(IMPERSONATION_BODY_CLASS);
    }, [active]);

    // Close the session the moment the token lapses instead of waiting for the
    // next request to 401. Server-side expiry is still the real boundary; this
    // just stops the tab presenting a dead session as a live one.
    useEffect(() => {
        if (!active) return undefined;
        const expiresAt = parseExpiry(profile.expires_at);
        if (!expiresAt) return undefined;

        const delay = Math.min(Math.max(expiresAt.getTime() - Date.now(), 0), MAX_TIMEOUT_MS);
        const timer = setTimeout(
            () => endImpersonationSession('This impersonation session expired.'),
            delay,
        );
        return () => clearTimeout(timer);
    }, [active, profile]);

    const handleExit = useCallback(() => {
        endImpersonationSession('Impersonation session ended. You can close this tab.');
        // Only works for tabs opened by script - which is how the super-admin
        // console launches this one. When it doesn't, the notice stands in.
        window.close();
    }, []);

    if (endedMessage) {
        return <ImpersonationNotice title="Impersonation session ended" message={endedMessage} />;
    }
    if (!active) return null;

    // Every field degrades independently: a missing name or actor drops that
    // clause rather than printing a placeholder that reads like real data.
    const accountName = profile.name || (profile.client_id ? `Account #${profile.client_id}` : 'this Account');
    const actorEmail = profile.actor_email || null;
    const expiry = formatExpiry(profile.expires_at);
    // Narrow viewports truncate the line, so keep the full sentence reachable.
    const fullText = [
        `Viewing ${accountName}${actorEmail ? ` as super-admin ${actorEmail}` : ''}`,
        'limited actions',
        expiry && `expires ${expiry}`,
    ].filter(Boolean).join(' · ');

    return (
        <div
            role="alert"
            title={fullText}
            className="fixed inset-x-0 top-0 z-[70] flex h-9 items-center gap-x-3 overflow-hidden bg-rose-600 px-3 text-white md:px-4"
        >
            <ShieldAlert size={15} aria-hidden="true" className="shrink-0" />
            <p className="min-w-0 flex-1 truncate text-[12.5px] leading-none">
                Viewing <span className="font-semibold">{accountName}</span>
                {actorEmail && (
                    <>
                        {' '}as super-admin <span className="font-semibold">{actorEmail}</span>
                    </>
                )}
                {/* "limited", not "safe": the allowlist admits real config writes
                    (agent settings, canned responses, conversation triage), so
                    the honest claim is scope-limited, not harmless. */}
                <span className="text-white/80"> · limited actions</span>
                {expiry && <span className="text-white/80 tabular-nums"> · expires {expiry}</span>}
            </p>
            <button
                type="button"
                onClick={handleExit}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1 text-[12px] font-semibold transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70"
            >
                <LogOut size={13} aria-hidden="true" />
                Exit
            </button>
        </div>
    );
}

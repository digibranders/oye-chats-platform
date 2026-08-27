import { t as translateNow } from '../i18n/i18n';
/**
 * Impersonation session store - deliberately TAB-SCOPED (``sessionStorage``).
 *
 * A super-admin opens a support session by following a one-time link minted by
 * the super-admin console (``?impersonation=<raw>``). That raw token is
 * redeemed once at boot and then becomes the credential carried on every
 * subsequent request as ``X-Impersonation-Token``.
 *
 * Why this does NOT go through ``utils/authStorage``
 * -------------------------------------------------
 * ``authStorage`` writes to ``localStorage`` ON PURPOSE so every tab in the
 * browser shares ONE customer session (see its module docstring). An
 * impersonation session is the exact opposite:
 *
 *   • It must not be shared. The super-admin very likely has their own genuine
 *     session open in another tab of the same browser; writing impersonation
 *     state into the shared bundle would stomp it everywhere.
 *   • It must die with the tab. ``sessionStorage`` gives us that for free -
 *     closing the tab ends the support session.
 *
 * So the two key names below are intentionally NOT members of
 * ``AUTH_STORAGE_KEYS`` and are never touched by ``clearAuthStorage()``.
 * Conversely, ending an impersonation session must never call
 * ``clearAuthStorage()`` - that would wipe the super-admin's real credentials
 * in every other tab.
 *
 * Server-side the token is re-validated on EVERY request (expiry + revocation),
 * so the client-side state here is a convenience, never the security boundary.
 */

/** sessionStorage key holding the raw impersonation token (the credential). */
export const IMPERSONATION_TOKEN_KEY = 'oc_impersonation_token';

/** sessionStorage key holding the redeemed profile JSON (Account + actor + expiry). */
export const IMPERSONATION_PROFILE_KEY = 'oc_impersonation_profile';

/** Query parameter carrying the raw token on the hand-off URL. */
export const IMPERSONATION_QUERY_PARAM = 'impersonation';

/** Window event fired once when a live impersonation session ends. */
export const IMPERSONATION_ENDED_EVENT = 'oyechats:impersonation-ended';

/**
 * Body class applied while a session is live.
 *
 * Kept as a hook for anything that needs to know, but it no longer drives a
 * layout offset: the bar is a flex row inside the shell (`ShellBanners`), so
 * nothing outside it has to compensate for its height. The rules it used to
 * carry in `index.css` targeted `[data-app-sidebar]` and `[data-app-topbar]`,
 * two attributes the rebuilt shell does not have, and the `body` padding they
 * came with pushed a `h-dvh` grid 36px below the fold.
 */
export const IMPERSONATION_BODY_CLASS = 'oc-impersonating';

/** Copy shown when the backend's write guard refuses a non-allowlisted action. */
export const IMPERSONATION_FORBIDDEN_MESSAGE = translateNow('app.disabledDuringImpersonation') || 'This action is disabled during impersonation.';

/** Default copy for a session the backend ended (expired or revoked). */
export const IMPERSONATION_ENDED_MESSAGE = translateNow('app.impersonationEnded') || 'Impersonation session ended.';

/**
 * Shown when the super-admin deliberately exits (rather than the session being
 * revoked or expiring out from under them). Exported so the four sign-out
 * surfaces cannot drift apart on the wording.
 */
export const IMPERSONATION_EXIT_MESSAGE = translateNow('app.impersonationEndedCloseTab') || 'Impersonation session ended. You can close this tab.';

/**
 * Latch: once a session has ended in this page's lifetime it stays ended.
 *
 * Two concurrent requests can both 401 on a revoked token. The first ends the
 * session and clears sessionStorage; without this latch the second would look
 * like an ordinary request from a non-impersonated tab and fall through to the
 * global auto-logout path, wiping the super-admin's real credentials. It also
 * lets the API client short-circuit every request issued after the end, so a
 * stale poller can never silently re-issue itself under the admin's own
 * ``X-API-Key``.
 */
let sessionEnded = false;

function readSessionValue(key) {
    try {
        return window.sessionStorage.getItem(key);
    } catch {
        // Private browsing / embedded webview with storage disabled. Treated as
        // "no session", which fails closed.
        return null;
    }
}

/**
 * Read ``?impersonation=<raw>`` and strip it from the address bar in the same
 * synchronous step.
 *
 * SECURITY: the strip is not cosmetic. The raw token is a live credential; left
 * in the URL it lands in browser history, in the ``Referer`` header of every
 * subsequent outbound request, and in every access log in front of this app.
 * The caller MUST invoke this before issuing any network call.
 *
 * @returns {string|null} the raw token, or null when the URL carries none.
 */
export function takeImpersonationTokenFromUrl() {
    if (typeof window === 'undefined') return null;

    const url = new URL(window.location.href);
    const token = url.searchParams.get(IMPERSONATION_QUERY_PARAM);
    if (!token) return null;

    url.searchParams.delete(IMPERSONATION_QUERY_PARAM);
    window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
    );
    return token;
}

/** The raw impersonation token for this tab, or null when not impersonating. */
export function getImpersonationToken() {
    return readSessionValue(IMPERSONATION_TOKEN_KEY);
}

/**
 * The redeemed profile for this tab:
 * ``{ client_id, name, email, expires_at, actor_email, is_impersonation }``.
 * Returns null when absent or unparseable (a corrupt value is treated as no
 * profile rather than crashing the banner).
 */
export function getImpersonationProfile() {
    const raw = readSessionValue(IMPERSONATION_PROFILE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** True while this tab holds a live impersonation credential. */
export function isImpersonating() {
    return getImpersonationToken() !== null;
}

/**
 * True once a session that WAS live has ended in this page's lifetime.
 * Consumers use it to keep treating the tab as an impersonation context even
 * after the credential has been cleared.
 */
export function isImpersonationSessionEnded() {
    return sessionEnded;
}

/**
 * Persist a freshly-redeemed session for this tab.
 *
 * @param {string} token - the raw token that was redeemed.
 * @param {object} profile - the redeem endpoint's 200 payload.
 * @throws {Error} when the token is missing or sessionStorage is unavailable -
 *   both mean the session cannot be started, and the caller must surface that
 *   rather than boot into a half-authenticated app.
 */
export function startImpersonationSession(token, profile) {
    if (!token) {
        throw new Error('Cannot start an impersonation session without a redeemed token.');
    }
    try {
        window.sessionStorage.setItem(IMPERSONATION_TOKEN_KEY, token);
        window.sessionStorage.setItem(IMPERSONATION_PROFILE_KEY, JSON.stringify(profile ?? {}));
    } catch {
        throw new Error('This browser blocks tab storage, which impersonation requires.');
    }
}

/**
 * Remove the impersonation keys. Touches ONLY the two tab-scoped keys above -
 * never ``clearAuthStorage()``, which would log the super-admin out of every
 * other tab in this browser.
 */
export function clearImpersonationSession() {
    try {
        window.sessionStorage.removeItem(IMPERSONATION_TOKEN_KEY);
        window.sessionStorage.removeItem(IMPERSONATION_PROFILE_KEY);
    } catch {
        // Storage already unavailable - there is nothing persisted to clear.
    }
}

/**
 * End a live impersonation session: clear the credential, latch the tab as
 * ended, and announce it once so the banner can render its terminal state.
 *
 * Idempotent, and a no-op when no session was live (so a stray call can never
 * latch a normal customer tab into the ended state).
 *
 * @param {string} [message] - user-facing reason shown on the terminal screen.
 */
export function endImpersonationSession(message = IMPERSONATION_ENDED_MESSAGE) {
    if (sessionEnded) return;
    const hadSession = isImpersonating();
    clearImpersonationSession();
    if (!hadSession) return;

    sessionEnded = true;
    window.dispatchEvent(
        new CustomEvent(IMPERSONATION_ENDED_EVENT, { detail: { message } }),
    );
}

/**
 * Sign-out guard for every UI path that would otherwise call
 * `clearAuthStorage()`.
 *
 * `clearAuthStorage()` wipes the SHARED localStorage bundle - the super-admin's
 * own credentials in every other tab of this browser. An impersonated tab must
 * never do that: signing out of a support session ends the support session
 * only. This helper is the single place that decision lives, so a new sign-out
 * path gets the behaviour by calling one function instead of re-deriving a
 * four-line guard (four such paths were shipped unguarded before this existed).
 *
 * Usage - bail out early when it returns true:
 *
 *     if (endImpersonationSessionFromSignOut()) return;
 *     clearAuthStorage();
 *
 * @returns {boolean} true if this was an impersonated tab and the support
 *   session was ended; false if the caller should proceed with a normal logout.
 */
export function endImpersonationSessionFromSignOut() {
    if (!isImpersonating()) return false;
    endImpersonationSession(IMPERSONATION_EXIT_MESSAGE);
    return true;
}

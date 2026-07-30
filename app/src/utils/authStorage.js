/**
 * Auth-aware storage wrapper.
 *
 * Auth ALWAYS lives in ``localStorage`` so every tab in the same browser
 * shares one session. It used to route non-"Remember me" logins into
 * ``sessionStorage``, but sessionStorage is per-tab - opening the app in a
 * second tab found no token and tore the whole session down. localStorage is
 * shared across tabs, which is the behaviour users expect.
 *
 * "Remember me" is preserved as an ABSOLUTE session expiry instead of a
 * per-tab store: remembered → 30 days, not-remembered → 1 day. The expiry is
 * armed whenever a login bundle (one carrying ``admin_token``) is written and
 * enforced once at app startup (see ``isSessionExpired`` + the guard in
 * main.jsx). A session with no expiry recorded (pre-migration) is treated as
 * valid so this change never force-logs-out an existing user.
 *
 * Reads still fall back to sessionStorage so any legacy per-tab session from
 * before this change keeps working in the tab that owns it.
 */

/** localStorage key holding the absolute session-expiry epoch (ms). */
export const SESSION_EXPIRY_KEY = 'admin_session_expires_at';
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; //  1 day

/**
 * Every browser-storage key that holds auth state. Used by ``clearAuthStorage``
 * on logout and by the API auto-logout interceptor. Adding a new auth-related
 * key? Add it here so logout fully clears it from both stores.
 */
export const AUTH_STORAGE_KEYS = [
    'admin_token',
    'admin_name',
    'admin_client_id',
    'admin_is_verified',
    'admin_pending_email',
    'auth_type',
    'operator_role',
    'operator_id',
    // Legacy keys from before the agent → operator rename - cleared on logout
    // in case the migration shim ran but the user logs out on an old session.
    'agent_role',
    'agent_id',
    'is_superadmin',
    'company_name',
    'company_website',
    'onboarding_complete',
    'selected_bot_id',
    // Workspace switcher state - the currently-active workspace context that
    // gets sent as X-Workspace-Id on every API call. Persisted across reloads
    // so the user comes back to the workspace they were in last.
    'current_workspace_id',
    'current_workspace_name',
    'current_workspace_role',
    SESSION_EXPIRY_KEY,
];

/**
 * Write a single auth key to localStorage (shared across tabs). Any legacy
 * sessionStorage copy of the same key is cleared so a stale per-tab shadow
 * can't shadow the shared value. The ``persistent`` param is accepted for
 * backward compatibility but no longer changes WHERE the value is stored -
 * session length is governed by the expiry armed in ``setAuthBundle``. Extra
 * positional args from legacy callers (the old ``persistent`` flag) are
 * harmlessly ignored.
 */
export function setAuthItem(key, value) {
    if (value === null || value === undefined) {
        removeAuthItem(key);
        return;
    }
    window.sessionStorage.removeItem(key);
    window.localStorage.setItem(key, String(value));
}

/**
 * Write every key in ``items`` with the same persistence tier. Falsy/nullish
 * values are skipped (NOT cleared) so callers can pass partial payloads
 * without accidentally nuking unrelated keys.
 */
export function setAuthBundle(items, persistent = true) {
    Object.entries(items).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        setAuthItem(k, v);
    });
    // A bundle carrying a token is a login/refresh - (re)arm the absolute
    // session expiry. Stored in localStorage so it's shared across tabs;
    // "Remember me" (persistent) buys 30 days, otherwise 1 day.
    if (items.admin_token) {
        const ttl = persistent ? REMEMBER_TTL_MS : SESSION_TTL_MS;
        window.localStorage.setItem(SESSION_EXPIRY_KEY, String(Date.now() + ttl));
    }
}

/**
 * True when a recorded session expiry has passed. A missing expiry (a session
 * created before this mechanism existed) is treated as NOT expired so the
 * migration never force-logs-out a currently-valid user.
 */
export function isSessionExpired() {
    const raw = window.localStorage.getItem(SESSION_EXPIRY_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() > ts;
}

/**
 * Read a single key. localStorage wins when both stores have it (shouldn't
 * happen because writes clear the other side, but defensive against legacy
 * data from before this module existed).
 */
export function getAuthItem(key) {
    const fromLocal = window.localStorage.getItem(key);
    if (fromLocal !== null) return fromLocal;
    return window.sessionStorage.getItem(key);
}

/** Delete a key from both stores. */
export function removeAuthItem(key) {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
}

/**
 * Wipe every known auth key from both stores. Used by logout handlers so a
 * session-only login is fully cleared without leaving stale localStorage
 * shadows (and vice versa).
 */
export function clearAuthStorage() {
    AUTH_STORAGE_KEYS.forEach(removeAuthItem);
}

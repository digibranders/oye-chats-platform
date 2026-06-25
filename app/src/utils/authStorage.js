/**
 * Auth-aware storage wrapper.
 *
 * Routes auth tokens + user metadata into one of two browser stores based on
 * the user's "Remember me" choice at login:
 *
 *   • ``persistent=true``  → ``localStorage``  (survives browser restart)
 *   • ``persistent=false`` → ``sessionStorage`` (cleared on tab close)
 *
 * All reads transparently fall back across both stores — callers never need
 * to know which one a given session chose. Writes target ONE store and clear
 * the OTHER to prevent ambiguous duplicates (otherwise a logout that only
 * clears localStorage would leave a sessionStorage shadow that auto-logs the
 * user back in on next request).
 *
 * Use ``setAuthBundle`` to set every login payload field in one call so they
 * stay aligned on the same persistence tier.
 */

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
    // Legacy keys from before the agent → operator rename — cleared on logout
    // in case the migration shim ran but the user logs out on an old session.
    'agent_role',
    'agent_id',
    'is_superadmin',
    'company_name',
    'company_website',
    'onboarding_complete',
    'selected_bot_id',
];

/**
 * Write a single key. ``persistent=true`` uses localStorage; ``false`` uses
 * sessionStorage. The opposite store is cleared so the next read sees one
 * unambiguous source.
 */
export function setAuthItem(key, value, persistent = true) {
    if (value === null || value === undefined) {
        removeAuthItem(key);
        return;
    }
    const stringified = String(value);
    if (persistent) {
        window.sessionStorage.removeItem(key);
        window.localStorage.setItem(key, stringified);
    } else {
        window.localStorage.removeItem(key);
        window.sessionStorage.setItem(key, stringified);
    }
}

/**
 * Write every key in ``items`` with the same persistence tier. Falsy/nullish
 * values are skipped (NOT cleared) so callers can pass partial payloads
 * without accidentally nuking unrelated keys.
 */
export function setAuthBundle(items, persistent = true) {
    Object.entries(items).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        setAuthItem(k, v, persistent);
    });
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

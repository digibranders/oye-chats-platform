/**
 * TrialBanner — storage helpers.
 *
 * Lives in its own module so the component file
 * (``src/components/TrialBanner.jsx``) stays "components only", which
 * is the contract Vite's fast-refresh enforces. Same prefix the banner
 * writes — kept here as the canonical source so login / logout paths
 * can scrub dismissals without having to know the key shape.
 */

const DISMISS_STORAGE_PREFIX = 'trial_banner_dismissed_';

/** Build the sessionStorage key for a given subscription status. */
export function bannerDismissKey(status) {
    return `${DISMISS_STORAGE_PREFIX}${status}`;
}

/**
 * Read whether the banner for ``status`` was previously dismissed in
 * this session. Defaults to ``false`` if sessionStorage is unavailable
 * (private browsing, embedded webviews) so the banner stays visible.
 */
export function readBannerDismissed(status) {
    if (!status) return false;
    try {
        return sessionStorage.getItem(bannerDismissKey(status)) === '1';
    } catch {
        return false;
    }
}

/** Mark the ``status`` banner as dismissed for the rest of this session. */
export function markBannerDismissed(status) {
    if (!status) return;
    try {
        sessionStorage.setItem(bannerDismissKey(status), '1');
    } catch {
        // Ignore — banner still hides for this render via component state.
    }
}

/**
 * Wipe every ``trial_banner_dismissed_*`` flag from sessionStorage.
 *
 * Called on login (Login.jsx), explicit logout (TopBar.jsx) and the
 * auth interceptor's auto-logout path (services/api.js) so the banner
 * reappears the moment a customer re-authenticates. Without this the
 * dismissal would survive a logout + login cycle in the same tab,
 * leaving the next user permanently blind to "trial ends tomorrow"
 * after the previous user dismissed it once.
 */
export function clearTrialBannerDismissals() {
    try {
        const keys = Object.keys(sessionStorage).filter((k) => k.startsWith(DISMISS_STORAGE_PREFIX));
        keys.forEach((k) => sessionStorage.removeItem(k));
    } catch {
        // Ignore — degrades to "banner shows unless re-dismissed", the safe direction.
    }
}

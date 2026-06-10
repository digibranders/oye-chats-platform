/**
 * Affiliate referral cookie — admin-app side of the flow.
 *
 * The marketing site (oyechats.com) sets the ``oye_ref_v1`` cookie scoped
 * to ``.oyechats.com``. The admin app (app.oyechats.com) reads it here at
 * signup, attaches the code to the /auth/register payload, and clears
 * the cookie on success so a single visitor cannot accidentally re-attribute
 * to a future signup on the same browser.
 *
 * Mirrors the shape of the same-named module on the landing site — they
 * intentionally use the SAME cookie name and version so the value
 * survives the subdomain hop without translation.
 */

const REF_COOKIE = 'oye_ref_v1';

// Same regex as the backend's DB CHECK constraint — guards against
// arbitrarily long / malformed cookie payloads being sent as a referral
// code. The backend will revalidate anyway; this just keeps the network
// call tidy.
const CODE_REGEX = /^[A-Za-z0-9_-]{3,20}$/;

function cookieDomain() {
    if (typeof window === 'undefined') return null;
    const host = window.location.hostname;
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (host.endsWith('.oyechats.com') || host === 'oyechats.com') {
        return '.oyechats.com';
    }
    return null;
}

/** Read the referral cookie. Returns null on missing/malformed values. */
export function readReferralCookie() {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(
        new RegExp(`(?:^|;\\s*)${REF_COOKIE}=([^;]+)`),
    );
    if (!match) return null;
    const value = decodeURIComponent(match[1]).trim();
    // Defensive: never trust the cookie contents — the backend revalidates,
    // but bailing here saves a wasted register-with-bad-code round-trip.
    return CODE_REGEX.test(value) ? value : null;
}

/** Clear the cookie. Call after a successful signup so it can't replay. */
export function clearReferralCookie() {
    if (typeof document === 'undefined') return;
    const parts = [`${REF_COOKIE}=`, 'path=/', 'max-age=0'];
    const domain = cookieDomain();
    if (domain) parts.push(`domain=${domain}`);
    document.cookie = parts.join('; ');
}

import { useCallback, useEffect, useState } from 'react';
import { LogOut, ShieldAlert } from 'lucide-react';
import {
  IMPERSONATION_ENDED_EVENT,
  endImpersonationSession,
  getImpersonationProfile,
  isImpersonating,
  type ImpersonationProfile,
} from '../utils/impersonation';
import { ImpersonationNotice } from './ImpersonationNotice';

/**
 * The bar shown on every page while a super-admin is acting inside somebody
 * else's account.
 *
 * Two jobs, both non-negotiable:
 *   1. Make it impossible to forget. Everything on screen belongs to another
 *      account, so the bar sits above the top bar as a real layout row and
 *      carries the danger fill — deliberately unlike the customer's own
 *      informational banners, and with no dismiss control.
 *   2. Give a way out. Exit clears the tab-scoped session and closes the tab;
 *      when the browser refuses to close a tab it did not open, the terminal
 *      notice takes over so the app is never left interactive with a half-dead
 *      session.
 *
 * It is a **flex child of the shell**, not a `position: fixed` strip. The
 * version this replaces was fixed at `z-70` and offset the app with a
 * `body.oc-impersonating` padding rule that targeted `[data-app-sidebar]` and
 * `[data-app-topbar]` — two attributes the rebuilt shell does not have — so it
 * pushed a `h-dvh` grid 36px below the fold and clipped the account menu off
 * screen. A layout row cannot drift from the chrome it sits above.
 *
 * Every colour here is a token. The version this replaces reached for
 * `bg-rose-600`, `text-white` and `bg-white/15`, all of which `tokens.css`
 * deletes with `--color-*: initial` — the built stylesheet contained none of
 * them, so the one bar that must never be missed rendered as a transparent
 * strip with near-black text.
 *
 * Renders nothing when not impersonating, so it is safe to mount unconditionally.
 */

/**
 * Parse the redeem endpoint's `expires_at`.
 *
 * The column is `TIMESTAMP WITH TIME ZONE`, so the wire value normally carries
 * an explicit offset. An offset-less ISO string still means UTC on this API,
 * but `new Date()` would read it as LOCAL time and skew the whole expiry by the
 * viewer's offset — a banner showing the wrong deadline and a shutdown timer
 * firing hours early or late. Pin the zone when it is missing.
 */
function parseExpiry(expiresAt: string | undefined): Date | null {
  if (typeof expiresAt !== 'string' || !expiresAt) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(expiresAt);
  const at = new Date(hasZone ? expiresAt : `${expiresAt}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Format the expiry as a local wall-clock time, e.g. "12:30". */
function formatExpiry(expiresAt: string | undefined): string | null {
  const at = parseExpiry(expiresAt);
  return at ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
}

/** `setTimeout` saturates past this — clamp so a far-future expiry does not fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function ImpersonationBanner() {
  // A tab holding the credential ALWAYS gets the bar, even if the stored
  // profile is missing or corrupt — an unlabelled impersonated session is the
  // one state this component exists to prevent. Empty object → the field
  // fallbacks below.
  const [profile, setProfile] = useState<Partial<ImpersonationProfile> | null>(() =>
    isImpersonating() ? (getImpersonationProfile() ?? {}) : null,
  );
  const [endedMessage, setEndedMessage] = useState<string | null>(null);

  const active = profile !== null && endedMessage === null;

  // The API client ends the session on a 401 (expired / revoked) and Exit ends
  // it locally. Both announce through the same event, so this is the one place
  // that flips the banner into its terminal state.
  useEffect(() => {
    function onEnded(event: Event) {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setProfile(null);
      setEndedMessage(detail?.message || 'Impersonation session ended.');
    }
    window.addEventListener(IMPERSONATION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(IMPERSONATION_ENDED_EVENT, onEnded);
  }, []);

  // Close the session the moment the token lapses instead of waiting for the
  // next request to 401. Server-side expiry is still the real boundary; this
  // just stops the tab presenting a dead session as a live one.
  useEffect(() => {
    if (!active || !profile) return undefined;
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
    // Only works for tabs opened by script — which is how the super-admin
    // console launches this one. When it does not, the notice stands in.
    window.close();
  }, []);

  if (endedMessage) {
    return <ImpersonationNotice title="Impersonation session ended" message={endedMessage} />;
  }
  if (!active || !profile) return null;

  // Every field degrades independently: a missing name or actor drops that
  // clause rather than printing a placeholder that reads like real data.
  const accountName =
    profile.name || (profile.client_id ? `Account #${profile.client_id}` : 'this account');
  const actorEmail = profile.actor_email || null;
  const expiry = formatExpiry(profile.expires_at);

  return (
    <div
      role="alert"
      className="flex min-h-9 shrink-0 items-center gap-3 bg-danger-fill px-gutter py-1.5 text-text-inverse lg:px-gutter-lg"
    >
      <ShieldAlert aria-hidden className="h-icon-md w-icon-md shrink-0" />
      {/* Two lines on a narrow window rather than a truncation plus a native
          `title` — DESIGN.md §6.9 bans the attribute, and this is the one
          string a super-admin genuinely has to be able to read in full. */}
      <p className="min-w-0 flex-1 text-xs">
        Viewing <span className="font-semibold">{accountName}</span>
        {actorEmail ? (
          <>
            {' '}
            as super-admin <span className="font-semibold">{actorEmail}</span>
          </>
        ) : null}
        {/* "limited", not "safe": the allowlist admits real config writes
            (chatbot settings, canned responses, conversation triage), so the
            honest claim is scope-limited, not harmless. */}
        <> · limited actions</>
        {expiry ? <> · expires <span className="figure">{expiry}</span></> : null}
      </p>
      <button
        type="button"
        onClick={handleExit}
        className="inline-flex h-control-sm shrink-0 items-center gap-1.5 rounded-sm bg-surface px-2.5 text-xs font-medium text-danger transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-surface"
      >
        <LogOut aria-hidden className="h-icon-sm w-icon-sm" />
        Exit
      </button>
    </div>
  );
}

export default ImpersonationBanner;

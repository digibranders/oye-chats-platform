import { AlertTriangle, RotateCw } from 'lucide-react';
import { useEntitlements } from '../hooks/useEntitlements';

/**
 * Says so when the app could not read the customer's plan.
 *
 * `EntitlementsProvider` falls back to Free defaults when
 * `GET /auth/me/entitlements` fails. That policy is right: denying by default
 * matches the backend resolver, and it beats crashing or leaving a stale
 * paid snapshot in place. What was missing is that the fallback was
 * indistinguishable from the truth. `loading` goes false, `error` was read by
 * none of the thirty-four `useEntitlements()` call sites, and the whole
 * console rearranges itself around a plan the customer does not have: Team
 * locked behind "Your plan does not include a team", Settings reporting
 * "Plan: Free", top-ups refused, and a workspace with six chatbots told that
 * "Free includes 1 chatbot; you have 6".
 *
 * A paying customer meeting that after one 500 has no way to tell a failed
 * request from a downgrade, and every reasonable reading of it is alarming.
 *
 * One banner rather than an error branch in thirty-four places. The locked
 * states stay exactly as they are, because a failed read genuinely cannot
 * authorise anything; this only stops them lying about WHY. It sits in the
 * shell so it reaches whichever page the customer happens to be on when the
 * request fails.
 *
 * Every colour is a real token. `tokens.css` defines `--color-warning`,
 * `--color-warning-fill` and `--color-warning-tint` and deletes Tailwind's own
 * palette with `--color-*: initial`, so a plausible-looking `bg-warning-50`
 * compiles to nothing and the banner renders as an unstyled strip.
 *
 * Not dismissible. Every surface it explains is still locked, so dismissing it
 * would restore the silent-downgrade state it exists to prevent.
 */
export function EntitlementsErrorBanner() {
  const { error, loading, refresh } = useEntitlements();

  // `loading` matters: a refresh after a failure keeps the previous error until
  // the new response lands, and a banner that stays up while its own retry is
  // in flight reads as a retry that did nothing.
  if (!error || loading) return null;

  return (
    <div
      role="alert"
      data-testid="entitlements-error-banner"
      className="flex items-center gap-3 border-b border-border bg-warning-tint px-gutter py-2 text-sm text-text-primary lg:px-gutter-lg"
    >
      <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1">
        <strong className="font-medium">We could not read your plan.</strong> Features are shown as
        unavailable until we can. This is not a change to your subscription.
      </p>
      <button
        type="button"
        onClick={() => void refresh()}
        className="inline-flex shrink-0 items-center gap-1.5 font-medium underline-offset-2 hover:underline"
      >
        <RotateCw aria-hidden className="h-3.5 w-3.5" />
        Try again
      </button>
    </div>
  );
}

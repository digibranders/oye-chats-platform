import { EntitlementsErrorBanner } from './EntitlementsErrorBanner';
import { ImpersonationBanner } from './ImpersonationBanner';
import { TrialBanner } from './TrialBanner';

/**
 * Shell-level banners.
 *
 * These are the messages that must reach the user wherever they are, because
 * they describe the account rather than the page: an impersonated session, and
 * in a later slice a failed payment and an unverified email. The onboarding
 * flow this replaces lived outside the shell entirely, which meant a customer
 * could hand over a card on a screen structurally incapable of telling them
 * their last payment had failed.
 *
 * A banner here is a **layout row**, not an overlay. It is rendered above the
 * top bar as an ordinary flex child, so it pushes the chrome down instead of
 * painting over it. The impersonation bar used to be `position: fixed` at
 * `z-70` with a `body { padding-top }` rule compensating for it — and that rule
 * targeted two attributes the rebuilt shell no longer has, so the bar covered
 * the top bar and the shell hung 36px below the fold.
 *
 * It shares the page gutter, so a banner, the breadcrumb and the page title
 * stand on one left edge.
 */
export function ShellBanners() {
  return (
    <>
      <ImpersonationBanner />
      {/* Below the impersonation bar: an impersonated session is a fact about
          WHO is looking, which outranks a fact about the account they are
          looking at. */}
      <TrialBanner />
      {/* Last: it explains why the rest of the console looks locked, which only
          matters once you have read what the account itself is doing. */}
      <EntitlementsErrorBanner />
    </>
  );
}

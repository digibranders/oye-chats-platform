/**
 * Shell-level banners.
 *
 * These are the messages that must reach the user wherever they are, because
 * they describe the account rather than the page: a failed payment, an
 * unverified email, an impersonated session. The onboarding flow this replaces
 * lived outside the shell entirely, which meant a customer could hand over a
 * card on a screen that was structurally incapable of telling them their last
 * payment had failed.
 *
 * Deliberately empty for now: the billing and verification surfaces are rebuilt
 * in a later slice, and a banner is only worth rendering once the destination it
 * sends the user to exists. The slot is here so that arrives as one change.
 */
export function ShellBanners() {
  return null;
}

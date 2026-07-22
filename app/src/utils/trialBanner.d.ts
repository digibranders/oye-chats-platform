/**
 * Type shim for the legacy JS trial-banner dismissal helper (`utils/trialBanner.js`).
 * The `.js` remains the runtime source; this only supplies types to new TS code.
 */
export function bannerDismissKey(status: string): string;
export function readBannerDismissed(status: string | null | undefined): boolean;
export function markBannerDismissed(status: string | null | undefined): void;
/** Wipe every `trial_banner_dismissed_*` flag — call on login/logout so the banner re-evaluates. */
export function clearTrialBannerDismissals(): void;

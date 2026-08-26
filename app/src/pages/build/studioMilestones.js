// The four guided milestones of the Build Studio, in order ("Prove-it-first"
// reorder - the aha lands at step 2, before any naming/appearance work).
//   - `key`   drives the ?m= URL param (resumability + deep-link)
//   - `label` is the compact spine label
//   - `title` is the milestone heading shown in the spine + guide pane
// @i18n-exempt: these labels are not rendered anywhere. Build Studio was
// replaced by Launch Studio; the only live exports of this module are
// `STUDIO_RESUME_KEY` and `isMilestoneKey`, and the latter reads `key` alone
// (a URL parameter, never translated). Translating dead copy would spend a
// translator's time on strings no user can reach.
export const MILESTONES = [
    { key: 'connect', label: 'Connect', title: 'Point me at your site' },
    { key: 'prove', label: 'Prove', title: 'Watch it learn - then prove it' },
    { key: 'personalize', label: 'Personalize', title: 'Make it yours' },
    { key: 'golive', label: 'Go live', title: 'Put it live' },
];

// localStorage key holding the furthest-reached milestone, so the Dashboard's
// "Resume setup" nudge can deep-link a returning user back to where they left
// off (?m=<key>) instead of restarting them on a blank step 1.
export const STUDIO_RESUME_KEY = 'oc_studio_resume_m';

// True when `key` names a real milestone - guards a stale/hand-edited ?m= value.
export function isMilestoneKey(key) {
    return MILESTONES.some((m) => m.key === key);
}

// Resolve a milestone key (from the ?m= param) to its index, defaulting to the
// first milestone for a missing/unknown key.
export function milestoneIndex(key) {
    const i = MILESTONES.findIndex((m) => m.key === key);
    return i === -1 ? 0 : i;
}

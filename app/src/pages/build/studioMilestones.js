// The four guided milestones of the Build Studio, in order ("Prove-it-first"
// reorder — the aha lands at step 2, before any naming/appearance work).
//   - `key`   drives the ?m= URL param (resumability + deep-link)
//   - `label` is the compact spine label
//   - `title` is the milestone heading shown in the spine + guide pane
export const MILESTONES = [
    { key: 'connect', label: 'Connect', title: 'Point me at your site' },
    { key: 'prove', label: 'Prove', title: 'Watch it learn — then prove it' },
    { key: 'personalize', label: 'Personalize', title: 'Make it yours' },
    { key: 'golive', label: 'Go live', title: 'Put it live' },
];

// Resolve a milestone key (from the ?m= param) to its index, defaulting to the
// first milestone for a missing/unknown key.
export function milestoneIndex(key) {
    const i = MILESTONES.findIndex((m) => m.key === key);
    return i === -1 ? 0 : i;
}

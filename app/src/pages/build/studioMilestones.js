// The five guided milestones of the Build Studio, in order.
//   - `key`   drives the ?m= URL param (resumability + deep-link)
//   - `label` is the compact spine label
//   - `title` is the milestone heading shown in the spine + guide pane
export const MILESTONES = [
    { key: 'create', label: 'Create', title: 'Create your agent' },
    { key: 'train', label: 'Train', title: 'Train it on your website' },
    { key: 'test', label: 'Test & trust', title: 'Test & trust it' },
    { key: 'appearance', label: 'Appearance', title: 'Make it yours' },
    { key: 'golive', label: 'Go live', title: 'Put it live' },
];

// Resolve a milestone key (from the ?m= param) to its index, defaulting to the
// first milestone for a missing/unknown key.
export function milestoneIndex(key) {
    const i = MILESTONES.findIndex((m) => m.key === key);
    return i === -1 ? 0 : i;
}

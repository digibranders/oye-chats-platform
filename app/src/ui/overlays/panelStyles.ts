import { cn } from '../lib/cn';

/**
 * The shape every anchored floating panel shares — menu, submenu, popover and
 * the combobox's list.
 *
 * Two decisions live here, both of which were silent disagreements before.
 *
 * **The z-index goes on the Positioner, not on the Popup.** Base UI puts
 * `position: fixed` on the Positioner and renders the Popup as a plain static
 * child, and `z-index` on a statically-positioned element does nothing at all.
 * So the `--z-*` ladder that `tokens.css` documents governed no anchored overlay
 * in the console: every menu, popover, tooltip and combobox list stacked by
 * portal DOM order. It worked only because the portal happened to be last in
 * `<body>`, and would have failed the first time a toast (`--z-toast`) or the
 * impersonation banner (`--z-banner`) was meant to sit above one.
 *
 * **A floating panel is 10px, not 14.** DESIGN.md §4 assigns "modals, drawers,
 * popovers" 14 and all three panels shipped at 10. The code is right: 14px on a
 * 176px-wide menu reads as a toast, and 10 − 4px of panel padding = 6, which is
 * exactly the item radius — the concentric maths works out rather than being a
 * coincidence. §4 should read *"10 card and floating panel · 14 modal and
 * drawer"*.
 *
 * The minimum width is shared for the same reason: three panels shipped three
 * different minimums (176 / 224 / none), none derived from anything. 208 fits
 * "No matches" plus a scrollbar.
 *
 * One more thing these panels have in common, recorded because DESIGN.md §5
 * currently says the opposite: an outline **is** clipped by an `overflow`
 * ancestor. It follows `border-radius` and takes no layout space, but it is
 * painted inside the ancestor's clip rect like any other ink — so a control at
 * the edge of a scrolling panel needs inset room for its ring. `Menu` and the
 * combobox list get away with 4px only because their items use `outline-none`
 * plus a highlight background; `PopoverBody` has to leave real room.
 */
export const PANEL_POSITIONER = 'z-[var(--z-overlay)]';

export const PANEL_BASE = cn(
  'motion-pop rounded-lg border border-border bg-surface shadow-md focus:outline-none',
);

/**
 * A panel that is a list of its own children, sized to fit them.
 *
 * `max-w-xs` is not optional: without a bound, one menu item rendering a bot
 * name or a document title stretches the popup to the collision boundary, and
 * the `truncate` on every item is dead code because its flex container is
 * unbounded.
 */
export const PANEL_LIST = cn(PANEL_BASE, 'min-w-52 max-w-xs p-1');

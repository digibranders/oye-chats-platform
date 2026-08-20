/**
 * The tab row's geometry, shared by `Tabs` and `NavTabs`.
 *
 * The two rows are one control with two different mechanisms behind them, and
 * they were drifting: every class string was written twice, so a fix to one had
 * to be remembered for the other. Same file split as `buttonStyles.ts`, and for
 * the same reason.
 */
/**
 * The tab itself.
 *
 * `h-control-lg` (40) rather than the previous `py-2.5` (42), which was not
 * `control-md`, `control-lg` or `row` — so a tab row above a toolbar lined up
 * with none of the controls beside it. The active marker is an **inset shadow**
 * rather than a border, so it sits exactly on the row's own hairline instead of
 * a pixel above it, nudging the label; and it is `accent-500`, because
 * DESIGN.md §1 says blue means active nav and this was the one selection state
 * in the app painted in ink.
 */
export const TAB_ITEM =
  'relative inline-flex h-control-lg shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-base font-medium transition-colors duration-[var(--dur-fast)]';
export const TAB_ACTIVE = 'text-text-primary shadow-[inset_0_-2px_0_var(--color-accent-500)]';
export const TAB_IDLE = 'text-text-secondary hover:text-text-primary';

/**
 * The same marker, expressed as Base UI's `data-selected` state.
 *
 * Written out in full rather than derived from `TAB_ACTIVE` at runtime: Tailwind
 * finds class names by scanning source text, so a class assembled from a
 * variable is a class that never gets generated.
 */
export const TAB_SELECTED =
  'data-[selected]:text-text-primary data-[selected]:shadow-[inset_0_-2px_0_var(--color-accent-500)]';

/**
 * The scroller.
 *
 * `-mx-3` pulls the first tab's *label* onto the page gutter — the tab's box
 * started there before, but its text began 12px in, so the row lined up with
 * neither the page title above it nor the card content below it. Linear and
 * Stripe both pull the first tab flush.
 *
 * The row scrolls rather than wraps: a wrapped row changes the page height when
 * the active tab changes, shifting content under the reader's cursor.
 */
export const TAB_LIST = '-mx-3 flex gap-1 overflow-x-auto';

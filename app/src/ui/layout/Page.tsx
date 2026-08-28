import { useCallback, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Eyebrow } from '../primitives/Misc';

/**
 * `page` fills the content area up to 1440. `full` removes the ceiling for a
 * surface that has to reach the viewport edge.
 *
 * `default` and `wide` are the previous vocabulary, kept so the routes that
 * still name them keep compiling. They are deprecated: `wide` is `page`, and
 * `default` is a page whose *content* wants a reading measure — which is a
 * property of the content, not of the page, and is now `Column`.
 */
export type PageWidth = 'page' | 'full' | 'default' | 'wide';

const WIDTHS: Record<PageWidth, string> = {
  page: 'max-w-page',
  // No max width. Padding is controlled separately by `gutter`, because a
  // full-bleed table page still wants vertical rhythm — dropping both left the
  // first row flush against the top of the viewport.
  full: 'max-w-none',
  wide: 'max-w-page',
  /** @deprecated Use `<Page><Column width="form">`. */
  default: 'max-w-reading',
};

export interface PageProps {
  children: ReactNode;
  width?: PageWidth;
  /** Horizontal padding. Off for a surface that must reach the viewport edge. */
  gutter?: boolean;
  /**
   * Row heights and cell padding for everything inside.
   *
   * One attribute on the page root, not a prop threaded through forty
   * components: `data-density` cascades `--row-h` / `--cell-x` / `--cell-y`, and
   * `DataTable`, `PropertyGrid` and `SettingRow` read them. The ops console and
   * the leads book opt in; everything else stays comfortable.
   */
  density?: 'comfortable' | 'dense';
  className?: string;
}

/**
 * The scroll body of a routed page. Chrome above it belongs to the shell.
 *
 * **The page box never moves.** It used to be `mx-auto`, which meant navigating
 * from a `wide` page to a `default` one slid the title, the tab row and every
 * card 148px to the right at 1440 and 388px at 1920, then back again — the app
 * had no stable left edge, and that is the single most visible cause of "the
 * arrangement of pages is broken". Left-anchoring costs nothing: a narrow
 * measure is what `Column` is for, and a `Column` inside a left-anchored page
 * keeps its 672px of reading width *and* the page's left edge.
 *
 * **`@container/page` is declared here**, and it is the breakpoint the layout
 * layer measures against. Not the viewport: this console has panes, and a
 * viewport query puts two columns inside a 320px inbox pane on a 1920px screen.
 * The name is re-declared by every primitive that narrows the measure —
 * `Column`, `Columns`, `SidebarLayout`, `SplitPane`, `PropertyGrid` — so
 * `@3xl/page:` always means "the box I am actually in is at least 768 wide",
 * wherever it is written. There is one name because there is one question.
 *
 * Horizontal padding is 24 below `lg` and 32 at and above, from one token pair
 * that `TopBar` and `ShellBanners` also consume — so the breadcrumb, the banner
 * and the page title stand on one left edge instead of three. Vertical padding
 * is its own, smaller number: nothing else lines up against the page's top or
 * bottom edge the way three surfaces line up against its left one, so there is
 * no shared alignment to preserve, and no reason to pay 32px for it.
 */
export function Page({
  children,
  width = 'page',
  gutter = true,
  density = 'comfortable',
  className,
}: PageProps) {
  return (
    <div
      data-density={density === 'dense' ? 'dense' : undefined}
      className={cn(
        '@container/page w-full py-4 lg:py-5',
        gutter && 'px-gutter lg:px-gutter-lg',
        WIDTHS[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  /**
   * The page's `h1`.
   *
   * `ReactNode`, not `string`, for the one thing a string cannot carry: a
   * decorative glyph that has to be hidden from assistive tech. Home's
   * greeting ends in an emoji, and a screen reader announcing "Good
   * afternoon, Gaurav, sun behind cloud" is noise — so that glyph is a
   * child `span` with `aria-hidden`. `PaneHeader.title` is already typed
   * this way for the same reason.
   */
  title: ReactNode;
  /**
   * How large the title prints.
   *
   * `page` (22px) is the default and is right for a title that NAMES the
   * surface — "Leads", "Settings". `display` (28px, the rung `tokens.css`
   * reserves for heroes) is for the rarer heading that IS the content
   * rather than a label for it: Home greets the person by name, and that
   * line is the most important thing on the page rather than a caption
   * over it.
   */
  titleSize?: 'page' | 'display';
  /**
   * One line. If it needs two, it is documentation, not a page description —
   * put it behind a link or in the control's own hint.
   */
  description?: ReactNode;
  /** Mono uppercase label above the title, naming the object or area. */
  eyebrow?: string;
  /** Primary and secondary controls for the whole page. */
  actions?: ReactNode;
  /** A tab row, filter bar or scope switcher, rendered under the title block. */
  toolbar?: ReactNode;
  /**
   * Keep the `h1` for screen-reader heading navigation, but do not print it.
   *
   * The shell's own top-bar breadcrumb already names a top-level page — for
   * a single-segment route like `/leads` that trail is exactly one crumb,
   * "Leads" — and this component's `title` prop restates the identical word
   * in 20px type six lines down. That is the same defect its own docstring
   * describes for two `h1`s on one page, in reverse: not a missing heading,
   * a heading that is also printed as chrome a few pixels above itself.
   *
   * Set it when the page's name is already on screen, which happens two
   * ways. The breadcrumb's last segment IS the title — true of `/leads`, and
   * equally of `/settings/workspace`, whose trail reads "Settings › Workspace"
   * and so prints both words before the page starts. Or a tab row in
   * `toolbar` names the current view: across Billing the crumb says "Usage",
   * the active tab says "Usage", and the `h1` between them was a third
   * statement of it. That one shipped half-done — Plan hid its title while
   * Usage and Reports kept theirs, so the same tab strip grew and shrank a
   * heading depending on which tab you were on.
   *
   * Leave it off when the page's name appears nowhere else on the screen.
   */
  titleVisuallyHidden?: boolean;
  /**
   * Run the toolbar's own hairline to the edges of the content area.
   *
   * A tab row draws a rule under itself, and inside the page gutter that rule
   * starts 32px in and stops 32px short — it reads as an underline on a
   * paragraph rather than as a structural division. Every console this is
   * benchmarked against runs it edge to edge. Only for a toolbar that draws a
   * bottom rule, and only on a page with a gutter to cancel.
   */
  toolbarBleed?: boolean;
  className?: string;
}

/**
 * A page's title block.
 *
 * Renders the only `h1` on the page. The old app had pages with two `h1`s (the
 * agent shell's name plus the tab's own title) and four tabs with no heading at
 * all, so a screen-reader user tabbing between them heard either a duplicate or
 * nothing.
 *
 * The description is 13px secondary text on a reading measure, not the 14/1.625
 * over 672px it used to be — that is a marketing subhead, and a console's page
 * description is a caption.
 */
export function PageHeader({
  title,
  titleSize = 'page',
  description,
  eyebrow,
  actions,
  toolbar,
  toolbarBleed = false,
  titleVisuallyHidden = false,
  className,
}: PageHeaderProps) {
  // `titleVisuallyHidden` hides the title text, not the title BLOCK — the row
  // it sits in, and the `mb-6` this component always used to carry below it,
  // are a separate question. A guard state that passes nothing else (no
  // eyebrow, no description, no actions, no toolbar) has, once the title is
  // hidden, nothing left to show at all — and reserving 24px of margin below
  // an invisible line is the exact defect `titleVisuallyHidden` exists to fix,
  // just relocated from "duplicate text" to "dead space where the text was."
  const hasContentWorthTheFullGap = Boolean(eyebrow) || !titleVisuallyHidden || Boolean(description);
  const hasVisibleTopRow = hasContentWorthTheFullGap || Boolean(actions);
  const hasVisibleContent = hasVisibleTopRow || Boolean(toolbar);
  // A page whose header is otherwise nothing but a hidden title and a single
  // right-aligned `actions` control (no eyebrow, no description, no toolbar
  // below it to lean on) reads as a floating button over a blank shelf — the
  // full `mb-6` a real title block earns was tuned for *that* block, not for
  // one button with nothing to its left. Tighter margin, same control.
  const marginClass = !hasVisibleContent
    ? undefined
    : hasContentWorthTheFullGap || toolbar
      ? 'mb-6'
      : 'mb-4';

  return (
    <header className={cn(marginClass, className)}>
      {hasVisibleTopRow ? (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
            <h1
              className={cn(
                titleVisuallyHidden
                  ? 'sr-only'
                  : cn(
                      'font-semibold text-text-primary',
                      titleSize === 'display' ? 'text-2xl' : 'text-xl',
                      eyebrow && 'mt-1',
                    ),
              )}
            >
              {title}
            </h1>
            {description ? (
              <p className="mt-1 max-w-reading text-sm text-text-secondary">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : (
        // Nothing to show, but the `h1` still has to exist — a screen-reader
        // user tabbing between pages must still hear the page's name.
        <h1 className="sr-only">{title}</h1>
      )}
      {toolbar ? (
        <div
          className={cn(
            // `mt-6` separates the toolbar from a visible title/actions row
            // above it. A page like Analytics — hidden title, no eyebrow, no
            // actions, the tab row *is* the header — has no such row, so that
            // margin was pure top-padding stacked on the page's own, paid
            // twice for the same gap.
            hasVisibleTopRow && 'mt-6',
            toolbarBleed && '-mx-gutter px-gutter lg:-mx-gutter-lg lg:px-gutter-lg',
          )}
        >
          {toolbar}
        </div>
      ) : null}
    </header>
  );
}

export interface SectionProps {
  title?: string;
  /** One clause. Never a restatement of the title. */
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** An id, so a settings page's secondary nav can link straight to it. */
  id?: string;
  className?: string;
}

/**
 * A titled division of a page.
 *
 * Sections are how a long settings page stays navigable: each one gets a real
 * heading and an id, rather than the previous app's practice of separating five
 * unrelated blocks with an unlabelled `border-t`.
 *
 * **A `Section` wrapping exactly one `Card` is a mistake**, and it is the most
 * common one on this surface: the section prints an 18px heading and a
 * description, and the card underneath prints an eyebrow, a 14px heading and
 * another description — five text elements and up to six lines before any
 * control. One card means the card carries the title; a `Section` earns its
 * heading when it groups two or more.
 *
 * `scroll-mt` matches the page's own top padding, not an invented 96: the
 * shell's `main` is the scroll container and the top bar sits outside it, so a
 * deep link to a section used to land 96px below where it should.
 */
export function Section({ title, description, actions, children, id, className }: SectionProps) {
  return (
    <section id={id} className={cn('scroll-mt-gutter lg:scroll-mt-gutter-lg', className)}>
      {title ? (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
            {description ? (
              <p className="mt-1 max-w-reading text-xs text-text-tertiary">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Vertical rhythm between sections. One gap value, applied in one place.
 *
 * **`Stack` is not how you arrange peers.** It stacks *sections* — a header, a
 * table, a group of settings — down the page. Two or more cards that answer the
 * same question at the same altitude are a `Grid`, and the reason this docstring
 * has to say so is that `Stack` was for a while the only composition primitive
 * the system exported: 88 hand-written `grid-cols-*` strings appeared in
 * `features/`, and every page whose author did not hand-roll one rendered a
 * single column of full-width cards. That is the magazine the rebuild is
 * escaping. If a page has more than three `Stack` children in a row and none of
 * them is a table, it is wrong.
 *
 * `flex` + `gap` rather than `space-y`: the margin-based utility skips over
 * fragments and misbehaves the moment a child is itself a flex or grid item,
 * which makes the spacing depend on how the caller happened to wrap things.
 */
export function Stack({
  children,
  gap = 'section',
  className,
}: {
  children: ReactNode;
  /** 16 between sections (default), 12 between the bands of one section. */
  gap?: 'section' | 'card';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col', gap === 'card' ? 'gap-3' : 'gap-4', className)}>
      {children}
    </div>
  );
}

/**
 * A bar of controls above a table or list: search, filters, view switches.
 *
 * Sticky, because on a long table the filters scroll away exactly when the user
 * decides the result set is wrong.
 *
 * The stuck band spans the full gutter and is opaque. It used to be `-mx-2`
 * against a 24–32px gutter, so rows scrolled through the 16px strip left
 * uncovered on each side, and it was `bg-canvas/95` + `backdrop-blur`, which is
 * glass over a flat paper token — banned by DESIGN.md §6 rule 6, and pointless
 * over a ground that has no image behind it.
 *
 * **The hairline appears only once the bar is actually stuck.** `border-b` is
 * what says "this is floating over content"; drawn at rest, full-bleed through
 * the page's gutter, it is a rule spanning the whole viewport that aligns with
 * nothing — on Leads it cut across the page above a card whose own border sat
 * 24px inside it. A one-pixel sentinel above the bar reports, through an
 * `IntersectionObserver`, whether the bar has left its resting place; the state
 * is written straight onto the DOM rather than held in React, because a
 * re-render of a filter bar on every scroll frame is exactly what a sticky
 * toolbar must not cost.
 */
export function Toolbar({
  children,
  sticky = false,
  className,
}: {
  children: ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  // React 19 runs the function a ref callback returns as its cleanup.
  const watchSentinel = useCallback(
    (sentinel: HTMLDivElement | null) => {
      if (!sentinel || !sticky || typeof IntersectionObserver === 'undefined') return;
      const bar = sentinel.nextElementSibling as HTMLElement | null;
      if (!bar) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          bar.dataset.stuck = entry.isIntersecting ? 'false' : 'true';
        },
        // Against the scroll container, whatever it is — the shell's `main` on a
        // page, a pane's own scroller in the inbox.
        { threshold: [1] },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    },
    [sticky],
  );

  const bar = (
    <div
      data-stuck="false"
      className={cn(
        'flex flex-wrap items-center gap-2',
        // `top-0`, not an offset: the shell's `main` is the scroll container,
        // so the toolbar sticks to the top of its own scroll box, immediately
        // under the top bar rather than a topbar's height below it.
        sticky &&
          cn(
            'sticky top-0 z-[var(--z-sticky)] -mx-gutter bg-canvas px-gutter py-2',
            'lg:-mx-gutter-lg lg:px-gutter-lg',
            'border-b border-transparent transition-colors duration-[var(--dur-fast)]',
            'data-[stuck=true]:border-border',
          ),
        className,
      )}
    >
      {children}
    </div>
  );

  if (!sticky) return bar;

  return (
    <>
      {/* Zero height, so it changes no layout, and `-mb-px` so it cannot open a
          1px gap between the bar and whatever is above it. */}
      <div ref={watchSentinel} aria-hidden className="-mb-px h-px w-full" />
      {bar}
    </>
  );
}

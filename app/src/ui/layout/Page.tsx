import { type ReactNode } from 'react';
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
 * Padding is 24 below `lg` and 32 at and above, on **both** axes, from one
 * token pair that `TopBar` and `ShellBanners` also consume — so the breadcrumb,
 * the banner and the page title stand on one left edge instead of three.
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
        '@container/page w-full py-gutter lg:py-gutter-lg',
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
  title: string;
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
  description,
  eyebrow,
  actions,
  toolbar,
  toolbarBleed = false,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <h1 className={cn('text-xl font-semibold text-text-primary', eyebrow && 'mt-1')}>
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
      {toolbar ? (
        <div
          className={cn(
            'mt-6',
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
  /** 24 between sections (default), 16 between the bands of one section. */
  gap?: 'section' | 'card';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col', gap === 'card' ? 'gap-4' : 'gap-6', className)}>
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
 * glass over a flat paper token — banned by DESIGN.md §6 rule 5, and pointless
 * over a ground that has no image behind it. The `border-b` is what tells the
 * reader it is stuck; without it the band has no edge at all.
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
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        // `top-0`, not an offset: the shell's `main` is the scroll container,
        // so the toolbar sticks to the top of its own scroll box, immediately
        // under the top bar rather than a topbar's height below it.
        sticky &&
          'sticky top-0 z-[var(--z-sticky)] -mx-gutter border-b border-border bg-canvas px-gutter py-2 lg:-mx-gutter-lg lg:px-gutter-lg',
        className,
      )}
    >
      {children}
    </div>
  );
}

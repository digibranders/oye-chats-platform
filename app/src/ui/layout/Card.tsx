import { type ElementType, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Eyebrow } from '../primitives/Misc';

/**
 * The rule that draws a card's internal divisions.
 *
 * It lives on the *card*, not on the bands, and it fires only between two
 * adjacent bands. Two defects came out of the bands each drawing their own:
 * `CardHeader` (`border-b`) followed by `CardSection` (`border-t`) painted a
 * doubled 2px rule, and a header-only card painted a square-ended line straight
 * across its own rounded bottom edge.
 *
 * Scoped to `[data-card-band]` rather than expressed as a blanket `divide-y`,
 * because a card's children are not all bands: an `AgentCard` is a link with two
 * plain `div`s in it and a `DataTable` seats itself flush without one, and
 * `divide-y` would have ruled between those too.
 */
const BANDS = '[&>[data-card-band]+[data-card-band]]:border-t [&>[data-card-band]+[data-card-band]]:border-border';

export interface CardProps {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  /** Lifts the card on hover. Only for a card that is itself a link or button. */
  interactive?: boolean;
}

/**
 * A white panel with a hairline. The console's only card family.
 *
 * No shadow, by rule. Elevation in this system means "floating above the page",
 * which a card is not — it is *part of* the page. Shadows are reserved for
 * menus, popovers, modals and drawers, so that when something does lift off the
 * surface the user knows it is temporary and can be dismissed.
 *
 * Cards do not nest. A card inside a card produces two competing hairlines and a
 * padding well that swallows twenty pixels of every side; use `CardSection` for
 * an internal division instead.
 *
 * `as` defaults to `div`, not `section`. An unnamed `<section>` is not exposed
 * as a landmark so the old default was benign — but a four-up grid of cards that
 * each acquired an `aria-label` would have announced four regions, and
 * `AgentsPage` already renders cards as `li`, where `section` is not a legal
 * substitute. A card that genuinely is a titled region passes `as="section"`
 * and supplies a `CardHeader` to name it.
 */
export function Card({ children, className, as: Tag = 'div', interactive = false }: CardProps) {
  return (
    <Tag
      // A stable hook for the card's own box, independent of which element it
      // renders as. `as` is now caller-controlled — `div`, `section` and `li`
      // all ship — so nothing downstream can identify a card by its tag.
      data-card
      className={cn(
        'relative rounded-lg border border-border bg-surface',
        BANDS,
        // The boundary is the only thing telling the reader this whole panel is
        // a target, so it carries control weight at rest (SC 1.4.11) and the
        // hover step moves the ground instead. It used to jump from the 1.28:1
        // decorative hairline to the 3.58:1 control border inside 120ms, which
        // reads as the card acquiring an outline rather than as it lifting.
        interactive &&
          'border-border-strong transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  /**
   * Mono uppercase label above the title. The console's editorial signature.
   *
   * Ignored at `size="sm"`: a widget card's whole header is 40px, and an eyebrow
   * that repeats the title — which is what an eyebrow above a two-word title
   * almost always is — costs half of it.
   */
  eyebrow?: string;
  title: ReactNode;
  /**
   * The heading level.
   *
   * A card inside a `Section` is a level below it, and hardcoding `h2` produced
   * a document outline of h1 → h2 → h2 where the third should have been h3.
   */
  titleAs?: 'h2' | 'h3' | 'h4';
  /**
   * Only when the title cannot carry the meaning.
   *
   * Never a restatement of the title, never a sentence about what the section
   * obviously is. 101 of the 103 headers in the app before this rebuild carried
   * one, and one card managed to say "Conversations" four times — eyebrow,
   * title, description and the first stat tile inside it.
   */
  description?: ReactNode;
  /** Buttons, menus, filters. Wraps below the title on narrow screens. */
  actions?: ReactNode;
  /**
   * `md` is a section card: 20/16 padding, a 14px title, a rule under it.
   * `sm` is a widget card — a KPI tile, a chart, a card in a `Grid` — where the
   * header is a 13px label and nothing else.
   */
  size?: 'md' | 'sm';
  className?: string;
}

/**
 * A card's header band.
 *
 * It used to be 98px of chrome on every card in the app: 16 + eyebrow 16 + 4 +
 * title 22 + 4 + description 20, and 118 when the description wrapped. Stripe's
 * equivalent panel header is about 44px and Linear's is 32. A card's chrome has
 * to be proportional to its content, so there are two sizes: a section card
 * (~68px with a description, ~52 without) and a widget card (40px, one line).
 * A card inside a `Grid` takes `size="sm"`.
 *
 * The header draws no rule of its own — the card draws it, and only when there
 * is a second band under it. See `BANDS`.
 */
export function CardHeader({
  eyebrow,
  title,
  titleAs: Title = 'h2',
  description,
  actions,
  size = 'md',
  className,
}: CardHeaderProps) {
  const small = size === 'sm';
  return (
    <div
      data-card-band
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-cell',
        small ? 'py-2.5' : 'py-4',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && !small ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Title
          className={cn(
            'font-semibold text-text-primary',
            small ? 'text-sm' : 'text-base',
            eyebrow && !small && 'mt-1',
          )}
        >
          {title}
        </Title>
        {description ? (
          <p className="mt-1 max-w-reading text-xs text-text-tertiary">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * `flush` drops the padding for a body that is entirely a table or a list, whose
 * rows draw their own gutters and must reach the card's edge to look seated.
 */
export function CardBody({
  children,
  className,
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <div data-card-band className={cn(!flush && 'px-cell py-4', className)}>
      {children}
    </div>
  );
}

/**
 * A hairline-separated division inside a card. Use instead of nesting a card.
 *
 * `tone="sunken"` sets the band on `--color-surface-sunken` — for a summary, a
 * preview or a note that is *about* the band above it rather than more of the
 * same. Three call sites were hand-writing `className="bg-surface-sunken"`,
 * which is a colour decision escaping into a feature.
 */
export function CardSection({
  children,
  tone = 'plain',
  className,
}: {
  children: ReactNode;
  tone?: 'plain' | 'sunken';
  className?: string;
}) {
  return (
    <div
      data-card-band
      className={cn('px-cell py-4', tone === 'sunken' && 'bg-surface-sunken', className)}
    >
      {children}
    </div>
  );
}

/**
 * The card's footer. `bg-surface-sunken` so a row of actions reads as a bar
 * rather than as more content. Always the card's last child.
 */
export function CardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-card-band
      className={cn(
        // The footer sits *inside* the card's 1px border, so its corner radius
        // is the card's minus that border. `rounded-b-[inherit]` resolved to the
        // full 10 and painted a hairline sliver of sunken grey outside the
        // border's arc at both bottom corners — visible against the canvas.
        'flex flex-wrap items-center justify-end gap-2 rounded-b-inner-flush',
        'bg-surface-sunken px-cell py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface WellProps {
  children: ReactNode;
  /**
   * `sunken` sets the well on `--color-surface-sunken` — the default, and what
   * makes it read as a recess in the card rather than as a second card. It is
   * 4.5 L* against the card's white and only **1.8** against the page's canvas,
   * so a `Well` belongs inside a `Card`; on the page ground it would be a block
   * with no visible edge, which is exactly how a chat bubble went missing. Its
   * border carries it either way, but the fill stops meaning anything. `plain`
   * keeps the card's own white and draws the border only, for a well holding a
   * control that already has a fill of its own (a code block, a colour swatch),
   * where two greys one L* apart look like a rendering fault.
   */
  tone?: 'sunken' | 'plain';
  className?: string;
}

/**
 * A bordered recess inside a card: a quoted value, a preview, a summary of what
 * is about to happen, an empty slot waiting for content.
 *
 * The most-copied shape in the app after the card itself — three agents asked
 * for it by name and six hand-rolled copies of the same
 * `rounded-md border border-border px-3 py-2.5` were still in `features/` when
 * this landed, at four different paddings and two radii.
 *
 * **8px, not 10.** A well is a child of a card, and a child inset by the card's
 * 20px gutter takes `--radius-inner`; sharing the parent's 10 is what draws the
 * crescent of dead space §4 calls a broken corner. 8 is close enough to read as
 * the same family and far enough to read as *inside* it.
 *
 * It is not a `Card`. A card is a top-level surface with a header, a body and
 * elevation semantics; nesting one inside another gives a doubled hairline and
 * two radii a pixel apart, which is the single most common defect in the console
 * this replaces. It is not `CardSection` either — that divides a card's own
 * bands with a hairline and reaches its edges; this is an object *in* a band.
 */
export function Well({ children, tone = 'sunken', className }: WellProps) {
  return (
    <div
      className={cn(
        'rounded-md border border-border px-3 py-2.5',
        tone === 'sunken' ? 'bg-surface-sunken' : 'bg-surface',
        className,
      )}
    >
      {children}
    </div>
  );
}

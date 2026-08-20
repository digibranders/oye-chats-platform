import { type ReactNode } from 'react';
import { AlertCircle, Lock, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { Skeleton } from '../primitives/Skeleton';

/**
 * The four states every surface owes its user: loading, empty, error, forbidden.
 *
 * They live together because they are one decision, not four. The old app had 43
 * uses of an empty state, twelve verbatim copies of a private loading block, two
 * ad-hoc error states, and no forbidden state at all — so "we could not load
 * this", "there is nothing here yet", "your filter matched nothing" and "your
 * plan does not include this" were routinely rendered as the same blank panel,
 * and the user could not tell which had happened.
 *
 * ## Why there is a size scale
 *
 * The first draft had one geometry — `px-6 py-14` around a 36px icon chip, 14px
 * of title and 12px of centred prose — and a `compact` flag that only shaved the
 * padding. Measured, that is a **190px box to say one sentence**, and a table
 * that returned no rows became a poster: a centred paragraph inside a surface
 * whose every other row is left-aligned, which is the "magazine" tell this
 * rebuild exists to remove.
 *
 * So a state now declares what it *is*:
 *
 * - `page` — the whole route is in this state. A hero: 48px disc, an 18px title,
 *   centred, room to breathe. The default.
 * - `panel` — a card body is in this state. A notice: 32px disc, a 14px title,
 *   centred, and never a card of its own — it is already inside one.
 * - `inline` — a table body, a list, a chart's plot area. **No icon**, one line
 *   of 13px type and one of 12px, **left-aligned on the surface's own text
 *   column**, about 120px tall. Linear's empty table is a single left-aligned
 *   line of secondary text; so is this.
 *
 * Horizontal padding is `--spacing-cell` at every size, which is the same 20px a
 * `CardBody` and a `DataTable` cell use — so a state's first character lands on
 * the same left edge as the card title above it and the rows it replaced. The
 * previous `px-4` put every one of them 4px out.
 */

export type StateSize = 'page' | 'panel' | 'inline';
export type StateAlign = 'center' | 'start';

interface StateGeometry {
  root: string;
  disc: string;
  glyph: string;
  title: string;
  description: string;
  measure: string;
  gap: string;
}

const GEOMETRY: Record<StateSize, StateGeometry> = {
  page: {
    root: 'px-cell py-16',
    disc: 'mb-4 h-12 w-12 rounded-md',
    glyph: 'h-icon-lg w-icon-lg',
    title: 'text-lg font-semibold',
    description: 'mt-1.5 text-sm',
    measure: 'max-w-sm',
    gap: 'mt-5',
  },
  panel: {
    root: 'px-cell py-10',
    // 16px glyph in a 32px disc — the 2:1 ratio `Avatar` and `Button icon-sm`
    // already use. The old 18px glyph (`h-4.5`) was not on the 4-base scale at
    // all, and a 36px chip at `rounded-md` is proportionally rounder than the
    // 10px card holding it.
    disc: 'mb-3 h-8 w-8 rounded-sm',
    glyph: 'h-icon-md w-icon-md',
    title: 'text-base font-medium',
    description: 'mt-1 text-xs',
    measure: 'max-w-xs',
    gap: 'mt-4',
  },
  inline: {
    root: 'px-cell py-6',
    // Unused: an inline state draws no disc. A 32px chip beside two lines of
    // type inside a table row is decoration, and decoration is what makes an
    // empty table read as a poster.
    disc: '',
    glyph: '',
    title: 'text-sm font-medium',
    description: 'mt-0.5 text-xs',
    measure: 'max-w-md',
    gap: 'mt-3',
  },
};

/** `inline` is a row of copy, not a poster: it reads from the left like the rows around it. */
function defaultAlign(size: StateSize): StateAlign {
  return size === 'inline' ? 'start' : 'center';
}

/**
 * A state's own surface.
 *
 * `LockedState` used to draw `rounded-lg border border-border bg-surface`
 * unconditionally while its two siblings drew nothing, so the three could not be
 * swapped for one another: seated in a card the locked one nested cards — banned
 * by DESIGN.md §4, and visible as a doubled hairline with two coincident 10px
 * radii — while standing alone the other two had no surface at all.
 *
 * The default now follows the size, and only for `LockedState`: at `page` it is
 * the whole route and there is nothing else to sit in, so it draws its card; at
 * `panel` and `inline` it is already inside one, so it does not. `EmptyState`
 * and `ErrorState` still draw nothing at any size, because the overwhelming
 * majority of their 154 call sites are already inside a `CardBody` — framing
 * them by default would have created the exact defect this change removes.
 * `framed` overrides either way.
 */
interface StateShellProps {
  framed: boolean;
  className?: string;
  children: ReactNode;
  role?: 'status' | 'alert';
}

function StateShell({ framed, className, children, role }: StateShellProps) {
  return (
    <div
      role={role}
      className={cn(framed && 'rounded-lg border border-border bg-surface', className)}
    >
      {children}
    </div>
  );
}

interface StateBodyProps {
  size: StateSize;
  align: StateAlign;
  icon?: LucideIcon;
  discClass: string;
  glyphClass: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

function StateBody({
  size,
  align,
  icon: Icon,
  discClass,
  glyphClass,
  title,
  description,
  action,
}: StateBodyProps) {
  const geometry = GEOMETRY[size];
  const centred = align === 'center';
  return (
    <div className={cn(geometry.root, centred ? 'text-center' : 'text-left')}>
      {Icon && size !== 'inline' ? (
        <span
          className={cn(
            'flex items-center justify-center',
            geometry.disc,
            discClass,
            centred && 'mx-auto',
          )}
        >
          <Icon aria-hidden className={cn(geometry.glyph, glyphClass)} />
        </span>
      ) : null}
      <p className={cn(geometry.title, 'text-text-primary')}>{title}</p>
      {description ? (
        <p
          className={cn(
            geometry.description,
            geometry.measure,
            'leading-relaxed text-text-secondary',
            centred && 'mx-auto',
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? (
        <div className={cn(geometry.gap, 'flex', centred ? 'justify-center' : 'justify-start')}>
          {action}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `compact` was the first draft's only size, and it is still passed at a dozen
 * call sites. It means `panel` — a state seated inside a card — so it keeps
 * working, and `size` wins wherever a caller has moved on.
 */
function resolveSize(size: StateSize | undefined, compact: boolean | undefined): StateSize {
  if (size) return size;
  return compact ? 'panel' : 'page';
}

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  /**
   * Why it is empty, and what to do about it.
   *
   * "Nothing here yet" and "nothing matched your filter" are answers to
   * different questions, and a single blank panel makes the reader guess which
   * one they are looking at — so the caller always supplies both the reason and
   * the way out.
   */
  description?: string;
  action?: ReactNode;
  /** See `StateSize`. Defaults to `page`, or `panel` when `compact` is set. */
  size?: StateSize;
  /** Overrides the size's own default: centred at `page`/`panel`, left at `inline`. */
  align?: StateAlign;
  /**
   * Draws the state's own card. Off by default — a state is nearly always
   * already inside one, and a caller that is not wraps this in a `Card`.
   */
  framed?: boolean;
  /** @deprecated Pass `size="panel"`. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size,
  align,
  framed,
  compact,
  className,
}: EmptyStateProps) {
  const resolved = resolveSize(size, compact);
  return (
    <StateShell framed={framed ?? false} className={className}>
      <StateBody
        size={resolved}
        align={align ?? defaultAlign(resolved)}
        icon={Icon}
        discClass="bg-surface-sunken"
        glyphClass="text-text-tertiary"
        title={title}
        description={description}
        action={action}
      />
    </StateShell>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** What actually failed, in the user's terms. Never a raw stack or status code. */
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  size?: StateSize;
  align?: StateAlign;
  framed?: boolean;
  /**
   * Announce politely rather than interrupting.
   *
   * `role="alert"` is assertive: rendering it interrupts whatever the screen
   * reader was saying. That is right for a failure that arrives while the user
   * is reading something else, and wrong for the six chart panels that all fail
   * at once on load — which interrupt the reader six times.
   *
   * It stays assertive by default because forty call sites and their tests
   * already expect an alert; a seated panel that is one of several on a page
   * should pass this.
   */
  polite?: boolean;
  /** @deprecated Pass `size="panel"`. */
  compact?: boolean;
  className?: string;
}

/**
 * Something did not load.
 *
 * Always offers the way back. A failed section with no retry is a dead card
 * until the user thinks to reload the whole page — and most do not, they just
 * read the zero and believe it.
 */
export function ErrorState({
  title = 'This could not be loaded',
  description,
  onRetry,
  retryLabel = 'Try again',
  size,
  align,
  framed,
  polite = false,
  compact,
  className,
}: ErrorStateProps) {
  const resolved = resolveSize(size, compact);
  return (
    <StateShell
      role={polite ? 'status' : 'alert'}
      framed={framed ?? false}
      className={className}
    >
      <StateBody
        size={resolved}
        align={align ?? defaultAlign(resolved)}
        icon={AlertCircle}
        discClass="bg-danger-tint"
        glyphClass="text-danger"
        title={title}
        description={description}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null
        }
      />
    </StateShell>
  );
}

export interface LockedStateProps {
  title: string;
  description: string;
  /** The upsell. Never a bare "Upgrade" — name the plan and what it unlocks. */
  action?: ReactNode;
  /** A glimpse of what is behind the lock, so the user can judge the upgrade. */
  preview?: ReactNode;
  size?: StateSize;
  align?: StateAlign;
  /** Draws the state's own card. Defaults to on at `page`, off when seated. */
  framed?: boolean;
  /** @deprecated Pass `size="panel"`. */
  compact?: boolean;
  className?: string;
}

/**
 * The user's plan does not include this.
 *
 * Carries a preview slot because a lock with nothing behind it asks people to
 * buy something they have never seen. The old app's locked surfaces rendered a
 * bare card with no page title and no description of the feature.
 *
 * It no longer draws a card at `panel` and `inline`. It used to draw one at
 * every size, which is why a locked analytics panel painted a full `rounded-lg`
 * border flush inside its `Card`'s own — a 2px seam down both sides and two
 * concentric radii a pixel apart at the corners.
 */
export function LockedState({
  title,
  description,
  action,
  preview,
  size,
  align,
  framed,
  compact,
  className,
}: LockedStateProps) {
  const resolved = resolveSize(size, compact);
  return (
    <StateShell framed={framed ?? resolved === 'page'} className={cn('overflow-hidden', className)}>
      {preview ? (
        // `inert` rather than `aria-hidden`: it is an illustration of the
        // feature, not the feature. `aria-hidden` alone hides the subtree from
        // a screen reader while leaving every control inside it in the tab
        // order, which is a keyboard trap into UI the user cannot use. `inert`
        // removes it from both.
        <div inert className="pointer-events-none select-none opacity-40">
          {preview}
        </div>
      ) : null}
      <StateBody
        size={resolved}
        align={align ?? defaultAlign(resolved)}
        icon={Lock}
        discClass="bg-plan-tint"
        glyphClass="text-plan"
        title={title}
        description={description}
        action={action}
      />
    </StateShell>
  );
}

export interface FullPageStateProps {
  icon?: LucideIcon;
  /** `danger` for a crash; `neutral` for a 403, a 404 or a bootstrap. */
  tone?: 'neutral' | 'danger' | 'plan';
  title: string;
  description: string;
  /** Rendered under the copy. The way out — never fewer than one. */
  actions?: ReactNode;
  /** Small print under the actions: a support address, an error id. */
  footnote?: ReactNode;
  /** The app is still starting. Announces politely instead of as an alert. */
  busy?: boolean;
  className?: string;
}

const FULL_PAGE_TONE: Record<NonNullable<FullPageStateProps['tone']>, { disc: string; glyph: string }> = {
  neutral: { disc: 'bg-surface-sunken', glyph: 'text-text-tertiary' },
  danger: { disc: 'bg-danger-tint', glyph: 'text-danger' },
  plan: { disc: 'bg-plan-tint', glyph: 'text-plan' },
};

/**
 * The whole window is this state: a crash, a 403 on a route, the bootstrap.
 *
 * It exists because the console shipped **two** crash screens with two designs,
 * both mounted — one a centred 448px card with a red disc, the other a
 * left-aligned 896px page with an eyebrow — plus a third hand-built shape for
 * the impersonation notice, all three assembled from raw classes inside
 * `src/components/`, which is precisely what `src/ui/` exists to stop.
 *
 * Centred on the viewport and no wider than a card, because there is no shell
 * around it to anchor to: the rail is gone, the top bar is gone, and a
 * full-width left-aligned column of text with nothing beside it reads as a
 * broken page rather than a considered one.
 */
export function FullPageState({
  icon: Icon,
  tone = 'neutral',
  title,
  description,
  actions,
  footnote,
  busy = false,
  className,
}: FullPageStateProps) {
  const palette = FULL_PAGE_TONE[tone];
  return (
    <div
      // `alert` would interrupt on mount for a screen that is often the first
      // thing rendered; `status` still announces it, politely.
      role={busy ? 'status' : 'alert'}
      aria-busy={busy || undefined}
      className={cn('grid min-h-dvh place-items-center bg-canvas p-6', className)}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface px-cell py-10 text-center">
        {Icon ? (
          <span
            className={cn(
              'mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-md',
              palette.disc,
            )}
          >
            <Icon aria-hidden className={cn('h-icon-lg w-icon-lg', palette.glyph)} />
          </span>
        ) : null}
        <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
        <p className="mx-auto mt-1.5 max-w-sm text-prose text-text-secondary">{description}</p>
        {actions ? <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div> : null}
        {footnote ? <div className="mt-4 text-xs text-text-tertiary">{footnote}</div> : null}
      </div>
    </div>
  );
}

/**
 * A loading placeholder shaped like the content it replaces.
 *
 * Shaped, not generic: a skeleton that does not match what arrives causes a
 * layout jump on every load, which is exactly what the old app's skeletons did —
 * three of them drew a four-tile summary row that the loaded page never rendered.
 *
 * `LoadingRows` was for a while the *only* shape in the system, so it stood in
 * for bar charts, transcripts and invoice lists as well as the roster row it is
 * actually drawn as — the same defect its own docstring warns about. The two
 * shapes below are the ones the console genuinely needed; a fourth belongs here
 * too the moment a surface needs it, not inside that surface.
 */
export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy className={cn('space-y-2.5', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * The shape `RankedBars` loads into: a label, a track, a figure.
 *
 * Six surfaces — the funnel, top questions, the ratings distribution, the
 * feedback log, the journey's routes — were loading a roster row with an avatar
 * in it and then painting a bar chart, so every one of them jumped on load.
 */
export function LoadingBars({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy className={cn('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-cell py-2.5">
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="h-2 w-full max-w-80 rounded-xs" />
          <Skeleton className="ml-auto h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * The shape a conversation list loads into: an avatar, two lines, a timestamp.
 *
 * Distinct from `LoadingRows` in the one way that matters — it is two lines
 * tall, because a conversation row carries a name *and* the last message, and a
 * one-line skeleton under a two-line row shifts the whole list on arrival.
 */
export function LoadingConversations({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy className={cn('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-3 border-b border-border px-cell py-3 last:border-b-0">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
          </div>
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

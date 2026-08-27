import { type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';
import { cn } from '../lib/cn';
import { Tooltip } from '../overlays/Tooltip';

/**
 * The 16px optical box every leading glyph sits in.
 *
 * An icon, a health dot, a progress ring and the brand mark are four different
 * sizes, and each of them picked its own before this existed — which is how the
 * rail ended up with the label column at x = 34, 40, 40.5, 42 and 44 on five
 * adjacent rows. Whatever the glyph is, it is centred in this box, and the box
 * is the icon column.
 */
const GLYPH_BOX = 'flex h-icon-md w-icon-md shrink-0 items-center justify-center';

/**
 * One row shape for the whole rail: 36 tall, 10 in, a 16px glyph, a 10px gap.
 *
 * The focus ring is overridden here. The global one is `--color-accent-500`,
 * which is measured against paper; on the near-black rail it is the same trap
 * DESIGN.md §2.2 warns about for every other paper token, so the rail's own
 * accent carries it.
 *
 * `text-base` (14px), not `text-sm` (13px) — the next rung up the type scale.
 * The rail is on screen in every state the app can be in, permanently, and at
 * 13px its labels read smaller than the 14px body copy in the pages they open.
 * Truncation is already the row's answer to a label that does not fit, so the
 * one-rung increase costs nothing there.
 */
const RAIL_ROW =
  'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-base font-medium transition-colors duration-[var(--dur-fast)] focus-visible:outline-rail-accent';

export interface RailFrameProps {
  /** The workspace switcher, or the platform console's mark. */
  header: ReactNode;
  /** The account menu, a billing link. Pinned to the bottom. */
  footer?: ReactNode;
  /** `RailItem`s, `RailGroupLabel`s and at most one `RailBackLink`. */
  children: ReactNode;
  /** Names the nav landmark, e.g. "Main" or "Platform console". */
  navLabel: string;
  className?: string;
}

/**
 * The navigation rail's frame.
 *
 * It exists because there are two rails — the customer console's and the
 * platform console's — and they were the same 248px column with two different
 * interiors: a 56px header against a 52px one, a bottom border against none, a
 * 12px inset against 16, 8px of nav padding against 0, and an active state with
 * an accent rule against one without. A super-admin crosses between the two
 * consoles constantly, and every crossing moved the content start by 22px and
 * changed what "selected" looks like.
 *
 * Per `CLAUDE.md` non-negotiable #1 this is a `src/ui/` component and not a
 * shell helper: two shells consuming one frame cannot drift, and two shells
 * each owning their own always will.
 *
 * The destinations are a real `ul`. A list of places to go is a list, and it is
 * what tells a screen-reader user how many there are before they start.
 */
export function RailFrame({ header, footer, children, navLabel, className }: RailFrameProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-rail text-rail-text', className)}>
      <div className="flex h-topbar shrink-0 items-center border-b border-rail-border px-2">
        {header}
      </div>
      <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">{children}</ul>
      </nav>
      {footer ? (
        <div className="shrink-0 border-t border-rail-border p-2">{footer}</div>
      ) : null}
    </div>
  );
}

export interface RailItemProps {
  to: string;
  label: string;
  /** Any glyph — an icon, a health dot, a progress ring. Always boxed. */
  glyph: ReactNode;
  /** A count badge, a fraction. Hidden while collapsed. */
  trailing?: ReactNode;
  /** Match only the exact path, for a section's index route. */
  end?: boolean;
  /**
   * Force the active state.
   *
   * The platform console computes its own, because several of its destinations
   * are prefixes of each other and `NavLink`'s own matching gets it wrong.
   * Leave it undefined and the router decides.
   */
  active?: boolean;
  /** Icon only, with the label carried by a tooltip. */
  collapsed?: boolean;
  /** Closes the mobile drawer. */
  onNavigate?: () => void;
  className?: string;
}

/** A destination in the rail. */
export function RailItem({
  to,
  label,
  glyph,
  trailing,
  end,
  active,
  collapsed = false,
  onNavigate,
  className,
}: RailItemProps) {
  function rowClass(isActive: boolean): string {
    return cn(
      RAIL_ROW,
      collapsed && 'justify-center px-0',
      isActive
        ? // No coloured leading rule. A saturated periwinkle stripe was the one
          // piece of chroma on an otherwise monochrome rail, which made a
          // decorative marker the loudest thing in the navigation — the
          // opposite of what the rail is for (`tokens.css`: a dark surface that
          // "stops the rail competing with the content").
          //
          // It earned its place, though, and the replacement has to do the same
          // job: hover ALSO raises the label to `--color-rail-text`, so without
          // the stripe an active row and a hovered one differed only by
          // `--color-rail-active` against `--color-rail-hover` — two greys
          // 1.14 apart on the rail, which is a felt step, not a legible
          // distinction. Weight is the second axis: the current row is the only
          // one set in semibold, so it reads as current even while the pointer
          // is somewhere else, and it costs no colour to say so.
          'bg-rail-active font-semibold text-rail-text'
        : 'text-rail-text-muted hover:bg-rail-hover hover:text-rail-text',
      className,
    );
  }

  const body = (
    <>
      {/* The glyph is not hidden here: an icon arrives already `aria-hidden`,
          and a health dot or a progress ring carries its own text, which is the
          only thing that makes it more than decoration. */}
      <span className={GLYPH_BOX}>{glyph}</span>
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing ? <span className="shrink-0">{trailing}</span> : null}
        </>
      )}
    </>
  );

  // A forced active state is a plain `Link`. `NavLink` computes `aria-current`
  // from its own match and drops the one it was handed, so a shell that decides
  // for itself would have got the fill without the announcement.
  const link =
    active === undefined ? (
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        className={({ isActive }) => rowClass(isActive)}
      >
        {body}
      </NavLink>
    ) : (
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={rowClass(active)}
      >
        {body}
      </Link>
    );

  return (
    <li>
      {collapsed ? (
        <Tooltip content={label} side="right">
          {link}
        </Tooltip>
      ) : (
        link
      )}
    </li>
  );
}

/**
 * A label over a group of destinations.
 *
 * Only earns its place over three or more: four of the platform rail's five
 * groups introduced a single row each, at 38px of chrome per 36px row. While
 * the rail is collapsed it becomes a hairline — an 11px uppercase label in a
 * 60px column is unreadable, and dropping it entirely loses the grouping.
 */
export function RailGroupLabel({
  children,
  action,
  collapsed = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return <li aria-hidden className="mx-2.5 my-2 border-t border-rail-border" />;
  }
  return (
    <li className="mt-4 flex items-center justify-between gap-2 px-2.5 pb-1.5 first:mt-0">
      {/* Not `Eyebrow`: that carries `text-text-tertiary`, a paper token, which
          measures 1.6 on the rail. */}
      <p className="min-w-0 truncate font-mono text-2xs uppercase tracking-eyebrow text-rail-text-muted">
        {children}
      </p>
      {action ? <span className="shrink-0">{action}</span> : null}
    </li>
  );
}

/**
 * The way back out of a scoped rail.
 *
 * Always the first row of the nav, at the same height and on the same optical
 * grid as every destination under it — it used to be 30px tall with a 14px icon
 * and a different gap, so the one row whose whole job is "you are somewhere
 * nested" was the row that looked least like the rest.
 */
export function RailBackLink({
  to,
  children,
  onNavigate,
}: {
  to: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <li>
      <NavLink
        to={to}
        onClick={onNavigate}
        className={cn(RAIL_ROW, 'text-rail-text-muted hover:bg-rail-hover hover:text-rail-text')}
      >
        <span className={GLYPH_BOX}>
          <ArrowLeft aria-hidden className="h-icon-md w-icon-md" />
        </span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </NavLink>
    </li>
  );
}

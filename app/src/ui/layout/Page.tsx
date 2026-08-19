import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export type PageWidth = 'default' | 'wide' | 'full';

const WIDTHS: Record<PageWidth, string> = {
  // Reading-width for settings and forms: a 1,400px-wide form is unusable
  // because the label and its control end up a screen apart.
  default: 'max-w-4xl',
  wide: 'max-w-[var(--page-max)]',
  // No max and no padding — for the inbox, which is a full-bleed workspace.
  full: 'max-w-none',
};

export interface PageProps {
  children: ReactNode;
  width?: PageWidth;
  className?: string;
}

/** The scroll body of a routed page. Chrome above it belongs to the shell. */
export function Page({ children, width = 'wide', className }: PageProps) {
  return (
    <div
      className={cn(
        'mx-auto w-full',
        width !== 'full' && 'px-6 py-6 md:px-8',
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
  description?: ReactNode;
  /** Mono uppercase label above the title, naming the object or area. */
  eyebrow?: string;
  /** Primary and secondary controls for the whole page. */
  actions?: ReactNode;
  /** A tab row, filter bar or scope switcher, rendered under the title block. */
  toolbar?: ReactNode;
  className?: string;
}

/**
 * A page's title block.
 *
 * Renders the only `h1` on the page. The old app had pages with two `h1`s (the
 * agent shell's name plus the tab's own title) and four tabs with no heading at
 * all, so a screen-reader user tabbing between them heard either a duplicate or
 * nothing.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  toolbar,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-text-tertiary">
              {eyebrow}
            </p>
          ) : null}
          <h1 className={cn('text-xl font-semibold text-text-primary', eyebrow && 'mt-1')}>
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-base leading-relaxed text-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {toolbar ? <div className="mt-5">{toolbar}</div> : null}
    </header>
  );
}

export interface SectionProps {
  title?: string;
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
 */
export function Section({ title, description, actions, children, id, className }: SectionProps) {
  return (
    <section id={id} className={cn('scroll-mt-24', className)}>
      {title ? (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 className="text-md font-semibold text-text-primary">{title}</h2>
            {description ? (
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-secondary">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Vertical rhythm between sections. One gap value, applied in one place. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('space-y-6', className)}>{children}</div>;
}

/**
 * A bar of controls above a table or list: search, filters, view switches.
 *
 * Sticky, because on a long table the filters scroll away exactly when the user
 * decides the result set is wrong.
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
        sticky && 'sticky top-[var(--topbar-h)] z-20 -mx-2 bg-canvas/95 px-2 py-2 backdrop-blur',
        className,
      )}
    >
      {children}
    </div>
  );
}

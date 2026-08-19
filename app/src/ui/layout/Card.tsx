import { type ElementType, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface CardProps {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  /** Lifts the border on hover. Only for a card that is itself a link or button. */
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
 */
export function Card({ children, className, as: Tag = 'section', interactive = false }: CardProps) {
  return (
    <Tag
      className={cn(
        'relative rounded-lg border border-border bg-surface',
        interactive &&
          'transition-colors duration-[var(--dur-fast)] hover:border-border-strong',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  /** Mono uppercase label above the title. The console's editorial signature. */
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, menus, filters. Wraps below the title on narrow screens. */
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ eyebrow, title, description, actions, className }: CardHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-3',
        'border-b border-border px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="font-mono text-2xs uppercase tracking-[0.08em] text-text-tertiary">
            {eyebrow}
          </p>
        ) : null}
        <h2 className={cn('text-md font-semibold text-text-primary', eyebrow && 'mt-1')}>{title}</h2>
        {description ? (
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-text-secondary">
            {description}
          </p>
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
  return <div className={cn(!flush && 'px-5 py-4', className)}>{children}</div>;
}

/** A hairline-separated division inside a card. Use instead of nesting a card. */
export function CardSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('border-t border-border px-5 py-4', className)}>{children}</div>;
}

/**
 * The card's footer. `bg-surface-sunken` so a row of actions reads as a bar
 * rather than as more content.
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
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t border-border',
        'bg-surface-sunken px-5 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

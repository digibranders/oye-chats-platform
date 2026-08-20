import { type ReactNode } from 'react';
import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { cn } from '../lib/cn';

/**
 * A hairline rule. Purely visual — it separates, it does not carry meaning.
 *
 * A vertical separator has its own height rather than `h-full`. In the case it
 * is actually used in — a `flex items-center` toolbar — `h-full` resolves
 * against a parent with no definite height and collapses to zero, so every
 * caller had to know that and pass a magic number, and the two that existed
 * passed two different ones. `self-center` also stops an `items-stretch` row
 * from painting a full-bleed rule.
 */
export function Separator({
  orientation = 'horizontal',
  size = 'md',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  /** Vertical only: `sm` 16px beside `sm` controls, `md` 24px beside `md`. */
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <BaseSeparator
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal'
          ? 'h-px w-full'
          : cn('w-px self-center', size === 'sm' ? 'h-4' : 'h-6'),
        className,
      )}
    />
  );
}

/**
 * A keyboard key.
 *
 * Takes the key as written for the current platform — the caller resolves ⌘ vs
 * Ctrl. The old shell hardcoded `⌘K` and showed it to Windows and Linux users,
 * where that key does not exist.
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border',
        'bg-surface-sunken px-1 font-mono text-2xs font-medium text-text-secondary',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * The console's mono eyebrow: a small uppercase label above a title or figure.
 *
 * A named component rather than a repeated class string, because it appears on
 * every card header, every stat tile and every column head, and it is the single
 * strongest signal that all these surfaces belong to one product.
 *
 * `as` exists because a `<p>` cannot appear inside a `<label>` or a heading, so
 * the two places that needed one — the drop zone's accepted-types line and the
 * menu's group label — each re-typed the class string instead. A `span` set to
 * `block` renders identically and is valid everywhere.
 */
export const EYEBROW_CLASS =
  'block font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary';

export function Eyebrow({
  children,
  as: Tag = 'p',
  className,
}: {
  children: ReactNode;
  as?: 'p' | 'span' | 'div';
  className?: string;
}) {
  return (
    <Tag className={cn(EYEBROW_CLASS, className)}>
      {children}
    </Tag>
  );
}

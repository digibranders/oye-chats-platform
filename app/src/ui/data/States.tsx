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
 */

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
  /** For an empty state inside a card body rather than a whole page. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      {Icon ? (
        <span className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-surface-sunken">
          <Icon aria-hidden className="h-4.5 w-4.5 text-text-tertiary" />
        </span>
      ) : null}
      <p className="text-base font-medium text-text-primary">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-text-secondary">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** What actually failed, in the user's terms. Never a raw stack or status code. */
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
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
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn('text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}
    >
      <span className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-danger-tint">
        <AlertCircle aria-hidden className="h-4.5 w-4.5 text-danger" />
      </span>
      <p className="text-base font-medium text-text-primary">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-text-secondary">
          {description}
        </p>
      ) : null}
      {onRetry ? (
        <div className="mt-4 flex justify-center">
          <Button size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface LockedStateProps {
  title: string;
  description: string;
  /** The upsell. Never a bare "Upgrade" — name the plan and what it unlocks. */
  action?: ReactNode;
  /** A glimpse of what is behind the lock, so the user can judge the upgrade. */
  preview?: ReactNode;
  compact?: boolean;
  className?: string;
}

/**
 * The user's plan does not include this.
 *
 * Carries a preview slot because a lock with nothing behind it asks people to
 * buy something they have never seen. The old app's locked surfaces rendered a
 * bare card with no page title and no description of the feature.
 */
export function LockedState({
  title,
  description,
  action,
  preview,
  compact = false,
  className,
}: LockedStateProps) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)}>
      {preview ? (
        // Dimmed and inert: it is an illustration of the feature, not the
        // feature. `aria-hidden` keeps a screen reader from reading out a
        // sample the user cannot actually reach.
        <div aria-hidden className="pointer-events-none select-none opacity-40">
          {preview}
        </div>
      ) : null}
      <div className={cn('text-center', compact ? 'px-4 py-8' : 'px-6 py-12')}>
        <span className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-plan-tint">
          <Lock aria-hidden className="h-4.5 w-4.5 text-plan" />
        </span>
        <p className="text-base font-medium text-text-primary">{title}</p>
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-text-secondary">
          {description}
        </p>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
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

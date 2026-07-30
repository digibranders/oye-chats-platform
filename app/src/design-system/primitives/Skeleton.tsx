import { type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/** Skeleton - loading placeholder block. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-[var(--ds-bg-sunken)]', className)}
      aria-hidden="true"
      {...props}
    />
  );
}
